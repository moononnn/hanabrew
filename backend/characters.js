// Backend Characters — ST 原生角色卡 CRUD
// 支持格式：
//   - PNG V2 卡片：tEXt chunk 中 keyword="chara" 嵌入 JSON
//   - JSON 文件：独立的 .json 文件，与 PNG 卡片同级

import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join, extname, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { paths } from "./store.js";
import { embedCharacterCardPng, isPng, readAvatarPng, readEmbeddedCard } from "./png-card.js";

const DEFAULT_CHARACTER_AVATAR_PATH = fileURLToPath(new URL('../assets/hanako-default.png', import.meta.url));
const require = createRequire(import.meta.url);
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * YAML 只在实际导入 YAML 卡片时按需加载。
 * 花酿首次启动要先在 sillytavern/ 安装依赖；若顶层静态 import yaml，干净安装包会在生命周期入口加载前就失败。
 * 优先用插件自身依赖（开发/测试），发布包则回退到 sillytavern/node_modules/yaml。
 */
function parseYaml(raw) {
  let yaml;
  try {
    yaml = require('yaml');
  } catch {
    try {
      yaml = require(join(MODULE_DIR, '..', 'sillytavern', 'node_modules', 'yaml'));
    } catch (error) {
      throw new Error(`YAML 依赖尚未就绪，请先打开花酿内嵌酒馆完成依赖安装：${error.message}`);
    }
  }
  return yaml.parse(raw);
}

/**
 * 从 PNG 文件中提取 V2 角色 JSON
 * ST V2 规范：PNG tEXt chunk 中 keyword="chara"，value 为 JSON 字符串
 */
export function decodeCharaTextValue(value) {
  const candidates = [String(value || '')];
  try { candidates.push(Buffer.from(String(value || ''), 'base64').toString('utf8')); } catch {}
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      return parsed.data || parsed;
    } catch {}
  }
  return null;
}

