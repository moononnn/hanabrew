/**
 * 花酿 — 浏览器启动器
 * 负责检测并启动系统的 Chromium 浏览器进程，
 * 以 --app 模式弹出独立窗口运行酒馆前端。
 *
 * 设计目标：
 * 1. 不内嵌任何浏览器二进制，依赖用户系统已有的 Chromium 系浏览器
 * 2. 跨平台：Windows / macOS / Linux
 * 3. 复用已启动的进程，避免每次点开花酿都开新窗口
 * 4. 浏览器进程独立于 Hana，关闭 Hana 不会关闭酒馆窗口
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:os';

// 平台标识
const OS = platform();

// 已启动的浏览器进程（URL -> { proc, binary, lastActiveAt }）
const _runningBrowsers = new Map();

/**
 * 启动浏览器时附加的额外参数
 * 不同浏览器对 ST 前端的兼容性差异巨大，需要针对性配置
 */
function getBrowserSpecificArgs(name) {
  const lower = name.toLowerCase();
  if (lower.includes('edge') || lower.includes('msedge')) {
    // Edge 黑屏修复：禁用所有安全/隐私/Edge 特有功能
    return [
      // 禁用 Edge 特有功能
      '--disable-features=msSmartScreenProtection,TrackingProtection,EdgeAutoUpdate,EdgeWalletSidebar,EdgeShoppingCarts,EdgeAIThemes,EdgeAssist,msEdgeSidebar,msEdgeAutoUpdate',
      // 禁用可能拦截的扩展和功能
      '--disable-extensions',
      '--disable-component-update',
      '--disable-domain-reliability',
      '--disable-client-side-phishing-detection',
      '--disable-breakpad',
      '--disable-features=TranslateUI,InfiniteSessionRestore',
      // 禁用 Edge PWA 安装提示
      '--disable-pwa-install-value',
      '--disable-features=WebOTP,WebPaymentRequest',
      // 注：Edge 不支持 --disable-blink-features=AutomationControlled（Chrome 专属）
      // 允许本地不安全内容
      '--allow-running-insecure-content',
      // 不缓存到磁盘
      '--disk-cache-size=0',
      '--media-cache-size=0',
      // 避免 Edge 启动闪页
      '--no-first-run',
      '--no-default-browser-check',
      '--no-pings',
      // 禁用 Edge 同步弹窗、个人资料引导、新闻等所有 Edge 特有功能
      '--disable-sync',
      '--disable-features=EdgeWalkieTalkie,EdgeShoppingCarts,EdgeAIThemes,msEdgeSidebar,msEdgeAutoUpdate,EdgeFeed,EdgeAutoUpdate,EdgePromo,EdgeNewsFeed,msEdgeRewards,EdgeCollections,EdgeHistory,EdgeWalletSidebar,EdgeAssist,EdgeAICompanion',
    ];
  }
  if (lower.includes('chrome')) {
    return [
      '--disable-features=Translate,InfiniteSessionRestore',
      '--no-first-run',
    ];
  }
  return [];
}

/**
 * 获取所有候选浏览器路径（按优先级排序）
 * @returns {string[]}
 */
