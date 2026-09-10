export const name = "tavern-import-character";
export const description = "Import a character card from JSON, YAML, or PNG format, preserving standard card data and PNG avatars.";
export const parameters = {
  type: "object",
  properties: {
    text: { type: "string", description: "角色卡 JSON 或 YAML 文本。" },
    filePath: { type: "string", description: "角色卡 JSON/YAML/PNG 的本地路径。" },
    fallbackName: { type: "string", description: "卡片缺少 name 时使用的名称。" },
    id: { type: "string", description: "可选的新角色编号；省略时自动生成，避免覆盖同目录来源卡。" }
  }
};
export async function execute(input, ctx = {}) {
  const { importCharacter } = await import("../backend/characters.js");
  try {
    const result = await importCharacter(input, ctx);
    const hint = result?.error
      ? ''
      : `\n\n小提示：这张角色卡也可以做真实测卡。你可以直接说“帮我测一下${result?.name ? `「${result.name}」` : '这张角色卡'}，看看表白后好感度会不会增加”，小花会打开角色卡体检流程。`;
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) + hint }]
    };
  } catch (e) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: e.message }, null, 2) }]
    };
  }
}
