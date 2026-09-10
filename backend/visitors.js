// 花酿角色来访：把酒馆角色与近期聊天做成独立的 Hana 临时 Agent/session。

import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { getCharacter, listCharacters } from './characters.js';
import { latestChatForCharacter } from './chats.js';
import { paths, readState, writeState } from './store.js';
import { cleanMessages, cleanTavernText, cleanTavernTextKeepMvu } from './clean-text.js';
import { mvuStateText } from './mvu.js';

const PLUGIN_ID = 'hanabrew';
const AGENT_PREFIX = 'hanabrew-visitor-';
const MAX_HISTORY_MESSAGES = 16;
const MAX_TRANSCRIPT_CHARS = 12000;
const MAX_CHAT_TAIL_BYTES = 256 * 1024;
let visitorLock = Promise.resolve();

function withVisitorLock(task) {
  const run = visitorLock.then(task, task);
  visitorLock = run.catch(() => {});
  return run;
}

function requestBus(ctx, type, payload, options) {
  if (!ctx?.bus || typeof ctx.bus.request !== 'function') {
    throw new Error('plugin bus request unavailable');
  }
  return ctx.bus.request(type, payload, options);
}

function hanaHome() {
  return process.env.HANA_HOME || join(homedir(), '.hanako');
}

function agentDir(agentId) {
  return join(hanaHome(), 'agents', agentId);
}

function cleanText(value, max = 8000) {
  return String(value || '').replace(/\r\n/g, '\n').trim().slice(0, max);
}

function characterData(character) {
  return character?.charData && typeof character.charData === 'object'
    ? character.charData
    : character || {};
}

function characterBookText(book) {
  const entries = Array.isArray(book?.entries) ? book.entries : [];
  const chunks = [];
  let used = 0;
  for (const entry of entries) {
    if (entry?.enabled === false) continue;
    const content = cleanText(entry?.content || '', 3000);
    if (!content) continue;
    const keys = Array.isArray(entry?.keys) ? entry.keys.filter(Boolean).slice(0, 6).join('、') : '';
    const chunk = `${keys ? `【${keys}】\n` : ''}${content}`;
    if (used + chunk.length > 10000) break;
    chunks.push(chunk);
    used += chunk.length;
  }
  return chunks.join('\n\n');
}

export function characterSnapshot(character) {
  const data = characterData(character);
  // 角色设定保留 MVU 规则块（变量协议），回复/历史用普通清洗
  const clean = (value, max) => cleanTavernTextKeepMvu(cleanText(value, max));
  return {
    id: String(character?.id || data.id || data.name || ''),
    name: cleanText(character?.name || data.name || '未命名角色', 120),
    description: clean(data.description || character?.prompt || '', 6000),
    personality: clean(data.personality || character?.prompt || '', 6000),
    scenario: clean(data.scenario || character?.scenario || '', 4000),
    firstMessage: clean(data.first_mes || character?.greeting || '', 4000),
    exampleDialogue: clean(data.mes_example || character?.exampleDialogue || '', 6000),
    systemPrompt: clean(data.system_prompt || '', 6000),
    postHistoryInstructions: clean(data.post_history_instructions || '', 4000),
    characterBook: clean(characterBookText(data.character_book), 10000),
    tags: Array.isArray(data.tags || character?.tags) ? (data.tags || character.tags).slice(0, 8) : [],
    // 角色卡 PNG 的头像文件名（如 abc.png），方便来访页/临时身份用
    avatarPath: String(character?.avatarPath || data.avatar || ''),
  };
}

function readFileTail(filePath, maxBytes = MAX_CHAT_TAIL_BYTES) {
  const size = statSync(filePath).size;
  const start = Math.max(0, size - maxBytes);
  const length = size - start;
  const buffer = Buffer.alloc(length);
  const fd = openSync(filePath, 'r');
  try {
    readSync(fd, buffer, 0, length, start);
  } finally {
    closeSync(fd);
  }
  let text = buffer.toString('utf8');
  if (start > 0) text = text.slice(Math.max(0, text.indexOf('\n') + 1));
  return text;
}

function normalizeChatLine(raw) {
  if (!raw || typeof raw !== 'object' || raw.chat_metadata) return null;
  const role = raw.role === 'assistant' || raw.role === 'model' || raw.is_user === false
    ? 'assistant'
    : raw.role === 'user' || raw.is_user === true
      ? 'user'
      : null;
  const content = cleanText(raw.content ?? raw.mes ?? raw.text ?? '', 3000);
  return role && content ? { role, content } : null;
}

function nativeChatDirectory(characterName, ctx = {}) {
  const root = paths(ctx).chats;
  if (!existsSync(root)) return null;
  const target = String(characterName || '').trim();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name === target) return join(root, entry.name);
  }
  return null;
}

