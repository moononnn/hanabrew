import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { REGISTRY_ANCHOR, THEME_ENTRY, patchLocaleSource, patchRegistrySource } from '../lib/theme-installer.js';

function write(file, text) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text, 'utf8'); }
test('主题注册表补丁幂等且遇到未知结构会停止', () => {
  const source = `const x={${REGISTRY_ANCHOR}};theme-registry:`;
  const first = patchRegistrySource(source);
  assert.equal(first.changed, true);
  assert.equal(first.text.split(THEME_ENTRY).length - 1, 1);
  assert.equal(patchRegistrySource(first.text).changed, false);
  assert.throws(() => patchRegistrySource('const x = {};'), /结构与已知版本不同/);
});
test('语言包补丁只写入两个主题名称', () => {
  const result = patchLocaleSource(JSON.stringify({ settings: { appearance: { coral: 'Coral' } } }), { name: '小花薄荷手帐', mode: '薄荷纸本' });
  const appearance = JSON.parse(result.text).settings.appearance;
  assert.equal(appearance.xiaohuaMint, '小花薄荷手帐');
  assert.equal(appearance.xiaohuaMintMode, '薄荷纸本');
});
test('主题源码已迁入花酿目录', () => {
  const file = new URL('../theme/xiaohua-mint.css', import.meta.url);
  assert.match(readFileSync(file, 'utf8'), /data-theme="xiaohua-mint"/);
});
