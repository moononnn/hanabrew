export const name = "tavern-list-characters";
export const description = "List all character cards in 花酿.";
export const parameters = {
  type: "object",
  properties: {},
  required: []
};
export async function execute(input, ctx = {}) {
  const { listCharacters } = await import("../backend/characters.js");
  const chars = await listCharacters(ctx, { shallow: false });
  const result = chars.map(c => ({
    id: c.id,
    name: c.name,
    description: c.description || c.prompt || c.charData?.description || '',
    prompt: c.prompt || c.charData?.personality || c.charData?.description || '',
    greeting: c.greeting || c.charData?.first_mes || '',
    scenario: c.scenario || c.charData?.scenario || '',
    tags: c.tags,
    avatarPath: c.avatarPath,
    createdAt: c.createdAt,
  }));
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
  };
}
