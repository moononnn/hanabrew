export const name = 'tavern-open-theater';
export const description = '打开花酿「小剧场 / 角色卡体检」卡片：用户在卡片里选择角色卡和固定测卡或“代笔对戏”。固定测卡展示逐幕测试过程并把结论带回当前对话；代笔对戏由用户给方向、小花代写玩家侧台词，真实角色按所选节奏连续推进，普通回合自动继续，关键剧情才回到当前对话请用户拍板。用户也可以直接说“帮我测一下这张角色卡”“看看这张卡的变量有没有生效”来表达测卡意图。';
export const sessionPermission = { readOnly: true };
export const parameters = { type: 'object', properties: {}, required: [] };

export async function execute(_input, ctx = {}) {
  return {
    content: [{ type: 'text', text: '已打开花酿「体检」卡片。你可以选择固定测卡或代笔对戏；也可以直接在当前对话说“帮我测一下这张角色卡”。' }],
    details: {
      card: {
        type: 'iframe',
        sessionId: ctx.sessionId,
        sessionRef: ctx.sessionRef,
        sessionPath: ctx.sessionPath,
        route: `/card/theater${ctx.sessionId ? `?sessionId=${encodeURIComponent(ctx.sessionId)}` : ''}${ctx.sessionPath ? `${ctx.sessionId ? '&' : '?'}sessionPath=${encodeURIComponent(ctx.sessionPath)}` : ''}${ctx.sessionRef ? `${ctx.sessionId || ctx.sessionPath ? '&' : '?'}sessionRef=${encodeURIComponent(ctx.sessionRef)}` : ''}`, 
        aspectRatio: '400:650',
        title: '花酿 · 体检',
        description: '卡片先选择角色卡和模式；固定测卡展示逐幕过程，代笔对戏按所选节奏自动推进，关键剧情回当前对话请用户拍板。'
      },
    },
  };
}