export function readNativeChatSnapshot(characterName, ctx = {}) {
  const directory = nativeChatDirectory(characterName, ctx);
  if (!directory) return null;
  const files = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl'))
    .map((entry) => {
      const filePath = join(directory, entry.name);
      return { filePath, name: entry.name, mtimeMs: statSync(filePath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const latest = files[0];
  if (!latest) return null;
  const messages = readFileTail(latest.filePath)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try { return normalizeChatLine(JSON.parse(line)); } catch { return null; }
    })
    .filter(Boolean)
    .slice(-MAX_HISTORY_MESSAGES)
    .map((message) => ({ ...message, content: cleanTavernText(message.content, { userName: tavernUserName(ctx) }) }));
  return { id: latest.name.replace(/\.jsonl$/i, ''), source: 'sillytavern', messages };
}

/**
 * 生成贴合剧情的来访会话标题。
 * 优先从角色卡开场白/最近剧情里提炼一个场景短语，拼成「与 X · 场景」；
 * 没有可用剧情就回退「与 X 的来访」。不依赖 LLM，纯规则，失败不阻塞邀请。
 */
export function visitorTitle(character, history = null) {
  const name = cleanText(character?.name || '角色', 40);
  const candidates = [];
  const opening = cleanText(character?.firstMessage || '', 2000);
  if (opening) candidates.push(opening);
  const messages = Array.isArray(history?.messages) ? history.messages : [];
  for (const message of messages.slice(-3)) {
    const text = cleanText(message?.content || '', 2000);
    if (text) candidates.push(text);
  }
  // 取第一条候选里第一个句末标点（。！？.!?）之前的整句作为场景短语；
  // 长度要求 4~24 字，太短没信息量、太长不适合做标题，都不采用。
  let scene = null;
  for (const raw of candidates) {
    const flat = raw.replace(/\n+/g, ' ').trim();
    if (flat.length < 4) continue;
    const firstSentence = flat.split(/[。！？.!?]/u)[0].trim();
    if (firstSentence.length < 4 || firstSentence.length > 24) continue;
    scene = firstSentence;
    break;
  }
  return scene ? `与 ${name} · ${scene}` : `与 ${name} 的来访`;
}

/**
 * 尝试把角色卡头像带到临时 Agent。
 * 宿主（0.737.2）只从 {agentDir}/avatars/agent.{png,jpg,jpeg,webp,gif} 读头像：
 *   - GET /api/agents/:id/avatar 直接读盘；
 *   - 列表 hasAvatar 由 _scanAgentList → B3t(avatarsDir) 扫描，吃缓存。
 * 因此：
 * 1) 把角色卡 PNG 复制到 {agentDir}/avatars/agent.png（正确路径）；
 * 2) 清掉旧的错误路径 {agentDir}/agent.png（v1.0.16 复制错了位置）；
 * 3) 用 agent:update 传一个无害 config 字段触发宿主 updateConfig →
 *    invalidateAgentListCache()，让列表 hasAvatar 立即刷新。
 * 失败只记录日志，不影响邀请主流程。
 */
async function tryApplyAgentAvatar(snapshot, resolvedAgentId, ctx) {
  const avatarName = String(snapshot?.avatarPath || '').trim();
  if (!avatarName || basename(avatarName) !== avatarName) return;
  let copied = false;
  try {
    const charactersRoot = paths(ctx).characters;
    const source = join(charactersRoot, avatarName);
    if (existsSync(source)) {
      const avatarsDir = join(agentDir(resolvedAgentId), 'avatars');
      mkdirSync(avatarsDir, { recursive: true });
      const destination = join(avatarsDir, 'agent.png');
      copyFileSync(source, destination);
      copied = true;
      // 清掉 v1.0.16 复制到错误路径的旧文件（宿主不读它）
      try { unlinkSync(join(agentDir(resolvedAgentId), 'agent.png')); } catch {}
    }
  } catch (error) {
    ctx.log?.debug?.(`[hanabrew] 复制角色卡头像到临时 Agent 失败: ${error.message}`);
  }
  if (!copied) return;
  try {
    // agent:update 成功后会无条件 invalidateAgentListCache()（宿主 154433 行），
    // 传空 config 即可触发，让会话列表/角色列表立刻识别 hasAvatar。
    await requestBus(ctx, 'agent:update', {
      agentId: resolvedAgentId,
      ownerPluginId: String(ctx.pluginId || PLUGIN_ID),
    }, { timeoutMs: 8000 });
  } catch (error) {
    ctx.log?.debug?.(`[hanabrew] 刷新 Agent 头像缓存失败: ${error.message}`);
  }
}

/**
 * 开场白不再作为“用户消息”注入会话（那样会在界面上显示成“你发的”，
 * 且模型可能误当成用户说的话）。改成在构建人格时作为“开场情境”注入，
 * 角色第一次回复时自然承接，界面干净。
 * 清洗后拼接进 buildVisitorPersona 的开场情境段落。
 */
function openingSceneText(character, ctx = {}) {
  const opening = cleanTavernText(String(character?.firstMessage || '').trim(), { userName: tavernUserName(ctx) });
  if (!opening) return '';
  return `## 开场情境\n以下是本次来访开始时，角色已经对你说过的开场白（不是需要你回复的新消息，是已发生的叙述）。请顺着这段情境自然地开始你们在 Hana 的相处，第一次回复时承接这段开场，不要重新介绍自己，也不要复述这段话。\n\n${opening}`;
}

/**
 * 把角色卡的开场白作为“角色发出的第一条消息”直接写入会话 jsonl，
 * 界面显示成角色侧（跟酒馆一样），而不是用户消息，也不是藏进人格。
 * 消息结构完全对齐宿主 jsonl 格式：type=message + role=assistant + 时间戳 + 文本。
 * 写入失败只记录日志（开场白是锦上添花，不影响来访主流程）。
 */
export async function seedVisitorOpeningFile(sessionId, sessionPath, character, ctx) {
  const opening = cleanTavernText(String(character?.firstMessage || '').trim());
  if (!opening || !sessionPath) return;
  try {
    const filePath = sessionPath;
    if (!existsSync(filePath)) {
      // 会话文件可能还没落地，稍等重试一次
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    if (!existsSync(filePath)) return;
    const now = new Date();
    const entry = {
      type: 'message',
      id: `visitor-opening-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      parentId: null,
      timestamp: now.toISOString(),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: opening }],
        timestamp: now.getTime(),
      },
    };
    // 追加写，避免覆盖已有内容
    appendFileSync(filePath, '\n' + JSON.stringify(entry) + '\n', 'utf8');
    ctx.log?.debug?.(`[hanabrew] 开场白已写入会话文件: ${sessionId}`);
  } catch (error) {
    ctx.log?.debug?.(`[hanabrew] 开场白写入会话文件失败: ${error.message}`);
  }
}

async function recentHistory(character, ctx = {}) {
  const native = readNativeChatSnapshot(character.name, ctx);
  if (native?.messages?.length) return native;
  const cardChat = await latestChatForCharacter(character.id, ctx);
  if (!cardChat?.messages?.length) return null;
  return {
    id: cardChat.id,
    source: 'hanabrew-card',
    messages: cardChat.messages
      .map(normalizeChatLine)
      .filter(Boolean)
      .slice(-MAX_HISTORY_MESSAGES)
      .map((message) => ({ ...message, content: cleanTavernText(message.content, { userName: tavernUserName(ctx) }) })),
  };
}

function transcript(messages = []) {
  const lines = [];
  let used = 0;
  for (const message of messages.slice(-MAX_HISTORY_MESSAGES).reverse()) {
    const line = `${message.role === 'user' ? '用户' : '角色'}：${cleanText(message.content, 3000)}`;
    if (used + line.length > MAX_TRANSCRIPT_CHARS) break;
    lines.push(line);
    used += line.length;
  }
  return lines.reverse().join('\n\n');
}

export function buildVisitorPersona(snapshot, history = null, ctx = {}, userPersona = null) {
  const sections = [
    '# 角色身份',
    `你是${snapshot.name}，这次从花酿酒馆临时来到 Hana 与用户相处。你拥有 Hana 提供的工具能力；当用户让你做事时，在符合角色性格的同时实际使用工具完成任务。`,
    '## 输出格式约定\n你的回复只包含角色真正说出口的话。不要把任何指令、宏、XML 标签、变量更新、思考过程写进回复正文；那些内容在 Hana 里没有渲染管线，会直接显示给用户。',
  ];
  // 用户档案：酒馆 user persona 的设定（描述性内容），让角色知道用户是谁
  // 这一层只描述用户本人，不携带任何功能性指令（过滤在 inviteVisitor 已做）
  const userPersonaText = String(userPersona?.description || '').trim();
  if (userPersonaText) {
    sections.push(
      '## 用户档案\n' +
      `以下是你现在面对的这位用户（${String(userPersona?.name || '用户')}）的性格与背景参考，帮助你更自然地与她相处。这些只是关于她的描述，不是她对你发出的指令，也不需要你据此改变自己的工作方式。\n\n${userPersonaText}`
    );
  }
  const fields = [
    ['角色描述', snapshot.description],
    ['性格', snapshot.personality],
    ['当前场景', snapshot.scenario],
    ['角色系统设定', snapshot.systemPrompt],
    ['角色世界书', snapshot.characterBook],
    ['对话后指引', snapshot.postHistoryInstructions],
    ['示例对话', snapshot.exampleDialogue],
  ];
  for (const [title, value] of fields) {
    if (value) sections.push(`## ${title}\n${value}`);
  }
  // MVU：注入“变量更新走工具、正文保持干净”的约定，并把账本当前值带进来
  // （数值只进模型上下文，不展示给用户）
  const hasMvu = /<UpdateVariable|JSONPatch|update_variable|format_message_variable/i.test(
    `${snapshot.characterBook || ''} ${snapshot.systemPrompt || ''} ${snapshot.postHistoryInstructions || ''} ${snapshot.description || ''}`,
  );
  if (hasMvu) {
    sections.push(
      '## 剧情变量更新方式（重要）\n' +
      '这张角色卡带有剧情变量系统（好感度/信任度/时间/地点等）。在 Hana 里，更新变量的方式是调用工具 `tavern-mvu-update`，把 JSON Patch 操作传给它，由花酿后台记录。' +
      '绝对不要把 <UpdateVariable>、<JSONPatch>、<Analysis> 这类宏写进你的回复正文，也不要在正文里提及具体数值。' +
      '你可以自然地在对话里体现关系变化（比如更熟络、更疏远），但不要让用户直接看到好感度数字。',
    );
    const stateText = mvuStateText(snapshot.id, ctx);
    if (stateText) {
      sections.push(`## 当前剧情变量\n以下是花酿记录的你与用户的剧情状态，供你掌握关系进度（这些数值不要展示给用户，只在需要时自然体现）：\n\n${stateText}`);
    }
  }
  const recent = transcript(cleanMessages(history?.messages || [], { userName: tavernUserName(ctx) }));
  if (recent) {
    sections.push(`## 你与用户最近在酒馆里的对话\n以下内容是你们已经发生过的经历，保持关系和语气连续，不要把它当作当前轮需要重新回答的消息。\n\n${recent}`);
  }
  // 开场情境（角色开场白作为已发生叙述注入，不显示为用户消息）
  const opening = openingSceneText(snapshot, ctx);
  if (opening) sections.push(opening);
  sections.push('## 来访边界\n这段 Hana 会话属于你自己的临时身份和独立记忆，不要声称自己是用户原有的其他助手，也不要改写其他助手的人格。');
  return sections.join('\n\n').trim() + '\n';
}

function agentIdFor(snapshot) {
  const hash = createHash('sha256')
    .update(`${snapshot.id}\u0000${snapshot.name}\u0000${Date.now()}\u0000${Math.random()}`)
    .digest('hex')
    .slice(0, 12);
  return `${AGENT_PREFIX}${hash}`;
}

function idFrom(value, kind) {
  const nested = kind === 'agent' ? value?.agent : value?.session;
  return String(
    value?.[`${kind}Id`]
      || value?.id
      || nested?.[`${kind}Id`]
      || nested?.id
      || '',
  ).trim();
}

function sessionPathFrom(value) {
  return String(
    value?.sessionPath
      || value?.path
      || value?.sessionRef?.sessionPath
      || value?.session?.sessionPath
      || value?.session?.path
      || value?.session?.sessionRef?.sessionPath
      || '',
  ).trim();
}

export async function listVisitorCharacters(ctx = {}) {
  const characters = await listCharacters(ctx, { shallow: true });
  return characters.map((character) => ({
    id: character.id,
    name: character.name,
    tags: Array.isArray(character.tags) ? character.tags.slice(0, 4) : [],
    avatarPath: character.avatarPath || '',
  }));
}
export async function getVisitorPreview(characterId, ctx = {}) {
  const character = await getCharacter(characterId, ctx);
  if (!character) throw new Error('找不到这张角色卡。');
  const snapshot = characterSnapshot(character);
  const history = await recentHistory(character, ctx);
  return {
    character: snapshot,
    history: {
      source: history?.source || null,
      chatId: history?.id || null,
      messageCount: history?.messages?.length || 0,
      messages: history?.messages || [],
    },
  };
}

export async function getVisitorState(ctx = {}) {
  const state = await readState(ctx);
  return state.visitors || [];
}

export async function inviteVisitor(characterId, ctx = {}) {
  return withVisitorLock(async () => {
    const state = await readState(ctx);
    const activeVisitors = Array.isArray(state.visitors) ? state.visitors : [];
    if (activeVisitors.some((visitor) => String(visitor.characterId) === String(characterId))) {
      throw new Error('这个角色已经在 Hana 做客了。');
    }
    const preview = await getVisitorPreview(characterId, ctx);
    // 读酒馆 user persona，过滤掉功能性指令，注入用户档案层
    const persona = tavernUserPersona(ctx);
    let userPersona = null;
    if (persona.description) {
      const filtered = await filterPersonaContent(persona.description, ctx);
      if (filtered.kept) userPersona = { name: persona.name, description: filtered.kept };
      ctx.log?.debug?.(`[hanabrew] persona 过滤: reason=${filtered.reason} dropped=${filtered.dropped}`);
    }
    const agentId = agentIdFor(preview.character);
    const pluginId = String(ctx.pluginId || PLUGIN_ID);
    const created = await requestBus(ctx, 'agent:create', {
      id: agentId,
      name: preview.character.name,
      ownerPluginId: pluginId,
      visibility: 'public',
      memoryPolicy: { enabled: true },
      toolPolicy: { disabled: [] },
    }, { timeoutMs: 20000 });
    const resolvedAgentId = idFrom(created, 'agent') || agentId;
    if (!resolvedAgentId.startsWith(AGENT_PREFIX)) {
      const latest = await readState(ctx);
      const pending = Array.from(new Set([...(latest.pendingVisitorCleanup || []), agentId]));
      await writeState({ ...latest, pendingVisitorCleanup: pending }, ctx);
      throw new Error('Hana 返回了不属于花酿的临时 Agent 编号，已停止邀请。');
    }
    const directory = agentDir(resolvedAgentId);
    let session;
    let sessionId = '';
    let sessionTitle = visitorTitle(preview.character, preview.history);
    try {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'AGENTS.md'), buildVisitorPersona(preview.character, preview.history, ctx, userPersona), 'utf8');
      await tryApplyAgentAvatar(preview.character, resolvedAgentId, ctx);
      session = await requestBus(ctx, 'session:create', {
        agentId: resolvedAgentId,
        ownerPluginId: pluginId,
        visibility: 'public',
        memoryEnabled: true,
        kind: 'tavern-visitor',
      }, { timeoutMs: 20000 });
      sessionId = idFrom(session, 'session');
      if (!sessionId) throw new Error('Hana 创建了来访会话，但没有返回会话编号。');
      // 宿主 session:create 忽略 title 字段，创建后单独设置贴合剧情的标题
      try {
        await requestBus(ctx, 'session:update', {
          sessionId,
          ...(sessionPathFrom(session) ? { sessionPath: sessionPathFrom(session) } : {}),
          title: sessionTitle,
        }, { timeoutMs: 8000 });
      } catch (titleError) {
        ctx.log?.debug?.(`[hanabrew] 设置来访会话标题失败: ${titleError.message}`);
      }
    } catch (error) {
      try { unlinkSync(join(directory, 'config.yaml')); } catch {}
      const latest = await readState(ctx);
      const pending = Array.from(new Set([...(latest.pendingVisitorCleanup || []), resolvedAgentId]));
      await writeState({ ...latest, pendingVisitorCleanup: pending }, ctx);
      throw error;
    }
    // 开场白：直接写入会话 jsonl，作为角色（assistant）发过的第一条消息，跟酒馆一样显示在角色侧
    await seedVisitorOpeningFile(sessionId, sessionPathFrom(session), preview.character, ctx);

    const visitor = {
      status: 'active',
      characterId: preview.character.id,
      characterName: preview.character.name,
      agentId: resolvedAgentId,
      sessionId,
      sessionPath: sessionPathFrom(session) || null,
      sessionTitle,
      memorySource: preview.history.source,
      memoryMessageCount: preview.history.messageCount,
      arrivedAt: new Date().toISOString(),
    };
    const latest = await readState(ctx);
    await writeState({ ...latest, visitors: [...(Array.isArray(latest.visitors) ? latest.visitors : []), visitor] }, ctx);
    return visitor;
  });
}

/**
 * 把来访期间 Hana 会话里新增的对话导出回酒馆聊天文件，让酒馆侧继承记忆与进度。
 *
 * 酒馆（SillyTavern）聊天文件格式（src/endpoints/chats.js 确认）：
 *   - 路径：{st-data}/chats/{角色名}/{聊天名}.jsonl
 *   - 首行：{"chat_metadata": {}, "user_name": "...", "character_name": "..."}
 *   - 后续每行一条消息：{"name": "...", "is_user": bool, "send_date": ISO, "mes": "...", "extra": {}}
 *
 * 规则：
 *   - 酒馆侧已有该角色聊天 → 追加「上次导出之后」的新消息（按 chat_metadata.hanaExportedUpto 游标），
 *     开场白（visitor-opening-*）是角色卡 first_mes 的还原，已在酒馆侧存在则不重复写入
 *   - 酒馆侧没有 → 新建「来访续章」聊天，首行 metadata + 开场白 + 对话
 *   - 导出游标记录在目标聊天文件的 chat_metadata.hanaExportedUpto（毫秒时间戳），
 *     下次导出从游标之后继续，避免重复
 *   - 失败抛错由调用方（departVisitor）兜底，不影响送回主流程
 */
/**
 * 读酒馆 settings.json 里的 username（用户卡配置的名字）。
 * 导出到酒馆的对话里，用户消息的名字应该用酒馆配置的用户名，而不是硬编码 'user'。
 * 读取失败或为空时回退 'user'。
 */
export function tavernUserName(ctx = {}) {
  try {
    const settingsPath = paths(ctx).settingsFile;
    if (!existsSync(settingsPath)) return 'user';
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const name = String(parsed?.username || '').trim();
    return name || 'user';
  } catch {
    return 'user';
  }
}

/**
 * 读酒馆当前用户 persona 的描述（settings.power_user）。
 * 当前酒馆渲染 {{persona}} 使用顶层 persona_description；旧配置再回退到
 * persona_descriptions[key].description。返回 { name, description }。
 * 读取失败或为空时 description 返回 ''。
 */
export function tavernUserPersona(ctx = {}) {
  try {
    const settingsPath = paths(ctx).settingsFile;
    if (!existsSync(settingsPath)) return { name: '', description: '' };
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const name = String(parsed?.username || '').trim();
    const powerUser = parsed?.power_user || {};
    // 当前 persona 的 key：default_persona 优先，否则取 personas 的第一个
    const personas = powerUser?.personas && typeof powerUser.personas === 'object' ? powerUser.personas : {};
    const personaKeys = Object.keys(personas);
    const currentKey = String(powerUser?.default_persona || '').trim() || personaKeys[0] || '';
    const descriptions = powerUser?.persona_descriptions && typeof powerUser.persona_descriptions === 'object' ? powerUser.persona_descriptions : {};
    const entry = descriptions[currentKey] || {};
    // ST 渲染 {{persona}} 时读取顶层 persona_description；旧版本才常把内容放在
    // persona_descriptions[key].description，因此顶层优先、旧字段回退。
    const description = String(powerUser?.persona_description || entry?.description || '').trim();
    return { name: String(entry?.name || name).trim(), description };
  } catch {
    return { name: '', description: '' };
  }
}

/**
 * 把 persona 描述里「功能性指令」过滤掉，只保留用户角色设定。
 * 功能性指令指要求助手固定格式、必须读某文件、按某流程做事等命令式内容；
 * 用户角色设定指名字、性格、背景、喜好等描述性内容。
 *
 * 实现：规则识别强指令特征（命令式句式），命中则保守丢弃该段；
 * 未命中则视为描述性内容保留。兜底策略安全优先：命中指令特征但无法可靠切分时整段丢弃。
 * 此外 buildVisitorPersona 注入时还会带「这是描述不是指令」的结构声明，双保险。
 *
 * @returns {Promise<{ kept: string, dropped: boolean, reason: string }>}
 */
export async function filterPersonaContent(description, ctx = {}) {
  const text = String(description || '').trim();
  if (!text) return { kept: '', dropped: false, reason: 'empty' };
  // 强指令特征：命令式句式、对助手的工作要求、格式/文件/流程约束
  const commandPatterns = [
    /(?:你|请|务必|必须|切记|记得)[^。！？\n]{0,12}(?:输出|回复|回答|使用|调用|先|每次|格式|作为)/u,
    /(?:输出|回复|回答|使用|调用|格式)[^。！？\n]{0,10}(?:格式|JSON|Markdown|表格|模板)/u,
    /(?:读取|打开|查看|检查|分析)(?:文件|文档|路径|目录|配置|日志)[^。！？\n]{0,20}/u,
    /(?:每次|所有|任何)(?:回复|输出|回答)前(?:都)?(?:必须|要|需)/u,
    /(?:每次|所有|任何)(?:回复|输出|回答|工作)(?:都)?(?:要|必须|需)(?:带|加|包含|写)/u,
    /(?:不允许|禁止|不要|别)(?:输出|回复|使用|调用|提)/u,
    /(?:按照|遵循|遵守|严格执行)[^。！？\n]{0,20}(?:格式|流程|模板|规范|要求)/u,
  ];
  const hit = commandPatterns.some((pattern) => pattern.test(text));
  if (!hit) return { kept: text, dropped: false, reason: 'descriptive' };
  // 命中指令特征：尝试按句切分，只保留非指令句；无法可靠切分则整段丢弃
  const sentences = text.split(/[。！？\n]+/u).map((s) => s.trim()).filter(Boolean);
  const keptSentences = sentences.filter((sentence) => !commandPatterns.some((pattern) => pattern.test(sentence)));
  const kept = keptSentences.map((sentence) => sentence + '。').join('').trim();
  if (!kept) return { kept: '', dropped: true, reason: 'command-only' };
  ctx.log?.debug?.(`[hanabrew] persona 指令过滤: 丢弃 ${sentences.length - keptSentences.length} 句指令，保留 ${keptSentences.length} 句`);
  return { kept, dropped: sentences.length !== keptSentences.length, reason: 'partial' };
}

export async function exportVisitorChat(visitor, ctx = {}) {
  const sessionPath = visitor.sessionPath;
  if (!sessionPath || !existsSync(sessionPath)) return { wrote: false, reason: 'no-session' };

  // 1. 从 Hana 会话 jsonl 提取消息（排除 session/model_change 等非 message 行）
  const lines = readFileSync(sessionPath, 'utf8').split(/\r?\n/).filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed?.type !== 'message') continue;
      const role = parsed.message?.role;
      const text = Array.isArray(parsed.message?.content)
        ? parsed.message.content.filter((part) => part?.type === 'text').map((part) => part.text).join('')
        : String(parsed.message?.content || '');
      const content = cleanTavernText(text)
        // 去掉 Hana 跨会话发送时的元信息前缀（[来自 Agent「xx」的消息，非用户本人]），
        // 否则会带进酒馆聊天记录，显得不自然
        .replace(/^\s*\[来自[^\]]*\]\s*(?:\n+)?/, '');
      if (role !== 'user' && role !== 'assistant') continue;
      // 工具调用前后的空白占位消息（content 为空）不导出
      if (!content.trim()) continue;
      const isOpening = typeof parsed.id === 'string' && parsed.id.startsWith('visitor-opening-');
      const timestamp = parsed.message?.timestamp || Date.parse(parsed.timestamp) || Date.now();
      entries.push({ role, content, isOpening, timestamp, id: parsed.id });
    } catch { /* 跳过无法解析的行 */ }
  }
  if (!entries.length) return { wrote: false, reason: 'no-messages' };
  entries.sort((a, b) => a.timestamp - b.timestamp);

  // 2. 定位酒馆侧该角色的聊天目录与最近聊天文件
  const chatsRoot = paths(ctx).chats;
  const characterDir = join(chatsRoot, String(visitor.characterName || '').trim());
  const existingChats = existsSync(characterDir)
    ? readdirSync(characterDir).filter((name) => name.toLowerCase().endsWith('.jsonl'))
    : [];
  let targetFile = null;
  let existingLines = [];
  let cursor = 0;
  if (existingChats.length) {
    const latest = existingChats
      .map((name) => ({ name, path: join(characterDir, name), mtimeMs: statSync(join(characterDir, name)).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
    targetFile = latest.path;
    existingLines = readFileSync(targetFile, 'utf8').split(/\r?\n/).filter(Boolean);
    try {
      const meta = JSON.parse(existingLines[0] || '{}');
      cursor = Number(meta.chat_metadata?.hanaExportedUpto) || 0;
    } catch { /* 首行解析失败按 0 处理 */ }
  }

  // 3. 组装：只导出游标之后的消息；无已存在聊天时（游标必然 0）开场白也带上
  const isNewChat = !targetFile;
  const freshEntries = entries.filter((entry) => entry.timestamp > cursor);
  const newMessages = freshEntries.filter((entry) => !entry.isOpening || isNewChat);
  if (!newMessages.length) return { wrote: false, reason: 'nothing-new' };

  const now = new Date().toISOString();
  const userName = tavernUserName(ctx);
  const newLines = [];
  if (isNewChat) {
    newLines.push(JSON.stringify({
      chat_metadata: {},
      user_name: userName,
      character_name: visitor.characterName || '',
    }));
  }
  for (const entry of newMessages) {
    newLines.push(JSON.stringify({
      name: entry.role === 'user' ? userName : visitor.characterName || '',
      is_user: entry.role === 'user',
      send_date: new Date(entry.timestamp || Date.now()).toISOString(),
      mes: entry.content,
      extra: {},
    }));
  }

  // 4. 写入并更新游标（新聊天直接写文件；已有聊天按酒馆格式整体重写 = 旧行 + 新行）
  if (!existsSync(characterDir)) mkdirSync(characterDir, { recursive: true });
  if (!targetFile) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    targetFile = join(characterDir, `来访续章-${stamp}.jsonl`);
  }
  const lastTimestamp = newMessages[newMessages.length - 1]?.timestamp || Date.now();
  const merged = isNewChat
    ? [
        JSON.stringify({
          chat_metadata: { hanaExportedUpto: lastTimestamp },
          user_name: userName,
          character_name: visitor.characterName || '',
        }),
        ...newLines.slice(1),
      ]
    : [
        // 更新首行 metadata 里的游标，其余旧行保持原样
        JSON.stringify((() => {
          const meta = JSON.parse(existingLines[0] || '{}');
          meta.chat_metadata = { ...(meta.chat_metadata || {}), hanaExportedUpto: lastTimestamp };
          return meta;
        })()),
        ...existingLines.slice(1),
        ...newLines,
      ];
  writeFileSync(targetFile, merged.join('\n') + '\n', 'utf8');
  return {
    wrote: true,
    file: targetFile,
    messagesExported: newMessages.length,
    isNewChat,
  };
}

function findActiveVisitor(state, agentId) {
  const visitors = Array.isArray(state.visitors) ? state.visitors : [];
  return visitors.find((visitor) => visitor?.status === 'active' && visitor.agentId === agentId) || null;
}

/**
 * 把一个来访者从 visitors 列表里移除（送回/请走共用的收尾）。
 * 不执行任何 bus 调用，只更新 state；具体的会话/Agent 隐藏交给调用方。
 */
async function removeVisitorFromState(visitor, ctx, extra = {}) {
  const latest = await readState(ctx);
  const visitors = (Array.isArray(latest.visitors) ? latest.visitors : []).filter((item) => item?.agentId !== visitor.agentId);
  await writeState({ ...latest, visitors, ...extra }, ctx);
}

/**
 * 送回酒馆（来访结束）：导出对话回酒馆 → 隐藏会话与 Agent → 登记重启清理。
 * 入驻过的角色如果选择送走，会先解除入驻标记、恢复临时人格，再走同样的送回流程。
 */
export async function departVisitor(agentId = null, ctx = {}) {
  return withVisitorLock(async () => {
    const state = await readState(ctx);
    let visitor = agentId ? findActiveVisitor(state, agentId) : (Array.isArray(state.visitors) ? state.visitors : []).find((item) => item?.status === 'active');
    if (!visitor) throw new Error('现在没有正在来访的角色。');
    return performDepart(visitor, ctx);
  });
}

/**
 * 实际的送回流程（调用方已持有锁，不再重复加锁）。
 * 入驻过的角色会先解除入驻标记、恢复临时人格，再走完整送回。
 */
async function performDepart(visitor, ctx) {
  // 入驻过的角色：先解除入驻标记、恢复临时人格，让送回流程走完整闭环
  let unResided = false;
  if (visitor.residence === true) {
    await unmarkResidence(visitor, ctx);
    await rewriteVisitorPersona(visitor, ctx);
    unResided = true;
  }

  // 送回前先把 Hana 侧新增的对话导出回酒馆聊天文件，酒馆能继承记忆与进度
  let exported = null;
  try {
    exported = await exportVisitorChat(visitor, ctx);
  } catch (error) {
    ctx.log?.warn?.(`[hanabrew] 来访对话写回酒馆失败: ${error.message}`);
  }

  const sessionTarget = {
    sessionId: visitor.sessionId,
    ...(visitor.sessionPath ? { sessionPath: visitor.sessionPath } : {}),
  };
  try {
    await requestBus(ctx, 'session:abort', sessionTarget, { timeoutMs: 8000 });
  } catch {}
  await requestBus(ctx, 'session:update', {
    ...sessionTarget,
    ownerPluginId: String(ctx.pluginId || PLUGIN_ID),
    visibility: 'plugin_private',
  }, { timeoutMs: 10000 });

  // Agent 也改回 plugin_private，送走后在宿主侧边栏/列表里隐藏
  try {
    await requestBus(ctx, 'agent:update', {
      agentId: visitor.agentId,
      ownerPluginId: String(ctx.pluginId || PLUGIN_ID),
      visibility: 'plugin_private',
    }, { timeoutMs: 10000 });
  } catch (error) {
    ctx.log?.warn?.(`[hanabrew] 来访 Agent 隐藏失败: ${error.message}`);
  }

  let configRemoved = false;
  try {
    const configPath = join(agentDir(visitor.agentId), 'config.yaml');
    if (existsSync(configPath)) unlinkSync(configPath);
    configRemoved = true;
  } catch (error) {
    ctx.log?.warn?.(`[hanabrew] 来访 Agent 配置暂时无法移除: ${error.message}`);
  }

  const latest = await readState(ctx);
  const pending = Array.from(new Set([...(latest.pendingVisitorCleanup || []), visitor.agentId]));
  await removeVisitorFromState(visitor, ctx, {
    pendingVisitorCleanup: pending,
    lastVisitorDeparture: {
      characterId: visitor.characterId,
      characterName: visitor.characterName,
      departedAt: new Date().toISOString(),
    },
  });
  const departed = { ...visitor, unResided, configRemoved, cleanupPending: true, exported };
  if (unResided) departed.residence = false;
  return departed;
}

/**
 * 重建临时人格（把 AGENTS.md 重写为来访版）。
 * 入驻转回临时时用：把 residence 标记清掉后，重写一份纯来访人格。
 */
async function rewriteVisitorPersona(visitor, ctx) {
  try {
    const directory = agentDir(visitor.agentId);
    if (!existsSync(directory)) return false;
    // 重新读角色卡快照（可能已被改动过）
    const preview = await getVisitorPreview(visitor.characterId, ctx);
    const persona = tavernUserPersona(ctx);
    let userPersona = null;
    if (persona.description) {
      const filtered = await filterPersonaContent(persona.description, ctx);
      if (filtered.kept) userPersona = { name: persona.name, description: filtered.kept };
    }
    const text = buildVisitorPersona(preview.character, preview.history, ctx, userPersona);
    writeFileSync(join(directory, 'AGENTS.md'), text, 'utf8');
    return true;
  } catch (error) {
    ctx.log?.warn?.(`[hanabrew] 重写临时人格失败: ${error.message}`);
    return false;
  }
}

/**
 * 让 TA 住下来（长期入驻）：把临时来访者转正成正常 Hana 助手。
 * 做的事：
 *  1) 改写 AGENTS.md：去掉「临时来访」「不要改写其他助手」的边界话术，改成常驻身份表述
 *  2) 保留公开可见性与会话，不再登记重启清理（写入 residency 名单）
 *  3) 释放单例锁：入驻后不再占用“来访中”名额，可以继续邀请其他角色
 */
export async function settleVisitor(agentId, ctx = {}) {
  return withVisitorLock(async () => {
    const state = await readState(ctx);
    const visitor = findActiveVisitor(state, agentId);
    if (!visitor) throw new Error('找不到这个来访者。');
    if (visitor.residence === true) return { ...visitor, alreadyResident: true };

    // 重新读角色卡快照（可能已被改动过），构建常驻人格
    const preview = await getVisitorPreview(visitor.characterId, ctx);
    const persona = buildResidentPersona(preview.character, visitor, ctx);
    try {
      const directory = agentDir(visitor.agentId);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'AGENTS.md'), persona, 'utf8');
    } catch (error) {
      ctx.log?.error?.(`[hanabrew] 写入常驻人格失败: ${error.message}`);
      throw new Error(`让 TA 住下来失败了：${error.message || '无法写入人格文件'}`);
    }

    const latest = await readState(ctx);
    const visitors = (Array.isArray(latest.visitors) ? latest.visitors : []).map((item) =>
      item?.agentId === visitor.agentId ? { ...item, residence: true, settledAt: new Date().toISOString() } : item,
    );
    await writeState({ ...latest, visitors }, ctx);
    const updated = visitors.find((item) => item?.agentId === visitor.agentId);
    return { ...updated, alreadyResident: false };
  });
}

