export const name = "tavern-worldbook";
export const description = "Manage world books — list, create, read, update, or delete entries.";
export const parameters = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["list", "create", "get", "update", "delete"] },
    bookId: { type: "string", description: "World book ID (required for get/update/delete)." },
    name: { type: "string", description: "World book name (for create/update)." },
    entries: { type: "array", description: "World book entries (for create/update).", items: { type: "object" } },
    data: { type: "object", description: "Additional world book fields for update." },
  },
  required: ["action"],
};

export async function execute({ action, bookId, name, entries, data }, ctx = {}) {
  const { listWorldBooks, createWorldBook, getWorldBook, updateWorldBook, deleteWorldBook } =
    await import("../backend/worldbook.js");

  try {
    let result;
    switch (action) {
      case "list":
        result = await listWorldBooks(ctx);
        break;
      case "create":
        result = await createWorldBook({ name, entries }, ctx);
        break;
      case "get":
        if (!String(bookId || '').trim()) return textResult({ ok: false, error: "读取世界书需要 bookId。" });
        result = await getWorldBook(bookId, ctx);
        if (!result) return textResult({ ok: false, error: "找不到这本世界书。" });
        break;
      case "update": {
        if (!String(bookId || '').trim()) return textResult({ ok: false, error: "更新世界书需要 bookId。" });
        const patch = data && typeof data === 'object' ? { ...data } : {};
        if (name !== undefined) patch.name = name;
        if (entries !== undefined) patch.entries = entries;
        result = await updateWorldBook(bookId, patch, ctx);
        if (!result) return textResult({ ok: false, error: "找不到这本世界书。" });
        break;
      }
      case "delete":
        if (!String(bookId || '').trim()) return textResult({ ok: false, error: "删除世界书需要 bookId。" });
        result = { ok: await deleteWorldBook(bookId, ctx), bookId: String(bookId).trim() };
        break;
      default:
        result = { ok: false, error: "Unknown action: " + action };
    }
    return textResult(result);
  } catch (error) {
    return textResult({ ok: false, error: error.message || String(error) });
  }
}

function textResult(result) {
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}
