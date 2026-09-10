import { runTheaterDuetTurn } from '../backend/theater.js';
import { getTheaterProgressForSession } from '../backend/theater-progress.js';

export const name = 'tavern-duet-turn';
export const sessionPermission = { readOnly: true };
export const description = '代笔对戏逐轮工具：把小花代写的一条自然第一人称玩家侧消息原样送进已经启动的真实 SillyTavern 隔离聊天，并只生成一轮角色回复。playerMessage 只能包含角色看得到的玩家台词和动作，不能夹带“导演指令”、测试目的、变量名、分析或对模型的提示。工具返回 theaterSessionId、实际角色回复和当前节奏；如果结果说明普通回合应自动继续，就在同一助手回合里继续代写下一条玩家消息并再次调用本工具，不要把中间回合带回主对话逐轮等待。用户刚给了新的实时方向时传 checkpoint=true，自动续接时省略或传 false；达到节奏安全上限、遇到关键剧情、关系变化或边界节点时停止工具调用，再把已完成过程带回用户决定。';
export const parameters = {
  type: 'object',
  properties: {
    theaterSessionId: { type: 'string', description: 'tavern-duet-start 或上一轮结果返回的对戏会话 ID。' },
    playerMessage: { type: 'string', description: '小花根据用户方向代写的一条玩家侧消息；会原样发送给真实角色。' },
    checkpoint: { type: 'boolean', description: '可选；用户刚给了新的实时方向时传 true，自动续接普通回合时不传。' },
  },
  required: ['theaterSessionId', 'playerMessage'],
};

export async function execute({ theaterSessionId, playerMessage, checkpoint = false }, ctx = {}) {
  try {
    const id = String(theaterSessionId || '').trim();
    if (!id) throw new Error('代笔对戏缺少会话 ID。');
    const progress = getTheaterProgressForSession(id, {
      sessionId: ctx.sessionId,
      sessionPath: ctx.sessionPath,
      sessionRef: ctx.sessionRef,
    });
    if (!progress) throw new Error('找不到这场代笔对戏，可能已结束或当前对话无权继续。');
    const result = await runTheaterDuetTurn({ progressId: id, playerMessage, checkpoint: checkpoint === true || checkpoint === 'true' }, ctx);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      details: { theater: result },
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: error.message }, null, 2) }],
      details: { theater: { mode: 'duet', error: error.message } },
    };
  }
}
