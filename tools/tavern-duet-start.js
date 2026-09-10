import { getCharacter } from '../backend/characters.js';
import { runTheaterDuetTurn, startTheaterDuet } from '../backend/theater.js';
import {
  claimTheaterProgress,
  failTheaterProgress,
  getTheaterProgressForSession,
} from '../backend/theater-progress.js';

export const name = 'tavern-duet-start';
export const sessionPermission = { readOnly: true };
export const description = '代笔对戏开始工具：小剧场选择“代笔对戏”后，用户给出大概方向，小花先把方向改写成一条自然的第一人称玩家消息，再调用本工具启动选中的角色卡。只传已经代写好的玩家台词，它会原样发给真实角色；不能把导演说明、测试目标、变量名或隐藏规则送进角色对话。本工具会在真实 SillyTavern 前端创建隔离临时聊天，但不会碰正式聊天。启动后返回 theaterSessionId、所选节奏和自动推进规则；普通回合按节奏可在同一助手回合内连续调用 tavern-duet-turn，只有关键剧情、关系变化、边界节点或自动推进安全上限才停下来询问用户。每次工具调用仍只生成一轮真实回复；用户明确说结束时使用 tavern-duet-end。';
export const parameters = {
  type: 'object',
  properties: {
    characterId: { type: 'string', description: '小剧场选中的角色卡 ID；不要改成当前活动角色。' },
    characterName: { type: 'string', description: '小剧场选中的角色卡名称；没有 ID 时按名称精确匹配。' },
    theaterSessionId: { type: 'string', description: '可选；卡片交接或之前结果提供的对戏会话 ID。首次调用通常不需要，工具会按当前会话认领卡片请求。' },
    title: { type: 'string', description: '可选的对戏标题。' },
    objective: { type: 'string', description: '可选的幕后目标，只用于过程标注，绝不能写进玩家台词。' },
    playerMessage: { type: 'string', description: '小花根据用户方向代写的第一条玩家侧消息；会原样发给真实角色。只写角色能看到的内容。' },
  },
  required: ['playerMessage'],
};

function sessionInput(ctx = {}) {
  return {
    sessionId: ctx.sessionId,
    sessionPath: ctx.sessionPath,
    sessionRef: ctx.sessionRef,
  };
}

export async function execute({
  characterId,
  characterName,
  theaterSessionId,
  title,
  objective,
  playerMessage,
}, ctx = {}) {
  let progressRunId = '';
  try {
    const firstTurn = String(playerMessage || '').trim();
    if (!firstTurn) throw new Error('代笔对戏开始时需要一条小花代写的玩家台词。');
    const selectedSession = String(theaterSessionId || '').trim();
    let progress = selectedSession
      ? getTheaterProgressForSession(selectedSession, sessionInput(ctx))
      : null;
    if (!selectedSession) {
      progress = claimTheaterProgress({
        ...sessionInput(ctx),
        characterId: String(characterId || '').trim(),
        mode: 'duet',
      });
    }
    if (!progress) throw new Error('没有找到当前会话的小剧场代笔对戏请求；请重新打开小剧场卡片并选择“代笔对戏”。');
    progressRunId = progress.runId;

    const id = String(characterId || progress.characterId || '').trim();
    const name = String(characterName || progress.characterName || '').trim();
    const character = await getCharacter(id || name, ctx);
    if (!character) throw new Error(`找不到卡片选中的角色卡「${name || id}」。请重新打开小剧场卡片选择。`);
    if (progress.characterId && progress.characterId !== character.id) {
      throw new Error('代笔对戏的角色卡与小剧场选中的角色不一致。');
    }

    const started = await startTheaterDuet({
      progressId: progressRunId,
      characterId: character.id,
      characterName: character.name,
      title,
      objective,
    }, ctx);
    const result = await runTheaterDuetTurn({ progressId: progressRunId, playerMessage: firstTurn, checkpoint: true }, ctx);
    const merged = {
      ...result,
      opening: started.opening,
      initialVariables: started.initialVariables,
      initialVariableSource: started.initialVariableSource,
      firstPlayerMessage: firstTurn,
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(merged, null, 2) }],
      details: { theater: merged },
    };
  } catch (error) {
    const current = progressRunId
      ? getTheaterProgressForSession(progressRunId, sessionInput(ctx))
      : null;
    const duplicateStart = Boolean(current?.chatFile && /已经启动/.test(String(error.message || error)));
    if (progressRunId && !duplicateStart) failTheaterProgress(progressRunId, error.message || error);
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: error.message }, null, 2) }],
      details: { theater: { mode: 'duet', error: error.message } },
    };
  }
}
