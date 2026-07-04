export const name = "tavern-delete-character";
export const description = "Delete a character card and all related chats.";
export const parameters = {
  type: "object",
  properties: {
    characterId: { type: "string" }
  },
  required: ["characterId"]
};
export async function execute({ characterId }, ctx = {}) {
  const { deleteCharacter } = await import("../backend/characters.js");
  await deleteCharacter(characterId, ctx);
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: true }) }]
  };
}
