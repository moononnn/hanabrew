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

test('内置主题只在目标缺失时写入，不覆盖已有文件', async () => {
  const { installBundledThemes } = await import('../index.js');
  const { join } = await import('node:path');
  const { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');

  const sandbox = join(tmpdir(), `hanabrew-test-${Date.now()}`);
  const prevAppData = process.env.APPDATA;
  process.env.APPDATA = sandbox;
  try {
    const themeDir = join(sandbox, 'hanabrew', 'st-data', 'default-user', 'themes');
    const themeFile = join(themeDir, '薄荷手帐 · 简约.json');

    // 首次：缺失时写入
    installBundledThemes({});
    assert.ok(existsSync(themeFile), '首次应写入内置主题');

    // 再次：用户改过之后不被覆盖
    writeFileSync(themeFile, '{"name":"用户自己改过的主题"}', 'utf8');
    installBundledThemes({});
    assert.equal(readFileSync(themeFile, 'utf8'), '{"name":"用户自己改过的主题"}', '已有文件不得被覆盖');
  } finally {
    if (prevAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = prevAppData;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('干净安装包未装依赖时，插件入口不会静态加载 YAML', () => {
  assert.doesNotMatch(charactersSource, /from ['\"]yaml['\"]/);
  assert.match(charactersSource, /require\(['\"]yaml['\"]\)/);
  assert.match(charactersSource, /sillytavern['\"].*node_modules['\"].*yaml/);
});
