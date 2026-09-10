import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const charactersSource = readFileSync(new URL('../backend/characters.js', import.meta.url), 'utf8');

test('插件默认入口通过实例 this.ctx 调用 onload/onunload', () => {
  assert.match(source, /class HanabrewPlugin/);
  assert.match(source, /async onload\(\)\s*\{[\s\S]*return onload\(this\.ctx\)/);
  assert.match(source, /async onunload\(\)\s*\{[\s\S]*return onunload\(this\.ctx\)/);
  assert.match(source, /export default HanabrewPlugin/);
});

test('生命周期负责初始化状态、清理离开角色并停止主题同步', () => {
  assert.match(source, /await ensureStore\(ctx\)/);
  assert.match(source, /await cleanupDepartedVisitors\(ctx\)/);
  assert.match(source, /startThemeSync\(ctx\)/);
  assert.match(source, /stopThemeSync\(\)/);
});

test('干净安装包未装依赖时，插件入口不会静态加载 YAML', () => {
  assert.doesNotMatch(charactersSource, /from ['\"]yaml['\"]/);
  assert.match(charactersSource, /require\(['\"]yaml['\"]\)/);
  assert.match(charactersSource, /sillytavern['\"].*node_modules['\"].*yaml/);
});
