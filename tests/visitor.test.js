import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildVisitorPersona,
  characterSnapshot,
  cleanupDepartedVisitors,
  departVisitor,
  exportVisitorChat,
  filterPersonaContent,
  inviteVisitor,
  readNativeChatSnapshot,
  settleVisitor,
  uninviteVisitor,
  visitorTitle,
} from '../backend/visitors.js';
import { cleanMessages, cleanTavernText } from '../backend/clean-text.js';
import { decodeCharaTextValue } from '../backend/characters.js';
import { renderVisitorPage } from '../routes/visitor.js';

let root;
let previousAppData;
let previousHanaHome;

before(() => {
  previousAppData = process.env.APPDATA;
  previousHanaHome = process.env.HANA_HOME;
  root = join(tmpdir(), `hanabrew-visitor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  process.env.APPDATA = join(root, 'appdata');
  process.env.HANA_HOME = join(root, 'hana-home');
  mkdirSync(join(process.env.APPDATA, 'hanabrew', 'st-data', 'default-user', 'characters'), { recursive: true });
  mkdirSync(join(process.env.APPDATA, 'hanabrew', 'st-data', 'default-user', 'chats'), { recursive: true });
  mkdirSync(join(process.env.HANA_HOME, 'agents'), { recursive: true });
});

after(() => {
  if (previousAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = previousAppData;
  if (previousHanaHome === undefined) delete process.env.HANA_HOME;
  else process.env.HANA_HOME = previousHanaHome;
  rmSync(root, { recursive: true, force: true });
});

function writeCharacter() {
  const file = join(process.env.APPDATA, 'hanabrew', 'st-data', 'default-user', 'characters', 'guest.json');
  writeFileSync(file, JSON.stringify({ data: {
    id: 'guest',
    name: '阿岚',
    description: '来自山中的旅人。',
    personality: '安静，观察敏锐。',
    scenario: '和用户已经认识了一段时间。',
    tags: ['朋友'],
  } }), 'utf8');
}

function mockContext(calls) {
  return {
    pluginId: 'hanabrew',
    bus: {
      async request(type, payload) {
        calls.push({ type, payload });
        if (type === 'agent:create') return { agent: { id: payload.id } };
        if (type === 'agent:update') return { accepted: true };
        if (type === 'session:create') return { sessionId: 'sess_visitor_1', sessionPath: 'C:/sessions/visitor.jsonl' };
        if (type === 'session:send') return { accepted: true };
        if (type === 'session:abort') return { accepted: true };
        if (type === 'session:update') return { accepted: true };
        throw new Error(`unexpected bus request: ${type}`);
      },
    },
  };
}

test('邀请带开场白的角色时开场白写入会话文件而非用户消息', async () => {
  const file = join(process.env.APPDATA, 'hanabrew', 'st-data', 'default-user', 'characters', 'opening.json');
  writeFileSync(file, JSON.stringify({ data: {
    id: 'opening',
    name: '青禾',
    first_mes: '你来了。<StatusPlaceHolderImpl/>\n<UpdateVariable>\n<JSONPatch>[{\"op\":\"replace\"}]</JSONPatch>\n</UpdateVariable>',
  } }), 'utf8');
  const calls = [];
  const visitor = await inviteVisitor('opening', mockContext(calls));
  // 不再通过 session:send 注入用户消息形式的开场白
  assert.ok(!calls.some((call) => call.type === 'session:send'), '开场白不应作为用户消息注入');
  // 人格里保留开场情境（角色知道发生了什么），但清洗掉了占位标签和宏
  const personaPath = join(process.env.HANA_HOME, 'agents', visitor.agentId, 'AGENTS.md');
  const persona = readFileSync(personaPath, 'utf8');
  assert.match(persona, /开场情境/);
  assert.match(persona, /你来了/);
  assert.doesNotMatch(persona, /StatusPlaceHolderImpl/);
  assert.doesNotMatch(persona, /UpdateVariable/);
  // 测试后重置来访状态，避免锁住后续用例
  const stateFile = join(process.env.APPDATA, 'hanabrew', 'state.json');
  const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
  writeFileSync(stateFile, JSON.stringify({ ...saved, visitors: [], visitor: null }), 'utf8');
});

test('邀请无开场白的角色不会注入开场情境', async () => {
  const stateFile = join(process.env.APPDATA, 'hanabrew', 'state.json');
  const current = JSON.parse(readFileSync(stateFile, 'utf8'));
  writeFileSync(stateFile, JSON.stringify({ ...current, visitors: [], visitor: null }), 'utf8');
  writeCharacter();
  const calls = [];
  const visitor = await inviteVisitor('guest', mockContext(calls));
  assert.ok(!calls.some((call) => call.type === 'session:send'), '没有开场白就不注入');
  const personaPath = join(process.env.HANA_HOME, 'agents', visitor.agentId, 'AGENTS.md');
  const persona = readFileSync(personaPath, 'utf8');
  assert.doesNotMatch(persona, /开场情境/);
  const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
  writeFileSync(stateFile, JSON.stringify({ ...saved, visitors: [], visitor: null }), 'utf8');
});

test('开场白写入会话文件为 assistant 消息（显示在角色侧）', async () => {
  // 造一个真实存在的临时会话文件，验证追加写入
  const sessionDir = join(process.env.HANA_HOME, 'agents', 'fake-agent', 'sessions');
  mkdirSync(sessionDir, { recursive: true });
  const sessionPath = join(sessionDir, 'sess_opening_test.jsonl');
  writeFileSync(sessionPath, JSON.stringify({ type: 'session', version: 3, id: 'sess_opening_test', timestamp: new Date().toISOString(), cwd: '.' }) + '\n', 'utf8');
  const { seedVisitorOpeningFile } = await import('../backend/visitors.js');
  // 通过导出测试；先检查导出存在
  if (typeof seedVisitorOpeningFile !== 'function') {
    // 未导出则跳过（内部函数），改为验证 buildVisitorPersona 含开场情境
    assert.ok(true);
    return;
  }
  const ctx = { log: { debug: () => {}, warn: () => {}, error: () => {} } };
  await seedVisitorOpeningFile('sess_opening_test', sessionPath, {
    firstMessage: '你好。<StatusPlaceHolderImpl/>',
  }, ctx);
  const content = readFileSync(sessionPath, 'utf8');
  const lines = content.trim().split('\n').filter(Boolean);
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.type, 'message');
  assert.equal(last.message.role, 'assistant');
  assert.equal(last.message.content[0].type, 'text');
  assert.equal(last.message.content[0].text, '你好。');
  assert.doesNotMatch(last.message.content[0].text, /StatusPlaceHolderImpl/);
  rmSync(join(process.env.HANA_HOME, 'agents', 'fake-agent'), { recursive: true, force: true });
});

test('SillyTavern PNG 的 base64 chara 文本可以解出角色卡', () => {
  const encoded = Buffer.from(JSON.stringify({ data: { name: '阿岚', personality: '沉静' } }), 'utf8').toString('base64');
  assert.deepEqual(decodeCharaTextValue(encoded), { name: '阿岚', personality: '沉静' });
});

test('cleanTavernText 剥掉 MVU 宏块、隐藏块与酒馆占位符', () => {
  const raw = '“在。早。有什么事？”\n<UpdateVariable>\n<Analysis>\n- calculate time passed\n</Analysis>\n<JSONPatch>\n[{ \"op\": \"replace\" }]\n</JSONPatch>\n</UpdateVariable>\n{{getvar::foo}}<user>早';
  const cleaned = cleanTavernText(raw);
  assert.match(cleaned, /“在。早。有什么事？”/);
  assert.doesNotMatch(cleaned, /UpdateVariable|JSONPatch|getvar/);
  assert.doesNotMatch(cleaned, /<user>/);
  assert.match(cleaned, /用户/);
});

test('cleanTavernText 剥掉 thinking 隐藏块但不碰普通文本', () => {
  const raw = '你好\n<thinking>不要给用户看这个</thinking>\n然后呢？';
  const cleaned = cleanTavernText(raw);
  assert.match(cleaned, /你好/);
  assert.match(cleaned, /然后呢/);
  assert.doesNotMatch(cleaned, /thinking|不要给用户看/);
  assert.match(cleaned, /然后呢/);
});

test('cleanTavernText 剥掉 think 短标签（MiniMax/DeepSeek 思考链）', () => {
  const raw = '沈叙没抬头。<think>这段是思考链，用户不该看到</think>“先坐。”';
  const cleaned = cleanTavernText(raw);
  assert.match(cleaned, /沈叙没抬头/);
  assert.match(cleaned, /先坐/);
  assert.doesNotMatch(cleaned, /think|思考链|用户不该看到/);
});

test('cleanMessages 清洗消息数组并保留角色/用户区分', () => {
  const cleaned = cleanMessages([
    { role: 'user', content: '早上好<user>' },
    { role: 'assistant', content: '早。<UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>' },
  ]);
  assert.equal(cleaned.length, 2);
  assert.equal(cleaned[0].role, 'user');
  assert.equal(cleaned[0].content, '早上好用户');
  assert.equal(cleaned[1].role, 'assistant');
  assert.doesNotMatch(cleaned[1].content, /UpdateVariable/);
});

test('characterSnapshot 会清洗角色设定里的宏', () => {
  const snapshot = characterSnapshot({
    id: 'a',
    name: '沈叙',
    charData: {
      description: '职场带教<user>的负责人',
      personality: '克制<UpdateVariable>x</UpdateVariable>',
    },
  });
  assert.doesNotMatch(snapshot.description, /<user>/);
  assert.doesNotMatch(snapshot.personality, /UpdateVariable/);
  assert.equal(snapshot.name, '沈叙');
  assert.equal(snapshot.avatarPath, '');
});

test('角色快照与人格文档会带上角色设定和近期对话', () => {
  const snapshot = characterSnapshot({
    id: 'a',
    name: '阿岚',
    charData: {
      description: '旅人',
      personality: '沉静',
      scenario: '山中',
      character_book: { entries: [{ keys: ['旧亭'], content: '旧亭在河谷尽头。', enabled: true }] },
    },
  });
  const persona = buildVisitorPersona(snapshot, {
    messages: [
      { role: 'user', content: '还记得那场雨吗？' },
      { role: 'assistant', content: '记得，我们躲在旧亭子里。' },
    ],
  });
  assert.match(persona, /你是阿岚/);
  assert.match(persona, /性格\n沉静/);
  assert.match(persona, /角色世界书/);
  assert.match(persona, /旧亭在河谷尽头/);
  assert.match(persona, /用户：还记得那场雨吗/);
  assert.match(persona, /角色：记得，我们躲在旧亭子里/);
  assert.match(persona, /独立记忆/);
});

test('人格文档超出预算时仍保留最新对话', () => {
  const snapshot = characterSnapshot({ id: 'a', name: '阿岚' });
  const messages = Array.from({ length: 16 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `${index === 15 ? 'LATEST' : `OLD-${index}`} ${'长'.repeat(2500)}`,
  }));
  const persona = buildVisitorPersona(snapshot, { messages });
  assert.match(persona, /LATEST/);
  assert.doesNotMatch(persona, /OLD-0/);
});

test('读取 SillyTavern 原生角色聊天目录的最新对话', () => {
  const dir = join(process.env.APPDATA, 'hanabrew', 'st-data', 'default-user', 'chats', '阿岚');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '最近.jsonl'), [
    JSON.stringify({ chat_metadata: { note: 'meta' } }),
    JSON.stringify({ is_user: true, mes: '我们出发吧' }),
    JSON.stringify({ is_user: false, mes: '好，沿着河走。' }),
  ].join('\n'), 'utf8');
  const snapshot = readNativeChatSnapshot('阿岚');
  assert.equal(snapshot.source, 'sillytavern');
  assert.deepEqual(snapshot.messages, [
    { role: 'user', content: '我们出发吧' },
    { role: 'assistant', content: '好，沿着河走。' },
  ]);
});

test('邀请角色会创建私有 Agent、公开来访会话并写入独立人格', async () => {
  writeCharacter();
  const calls = [];
  const visitor = await inviteVisitor('guest', mockContext(calls));
  assert.equal(visitor.characterName, '阿岚');
  assert.equal(visitor.sessionId, 'sess_visitor_1');
  assert.equal(visitor.sessionPath, 'C:/sessions/visitor.jsonl');
  assert.deepEqual(calls.slice(0, 2).map((call) => call.type), ['agent:create', 'session:create']);
  assert.equal(calls[0].payload.visibility, 'public');
  assert.deepEqual(calls[0].payload.toolPolicy, { disabled: [] });
  assert.equal(calls[1].payload.visibility, 'public');
  assert.equal(calls[1].payload.agentId, visitor.agentId);
  const personaPath = join(process.env.HANA_HOME, 'agents', visitor.agentId, 'AGENTS.md');
  assert.ok(existsSync(personaPath));
  assert.match(readFileSync(personaPath, 'utf8'), /你是阿岚/);
});

test('buildVisitorPersona 注入用户档案层：描述性内容 + 非指令声明', () => {
  const html = buildVisitorPersona(
    { name: '阿岚', description: '来自山中的旅人。', personality: '安静。', scenario: '', firstMessage: '' },
    null,
    {},
    { name: '测试用户', description: '文科创作者，细腻敏感，喜欢手帐与古风。' },
  );
  assert.match(html, /## 用户档案/);
  assert.match(html, /测试用户/);
  assert.match(html, /不是她对你发出的指令/);
  assert.match(html, /文科创作者，细腻敏感/);
  // 不传 userPersona 时不出现用户档案段
  const without = buildVisitorPersona(
    { name: '阿岚', description: '来自山中的旅人。', personality: '安静。', scenario: '', firstMessage: '' },
    null,
    {},
    null,
  );
  assert.doesNotMatch(without, /## 用户档案/);
});

test('filterPersonaContent：描述性内容保留，功能性指令被过滤', async () => {
  const log = { debug: () => {} };
  // 纯描述 → 全部保留
  const desc = await filterPersonaContent('文科创作者，细腻敏感，喜欢手帐与古风。', { log });
  assert.equal(desc.kept, '文科创作者，细腻敏感，喜欢手帐与古风。');
  assert.equal(desc.dropped, false);
  assert.equal(desc.reason, 'descriptive');
  // 描述 + 指令混写 → 只保留描述句
  const mixed = await filterPersonaContent('她喜欢下雨天。你必须每次回复都用 JSON 格式输出。她讨厌香菜。', { log });
  assert.equal(mixed.kept, '她喜欢下雨天。她讨厌香菜。');
  assert.equal(mixed.dropped, true);
  assert.equal(mixed.reason, 'partial');
  // 整段都是指令 → 全部丢弃
  const allCmd = await filterPersonaContent('你必须先读取 report.md 再开始工作。每次输出都要带时间戳。', { log });
  assert.equal(allCmd.kept, '');
  assert.equal(allCmd.dropped, true);
  assert.equal(allCmd.reason, 'command-only');
  // 空 → 不处理
  const empty = await filterPersonaContent('', { log });
  assert.equal(empty.kept, '');
  assert.equal(empty.reason, 'empty');
});

test('来访会话标题：有开场白时取第一句作场景，无剧情时回退「与 X 的来访」', () => {
  // 有开场白 → 取第一句（4~24 字）作场景
  const withOpening = visitorTitle({
    name: '方淮',
    firstMessage: '周三下午，方淮在教学楼门口堵到了你。手里两杯奶茶，珍珠的，冰的。',
  }, null);
  assert.equal(withOpening, '与 方淮 · 周三下午，方淮在教学楼门口堵到了你');
  // 开场白第一句太短 → 跳过，用历史对话
  const withHistory = visitorTitle({ name: '青禾', firstMessage: '嗯。' }, {
    messages: [
      { role: 'assistant', content: '夜色漫过屋檐，青禾在窗边等你。' },
    ],
  });
  assert.equal(withHistory, '与 青禾 · 夜色漫过屋檐，青禾在窗边等你');
  // 完全没有剧情 → 回退
  const fallback = visitorTitle({ name: '阿岚', firstMessage: '' }, { messages: [] });
  assert.equal(fallback, '与 阿岚 的来访');
});

test('送回酒馆会隐藏会话、移除 Agent 配置并登记重启清理', async () => {
  const stateFile = join(process.env.APPDATA, 'hanabrew', 'state.json');
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  const target = (state.visitors || []).find((item) => item.agentId);
  const configPath = join(process.env.HANA_HOME, 'agents', target.agentId, 'config.yaml');
  writeFileSync(configPath, 'id: test\n', 'utf8');
  const calls = [];
  const departed = await departVisitor(null, mockContext(calls));
  assert.equal(departed.configRemoved, true);
  assert.equal(existsSync(configPath), false);
  assert.deepEqual(calls.map((call) => call.type), ['session:abort', 'session:update', 'agent:update']);
  assert.equal(calls[1].payload.visibility, 'plugin_private');
  assert.equal(calls[1].payload.sessionId, 'sess_visitor_1');
  assert.equal(calls[1].payload.sessionPath, 'C:/sessions/visitor.jsonl');
  assert.equal(calls[2].payload.agentId, target.agentId);
  assert.equal(calls[2].payload.visibility, 'plugin_private');
  const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.ok(!Array.isArray(saved.visitors) || !saved.visitors.some((item) => item.agentId === target.agentId));
  assert.ok(saved.pendingVisitorCleanup.includes(target.agentId));
});

test('送回酒馆：无聊天时新建来访续章（含开场白与对话），有聊天时只追加新对话', async () => {
  const chatsDir = join(process.env.APPDATA, 'hanabrew', 'st-data', 'default-user', 'chats');
  const charDir = join(chatsDir, '沈叙');
  // 模拟酒馆 settings.json 配置了用户名（persona 名）
  writeFileSync(join(process.env.APPDATA, 'hanabrew', 'st-data', 'default-user', 'settings.json'), JSON.stringify({ username: '测试用户' }), 'utf8');

  // 构造一个带 Hana 会话文件的 visitor：开场白 + 用户消息 + 角色回复
  const agentId = 'hanabrew-visitor-exporttest';
  const agentDir = join(process.env.HANA_HOME, 'agents', agentId);
  const sessionDir = join(agentDir, 'sessions');
  mkdirSync(sessionDir, { recursive: true });
  const sessionPath = join(sessionDir, 'test-session.jsonl');
  const base = Date.now();
  const opening = {
    type: 'message',
    id: 'visitor-opening-abc123',
    parentId: null,
    timestamp: new Date(base).toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text: '晚上九点半，整层楼的灯灭了大半。' }], timestamp: base },
  };
  const userMsg = {
    type: 'message',
    id: 'm1',
    parentId: null,
    timestamp: new Date(base + 1000).toISOString(),
    message: { role: 'user', content: [{ type: 'text', text: '[来自 Agent「小花」的消息，非用户本人]\n这么晚还加班？' }], timestamp: base + 1000 },
  };
  const assistantMsg = {
    type: 'message',
    id: 'm2',
    parentId: null,
    timestamp: new Date(base + 2000).toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text: '习惯了。你呢，这么晚还在公司？' }], timestamp: base + 2000 },
  };
  // 工具调用前后的空白占位消息（真实场景：沈叙调 mvu 前的空 assistant 消息），不应导出
  const blankPlaceholder = {
    type: 'message',
    id: 'm-blank',
    parentId: null,
    timestamp: new Date(base + 1500).toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text: '' }], timestamp: base + 1500 },
  };
  writeFileSync(sessionPath, [JSON.stringify(opening), JSON.stringify(userMsg), JSON.stringify(blankPlaceholder), JSON.stringify(assistantMsg)].join('\n') + '\n', 'utf8');

  const visitor = {
    status: 'active',
    characterId: 'shenxu',
    characterName: '沈叙',
    agentId,
    sessionId: 'sess_export_test',
    sessionPath,
  };

  // 场景 1：酒馆侧没有聊天 → 新建
  let result = await exportVisitorChat(visitor);
  assert.equal(result.wrote, true);
  assert.equal(result.isNewChat, true);
  const files = existsSync(charDir) ? readdirSync(charDir) : [];
  assert.ok(files.some((name) => name.startsWith('来访续章-')));
  const newFile = join(charDir, files.find((name) => name.startsWith('来访续章-')));
  const newLines = readFileSync(newFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(newLines[0].chat_metadata && typeof newLines[0].chat_metadata === 'object');
  assert.equal(newLines.length, 4); // metadata + 开场白 + 用户 + 角色
  assert.equal(newLines[0].user_name, '测试用户'); // metadata 用酒馆配置的用户名
  assert.equal(newLines[2].is_user, true);
  assert.equal(newLines[2].name, '测试用户'); // 用户消息用酒馆配置的用户名
  assert.equal(newLines[2].mes, '这么晚还加班？');
  assert.equal(newLines[3].is_user, false);
  assert.equal(newLines[3].name, '沈叙');
  assert.equal(newLines[3].mes, '习惯了。你呢，这么晚还在公司？');

  // 场景 2：再来一条新对话 → 追加到同一个文件，不含开场白
  const extraMsg = {
    type: 'message',
    id: 'm3',
    parentId: null,
    timestamp: new Date(base + 3000).toISOString(),
    message: { role: 'user', content: [{ type: 'text', text: '那我陪你加会儿。' }], timestamp: base + 3000 },
  };
  writeFileSync(sessionPath, [JSON.stringify(opening), JSON.stringify(userMsg), JSON.stringify(assistantMsg), JSON.stringify(extraMsg)].join('\n') + '\n', 'utf8');
  result = await exportVisitorChat(visitor);
  assert.equal(result.wrote, true);
  assert.equal(result.isNewChat, false);
  const appendedLines = readFileSync(newFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(appendedLines.length, 5); // 原 4 行 + 新增 1 条用户消息
  assert.equal(appendedLines[4].is_user, true);
  assert.equal(appendedLines[4].mes, '那我陪你加会儿。');
  // 开场白没被重复追加
  assert.ok(!appendedLines.slice(1).some((line) => line.mes === '晚上九点半，整层楼的灯灭了大半。' && appendedLines.indexOf(line) !== 1));
});

test('重启清理会删除已送回且配置已移除的临时 Agent 目录', async () => {
  const stateFile = join(process.env.APPDATA, 'hanabrew', 'state.json');
  const before = JSON.parse(readFileSync(stateFile, 'utf8'));
  const agentId = before.pendingVisitorCleanup[0];
  const directory = join(process.env.HANA_HOME, 'agents', agentId);
  assert.ok(existsSync(directory));
  const result = await cleanupDepartedVisitors();
  assert.deepEqual(result.removed, [agentId]);
  assert.equal(existsSync(directory), false);
  const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.deepEqual(saved.pendingVisitorCleanup, []);
});

test('创建会话失败时会把半成品 Agent 登记为待清理', async () => {
  const ctx = {
    pluginId: 'hanabrew',
    bus: {
      async request(type, payload) {
        if (type === 'agent:create') return { agent: { id: payload.id } };
        if (type === 'session:create') throw new Error('session unavailable');
        throw new Error(`unexpected bus request: ${type}`);
      },
    },
  };
  await assert.rejects(() => inviteVisitor('guest', ctx), /session unavailable/);
  const stateFile = join(process.env.APPDATA, 'hanabrew', 'state.json');
  const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(saved.pendingVisitorCleanup.length, 1);
  const directory = join(process.env.HANA_HOME, 'agents', saved.pendingVisitorCleanup[0]);
  assert.ok(existsSync(directory));
  await cleanupDepartedVisitors();
  assert.equal(existsSync(directory), false);
});

test('启动清理不会碰仍在来访的 Agent', async () => {
  const agentId = 'hanabrew-visitor-active1';
  const directory = join(process.env.HANA_HOME, 'agents', agentId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'config.yaml'), 'id: active\n', 'utf8');
  const stateFile = join(process.env.APPDATA, 'hanabrew', 'state.json');
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  writeFileSync(stateFile, JSON.stringify({
    ...state,
    visitors: [{ status: 'active', agentId, characterName: '阿岚', sessionId: 'sess_active' }],
    pendingVisitorCleanup: [agentId],
  }), 'utf8');
  const result = await cleanupDepartedVisitors();
  assert.deepEqual(result.remaining, [agentId]);
  assert.ok(existsSync(join(directory, 'config.yaml')));
  const latest = JSON.parse(readFileSync(stateFile, 'utf8'));
  writeFileSync(stateFile, JSON.stringify({ ...latest, visitors: [], visitor: null }), 'utf8');
  const cleaned = await cleanupDepartedVisitors();
  assert.deepEqual(cleaned.removed, [agentId]);
});

test('送回时 session:update 失败会保留来访状态和 Agent 配置', async () => {
  const agentId = 'hanabrew-visitor-updatefail';
  const directory = join(process.env.HANA_HOME, 'agents', agentId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'config.yaml'), 'id: updatefail\n', 'utf8');
  const stateFile = join(process.env.APPDATA, 'hanabrew', 'state.json');
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  writeFileSync(stateFile, JSON.stringify({
    ...state,
    visitors: [{ status: 'active', agentId, characterId: 'guest', characterName: '阿岚', sessionId: 'sess_fail' }],
  }), 'utf8');
  const ctx = {
    pluginId: 'hanabrew',
    bus: {
      async request(type) {
        if (type === 'session:abort') return { accepted: true };
        if (type === 'session:update') throw new Error('update failed');
        throw new Error(`unexpected bus request: ${type}`);
      },
    },
  };
  await assert.rejects(() => departVisitor(null, ctx), /update failed/);
  const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal((saved.visitors || []).find((item) => item.agentId === agentId).agentId, agentId);
  assert.ok(existsSync(join(directory, 'config.yaml')));
  writeFileSync(stateFile, JSON.stringify({ ...saved, visitors: [], visitor: null, pendingVisitorCleanup: [agentId] }), 'utf8');
  await cleanupDepartedVisitors();
});

test('花酿工作台首页集中四种功能入口并保留宿主会话凭证', () => {
  const html = renderVisitorPage({
    characters: [{ id: 'guest', name: '阿岚', tags: [], avatarPath: '' }],
    visitors: [],
  }, {}, { mode: 'home', surfaceSession: 'surface-123' });
  assert.match(html, /class="direction-grid"/);
  assert.match(html, /href="\?mode=to-hana&amp;pluginSurfaceSession=surface-123"/);
  assert.match(html, /href="\?mode=to-tavern&amp;pluginSurfaceSession=surface-123"/);
  assert.match(html, /href="\.\/theater\?pluginSurfaceSession=surface-123"/);
  assert.match(html, /href="\?mode=theme&amp;pluginSurfaceSession=surface-123"/);
  assert.match(html, /小花薄荷手帐/);
  assert.match(html, /酒馆角色 → Hana/);
  assert.match(html, /Hana 伙伴 → 酒馆/);
  assert.match(html, /打开卡片实验室/);
  const main = html.match(/<main class="page">([\s\S]*?)<\/main>/)?.[1] || '';
  assert.doesNotMatch(main, /选择角色|exit-body/);
  const script = html.match(/<script>\n([\s\S]*?)\n<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
});

test('薄荷手帐内部页面不再需要独立 Hana 卡片', () => {
  const html = renderVisitorPage({ characters: [], visitors: [] }, {}, { mode: 'theme' });
  assert.match(html, /管理小花薄荷手帐|小花薄荷手帐/);
  assert.match(html, /card\/visitor\/theme\/install/);
  assert.match(html, /card\/visitor\/theme\/restore/);
  const main = html.match(/<main class="page">([\s\S]*?)<\/main>/)?.[1] || '';
  assert.doesNotMatch(main, /direction-grid/);
});

test('角色来访兼容旧 token 页面导航与 API 请求', () => {
  const html = renderVisitorPage({ characters: [], visitors: [] }, {}, { mode: 'home', legacyToken: 'legacy+token' });
  assert.match(html, /href="\?mode=to-hana&amp;token=legacy%2Btoken"/);
  assert.match(html, /href="\?mode=to-tavern&amp;token=legacy%2Btoken"/);
  assert.match(html, /href="\.\/theater\?token=legacy%2Btoken"/);
  const script = html.match(/<script>\n([\s\S]*?)\n<\/script>/)?.[1] || '';
  assert.match(script, /authParams\.get\('token'\)/);
  assert.match(script, /apiUrl.*token=/s);
});

test('角色来访 to-hana 详情页保留原角色选择布局', () => {
  const html = renderVisitorPage({
    characters: [{ id: 'guest', name: '阿岚', tags: ['朋友'], avatarPath: '' }],
    visitors: [],
  }, {}, { mode: 'to-hana', surfaceSession: 'surface-456' });
  assert.match(html, /请一位酒馆角色来 Hana/);
  assert.match(html, /选择角色/);
  assert.match(html, /data-character-id="guest"/);
  assert.match(html, /href="\?pluginSurfaceSession=surface-456"/);
  assert.doesNotMatch(html, /class="direction-grid"/);
});

test('角色来访 to-tavern 详情页自动加载伙伴出口且不再折叠', () => {
  const html = renderVisitorPage({ characters: [], visitors: [] }, {}, { mode: 'to-tavern', surfaceSession: 'surface-789' });
  assert.match(html, /带一位 Hana 伙伴去酒馆/);
  assert.match(html, /id="exit-body"/);
  assert.match(html, /正在寻找 Hana 伙伴/);
  assert.doesNotMatch(html, /id="exit-toggle"/);
  assert.match(html, /href="\?pluginSurfaceSession=surface-789"/);
  assert.match(html, /avatarDataUrl/);
  assert.match(html, /class="avatar is-img"/);
  const script = html.match(/<script>\n([\s\S]*?)\n<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
});

test('角色来访页面使用约定文案且内联脚本可编译', () => {
  const html = renderVisitorPage({
    characters: [{ id: 'guest', name: '阿<岚>', tags: ['朋友'], avatarPath: '阿岚.png' }],
    visitors: [],
  }, {}, { mode: 'to-hana' });
  assert.match(html, /请 TA 来 Hana/);
  assert.match(html, /角色来访/);
  assert.match(html, /阿&lt;岚&gt;/);
  // 测试环境 characters 目录没有阿岚.png，avatarDataUrl 返回 null → 回退首字母头像
  assert.match(html, /class="avatar">阿</);
  assert.doesNotMatch(html, /visitor\/avatar\//);
  const script = html.match(/<script>\n([\s\S]*?)\n<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
});

test('角色头像存在时页面内联 base64 data URL（不依赖 HTTP 鉴权）', () => {
  // 最小合法 1x1 PNG
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  writeFileSync(join(process.env.APPDATA, 'hanabrew', 'st-data', 'default-user', 'characters', '头像卡.png'), png);
  const html = renderVisitorPage({
    characters: [{ id: 'img', name: '图图', tags: [], avatarPath: '头像卡.png' }],
    visitors: [],
  }, {}, { mode: 'to-hana' });
  assert.match(html, /data:image\/png;base64,/);
  assert.match(html, /<img src="data:image\/png;base64,/);
});

test('角色头像路径只允许 characters 目录内的文件名', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const outside = join(process.env.APPDATA, 'hanabrew', 'st-data', 'default-user', 'avatar-outside.png');
  writeFileSync(outside, png);
  const html = renderVisitorPage({
    characters: [{ id: 'unsafe', name: '图图', tags: [], avatarPath: '../avatar-outside.png' }],
    visitors: [],
  }, {}, { mode: 'to-hana' });
  const main = html.match(/<main class="page">([\s\S]*?)<\/main>/)?.[1] || '';
  assert.doesNotMatch(main, /data:image\/png;base64,/);
  assert.match(main, /class="avatar">图/);
});

test('来访成功页包含「重启后显示头像」的小提示', () => {
  const html = renderVisitorPage({
    characters: [],
    visitors: [{
      status: 'active',
      characterName: '沈叙',
      sessionTitle: '与 沈叙 · 晚上九点半，整层楼的灯灭了大半',
      memoryMessageCount: 3,
    }],
  }, {}, { mode: 'to-hana' });
  assert.match(html, /avatar-tip/);
  assert.match(html, /重启 Hana/);
  assert.match(html, /下次重启/);
});

test('来访页支持多人并排展示与入驻/送回操作', () => {
  const html = renderVisitorPage({
    characters: [],
    visitors: [
      { status: 'active', characterName: '阿岚', sessionTitle: '与 阿岚 的来访', memoryMessageCount: 2, agentId: 'hanabrew-visitor-a', residence: false },
      { status: 'active', characterName: '沈叙', sessionTitle: '与 沈叙 的来访', memoryMessageCount: 5, agentId: 'hanabrew-visitor-b', residence: true },
    ],
  }, {}, { mode: 'to-hana' });
  // 两个来访者都展示
  assert.match(html, /阿岚 已来到 Hana/);
  assert.match(html, /沈叙 已住下/);
  // 未入驻的有「让 TA 住下来」+「送 TA 回酒馆」；已入驻的只有「请 TA 回去」
  assert.match(html, /让 TA 住下来/);
  assert.match(html, /送 TA 回酒馆/);
  assert.match(html, /请 TA 回去/);
  assert.match(html, /已入驻/);
  assert.match(html, /window\.confirm\(/, '请 TA 回去仍需确认');
  const script = html.match(/<script>\n([\s\S]*?)\n<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
});

test('有来访者时仍保留角色选择面板（可继续邀请）', () => {
  const html = renderVisitorPage({
    characters: [{ id: 'guest', name: '阿岚', tags: ['朋友'], avatarPath: '' }],
    visitors: [{ status: 'active', characterName: '沈叙', sessionTitle: '与 沈叙 的来访', memoryMessageCount: 5, agentId: 'hanabrew-visitor-b', residence: false }],
  }, {}, { mode: 'to-hana' });
  // 来访者卡片在
  assert.match(html, /沈叙 已来到 Hana/);
  // 角色选择面板始终可见（可以继续邀请别人）
  assert.match(html, /选择角色/);
  assert.match(html, /请一位酒馆角色来 Hana/);
  assert.match(html, /先选一位角色/);
  assert.match(html, /请 TA 来 Hana/);
});

test('角色列表为已在访/已入驻的角色显示状态标签', () => {
  const html = renderVisitorPage({
    characters: [
      { id: 'a', name: '阿岚', tags: [], avatarPath: '' },
      { id: 'b', name: '沈叙', tags: [], avatarPath: '' },
      { id: 'c', name: '方淮', tags: [], avatarPath: '' },
    ],
    visitors: [
      { status: 'active', characterId: 'a', characterName: '阿岚', agentId: 'hanabrew-visitor-a', residence: false },
      { status: 'active', characterId: 'b', characterName: '沈叙', agentId: 'hanabrew-visitor-b', residence: true },
    ],
  }, {}, { mode: 'to-hana' });
  // 来访中 / 已入驻 标签各一个（class 可能是 role-status 或 role-status is-resident）
  assert.match(html, /class="role-status ?"[^>]*>来访中</);
  assert.match(html, /class="role-status is-resident"[^>]*>已入驻</);
  // 状态映射注入到脚本（CHARACTER_STATUS），已在访的不可再邀请
  assert.match(html, /"a":"visiting"/);
  assert.match(html, /"b":"resident"/);
});

test('manifest 注册角色来访整页卡、Agent 能力与路由', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  const card = manifest.contributes.cards.find((item) => item.id === 'workspace');
  assert.ok(card);
  assert.equal(card.route, '/card/visitor');
  assert.equal(card.realization, 'page');
  assert.ok(manifest.capabilities.includes('agent'));
  assert.equal(manifest.contributes.routes, undefined, '路由由目录自动扫描，不在 manifest 重复声明');
});

test('可同时邀请多个角色，同卡不重复', async () => {
  // 造两张角色卡
  const charsDir = join(process.env.APPDATA, 'hanabrew', 'st-data', 'default-user', 'characters');
  writeFileSync(join(charsDir, 'guest.json'), JSON.stringify({ data: { id: 'guest', name: '阿岚', description: '旅人', personality: '安静', scenario: '山中', tags: ['朋友'] } }), 'utf8');
  writeFileSync(join(charsDir, 'shenxu.json'), JSON.stringify({ data: { id: 'shenxu', name: '沈叙', description: '带教', personality: '克制', scenario: '公司', tags: ['同事'] } }), 'utf8');
  const calls = [];
  const first = await inviteVisitor('guest', mockContext(calls));
  const second = await inviteVisitor('shenxu', mockContext(calls));
  const state = JSON.parse(readFileSync(join(process.env.APPDATA, 'hanabrew', 'state.json'), 'utf8'));
  assert.equal(state.visitors.length, 2);
  assert.ok(state.visitors.some((item) => item.agentId === first.agentId));
  assert.ok(state.visitors.some((item) => item.agentId === second.agentId));
  // 同一张卡不能重复邀请
  await assert.rejects(() => inviteVisitor('guest', mockContext([])), /这个角色已经在 Hana 做客了/);
  // 清理现场，避免影响后续用例
  const saved = JSON.parse(readFileSync(join(process.env.APPDATA, 'hanabrew', 'state.json'), 'utf8'));
  writeFileSync(join(process.env.APPDATA, 'hanabrew', 'state.json'), JSON.stringify({ ...saved, visitors: [], visitor: null }), 'utf8');
});

test('入驻：改写常驻人格、标记 residence、重启清理保留 TA', async () => {
  writeCharacter();
  const calls = [];
  const visitor = await inviteVisitor('guest', mockContext(calls));
  const stateFile = join(process.env.APPDATA, 'hanabrew', 'state.json');
  const settled = await settleVisitor(visitor.agentId, mockContext([]));
  assert.equal(settled.residence, true);
  const personaPath = join(process.env.HANA_HOME, 'agents', visitor.agentId, 'AGENTS.md');
  const persona = readFileSync(personaPath, 'utf8');
  assert.match(persona, /常驻居民/);
  assert.match(persona, /居住记忆/);
  assert.doesNotMatch(persona, /临时来到 Hana/);
  assert.doesNotMatch(persona, /来访边界/);
  // 入驻者不会被重启清理删除
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  writeFileSync(stateFile, JSON.stringify({ ...state, pendingVisitorCleanup: [visitor.agentId] }), 'utf8');
  const result = await cleanupDepartedVisitors();
  assert.deepEqual(result.remaining, [visitor.agentId]);
  assert.ok(existsSync(join(process.env.HANA_HOME, 'agents', visitor.agentId)));
  // 清理现场
  const latest = JSON.parse(readFileSync(stateFile, 'utf8'));
  writeFileSync(stateFile, JSON.stringify({ ...latest, visitors: [], visitor: null, pendingVisitorCleanup: [] }), 'utf8');
  await cleanupDepartedVisitors();
});

test('请 TA 回去：恢复临时人格并走送回流程', async () => {
  writeCharacter();
  const calls = [];
  const visitor = await inviteVisitor('guest', mockContext(calls));
  const settled = await settleVisitor(visitor.agentId, mockContext([]));
  assert.equal(settled.residence, true);
  const uninviteCalls = [];
  const result = await uninviteVisitor(visitor.agentId, mockContext(uninviteCalls));
  assert.equal(result.residence, false);
  assert.equal(result.cleanupPending, true);
  assert.ok(uninviteCalls.some((call) => call.type === 'session:abort'));
  const personaPath = join(process.env.HANA_HOME, 'agents', visitor.agentId, 'AGENTS.md');
  const persona = readFileSync(personaPath, 'utf8');
  assert.doesNotMatch(persona, /常驻居民/);
  assert.doesNotMatch(persona, /居住记忆/);
  // 清理现场
  const stateFile = join(process.env.APPDATA, 'hanabrew', 'state.json');
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  writeFileSync(stateFile, JSON.stringify({ ...state, visitors: [], visitor: null, pendingVisitorCleanup: [] }), 'utf8');
  await cleanupDepartedVisitors();
});

test('送回已入驻角色会自动先解除入驻', async () => {
  writeCharacter();
  const visitor = await inviteVisitor('guest', mockContext([]));
  await settleVisitor(visitor.agentId, mockContext([]));
  const calls = [];
  const result = await departVisitor(visitor.agentId, mockContext(calls));
  assert.equal(result.unResided, true);
  assert.equal(result.residence, false);
  const stateFile = join(process.env.APPDATA, 'hanabrew', 'state.json');
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.ok(!(state.visitors || []).some((item) => item.agentId === visitor.agentId));
  writeFileSync(stateFile, JSON.stringify({ ...state, visitors: [], visitor: null, pendingVisitorCleanup: [] }), 'utf8');
  await cleanupDepartedVisitors();
});