export function findChromiumCandidates() {
  if (OS === 'win32') {
    const candidates = [
      // Edge 优先（Windows 10/11 系统自带，覆盖率高）
      join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(process.env['ProgramFiles'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      // Chrome 作为后备（如果以后装了）
      join(process.env['ProgramFiles'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(process.env['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(process.env['LocalAppData'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      // Brave
      join(process.env['LocalAppData'] || '', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      // Vivaldi
      join(process.env['LocalAppData'] || '', 'Vivaldi', 'Application', 'vivaldi.exe'),
      // Arc
      join(process.env['LocalAppData'] || '', 'Arc', 'Application', 'Arc.exe'),
    ];
    return candidates.filter(p => p && existsSync(p));
  }

  if (OS === 'darwin') {
    const candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi',
      '/Applications/Arc.app/Contents/MacOS/Arc',
    ];
    return candidates.filter(p => existsSync(p));
  }

  if (OS === 'linux') {
    const candidates = [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
      '/usr/bin/brave-browser',
      '/usr/bin/vivaldi',
      '/snap/bin/chromium',
    ];
    return candidates.filter(p => existsSync(p));
  }

  return [];
}

/**
 * 查找第一个可用的浏览器二进制路径
 * @returns {{ binary: string, name: string } | null}
 */
export function findChromiumBinary() {
  const candidates = findChromiumCandidates();
  if (candidates.length === 0) return null;

  const binary = candidates[0];
  const name = binaryName(binary);
  return { binary, name };
}

/**
 * 从完整路径提取浏览器名称（用于显示）
 */
function binaryName(binaryPath) {
  const file = binaryPath.split(/[\\/]/).pop() || binaryPath;
  const lower = file.toLowerCase();
  if (lower.includes('msedge') || lower.includes('edge')) return 'Edge';
  if (lower.includes('chrome')) return 'Chrome';
  if (lower.includes('brave')) return 'Brave';
  if (lower.includes('vivaldi')) return 'Vivaldi';
  if (lower.includes('arc')) return 'Arc';
  if (lower.includes('chromium')) return 'Chromium';
  return file.replace(/\.exe$/i, '');
}

/**
 * 检查指定 URL 对应的浏览器进程是否仍在运行
 */
export function isBrowserRunning(url) {
  const entry = _runningBrowsers.get(url);
  if (!entry) return false;
  // 检查子进程是否还活着
  try {
    // kill 信号 0 只检查存在性，不实际杀进程
    process.kill(entry.proc.pid, 0);
    entry.lastActiveAt = Date.now();
    return true;
  } catch {
    // 进程已死，清除
    _runningBrowsers.delete(url);
    return false;
  }
}

/**
 * 启动浏览器加载指定 URL（--app 模式，无地址栏标签栏）
 *
 * @param {string} url - 要加载的 URL（通常是 http://127.0.0.1:PORT/）
 * @param {object} [options]
 * @param {string} [options.binary] - 指定浏览器二进制路径；不指定则自动选择
 * @param {string} [options.userDataDir] - 独立用户数据目录（避免与用户日常浏览器冲突）
 * @param {string[]} [options.extraArgs] - 额外启动参数
 * @returns {{ ok: true, binary: string, name: string, pid: number, reused: boolean }
 *        | { ok: false, reason: string }}
 */
export function spawnBrowser(url, options = {}) {
  // 复用检查：如果 URL 对应的进程还在跑，就不重启
  if (isBrowserRunning(url) && !options.forceRestart) {
    const entry = _runningBrowsers.get(url);
    return {
      ok: true,
      binary: entry.binary,
      name: binaryName(entry.binary),
      pid: entry.proc.pid,
      reused: true,
    };
  }

  // 选择浏览器
  let binary;
  let name;
  if (options.binary && existsSync(options.binary)) {
    binary = options.binary;
    name = binaryName(binary);
  } else {
    const found = findChromiumBinary();
    if (!found) {
      return {
        ok: false,
        reason: 'no_browser',
        message: '未找到可用的 Chromium 浏览器（需要 Chrome/Edge/Brave/Vivaldi/Arc 之一）',
        candidates: findChromiumCandidates(),
      };
    }
    binary = found.binary;
    name = found.name;
  }

  // 构造启动参数
  const args = [
    `--app=${url}`,
    '--new-window',
    // 花酿是本地应用，禁用一些用不上的功能
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    // 给 ST 一个稳定的用户数据目录，避免与用户日常 Chrome 的 Cookie/缓存冲突
    options.userDataDir ? `--user-data-dir=${options.userDataDir}` : null,
    ...getBrowserSpecificArgs(name),
    ...(options.extraArgs || []),
  ].filter(Boolean);

  // 启动
  let proc;
  try {
    proc = spawn(binary, args, {
      detached: true, // 独立进程组，关闭 Hana 不会关闭浏览器
      stdio: 'ignore', // 不需要 stdin/stdout/stderr
      windowsHide: false,
    });
  } catch (e) {
    return {
      ok: false,
      reason: 'spawn_failed',
      message: `启动浏览器失败: ${e.message}`,
      binary,
      name,
    };
  }

  // 处理异常退出
  proc.on('error', (err) => {
    _runningBrowsers.delete(url);
    // eslint-disable-next-line no-console
    console.error('[hanabrew] browser exited with error:', err.message);
  });

  proc.on('exit', (code, signal) => {
    _runningBrowsers.delete(url);
    // eslint-disable-next-line no-console
    console.log(`[hanabrew] browser exited: code=${code} signal=${signal}`);
  });

  // 让 Hana 主进程独立于浏览器进程（Hana 退出不会拖死浏览器）
  proc.unref?.();

  _runningBrowsers.set(url, {
    proc,
    binary,
    lastActiveAt: Date.now(),
  });

  return {
    ok: true,
    binary,
    name,
    pid: proc.pid,
    reused: false,
  };
}

/**
 * 关闭指定 URL 对应的浏览器进程
 */
export function closeBrowser(url) {
  const entry = _runningBrowsers.get(url);
  if (!entry) return false;
  try {
    entry.proc.kill();
  } catch {
    // 已死
  }
  _runningBrowsers.delete(url);
  return true;
}

/**
 * 关闭所有花酿启动的浏览器进程
 */
export function closeAllBrowsers() {
  for (const [url, entry] of _runningBrowsers) {
    try {
      entry.proc.kill();
    } catch {
      // 忽略
    }
  }
  _runningBrowsers.clear();
}

/**
 * 获取当前所有运行中的浏览器信息（用于状态面板）
 */
export function listRunningBrowsers() {
  const result = [];
  for (const [url, entry] of _runningBrowsers) {
    result.push({
      url,
      binary: entry.binary,
      pid: entry.proc.pid,
      lastActiveAt: entry.lastActiveAt,
    });
  }
  return result;
}