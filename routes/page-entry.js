/**
 * 花酿 — ST 子进程管理、Hana 内嵌 WebUI 与 Edge 备用入口；版本号一律从 manifest.json 读取
 *
 * 工作流：
 * 1. 访问 /tavern → ensureServer() 查找空闲端口 → spawn ST server.js → Hana iframe 内嵌
 * 2. 访问 /legacy → 复用同一 ST 服务 → 弹出 Edge 独立窗口
 * 3. ST 自行管理 settings、secrets、模型列表和完整酒馆界面
 * 4. 助手通过 agent 工具读 ST 的 data/ 目录
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { appendFileSync, mkdirSync, existsSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';

import { spawnBrowser } from '../lib/browser.js';
import { ensureStDeps } from '../backend/ensure-deps.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ST_DIR = join(__dirname, '..', 'sillytavern');
const LOG_DIR = join(process.env.APPDATA || tmpdir(), 'hanabrew', 'logs');
const LOG_FILE = join(LOG_DIR, 'request-log.jsonl');
const MANIFEST_PATH = join(__dirname, '..', 'manifest.json');

/** 插件版本号的唯一来源是 manifest.json，避免注释和状态页各写一份手抄版 */
function pluginVersion() {
  try {
    const v = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')).version;
    return typeof v === 'string' ? v.trim() : '';
  } catch {
    return '';
  }
}

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
export async function ensureServer() {
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

    // 固定端口（每次打开花酿用同一个，助手不用关心端口变化）
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
        throw new Error('未检测到 Node.js。请先安装 Node.js 20+（https://nodejs.org）');
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
      const entries = readdirSync(tmpdir());
      const oldDirs = entries
        .filter(n => n.startsWith('hanabrew-chrome-') && n !== `hanabrew-chrome-${stamp}`)
        .map(n => ({ name: n, path: join(tmpdir(), n), mtime: statSync(join(tmpdir(), n)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      for (const d of oldDirs.slice(3)) {
        try { rmSync(d.path, { recursive: true, force: true }); } catch {}
      }
    } catch {}
  });

  return spawnBrowser(serverUrl, { userDataDir });
}

/** Hana 内嵌酒馆页面：复用本地 ST 服务，但不启动外部浏览器。 */
export function renderEmbeddedPage({ serverUrl, error }) {
  const escape = (value) => String(value || '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
  const body = serverUrl
    ? `<iframe id="st-frame" src="${escape(serverUrl)}" title="SillyTavern" allow="clipboard-read; clipboard-write; fullscreen"></iframe>`
    : `<main class="error-card"><h1>酒馆暂时没有启动</h1><p>${escape(error || '未知错误')}</p><button type="button" onclick="location.reload()">重新启动</button></main>`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>花酿 · 内嵌酒馆</title>
<style>
  html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #f5efe4; }
  body { font-family: system-ui, -apple-system, "Microsoft YaHei", sans-serif; color: #2a2622; }
  #st-frame { display: block; width: 100%; height: 100%; border: 0; background: #fff; }
  .error-card { width: min(560px, calc(100% - 40px)); margin: 14vh auto 0; padding: 28px; box-sizing: border-box; border: 1px solid #d8cfbe; border-radius: 14px; background: #fbf7ee; }
  .error-card h1 { margin: 0 0 8px; font-size: 20px; }
  .error-card p { color: #6b6158; line-height: 1.6; white-space: pre-wrap; }
  .error-card button { border: 1px solid #537d96; border-radius: 8px; padding: 8px 14px; color: #537d96; background: transparent; cursor: pointer; }
</style>
</head>
<body>
${body}
<script>
window.parent.postMessage({ protocol: 'hana.plugin.ui', version: 1, kind: 'event', type: 'hana.ready' }, '*');
window.parent.postMessage({ type: 'ready' }, '*');
</script>
<script>
// 花酿 · 内嵌酒馆「跟随 Hana 主题」：轮询宿主主题状态 → postMessage 给酒馆 iframe
(function () {
  var frame = document.getElementById('st-frame');
  if (!frame) return;
  // 直连宿主原生主题接口（插件页面同源带凭证，稳）
  var endpoint = '/api/preferences/appearance';
  var lastDark = null;
  function isDarkTheme(theme) {
    return theme === 'midnight' || theme === 'midnight-contrast';
  }
  // 兼容多种返回结构：{appearance:{theme}} | {theme} | 直接字符串
  function extractTheme(state) {
    if (!state) return '';
    if (typeof state === 'string') return state;
    if (state.appearance && state.appearance.theme) return state.appearance.theme;
    if (state.theme) return state.theme;
    return '';
  }
  function sync() {
    fetch(endpoint, { headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (state) {
        if (!state) return;
        var theme = extractTheme(state);
        if (!theme) return;
        var dark = isDarkTheme(theme);
        if (dark !== lastDark) {
          lastDark = dark;
          frame.contentWindow.postMessage({ type: 'hana-theme-sync', dark: dark, theme: theme }, '*');
        }
      })
      .catch(function () {});
  }
  // 页面加载时：优先读 URL 参数（即时生效），随后轮询覆盖
  try {
    var urlTheme = new URLSearchParams(location.search).get('hana-theme') || '';
    if (urlTheme) {
      lastDark = isDarkTheme(urlTheme);
      frame.contentWindow.postMessage({ type: 'hana-theme-sync', dark: lastDark, theme: urlTheme }, '*');
    }
  } catch (e) {}
  // 酒馆 iframe 刷新后主动请求当前状态时，立即响应一轮
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (d && typeof d === 'object' && d.type === 'hana-theme-sync-request') {
      fetch(endpoint, { headers: { 'Accept': 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (state) {
          if (state) {
            var theme = extractTheme(state);
            if (theme) {
              lastDark = isDarkTheme(theme);
              frame.contentWindow.postMessage({ type: 'hana-theme-sync', dark: lastDark, theme: theme }, '*');
            }
          }
        })
        .catch(function () {});
    }
  });
  sync();
  setInterval(sync, 2000);
})();
</script>
</body>
</html>`;
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
  /* 滚动条统一：细薄荷圆条（2026-08-26，深色底适配） */
  *::-webkit-scrollbar{width:8px;height:8px}
  *::-webkit-scrollbar-track{background:transparent}
  *::-webkit-scrollbar-thumb{background:#c9dfd3;border-radius:99px;border:2px solid rgba(10,14,26,.8)}
  *::-webkit-scrollbar-thumb:hover{background:#5dae8e}
  *{scrollbar-width:thin;scrollbar-color:#c9dfd3 transparent}
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
    ${pluginVersion() ? `花酿 v${pluginVersion()} · ` : ''}ST 1.18.0 原生引擎 · 独立 Edge 窗口运行
  </div>
</div>
</body>
</html>`;
}

/** 依赖安装/失败状态页 */
function renderDepsPage(deps) {
  const escape = (s) => String(s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const installing = deps.status === 'installing';
  const refresh = installing ? `<meta http-equiv="refresh" content="5">` : "";
  const detail = deps.message && deps.status === 'failed' ? `
    <details style="margin-top:16px">
      <summary style="cursor:pointer;color:#94a3b8;font-size:12px">安装错误详情</summary>
      <pre style="background:rgba(0,0,0,0.3);padding:8px;border-radius:6px;font-size:11px;color:#94a3b8;max-height:200px;overflow:auto;margin-top:4px;white-space:pre-wrap">${escape(deps.message)}</pre>
    </details>` : "";
  const body = installing ? `
    <div class="row">
      <div class="icon installing">…</div>
      <div class="label">
        <div class="row-title">正在安装酒馆引擎依赖</div>
        <div class="row-sub">第一次使用需要下载依赖（约几百 MB），可能需要几分钟。页面会自动刷新，装好后自动进入酒馆。</div>
      </div>
    </div>` : `
    <div class="row">
      <div class="icon err">X</div>
      <div class="label">
        <div class="row-title">依赖安装失败</div>
        <div class="row-sub">${escape(deps.message || '未知错误')}</div>
      </div>
    </div>
    <div class="actions">
      <a href="/legacy?retryDeps=1" class="btn">强制重试</a>
    </div>
    <div class="err-box">
      <div class="err-title">手动安装方案（网络实在不行时）</div>
      <div class="err-text">
        1. 到花酿的 GitHub Release 页面下载「依赖包」（deps zip）<br>
        2. 解压后把 node_modules 文件夹放进插件目录的 sillytavern/ 下<br>
        3. 刷新本页即可
      </div>
    </div>`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>花酿酒馆</title>
${refresh}
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  /* 滚动条统一：细薄荷圆条（2026-08-26，深色底适配） */
  *::-webkit-scrollbar{width:8px;height:8px}
  *::-webkit-scrollbar-track{background:transparent}
  *::-webkit-scrollbar-thumb{background:#c9dfd3;border-radius:99px;border:2px solid rgba(10,14,26,.8)}
  *::-webkit-scrollbar-thumb:hover{background:#5dae8e}
  *{scrollbar-width:thin;scrollbar-color:#c9dfd3 transparent}
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
  .icon.err { background: #ef4444; color: #fff; }
  .icon.installing { background: #f59e0b; color: #fff; }
  .row-title { font-size: 14px; color: #e2e8f0; }
  .row-sub { font-size: 12px; color: #94a3b8; margin-top: 2px; line-height: 1.5; }
  .actions { display: flex; gap: 8px; margin-top: 16px; }
  .btn {
    background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.12);
    color: #e0e0e0; padding: 8px 16px; border-radius: 8px; cursor: pointer; font-size: 13px; text-decoration: none; display: inline-block;
  }
  .err-box { background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 10px; padding: 16px; margin-top: 16px; }
  .err-title { font-size: 14px; color: #fca5a5; font-weight: 600; margin-bottom: 6px; }
  .err-text { font-size: 13px; color: #fca5a5; line-height: 1.7; }
</style>
</head>
<body>
<div class="card">
  <div class="title">花酿酒馆</div>
  <div class="subtitle">SillyTavern 1.18.0 原生引擎 · 助手实时调试</div>
  ${body}
  ${detail}
</div>
</body>
</html>`;
}

/** 注册花酿路由 */
export default async function registerRoutes(app, ctx = {}) {
  // 内嵌酒馆跟随 Hana 主题：路由注册时再做一次幂等启动，兼容旧宿主未触发生命周期的情况。
  try {
    const themeSync = await import('../backend/theme-sync.js');
    themeSync.startThemeSync(ctx);
    // 保留 theme-sync 接口（幂等）
    app.get('/api/tavern/theme-sync', (c) => {
      return c.json(themeSync.readHanaThemeState());
    });
  } catch (e) {
    ctx.log?.warn?.('[hanabrew] theme-sync start failed:', e.message);
  }

  app.get('/legacy', async (c) => {
    // 第一步：依赖保障（缺依赖先装，装好才启动 ST）
    const forceRetry = String(c.req?.url || '').includes('retryDeps=1');
    const deps = await ensureStDeps(ctx, { force: forceRetry });
    if (deps.status !== 'ok') {
      return c.html(renderDepsPage(deps), deps.status === 'installing' ? 200 : 500);
    }

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

  // Hana 页面默认内嵌完整 ST；旧 Edge 酒馆仍由 /legacy 提供备用入口。
  app.get('/tavern', async (c) => {
    let serverUrl = '';
    let error = null;
    const deps = await ensureStDeps(ctx);
    if (deps.status !== 'ok') {
      error = deps.message || 'SillyTavern 依赖尚未就绪。';
    } else {
      try {
        serverUrl = await ensureServer();
      } catch (e) {
        error = e.message;
        ctx.log?.error?.('[hanabrew] Embedded ST failed:', e.message);
      }
    }
    return c.html(renderEmbeddedPage({ serverUrl, error }), serverUrl ? 200 : 500);
  });

  // 兼容旧书签与旧宿主 page 入口：转入内嵌酒馆，不再默认弹 Edge。
  app.get('/page', (c) => {
    const target = new URL(c.req.url);
    target.pathname = target.pathname.replace(/\/page$/, '/tavern');
    return c.redirect(target.toString());
  });
}

// 暴露给 index.js 用于 onunload 清理
export function getStProcess() { return stProcess; }
export function setStProcess(p) { stProcess = p; globalThis.__hanabrew_state._stProcess = p; }
export function getStServerUrl() { return stServerUrl; }
export function getStPort() { return stPort; }
