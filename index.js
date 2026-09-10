// 花酿 — Plugin Entry
// 管理 ST 子进程生命周期 + 数据存储初始化

import { existsSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { ensureStore, readState, writeState } from './backend/store.js';
import { cleanupDepartedVisitors } from './backend/visitors.js';
import { startThemeSync, stopThemeSync } from './backend/theme-sync.js';
import { stopSillyTavernTheater } from './backend/st-runtime.js';

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

/** 同步内置的 hanabrew-card-testing skill；只覆盖插件自带文件，不删除用户额外文件 */
function installBundledSkill(ctx) {
  const skillName = 'hanabrew-card-testing';
  const skillSrc = join(__dirname, 'skills', skillName);
  const skillDst = join(homedir(), '.hanako', 'skills', skillName);
  if (!existsSync(skillSrc)) return;
  try {
    copyDir(skillSrc, skillDst);
    ctx.log?.info?.(`[hanabrew] skill "${skillName}" 已同步到 ${skillDst}`);
  } catch (e) {
    ctx.log?.warn?.(`[hanabrew] skill 安装失败: ${e.message}`);
  }
}

export async function onload(ctx = {}) {
  installBundledSkill(ctx);
  ctx.log?.info?.('[hanabrew] onload...');
  await ensureStore(ctx);
  await cleanupDepartedVisitors(ctx);
  const state = await readState(ctx);
  await writeState({ ...state, pluginLoadedAt: new Date().toISOString() }, ctx);

  // 内嵌酒馆跟随 Hana 主题：后端轮询 Hana 主题 → 写静态主题文件 → 酒馆脚本读取
  startThemeSync(ctx);
}

export async function onunload(ctx = {}) {
  ctx.log?.info?.('[hanabrew] onunload...');
  const state = await readState(ctx);
  await writeState({ ...state, pluginUnloadedAt: new Date().toISOString() }, ctx);

  // 关闭真实测卡使用的无界面前端，再关闭 ST 子进程
  try {
    await stopSillyTavernTheater(ctx);
  } catch (e) {
    ctx.log?.warn?.('[hanabrew] theater runtime cleanup error:', e.message);
  }

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

  // 停止主题同步轮询
  stopThemeSync();

  // 清理全局状态（防止禁用→启用时复用僵尸引用）
  if (globalThis.__hanabrew_state) {
    try { globalThis.__hanabrew_state._server?.close(); } catch {}
    globalThis.__hanabrew_state._server = null;
    globalThis.__hanabrew_state._stProcess = null;
  }
}

// Hana 当前宿主实例化默认导出的插件类，再无参调用 onload/onunload；
// 保留具名函数供旧式直接导入和单元测试使用。
class HanabrewPlugin {
  async onload() {
    return onload(this.ctx);
  }

  async onunload() {
    return onunload(this.ctx);
  }
}

export default HanabrewPlugin;
