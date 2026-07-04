// 花酿 v0.4.0 — Plugin Entry
// 管理 ST 子进程生命周期 + 数据存储初始化

import { ensureStore, readState, writeState } from './backend/store.js';

export async function onload(ctx = {}) {
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
