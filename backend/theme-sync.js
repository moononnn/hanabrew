// 花酿 · 内嵌酒馆跟随 Hana 主题（后端同步 v2 · 静态文件方案）
// 每 2 秒读 Hana 宿主主题配置（preferences.json 的 appearance.theme），
// 把 { dark, theme } 写进 ST public 目录的静态文件 hana-theme.json。
// 酒馆前端脚本轮询同源 /hana-theme.json 读取该字段，切换 hana-dark class。
//
// v2 为什么放弃 ST settings（power_user.hanaDark）：
// ST 前端保存设置时 payload 会全量写回 power_user（script.js: saveSettings），
// 前端内存快照是页面加载时读的旧值，用户操作触发保存就会把 hanaDark 顶回旧值，
// 后端轮询再补回 → 形成「一会黑一会白」的拉锯。
// 静态文件不经过 ST 的 settings 系统，前端怎么保存都碰不到它，彻底根除抖动。

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// ST public 目录（静态文件落地处）：backend/../sillytavern/public
export const ST_PUBLIC_DIR = join(__dirname, '..', 'sillytavern', 'public');
// 主题状态静态文件（相对 ST 根，前端 fetch /hana-theme.json 同源直达）
export const THEME_FILE_NAME = 'hana-theme.json';
export const THEME_FILE_PATH = join(ST_PUBLIC_DIR, THEME_FILE_NAME);

// Hana 宿主主题配置文件（当前主题 id 存在 appearance.theme）
const HANA_PREFS_PATH = join(homedir(), '.hanako', 'user', 'preferences.json');
// Hana 暗色主题 id（宿主内置主题里仅这两个是暗色）
const HANA_DARK_THEMES = new Set(['midnight', 'midnight-contrast']);

let _timer = null;
let _lastDark = null; // 上次写入文件的暗色状态
let _log = () => {};

/** 读 Hana 宿主当前主题，返回 { dark, theme } */
export function readHanaThemeState() {
  try {
    const raw = readFileSync(HANA_PREFS_PATH, 'utf8');
    const prefs = JSON.parse(raw);
    const theme = prefs?.appearance?.theme || '';
    return { dark: HANA_DARK_THEMES.has(theme), theme };
  } catch {
    return { dark: false, theme: '' };
  }
}

/** 把主题状态写进静态文件 hana-theme.json（原子写：先写临时文件再改名） */
function writeThemeFile(state) {
  try {
    mkdirSync(dirname(THEME_FILE_PATH), { recursive: true });
    const payload = JSON.stringify({ ...state, updatedAt: Date.now() });
    const tmp = THEME_FILE_PATH + '.tmp';
    writeFileSync(tmp, payload, 'utf8');
    // 原子替换
    renameSync(tmp, THEME_FILE_PATH);
    return true;
  } catch (e) {
    _log('warn', `[hanabrew-theme-sync] write theme file failed: ${e.message}`);
    return false;
  }
}

/** 单轮同步：读主题 → 有变化才写文件 */
async function syncOnce() {
  const state = readHanaThemeState();
  if (state.dark === _lastDark) return;
  const ok = writeThemeFile(state);
  if (ok) {
    _lastDark = state.dark;
    _log('info', `[hanabrew-theme-sync] wrote ${THEME_FILE_NAME} dark=${state.dark} theme=${state.theme}`);
  }
}

/**
 * 启动主题同步轮询。
 * @param {object} ctx 插件上下文（log）
 */
export function startThemeSync(ctx = {}) {
  _log = (level, msg) => ctx.log?.[level]?.(msg);
  if (_timer) return;
  _timer = setInterval(() => {
    syncOnce().catch(() => {});
  }, 2000);
  // 启动后立即同步一轮（不等 2 秒），并清掉模块级旧缓存
  _lastDark = null;
  syncOnce().catch(() => {});
  _log('info', '[hanabrew-theme-sync] started (static file mode)');
}

/** 停止主题同步轮询 */
export function stopThemeSync() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  _lastDark = null;
  _log('info', '[hanabrew-theme-sync] stopped');
}
