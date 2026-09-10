import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWorldBook,
  deleteWorldBook,
  getWorldBook,
  listWorldBooks,
  updateWorldBook,
} from '../backend/worldbook.js';

let root;
let previousAppData;

before(() => {
  previousAppData = process.env.APPDATA;
  root = join(tmpdir(), `hanabrew-worldbook-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  process.env.APPDATA = join(root, 'appdata');
  mkdirSync(join(process.env.APPDATA, 'hanabrew'), { recursive: true });
});

after(() => {
  if (previousAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = previousAppData;
  rmSync(root, { recursive: true, force: true });
});

test('独立世界书支持创建、读取、局部更新和删除', async () => {
  const book = await createWorldBook({
    name: '测试世界',
    entries: [{ keys: ['门'], content: '门后有风。' }],
  });
  assert.match(book.id, /^wb-[0-9]+-[a-z0-9]+$/);
  assert.deepEqual((await getWorldBook(book.id)).entries, book.entries);
  assert.equal((await listWorldBooks()).find((item) => item.id === book.id).entries, 1);

  const updated = await updateWorldBook(book.id, { name: '更新后的世界' });
  assert.equal(updated.name, '更新后的世界');
  assert.deepEqual(updated.entries, book.entries, '只更新名称时不能清空条目');
  assert.ok(existsSync(join(process.env.APPDATA, 'hanabrew', 'st-data', 'default-user', 'worlds', `${book.id}.json`)));
  assert.equal(await deleteWorldBook(book.id), true);
  assert.equal(await getWorldBook(book.id), null);
  assert.equal(await deleteWorldBook(book.id), false);
});
