// 小剧场：默认走真实 SillyTavern 前端运行时；旧的提示词模拟链路仅保留为显式预检。
import { getCharacter } from './characters.js';
import { callLLM } from './llm.js';
import { cleanTavernText } from './clean-text.js';
import { readMvuState, formatMvuStateText, applyJsonPatch, extractJsonPatch } from './mvu.js';
import {
  endSillyTavernDuet,
  runSillyTavernDuetTurn,
  runSillyTavernTheater,
  startSillyTavernDuet,
} from './st-runtime.js';
import {
  completeTheaterProgress,
  failTheaterProgress,
  getTheaterProgressForSession,
  updateTheaterProgress,
} from './theater-progress.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}

export function normalizeTheaterTurns(turns) {
  if (!Array.isArray(turns)) return [];
  return turns.map((turn) => String(turn ?? '').trim()).filter(Boolean).slice(0, 12);
}

export function normalizeDuetPlayerMessage(message) {
  return String(message ?? '').trim().slice(0, 6000);
}

function requireDuetProgress(progressId, ctx, characterId = '') {
  const id = String(progressId || '').trim();
  const progress = getTheaterProgressForSession(id, ctx);
  if (!progress) throw new Error('找不到这场代笔对戏，可能已结束或当前对话无权继续。');
  if (progress.mode !== 'duet' && progress.testType !== 'duet') {
    throw new Error('这条小剧场记录不是代笔对戏，不能用对戏工具继续。');
  }
  if (characterId && progress.characterId && progress.characterId !== String(characterId)) {
    throw new Error('代笔对戏的角色卡与小剧场选中的角色不一致。');
  }
  return progress;
}

function duetWarning(mvuAvailable) {
  return mvuAvailable
    ? []
    : ['本次真实 ST 页面没有发现 Mvu API；角色回复确实经过 Generate()，但变量不可用，不能据此判断 MVU 变量逻辑。'];
}

function duetVariableScope() {
  return {
    initial: '真实 ST 代笔对戏临时聊天创建后读取的变量',
    final: '真实 ST 代笔对戏临时聊天最近一轮后读取的变量',
    formalChat: '本次未读取，也未修改正式聊天变量；formalChatVariables 固定为 null',
  };
}

function duetPaceInfo(progress = {}) {
  const configuredAutoContinue = progress.autoContinue !== false;
  const autoRoundsSinceCheckpoint = Number(progress.autoRoundsSinceCheckpoint || 0);
  const maxAutoRounds = Number(progress.maxAutoRounds || 0);
  const manualCheckpoint = !configuredAutoContinue && Number(progress.currentTurnIndex || 0) > 0;
  const needsUserCheckpoint = Boolean(progress.needsUserCheckpoint)
    || manualCheckpoint
    || (configuredAutoContinue && maxAutoRounds > 0 && autoRoundsSinceCheckpoint >= maxAutoRounds);
  return {
    pace: String(progress.pace || '').trim(),
    paceLabel: String(progress.paceLabel || progress.detail || '').trim(),
    autoContinue: configuredAutoContinue && !needsUserCheckpoint,
    maxAutoRounds,
    autoRoundsSinceCheckpoint,
    needsUserCheckpoint,
    pausePolicy: String(progress.pausePolicy || '').trim(),
  };
}

function duetInteraction(progress = {}, turnCount = 0) {
  const pace = duetPaceInfo(progress);
  return {
    status: 'waiting_for_direction',
    turnCount,
    pace: pace.paceLabel || pace.pace || '自由发展',
    autoContinue: pace.autoContinue,
    needsUserCheckpoint: pace.needsUserCheckpoint,
    pausePolicy: pace.pausePolicy,
    next: pace.needsUserCheckpoint
      ? '自动推进安全上限已到，请回到用户决定下一步。'
      : pace.autoContinue
        ? '普通回合自动继续；遇到关键剧情、关系变化或边界节点时暂停并询问用户。'
        : '等待用户决定下一步方向。',
  };
}

