#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { createLarkChannel } = require('@larksuiteoapi/node-sdk');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, '.feishu-codex-bridge.json');
const LEGACY_CREDENTIALS = '/Users/zhangfan/.codex/skills/feishu-integration/references/.feishu-config.json';
const CODEX = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
const MAX_REPLY = 3500;
const TASK_LIMIT = 12;

function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeConfig(config) {
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function loadConfig() {
  const saved = readJson(CONFIG_PATH);
  const legacy = readJson(LEGACY_CREDENTIALS);
  const config = {
    appId: saved.appId || legacy.appId || '',
    appSecret: saved.appSecret || legacy.appSecret || '',
    allowedOpenId: saved.allowedOpenId || '',
    pairingCode: saved.pairingCode || crypto.randomBytes(3).toString('hex').toUpperCase(),
  };
  if (!saved.pairingCode) writeConfig(config);
  return config;
}

function clean(value) { return String(value || '').trim(); }
function clip(value, limit = MAX_REPLY) {
  const text = clean(value);
  return text.length <= limit ? text : `${text.slice(0, limit)}\n\n（结果较长，已截取前 ${limit} 个字。）`;
}

class CodexClient {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.turns = new Map();
    this.proc = null;
  }

  async start() {
    if (this.proc && !this.proc.killed) return;
    this.proc = spawn(CODEX, ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stderr.on('data', (chunk) => console.error(`[codex] ${chunk}`));
    this.proc.on('exit', () => { this.proc = null; });
    readline.createInterface({ input: this.proc.stdout }).on('line', (line) => this.onLine(line));
    await this.request('initialize', {
      clientInfo: { name: 'feishu-codex-bridge', title: null, version: '0.1.0' },
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
  }

  onLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === 'item/agentMessage/delta') {
      const state = this.turns.get(message.params.turnId);
      if (state) state.text += message.params.delta || '';
    }
    if (message.method === 'turn/completed') {
      const state = this.turns.get(message.params.turn.id);
      if (state) state.resolve({ text: state.text, turn: message.params.turn });
    }
  }

  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      setTimeout(() => {
        const pending = this.pending.get(id);
        if (pending) { this.pending.delete(id); pending.reject(new Error(`${method} 请求超时`)); }
      }, 30_000).unref();
    });
  }

  async listThreads() {
    await this.start();
    const result = await this.request('thread/list', { limit: TASK_LIMIT, archived: false });
    return result.data || [];
  }

  async continueThread(threadId, input) {
    await this.start();
    await this.request('thread/resume', { threadId, excludeTurns: true });
    const started = await this.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: input, text_elements: [] }],
      turnTrigger: 'feishu-private-bridge',
    });
    const turnId = started.turn.id;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.turns.delete(turnId);
        reject(new Error('任务运行超过 20 分钟，已停止等待；可稍后发送“状态 N”查看。'));
      }, 20 * 60 * 1000);
      this.turns.set(turnId, {
        text: '',
        resolve: (result) => { clearTimeout(timeout); this.turns.delete(turnId); resolve(result); },
      });
    });
  }
}

function taskLabel(thread, index) {
  const title = clean(thread.name || thread.preview || '未命名任务').replace(/\s+/g, ' ');
  const folder = clean(thread.cwd).replace(os.homedir(), '~');
  const status = thread.status?.type === 'active' ? '进行中' : '可继续';
  return `${index}. ${title}\n   ${status}｜${folder}`;
}

class Bridge {
  constructor(config) {
    this.config = config;
    this.codex = new CodexClient();
    this.lastTasks = [];
    this.channel = null;
  }

  async send(chatId, text) { await this.channel.send(chatId, { text: clip(text) }); }

  async handle(message) {
    if (message.chatType !== 'p2p' || message.rawContentType !== 'text') return;
    const text = clean(message.content);
    if (!text) return;
    if (!this.config.allowedOpenId) {
      if (text === `绑定 ${this.config.pairingCode}`) {
        this.config.allowedOpenId = message.senderId;
        this.config.pairingCode = '';
        writeConfig(this.config);
        await this.send(message.chatId, '绑定成功。以后只有你的私聊指令会被执行。发送“列出任务”开始。');
      } else {
        await this.send(message.chatId, `首次使用请发送：绑定 ${this.config.pairingCode}`);
      }
      return;
    }
    if (message.senderId !== this.config.allowedOpenId) return;
    try {
      if (/^(列出任务|任务列表|列任务)$/.test(text)) return await this.list(message.chatId);
      const match = text.match(/^继续\s*(\d+)\s*[:：]\s*([\s\S]+)/);
      if (match) return await this.continue(message.chatId, Number(match[1]), match[2]);
      const status = text.match(/^状态\s*(\d+)$/);
      if (status) return await this.status(message.chatId, Number(status[1]));
      await this.send(message.chatId, '可用指令：\n• 列出任务\n• 继续 2：你的工作要求\n• 状态 2');
    } catch (error) {
      console.error(error);
      await this.send(message.chatId, `执行失败：${error.message}`);
    }
  }

  async list(chatId) {
    const tasks = await this.codex.listThreads();
    this.lastTasks = tasks;
    if (!tasks.length) return this.send(chatId, '当前没有可继续的 Codex 任务。');
    await this.send(chatId, `当前任务：\n\n${tasks.map(taskLabel).join('\n\n')}\n\n回复：继续 编号：你的要求`);
  }

  async status(chatId, number) {
    const tasks = await this.codex.listThreads();
    const task = tasks[number - 1];
    if (!task) return this.send(chatId, '没有这个编号。请先发送“列出任务”。');
    await this.send(chatId, `${taskLabel(task, number)}\n\n当前状态：${task.status?.type || '未知'}`);
  }

  async continue(chatId, number, request) {
    if (!this.lastTasks.length) this.lastTasks = await this.codex.listThreads();
    const task = this.lastTasks[number - 1];
    if (!task) return this.send(chatId, '没有这个编号。请先发送“列出任务”。');
    await this.send(chatId, `已接收：继续“${task.name || task.preview}”。\n执行中……`);
    const result = await this.codex.continueThread(task.id, request);
    await this.send(chatId, `完成：\n${result.text || '任务已完成，但没有返回文字结果。'}`);
  }

  async start() {
    if (!this.config.appId || !this.config.appSecret) throw new Error('未找到飞书应用凭证。');
    this.channel = createLarkChannel({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: 1,
      policy: { dmMode: 'open' },
    });
    this.channel.on('message', (message) => this.handle(message));
    this.channel.on('error', (error) => console.error('[feishu]', error.message));
    this.channel.on('reconnecting', () => console.error('[feishu] reconnecting'));
    this.channel.on('reconnected', () => console.error('[feishu] reconnected'));
    await this.channel.connect();
    console.log('Feishu-Codex bridge connected.');
    console.log(this.config.allowedOpenId ? 'Private user already bound.' : `Pair in Feishu with: 绑定 ${this.config.pairingCode}`);
  }
}

async function main() {
  const bridge = new Bridge(loadConfig());
  await bridge.start();
}

main().catch((error) => { console.error(error); process.exit(1); });
