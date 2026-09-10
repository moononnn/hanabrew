import { endTheaterDuet } from '../backend/theater.js';

export const name = 'tavern-duet-end';
export const sessionPermission = { readOnly: true };
export const description = '代笔对戏结束工具：用户明确说结束、退出或换一场时调用。它会关闭对戏专用的无界面 SillyTavern 会话并清理带唯一前缀的临时聊天，只保留卡片里的过程记录，不会删除或修改用户正式聊天。结束不可逆；没有用户明确要求时不要调用。';
export const parameters = {
  type: 'object',
  properties: {
    theaterSessionId: { type: 'string', description: '当前代笔对戏结果返回的会话 ID。' },
  },
  required: ['theaterSessionId'],
};

export async function execute({ theaterSessionId }, ctx = {}) {
  try {
    const result = await endTheaterDuet({ progressId: String(theaterSessionId || '').trim() }, ctx);
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