export function buildTheaterMessages(character, history, message, vars) {
  const messages = [];
  if (character?.prompt) messages.push({ role: 'system', content: character.prompt });
  if (character?.scenario) messages.push({ role: 'system', content: `当前场景: ${character.scenario}` });
  const variableText = formatMvuStateText(vars);
  if (variableText) {
    messages.push({ role: 'system', content: `当前 MVU 变量（仅供角色遵循，不要向用户解释变量系统）：\n${variableText}` });
  }
  for (const item of history || []) {
    messages.push({ role: item.role, content: item.content });
  }
  messages.push({ role: 'user', content: message });
  return messages;
}

export function summarizeVariableChanges(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  return [...keys].filter((key) => JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key]))
    .map((key) => ({ key, before: Object.hasOwn(before || {}, key) ? before[key] : null, after: Object.hasOwn(after || {}, key) ? after[key] : null }));
}

/**
 * 旧的后端提示词预检。它不经过 SillyTavern 前端，也不会执行世界书/EJS/MVU 扩展。
 * 仅供测试代码或明确要求“卡片上下文预检”时使用，不能冒充真实测卡。
 */
export async function runPromptPreview({ characterId, turns, title = '', objective = '' }, ctx = {}) {
  const character = await getCharacter(characterId, ctx);
  if (!character) throw new Error(`角色 ${characterId} 不存在`);
  const normalizedTurns = normalizeTheaterTurns(turns);
  if (!normalizedTurns.length) throw new Error('小剧场至少需要一幕测试台词。');

  const initialVariables = clone(readMvuState(character.id, ctx) || {});
  let vars = clone(initialVariables);
  const history = [];
  const scenes = [];
  const opening = cleanTavernText(String(character.first_mes || character.greeting || character.charData?.first_mes || character.charData?.greeting || '').trim());
  if (opening) history.push({ role: 'assistant', content: opening });

  for (let index = 0; index < normalizedTurns.length; index += 1) {
    const message = normalizedTurns[index];
    const before = clone(vars);
    const result = await callLLM({
      messages: buildTheaterMessages(character, history, message, vars),
      characterName: character.name,
    }, ctx);
    const rawReply = String(result.text || '');
    const patches = extractJsonPatch(rawReply);
    if (patches.length) vars = applyJsonPatch(vars, patches);
    const reply = cleanTavernText(rawReply);
    history.push({ role: 'user', content: message }, { role: 'assistant', content: reply });
    scenes.push({
      index: index + 1,
      user: message,
      reply,
      variableChanges: summarizeVariableChanges(before, vars),
      patchesApplied: patches.length,
      usage: result.usage || {},
    });
  }

  return {
    mode: 'theater-preview',
    engine: 'prompt-preview',
    title: String(title || `${character.name} 的小剧场上下文预检`),
    objective: String(objective || ''),
    initialVariables,
    character: { id: character.id, name: character.name },
    sceneCount: scenes.length,
    opening,
    finalVariables: vars,
    scenes,
  };
}

/**
 * 真实测卡入口：在隔离的无界面 SillyTavern 页面中执行 Generate()。
 * 临时聊天在返回前清理；正式聊天与 Hana 侧 mvu-state.json 不参与本次测试。
 */
