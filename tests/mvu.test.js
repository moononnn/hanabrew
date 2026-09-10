// 花酿 MVU 变量引擎测试：JSON Patch 执行、宏提取、账本、模糊描述。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyJsonPatch,
  applyMvuUpdate,
  buildMvuSummary,
  extractJsonPatch,
  pointerGet,
  readMvuState,
} from '../backend/mvu.js';
import { execute as executeMvuUpdate, resolveMvuCharacterId } from '../tools/tavern-mvu-update.js';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let root;
let previousAppData;
let previousHanaHome;

test.before(() => {
  previousAppData = process.env.APPDATA;
  previousHanaHome = process.env.HANA_HOME;
  root = join(tmpdir(), `hanabrew-mvu-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  process.env.APPDATA = join(root, 'appdata');
  process.env.HANA_HOME = join(root, 'hana-home');
  mkdirSync(join(process.env.APPDATA, 'hanabrew'), { recursive: true });
});

test.after(() => {
  if (previousAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = previousAppData;
  if (previousHanaHome === undefined) delete process.env.HANA_HOME;
  else process.env.HANA_HOME = previousHanaHome;
  rmSync(root, { recursive: true, force: true });
});

function ctx() {
  return { log: { warn: () => {}, error: () => {}, debug: () => {} } };
}

test('JSON Patch replace 更新嵌套变量', () => {
  const base = { 世界: { 当前时间: '2026/08/27-21:30' }, 关系: { 好感度: 35, 信任度: 25 } };
  const result = applyJsonPatch(base, [
    { op: 'replace', path: '/关系/好感度', value: 37 },
    { op: 'replace', path: '/世界/当前时间', value: '2026/08/28-07:30' },
  ]);
  assert.equal(result.关系.好感度, 37);
  assert.equal(result.世界.当前时间, '2026/08/28-07:30');
  // 原对象不被污染
  assert.equal(base.关系.好感度, 35);
});

test('JSON Patch add 自动补中间对象', () => {
  const result = applyJsonPatch({}, [
    { op: 'add', path: '/关系/亲密度', value: 10 },
  ]);
  assert.equal(result.关系.亲密度, 10);
});

test('JSON Patch remove 删除变量', () => {
  const result = applyJsonPatch({ 世界: { 当前地点: '办公室' } }, [
    { op: 'remove', path: '/世界/当前地点' },
  ]);
  assert.deepEqual(result, { 世界: {} });
});

test('extractJsonPatch 从模型回复提取宏块', () => {
  const text = '“在。早。”\n<UpdateVariable>\n<Analysis>\n- time passed\n</Analysis>\n<JSONPatch>\n[{"op":"replace","path":"/关系/好感度","value":36}]\n</JSONPatch>\n</UpdateVariable>';
  const patches = extractJsonPatch(text);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].op, 'replace');
  assert.equal(patches[0].path, '/关系/好感度');
});

test('extractJsonPatch 容错：尾逗号 + markdown 代码块', () => {
  const text = '```json\n<UpdateVariable>\n<JSONPatch>\n[{"op":"replace","path":"/关系/好感度","value":40},]\n</JSONPatch>\n</UpdateVariable>\n```';
  const patches = extractJsonPatch(text);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].value, 40);
});

test('extractJsonPatch 无宏返回空数组', () => {
  assert.deepEqual(extractJsonPatch('普通回复，没有宏。'), []);
});

test('applyMvuUpdate 记账并返回前后值', () => {
  const result = applyMvuUpdate('char-a', [
    { op: 'replace', path: '/关系/好感度', value: 38 },
  ], ctx());
  assert.equal(result.applied, 1);
  assert.equal(result.before.关系?.好感度 ?? 0, 0);
  assert.equal(result.after.关系.好感度, 38);
  // 账本落盘
  const state = JSON.parse(readFileSync(join(process.env.APPDATA, 'hanabrew', 'mvu-state.json'), 'utf8'));
  assert.equal(state['char-a'].vars.关系.好感度, 38);
});

test('readMvuState 读回账本，无则 null', () => {
  const vars = readMvuState('char-a', ctx());
  assert.equal(vars.关系.好感度, 38);
  assert.equal(readMvuState('不存在', ctx()), null);
});

test('applyMvuUpdate 数值变更生成模糊描述，不包含数字', () => {
  const result = applyMvuUpdate('char-b', [
    { op: 'replace', path: '/关系/好感度', value: 40 },
  ], ctx());
  assert.ok(result.summary);
  assert.match(result.summary, /亲近|疏远/);
  assert.doesNotMatch(result.summary, /\d/);
});

test('多来访者的 MVU 工具按 agent/session 定位，身份缺失时拒绝串账', () => {
  const state = {
    activeCharacterId: 'light-chat-character',
    visitors: [
      { status: 'active', characterId: 'character-a', agentId: 'visitor-agent-a', sessionId: 'session-a', sessionPath: 'path-a' },
      { status: 'active', characterId: 'character-b', agentId: 'visitor-agent-b', sessionId: 'session-b', sessionPath: 'path-b' },
    ],
  };
  assert.equal(resolveMvuCharacterId(state, { agentId: 'visitor-agent-b' }), 'character-b');
  assert.equal(resolveMvuCharacterId(state, { sessionId: 'session-a' }), 'character-a');
  assert.equal(resolveMvuCharacterId(state, {}), null, '不能把多来访者误记到轻聊当前角色');
  assert.equal(resolveMvuCharacterId({ ...state, visitors: [state.visitors[0]] }, {}), 'character-a');
});

test('tavern-mvu-update 实际记账到调用方对应角色', async () => {
  writeFileSync(join(process.env.APPDATA, 'hanabrew', 'state.json'), JSON.stringify({
    version: 4,
    activeCharacterId: 'light-chat-character',
    visitors: [
      { status: 'active', characterId: 'character-a', agentId: 'visitor-agent-a', sessionId: 'session-a' },
      { status: 'active', characterId: 'character-b', agentId: 'visitor-agent-b', sessionId: 'session-b' },
    ],
  }), 'utf8');
  const result = await executeMvuUpdate({ patches: [{ op: 'add', path: '/关系/信任度', value: 12 }] }, { ...ctx(), agentId: 'visitor-agent-b' });
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.ok, true);
  const ledger = JSON.parse(readFileSync(join(process.env.APPDATA, 'hanabrew', 'mvu-state.json'), 'utf8'));
  assert.equal(ledger['character-b'].vars.关系.信任度, 12);
  assert.equal(ledger['light-chat-character'], undefined);
});

test('buildMvuSummary 无变化返回 null', () => {
  const summary = buildMvuSummary({ 关系: { 好感度: 30 } }, { 关系: { 好感度: 30 } });
  assert.equal(summary, null);
});

test('pointerGet 支持 RFC 6901 转义', () => {
  const target = { a: { 'b/c': 1, 'd~e': 2 } };
  assert.equal(pointerGet(target, '/a/b~1c'), 1);
  assert.equal(pointerGet(target, '/a/d~0e'), 2);
});
