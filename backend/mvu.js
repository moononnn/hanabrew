// 花酿 MVU 变量引擎：让带 MVU（<UpdateVariable>）的角色卡在 Hana 里真正"活"起来。
//
// 原理：酒馆里 MVU 由配套脚本/正则解析执行（变量更新 + 宏隐藏）。Hana 没有这套，
// 花酿自己当那个脚本：
//   1. 从模型回复里提取 <UpdateVariable><Analysis>…<JSONPatch>…</UpdateVariable> 宏块
//   2. 按 RFC 6902 JSON Patch 执行变量更新（add / replace / remove）
//   3. 按角色存一份"变量账本"（mvu-state.json），数值只进后台，不进前端
//   4. 展示层把宏剥掉，用户看到的是干净对话；变量状态角色自己知道
//
// 宽容原则：模型输出可能不标准（宏没闭合、JSON 带尾逗号/注释），解析失败就跳过，
// 绝不因为宏解析问题让聊天炸掉。

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { paths } from './store.js';

// ---------- JSON Pointer（RFC 6901）---------- //

export function parseJsonPointer(pointer) {
  if (!pointer || pointer === '') return [];
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) {
    throw new Error(`invalid JSON pointer: ${String(pointer)}`);
  }
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
}

export function pointerGet(target, pointer) {
  const segments = parseJsonPointer(pointer);
  let node = target;
  for (const segment of segments) {
    if (node == null) return undefined;
    node = Array.isArray(node) ? node[Number(segment)] : node[segment];
  }
  return node;
}

/** 深拷贝（JSON 安全，MVU 变量都是纯 JSON 数据）。 */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * 执行 JSON Patch（RFC 6902 的 add/replace/remove 子集，MVU 只用到这三个）。
 * 宽容处理：add 到不存在的路径自动补中间对象；数组 index 越界时追加。
 */
export function applyJsonPatch(target, patches) {
  const result = clone(target ?? {});
  for (const patch of Array.isArray(patches) ? patches : []) {
    if (!patch || typeof patch !== 'object') continue;
    const op = String(patch.op || '').toLowerCase();
    const pointer = String(patch.path || '');
    const value = patch.value;
    if (!pointer) continue;
    const segments = parseJsonPointer(pointer);
    if (segments.length === 0) {
      if (op === 'replace' || op === 'add') return clone(value);
      continue;
    }
    const last = segments[segments.length - 1];
    const parentPointer = '/' + segments.slice(0, -1).join('/');
    let parent = pointerGet(result, parentPointer);
    if (parent == null && (op === 'add' || op === 'replace')) {
      // 自动补中间对象（宽容：add 和 replace 都补，MVU 变量第一次出现时也是这种场景）
      parent = result;
      for (const segment of segments.slice(0, -1)) {
        if (parent[segment] == null) parent[segment] = {};
        parent = parent[segment];
      }
    }
    if (parent == null) continue;

    if (Array.isArray(parent)) {
      const index = last === '-' ? parent.length : Number(last);
      if (op === 'add') {
        parent.splice(Number.isFinite(index) ? Math.min(index, parent.length) : parent.length, 0, clone(value));
      } else if (op === 'replace') {
        if (Number.isFinite(index) && index >= 0 && index < parent.length) parent[index] = clone(value);
        else if (Number.isFinite(index) && index === parent.length) parent.push(clone(value));
      } else if (op === 'remove') {
        if (Number.isFinite(index) && index >= 0 && index < parent.length) parent.splice(index, 1);
      }
    } else if (typeof parent === 'object') {
      if (op === 'add' || op === 'replace') parent[last] = clone(value);
      else if (op === 'remove') delete parent[last];
    }
  }
  return result;
}

// ---------- 从模型回复提取宏块 ---------- //

/** 宽容提取 <UpdateVariable> 块里的 JSONPatch 数组；解析失败返回 []。 */
export function extractJsonPatch(text) {
  const source = String(text == null ? '' : text);
  if (!source) return [];

  const block = source.match(/<UpdateVariable>([\s\S]*?)<\/UpdateVariable>/i)?.[1]
    || source.match(/<JSONPatch>([\s\S]*?)<\/JSONPatch>/i)?.[1];
  if (!block) return [];

  const patchMatch = block.match(/<JSONPatch>\s*([\s\S]*?)\s*<\/JSONPatch>/i) || block.match(/^(\[[\s\S]*\])$/);
  if (!patchMatch) return [];

  const candidates = [patchMatch[1]];
  // 模型可能输出尾逗号 / 注释 / markdown 代码块包裹，逐级宽容
  const cleaned = patchMatch[1]
    .replace(/```json\s*/gi, '')
    .replace(/```/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/,(\s*[}\]])/g, '$1');
  if (cleaned !== patchMatch[1]) candidates.push(cleaned);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && Array.isArray(parsed.patches)) return parsed.patches;
    } catch { /* 换下一个候选 */ }
  }
  return [];
}