export async function runTheater({ characterId, turns, title = '', objective = '', progressId = '' }, ctx = {}) {
  if (ctx.promptPreview === true) {
    return runPromptPreview({ characterId, turns, title, objective }, ctx);
  }
  const character = await getCharacter(characterId, ctx);
  if (!character) throw new Error(`角色 ${characterId} 不存在`);
  const normalizedTurns = normalizeTheaterTurns(turns);
  if (!normalizedTurns.length) throw new Error('小剧场至少需要一幕测试台词。');

  const liveProgress = String(progressId || '').trim();
  if (liveProgress) {
    updateTheaterProgress(liveProgress, {
      status: 'running',
      characterId: character.id,
      characterName: character.name,
      title: String(title || `${character.name} 的真实酒馆测卡`),
      objective: String(objective || ''),
      turns: normalizedTurns,
      currentTurnIndex: 0,
    });
  }

  const reportProgress = async (snapshot = {}) => {
    if (!liveProgress) return;
    const scenes = Array.isArray(snapshot.scenes)
      ? snapshot.scenes.map((scene) => ({
        ...scene,
        reply: cleanTavernText(String(scene.reply || '')),
      }))
      : undefined;
    const patch = {
      status: snapshot.status === 'error' ? 'error' : 'running',
      opening: String(snapshot.opening || ''),
      activeScene: snapshot.activeScene || null,
      currentTurnIndex: Number(snapshot.currentTurnIndex || scenes?.length || 0),
    };
    if (scenes) patch.scenes = scenes;
    if (Object.hasOwn(snapshot, 'initialVariables')) patch.initialVariables = snapshot.initialVariables ?? null;
    if (Object.hasOwn(snapshot, 'finalVariables')) patch.finalVariables = snapshot.finalVariables ?? null;
    if (snapshot.initialVariableSource) patch.initialVariableSource = snapshot.initialVariableSource;
    if (snapshot.finalVariableSource) patch.finalVariableSource = snapshot.finalVariableSource;
    if (typeof snapshot.mvuAvailable === 'boolean') patch.mvuAvailable = snapshot.mvuAvailable;
    await updateTheaterProgress(liveProgress, patch);
  };

  try {
    const result = await runSillyTavernTheater({
      characterId: character.id,
      characterName: character.name,
      turns: normalizedTurns,
      onProgress: reportProgress,
    }, ctx);

    const scenes = (result.scenes || []).map((scene) => ({
      ...scene,
      // ST 的消息里可能带可折叠的 thinking 标签；回传给主对话时只保留用户实际看到的正文。
      reply: cleanTavernText(String(scene.reply || '')),
    }));
    const warnings = result.mvuAvailable === true
      ? []
      : ['本次真实 ST 页面没有发现 Mvu API；回复确实经过 Generate()，但 stat_data 未能读取，不能据此判断 MVU 变量逻辑。'];

    const report = {
      mode: 'theater',
      engine: 'sillytavern-runtime',
      title: String(title || `${character.name} 的真实酒馆测卡`),
      objective: String(objective || ''),
      character: { id: character.id, name: character.name },
      sceneCount: scenes.length,
      opening: result.opening || '',
      initialVariables: result.initialVariables ?? null,
      finalVariables: result.finalVariables ?? null,
      formalChatVariables: null,
      initialVariableSource: result.initialVariableSource || 'unavailable',
      finalVariableSource: result.finalVariableSource || 'unavailable',
      mvuAvailable: result.mvuAvailable === true,
      runtimeCapabilities: {
        yueAssistant: result.yueAssistantLoaded === true,
        mvu: result.mvuAvailable === true,
        generate: true,
      },
      warnings,
      variableScope: {
        initial: '真实 ST 临时测试聊天创建后读取的变量',
        final: '真实 ST 临时测试聊天最后一幕后读取的变量',
        formalChat: '本次未读取，也未修改正式聊天变量；formalChatVariables 固定为 null',
      },
      isolated: result.isolated === true,
      serverUrl: result.serverUrl || undefined,
      runId: result.runId,
      scenes,
    };

    if (liveProgress) {
      completeTheaterProgress(liveProgress, {
        title: report.title,
        objective: report.objective,
        characterId: report.character.id,
        characterName: report.character.name,
        turns: normalizedTurns,
        currentTurnIndex: scenes.length,
        opening: report.opening,
        initialVariables: report.initialVariables,
        finalVariables: report.finalVariables,
        initialVariableSource: report.initialVariableSource,
        finalVariableSource: report.finalVariableSource,
        mvuAvailable: report.mvuAvailable,
        isolated: report.isolated,
        warnings: report.warnings,
        scenes,
      });
    }
    return report;
  } catch (error) {
    if (liveProgress) failTheaterProgress(liveProgress, error.message || error);
    throw error;
  }
}

