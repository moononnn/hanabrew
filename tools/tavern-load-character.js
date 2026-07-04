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
  const { readState, writeState } = await import("../backend/store.js");
  const state = await readState(ctx);
  state.activeCharacterId = characterId;
  await writeState(state, ctx);
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: true, activeCharacterId: characterId }) }]
  };
}
