// 花酿 ST 依赖保障模块
// 职责：检查 sillytavern/node_modules 是否就绪；缺失时自动 npm ci（带重试 + 镜像源切换）；
//       安装状态持久化到 state.json，失败冷却 + 支持手动强制重试；装完校验关键依赖。
// 兜底：用户可手动把依赖包解压到 sillytavern/node_modules，depsReady() 检测到即跳过安装。
import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { readState, writeState } from './store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ST_DIR = join(__dirname, '..', 'sillytavern');
const NODE_MODULES = join(ST_DIR, 'node_modules');

// 安装状态键（存 state.json）
const DEPS_KEY = 'stDeps';
// 失败后冷却：5 分钟内不自动重试（防止刷新页面就触发重装）
const RETRY_COOLDOWN_MS = 5 * 60 * 1000;
// 最多尝试次数：官方源 → 官方源 → 镜像源
const MAX_ATTEMPTS = 3;
// 失败后的等待（第 1 次失败等 30s，第 2 次失败等 60s）
const BACKOFF_MS = [30_000, 60_000];
// 官方源优先，重试时切到国内镜像（npmmirror）
const REGISTRIES = ['https://registry.npmjs.org/', 'https://registry.npmmirror.com/'];
// 单次 npm ci 超时
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

// npm ci 成功后的关键依赖抽查
const KEY_PACKAGES = ['express', 'ws', 'dompurify'];

let _installPromise = null; // 并发锁：同一时间只有一个安装流程

/** 关键依赖是否就绪 */
export function depsReady(stDir = ST_DIR) {
  const nm = join(stDir, 'node_modules');
  if (!existsSync(nm)) return false;
  return KEY_PACKAGES.every((p) => existsSync(join(nm, p, 'package.json')));
}

function appendDepsLog(line) {
  try {
    const dir = join(process.env.APPDATA || dirname(process.execPath), 'hanabrew', 'logs');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'deps.log'), `${new Date().toISOString()} ${line}\n`, 'utf-8');
  } catch { /* 日志失败不影响主流程 */ }
}

/** 执行一次 npm ci，返回 { code, output } */
function runNpmCi(registry, stDir = ST_DIR, timeoutMs = INSTALL_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const common = ['ci', '--no-audit', '--no-fund', '--registry', registry];
    // 优先用 Node 自带的 npm-cli.js，完全不经 shell。
    // 找不到时才兜底：Windows 用 cmd.exe /c（参数是固定常量列表，不做 shell 字符串拼接），
    // 其他平台直接找 npm可执行文件。
    // 不能写成 spawn('npm.cmd', ..., { shell: false })：Node 18.20.2+ 对 .cmd/.bat 要求 shell: true，
    // 直接 spawn 会抛 EINVAL（已在本机 Node 24 复现）。
    const child = existsSync(npmCli)
      ? spawn(process.execPath, [npmCli, ...common], { cwd: stDir, windowsHide: true })
      : process.platform === 'win32'
        ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', ['npm', ...common].join(' ')], { cwd: stDir, windowsHide: true })
        : spawn('npm', common, { cwd: stDir, windowsHide: true });

    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { child.kill('SIGKILL'); } catch {}
        resolve({ code: -1, output: `${output}\n[安装超时，已终止]` });
      }
    }, timeoutMs);

    child.stdout?.on('data', (d) => { output += d.toString(); });
    child.stderr?.on('data', (d) => { output += d.toString(); });
    child.on('error', (e) => {
      if (!settled) { settled = true; clearTimeout(timer); resolve({ code: -2, output: e.message }); }
    });
    child.on('exit', (code) => {
      if (!settled) { settled = true; clearTimeout(timer); resolve({ code, output }); }
    });
  });
}