/** 启动一场由主对话逐轮导演的真实对戏；这里只负责酒馆，不替用户编写方向。 */
export async function startTheaterDuet({
  progressId,
  characterId,
  characterName = '',
  title = '',
  objective = '',
}, ctx = {}) {
  const progress = requireDuetProgress(progressId, ctx, characterId);
  const character = await getCharacter(characterId || progress.characterId, ctx);
  if (!character) throw new Error(`角色 ${characterName || characterId || progress.characterName} 不存在`);
  if (progress.chatFile) throw new Error('这场代笔对戏已经启动，请直接继续下一轮。');
  const reportTitle = String(title || `${character.name} 的代笔对戏`);
  const reportObjective = String(objective || progress.detail || '由用户给方向，小花逐轮代笔推进。');
  updateTheaterProgress(progress.runId, {
    status: 'running',
    characterId: character.id,
    characterName: character.name,
    title: reportTitle,
    objective: reportObjective,
    activeScene: null,
    error: null,
  });
  try {
    const result = await startSillyTavernDuet({
      duetId: progress.runId,
      characterId: character.id,
      characterName: character.name,
    }, ctx);
    const mvuAvailable = result.mvuAvailable === true;
    const opening = cleanTavernText(String(result.opening || ''));
    const warnings = duetWarning(mvuAvailable);
    const report = {
      mode: 'duet',
      interactionMode: '代笔对戏',
      engine: 'sillytavern-runtime',
      title: reportTitle,
      objective: reportObjective,
      character: { id: character.id, name: character.name },
      sceneCount: 0,
      opening,
      initialVariables: result.initialVariables ?? null,
      finalVariables: null,
      formalChatVariables: null,
      initialVariableSource: result.initialVariableSource || 'unavailable',
      finalVariableSource: 'unavailable',
      mvuAvailable,
      runtimeCapabilities: {
        yueAssistant: result.yueAssistantLoaded === true,
        mvu: mvuAvailable,
        generate: true,
      },
      warnings,
      variableScope: duetVariableScope(),
      isolated: result.isolated === true,
      serverUrl: result.serverUrl || undefined,
      runId: progress.runId,
      theaterSessionId: progress.runId,
      ...duetPaceInfo(progress),
      interaction: duetInteraction(progress, 0),
      scenes: [],
    };
    updateTheaterProgress(progress.runId, {
      status: 'waiting_for_direction',
      title: report.title,
      objective: report.objective,
      characterId: report.character.id,
      characterName: report.character.name,
      chatFile: result.chatFile || '',
      opening: report.opening,
      initialVariables: report.initialVariables,
      finalVariables: null,
      initialVariableSource: report.initialVariableSource,
      finalVariableSource: report.finalVariableSource,
      mvuAvailable: report.mvuAvailable,
      isolated: report.isolated,
      warnings: report.warnings,
      currentTurnIndex: 0,
      activeScene: null,
      scenes: [],
      error: null,
    });
    return report;
  } catch (error) {
    failTheaterProgress(progress.runId, error.message || error);
    throw error;
  }
}

