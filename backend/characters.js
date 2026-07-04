// Backend Characters — ST 原生角色卡 CRUD
// 支持格式：
//   - PNG V2 卡片：tEXt chunk 中 keyword="chara" 嵌入 JSON
//   - JSON 文件：独立的 .json 文件，与 PNG 卡片同级

import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { paths } from "./store.js";

/**
 * 从 PNG 文件中提取 V2 角色 JSON
 * ST V2 规范：PNG tEXt chunk 中 keyword="chara"，value 为 JSON 字符串
 */
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
          if (keyword === 'chara') {
            try {
              const charData = JSON.parse(value);
              return charData.data || charData;
            } catch {
              return null;
            }
          }
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
          id: charData.name || charName,
          name: charData.name || charName,
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
  return results;
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
 * Create a new character (保存为 JSON 文件)
 */
export async function createCharacter(data, ctx = {}) {
  const charDir = paths(ctx).characters;
  const id = data.id || generateId();
  const now = new Date().toISOString();

  const character = {
    name: data.name || 'New Character',
    description: data.prompt || '',
    personality: data.prompt || '',
    scenario: data.scenario || '',
    first_mes: data.greeting || '',
    mes_example: data.exampleDialogue || '',
    creator_notes: data.creatorNotes || '',
    system_prompt: '',
    post_history_instructions: '',
    tags: Array.isArray(data.tags) ? data.tags : [],
    creator: '',
    character_version: '1.0',
    extensions: {},
    create_date: now,
    id,
  };

  const filePath = join(charDir, `${id}.json`);
  writeFileSync(filePath, JSON.stringify({ data: character }, null, 2), 'utf-8');

  return { ...character, id };
}

/**
 * Import a character from JSON text
 */
export async function importCharacter(input, ctx = {}) {
  let raw;
  if (input.text) {
    raw = input.text;
  } else if (input.filePath) {
    if (!existsSync(input.filePath)) {
      return { error: `File not found: ${input.filePath}` };
    }
    raw = readFileSync(input.filePath, 'utf-8');
  } else {
    return { error: 'Must provide text or filePath' };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { error: `Parse error: ${e.message}` };
  }

  const data = parsed.data || parsed;
  const name = data.name || input.fallbackName || 'Imported Character';

  return await createCharacter({
    name,
    prompt: data.description || data.personality || data.system_prompt || data.prompt || '',
    greeting: data.first_mes || data.greeting || '',
    scenario: data.scenario || '',
    exampleDialogue: data.mes_example || data.exampleDialogue || '',
    creatorNotes: data.creator_notes || data.creatorNotes || '',
    tags: data.tags || [],
  }, ctx);
}

/**
 * Update an existing character
 */
export async function updateCharacter(data, ctx = {}) {
  const existing = await getCharacter(data.id || data.name, ctx);
  if (!existing) return null;

  // 覆盖写入 JSON 文件（不修改原 PNG）
  const charDir = paths(ctx).characters;
  const updated = {
    name: data.name || existing.name,
    description: data.prompt || existing.prompt || '',
    personality: data.prompt || existing.prompt || '',
    scenario: data.scenario || existing.scenario || '',
    first_mes: data.greeting || existing.greeting || '',
    mes_example: data.exampleDialogue || existing.exampleDialogue || '',
    creator_notes: data.creatorNotes || existing.creatorNotes || '',
    system_prompt: '',
    post_history_instructions: '',
    tags: Array.isArray(data.tags) ? data.tags : existing.tags || [],
    creator: '',
    character_version: '1.1',
    extensions: {},
    create_date: existing.createdAt || new Date().toISOString(),
    id: existing.id,
  };

  const filePath = join(charDir, `${existing.id}.json`);
  writeFileSync(filePath, JSON.stringify({ data: updated }, null, 2), 'utf-8');
  return updated;
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
