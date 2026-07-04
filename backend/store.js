// Backend Store — Data persistence layer
// 数据指向 ST 原生 data 目录，agent 工具直接操作 ST 数据
// 角色卡：st-data/default-user/characters/（PNG V2 卡片 + JSON 文件）
// 聊天：st-data/default-user/chats/（JSONL 格式）
// 设置：st-data/default-user/settings.json
// secrets：st-data/default-user/secrets.json
// 世界书：st-data/default-user/worlds/（JSON 格式）

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

const STORE_VERSION = 2;
const DEFAULT_STATE = {
  version: STORE_VERSION,
  activeCharacterId: null,
  activeChatId: null,
  activeRoomId: null,
  currentSession: null,
  pluginLoadedAt: null,
  pluginUnloadedAt: null,
};

/**
 * 获取 ST 数据目录路径
 * 花酿使用固定路径 %APPDATA%\hanabrew\st-data\default-user\
 */
export function stDataRoot(ctx = {}) {
  const root = process.env.APPDATA
    ? join(process.env.APPDATA, "hanabrew", "st-data")
    : join(process.cwd(), "data", "hanabrew", "st-data");
  // ST 默认用户为 default-user
  return join(root, "default-user");
}

/**
 * Get the plugin's data directory from the context
 * @deprecated 改用 stDataRoot() + stPaths()
 */
export function paths(ctx = {}) {
  const root = process.env.APPDATA
    ? join(process.env.APPDATA, "hanabrew")
    : join(process.cwd(), "data", "hanabrew");
  const dataRoot = stDataRoot(ctx);

  return {
    root,
    // assets 保留在老路径（花酿自己的状态面板用）
    assets: join(root, "assets"),
    // characters → ST data 目录
    characters: join(dataRoot, "characters"),
    // chats → ST data 目录
    chats: join(dataRoot, "chats"),
    rooms: join(root, "rooms"),
    exports: join(root, "exports"),
    // 插件状态文件保留在老路径
    stateFile: join(root, "state.json"),
    // settings → ST 原生 settings.json
    settingsFile: join(dataRoot, "settings.json"),
    // secrets → ST 原生 secrets.json
    secretsFile: join(dataRoot, "secrets.json"),
  };
}

/**
 * Ensure all required directories exist
 */
export async function ensureStore(ctx = {}) {
  const p = paths(ctx);
  const dirs = [
    p.root, p.assets, p.characters, p.chats, p.rooms, p.exports,
    dirname(p.settingsFile),
  ];

  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

/**
 * Read plugin state
 */
export async function readState(ctx = {}) {
  const stateFile = paths(ctx).stateFile;
  try {
    if (existsSync(stateFile)) {
      const raw = readFileSync(stateFile, "utf-8");
      return JSON.parse(raw);
    }
  } catch (e) {
    ctx.log?.warn?.("[hanabrew] Failed to read state:", e.message);
  }
  return { ...DEFAULT_STATE };
}

/**
 * Write plugin state
 */
export async function writeState(state, ctx = {}) {
  const stateFile = paths(ctx).stateFile;
  try {
    writeFileSync(stateFile, JSON.stringify({ ...state, version: STORE_VERSION }, null, 2), "utf-8");
  } catch (e) {
    ctx.log?.error?.("[hanabrew] Failed to write state:", e.message);
  }
}

/**
 * Read settings from ST 原生 settings.json
 */
export async function readSettings(ctx = {}) {
  const settingsFile = paths(ctx).settingsFile;
  try {
    if (existsSync(settingsFile)) {
      const raw = readFileSync(settingsFile, "utf-8");
      return JSON.parse(raw);
    }
  } catch (e) {
    ctx.log?.warn?.("[hanabrew] Failed to read settings:", e.message);
  }
  return {};
}

/**
 * Write settings to ST 原生 settings.json
 */
export async function writeSettings(settings, ctx = {}) {
  const settingsFile = paths(ctx).settingsFile;
  try {
    const dir = dirname(settingsFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(settingsFile, JSON.stringify(settings, null, 2), "utf-8");
  } catch (e) {
    ctx.log?.error?.("[hanabrew] Failed to write settings:", e.message);
  }
}

/**
 * Read secrets from ST 原生 secrets.json
 * 格式: { api_key_deepseek: "sk-xxx", ... }
 * 或更复杂的 { api_key_deepseek: [{ id, value, label, active }] }
 */
export async function readSecrets(ctx = {}) {
  const secretsFile = paths(ctx).secretsFile;
  try {
    if (existsSync(secretsFile)) {
      const raw = readFileSync(secretsFile, "utf-8");
      return JSON.parse(raw);
    }
  } catch (e) {
    ctx.log?.warn?.("[hanabrew] Failed to read secrets:", e.message);
  }
  return {};
}

/**
 * Get active API key value from secrets by secret key name
 * @param {string} secretKey - e.g. "api_key_deepseek"
 */
export async function getSecretKey(secretKey, ctx = {}) {
  const secrets = await readSecrets(ctx);
  const entry = secrets[secretKey];
  if (Array.isArray(entry)) {
    const active = entry.find(x => x.active);
    return active ? active.value : null;
  }
  if (typeof entry === 'string') return entry;
  return null;
}
