/**
 * 花酿 v0.4.0 — 路由入口 + ST 子进程管理 + 浏览器启动
 *
 * 工作流：
 * 1. 访问 /page → ensureServer() 查找空闲端口 → spawn ST server.js
 * 2. ST 自行管理所有 API（settings、secrets、模型列表、聊天等），零兼容问题
 * 3. 等待 ST 启动完成 → 弹出 Edge 独立窗口
 * 4. 助手通过 agent 工具读 ST 的 data/ 目录
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { appendFileSync, mkdirSync, existsSync } from 'node:fs';

import { spawnBrowser } from '../lib/browser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ST_DIR = join(__dirname, '..', 'sillytavern');
const LOG_DIR = join(process.env.APPDATA || tmpdir(), 'hanabrew', 'logs');
const LOG_FILE = join(LOG_DIR, 'request-log.jsonl');

// ST 子进程状态
let stProcess = null;
let stPort = 0;
let stServerUrl = '';
let _startingPromise = null; // 并发保护锁

// 防止 Hana sandbox GC 回收
if (!globalThis.__hanabrew_state) {
  globalThis.__hanabrew_state = {};
}
if (!globalThis.__hanabrew_state._stProcess) {
  globalThis.__hanabrew_state._stProcess = null;
}

function ensureLogDir() {
  try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}
}

function appendLog(entry) {
  ensureLogDir();
  try { appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', 'utf-8'); } catch {}
}

/** 查找空闲端口 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

/** 等待 ST 服务器就绪（轮询 POST /api/ping） */
async function waitForStart(port, timeoutMs = 30000) {
  const start = Date.now();
  const url = `http://127.0.0.1:${port}/api/ping`;
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(2000) });
      if (r.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('ST 启动超时');
}

