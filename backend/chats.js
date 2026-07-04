// Backend Chats — Chat history CRUD
// Stores chats as JSONL files (SillyTavern format)

import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { paths, readState, writeState } from "./store.js";

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


/**
 * 发送消息并获取 AI 回复
 * Agent 工具 tavern-chat 调用此函数
 */
export async function chat(characterId, message, ctx = {}) {
  const { getCharacter } = await import('./characters.js');
  const { callLLM } = await import('./llm.js');
  const { readState } = await import('./store.js');

  const character = await getCharacter(characterId, ctx);
  if (!character) throw new Error(`角色 ${characterId} 不存在`);

  const state = await readState(ctx);
  const chatId = state.activeChatId || `chat-${Date.now()}`;

  // 加载或创建聊天记录
  let chat = await getChat(chatId, ctx);
  if (!chat) {
    chat = await saveChat({
      id: chatId,
      characterId,
      characterName: character.name,
      title: `与 ${character.name} 的对话`,
    }, ctx);
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

  // 调用 LLM
  const result = await callLLM({ messages, characterName: character.name }, ctx);

  // 保存 AI 回复
  chat.messages = [...chat.messages, { role: 'assistant', content: result.text, timestamp: Date.now() }];
  await saveChat(chat, ctx);

  return {
    characterName: character.name,
    message,
    reply: result.text,
    usage: result.usage,
    chatId: chat.id,
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
