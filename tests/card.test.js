import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import registerPageRoutes, { renderDepsPage, renderEmbeddedPage } from '../routes/page-entry.js';
import { stopThemeSync } from '../backend/theme-sync.js';

after(() => stopThemeSync());

test('旧 Edge 路由保留，主 page 入口转到内嵌酒馆', async () => {
  const registered = [];
  const app = { get(path, handler) { registered.push([path, handler]); } };
  await registerPageRoutes(app, {});
  assert.deepEqual(registered.map(([path]) => path), ['/api/tavern/theme-sync', '/legacy', '/tavern', '/page']);
  const redirect = registered[3][1]({
    req: { url: 'http://hana.test/api/plugins/hanabrew/page?pluginSurfaceSession=demo' },
    redirect(url) { return url; },
  });
  assert.equal(redirect, 'http://hana.test/api/plugins/hanabrew/tavern?pluginSurfaceSession=demo');
});

test('主题同步接口返回宿主暗色状态', async () => {
  const registered = [];
  const app = { get(path, handler) { registered.push([path, handler]); } };
  await registerPageRoutes(app, {});
  const handler = registered[0][1];
  let result;
  handler({ json: (body) => { result = body; return body; } });
  assert.equal(typeof result.dark, 'boolean');
  assert.equal(typeof result.theme, 'string');
});

test('SillyTavern 允许由 Hana 页面 iframe 内嵌', () => {
  const server = readFileSync(new URL('../sillytavern/src/server-main.js', import.meta.url), 'utf8');
  assert.match(server, /frameguard:\s*false/);
  assert.match(server, /crossOriginResourcePolicy:\s*false/);
});

test('内嵌酒馆页面输出本地 ST iframe 和 Hana 握手', () => {
  const html = renderEmbeddedPage({ serverUrl: 'http://127.0.0.1:18500/' });
  assert.match(html, /<iframe id="st-frame"/);
  assert.match(html, /http:\/\/127\.0\.0\.1:18500\//);
  assert.match(html, /type: 'hana\.ready'/);
});

test('manifest 注册两张独立卡片，且不再保留重复的旧酒馆页面入口', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.contributes?.page, undefined);
  const cards = manifest.contributes?.cards || [];
  assert.equal(cards.length, 2);
  const workspaceCard = cards.find((item) => item.id === 'workspace');
  const tavernCard = cards.find((item) => item.id === 'tavern');
  assert.equal(workspaceCard?.type, 'webview');
  assert.equal(workspaceCard?.title, '花酿·工作台');
  assert.equal(workspaceCard?.route, '/card/visitor');
  assert.equal(workspaceCard?.face?.image, 'workspace.png');
  assert.match(workspaceCard?.description || '', /角色来访/);
  assert.equal(tavernCard?.type, 'webview');
  assert.equal(tavernCard?.title, '花酿·酒馆');
  assert.equal(tavernCard?.route, '/tavern');
  assert.equal(tavernCard?.face?.image, 'tavern.png');
  assert.doesNotMatch(JSON.stringify(manifest), /内嵌酒馆/);
  assert.doesNotMatch(JSON.stringify(cards), /轻聊/);
});

test('依赖失败页的「强制重试」走当前入口，不写死 /legacy', () => {
  const html = renderDepsPage({ status: 'failed', message: '网络不通' });
  assert.match(html, /href="\?retryDeps=1"/, '重试按钮应是相对链接，主入口与备用入口都能用');
  assert.doesNotMatch(html, /\/legacy\?retryDeps=1/, '不应把主入口的用户另指到 /legacy');
  assert.match(html, /依赖安装失败/);
});

test('依赖安装中的页面会自动刷新', () => {
  const html = renderDepsPage({ status: 'installing' });
  assert.match(html, /http-equiv="refresh"/);
  assert.match(html, /正在安装酒馆引擎依赖/);
});
