import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortChatsByRecent, withCharacterChatLock, seedOpeningForCharacter, tavernChatAppend } from '../backend/chats.js';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let root;
let previousAppData;

test.before(() => {
  previousAppData = process.env.APPDATA;
  root = join(tmpdir(), `hanabrew-chats-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  process.env.APPDATA = join(root, 'appdata');
  mkdirSync(join(process.env.APPDATA, 'hanabrew', 'st-data', 'default-user', 'chats'), { recursive: true });
});

test.after(() => {
  if (previousAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = previousAppData;
  rmSync(root, { recursive: true, force: true });
});

test('seedOpeningForCharacter 取角色开场白并清洗宏与占位标签', () => {
  const opening = seedOpeningForCharacter({
    first_mes: '你好。<StatusPlaceHolderImpl/>\n<UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>',
  });
  assert.equal(opening, '你好。');
});

test('seedOpeningForCharacter 无开场白返回空串', () => {
  assert.equal(seedOpeningForCharacter({ name: '阿岚' }), '');
  assert.equal(seedOpeningForCharacter(null), '');
});

test('按角色聊天锁串行化同一角色的并发请求', async () => {
  const order = [];
  let releaseFirst;
  const first = withCharacterChatLock('alice', async () => {
    order.push('first:start');
    await new Promise((resolve) => { releaseFirst = resolve; });
    order.push('first:end');
  });
  await new Promise((resolve) => setImmediate(resolve));

  const second = withCharacterChatLock('alice', async () => {
    order.push('second');
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['first:start']);

  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first:start', 'first:end', 'second']);
});

test('按最近更新时间选择角色自己的聊天', () => {
  const chats = [
    { id: 'old', characterId: 'alice', updatedAt: '2026-08-26T10:00:00Z' },
    { id: 'new', characterId: 'alice', updatedAt: '2026-08-26T11:00:00Z' },
    { id: 'created-only', characterId: 'alice', createdAt: '2026-08-26T12:00:00Z' },
  ];
  assert.deepEqual(sortChatsByRecent(chats).map((chat) => chat.id), ['created-only', 'new', 'old']);
});

test('tavernChatAppend 续接酒馆聊天文件并以酒馆格式追加对话', async () => {
  const chatsDir = join(process.env.APPDATA, 'hanabrew', 'st-data', 'default-user', 'chats');
  const charDir = join(chatsDir, '测试角色');
  mkdirSync(charDir, { recursive: true });
  const existingFile = join(charDir, '已有聊天.jsonl');
  writeFileSync(existingFile, [
    JSON.stringify({ chat_metadata: {}, user_name: '林小月', character_name: '测试角色' }),
    JSON.stringify({ name: '测试角色', is_user: false, send_date: new Date().toISOString(), mes: '开场白。', extra: {} }),
  ].join('\n') + '\n', 'utf8');

  // 预置 settings.json 让 tavernUserName 读到 林小月 + callLLM 读到 custom 配置
  writeFileSync(
    join(process.env.APPDATA, 'hanabrew', 'st-data', 'default-user', 'settings.json'),
    JSON.stringify({
      username: '林小月',
      power_user: {},
      oai_settings: { custom_url: 'https://api.minimaxi.com/v1', custom_model: 'MiniMax-M3' },
    }),
    'utf8',
  );
  writeFileSync(
    join(process.env.APPDATA, 'hanabrew', 'st-data', 'default-user', 'secrets.json'),
    JSON.stringify({ api_key_custom: [{ id: 't', value: 'sk-test', label: 'test', active: true }] }),
    'utf8',
  );

  // mock getCharacter：放一个同名角色文件
  const charactersDir = join(process.env.APPDATA, 'hanabrew', 'st-data', 'default-user', 'characters');
  mkdirSync(charactersDir, { recursive: true });
  writeFileSync(
    join(charactersDir, '测试角色.png'),
    JSON.stringify({ name: '测试角色', prompt: '你是测试角色。', first_mes: '你好。' }),
    'utf8',
  );

  // mock fetch（callLLM 用它）
  const origFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '测试回复。' } }], usage: {} }),
  });

  try {
    const result = await tavernChatAppend('测试角色', '你好呀', { log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } });
    assert.ok(result.chatFile.endsWith('已有聊天.jsonl'));
    assert.equal(result.reply, '测试回复。');
    const raw = readFileSync(existingFile, 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 4); // metadata + 开场白 + 用户 + 回复
    const userLine = JSON.parse(lines[2]);
    const replyLine = JSON.parse(lines[3]);
    assert.equal(userLine.name, '林小月');
    assert.equal(userLine.is_user, true);
    assert.equal(userLine.mes, '你好呀');
    assert.equal(replyLine.name, '测试角色');
    assert.equal(replyLine.is_user, false);
  } finally {
    global.fetch = origFetch;
  }
});
