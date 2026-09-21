import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { defaultBackupRoot, inspectTheme, installTheme, restoreTheme } from './theme-installer.js';

let runtimeCtx = null;
const oldDataDir = join(homedir(), '.hanako', 'plugin-data', 'xiaohua-mint-theme');
function json(file, fallback) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } }
function settingsPath() { return join(runtimeCtx.dataDir, 'theme-settings.json'); }
function settings() {
  const current = json(settingsPath(), null) || json(join(oldDataDir, 'settings.json'), {});
  return { autoRepair: current.autoRepair === true, backupRoot: typeof current.backupRoot === 'string' && current.backupRoot.trim() ? current.backupRoot.trim() : defaultBackupRoot(runtimeCtx.dataDir) };
}
function save(patch) { const next = { ...settings(), ...patch }; mkdirSync(runtimeCtx.dataDir, { recursive: true }); writeFileSync(settingsPath(), `${JSON.stringify(next, null, 2)}\n`, 'utf8'); return next; }
export function configure(ctx) { runtimeCtx = ctx; }
export function getThemeStatus() { const current = settings(); try { return { ...inspectTheme(), settings: current }; } catch (error) { return { ok: false, compatible: false, installed: false, error: error.message, settings: current }; } }
export function installMintTheme() { const current = settings(); const result = installTheme({ pluginDir: runtimeCtx.pluginDir, backupRoot: current.backupRoot }); save({ autoRepair: true }); return { ...result, settings: settings() }; }
export function restoreMintTheme() { const result = restoreTheme({ backupRoot: settings().backupRoot }); save({ autoRepair: false }); return { ...result, settings: settings() }; }
export function autoRepairMintTheme() { if (!settings().autoRepair) return { ok: true, skipped: true }; const status = getThemeStatus(); if (status.installed) return { ok: true, skipped: true, reason: 'already-installed' }; try { return installMintTheme(); } catch (error) { runtimeCtx.log?.warn?.(`[hanabrew] 薄荷手帐自动装回暂停：${error.message}`); return { ok: false, error: error.message }; } }
