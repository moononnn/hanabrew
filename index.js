// 花酿 v0.4.0 — Plugin Entry
// 管理 ST 子进程生命周期 + 数据存储初始化

import { existsSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { ensureStore, readState, writeState } from './backend/store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 递归复制目录（用于 skill 自动安装） */
function copyDir(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else copyFileSync(s, d);
  }
}

/** 把内置的 hanabrew-card-testing skill 复制到 ~/.hanako/skills/，已存在则跳过 */
function installBundledSkill(ctx) {
  const skillName = 'hanabrew-card-testing';
  const skillSrc = join(__dirname, 'skills', skillName);
  const skillDst = join(homedir(), '.hanako', 'skills', skillName);
  if (!existsSync(skillSrc)) return;
  if (existsSync(skillDst)) {
    ctx.log?.info?.(`[hanabrew] skill "${skillName}" 已存在，跳过安装`);
    return;
  }
  try {
    copyDir(skillSrc, skillDst);
    ctx.log?.info?.(`[hanabrew] skill "${skillName}" 已安装到 ${skillDst}`);
  } catch (e) {
    ctx.log?.warn?.(`[hanabrew] skill 安装失败: ${e.message}`);
  }
}

export async function onload(ctx = {}) {
  installBundledSkill(ctx);
  ctx.log?.info?.('[hanabrew] onload...');
  await ensureStore(ctx);
  const state = await readState(ctx);
  await writeState({ ...state, pluginLoadedAt: new Date().toISOString() }, ctx);
}

export async function onunload(ctx = {}) {
  ctx.log?.info?.('[hanabrew] onunload...');
  const state = await readState(ctx);
  await writeState({ ...state, pluginUnloadedAt: new Date().toISOString() }, ctx);

  // 关闭 ST 子进程
  try {
    const pageEntry = await import('./routes/page-entry.js');
    const proc = pageEntry.getStProcess();
    if (proc) {
      pageEntry.setStProcess(null);
      proc.kill('SIGTERM');
      ctx.log?.info?.('[hanabrew] ST process killed');
      // 给 2 秒优雅退出，然后强制杀
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
      }, 2000);
    }
  } catch (e) {
    ctx.log?.error?.('[hanabrew] onunload cleanup error:', e.message);
  }

  // 清理全局状态（防止禁用→启用时复用僵尸引用）
  if (globalThis.__hanabrew_state) {
    try { globalThis.__hanabrew_state._server?.close(); } catch {}
    globalThis.__hanabrew_state._server = null;
    globalThis.__hanabrew_state._stProcess = null;
  }
}
