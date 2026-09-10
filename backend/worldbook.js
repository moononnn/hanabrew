// Backend Worldbooks — 独立世界书 CRUD
// 保存到 SillyTavern 的 %APPDATA%\hanabrew\st-data\default-user\worlds\ 目录。

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { stDataRoot } from "./store.js";

function generateId() {
  return `wb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function worldBookDir(ctx = {}) {
  return join(stDataRoot(ctx), "worlds");
}

function worldBookFile(bookId, ctx = {}) {
  const id = String(bookId || '').trim();
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('非法的世界书编号。');
  return join(worldBookDir(ctx), `${id}.json`);
}

function listWorldBookFiles(ctx = {}) {
  const dir = worldBookDir(ctx);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith(".json"));
}

/**
 * List all world books
 */
export async function listWorldBooks(ctx = {}) {
  const files = listWorldBookFiles(ctx);
  return files.map(f => {
    try {
      const data = JSON.parse(readFileSync(join(worldBookDir(ctx), f), "utf-8"));
      return { id: data.id, name: data.name, entries: data.entries?.length || 0 };
    } catch {
      return { id: f.replace(".json", ""), name: f, entries: 0 };
    }
  });
}

/**
 * Create a new world book
 */
export async function createWorldBook({ name, entries = [] } = {}, ctx = {}) {
  const id = generateId();
  const dir = worldBookDir(ctx);
  mkdirSync(dir, { recursive: true });
  const wb = {
    id,
    name: String(name || "Untitled").trim() || "Untitled",
    entries: Array.isArray(entries) ? entries : [],
    createdAt: new Date().toISOString(),
  };
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(wb, null, 2), "utf-8");
  return wb;
}

/**
 * Get a world book by ID
 */
export async function getWorldBook(bookId, ctx = {}) {
  const file = worldBookFile(bookId, ctx);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf-8"));
}

/**
 * Update a world book (保留未传入的字段，避免局部编辑清空 entries)
 */
export async function updateWorldBook(bookId, data = {}, ctx = {}) {
  const current = await getWorldBook(bookId, ctx);
  if (!current) return null;
  const file = worldBookFile(bookId, ctx);
  const updated = {
    ...current,
    ...(data && typeof data === 'object' ? data : {}),
    id: String(bookId).trim(),
    updatedAt: new Date().toISOString(),
  };
  if (!Array.isArray(updated.entries)) updated.entries = [];
  writeFileSync(file, JSON.stringify(updated, null, 2), "utf-8");
  return updated;
}

/**
 * Delete a world book
 */
export async function deleteWorldBook(bookId, ctx = {}) {
  const file = worldBookFile(bookId, ctx);
  if (!existsSync(file)) return false;
  unlinkSync(file);
  return true;
}