// ---------- 变量账本 ---------- //

function mvuStateFile(ctx = {}) {
  return join(paths(ctx).root, 'mvu-state.json');
}

function readMvuFile(ctx = {}) {
  const file = mvuStateFile(ctx);
  try {
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) || {};
  } catch (error) {
    ctx.log?.warn?.(`[hanabrew] mvu-state 读取失败，按空账本处理: ${error.message}`);
  }
  return {};
}

function writeMvuFile(data, ctx = {}) {
  const file = mvuStateFile(ctx);
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    ctx.log?.warn?.(`[hanabrew] mvu-state 写入失败: ${error.message}`);
  }
}

/** 读取某角色的变量账本（无则返回 null，由调用方决定是否给初始值）。 */
export function readMvuState(characterId, ctx = {}) {
  if (!characterId) return null;
  const entry = readMvuFile(ctx)[String(characterId)];
  return entry && typeof entry.vars === 'object' ? entry.vars : null;
}

/**
 * 应用一次 MVU 更新并记账。
 * @returns {{ before, after, applied: number, summary: string|null }}
 */
export function applyMvuUpdate(characterId, patches, ctx = {}) {
  if (!characterId) return { before: null, after: null, applied: 0, summary: null };
  const all = readMvuFile(ctx);
  const key = String(characterId);
  const before = (all[key] && all[key].vars) || {};
  const after = applyJsonPatch(before, patches);
  const applied = Array.isArray(patches) ? patches.filter((p) => p && p.path).length : 0;
  all[key] = {
    vars: after,
    updatedAt: new Date().toISOString(),
    lastApplied: applied,
  };
  writeMvuFile(all, ctx);
  return { before, after, applied, summary: buildMvuSummary(before, after) };
}

/** 把变量对象格式化成注入模型的文本，支持嵌套路径。 */
export function formatMvuStateText(vars) {
  if (!vars || typeof vars !== 'object') return '';
  const lines = [];
  const walk = (node, prefix) => {
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      for (const [key, value] of Object.entries(node)) {
        if (value && typeof value === 'object') walk(value, prefix ? `${prefix}.${key}` : key);
        else lines.push(`${prefix ? `${prefix}.${key}` : key}: ${value}`);
      }
    }
  };
  walk(vars, '');
  return lines.join('\n');
}

/** 从账本里取某角色的变量值，格式化成注入人格的文本（数值会进模型上下文，但不会显示给用户）。 */
export function mvuStateText(characterId, ctx = {}) {
  return formatMvuStateText(readMvuState(characterId, ctx));
}

// ---------- 模糊描述（数值不展示，只给程度词） ---------- //

const RELATION_KEYS = ['好感度', '信任度', '亲密度', '好感', '信任'];

/**
 * 对比更新前后的关系类变量，生成一句模糊描述（不含任何数字）。
 * 用于可选的小尾巴；默认不展示，由调用方决定要不要用。
 */
export function buildMvuSummary(before, after) {
  if (!before || !after) return null;
  const deltas = [];
  const walk = (prev, next, prefix = '') => {
    if (!next || typeof next !== 'object') return;
    for (const [key, value] of Object.entries(next)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === 'object') {
        walk(prev?.[key], value, fullKey);
      } else if (RELATION_KEYS.some((k) => fullKey.includes(k))) {
        const oldValue = prev?.[key];
        const isNew = typeof oldValue !== 'number' && typeof value === 'number';
        if (isNew || (typeof oldValue === 'number' && typeof value === 'number' && oldValue !== value)) {
          // 首次出现（旧值缺失）也算一次正向变化；否则按差值符号计
          deltas.push({ key: fullKey, delta: isNew ? 1 : value - oldValue });
        }
      }
    }
  };
  walk(before, after);
  if (!deltas.length) return null;
  const total = deltas.reduce((sum, item) => sum + Math.sign(item.delta), 0);
  if (total > 0) return '（你们的关系似乎更亲近了一些。）';
  if (total < 0) return '（你们的关系似乎有些疏远。）';
  return null;
}
