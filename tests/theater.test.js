import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildTheaterMessages,
  endTheaterDuet,
  normalizeDuetPlayerMessage,
  normalizeTheaterTurns,
  runPromptPreview,
  runTheater,
  runTheaterDuetTurn,
  startTheaterDuet,
  summarizeVariableChanges,
} from '../backend/theater.js';
import {
  claimTheaterProgress,
  createTheaterProgress,
  discardTheaterProgress,
  getTheaterProgress,
  getTheaterProgressForSession,
  resolveDuetPace,
  theaterProgressDefaults,
  updateTheaterProgress,
} from '../backend/theater-progress.js';
import registerTheaterRoutes, { renderTheater } from '../routes/theater.js';
import * as theaterTool from '../tools/tavern-theater-run.js';
import * as duetStartTool from '../tools/tavern-duet-start.js';
import * as duetTurnTool from '../tools/tavern-duet-turn.js';
import * as duetEndTool from '../tools/tavern-duet-end.js';
import * as openTheaterTool from '../tools/tavern-open-theater.js';

let root;
let previousAppData;

test.before(() => {
  previousAppData = process.env.APPDATA;
  root = join(tmpdir(), `hanabrew-theater-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  process.env.APPDATA = join(root, 'appdata');
  const base = join(process.env.APPDATA, 'hanabrew', 'st-data', 'default-user');
  mkdirSync(join(base, 'characters'), { recursive: true });
  mkdirSync(join(base, 'chats'), { recursive: true });
  writeFileSync(join(base, 'characters', '小剧场测试卡.json'), JSON.stringify({
    name: '小剧场测试卡',
    prompt: '你是一个保持克制、会回应场景的测试角色。',
    scenario: '你正在一间安静的房间里。',
    first_mes: '你好，欢迎来到这里。',
  }), 'utf8');
  writeFileSync(join(base, 'settings.json'), JSON.stringify({
    oai_settings: { custom_url: 'https://example.test/v1', custom_model: 'test-model' },
  }), 'utf8');
  writeFileSync(join(base, 'secrets.json'), JSON.stringify({
    api_key_custom: [{ value: 'test-key', active: true }],
  }), 'utf8');
});

test.after(() => {
  if (previousAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = previousAppData;
  rmSync(root, { recursive: true, force: true });
});

test('小剧场规范化测试台词并限制最多 12 幕', () => {
  assert.deepEqual(normalizeTheaterTurns(['  第一幕 ', '', null, '第二幕 ']), ['第一幕', '第二幕']);
  assert.equal(normalizeTheaterTurns(Array.from({ length: 20 }, (_, i) => String(i))).length, 12);
  assert.equal(normalizeDuetPlayerMessage('  玩家消息  '), '玩家消息');
  assert.equal(normalizeDuetPlayerMessage('x'.repeat(7000)).length, 6000);
});

test('代笔对戏节奏会区分自动推进和暂停边界', () => {
  const slow = resolveDuetPace('慢慢推进');
  assert.equal(slow.id, 'slow');
  assert.equal(slow.autoContinue, true);
  assert.equal(slow.maxAutoRounds, 4);
  assert.match(slow.pausePolicy, /关键剧情/);
  assert.equal(resolveDuetPace('free').label, '自由发展');
  assert.equal(resolveDuetPace('保持克制').autoContinue, false);

  const progress = createTheaterProgress({
    sessionId: 'sess-pace',
    mode: 'duet',
    testType: 'duet',
    detail: '慢慢推进',
  });
  assert.equal(progress.pace, 'slow');
  assert.equal(progress.paceLabel, '慢慢推进');
  assert.equal(progress.autoContinue, true);
  assert.equal(progress.autoRoundsSinceCheckpoint, 0);
  assert.equal(progress.needsUserCheckpoint, false);
  discardTheaterProgress(progress.runId);
});

test('小剧场构造角色上下文并带入当前变量', () => {
  const messages = buildTheaterMessages(
    { prompt: '人设', scenario: '场景' },
    [{ role: 'assistant', content: '开场' }],
    '测试输入',
    { 好感度: 10 },
  );
  assert.equal(messages.at(-1).content, '测试输入');
  assert.match(messages.find((item) => item.content.includes('MVU 变量')).content, /好感度: 10/);
  const nested = buildTheaterMessages({ prompt: '人设' }, [], '测试输入', { 关系: { 好感度: 37 } });
  assert.match(nested.find((item) => item.content.includes('MVU 变量')).content, /关系\.好感度: 37/);
  assert.doesNotMatch(nested.find((item) => item.content.includes('MVU 变量')).content, /\[object Object\]/);
});

test('小剧场运行多幕并只在内存中推进 MVU', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: calls++ === 0
        ? '第一幕回复。<UpdateVariable><JSONPatch>[{"op":"replace","path":"/好感度","value":12}]</JSONPatch></UpdateVariable>'
        : '第二幕回复。' } }],
      usage: { total_tokens: 3 },
    }),
  });
  try {
    const result = await runPromptPreview({ characterId: '小剧场测试卡', objective: '确认好感度是否会变化', turns: ['第一句', '第二句'] });
    assert.equal(result.sceneCount, 2);
    assert.equal(result.objective, '确认好感度是否会变化');
    assert.deepEqual(result.initialVariables, {});
    assert.equal(result.scenes[0].reply, '第一幕回复。');
    assert.deepEqual(result.scenes[0].variableChanges, [{ key: '好感度', before: null, after: 12 }]);
    assert.equal(result.finalVariables.好感度, 12);
    assert.equal(existsSync(join(process.env.APPDATA, 'hanabrew', 'mvu-state.json')), false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('真实小剧场默认把角色交给 ST 运行时，而不是后端提示词模拟', async () => {
  const result = await runTheater({ characterId: '小剧场测试卡', objective: '验证真实运行时', turns: ['第一句'] }, {
    theaterRuntime: {
      run: async ({ characterName, turns }) => ({
        character: { name: characterName },
        opening: '真实开场',
        initialVariables: { phase: 'start' },
        finalVariables: { phase: 'done' },
        initialVariableSource: 'Mvu.getMvuData',
        finalVariableSource: 'Mvu.getMvuData',
        mvuAvailable: true,
        isolated: true,
        scenes: [{ index: 1, user: turns[0], reply: '真实回复。', variableChanges: [{ key: 'phase', before: 'start', after: 'done' }] }],
      }),
    },
  });
  assert.equal(result.engine, 'sillytavern-runtime');
  assert.equal(result.scenes[0].reply, '真实回复。');
  assert.deepEqual(result.initialVariables, { phase: 'start' });
  assert.equal(result.formalChatVariables, null);
  assert.equal(result.variableScope.formalChat, '本次未读取，也未修改正式聊天变量；formalChatVariables 固定为 null');
});

test('小剧场工具以卡片为入口，真实测卡工具声明只读', () => {
  assert.equal(theaterTool.sessionPermission.readOnly, true);
  assert.match(theaterTool.description, /小剧场卡片/);
  assert.match(theaterTool.description, /先打开小剧场卡片/);
  assert.match(theaterTool.description, /同步显示/);
  assert.match(theaterTool.description, /代笔对戏/);
  assert.ok(theaterTool.parameters.properties.characterName);
  assert.equal(duetStartTool.sessionPermission.readOnly, true);
  assert.equal(duetTurnTool.sessionPermission.readOnly, true);
  assert.equal(duetEndTool.sessionPermission.readOnly, true);
  assert.match(duetStartTool.description, /原样发给真实角色/);
  assert.match(duetStartTool.description, /连续调用 tavern-duet-turn/);
  assert.match(duetTurnTool.description, /只生成一轮/);
  assert.match(duetTurnTool.description, /同一助手回合/);
  assert.match(duetEndTool.description, /明确说结束/);
  assert.match(openTheaterTool.description, /代笔对戏/);
  assert.match(openTheaterTool.description, /帮我测一下这张角色卡/);
  assert.match(theaterTool.description, /看看这张卡的变量有没有生效/);
});

test('同一会话的多个小剧场请求按提交顺序认领', () => {
  const first = createTheaterProgress({ sessionId: 'sess-fifo', characterId: 'c1' });
  const second = createTheaterProgress({ sessionId: 'sess-fifo', characterId: 'c1' });
  const claimed = claimTheaterProgress({ sessionId: 'sess-fifo', characterId: 'c1' });
  assert.equal(claimed.runId, first.runId);
  discardTheaterProgress(first.runId);
  discardTheaterProgress(second.runId);
});

test('固定测卡认领不会吞掉代笔对戏请求', () => {
  const duet = createTheaterProgress({ sessionId: 'sess-mode-filter', characterId: 'c1', testType: 'duet', mode: 'duet' });
  assert.equal(claimTheaterProgress({ sessionId: 'sess-mode-filter', mode: 'scripted' }), null);
  const claimed = claimTheaterProgress({ sessionId: 'sess-mode-filter', mode: 'duet' });
  assert.equal(claimed.runId, duet.runId);
  discardTheaterProgress(duet.runId);
});

test('代笔对戏过程使用更长保留期，并跳过已经启动的认领记录', () => {
  assert.ok(theaterProgressDefaults.duetRunTtlMs > theaterProgressDefaults.runTtlMs);
  const started = createTheaterProgress({ sessionId: 'sess-started-duet', mode: 'duet', characterId: 'c1' });
  updateTheaterProgress(started.runId, { chatFile: 'hanabrew-duet-started' });
  assert.equal(claimTheaterProgress({ sessionId: 'sess-started-duet', mode: 'duet' }), null);
  discardTheaterProgress(started.runId);
});

test('小剧场过程状态按发起会话认领，并在结束后保留逐幕记录', () => {
  const created = createTheaterProgress({
    sessionId: 'sess-progress',
    characterId: '小剧场测试卡',
    characterName: '小剧场测试卡',
  });
  assert.equal(created.status, 'waiting');
  const claimed = theaterTool.execute({
    characterName: '小剧场测试卡',
    turns: ['第一句'],
  }, {
    sessionId: 'sess-progress',
    theaterRuntime: {
      run: async ({ onProgress }) => {
        await onProgress({
          opening: '真实开场',
          initialVariables: { phase: 'start' },
          initialVariableSource: 'Mvu.getMvuData',
          mvuAvailable: true,
          activeScene: { index: 1, user: '第一句' },
          scenes: [],
        });
        return {
          opening: '真实开场',
          initialVariables: { phase: 'start' },
          finalVariables: { phase: 'done' },
          initialVariableSource: 'Mvu.getMvuData',
          finalVariableSource: 'Mvu.getMvuData',
          mvuAvailable: true,
          isolated: true,
          scenes: [{ index: 1, user: '第一句', reply: '真实回复。', variableChanges: [] }],
        };
      },
    },
  });
  return claimed.then(() => {
    const finished = getTheaterProgress(created.runId);
    assert.equal(finished.status, 'done');
    assert.equal(finished.scenes[0].reply, '真实回复。');
    assert.deepEqual(finished.initialVariables, { phase: 'start' });
    discardTheaterProgress(created.runId);
  });
});

test('代笔对戏按同一会话逐轮推进，结束时清理状态', async () => {
  const created = createTheaterProgress({
    sessionId: 'sess-duet-flow',
    characterId: '小剧场测试卡',
    characterName: '小剧场测试卡',
    testType: 'duet',
    mode: 'duet',
  });
  assert.equal(created.status, 'waiting_for_direction');
  const calls = [];
  const ctx = {
    sessionId: 'sess-duet-flow',
    duetRuntime: {
      start: async () => ({
        opening: '真实开场',
        initialVariables: { phase: 'start' },
        initialVariableSource: 'Mvu.getMvuData',
        mvuAvailable: true,
        yueAssistantLoaded: true,
        chatFile: 'hanabrew-duet-test',
        isolated: true,
      }),
      turn: async ({ playerMessage, sceneIndex }) => {
        calls.push(playerMessage);
        return {
          mvuAvailable: true,
          yueAssistantLoaded: true,
          finalVariables: { phase: `turn-${sceneIndex}` },
          finalVariableSource: 'Mvu.getMvuData',
          isolated: true,
          scene: {
            index: sceneIndex,
            user: playerMessage,
            reply: `角色回应：${playerMessage}`,
            variableSource: 'Mvu.getMvuData',
            variablesBefore: { phase: sceneIndex === 1 ? 'start' : 'turn-1' },
            variablesAfter: { phase: `turn-${sceneIndex}` },
            variableChanges: [{ key: 'phase', before: sceneIndex === 1 ? 'start' : 'turn-1', after: `turn-${sceneIndex}` }],
          },
        };
      },
      end: async () => ({ ended: true, cleanedChats: 1 }),
    },
  };
  const started = await duetStartTool.execute({
    characterName: '小剧场测试卡',
    playerMessage: '我轻声问他愿不愿意继续聊下去。',
  }, ctx);
  const first = started.details.theater;
  assert.equal(first.mode, 'duet');
  assert.equal(first.autoContinue, true);
  assert.equal(first.interaction.autoContinue, true);
  assert.equal(first.interaction.status, 'waiting_for_direction');
  assert.equal(first.scene.reply, '角色回应：我轻声问他愿不愿意继续聊下去。');
  assert.equal(first.theaterSessionId, created.runId);
  assert.deepEqual(calls, ['我轻声问他愿不愿意继续聊下去。']);

  const second = await duetTurnTool.execute({
    theaterSessionId: created.runId,
    playerMessage: '我把话题转到窗外的雨声。',
  }, ctx);
  assert.equal(second.details.theater.scene.index, 2);
  assert.equal(getTheaterProgress(created.runId).scenes.length, 2);
  assert.equal(getTheaterProgressForSession(created.runId, { sessionId: 'other-session' }), null);

  const ended = await duetEndTool.execute({ theaterSessionId: created.runId }, ctx);
  assert.equal(ended.details.theater.status, 'ended');
  assert.equal(getTheaterProgress(created.runId).status, 'ended');
  discardTheaterProgress(created.runId);
});

test('代笔对戏达到自动推进安全上限后必须由新方向解锁', async () => {
  const created = createTheaterProgress({
    sessionId: 'sess-duet-checkpoint',
    characterId: '小剧场测试卡',
    characterName: '小剧场测试卡',
    testType: 'duet',
    mode: 'duet',
    detail: '慢慢推进',
  });
  const ctx = {
    sessionId: 'sess-duet-checkpoint',
    duetRuntime: {
      start: async () => ({ opening: '开场', initialVariables: {}, mvuAvailable: true, chatFile: 'duet-checkpoint' }),
      turn: async ({ playerMessage, sceneIndex }) => ({
        mvuAvailable: true,
        scene: { index: sceneIndex, user: playerMessage, reply: `回复${sceneIndex}`, variablesBefore: {}, variablesAfter: {}, variableChanges: [] },
        finalVariables: {},
      }),
      end: async () => ({ ended: true }),
    },
  };
  await startTheaterDuet({ progressId: created.runId, characterId: '小剧场测试卡' }, ctx);
  let last;
  for (let index = 0; index < 5; index += 1) {
    last = await runTheaterDuetTurn({
      progressId: created.runId,
      playerMessage: `自动续接${index}`,
      checkpoint: index === 0,
    }, ctx);
  }
  assert.equal(last.needsUserCheckpoint, true);
  assert.equal(last.autoContinue, false);
  await assert.rejects(
    runTheaterDuetTurn({ progressId: created.runId, playerMessage: '继续跑', checkpoint: false }, ctx),
    /安全上限/,
  );
  const resumed = await runTheaterDuetTurn({ progressId: created.runId, playerMessage: '我给出新的方向', checkpoint: true }, ctx);
  assert.equal(resumed.needsUserCheckpoint, false);
  assert.equal(resumed.autoContinue, true);
  await endTheaterDuet({ progressId: created.runId }, ctx);
  discardTheaterProgress(created.runId);
});

test('保持克制每轮结束后必须等新的 checkpoint 方向', async () => {
  const created = createTheaterProgress({
    sessionId: 'sess-duet-restrained',
    characterId: '小剧场测试卡',
    characterName: '小剧场测试卡',
    testType: 'duet',
    mode: 'duet',
    detail: '保持克制',
  });
  const ctx = {
    sessionId: 'sess-duet-restrained',
    duetRuntime: {
      start: async () => ({ opening: '开场', initialVariables: {}, mvuAvailable: true, chatFile: 'duet-restrained' }),
      turn: async ({ playerMessage, sceneIndex }) => ({
        mvuAvailable: true,
        scene: { index: sceneIndex, user: playerMessage, reply: '回复', variablesBefore: {}, variablesAfter: {}, variableChanges: [] },
        finalVariables: {},
      }),
      end: async () => ({ ended: true }),
    },
  };
  await startTheaterDuet({ progressId: created.runId, characterId: '小剧场测试卡' }, ctx);
  const first = await runTheaterDuetTurn({ progressId: created.runId, playerMessage: '第一句', checkpoint: true }, ctx);
  assert.equal(first.autoContinue, false);
  assert.equal(first.needsUserCheckpoint, true);
  await assert.rejects(
    runTheaterDuetTurn({ progressId: created.runId, playerMessage: '未经允许的续接' }, ctx),
    /安全上限/,
  );
  const resumed = await runTheaterDuetTurn({ progressId: created.runId, playerMessage: '新的方向', checkpoint: true }, ctx);
  assert.equal(resumed.needsUserCheckpoint, true);
  await endTheaterDuet({ progressId: created.runId }, ctx);
  discardTheaterProgress(created.runId);
});

test('代笔对戏状态机拒绝跨会话和并发推进', async () => {
  const created = createTheaterProgress({
    sessionId: 'sess-duet-state',
    characterId: '小剧场测试卡',
    characterName: '小剧场测试卡',
    testType: 'duet',
    mode: 'duet',
  });
  const runtime = {
    start: async () => ({ opening: '开场', initialVariables: {}, mvuAvailable: true, chatFile: 'duet-state' }),
    turn: async () => new Promise((resolve) => setTimeout(() => resolve({
      mvuAvailable: true,
      scene: { index: 1, user: '第一句', reply: '回复', variablesBefore: {}, variablesAfter: {}, variableChanges: [] },
      finalVariables: {},
    }), 20)),
  };
  const ctx = { sessionId: 'sess-duet-state', duetRuntime: runtime };
  await startTheaterDuet({ progressId: created.runId, characterId: '小剧场测试卡' }, ctx);
  await assert.rejects(
    runTheaterDuetTurn({ progressId: created.runId, playerMessage: '越权' }, { sessionId: 'other', duetRuntime: runtime }),
    /无权继续/,
  );
  const first = runTheaterDuetTurn({ progressId: created.runId, playerMessage: '第一句' }, ctx);
  await assert.rejects(
    runTheaterDuetTurn({ progressId: created.runId, playerMessage: '第二句' }, ctx),
    /正在回复/,
  );
  await first;
  await endTheaterDuet({ progressId: created.runId }, { ...ctx, duetRuntime: { end: async () => ({}) } });
  discardTheaterProgress(created.runId);
});

test('卡片选中的角色名称会传给真实测卡工具', async () => {
  let captured;
  const result = await theaterTool.execute({ characterName: '小剧场测试卡', turns: ['第一句'] }, {
    theaterRuntime: {
      run: async (input) => {
        captured = input;
        return {
          opening: '真实开场',
          initialVariables: null,
          finalVariables: null,
          mvuAvailable: false,
          yueAssistantLoaded: true,
          isolated: true,
          scenes: [{ index: 1, user: input.turns[0], reply: '真实回复。' }],
        };
      },
    },
  });
  assert.equal(captured.characterId, '小剧场测试卡');
  assert.equal(captured.characterName, '小剧场测试卡');
  assert.equal(result.details.theater.character.name, '小剧场测试卡');
});

test('打开小剧场卡片会绑定调用它的会话', async () => {
  const result = await openTheaterTool.execute({}, { sessionId: 'sess-1', sessionPath: 'sessions/sess-1.jsonl' });
  const card = result.details.card;
  assert.equal(card.sessionId, 'sess-1');
  assert.equal(card.sessionPath, 'sessions/sess-1.jsonl');
  assert.match(card.route, /sessionId=sess-1/);
  assert.match(card.route, /sessionPath=sessions%2Fsess-1\.jsonl/);
});

test('小剧场页面注册说明页与试演 API，内联脚本可编译', () => {
  const registered = [];
  const app = {
    get(path) { registered.push(['GET', path]); },
    post(path) { registered.push(['POST', path]); },
  };
  registerTheaterRoutes(app, {});
  assert.deepEqual(registered, [['GET', '/card/theater'], ['GET', '/card/theater/progress'], ['POST', '/card/theater/handoff'], ['POST', '/card/theater/control']]);
  const html = renderTheater({ characters: [{ id: 'c1', name: '角色甲' }], activeCharacterId: 'c1' });
  assert.match(html, /卡片实验室/);
  assert.match(html, /角色卡体检/);
  assert.match(html, /帮我测一下这张角色卡/);
  assert.match(html, /透明的测试聊天/);
  assert.doesNotMatch(html, /<textarea|<select|开始试演/);
  assert.match(html, /发给小花开始测试/);
  assert.match(html, /代笔对戏/);
  assert.match(html, /tavern-duet-start/);
  assert.match(html, /chat-end/);
  assert.match(html, /结束这场对戏/);
  assert.match(html, /结论回到当前对话正文/);
  assert.match(html, /实时测卡/);
  assert.match(html, /body\[data-mode="chat"\] #chat-screen/);
  assert.match(html, /普通回合会自动继续/);
  assert.match(html, /handoff'\) && canHandoff/);
  assert.match(html, /data-card-sizing="viewport"/);
  assert.match(html, /max-height:none/);
  assert.match(html, /card\/theater\/handoff/);
  assert.match(html, /card\/theater\/progress/);
  assert.match(html, /card\/theater\/control/);
  assert.match(html, /setInterval\(pollProgress, 650\)/);
  assert.match(html, /X-Hana-Plugin-Surface-Session/);
  assert.match(html, /sessionId: query\.get\('sessionId'\)/);
  assert.match(html, /sessionPath: query\.get\('sessionPath'\)/);
  assert.match(html, /characterName: character\.name/);
  assert.match(html, /AbortSignal\.timeout\(10000\)/);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));

  const guideHtml = renderTheater({ characters: [{ id: 'c1', name: '角色甲' }], activeCharacterId: 'c1', canHandoff: false });
  assert.match(guideHtml, /这是角色卡体检的说明入口/);
  assert.match(guideHtml, /请在对话里说「帮我测卡」/);
});

test('小剧场交接先创建过程记录，并把同一会话交给主对话', async () => {
  let handoff;
  let sent;
  const app = {
    get() {},
    post(path, handler) {
      if (path === '/card/theater/handoff') handoff = handler;
    },
  };
  registerTheaterRoutes(app, {
    bus: {
      request: async (_topic, payload) => {
        sent = payload;
        return { accepted: true };
      },
    },
  });
  const response = await handoff({
    req: {
      json: async () => ({
        request: '开始测卡',
        sessionId: 'sess-handoff',
        characterId: 'c1',
        characterName: '角色甲',
      }),
      query: () => '',
    },
    get: () => ({}),
    json: (value, status) => ({ value, status }),
  });
  assert.equal(response.value.ok, true);
  assert.equal(sent.sessionId, 'sess-handoff');
  assert.equal(sent.text, '开始测卡');
  assert.equal(getTheaterProgress(response.value.runId).status, 'waiting');
  discardTheaterProgress(response.value.runId);
});

test('代笔对戏卡片结束端点按会话绑定清理', async () => {
  const created = createTheaterProgress({
    sessionId: 'sess-control',
    characterId: '小剧场测试卡',
    characterName: '小剧场测试卡',
    testType: 'duet',
    mode: 'duet',
  });
  const handlers = {};
  const app = {
    get(path, handler) { handlers[`GET ${path}`] = handler; },
    post(path, handler) { handlers[`POST ${path}`] = handler; },
  };
  let ended = 0;
  registerTheaterRoutes(app, {
    duetRuntime: { end: async () => { ended += 1; return { ended: true, cleanedChats: 1 }; } },
  });
  const wrongProgress = await handlers['GET /card/theater/progress']({
    req: { query: (name) => name === 'runId' ? created.runId : 'other' },
    get: () => ({}),
    header: () => {},
    json: (value, status) => ({ value, status }),
  });
  assert.equal(wrongProgress.status, 404);
  const rightProgress = await handlers['GET /card/theater/progress']({
    req: { query: (name) => name === 'runId' ? created.runId : 'sess-control' },
    get: () => ({}),
    header: () => {},
    json: (value, status) => ({ value, status }),
  });
  assert.equal(rightProgress.value.runId, created.runId);
  const wrong = await handlers['POST /card/theater/control']({
    req: { json: async () => ({ runId: created.runId, action: 'end', sessionId: 'other' }), query: () => '' },
    get: () => ({}),
    json: (value, status) => ({ value, status }),
  });
  assert.equal(wrong.status, 404);
  assert.equal(ended, 0);
  const right = await handlers['POST /card/theater/control']({
    req: { json: async () => ({ runId: created.runId, action: 'end', sessionId: 'sess-control' }), query: () => '' },
    get: () => ({}),
    json: (value, status) => ({ value, status }),
  });
  assert.equal(right.value.ok, true);
  assert.equal(right.value.progress.status, 'ended');
  assert.equal(ended, 1);
  discardTheaterProgress(created.runId);
});

test('小剧场变量变化摘要只返回有变化的键', () => {
  assert.deepEqual(summarizeVariableChanges({ a: 1, b: 2 }, { a: 1, b: 3, c: 4 }), [
    { key: 'b', before: 2, after: 3 },
    { key: 'c', before: null, after: 4 },
  ]);
});
