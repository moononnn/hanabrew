// Backend Worldbooks — 世界书 CRUD
// 占位实现：保存到 %APPDATA%\hanabrew\worldbooks\ 目录的 JSON 文件
// 注：v0.3 阶段只实现 list/create/get；update/delete 可后续扩展

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { paths, stDataRoot } from "./store.js";

function generateId() {
  return `wb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function worldBookDir(ctx = {}) {
  return join(stDataRoot(ctx), "worlds");
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
  const wb = { id, name: name || "Untitled", entries, createdAt: new Date().toISOString() };
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(wb, null, 2), "utf-8");
  return wb;
}

/**
 * Get a world book by ID
 */
export async function getWorldBook(bookId, ctx = {}) {
  const file = join(worldBookDir(ctx), `${bookId}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf-8"));
}

/**
 * Update a world book (full replace)
 */
export async function updateWorldBook(bookId, data, ctx = {}) {
  const file = join(worldBookDir(ctx), `${bookId}.json`);
  if (!existsSync(file)) return null;
  const updated = { ...data, id: bookId, updatedAt: new Date().toISOString() };
  writeFileSync(file, JSON.stringify(updated, null, 2), "utf-8");
  return updated;
}

/**
 * Delete a world book
 */
export async function deleteWorldBook(bookId, ctx = {}) {
  const file = join(worldBookDir(ctx), `${bookId}.json`);
  if (!existsSync(file)) return false;
  unlinkSync(file);
  return true;
}