/** 带重试和镜像源切换的安装流程 */
async function installWithRetry(ctx = {}, exec = runNpmCi, stDir = ST_DIR, onProgress, backoffMs = BACKOFF_MS) {
  let lastOutput = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const registry = REGISTRIES[Math.min(attempt - 1, REGISTRIES.length - 1)];
    ctx.log?.info?.(`[hanabrew:deps] npm ci 第 ${attempt}/${MAX_ATTEMPTS} 次，源：${registry}`);
    appendDepsLog(`install attempt ${attempt} registry=${registry}`);
    onProgress?.({ phase: 'installing', attempt, registry });

    const res = await exec(registry, stDir);
    lastOutput = res.output || '';

    if (res.code === 0 && depsReady(stDir)) {
      appendDepsLog('install OK');
      return { ok: true, output: lastOutput };
    }
    appendDepsLog(`attempt ${attempt} failed code=${res.code}`);

    if (attempt < MAX_ATTEMPTS) {
      const wait = backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] ?? 60_000;
      ctx.log?.info?.(`[hanabrew:deps] 第 ${attempt} 次失败，${Math.round(wait / 1000)}s 后重试`);
      onProgress?.({ phase: 'retrying', attempt, waitMs: wait });
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  return { ok: false, output: lastOutput };
}

function readDepsState(state) {
  const s = state?.[DEPS_KEY];
  return s && typeof s === 'object' ? s : {};
}

/**
 * 确保 ST 依赖就绪。
 * @param {object} ctx Hana 上下文
 * @param {object} opts { force?: boolean, stDir?: string, exec?: Function }
 * @returns {Promise<{status:'ok'|'installing'|'failed', message:string, cooldown?:boolean}>}
 */
export async function ensureStDeps(ctx = {}, opts = {}) {
  const stDir = opts.stDir || ST_DIR;
  const exec = opts.exec || runNpmCi;

  // 已就绪：直接返回 ok（手动解压依赖包也能走到这）
  if (depsReady(stDir)) {
    const state = await readState(ctx);
    if (readDepsState(state).status !== 'ok') {
      await writeState({ ...state, [DEPS_KEY]: { status: 'ok', okAt: new Date().toISOString() } }, ctx);
    }
    return { status: 'ok', message: '依赖已就绪' };
  }

  const force = !!opts.force;

  // 冷却检查：失败后一段时间内不自动重试
  if (!force) {
    const state = await readState(ctx);
    const deps = readDepsState(state);
    if (deps.status === 'failed' && deps.failedAt) {
      const elapsed = Date.now() - new Date(deps.failedAt).getTime();
      if (elapsed >= 0 && elapsed < RETRY_COOLDOWN_MS) {
        const left = Math.ceil((RETRY_COOLDOWN_MS - elapsed) / 1000);
        return { status: 'failed', message: `上次安装失败，${left} 秒后可自动重试，也可以点击「强制重试」`, cooldown: true };
      }
    }
  }

  // 并发锁：安装进行中
  if (_installPromise) {
    return { status: 'installing', message: '依赖正在安装中，请稍候…' };
  }

  // 标记 installing 并启动安装
  await writeState({
    ...(await readState(ctx)),
    [DEPS_KEY]: { status: 'installing', startedAt: new Date().toISOString() },
  }, ctx);

  _installPromise = (async () => {
    const result = await installWithRetry(ctx, exec, stDir, undefined, opts.backoffMs);
    const next = result.ok
      ? { status: 'ok', okAt: new Date().toISOString() }
      : { status: 'failed', failedAt: new Date().toISOString(), message: (result.output || '').slice(-500) };
    await writeState({ ...(await readState(ctx)), [DEPS_KEY]: next }, ctx);
    return result.ok
      ? { status: 'ok', message: '依赖已就绪' }
      : { status: 'failed', message: next.message || '安装失败，请稍后重试或查看说明手动安装依赖' };
  })();

  try {
    return await _installPromise;
  } finally {
    _installPromise = null;
  }
}

// 供测试注入用
export const _internal = { DEPS_KEY, RETRY_COOLDOWN_MS, MAX_ATTEMPTS, REGISTRIES };
