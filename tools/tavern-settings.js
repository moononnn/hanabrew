export const name = "tavern-settings";
export const description = "Get or update 花酿 settings (model, API, presets, theme); sensitive keys are redacted from tool responses.";
export const parameters = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["get", "set"] },
    key: { type: "string" },
    value: {}
  },
  required: ["action"]
};
const SENSITIVE_KEY = /(api.?key|token|secret|password|passwd|credential|cookie|authorization)/i;

export function redactSettings(value, key = '') {
  if (SENSITIVE_KEY.test(String(key))) return '[已隐藏]';
  if (Array.isArray(value)) return value.map((item) => redactSettings(item, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redactSettings(childValue, childKey)]));
  }
  return value;
}

export async function execute({ action, key, value }, ctx = {}) {
  const { readSettings, writeSettings } = await import("../backend/store.js");
  let result;
  if (action === "get") {
    const s = await readSettings(ctx);
    result = key ? { [key]: redactSettings(s[key], key) } : redactSettings(s);
  } else if (action === "set" && key !== undefined) {
    const s = await readSettings(ctx);
    s[key] = value;
    await writeSettings(s, ctx);
    result = { ok: true, [key]: redactSettings(value, key) };
  } else {
    result = { error: "Invalid action" };
  }
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
  };
}
