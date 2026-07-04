export const name = "tavern-settings";
export const description = "Get or update 花酿 settings (model, API, presets, theme).";
export const parameters = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["get", "set"] },
    key: { type: "string" },
    value: {}
  },
  required: ["action"]
};
export async function execute({ action, key, value }, ctx = {}) {
  const { readSettings, writeSettings } = await import("../backend/store.js");
  let result;
  if (action === "get") {
    const s = await readSettings(ctx);
    result = key ? { [key]: s[key] } : s;
  } else if (action === "set" && key !== undefined) {
    const s = await readSettings(ctx);
    s[key] = value;
    await writeSettings(s, ctx);
    result = { ok: true, [key]: value };
  } else {
    result = { error: "Invalid action" };
  }
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
  };
}