function extractCharaFromPng(filePath) {
  try {
    const buf = readFileSync(filePath);
    const signature = buf.slice(0, 8).toString('binary');
    if (signature !== '\x89PNG\r\n\x1a\n') return null;

    let offset = 8;
    while (offset + 8 <= buf.length) {
      const length = buf.readUInt32BE(offset);
      const type = buf.slice(offset + 4, offset + 8).toString('ascii');

      if (type === 'IEND') break;

      const chunkData = buf.slice(offset + 8, offset + 8 + length);

      if (type === 'tEXt') {
        // tEXt: null-terminated keyword + value
        const nullPos = chunkData.indexOf(0);
        if (nullPos >= 0) {
          const keyword = chunkData.slice(0, nullPos).toString('latin1');
          const value = chunkData.slice(nullPos + 1).toString('latin1');
          if (keyword === 'chara') return decodeCharaTextValue(value);
        }
      }

      offset += 12 + length; // type(4) + data + crc(4)
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 生成唯一角色 ID
 */
function generateId() {
  return `char-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function safeCharacterId(value) {
  const text = String(value ?? '').trim();
  if (!text) return generateId();
  const safe = text
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/^\.+$/, '_')
    .slice(0, 80);
  return safe || generateId();
}

/**
 * 扫描角色目录，返回角色列表
 * 支持 .png（V2 卡片）和 .json 文件
 */
function scanCharacters(charDir) {
  const results = [];
  let files;
  try {
    files = readdirSync(charDir);
  } catch {
    return [];
  }

  for (const file of files) {
    if (file.endsWith('.png')) {
      // PNG 卡片 - 尝试提取 chara 元数据
      const filePath = join(charDir, file);
      const charName = file.replace(/\.png$/, '').replace(/^default_/, '');
      const charData = extractCharaFromPng(filePath);
      if (charData) {
        results.push({
          id: charData.id || charData.name || charName,
          name: charData.name || charName,
          description: charData.description || '',
          prompt: charData.personality || charData.description || charData.system_prompt || charData.prompt || '',
          greeting: charData.first_mes || charData.greeting || '',
          scenario: charData.scenario || '',
          exampleDialogue: charData.mes_example || charData.exampleDialogue || '',
          tags: charData.tags || [],
          avatarPath: file,
          createdAt: charData.create_date || null,
          charData,
          _fileType: 'png',
          _filePath: filePath,
        });
      } else {
        results.push({
          id: charName,
          name: charName,
          tags: [],
          avatarPath: file,
          createdAt: null,
          _fileType: 'png',
          _filePath: filePath,
        });
      }
    } else if (file.endsWith('.json')) {
      // JSON 文件直接读取
      const filePath = join(charDir, file);
      try {
        const raw = readFileSync(filePath, 'utf-8');
        const charData = JSON.parse(raw);
        const data = charData.data || charData;
        results.push({
          id: data.id || data.name || basename(file, '.json'),
          name: data.name || basename(file, '.json'),
          prompt: data.personality || data.system_prompt || data.prompt || '',
          greeting: data.first_mes || data.greeting || '',
          scenario: data.scenario || '',
          exampleDialogue: data.mes_example || data.exampleDialogue || '',
          tags: data.tags || [],
          avatarPath: data.avatar || '',
          createdAt: data.create_date || null,
          charData: data,
          _fileType: 'json',
          _filePath: filePath,
        });
      } catch { /* skip bad json */ }
    }
  }
  // Hana 侧的兼容扫描允许读取旧 JSON，但实际 SillyTavern 只认 PNG。
  // 同一张卡完成 PNG 迁移后，保留旧 JSON 作为数据备份，同时只对外暴露 PNG，避免角色来访出现重复卡。
  const pngNames = new Set(results.filter((item) => item._fileType === 'png').map((item) => item.name));
  return results.filter((item) => item._fileType !== 'json' || !pngNames.has(item.name));
}

async function writeCharacterPng(filePath, character, sourceAvatarPng = null) {
  const avatarPng = isPng(sourceAvatarPng)
    ? sourceAvatarPng
    : await readAvatarPng(null, DEFAULT_CHARACTER_AVATAR_PATH);
  const card = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: character,
  };
  writeFileSync(filePath, embedCharacterCardPng(avatarPng, card));
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function firstDefined(object, keys, fallback = '') {
  for (const key of keys) {
    if (hasOwn(object, key) && object[key] !== undefined && object[key] !== null) return object[key];
  }
  return fallback;
}

/**
 * 把保存表单或导入卡片整理成角色数据；导入时保留未专门处理的标准字段，
 * 例如 character_book、extensions 和自定义扩展，避免再次保存时把卡片削薄。
 */
function normalizeCharacterData(data = {}, existing = null) {
  const source = {
    ...(existing?.charData && typeof existing.charData === 'object' ? existing.charData : {}),
    ...(data?.cardData && typeof data.cardData === 'object' ? data.cardData : {}),
  };
  const name = firstDefined(data, ['name'], firstDefined(source, ['name'], existing?.name || 'New Character'));
  const description = firstDefined(
    data,
    ['description', 'prompt'],
    firstDefined(source, ['description', 'personality', 'prompt'], existing?.prompt || ''),
  );
  const personality = firstDefined(
    data,
    ['personality', 'prompt'],
    firstDefined(source, ['personality', 'description', 'prompt'], existing?.prompt || ''),
  );
  const scenario = firstDefined(data, ['scenario'], firstDefined(source, ['scenario'], existing?.scenario || ''));
  const firstMessage = firstDefined(
    data,
    ['first_mes', 'greeting'],
    firstDefined(source, ['first_mes', 'greeting'], existing?.greeting || ''),
  );
  const exampleDialogue = firstDefined(
    data,
    ['mes_example', 'exampleDialogue'],
    firstDefined(source, ['mes_example', 'exampleDialogue'], existing?.exampleDialogue || ''),
  );
  const creatorNotes = firstDefined(
    data,
    ['creator_notes', 'creatorNotes'],
    firstDefined(source, ['creator_notes', 'creatorNotes'], ''),
  );
  const systemPrompt = firstDefined(data, ['system_prompt', 'systemPrompt'], firstDefined(source, ['system_prompt'], ''));
  const postHistoryInstructions = firstDefined(
    data,
    ['post_history_instructions', 'postHistoryInstructions'],
    firstDefined(source, ['post_history_instructions'], ''),
  );
  const tags = firstDefined(data, ['tags'], firstDefined(source, ['tags'], []));
  const extensions = firstDefined(data, ['extensions'], firstDefined(source, ['extensions'], {}));
  const characterBook = firstDefined(data, ['character_book', 'characterBook'], firstDefined(source, ['character_book'], null));

  return {
    ...source,
    name: String(name || 'New Character'),
    description: String(description || ''),
    personality: String(personality || ''),
    scenario: String(scenario || ''),
    first_mes: String(firstMessage || ''),
    mes_example: String(exampleDialogue || ''),
    creator_notes: String(creatorNotes || ''),
    system_prompt: String(systemPrompt || ''),
    post_history_instructions: String(postHistoryInstructions || ''),
    tags: Array.isArray(tags) ? tags : [],
    creator: String(firstDefined(data, ['creator'], firstDefined(source, ['creator'], '')) || ''),
    character_version: String(firstDefined(data, ['character_version', 'characterVersion'], firstDefined(source, ['character_version'], '1.0')) || '1.0'),
    extensions: extensions && typeof extensions === 'object' ? extensions : {},
    character_book: characterBook && typeof characterBook === 'object' ? characterBook : null,
    create_date: firstDefined(data, ['create_date'], firstDefined(source, ['create_date'], existing?.createdAt || new Date().toISOString())),
    id: safeCharacterId(firstDefined(data, ['id'], firstDefined(source, ['id'], existing?.id || ''))),
  };
}

/**
 * List all characters
 */
export async function listCharacters(ctx = {}, { shallow = false } = {}) {
  const charDir = paths(ctx).characters;
  const chars = scanCharacters(charDir);

  if (shallow) {
    return chars.map(c => ({
      id: c.id,
      name: c.name,
      avatarPath: c.avatarPath,
      tags: c.tags,
      createdAt: c.createdAt,
    }));
  }

  return chars;
}

/**
 * Get a single character by ID (name or custom id)
 */
export async function getCharacter(charId, ctx = {}) {
  const charDir = paths(ctx).characters;
  const chars = scanCharacters(charDir);
  // 按 id 或 name 匹配
  return chars.find(c => c.id === charId || c.name === charId) || null;
}

/**
 * Create a new character（保存为 SillyTavern 可识别的 PNG 角色卡）
 */
export async function createCharacter(data = {}, ctx = {}, options = {}) {
  const charDir = paths(ctx).characters;
  mkdirSync(charDir, { recursive: true });
  const character = normalizeCharacterData(data);
  const filePath = join(charDir, `${character.id}.png`);
  await writeCharacterPng(filePath, character, options.avatarPng);

  return { ...character, fileName: `${character.id}.png` };
}

/**
 * Import a character from JSON, YAML, or PNG.
 * PNG 导入保留原头像；JSON/YAML 导入保留标准 data 字段和自定义 extensions。
 */
export async function importCharacter(input = {}, ctx = {}) {
  let parsed;
  let avatarPng = null;

  if (input.text) {
    const raw = String(input.text);
    try {
      parsed = JSON.parse(raw);
    } catch {
      try { parsed = parseYaml(raw); } catch (error) { return { error: `Parse error: ${error.message}` }; }
    }
  } else if (input.filePath) {
    if (!existsSync(input.filePath)) return { error: `File not found: ${input.filePath}` };
    let buffer;
    try {
      buffer = readFileSync(input.filePath);
    } catch (error) {
      return { error: `Read error: ${error.message}` };
    }
    if (isPng(buffer)) {
      const card = readEmbeddedCard(buffer);
      if (!card || typeof card !== 'object') return { error: 'PNG 中没有可识别的角色卡数据。' };
      parsed = card;
      avatarPng = buffer;
    } else {
      const raw = buffer.toString('utf8');
      try {
        parsed = JSON.parse(raw);
      } catch {
        try { parsed = parseYaml(raw); } catch (error) { return { error: `Parse error: ${error.message}` }; }
      }
    }
  } else {
    return { error: 'Must provide text or filePath' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: '角色卡内容必须是对象。' };
  }
  const data = parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed;
  const charDir = paths(ctx).characters;
  const requestedId = input.id || data.id;
  const safeRequestedId = requestedId ? safeCharacterId(requestedId) : '';
  const requestedPath = safeRequestedId ? join(charDir, `${safeRequestedId}.png`) : '';
  // 导入同一目录里的 PNG 时不能原地覆盖来源卡；外部卡若没有冲突则保留其 id。
  const id = requestedPath && !existsSync(requestedPath) ? safeRequestedId : generateId();
  return createCharacter({
    cardData: data,
    id,
    name: data.name || input.fallbackName || 'Imported Character',
  }, ctx, { avatarPng });
}

/**
 * Update an existing character
 */
export async function updateCharacter(data, ctx = {}) {
  const existing = await getCharacter(data.id || data.name, ctx);
  if (!existing) return null;

  // 更新仍写回 PNG；若目标原来只有 JSON，则新建同 ID 的 PNG，旧 JSON 保留作兼容备份。
  const charDir = paths(ctx).characters;
  mkdirSync(charDir, { recursive: true });
  const updated = normalizeCharacterData({ ...data, id: existing.id }, existing);

  const filePath = existing._fileType === 'png' && existing._filePath
    ? existing._filePath
    : join(charDir, `${existing.id}.png`);
  const avatarPath = existing._fileType === 'png' ? filePath : null;
  const avatarPng = await readAvatarPng(avatarPath, DEFAULT_CHARACTER_AVATAR_PATH);
  writeFileSync(filePath, embedCharacterCardPng(avatarPng, {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: updated,
  }));
  return { ...updated, fileName: basename(filePath) };
}

/**
 * Delete a character (删除 .png 和 .json 文件)
 */
export async function deleteCharacter(charId, ctx = {}) {
  const charDir = paths(ctx).characters;
  const existing = await getCharacter(charId, ctx);
  if (!existing) return { deleted: false, id: charId, error: 'Character not found' };

  // 删除对应 .json 文件
  const jsonPath = join(charDir, `${existing.id}.json`);
  if (existsSync(jsonPath)) unlinkSync(jsonPath);

  // 删除 .png 文件
  if (existing._filePath && existsSync(existing._filePath)) {
    unlinkSync(existing._filePath);
  }

  // 删除同名目录（角色头像等）
  const charDirPath = join(charDir, existing.name);
  try {
    const { rmSync } = await import('node:fs');
    if (existsSync(charDirPath)) rmSync(charDirPath, { recursive: true, force: true });
  } catch {}

  return { deleted: true, id: existing.id };
}
