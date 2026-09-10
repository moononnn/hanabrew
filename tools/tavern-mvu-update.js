// 来访角色的 MVU 更新工具：让角色通过工具调用提交变量更新，正文保持干净。
// 花酿在自己的账本里记账（mvu-state.json），数值不进前端展示。

import { applyMvuUpdate, extractJsonPatch } from '../backend/mvu.js';
import { getCharacter } from '../backend/characters.js';

export const name = 'tavern-mvu-update';
export const description = '更新这张角色卡的剧情状态变量（好感度/信任度/时间/地点等）。当你想记录这段对话里关系或世界状态的变化时调用它，传入 JSON Patch 格式的变量更新。';
export const parameters = {
  type: 'object',
  properties: {
    patches: {
      type: 'array',
      description: 'JSON Patch（RFC 6902）操作数组，如 [{ "op": "replace", "path": "/关系/好感度", "value": 37 }]。支持 add / replace / remove。',
      items: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['add', 'replace', 'remove'] },
          path: { type: 'string' },
          value: {},
        },
        required: ['op', 'path'],
      },
    },
  },
  required: ['patches'],
};

export function resolveMvuCharacterId(state = {}, ctx = {}) {
  const visitors = (Array.isArray(state?.visitors) ? state.visitors : [])
    .filter((visitor) => visitor?.status === 'active' && visitor?.characterId);
  const agentIds = [
    ctx?.agentId,
    ctx?.agent?.id,
    ctx?.agentRef?.id,
    ctx?.sessionRef?.agentId,
    ctx?.sessionRef?.agent?.id,
  ].map((value) => String(value || '').trim()).filter(Boolean);
  const sessionIds = [
    ctx?.sessionId,
    ctx?.sessionRef?.sessionId,
    ctx?.sessionRef?.id,
    ctx?.session?.sessionId,
    ctx?.session?.id,
  ].map((value) => String(value || '').trim()).filter(Boolean);
  const sessionPaths = [
    ctx?.sessionPath,
    ctx?.sessionRef?.sessionPath,
    ctx?.session?.sessionPath,
    ctx?.session?.path,
  ].map((value) => String(value || '').trim()).filter(Boolean);

  const matched = visitors.find((visitor) =>
    (agentIds.length && agentIds.includes(String(visitor.agentId || '').trim()))
    || (sessionIds.length && sessionIds.includes(String(visitor.sessionId || '').trim()))
    || (sessionPaths.length && sessionPaths.includes(String(visitor.sessionPath || '').trim()))
  );
  if (matched) return String(matched.characterId);

  // 没有会话身份时，只有唯一来访者才允许无歧义回退；多位来访者必须拒绝串账。
  if (visitors.length === 1) return String(visitors[0].characterId);
  if (visitors.length > 1) return null;
  return state?.activeCharacterId ? String(state.activeCharacterId) : null;
}

export async function execute({ patches }, ctx = {}) {
  try {
    const state = await import('../backend/store.js').then((m) => m.readState(ctx));
    const characterId = resolveMvuCharacterId(state, ctx);
    if (!characterId) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: '没有找到当前角色。' }) }] };
    }
    const result = applyMvuUpdate(characterId, patches, ctx);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ok: true,
          applied: result.applied,
          // 不返回具体数值，只返回应用了多少条，避免把数值暴露给用户
          note: result.applied ? '变量已更新并记录。' : '没有可应用的更新。',
        }),
      }],
    };
  } catch (error) {
    return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: error.message }) }] };
  }
}
