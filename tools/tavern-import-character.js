export const name = "tavern-import-character";
export const description = "Import a character card from JSON, YAML, or PNG format.";
export const parameters = {
  type: "object",
  properties: {
    text: { type: "string" },
    filePath: { type: "string" },
    fallbackName: { type: "string" }
  }
};
export async function execute(input, ctx = {}) {
  const { importCharacter } = await import("../backend/characters.js");
  try {
    const result = await importCharacter(input, ctx);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
    };
  } catch (e) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: e.message }, null, 2) }]
    };
  }
}