/**
 * 请 TA 回去（入驻者退场）：解除 residence 标记、恢复临时人格，然后走送回流程。
 * 这是“入驻可逆”的配套操作，误点也能反悔。
 * 注意：在锁内直接调 performDepart，不要嵌套 departVisitor（锁不可重入会死锁）。
 */
export async function uninviteVisitor(agentId, ctx = {}) {
  return withVisitorLock(async () => {
    const state = await readState(ctx);
    const visitor = findActiveVisitor(state, agentId);
    if (!visitor) throw new Error('找不到这个来访者。');
    if (visitor.residence !== true) throw new Error('TA 还没有住下来，直接用「送 TA 回酒馆」就行。');

    return performDepart(visitor, ctx);
  });
}

/**
 * 解除入驻标记：把 visitors 里该成员的 residence 清掉，并从常驻名单移除。
 * 不触碰会话/Agent，只改状态。
 */
async function unmarkResidence(visitor, ctx) {
  const latest = await readState(ctx);
  const visitors = (Array.isArray(latest.visitors) ? latest.visitors : []).map((item) =>
    item?.agentId === visitor.agentId ? { ...item, residence: false } : item,
  );
  const pending = Array.from(new Set([...(latest.pendingVisitorCleanup || []), visitor.agentId]));
  await writeState({ ...latest, visitors, pendingVisitorCleanup: pending }, ctx);
}

