import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';

export const THEME_ID = 'xiaohua-mint';
export const THEME_NAME = '小花薄荷手帐';
export const THEME_ENTRY = `"${THEME_ID}":{cssPath:"themes/${THEME_ID}.css",backgroundColor:"#F7F4EA",appearance:"light",i18nName:"settings.appearance.xiaohuaMint",i18nMode:"settings.appearance.xiaohuaMintMode"}`;
export const REGISTRY_ANCHOR = 'coral:{cssPath:"themes/coral.css",backgroundColor:"#FDF6EC",appearance:"light",i18nName:"settings.appearance.coral",i18nMode:"settings.appearance.coralMode"}';
const POINTER_FILE = join('artifacts', 'pointers', 'beta.renderer.current.json');
const LOCALE_TEXT = {
  'zh.json': { name: '小花薄荷手帐', mode: '薄荷纸本' },
  'zh-TW.json': { name: '小花薄荷手帳', mode: '薄荷紙本' },
  'en.json': { name: 'Hanako Mint Journal', mode: 'Mint Paper' },
  'ja.json': { name: '小花ミント手帳', mode: 'ミント紙' },
  'ko.json': { name: '샤오화 민트 다이어리', mode: '민트 페이퍼' },
};
const count = (text, needle) => text.split(needle).length - 1;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const writeJson = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); };
function inside(parent, child) { const rel = relative(resolve(parent), resolve(child)); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..'); }

export function resolveCurrentRenderer(hanaHome = join(homedir(), '.hanako')) {
  const pointerPath = join(hanaHome, POINTER_FILE);
  if (!existsSync(pointerPath)) throw new Error('没有找到 Hana 当前前端版本指针');
  const pointer = readJson(pointerPath);
  const rendererRoot = join(hanaHome, 'artifacts', 'renderer');
  const versionDir = resolve(String(pointer.versionDir || ''));
  if (!pointer.version || !inside(rendererRoot, versionDir)) throw new Error('当前前端版本指针不完整或路径不安全');
  if (!existsSync(versionDir) || !statSync(versionDir).isDirectory()) throw new Error(`当前前端目录不存在：${versionDir}`);
  return { pointerPath, versionDir, version: String(pointer.version) };
}

export function patchRegistrySource(source, label = '主题注册表') {
  if (count(source, THEME_ENTRY) === 1) return { text: source, changed: false };
  if (count(source, THEME_ENTRY) > 1 || count(source, REGISTRY_ANCHOR) !== 1) throw new Error(`${label} 结构与已知版本不同，已停止修改`);
  const text = source.replace(REGISTRY_ANCHOR, `${REGISTRY_ANCHOR},${THEME_ENTRY}`);
  if (count(text, THEME_ENTRY) !== 1) throw new Error(`${label} 修改后自检失败`);
  return { text, changed: true };
}

export function patchLocaleSource(source, translation, label = '语言包') {
  const data = JSON.parse(source);
  const appearance = data?.settings?.appearance;
  if (!appearance || typeof appearance !== 'object' || Array.isArray(appearance)) throw new Error(`${label} 缺少 settings.appearance，已停止修改`);
  const changed = appearance.xiaohuaMint !== translation.name || appearance.xiaohuaMintMode !== translation.mode;
  appearance.xiaohuaMint = translation.name;
  appearance.xiaohuaMintMode = translation.mode;
  return { text: `${JSON.stringify(data, null, 2)}\n`, changed };
}

export function findRendererBundle(versionDir) {
  const candidates = readdirSync(join(versionDir, 'assets'))
    .filter((name) => /^index-[A-Za-z0-9_-]+\.js$/.test(name))
    .map((name) => join(versionDir, 'assets', name))
    .filter((file) => { const text = readFileSync(file, 'utf8'); return text.includes(REGISTRY_ANCHOR) && text.includes('theme-registry:'); });
  if (candidates.length !== 1) throw new Error(`找到 ${candidates.length} 个主题主文件，当前版本暂不兼容`);
  return candidates[0];
}

function replaceFile(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const next = `${file}.hanabrew-next-${nonce}`;
  const old = `${file}.hanabrew-old-${nonce}`;
  writeFileSync(next, content);
  let moved = false;
  try { if (existsSync(file)) { renameSync(file, old); moved = true; } renameSync(next, file); if (moved) unlinkSync(old); }
  catch (error) { if (existsSync(next)) rmSync(next, { force: true }); if (moved && existsSync(old) && !existsSync(file)) renameSync(old, file); throw error; }
}

function backupTargets(targets, versionDir, backupRoot, version) {
  const dir = join(backupRoot, `${version}_${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const files = [];
  for (const target of targets) {
    const relPath = relative(versionDir, target.file).replaceAll('\\', '/');
    if (target.original) { const backup = join(dir, relPath); mkdirSync(dirname(backup), { recursive: true }); writeFileSync(backup, target.original); }
    files.push({ relPath, existed: Boolean(target.original), originalSha256: target.original ? sha256(target.original) : null, patchedSha256: sha256(target.next) });
  }
  writeJson(join(dir, 'backup.json'), { version, versionDir, createdAt: new Date().toISOString(), files });
  return dir;
}

export function inspectTheme({ hanaHome } = {}) {
  const current = resolveCurrentRenderer(hanaHome);
  let bundle;
  try { bundle = findRendererBundle(current.versionDir); } catch (error) { return { ok: false, compatible: false, installed: false, version: current.version, versionDir: current.versionDir, error: error.message }; }
  const themeJs = readFileSync(join(current.versionDir, 'lib', 'theme.js'), 'utf8');
  const bundleText = readFileSync(bundle, 'utf8');
  const localeOk = Object.keys(LOCALE_TEXT).every((name) => { try { const data = readJson(join(current.versionDir, 'locales', name)); return Boolean(data?.settings?.appearance?.xiaohuaMint && data?.settings?.appearance?.xiaohuaMintMode); } catch { return false; } });
  return { ok: true, compatible: count(themeJs, REGISTRY_ANCHOR) === 1 && count(bundleText, REGISTRY_ANCHOR) === 1, installed: count(themeJs, THEME_ENTRY) === 1 && count(bundleText, THEME_ENTRY) === 1 && existsSync(join(current.versionDir, 'themes', `${THEME_ID}.css`)) && localeOk, version: current.version, versionDir: current.versionDir, cssPath: join(current.versionDir, 'themes', `${THEME_ID}.css`) };
}

export function installTheme({ hanaHome, pluginDir, backupRoot }) {
  const current = resolveCurrentRenderer(hanaHome);
  const bundle = findRendererBundle(current.versionDir);
  const targets = [];
  for (const [file, label] of [[join(current.versionDir, 'lib', 'theme.js'), '主题加载器'], [bundle, '设置页主题注册表']]) {
    const original = readFileSync(file, 'utf8'); const patched = patchRegistrySource(original, label); targets.push({ file, original: Buffer.from(original), next: Buffer.from(patched.text), changed: patched.changed });
  }
  for (const [name, translation] of Object.entries(LOCALE_TEXT)) { const file = join(current.versionDir, 'locales', name); const original = readFileSync(file, 'utf8'); const patched = patchLocaleSource(original, translation, name); targets.push({ file, original: Buffer.from(original), next: Buffer.from(patched.text), changed: patched.changed }); }
  const css = join(current.versionDir, 'themes', `${THEME_ID}.css`); const source = join(pluginDir, 'theme', `${THEME_ID}.css`); if (!existsSync(source)) throw new Error('花酿缺少主题样式文件'); const original = existsSync(css) ? readFileSync(css) : null; const next = readFileSync(source); targets.push({ file: css, original, next, changed: !original || !original.equals(next) });
  const changed = targets.filter((target) => target.changed); if (!changed.length) return { ok: true, changed: false, ...inspectTheme({ hanaHome }) };
  const backupDir = backupTargets(changed, current.versionDir, backupRoot, current.version); const written = [];
  try { for (const target of changed) { replaceFile(target.file, target.next); written.push(target); } }
  catch (error) { for (const target of written.reverse()) { try { target.original ? replaceFile(target.file, target.original) : rmSync(target.file, { force: true }); } catch {} } throw new Error(`安装没有完成，已尝试恢复原文件：${error.message}`); }
  return { ok: true, changed: true, version: current.version, backupDir, filesChanged: changed.map((target) => relative(current.versionDir, target.file).replaceAll('\\', '/')), restartRequired: true };
}

function listBackups(root, version) { if (!existsSync(root)) return []; return readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.startsWith(`${version}_`)).map((e) => join(root, e.name)).filter((dir) => existsSync(join(dir, 'backup.json'))).sort().reverse(); }
export function restoreTheme({ hanaHome, backupRoot }) {
  const current = resolveCurrentRenderer(hanaHome); const dir = listBackups(backupRoot, current.version)[0]; if (!dir) throw new Error(`没有找到 ${current.version} 的可恢复备份`); const manifest = readJson(join(dir, 'backup.json')); if (resolve(manifest.versionDir) !== resolve(current.versionDir)) throw new Error('备份与当前前端目录不匹配，已停止恢复');
  for (const file of manifest.files) { const target = join(current.versionDir, file.relPath); if (!inside(current.versionDir, target)) throw new Error('备份包含不安全路径，已停止恢复'); if (existsSync(target) && sha256(readFileSync(target)) !== file.patchedSha256) throw new Error(`文件已被其他更新改动，未覆盖：${file.relPath}`); }
  for (const file of manifest.files) { const target = join(current.versionDir, file.relPath); file.existed ? replaceFile(target, readFileSync(join(dir, file.relPath))) : rmSync(target, { force: true }); }
  return { ok: true, changed: true, version: current.version, backupDir: dir, restartRequired: true };
}
export const defaultBackupRoot = (dataDir) => join(dataDir, 'backups');
