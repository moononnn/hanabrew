/**
 * Tool: tavern-debug — inspect plugin state, logs, and error traces
 */
export const name = "tavern-debug";
export const description = "Inspect 花酿 plugin state, character summaries, redacted settings, and diagnostic information. Sensitive settings are never returned.";

export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["logs", "state", "characters", "settings", "trace"],
      description: "What to inspect: logs (recent API/console logs), state (plugin state), characters (list all), settings (current settings), trace (full debug dump)"
    },
    limit: {
      type: "number",
      description: "Max number of log entries (default 50)"
    },
    traceId: {
      type: "string",
      description: "Specific trace ID to look up (for action=trace)"
    }
  },
  required: ["action"]
};

export async function execute({ action, limit = 50, traceId }, ctx = {}) {
  const { readState, readSettings, paths } = await import("../backend/store.js");
  const { redactSettings } = await import("./tavern-settings.js");
  const { listCharacters } = await import("../backend/characters.js");
  const { readdirSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");

  let result;

  switch (action) {
    case "logs": {
      const state = await readState(ctx);
      const chars = await listCharacters(ctx, { shallow: true });
      result = {
        pluginLoaded: state.pluginLoadedAt || "unknown",
        characterCount: chars.length,
        activeCharacterId: state.activeCharacterId,
        storeRoot: paths(ctx).root,
      };
      break;
    }

    case "state": {
      const state = await readState(ctx);
      result = { state };
      break;
    }

    case "characters": {
      const chars = await listCharacters(ctx, { shallow: true });
      result = {
        count: chars.length,
        characters: chars.map(c => ({
          id: c.id, name: c.name, avatarPath: c.avatarPath, tags: c.tags, createdAt: c.createdAt,
        }))
      };
      break;
    }

    case "settings": {
      const settings = await readSettings(ctx);
      result = { settings: redactSettings(settings) };
      break;
    }

    case "trace": {
      const state = await readState(ctx);
      const settings = await readSettings(ctx);
      const chars = await listCharacters(ctx, { shallow: true });
      const p = paths(ctx);
      let storeFiles = [];
      try { storeFiles = readdirSync(p.root); } catch {}
      result = {
        pluginState: state,
        settings: redactSettings(settings),
        characters: chars.map(c => ({ id: c.id, name: c.name })),
        storeRoot: p.root, storeFiles,
        storeDirs: { characters: p.characters, chats: p.chats, rooms: p.rooms },
      };
      break;
    }

    default:
      result = { error: "Unknown action: " + action };
  }

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
  };
}