/** 启动 ST 服务器（如果尚未运行），带并发保护 */
async function ensureServer() {
  // 如果已有启动中的 Promise，复用
  if (_startingPromise) return _startingPromise;

  // ST 已运行且存活
  if (stPort && stServerUrl) {
    try {
      const alive = await fetch(stServerUrl + 'api/ping', { method: 'POST', signal: AbortSignal.timeout(800) });
      if (alive.ok) return stServerUrl;
    } catch {}
    // 进程死了，清理
    try { stProcess?.kill('SIGKILL'); } catch {}
    stProcess = null;
    stPort = 0;
    stServerUrl = '';
  }

  // 创建启动锁
  _startingPromise = (async () => {
    appendLog({ ts: new Date().toISOString(), event: 'st.start.begin' });

    // 固定端口（每次打开花酿用同一个，悠米不用关心端口变化）
    // 如果端口被占用会自动 fallback 到随机端口
    const ST_PORT = 18500;
    let port = ST_PORT;
    // 检查固定端口是否可用
    const portInUse = await new Promise(r => {
      const s = createServer();
      s.on('error', () => r(true));
      s.listen(ST_PORT, '127.0.0.1', () => { s.close(() => r(false)); });
    });
    if (portInUse) {
      port = await findFreePort();
      appendLog({ ts: new Date().toISOString(), event: 'st.port_fallback', reason: `${ST_PORT} in use`, fallback: port });
    }
    const dataRoot = join(process.env.APPDATA || tmpdir(), 'hanabrew', 'st-data');

    // 确保 data 目录存在
    try { mkdirSync(dataRoot, { recursive: true }); } catch {}

    // 启动 ST server.js（首次启动需要 webpack 编译 + 复制预设文件，可能 15-20 秒）
    let child;
    try {
      child = spawn('node', [
        'server.js',
        '--port', String(port),
        '--listen', 'false',
        '--disableCsrf', 'true',
        '--whitelist', 'false',
        '--dataRoot', dataRoot,
        '--browserLaunchEnabled', 'false',
      ], {
        cwd: ST_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      if (e.code === 'ENOENT') {
        throw new Error('未检测到 Node.js。请先安装 Node.js 18+（https://nodejs.org）');
      }
      throw new Error('启动 ST 失败: ' + e.message);
    }

    let startupLogs = '';
    child.stdout.on('data', (d) => { startupLogs += d.toString().slice(0, 5000); });
    child.stderr.on('data', (d) => { startupLogs += '[STDERR] ' + d.toString().slice(0, 2000); });
    child.on('exit', (code) => {
      appendLog({ ts: new Date().toISOString(), event: 'st.exit', code });
      if (stProcess === child) {
        stProcess = null;
        stPort = 0;
        stServerUrl = '';
      }
    });

    stProcess = child;
    globalThis.__hanabrew_state._stProcess = child;
    stPort = port;
    stServerUrl = `http://127.0.0.1:${port}/`;

    appendLog({ ts: new Date().toISOString(), event: 'st.started', port, pid: child.pid, dataRoot });

    // 等待 ST 就绪（首次启动给 60 秒，后续给 30 秒）
    try {
      await waitForStart(port, 60000);
      appendLog({ ts: new Date().toISOString(), event: 'st.ready', port });
      return stServerUrl;
    } catch (e) {
      appendLog({ ts: new Date().toISOString(), event: 'st.timeout', port, log: startupLogs.slice(-2000) });
      throw new Error('ST 启动超时，请检查 Node.js 和 sillytavern 目录');
    }
  })();

  try {
    return await _startingPromise;
  } finally {
    _startingPromise = null;
  }
}

/** 启动浏览器窗口 */
function startTavernWindow(serverUrl) {
  const baseDir = join(tmpdir(), 'hanabrew-chrome');
  const stamp = Date.now();
  const userDataDir = `${baseDir}-${stamp}`;

  // 清理旧临时目录
  setImmediate(() => {
    try {
      const fs = require('node:fs');
      const path = require('node:path');
      const entries = fs.readdirSync(tmpdir());
      const oldDirs = entries
        .filter(n => n.startsWith('hanabrew-chrome-') && n !== `hanabrew-chrome-${stamp}`)
        .map(n => ({ name: n, path: path.join(tmpdir(), n), mtime: fs.statSync(path.join(tmpdir(), n)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      for (const d of oldDirs.slice(3)) {
        try { fs.rmSync(d.path, { recursive: true, force: true }); } catch {}
      }
    } catch {}
  });

  return spawnBrowser(serverUrl, { userDataDir });
}

/** 状态面板 HTML */
function renderStatusPage({ serverRunning, serverUrl, browser, error, stLog }) {
  const escape = (s) => String(s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let browserRow = "";
  let errorBox = "";

  if (browser) {
    if (browser.ok) {
      const reused = browser.reused ? "（已复用）" : "";
      browserRow = `
        <div class="row">
          <div class="icon ok">OK</div>
          <div class="label">
            <div class="row-title">${browser.reused ? "浏览器窗口已就绪" : "已弹出浏览器窗口"}</div>
            <div class="row-sub">${escape(browser.name)} · PID ${browser.pid}${reused}</div>
          </div>
        </div>`;
    } else {
      browserRow = `
        <div class="row">
          <div class="icon err">X</div>
          <div class="label">
            <div class="row-title">未启动浏览器</div>
            <div class="row-sub">${escape(browser.message || browser.reason)}</div>
          </div>
        </div>`;
      if (browser.reason === "no_browser") {
        errorBox = `
          <div class="err-box">
            <div class="err-title">需要 Chromium 浏览器</div>
            <div class="err-text">花酿借用系统已有的 Edge 浏览器启动独立窗口。Windows 11 自带 Edge。</div>
            <div class="err-actions"><a href="https://www.google.com/chrome/" target="_blank" class="btn">下载 Chrome</a></div>
          </div>`;
      }
    }
  }

  const urlBlock = serverUrl ? `
    <div class="url-box">${escape(serverUrl)}</div>
    <div class="actions">
      <button onclick="navigator.clipboard.writeText('${escape(serverUrl)}');this.textContent='已复制';setTimeout(()=>this.textContent='复制地址',1500)">复制地址</button>
      <button onclick="window.location.reload()">刷新状态</button>
    </div>
  ` : "";

  const errorDetail = error ? `<div class="err-text" style="margin-top:12px">错误：${escape(error)}</div>` : "";

  const logSection = stLog ? `
    <details style="margin-top:16px">
      <summary style="cursor:pointer;color:#94a3b8;font-size:12px">ST 启动日志</summary>
      <pre style="background:rgba(0,0,0,0.3);padding:8px;border-radius:6px;font-size:11px;color:#94a3b8;max-height:200px;overflow:auto;margin-top:4px">${escape(stLog)}</pre>
    </details>
  ` : "";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>花酿酒馆</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f1729 100%);
    color: #e0e0e0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px;
  }
  .card {
    background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 16px; padding: 32px 40px; max-width: 560px; width: 100%;
  }
  .title { font-size: 24px; font-weight: 600; margin-bottom: 4px; color: #fff; }
  .subtitle { font-size: 13px; color: #94a3b8; margin-bottom: 24px; }
  .row {
    display: flex; align-items: center; gap: 12px; padding: 12px 16px;
    background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: 10px; margin-bottom: 8px;
  }
  .icon { width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 600; flex-shrink: 0; }
  .icon.ok { background: #10b981; color: #fff; }
  .icon.err { background: #ef4444; color: #fff; }
  .row-title { font-size: 14px; color: #e2e8f0; }
  .row-sub { font-size: 12px; color: #94a3b8; margin-top: 2px; }
  .url-box {
    background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 8px;
    padding: 12px 14px; margin-top: 16px;
    font-family: "JetBrains Mono", "Consolas", "SF Mono", monospace; font-size: 13px; color: #94a3b8; word-break: break-all;
  }
  .actions { display: flex; gap: 8px; margin-top: 16px; }
  button, .btn {
    background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.12);
    color: #e0e0e0; padding: 8px 16px; border-radius: 8px; cursor: pointer; font-size: 13px; text-decoration: none; display: inline-block;
  }
  .err-box { background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 10px; padding: 16px; margin-top: 16px; }
  .err-title { font-size: 14px; color: #fca5a5; font-weight: 600; margin-bottom: 6px; }
  .err-text { font-size: 13px; color: #fca5a5; line-height: 1.5; }
  .err-actions { margin-top: 12px; }
  .footer { margin-top: 24px; padding-top: 16px; border-top: 1px solid rgba(255, 255, 255, 0.06); font-size: 11px; color: #64748b; line-height: 1.6; }
</style>
</head>
<body>
<div class="card">
  <div class="title">花酿酒馆</div>
  <div class="subtitle">SillyTavern 1.18.0 原生引擎 · 助手实时调试</div>

  <div class="row">
    <div class="icon ${serverRunning ? "ok" : "err"}">${serverRunning ? "OK" : "X"}</div>
    <div class="label">
      <div class="row-title">ST 服务器</div>
      <div class="row-sub">${serverRunning ? "已启动 · 监听 127.0.0.1:" + (stPort || "?") : "未启动"}</div>
    </div>
  </div>

  ${browserRow}
  ${urlBlock}
  ${errorBox}
  ${errorDetail}
  ${logSection}

  <div class="footer">
    花酿 v1.0 · ST 1.18.0 原生引擎 · 独立 Edge 窗口运行
  </div>
</div>
</body>
</html>`;
}

/** 注册花酿路由 */
export default async function registerRoutes(app, ctx = {}) {
  app.get('/page', async (c) => {
    const status = {
      serverRunning: false,
      serverUrl: '',
      browser: null,
      error: null,
      stLog: '',
    };

    try {
      await ensureServer();
      status.serverRunning = true;
      status.serverUrl = stServerUrl;
      status.browser = startTavernWindow(stServerUrl);
      ctx.log?.info?.(`[hanabrew] Page opened, st=${stServerUrl}, browser=${status.browser.ok ? status.browser.name : status.browser.reason}`);
    } catch (e) {
      status.error = e.message;
      ctx.log?.error?.('[hanabrew]', e.message);
    }

    const statusCode = status.serverRunning ? 200 : 500;
    return c.html(renderStatusPage(status), statusCode);
  });
}

// 暴露给 index.js 用于 onunload 清理
export function getStProcess() { return stProcess; }
export function setStProcess(p) { stProcess = p; globalThis.__hanabrew_state._stProcess = p; }
