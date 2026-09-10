export const name = "tavern-load-character";
export const description = "Set the active character in 花酿.";
export const parameters = {
  type: "object",
  properties: {
    characterId: { type: "string", description: "Character ID to load" }
  },
  required: ["characterId"]
};
export async function execute({ characterId }, ctx = {}) {
  const { getCharacter } = await import("../backend/characters.js");
  const { readState, writeState } = await import("../backend/store.js");
  const character = await getCharacter(characterId, ctx);
  if (!character) {
    return {
      content: [{ type: "text", text: JSON.stringify({ ok: false, error: "找不到这张角色卡。" }) }],
    };
  }
  const state = await readState(ctx);
  if (state.activeCharacterId !== character.id) state.activeChatId = null;
  state.activeCharacterId = character.id;
  await writeState(state, ctx);
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: true, activeCharacterId: character.id }) }]
  };
}
