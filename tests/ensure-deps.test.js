// ensure-deps 依赖保障模块测试
// 覆盖：就绪检测、安装成功、安装失败、冷却、强制重试、并发锁、镜像源切换顺序
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureStDeps, depsReady } from '../backend/ensure-deps.js';

// 隔离环境：临时 APPDATA + 临时 stDir
let appDataDir;
let stDir;
let stateFile;

function setupEnv() {
  appDataDir = join(tmpdir(), `hanabrew-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  stDir = join(appDataDir, 'st');
  stateFile = join(appDataDir, 'hanabrew', 'state.json');
  mkdirSync(stDir, { recursive: true });
  process.env.APPDATA = appDataDir;
}

function makeNodeModules() {
  for (const p of ['express', 'ws', 'dompurify']) {
    const dir = join(stDir, 'node_modules', p);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{}');
  }
}

function clearState() {
  if (existsSync(stateFile)) rmSync(stateFile);
}

/** fake exec：记录调用，按脚本返回；code=0 时模拟装好了依赖 */
function makeFakeExec(script) {
  const calls = [];
  const exec = async (registry, dir) => {
    calls.push({ registry, dir });
    const step = script.shift() || { code: 0 };
    if (step.code === 0) makeNodeModules();
    return step;
  };
  exec.calls = calls;
  return exec;
}

test('depsReady：空目录为 false，关键包齐全为 true', () => {
  setupEnv();
  assert.equal(depsReady(stDir), false);
  makeNodeModules();
  assert.equal(depsReady(stDir), true);
});

const FAST_BACKOFF = [1, 1];

test('依赖缺失 + 安装成功 → status ok，状态落盘', async () => {
  setupEnv();
  const exec = makeFakeExec([{ code: 0 }]);
  const result = await ensureStDeps({}, { stDir, exec, backoffMs: FAST_BACKOFF });
  assert.equal(result.status, 'ok');
  // 使用官方源
  assert.equal(exec.calls.length, 1);
  assert.equal(exec.calls[0].registry, 'https://registry.npmjs.org/');
  // 状态落盘
  const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
  assert.equal(state.stDeps.status, 'ok');
  assert.ok(state.stDeps.okAt);
});

test('安装全失败 → failed + failedAt；冷却期内不再自动重试', async () => {
  setupEnv();
  const exec = makeFakeExec([{ code: 1 }, { code: 1 }, { code: 1 }]);
  const result = await ensureStDeps({}, { stDir, exec, backoffMs: FAST_BACKOFF });
  assert.equal(result.status, 'failed');
  // 镜像源切换顺序：官方失败一次即切镜像，后续都在镜像上重试
  const registries = exec.calls.map(c => c.registry);
  assert.deepEqual(registries, [
    'https://registry.npmjs.org/',
    'https://registry.npmmirror.com/',
    'https://registry.npmmirror.com/',
  ]);
  // 冷却期内自动重试被拦
  const again = await ensureStDeps({}, { stDir, exec, backoffMs: FAST_BACKOFF });
  assert.equal(again.status, 'failed');
  assert.equal(again.cooldown, true);
  // 没再触发安装
  assert.equal(exec.calls.length, 3);
});

test('冷却期内 force=true 强制重试 → 成功', async () => {
  setupEnv();
  const exec = makeFakeExec([{ code: 1 }, { code: 1 }, { code: 1 }]);
  await ensureStDeps({}, { stDir, exec, backoffMs: FAST_BACKOFF }); // 失败进冷却
  const exec2 = makeFakeExec([{ code: 0 }]);
  const result = await ensureStDeps({}, { stDir, exec: exec2, force: true, backoffMs: FAST_BACKOFF });
  assert.equal(result.status, 'ok');
  assert.equal(exec2.calls.length, 1);
});

test('安装进行中（并发锁）→ 返回 installing，不重复执行', async () => {
  setupEnv();
  let release;
  const gate = new Promise((r) => { release = r; });
  const exec = async () => { await gate; makeNodeModules(); return { code: 0 }; };
  const p1 = ensureStDeps({}, { stDir, exec, backoffMs: FAST_BACKOFF });
  // 稍等让第一个进入 installing 状态
  await new Promise((r) => setTimeout(r, 50));
  const p2 = ensureStDeps({}, { stDir, exec, backoffMs: FAST_BACKOFF });
  const r2 = await p2;
  assert.equal(r2.status, 'installing');
  release();
  const r1 = await p1;
  assert.equal(r1.status, 'ok');
});

test('依赖已就绪时直接返回 ok，不触发安装', async () => {
  setupEnv();
  makeNodeModules();
  const exec = makeFakeExec([]);
  const result = await ensureStDeps({}, { stDir, exec });
  assert.equal(result.status, 'ok');
  assert.equal(exec.calls.length, 0);
});