/** 把小花已经代写好的玩家一条消息送进同一场真实酒馆对戏。 */
export async function runTheaterDuetTurn({ progressId, playerMessage, checkpoint = false }, ctx = {}) {
  const checkpointFlag = checkpoint === true || checkpoint === 'true';
  const message = normalizeDuetPlayerMessage(playerMessage);
  if (!message) throw new Error('代笔对戏这一轮没有可发送的玩家台词。');
  const progress = requireDuetProgress(progressId, ctx);
  if (progress.status === 'ended') throw new Error('这场代笔对戏已经结束，请从小剧场重新开始。');
  if (progress.status === 'running') throw new Error('角色正在回复，请等这一轮结束后再给方向。');
  if (!progress.chatFile) throw new Error('代笔对戏还没有启动，请先调用开始工具。');
  if (progress.needsUserCheckpoint && !checkpointFlag) {
    throw new Error('这段对戏已达到自动推进安全上限，请先等用户给出新的方向。');
  }
  const nextIndex = Number(progress.currentTurnIndex || progress.scenes?.length || 0) + 1;
  const autoRoundsSinceCheckpoint = checkpointFlag
    ? 0
    : Number(progress.autoRoundsSinceCheckpoint || 0) + 1;
  const maxAutoRounds = Number(progress.maxAutoRounds || 0);
  const needsUserCheckpoint = progress.autoContinue === false
    || (maxAutoRounds > 0 && autoRoundsSinceCheckpoint >= maxAutoRounds);
  updateTheaterProgress(progress.runId, {
    status: 'running',
    activeScene: { index: nextIndex, user: message },
    autoRoundsSinceCheckpoint,
    needsUserCheckpoint,
    error: null,
  });
  try {
    const result = await runSillyTavernDuetTurn({
      duetId: progress.runId,
      playerMessage: message,
      sceneIndex: nextIndex,
    }, ctx);
    if (!result?.scene) throw new Error('真实酒馆没有返回这一轮的角色回复。');
    const mvuAvailable = typeof result.mvuAvailable === 'boolean'
      ? result.mvuAvailable
      : progress.mvuAvailable === true;
    const scene = {
      ...result.scene,
      index: nextIndex,
      user: message,
      reply: cleanTavernText(String(result.scene.reply || '')),
      variableChanges: Array.isArray(result.scene.variableChanges) ? result.scene.variableChanges : [],
    };
    const scenes = [...(Array.isArray(progress.scenes) ? progress.scenes : []), scene];
    const finalVariables = result.finalVariables ?? scene.variablesAfter ?? null;
    const finalVariableSource = result.finalVariableSource || scene.variableSource || 'unavailable';
    const warnings = duetWarning(mvuAvailable);
    updateTheaterProgress(progress.runId, {
      status: 'waiting_for_direction',
      activeScene: null,
      currentTurnIndex: scenes.length,
      autoRoundsSinceCheckpoint,
      needsUserCheckpoint,
      finalVariables,
      finalVariableSource,
      mvuAvailable,
      isolated: result.isolated === true || progress.isolated === true,
      warnings,
      scenes,
      error: null,
    });
    return {
      mode: 'duet',
      interactionMode: '代笔对戏',
      engine: 'sillytavern-runtime',
      title: progress.title || `${progress.characterName} 的代笔对戏`,
      objective: progress.objective || '',
      character: { id: progress.characterId, name: progress.characterName },
      sceneCount: scenes.length,
      opening: progress.opening || '',
      initialVariables: progress.initialVariables ?? null,
      finalVariables,
      formalChatVariables: null,
      initialVariableSource: progress.initialVariableSource || 'unavailable',
      finalVariableSource,
      mvuAvailable,
      runtimeCapabilities: {
        yueAssistant: result.yueAssistantLoaded === true,
        mvu: mvuAvailable,
        generate: true,
      },
      warnings,
      variableScope: duetVariableScope(),
      isolated: result.isolated === true || progress.isolated === true,
      runId: progress.runId,
      theaterSessionId: progress.runId,
      ...duetPaceInfo({ ...progress, autoRoundsSinceCheckpoint, needsUserCheckpoint }),
      interaction: duetInteraction({ ...progress, autoRoundsSinceCheckpoint, needsUserCheckpoint }, scenes.length),
      scene,
      scenes: [scene],
    };
  } catch (error) {
    failTheaterProgress(progress.runId, error.message || error);
    throw error;
  }
}

/** 结束并清理对戏专用的驻留酒馆会话。 */
export async function endTheaterDuet({ progressId }, ctx = {}) {
  const progress = requireDuetProgress(progressId, ctx);
  if (progress.status === 'running') throw new Error('角色正在回复，请等这一轮结束后再结束对戏。');
  try {
    const cleanup = await endSillyTavernDuet({ duetId: progress.runId }, ctx);
    const endedAt = Date.now();
    const finalProgress = updateTheaterProgress(progress.runId, {
      status: 'ended',
      activeScene: null,
      interactionStatus: 'ended',
      endedAt,
      error: null,
    }) || progress;
    return {
      mode: 'duet',
      interactionMode: '代笔对戏',
      status: 'ended',
      ended: true,
      alreadyEnded: cleanup.alreadyEnded === true,
      cleanedChats: Number(cleanup.cleanedChats || 0),
      character: { id: finalProgress.characterId, name: finalProgress.characterName },
      sceneCount: Array.isArray(finalProgress.scenes) ? finalProgress.scenes.length : 0,
      runId: finalProgress.runId,
      theaterSessionId: finalProgress.runId,
      scenes: finalProgress.scenes || [],
    };
  } catch (error) {
    failTheaterProgress(progress.runId, error.message || error);
    throw error;
  }
}
