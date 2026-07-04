export const name = "tavern-worldbook";
export const description = "Manage world books — list, create, edit entries.";
export const parameters = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["list", "create", "get"] },
  },
  required: ["action"]
};
export async function execute({ action }, ctx = {}) {
  const { listWorldBooks, createWorldBook, getWorldBook } = await import("../backend/worldbook.js");
  let result;
  switch (action) {
    case "list":
      result = await listWorldBooks(ctx);
      break;
    case "create":
      result = await createWorldBook(ctx);
      break;
    case "get":
      result = await getWorldBook(ctx);
      break;
    default:
      result = { error: "Unknown action: " + action };
  }
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
  };
}
