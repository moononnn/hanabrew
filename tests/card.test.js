import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import registerPageRoutes, { renderEmbeddedPage } from '../routes/page-entry.js';
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

test('manifest 注册了插件页面（内嵌酒馆）与角色卡体检卡片', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  // contributes.page 是宿主插件页面入口（DSHana 同款机制），指向内嵌酒馆；同时兼容旧布局实例的恢复。
  const page = manifest.contributes?.page;
  assert.equal(page?.route, '/tavern');
  assert.ok(page?.title, 'page contribution should carry a title');
  const theaterCard = manifest.contributes?.cards?.find((item) => item.id === 'theater');
  assert.equal(theaterCard?.type, 'webview');
  assert.equal(theaterCard?.title, '花酿 · 体检');
  assert.equal(theaterCard?.route, '/card/theater');
  assert.match(theaterCard?.description || '', /帮我测一下这张角色卡/);
});
