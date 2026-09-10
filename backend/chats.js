// Backend Chats — Chat history CRUD
// Stores chats as JSONL files (SillyTavern format)

import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { paths, readState, writeState } from "./store.js";
import { cleanTavernText } from "./clean-text.js";
import { applyMvuUpdate, extractJsonPatch } from "./mvu.js";

/**
 * 从角色卡取开场白（first_mes / greeting），清洗掉宏、占位标签后返回。
 */
export function seedOpeningForCharacter(character, options = {}) {
  if (!character) return '';
  const raw = String(
    character.first_mes
    || character.greeting
    || character.charData?.first_mes
    || character.charData?.greeting
    || '',
  ).trim();
  return cleanTavernText(raw, options);
}

function generateId() {
  return `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function chatFilePath(chatId, ctx = {}) {
  return join(paths(ctx).chats, `${chatId}.jsonl`);
}

function readChatFile(chatId, ctx = {}) {
  const filePath = chatFilePath(chatId, ctx);
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    const messages = lines.map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);

    // First line is chat metadata
    const metadata = messages.shift() || {};
    return { id: chatId, ...metadata, messages };
  } catch (e) {
    ctx.log?.warn?.("[hanabrew] Failed to read chat:", chatId, e.message);
    return null;
  }
}

function writeChatFile(chat, ctx = {}) {
  const filePath = chatFilePath(chat.id, ctx);
  try {
    const dir = paths(ctx).chats;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    // First line: metadata (without messages)
    const { messages, ...metadata } = chat;
    const lines = [
      JSON.stringify({ ...metadata, chat_id: chat.id }),
      ...(messages || []).map(m => JSON.stringify(m)),
    ];
    writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
  } catch (e) {
    ctx.log?.error?.("[hanabrew] Failed to write chat:", chat.id, e.message);
  }
}

/**
 * List chats for a character
 */
export async function listChatsForCharacter(characterId, ctx = {}) {
  const chatDir = paths(ctx).chats;
  if (!existsSync(chatDir)) return [];

  const files = readdirSync(chatDir).filter(f => f.endsWith(".jsonl"));
  const chats = [];

  for (const file of files) {
    const chatId = file.replace(".jsonl", "");
    const chat = readChatFile(chatId, ctx);
    if (chat && chat.characterId === characterId) {
      chats.push({
        id: chat.id,
        characterId: chat.characterId,
        characterName: chat.characterName || "",
        title: chat.title || chat.characterName || "",
        messageCount: chat.messages?.length || 0,
        createdAt: chat.createdAt || "",
        updatedAt: chat.updatedAt || "",
        lastMessage: chat.messages?.at(-1)?.content?.slice(0, 100) || "",
      });
    }
  }

  return chats;
}

/**
 * Get a single chat
 */
export async function getChat(chatId, ctx = {}) {
  return readChatFile(chatId, ctx);
}

/**
 * Save (create or update) a chat
 */
export async function saveChat(data, ctx = {}) {
  let chat;

  if (data.id) {
    chat = readChatFile(data.id, ctx);
    if (!chat) {
      // Create new with given ID
      chat = {
        id: data.id,
        characterId: data.characterId || "",
        characterName: data.characterName || "",
        title: data.title || data.characterName || "",
        createdAt: data.createdAt || new Date().toISOString(),
        messages: [],
      };
    }
  } else {
    const id = generateId();
    chat = {
      id,
      characterId: data.characterId || "",
      characterName: data.characterName || "",
      title: data.title || data.characterName || "",
      createdAt: new Date().toISOString(),
      messages: [],
    };
  }

  // Update fields
  if (data.messages) chat.messages = data.messages;
  if (data.title) chat.title = data.title;
  chat.updatedAt = new Date().toISOString();

  writeChatFile(chat, ctx);

  // Update active chat in state
  const state = await readState(ctx);
  await writeState({ ...state, activeChatId: chat.id }, ctx);

  return chat;
}


const chatLocks = new Map();

export async function withCharacterChatLock(characterId, task) {
  const previous = chatLocks.get(characterId) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  chatLocks.set(characterId, current);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (chatLocks.get(characterId) === current) chatLocks.delete(characterId);
  }
}

export function sortChatsByRecent(summaries) {
  return [...summaries].sort((a, b) => {
    const left = Date.parse(a.updatedAt || a.createdAt || '') || 0;
    const right = Date.parse(b.updatedAt || b.createdAt || '') || 0;
    return right - left;
  });
}

export async function latestChatForCharacter(characterId, ctx = {}) {
  const summaries = sortChatsByRecent(await listChatsForCharacter(characterId, ctx));
  return summaries[0] ? getChat(summaries[0].id, ctx) : null;
}

/**
 * 发送消息并获取 AI 回复
 * Agent 工具 tavern-chat 调用此函数
 */
export async function chat(characterId, message, ctx = {}) {
  return withCharacterChatLock(String(characterId), () => chatUnlocked(characterId, message, ctx));
}

async function chatUnlocked(characterId, message, ctx = {}) {
  const { getCharacter } = await import('./characters.js');
  const { callLLM } = await import('./llm.js');
  const { readState } = await import('./store.js');
  const { tavernUserName } = await import('./visitors.js');

  const character = await getCharacter(characterId, ctx);
  if (!character) throw new Error(`角色 ${characterId} 不存在`);
  const userName = tavernUserName(ctx);

  const state = await readState(ctx);

  // 当前角色没有显式活动会话时，续接该角色最近更新的一条；不同角色不会串线。
  let chat = state.activeChatId ? await getChat(state.activeChatId, ctx) : null;
  if (!chat || chat.characterId !== characterId) {
    chat = await latestChatForCharacter(characterId, ctx);
  }
  let isNewChat = false;
  if (!chat) {
    chat = await saveChat({
      id: undefined,
      characterId,
      characterName: character.name,
      title: `与 ${character.name} 的对话`,
    }, ctx);
    isNewChat = true;
  }

  // 新聊天时，把角色开场白作为第一条角色消息写入（显示在角色侧，跟酒馆一样）
  if (isNewChat) {
    const opening = seedOpeningForCharacter(character, { userName });
    if (opening) {
      chat.messages = [...(chat.messages || []), { role: 'assistant', content: opening, timestamp: Date.now() }];
      await saveChat(chat, ctx);
    }
  }

  // 构造消息数组
  const messages = [];

  // 系统提示 = 角色设定
  if (character.prompt) {
    messages.push({ role: 'system', content: character.prompt });
  }

  // 场景描述
  if (character.scenario) {
    messages.push({ role: 'system', content: `当前场景: ${character.scenario}` });
  }

  // 历史消息
  for (const m of (chat.messages || [])) {
    messages.push({ role: m.role || 'user', content: m.content || '' });
  }

  // 用户新消息
  messages.push({ role: 'user', content: message });

  // 保存用户消息
  chat.messages = [...(chat.messages || []), { role: 'user', content: message, timestamp: Date.now() }];
  await saveChat(chat, ctx);

  // 调用 LLM；先执行 MVU 记账，再把隐藏宏清掉，确保卡片和工具共用同一份干净历史。
  const result = await callLLM({ messages, characterName: character.name }, ctx);
  const rawReply = String(result.text || '');
  const patches = extractJsonPatch(rawReply);
  if (patches.length) applyMvuUpdate(characterId, patches, ctx);
  const reply = cleanTavernText(rawReply, { userName });

  // 保存清洗后的回复
  chat.messages = [...chat.messages, { role: 'assistant', content: reply, timestamp: Date.now() }];
  await saveChat(chat, ctx);

  return {
    characterName: character.name,
    message,
    reply,
    usage: result.usage,
    chatId: chat.id,
  };
}

/**
 * 酒馆格式模拟对话：续接 chats/{角色名}/ 下最近更新的酒馆聊天文件，
 * 用酒馆标准格式（name/is_user/send_date/mes/extra）追加用户消息与 LLM 回复。
 * 这样对话会真实出现在酒馆 UI 里（与手动在酒馆发消息效果一致）。
 *
 * 无酒馆聊天时新建「来访续章-时间戳.jsonl」，含角色开场白。
 * 模拟用户消息署名用酒馆配置的 username（persona 名）。
 */
export async function tavernChatAppend(characterId, message, ctx = {}) {
  return withCharacterChatLock(String(characterId), () => tavernChatAppendUnlocked(characterId, message, ctx));
}

async function tavernChatAppendUnlocked(characterId, message, ctx = {}) {
  const { getCharacter } = await import('./characters.js');
  const { callLLM } = await import('./llm.js');
  const { paths: p } = await import('./store.js');
  const { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { cleanTavernText } = await import('./clean-text.js');
  const { tavernUserName } = await import('./visitors.js');

  const character = await getCharacter(characterId, ctx);
  if (!character) throw new Error(`角色 ${characterId} 不存在`);

  const chatsRoot = p(ctx).chats;
  const characterDir = join(chatsRoot, String(character.name || characterId).trim());
  const userName = tavernUserName(ctx);

  // 找最近更新的酒馆聊天文件
  let targetFile = null;
  let lines = [];
  if (existsSync(characterDir)) {
    const files = readdirSync(characterDir)
      .filter((name) => name.toLowerCase().endsWith('.jsonl'))
      .map((name) => ({ name, path: join(characterDir, name), mtimeMs: statSync(join(characterDir, name)).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (files.length) {
      targetFile = files[0].path;
      lines = readFileSync(targetFile, 'utf8').split(/\r?\n/).filter(Boolean);
    }
  }

  // 无现有聊天：新建，带角色开场白
  if (!targetFile) {
    if (!existsSync(characterDir)) mkdirSync(characterDir, { recursive: true });
    const opening = cleanTavernText(String(character.first_mes || character.greeting || character.charData?.first_mes || character.charData?.greeting || '').trim(), { userName });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    targetFile = join(characterDir, `来访续章-${stamp}.jsonl`);
    lines = [
      JSON.stringify({ chat_metadata: {}, user_name: userName, character_name: character.name || '' }),
    ];
    if (opening) {
      lines.push(JSON.stringify({
        name: character.name,
        is_user: false,
        send_date: new Date().toISOString(),
        mes: opening,
        extra: {},
      }));
    }
  }

  // 构造 LLM 上下文：角色设定 + 场景 + 历史（酒馆行转 message）+ 新消息
  const messages = [];
  if (character.prompt) messages.push({ role: 'system', content: character.prompt });
  if (character.scenario) messages.push({ role: 'system', content: `当前场景: ${character.scenario}` });
  for (const line of lines.slice(1)) {
    try {
      const j = JSON.parse(line);
      if (!j || typeof j.mes !== 'string') continue;
      messages.push({ role: j.is_user ? 'user' : 'assistant', content: j.mes });
    } catch { /* 跳过坏行 */ }
  }
  messages.push({ role: 'user', content: message });

  // 调 LLM；酒馆格式聊天也走同一套 MVU 记账和正文清洗。
  const result = await callLLM({ messages, characterName: character.name }, ctx);
  const rawReply = String(result.text || '');
  const patches = extractJsonPatch(rawReply);
  if (patches.length) applyMvuUpdate(characterId, patches, ctx);
  const reply = cleanTavernText(rawReply, { userName });

  // 追加用户消息 + 回复（酒馆格式），写回文件
  const now = new Date().toISOString();
  lines.push(JSON.stringify({ name: userName, is_user: true, send_date: now, mes: message, extra: {} }));
  lines.push(JSON.stringify({ name: character.name, is_user: false, send_date: new Date().toISOString(), mes: reply, extra: {} }));
  writeFileSync(targetFile, lines.join('\n') + '\n', 'utf8');

  return {
    characterName: character.name,
    chatFile: targetFile,
    message,
    reply,
    usage: result.usage,
  };
}

/**
 * Delete a chat
 */
export async function deleteChat(chatId, ctx = {}) {
  const filePath = chatFilePath(chatId, ctx);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
    return { deleted: true, id: chatId };
  }
  return { deleted: false, id: chatId, error: "Chat not found" };
}
