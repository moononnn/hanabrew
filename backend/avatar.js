// 花酿 · Hana 助手头像解析
// 有自定义头像时沿用 agents/<id>/avatars；没有时回退到该助手 Yuan 对应的 Hana 内置头像。

import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_YUAN = 'hanako';

const DEFAULT_AVATAR_FILES = Object.freeze({
  hanako: 'Hanako.png',
  butter: 'Butter.png',
  ming: 'Ming.png',
  kong: 'Kong.png',
});

const CUSTOM_AVATAR_EXTENSIONS = Object.freeze(['png', 'jpg', 'jpeg', 'webp']);
const MIME_TYPES = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
});

function isSafeAgentId(agentId) {
  return typeof agentId === 'string' && /^[a-zA-Z0-9_-]+$/.test(agentId);
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function uniquePaths(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const resolved = path.resolve(value);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(resolved);
  }
  return result;
}

/**
 * 把 Hana 的 Yuan 类型收敛到已知的内置头像集合。
 * 未知类型按 Hana 自己的默认行为回到 hanako。
 */
export function normalizeYuan(yuan) {
  const value = String(yuan || '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .toLowerCase();
  return Object.prototype.hasOwnProperty.call(DEFAULT_AVATAR_FILES, value)
    ? value
    : DEFAULT_YUAN;
}

export function defaultAvatarFilename(yuan) {
  return DEFAULT_AVATAR_FILES[normalizeYuan(yuan)];
}

/**
 * 从 config.yaml 的 agent 段读取 Yuan 类型。
 * 只接受缩进字段，避免把其他配置段里的同名字段误当成助手 Yuan。
 */
export function parseAgentYuan(configText) {
  if (typeof configText !== 'string') return DEFAULT_YUAN;
  const match = configText.match(
    /^[ \t]+yuan\s*:\s*["']?([a-zA-Z0-9_-]+)["']?\s*(?:#.*)?$/m,
  );
  return normalizeYuan(match?.[1]);
}

export function readAgentYuan(hanaHome, agentId) {
  if (typeof hanaHome !== 'string' || !hanaHome || !isSafeAgentId(agentId)) {
    return DEFAULT_YUAN;
  }
  try {
    const configPath = path.join(hanaHome, 'agents', agentId, 'config.yaml');
    return parseAgentYuan(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return DEFAULT_YUAN;
  }
}

function runtimeProductRoots() {
  return [
    process.env.HANA_PRODUCT_DIR,
    process.cwd(),
    process.argv[1] ? path.dirname(process.argv[1]) : '',
    process.execPath ? path.dirname(process.execPath) : '',
  ];
}

function productAssetCandidates(productRoots, filename) {
  const candidates = [];
  for (const root of productRoots) {
    candidates.push(
      path.join(root, 'desktop', 'dist-renderer', 'assets', filename),
      path.join(root, 'desktop', 'src', 'assets', filename),
      path.join(root, 'dist-renderer', 'assets', filename),
      path.join(root, 'src', 'assets', filename),
    );
  }
  return candidates;
}

/**
 * 返回头像文件信息；找不到时返回 null。
 * @param {string} hanaHome Hana 数据根目录
 * @param {string} agentId 助手 ID
 * @param {{productDirs?: string|string[], includeRuntimeRoots?: boolean}} options
 */
export function resolveAgentAvatar(hanaHome, agentId, options = {}) {
  if (typeof hanaHome !== 'string' || !hanaHome || !isSafeAgentId(agentId)) {
    return null;
  }

  const customDir = path.join(hanaHome, 'agents', agentId, 'avatars');
  for (const ext of CUSTOM_AVATAR_EXTENSIONS) {
    const filePath = path.join(customDir, `agent.${ext}`);
    if (isFile(filePath)) {
      return {
        path: filePath,
        mimeType: MIME_TYPES[ext],
        source: 'custom',
        yuan: null,
      };
    }
  }

  const yuan = readAgentYuan(hanaHome, agentId);
  const filename = defaultAvatarFilename(yuan);
  const configuredRoots = Array.isArray(options.productDirs)
    ? options.productDirs
    : [options.productDirs];
  const roots = configuredRoots.concat(
    options.includeRuntimeRoots === false ? [] : runtimeProductRoots(),
  );

  for (const filePath of productAssetCandidates(uniquePaths(roots), filename)) {
    if (isFile(filePath)) {
      return {
        path: filePath,
        mimeType: 'image/png',
        source: 'yuan-default',
        yuan,
      };
    }
  }

  return null;
}

export { DEFAULT_AVATAR_FILES };