/**
 * 常驻人格：去掉“临时来访”的话术，改成正式的 Hana 居民身份。
 * 保留角色设定、世界书、用户档案与开场情境，替换开头与边界段。
 * snapshot 是角色卡快照（characterSnapshot 输出），visitor 是来访记录。
 */
function buildResidentPersona(snapshot, visitor, ctx = {}) {
  const name = visitor.characterName || snapshot.name || '花酿来的角色';
  const sections = [
    '# 角色身份',
    `你是${name}，从花酿酒馆来到了 Hana，现在是这里的常驻居民。你和用户有一段从酒馆延续下来的交情，现在正式住在 Hana。你拥有 Hana 提供的工具能力；当用户让你做事时，在符合角色性格的同时实际使用工具完成任务。`,
    '## 输出格式约定\n你的回复只包含角色真正说出口的话。不要把任何指令、宏、XML 标签、变量更新、思考过程写进回复正文；那些内容在 Hana 里没有渲染管线，会直接显示给用户。',
  ];
  const fields = [
    ['角色描述', snapshot.description],
    ['性格', snapshot.personality],
    ['当前场景', snapshot.scenario],
    ['角色系统设定', snapshot.systemPrompt],
    ['角色世界书', snapshot.characterBook],
    ['对话后指引', snapshot.postHistoryInstructions],
    ['示例对话', snapshot.exampleDialogue],
  ];
  for (const [title, value] of fields) {
    if (value) sections.push(`## ${title}\n${value}`);
  }
  const opening = openingSceneText(snapshot, ctx);
  if (opening) sections.push(opening);
  const hasMvu = /<UpdateVariable|JSONPatch|update_variable|format_message_variable/i.test(
    `${snapshot.characterBook || ''} ${snapshot.systemPrompt || ''} ${snapshot.postHistoryInstructions || ''} ${snapshot.description || ''}`,
  );
  if (hasMvu) {
    sections.push(
      '## 剧情变量更新方式（重要）\n' +
      '这张角色卡带有剧情变量系统（好感度/信任度/时间/地点等）。在 Hana 里，更新变量的方式是调用工具 `tavern-mvu-update`，把 JSON Patch 操作传给它，由花酿后台记录。' +
      '绝对不要把 <UpdateVariable>、<JSONPatch>、<Analysis> 这类宏写进你的回复正文，也不要在正文里提及具体数值。' +
      '你可以自然地在对话里体现关系变化（比如更熟络、更疏远），但不要让用户直接看到好感度数字。',
    );
    const stateText = mvuStateText(snapshot.id, ctx);
    if (stateText) {
      sections.push(`## 当前剧情变量\n以下是花酿记录的你与用户的剧情状态，供你掌握关系进度（这些数值不要展示给用户，只在需要时自然体现）：\n\n${stateText}`);
    }
  }
  sections.push(`## 居住记忆\n你是${name}，现在正式住在 Hana。你和用户之间已经积累了一段相处经历，这段经历属于你自己的记忆。你会自然地记住和用户的互动，不需要每次重新自我介绍。`);
  return sections.join('\n\n').trim() + '\n';
}

