import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  endSillyTavernDuet,
  normalizeRuntimeVariables,
  runSillyTavernDuetTurn,
  runSillyTavernTheater,
  runtimeDefaults,
  startSillyTavernDuet,
  summarizeRuntimeVariableChanges,
} from '../backend/st-runtime.js';

test('真实运行时变量读取保留 stat_data，并区分读不到与空对象', () => {
  assert.deepEqual(normalizeRuntimeVariables({ stat_data: { phase: 'start' } }), { phase: 'start' });
  assert.deepEqual(normalizeRuntimeVariables([{ data: { stat_data: { fear: 2 } } }]), { fear: 2 });
  assert.equal(normalizeRuntimeVariables(null), null);
  assert.deepEqual(normalizeRuntimeVariables({ stat_data: {} }), {});
});

test('真实运行时变量变化支持嵌套字段并保留前后值', () => {
  assert.deepEqual(summarizeRuntimeVariableChanges(
    { relation: { phase: 'start', fear: 1 }, unchanged: true },
    { relation: { phase: 'done', fear: 1, trust: 2 }, unchanged: true },
  ), [
    { key: 'relation.phase', before: 'start', after: 'done' },
    { key: 'relation.trust', before: null, after: 2 },
  ]);
});

test('真实运行时使用固定的临时聊天前缀和超时默认值', () => {
  assert.equal(runtimeDefaults.temporaryChatPrefix, 'hanabrew-theater-');
  assert.equal(runtimeDefaults.duetChatPrefix, 'hanabrew-duet-');
  assert.equal(runtimeDefaults.timeoutMs, 120000);
});

test('真实代笔对戏运行时按启动、逐轮、结束分开调用', async () => {
  const calls = [];
  const ctx = {
    duetRuntime: {
      start: async (input) => {
        calls.push(['start', input]);
        return { opening: '开场', initialVariables: { phase: 'start' }, mvuAvailable: true };
      },
      turn: async (input) => {
        calls.push(['turn', input]);
        return { scene: { index: input.sceneIndex, user: input.playerMessage, reply: '角色回复' }, mvuAvailable: true };
      },
      end: async (input) => {
        calls.push(['end', input]);
        return { ended: true, cleanedChats: 1 };
      },
    },
  };
  const started = await startSillyTavernDuet({ duetId: 'duet-test', characterId: 'c1', characterName: '角色甲' }, ctx);
  const turn = await runSillyTavernDuetTurn({ duetId: 'duet-test', playerMessage: '玩家一句', sceneIndex: 1 }, ctx);
  const ended = await endSillyTavernDuet({ duetId: 'duet-test' }, ctx);
  assert.equal(started.isolated, true);
  assert.equal(started.chatFile, 'hanabrew-duet-duet-test');
  assert.equal(turn.scene.reply, '角色回复');
  assert.equal(ended.ended, true);
  assert.deepEqual(calls.map(([kind]) => kind), ['start', 'turn', 'end']);
  assert.equal(calls[1][1].playerMessage, '玩家一句');
});

test('真实测卡会把过程快照传给卡片回流层', async () => {
  const snapshots = [];
  const result = await runSillyTavernTheater({
    characterId: 'a',
    characterName: '甲',
    turns: ['一'],
    onProgress: async (snapshot) => snapshots.push(snapshot),
  }, {
    theaterRuntime: {
      run: async ({ onProgress }) => {
        await onProgress({
          status: 'running',
          activeScene: { index: 1, user: '一' },
          scenes: [],
        });
        return {
          opening: '开场',
          scenes: [{ index: 1, user: '一', reply: '回复' }],
          mvuAvailable: false,
        };
      },
    },
  });
  assert.equal(result.engine, 'sillytavern-runtime');
  assert.equal(snapshots[0].activeScene.user, '一');
  assert.equal(snapshots.at(-1).status, 'done');
  assert.equal(snapshots.at(-1).scenes[0].reply, '回复');
});

test('真实测卡并发会排队，失败后队列仍可继续', async () => {
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const ctx = {
    theaterRuntime: {
      run: async () => {
        calls += 1;
        if (calls === 1) throw new Error('模拟 ST 超时');
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active -= 1;
        return { scenes: [], mvuAvailable: false };
      },
    },
  };
  const first = runSillyTavernTheater({ characterId: 'a', characterName: '甲', turns: ['一'] }, ctx);
  const second = runSillyTavernTheater({ characterId: 'b', characterName: '乙', turns: ['二'] }, ctx);
  await assert.rejects(first, /模拟 ST 超时/);
  const result = await second;
  assert.equal(result.engine, 'sillytavern-runtime');
  assert.equal(maximum, 1);
});
