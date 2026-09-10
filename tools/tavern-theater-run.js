import { runTheater, normalizeTheaterTurns } from '../backend/theater.js';
import { getCharacter } from '../backend/characters.js';
import { readState } from '../backend/store.js';
import { claimTheaterProgress, failTheaterProgress } from '../backend/theater-progress.js';

export const name = 'tavern-theater-run';
export const sessionPermission = { readOnly: true };
export const description = '真实角色卡固定测卡工具：用户从小剧场卡片提交角色卡和测试方式后，助手调用本工具，把测试目标拆成 1~12 幕台词，在真正的 SillyTavern 前端中执行 Generate()，让世界书、EJS、MVU 和已安装扩展一起生效；卡片会同步显示测试台词、角色逐幕回复和变量变化，详细判断仍由助手在当前对话正文分析。它只用于确定性的“变量体检”；用户选择“代笔对戏”时改用 tavern-duet-start、tavern-duet-turn、tavern-duet-end，不能一次预写多轮。若用户说“帮我测卡”“帮我测一下这张角色卡”“试演一下这个角色”“看看这张卡的变量有没有生效”或类似测卡意图而没有卡片请求，先打开小剧场卡片，不要跳过选择界面。ST 不可用或运行失败时必须报告失败，不能把后端提示词预检冒充真实测卡。';
export const parameters = {
  type: 'object',
  properties: {
    characterId: { type: 'string', description: '角色卡 ID；卡片请求优先传入。' },
    characterName: { type: 'string', description: '卡片请求选中的角色卡名称；没有 ID 时按名称精确匹配，不能回退到当前角色。' },
    title: { type: 'string', description: '本次调试标题，可由助手根据测试目标填写。' },
    objective: { type: 'string', description: '用户要验证的目标，例如“确认好感度在表白后是否增加”；用于结果标注，不要求用户填写。' },
    turns: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 12,
      description: '由助手根据用户的测试目标自动设计的逐幕测试台词；不要把这个字段暴露成让用户自行填写的操作步骤。'
    }
  },
  required: ['turns']
};

export async function execute({ characterId, characterName, title, objective, turns }, ctx = {}) {
  let progressRunId = '';
  try {
    const state = await readState(ctx);
    let id = String(characterId || '').trim();
    if (!id && String(characterName || '').trim()) {
      const selected = await getCharacter(String(characterName).trim(), ctx);
      if (!selected) throw new Error(`找不到卡片选中的角色卡「${String(characterName).trim()}」。请重新打开小剧场卡片选择。`);
      id = selected.id;
    }
    if (!id) id = String(state.activeCharacterId || '').trim();
    const normalized = normalizeTheaterTurns(turns);
    if (!id) throw new Error('还没有可测试的角色卡；请先导入或创建一张角色卡，之后直接告诉小花测试目标即可。');
    if (!normalized.length) throw new Error('小剧场至少需要一幕测试台词。');
    const progress = claimTheaterProgress({
      sessionId: ctx.sessionId,
      sessionPath: ctx.sessionPath,
      sessionRef: ctx.sessionRef,
      characterId: id,
      mode: 'scripted',
    });
    progressRunId = progress?.runId || '';
    const result = await runTheater({
      characterId: id,
      title,
      objective,
      turns: normalized,
      progressId: progress?.runId || '',
    }, ctx);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      details: { theater: result },
    };
  } catch (error) {
    if (progressRunId) failTheaterProgress(progressRunId, error.message || error);
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: error.message }, null, 2) }],
      details: { theater: { mode: 'theater', error: error.message } },
    };
  }
}