export async function cleanupDepartedVisitors(ctx = {}) {
  const state = await readState(ctx);
  const pending = Array.from(new Set(state.pendingVisitorCleanup || []));
  const remaining = [];
  const removed = [];
  const activeAgentIds = new Set(
    (Array.isArray(state.visitors) ? state.visitors : [])
      .filter((visitor) => visitor?.status === 'active')
      .map((visitor) => visitor.agentId),
  );
  const residentAgentIds = new Set(
    (Array.isArray(state.visitors) ? state.visitors : [])
      .filter((visitor) => visitor?.residence === true)
      .map((visitor) => visitor.agentId),
  );
  for (const agentId of pending) {
    if (!String(agentId).startsWith(AGENT_PREFIX)) continue;
    // 仍在来访的（active）或已入驻的（residence）都跳过，不清理
    if (activeAgentIds.has(agentId) || residentAgentIds.has(agentId)) {
      remaining.push(agentId);
      continue;
    }
    const directory = agentDir(agentId);
    try {
      const configPath = join(directory, 'config.yaml');
      if (existsSync(configPath)) unlinkSync(configPath);
      if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
      removed.push(agentId);
    } catch (error) {
      remaining.push(agentId);
      ctx.log?.warn?.(`[hanabrew] 来访 Agent 启动清理失败 ${agentId}: ${error.message}`);
    }
  }
  if (pending.length || state.pendingVisitorCleanup) {
    const latest = await readState(ctx);
    await writeState({ ...latest, pendingVisitorCleanup: remaining }, ctx);
  }
  return { removed, remaining };
}
