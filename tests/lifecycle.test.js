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

test('生命周期负责初始化状态、清理离开角色、安装内置主题并停止主题同步', () => {
  assert.match(source, /await ensureStore\(ctx\)/);
  assert.match(source, /await cleanupDepartedVisitors\(ctx\)/);
  assert.match(source, /installBundledThemes\(ctx\)/);
  assert.match(source, /startThemeSync\(ctx\)/);
  assert.match(source, /stopThemeSync\(\)/);
});

test('内置主题文件存在、含暗色覆盖并在默认内容索引中登记', () => {
  const themePath = new URL('../sillytavern/default/content/themes/薄荷手帐 · 简约.json', import.meta.url);
  const theme = JSON.parse(readFileSync(themePath, 'utf8'));
  assert.equal(theme.name, '薄荷手帐 · 简约');
  assert.ok(typeof theme.custom_css === 'string' && theme.custom_css.includes('hana-dark'));

  const index = JSON.parse(readFileSync(new URL('../sillytavern/default/content/index.json', import.meta.url), 'utf8'));
  assert.ok(index.some((item) => item.type === 'theme' && item.filename === 'themes/薄荷手帐 · 简约.json'));
});

test('酒馆默认主题指向内置的「薄荷手帐 · 简约」', () => {
  const settingsPath = new URL('../sillytavern/default/content/settings.json', import.meta.url);
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(settings.power_user.theme, '薄荷手帐 · 简约');
});

test('干净安装包未装依赖时，插件入口不会静态加载 YAML', () => {
  assert.doesNotMatch(charactersSource, /from ['\"]yaml['\"]/);
  assert.match(charactersSource, /require\(['\"]yaml['\"]\)/);
  assert.match(charactersSource, /sillytavern['\"].*node_modules['\"].*yaml/);
});
