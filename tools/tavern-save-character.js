export const name = "tavern-save-character";
export const description = "Create or update a character card in 花酿.";
export const parameters = {
  type: "object",
  properties: {
    name: { type: "string" },
    prompt: { type: "string" },
    greeting: { type: "string" },
    scenario: { type: "string" },
    exampleDialogue: { type: "string" },
    tags: { type: "string" },
  },
  required: ["name"]
};
export async function execute(input, ctx = {}) {
  const { createCharacter, updateCharacter } = await import("../backend/characters.js");
  const chars = await (await import("../backend/characters.js")).listCharacters(ctx, { shallow: true });
  const existing = chars.find(c => c.name === input.name);
  let result;
  if (existing) {
    result = await updateCharacter({ ...input, id: existing.id }, ctx);
  } else {
    result = await createCharacter(input, ctx);
  }
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
  };
}
