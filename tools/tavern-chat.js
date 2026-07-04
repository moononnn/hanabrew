export const name = "tavern-chat";
export const description = "Send a message to the active character and get a reply.";
export const parameters = {
  type: "object",
  properties: {
    message: { type: "string" },
    characterId: { type: "string" }
  },
  required: ["message"]
};
export async function execute({ message, characterId }, ctx = {}) {
  const { chat } = await import("../backend/chats.js");
  const { readState } = await import("../backend/store.js");
  const state = await readState(ctx);
  const charId = characterId || state.activeCharacterId;
  if (!charId) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: "No active character. Load one first." }) }]
    };
  }
  try {
    const result = await chat(charId, message, ctx);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
    };
  } catch (e) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: e.message }, null, 2) }]
    };
  }
}
