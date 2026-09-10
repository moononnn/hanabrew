// Hana「角色来访」整页卡：选择酒馆角色，创建独立临时 Agent 与主会话。

import {
  departVisitor,
  getVisitorPreview,
  getVisitorState,
  inviteVisitor,
  listVisitorCharacters,
  settleVisitor,
  uninviteVisitor,
  tavernUserName,
} from '../backend/visitors.js';
import {
  exportAgentToTavern,
  getAgentExportPreview,
  listExportableAgents,
} from '../backend/export-agent.js';
import { readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { paths } from '../backend/store.js';
import { escapeHtml, initials } from './card.js';

function renderCharacters(characters, ctx = {}, visitorByCharacter = {}) {
  if (!characters.length) {
    return '<div class="empty"><strong>酒馆里还没有角色</strong><span>先在花酿酒馆导入角色卡，再回来邀请 TA。</span></div>';
  }
  return characters.map((character) => {
    const tags = character.tags.length ? character.tags.join(' · ') : '角色卡';
    const avatarSrc = avatarDataUrl(character.avatarPath, ctx);
    const avatar = avatarSrc
      ? `<span class="avatar is-img" aria-hidden="true"><img src="${avatarSrc}" alt=""></span>`
      : `<span class="avatar">${escapeHtml(initials(character.name))}</span>`;
    const status = visitorByCharacter[character.id];
    const statusBadge = status
      ? `<span class="role-status ${status === 'resident' ? 'is-resident' : ''}">${status === 'resident' ? '已入驻' : '来访中'}</span>`
      : '';
    return `<button class="role" type="button" data-character-id="${escapeHtml(character.id)}">
      ${avatar}
      <span class="role-copy"><strong>${escapeHtml(character.name)}</strong><small>${escapeHtml(tags)}</small></span>
      ${statusBadge}
      <span class="role-arrow" aria-hidden="true">›</span>
    </button>`;
  }).join('');
}

function renderActiveVisitors(visitors) {
  if (!visitors.length) return '';
  return `<section class="visitors-now">
    <div class="visitors-head"><p class="eyebrow">正在 Hana 做客</p><span>${visitors.length} 位</span></div>
    ${visitors.map((visitor) => {
      const resident = visitor.residence === true;
      return `<article class="visitor-now${resident ? ' is-resident' : ''}">
    <div class="visitor-seal">${resident ? '已入驻' : '来访中'}</div>
    <div class="visitor-avatar">${escapeHtml(initials(visitor.characterName))}</div>
    <div class="visitor-copy">
      <p class="eyebrow">花酿 · 来访</p>
      <h1>${escapeHtml(visitor.characterName)} ${resident ? '已住下' : '已来到 Hana'}</h1>
      <p>${visitor.memoryMessageCount
        ? `带来了最近 ${escapeHtml(visitor.memoryMessageCount)} 条酒馆对话。`
        : '带来了角色设定；酒馆里暂时没有可带来的近期对话。'}</p>
      <div class="session-note"><span class="status-dot"></span>请在 Hana 的最近对话中打开「${escapeHtml(visitor.sessionTitle)}」</div>
      ${resident
        ? `<div class="resident-note"><span class="tip-mark">已入驻</span><span>TA 现在是 Hana 的常驻居民了，会出现在助手列表里，也可以继续邀请其他角色来做客。想让 TA 离开时，随时可以「请 TA 回去」。</span></div>`
        : `<div class="avatar-tip"><span class="tip-mark">小提示</span><span>Hana 侧的头像要等<b>下次重启 Hana</b>后才会显示出来（Hana 只在启动时加载新助手的头像）。现在重启一下，TA 的头像和会话就都会出现在最近对话里了。</span></div>`}
    </div>
    <div class="visitor-actions">
      ${resident
        ? `<button class="secondary uninvite" data-agent-id="${escapeHtml(visitor.agentId)}" type="button">请 TA 回去</button>`
        : `<button class="primary settle" data-agent-id="${escapeHtml(visitor.agentId)}" type="button">让 TA 住下来</button>
      <button class="secondary depart" data-agent-id="${escapeHtml(visitor.agentId)}" type="button">送 TA 回酒馆</button>`}
      <div class="status" data-status-for="${escapeHtml(visitor.agentId)}" role="status" aria-live="polite"></div>
    </div>
  </article>`;
    }).join('')}
  </section>`;
}

function modeHref(mode, surfaceSession = '', legacyToken = '') {
  const params = new URLSearchParams();
  if (mode && mode !== 'home') params.set('mode', mode);
  if (surfaceSession) params.set('pluginSurfaceSession', surfaceSession);
  if (legacyToken) params.set('token', legacyToken);
  const query = params.toString();
  return query ? `?${query}` : '?';
}

function renderDirectionHome(visitors, surfaceSession, legacyToken) {
  const toHana = modeHref('to-hana', surfaceSession, legacyToken);
  const toTavern = modeHref('to-tavern', surfaceSession, legacyToken);
  return `<header class="hero">
    <div>
      <p class="eyebrow">花酿 · 来访</p>
      <h1>想让谁来坐坐？</h1>
      <p>这里有两扇门：请酒馆里的角色来 Hana，或把一位 Hana 伙伴带去酒馆。每次都是独立快照，方向清清楚楚。</p>
    </div>
    <div class="hero-mark" aria-hidden="true">访</div>
  </header>
  <section class="direction-grid" aria-label="角色来访方向">
    <a class="direction-card is-mint" href="${escapeHtml(toHana)}">
      <span class="direction-mark" aria-hidden="true">来</span>
      <span class="direction-copy">
        <p class="eyebrow">酒馆角色 → Hana</p>
        <h2>请一位角色来 Hana</h2>
        <p>带上角色设定、世界书和最近对话，在 Hana 开一段独立的来访会话。</p>
      </span>
      <span class="direction-arrow" aria-hidden="true">→</span>
    </a>
    <a class="direction-card is-pink" href="${escapeHtml(toTavern)}">
      <span class="direction-mark" aria-hidden="true">去</span>
      <span class="direction-copy">
        <p class="eyebrow">Hana 伙伴 → 酒馆</p>
        <h2>带一位伙伴去酒馆</h2>
        <p>把 Hana 伙伴做成带记忆的角色卡，放进花酿酒馆继续聊天。</p>
      </span>
      <span class="direction-arrow" aria-hidden="true">→</span>
    </a>
  </section>
  ${visitors.length
    ? `<p class="home-current">当前有 <b>${escapeHtml(visitors.length)}</b> 位角色在 Hana 做客，进入对应方向可以继续管理。</p>`
    : '<p class="home-current is-empty">两边都可以随时进，选一扇门开始就好。</p>'}`;
}

function renderDetailHero(mode, surfaceSession, legacyToken) {
  const toTavern = mode === 'to-tavern';
  return `<header class="hero detail-hero">
    <div>
      <a class="back-link" href="${escapeHtml(modeHref('home', surfaceSession, legacyToken))}">← 返回角色来访</a>
      <p class="eyebrow">${toTavern ? 'Hana 伙伴 → 酒馆' : '酒馆角色 → Hana'}</p>
      <h1>${toTavern ? '带一位 Hana 伙伴去酒馆' : '请一位酒馆角色来 Hana'}</h1>
      <p>${toTavern
        ? '导出一张独立角色卡，带上性格与清洗后的相处回忆。酒馆里的经历不会回写 Hana。'
        : '从酒馆挑一张角色卡，带上设定和最近回忆，在 Hana 开一段独立的临时会话。'}</p>
    </div>
    <div class="hero-mark" aria-hidden="true">${toTavern ? '去' : '来'}</div>
  </header>`;
}

function renderToHanaBody(characters, visitors, visitorByCharacter, ctx) {
  return `${visitors.length ? renderActiveVisitors(visitors) : ''}
  <section class="workspace">
    <div class="panel">
      <div class="panel-head"><strong>选择角色</strong><span>${characters.length} 张</span></div>
      <div class="roles">${renderCharacters(characters, ctx, visitorByCharacter)}</div>
    </div>
    <div class="panel preview" id="preview">
      <div class="preview-empty"><strong>先选一位角色</strong><span>选中后可以确认这次会带来的角色设定和近期对话。</span></div>
    </div>
  </section>`;
}

function renderToTavernBody() {
  return `<section class="exit-panel detail-panel" id="exit-panel">
    <div class="exit-head">
      <div>
        <p class="eyebrow">Hana 伙伴 → 酒馆</p>
        <h2>选择要带走的伙伴</h2>
        <p>这是一次单向快照：带走性格、头像和清洗后的相处回忆；酒馆里的新经历不会回写 Hana。</p>
      </div>
    </div>
    <div class="exit-body" id="exit-body">
      <div class="exit-list" id="exit-list">
        <div class="empty"><strong>正在寻找 Hana 伙伴…</strong><span>稍等一下下。</span></div>
      </div>
      <div class="exit-preview" id="exit-preview"></div>
    </div>
  </section>`;
}

export function renderVisitorPage({ characters = [], visitors = [] }, ctx = {}, options = {}) {
  // 角色卡 id → 当前状态：'visiting' 来访中 / 'resident' 已入驻
  const visitorByCharacter = {};
  for (const visitor of visitors) {
    if (!visitor?.characterId) continue;
    visitorByCharacter[visitor.characterId] = visitor.residence === true ? 'resident' : 'visiting';
  }
  const mode = options.mode === 'to-tavern' || options.mode === 'to-hana' ? options.mode : 'home';
  const surfaceSession = String(options.surfaceSession || '');
  const legacyToken = String(options.legacyToken || '');
  const pageBody = mode === 'home'
    ? renderDirectionHome(visitors, surfaceSession, legacyToken)
    : `${renderDetailHero(mode, surfaceSession, legacyToken)}${mode === 'to-tavern'
      ? renderToTavernBody()
      : renderToHanaBody(characters, visitors, visitorByCharacter, ctx)}`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>花酿 · 来访</title>
<style>
  :root {
    --paper: #fffaf3;
    --paper-2: #f8f0e6;
    --white: #fffdf9;
    --mint: #5dae8e;
    --mint-deep: #3f8068;
    --mint-soft: #e4f2eb;
    --pink: #d98da5;
    --pink-soft: #f8e8ed;
    --ink: #4c4a47;
    --muted: #746f69;
    --line: #eadfd3;
    --shadow: 0 16px 40px rgba(112, 83, 65, .10);
  }
  * { box-sizing: border-box; }
  *::-webkit-scrollbar{width:8px;height:8px}
  *::-webkit-scrollbar-track{background:transparent}
  *::-webkit-scrollbar-thumb{background:#c9dfd3;border-radius:99px;border:2px solid var(--paper)}
  *::-webkit-scrollbar-thumb:hover{background:var(--mint)}
  *{scrollbar-width:thin;scrollbar-color:#c9dfd3 transparent}
  body {
    margin: 0;
    min-width: 0;
    color: var(--ink);
    background: var(--paper);
    font-family: "LXGW WenKai", "霞鹜文楷", "Noto Sans SC", system-ui, sans-serif;
  }
  button { font: inherit; }
  .page { width: min(100%, 1080px); min-height: 100vh; margin: 0 auto; padding: 30px 24px 44px; }
  .hero { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 24px; padding: 8px 2px 24px; border-bottom: 1px solid var(--line); }
  .eyebrow { margin: 0 0 6px; color: var(--mint-deep); font: 600 12px/1.4 system-ui, sans-serif; letter-spacing: .08em; }
  h1 { margin: 0; font-size: clamp(25px, 4vw, 36px); line-height: 1.25; }
  .hero p:last-child { max-width: 650px; margin: 9px 0 0; color: var(--muted); font-size: 14px; line-height: 1.7; }
  .hero-mark { display: grid; place-items: center; width: 72px; height: 72px; border: 1px solid #c7e3d5; border-radius: 22px; color: var(--mint-deep); background: var(--mint-soft); font-size: 29px; transform: rotate(2deg); }
  .detail-hero { align-items: end; }
  .back-link { display: inline-flex; align-items: center; gap: 5px; margin-bottom: 14px; color: var(--mint-deep); font: 600 12px/1.4 system-ui, sans-serif; text-decoration: none; }
  .back-link:hover { color: var(--mint); text-decoration: underline; text-underline-offset: 3px; }
  .direction-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin-top: 22px; }
  .direction-card { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 15px; min-width: 0; padding: 22px 20px; border: 1px solid var(--line); border-radius: 20px; color: var(--ink); background: var(--white); box-shadow: var(--shadow); text-decoration: none; transition: transform .16s ease, border-color .16s ease, box-shadow .16s ease; }
  .direction-card:hover { transform: translateY(-2px); border-color: #acd5c2; box-shadow: 0 18px 42px rgba(112, 83, 65, .14); }
  .direction-card.is-pink:hover { border-color: #e8b9c8; }
  .direction-mark { display: grid; place-items: center; width: 52px; height: 52px; border-radius: 16px; color: var(--mint-deep); background: var(--mint-soft); font-size: 23px; }
  .direction-card.is-pink .direction-mark { color: #a4536b; background: var(--pink-soft); }
  .direction-copy { display: grid; min-width: 0; gap: 4px; }
  .direction-copy .eyebrow { margin: 0; }
  .direction-copy h2 { margin: 0; font-size: 19px; line-height: 1.35; }
  .direction-copy p:last-child { margin: 2px 0 0; color: var(--muted); font-size: 13px; line-height: 1.65; }
  .direction-arrow { color: #a9a199; font-size: 25px; line-height: 1; }
  .direction-card.is-mint .direction-arrow { color: var(--mint); }
  .direction-card.is-pink .direction-arrow { color: var(--pink); }
  .home-current { margin: 16px 2px 0; color: var(--muted); font: 12px/1.6 system-ui, sans-serif; }
  .home-current b { color: var(--ink); }
  .home-current.is-empty { color: #9b938b; }
  .detail-panel { margin-top: 22px; }
  .workspace { display: grid; grid-template-columns: minmax(280px, .9fr) minmax(340px, 1.1fr); gap: 20px; margin-top: 22px; }
  .panel { min-width: 0; overflow: hidden; border: 1px solid var(--line); border-radius: 20px; background: var(--white); box-shadow: var(--shadow); }
  .panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 17px 18px 13px; border-bottom: 1px solid var(--line); background: var(--paper-2); }
  .panel-head strong { font-size: 15px; }
  .panel-head span { color: var(--muted); font: 12px/1.4 system-ui, sans-serif; }
  .roles { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; max-height: 520px; padding: 14px; overflow: auto; }
  .role { display: flex; align-items: center; min-width: 0; gap: 10px; padding: 11px; border: 1px solid var(--line); border-radius: 14px; color: var(--ink); background: #fff; text-align: left; cursor: pointer; transition: transform .16s ease, border-color .16s ease, background .16s ease; }
  .role:hover { transform: translateY(-1px); border-color: #acd5c2; background: #f8fcf8; }
  .role.is-selected { border-color: var(--mint); background: var(--mint-soft); }
  .avatar, .visitor-avatar { display: grid; place-items: center; flex: 0 0 auto; border-radius: 50%; color: white; background: var(--mint); }
  .avatar { width: 38px; height: 38px; font-size: 17px; }
  .avatar.is-img { overflow: hidden; background: #f2e6d4; }
  .avatar.is-img img { width: 100%; height: 100%; object-fit: cover; }
  .role:nth-child(even) .avatar { background: var(--pink); }
  .role-copy { display: grid; min-width: 0; gap: 2px; }
  .role-copy strong, .role-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .role-copy strong { font-size: 14px; }
  .role-copy small { color: var(--muted); font: 11px/1.35 system-ui, sans-serif; }
  .role-status { flex: 0 0 auto; padding: 2px 7px; border-radius: 99px; color: #a4536b; background: var(--pink-soft); font: 600 10px/1.3 system-ui, sans-serif; }
  .role-status.is-resident { color: #9c6f48; background: #f3e4d3; }
  .role-arrow { margin-left: auto; color: #a9a199; font-size: 24px; line-height: 1; }
  .preview { display: grid; align-content: start; min-height: 370px; padding: 22px; }
  .preview-empty, .empty { display: grid; place-items: center; align-content: center; gap: 7px; min-height: 260px; padding: 24px; color: var(--muted); text-align: center; }
  .preview-empty strong, .empty strong { color: var(--ink); font-size: 15px; }
  .preview-empty span, .empty span { max-width: 390px; font: 12px/1.6 system-ui, sans-serif; }
  .preview-title { display: flex; align-items: center; gap: 12px; }
  .preview-title .avatar { width: 48px; height: 48px; font-size: 21px; }
  .preview-title .avatar.is-img { overflow: hidden; background: #f2e6d4; }
  .preview-title .avatar.is-img img { width: 100%; height: 100%; object-fit: cover; }
  .preview-title h2 { margin: 0; font-size: 22px; }
  .preview-title p { margin: 4px 0 0; color: var(--muted); font: 12px/1.45 system-ui, sans-serif; }
  .carry { display: grid; gap: 9px; margin: 18px 0; padding: 15px; border: 1px solid #cce5d9; border-radius: 15px; background: var(--mint-soft); }
  .carry-row { display: flex; align-items: flex-start; gap: 9px; font-size: 13px; line-height: 1.6; }
  .check { color: var(--mint-deep); font-weight: 700; }
  .description { margin: 0 0 17px; color: var(--muted); font-size: 13px; line-height: 1.75; }
  .memory { display: grid; gap: 8px; max-height: 180px; padding: 13px; overflow: auto; border: 1px solid var(--line); border-radius: 14px; background: var(--paper); }
  .memory-label { color: var(--muted); font: 600 11px/1.4 system-ui, sans-serif; letter-spacing: .05em; }
  .memory-line { padding: 8px 10px; border-radius: 10px; background: #fff; font-size: 12px; line-height: 1.55; }
  .memory-line.user { background: #edf7f2; }
  .actions { display: flex; justify-content: flex-end; gap: 9px; margin-top: 18px; }
  .primary, .secondary { min-height: 42px; padding: 0 17px; border-radius: 12px; cursor: pointer; font-weight: 600; transition: transform .16s ease, opacity .16s ease, background .16s ease; }
  .primary { border: 0; color: white; background: var(--mint); }
  .primary:hover { background: var(--mint-deep); transform: translateY(-1px); }
  .primary:disabled { cursor: not-allowed; opacity: .55; transform: none; }
  .secondary { border: 1px solid var(--line); color: var(--ink); background: var(--white); }
  .secondary:hover { background: var(--paper-2); }
  .status { min-height: 22px; margin-top: 12px; color: var(--muted); font: 12px/1.5 system-ui, sans-serif; text-align: right; }
  .status.error { color: #b65e72; }
  .visitor-now { position: relative; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 18px; margin-top: 22px; padding: 24px; overflow: hidden; border: 1px solid #cce5d9; border-radius: 20px; background: var(--white); box-shadow: var(--shadow); }
  .visitors-now { display: grid; gap: 14px; }
  .visitors-now .visitor-now { margin-top: 0; }
  /* 伙伴出口 */
  .exit-panel { margin-top: 22px; overflow: hidden; border: 1px solid var(--line); border-radius: 20px; background: var(--white); box-shadow: var(--shadow); }
  .exit-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; padding: 18px 20px; }
  .exit-head .eyebrow { margin: 0 0 5px; }
  .exit-head h2 { margin: 0; font-size: 19px; }
  .exit-head p { max-width: 620px; margin: 7px 0 0; color: var(--muted); font-size: 13px; line-height: 1.65; }
  .exit-toggle { flex: 0 0 auto; min-height: 34px; padding: 0 14px; border: 1px solid var(--line); border-radius: 10px; color: var(--mint-deep); background: var(--white); cursor: pointer; font-weight: 600; }
  .exit-toggle:hover { background: var(--paper-2); }
  .exit-body { display: grid; grid-template-columns: minmax(260px, .9fr) minmax(320px, 1.1fr); gap: 0; border-top: 1px solid var(--line); }
  .exit-list { display: grid; gap: 8px; max-height: 440px; padding: 16px; overflow: auto; border-right: 1px solid var(--line); }
  .exit-list .empty { min-height: 120px; }
  .exit-agent { display: flex; align-items: center; min-width: 0; gap: 10px; padding: 11px 12px; border: 1px solid var(--line); border-radius: 13px; color: var(--ink); background: #fff; text-align: left; cursor: pointer; transition: border-color .16s ease, background .16s ease; }
  .exit-agent:hover { border-color: #acd5c2; background: #f8fcf8; }
  .exit-agent.is-selected { border-color: var(--mint); background: var(--mint-soft); }
  .exit-agent .avatar { width: 34px; height: 34px; font-size: 15px; }
  .exit-agent .avatar.is-img { overflow: hidden; background: #f2e6d4; }
  .exit-agent .avatar.is-img img { width: 100%; height: 100%; object-fit: cover; }
  .exit-agent-copy { display: grid; min-width: 0; gap: 2px; }
  .exit-agent-copy strong, .exit-agent-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .exit-agent-copy strong { font-size: 14px; }
  .exit-agent-copy small { color: var(--muted); font: 11px/1.35 system-ui, sans-serif; }
  .exit-agent-badge { flex: 0 0 auto; padding: 2px 7px; border-radius: 99px; color: var(--mint-deep); background: var(--mint-soft); font: 600 10px/1.3 system-ui, sans-serif; }
  .exit-preview { display: grid; align-content: start; gap: 14px; padding: 20px; }
  .exit-preview-empty { display: grid; place-items: center; align-content: center; gap: 6px; min-height: 180px; padding: 20px; color: var(--muted); text-align: center; }
  .exit-preview-empty strong { color: var(--ink); font-size: 14px; }
  .exit-preview-empty span { max-width: 340px; font: 12px/1.6 system-ui, sans-serif; }
  .exit-preview-title { display: flex; align-items: center; gap: 12px; }
  .exit-preview-title .avatar { width: 46px; height: 46px; font-size: 20px; }
  .exit-preview-title .avatar.is-img { overflow: hidden; background: #f2e6d4; }
  .exit-preview-title .avatar.is-img img { width: 100%; height: 100%; object-fit: cover; }
  .exit-preview-title h3 { margin: 0; font-size: 20px; }
  .exit-preview-title p { margin: 3px 0 0; color: var(--muted); font: 12px/1.45 system-ui, sans-serif; }
  .exit-carry { display: grid; gap: 7px; padding: 13px 15px; border: 1px solid #cce5d9; border-radius: 14px; background: var(--mint-soft); }
  .exit-carry-row { display: flex; align-items: flex-start; gap: 8px; font-size: 13px; line-height: 1.6; }
  .exit-carry-row .check { color: var(--mint-deep); font-weight: 700; }
  .exit-note { padding: 10px 13px; border: 1px solid #e6d3be; border-radius: 12px; color: var(--muted); background: #faf3e9; font-size: 12px; line-height: 1.6; }
  .exit-note b { color: #9c6f48; font-weight: 700; }
  .exit-memory { display: grid; gap: 6px; max-height: 150px; padding: 12px 13px; overflow: auto; border: 1px solid var(--line); border-radius: 13px; background: var(--paper); }
  .exit-memory-label { color: var(--muted); font: 600 11px/1.4 system-ui, sans-serif; letter-spacing: .05em; }
  .exit-memory-line { padding: 7px 9px; border-radius: 9px; background: #fff; font-size: 12px; line-height: 1.55; }
  .exit-actions { display: flex; justify-content: flex-end; gap: 9px; margin-top: 4px; }
  .exit-actions .status { margin-top: 8px; }
  .exit-done { display: grid; place-items: center; gap: 10px; min-height: 220px; padding: 26px; text-align: center; }
  .exit-done-mark { display: grid; place-items: center; width: 58px; height: 58px; border-radius: 50%; color: #fff; background: var(--mint); font-size: 28px; }
  .exit-done h3 { margin: 0; font-size: 20px; }
  .exit-done p { max-width: 420px; margin: 0; color: var(--muted); font-size: 13px; line-height: 1.7; }
  @media (max-width: 760px) {
    .exit-body { grid-template-columns: 1fr; }
    .exit-list { max-height: 240px; border-right: 0; border-bottom: 1px solid var(--line); }
    .exit-head { flex-direction: column; }
  }
  .visitors-head { display: flex; align-items: baseline; gap: 10px; margin: 22px 2px 0; }
  .visitors-head .eyebrow { margin: 0; }
  .visitors-head span { color: var(--muted); font: 12px/1.4 system-ui, sans-serif; }
  .visitor-now.is-resident { border-color: #e3c9b5; background: linear-gradient(180deg, #fffdf9, #fdf6ec); }
  .visitor-now.is-resident .visitor-seal { color: #9c6f48; background: #f3e4d3; }
  .visitor-now.is-resident .visitor-avatar { background: #c49a6c; }
  .visitor-seal { position: absolute; top: 14px; right: 18px; padding: 4px 9px; border-radius: 99px; color: #a4536b; background: var(--pink-soft); font: 600 11px/1.3 system-ui, sans-serif; }
  .visitor-avatar { width: 64px; height: 64px; font-size: 27px; }
  .visitor-copy h1 { font-size: 27px; }
  .visitor-copy > p:not(.eyebrow) { margin: 7px 0; color: var(--muted); font-size: 13px; }
  .session-note { display: flex; align-items: center; gap: 8px; margin-top: 12px; color: var(--mint-deep); font-size: 13px; line-height: 1.5; }
  .status-dot { width: 9px; height: 9px; flex: 0 0 auto; border-radius: 50%; background: var(--mint); box-shadow: 0 0 0 4px var(--mint-soft); }
  .avatar-tip, .resident-note, .status-note { display: flex; align-items: flex-start; gap: 8px; margin-top: 10px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 12px; color: var(--muted); background: #fbf6ee; font-size: 12px; line-height: 1.6; }
  .status-note { border-color: #cce5d9; background: var(--mint-soft); color: var(--mint-deep); }
  .status-note .tip-mark { flex: 0 0 auto; color: var(--mint-deep); font-weight: 700; }
  .resident-note { border-color: #e6d3be; background: #faf3e9; }
  .avatar-tip b { color: var(--ink); font-weight: 600; }
  .avatar-tip .tip-mark { flex: 0 0 auto; color: #b08a5e; font-weight: 700; }
  .resident-note .tip-mark { flex: 0 0 auto; color: #9c6f48; font-weight: 700; }
  .visitor-actions { display: grid; align-self: end; justify-items: stretch; min-width: 150px; margin-top: 28px; gap: 8px; }
  .visitor-actions .status { max-width: 220px; margin-top: 0; }
  .depart, .settle, .uninvite { width: 100%; }
  .settle { border: 0; color: white; background: var(--mint); }
  .settle:hover { background: var(--mint-deep); transform: translateY(-1px); }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { transition-duration: .01ms !important; animation-duration: .01ms !important; }
  }
  @media (max-width: 760px) {
    .page { padding: 20px 14px 34px; }
    .direction-grid { grid-template-columns: 1fr; }
    .workspace { grid-template-columns: 1fr; }
    .roles { max-height: 330px; }
    .visitor-now { grid-template-columns: auto 1fr; }
    .visitor-actions { grid-column: 1 / -1; width: 100%; margin-top: 2px; }
    .visitor-actions .status { max-width: none; }
  }
  @media (max-width: 480px) {
    .hero-mark { display: none; }
    .hero { grid-template-columns: 1fr; }
    .roles { grid-template-columns: 1fr; }
    .preview { padding: 17px; }
  }
</style>
</head>
<body>
<main class="page">
  ${pageBody}
</main>
<script>
(function () {
  'use strict';

  function escapeText(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char];
    });
  }
  var CHARACTER_STATUS = ${JSON.stringify(visitorByCharacter)};

  /* 伙伴出口：把 Hana 伙伴导出成酒馆角色卡 */
  (function () {
    var toggle = document.getElementById('exit-toggle');
    var body = document.getElementById('exit-body');
    var list = document.getElementById('exit-list');
    var preview = document.getElementById('exit-preview');
    if (!body || !list || !preview) return;
    var agents = [];
    var selectedAgentId = null;
    var exportRequestId = 0;

    if (toggle) {
      toggle.addEventListener('click', function () {
        var expanded = body.hidden;
        body.hidden = !expanded;
        toggle.setAttribute('aria-expanded', String(expanded));
        toggle.textContent = expanded ? '收起' : '展开';
        if (expanded && !agents.length) loadAgents();
      });
    } else {
      loadAgents();
    }

    async function loadAgents() {
      list.innerHTML = '<div class="empty"><strong>正在寻找 Hana 伙伴…</strong><span>稍等一下下。</span></div>';
      try {
        var payload = await callApi('card/visitor/export/agents');
        agents = Array.isArray(payload.agents) ? payload.agents : [];
        if (!agents.length) {
          list.innerHTML = '<div class="empty"><strong>没有找到可导出的伙伴</strong><span>常驻的 Hana 助手会出现在这里。</span></div>';
          return;
        }
        list.innerHTML = agents.map(function (agent) {
          var badge = agent.hasDialect
            ? '<span class="exit-agent-badge">方言</span>'
            : (agent.hasDescription ? '<span class="exit-agent-badge">可导出</span>' : '');
          var avatar = agent.avatarDataUrl
            ? '<span class="avatar is-img"><img src="' + escapeText(agent.avatarDataUrl) + '" alt=""></span>'
            : '<span class="avatar">' + escapeText(agent.name.slice(0, 1)) + '</span>';
          return '<button class="exit-agent" type="button" data-agent-id="' + escapeText(agent.agentId) + '">' +
            avatar +
            '<span class="exit-agent-copy"><strong>' + escapeText(agent.name) + '</strong><small>' + escapeText(agent.agentId) + '</small></span>' +
            badge +
            '</button>';
        }).join('');
        list.querySelectorAll('.exit-agent').forEach(function (button) {
          button.addEventListener('click', function () {
            selectAgent(button.getAttribute('data-agent-id'), button);
          });
        });
      } catch (error) {
        list.innerHTML = '<div class="empty"><strong>伙伴列表没读出来</strong><span>' + escapeText(error.message || '请稍后再试') + '</span></div>';
      }
    }

    function selectAgent(agentId, button) {
      selectedAgentId = agentId;
      list.querySelectorAll('.exit-agent').forEach(function (item) { item.classList.remove('is-selected'); });
      if (button) button.classList.add('is-selected');
      var requestId = ++exportRequestId;
      preview.innerHTML = '<div class="exit-preview-empty"><strong>正在整理伙伴资料…</strong><span>看看这次会带走哪些性格与回忆。</span></div>';
      callApi('card/visitor/export/preview', { agentId: agentId }).then(function (payload) {
        if (requestId !== exportRequestId) return;
        renderPreview(payload.preview);
      }).catch(function (error) {
        if (requestId !== exportRequestId) return;
        preview.innerHTML = '<div class="exit-preview-empty"><strong>资料没读出来</strong><span>' + escapeText(error.message || '请稍后再试') + '</span></div>';
      });
    }

    function renderPreview(data) {
      var carryRows = [
        '<span class="check">✓</span><span>带上完整性格设定' + (data.willCarry.dialect ? '（含四川话口吻）' : '') + '</span>',
        '<span class="check">✓</span><span>' + (data.willCarry.memory ? '带上清洗后的相处回忆（' + data.memoryLineCount + ' 条）' : '没有可带的相处回忆，只带性格') + '</span>',
        '<span class="check">✓</span><span>单向快照：酒馆里的经历不会回写 Hana</span>',
      ].map(function (row) { return '<div class="exit-carry-row">' + row + '</div>'; }).join('');
      var memoryHtml = '';
      if (data.willCarry.memory) {
        var lines = data.memoryPreview.split('\\n').filter(Boolean);
        var moreHint = data.memoryLineCount > lines.length ? '（仅展示前 ' + lines.length + ' 条，共 ' + data.memoryLineCount + ' 条）' : '';
        memoryHtml = '<div class="exit-memory"><div class="exit-memory-label">即将带走的回忆（清洗后）' + moreHint + '</div>' +
          lines.map(function (line) { return '<div class="exit-memory-line">' + escapeText(line) + '</div>'; }).join('') +
          '</div>';
      }
      preview.innerHTML =
        '<div class="exit-preview-title">' +
        (data.avatarDataUrl
          ? '<span class="avatar is-img"><img src="' + data.avatarDataUrl + '" alt=""></span>'
          : '<span class="avatar">' + escapeText(data.name.slice(0, 1)) + '</span>') +
        '<div><h3>' + escapeText(data.name) + '</h3><p>' + escapeText(data.agentId) + ' · ' + (data.willCarry.dialect ? '会说四川话' : '性格伙伴') + ' · ' + escapeText(data.avatarSource || 'Hana 默认头像') + '</p></div></div>' +
        '<div class="exit-carry">' + carryRows + '</div>' +
        '<div class="exit-note"><b>单向出口</b><span>这张卡是导出的那一刻的快照。TA 在酒馆里认识的人、经历的事，都留在酒馆，Hana 这边的 TA 不会知道。</span></div>' +
        (memoryHtml || '') +
        '<div class="exit-actions"><button class="primary" id="exit-export-button" type="button" data-agent-id="' + escapeText(data.agentId) + '">导出到酒馆</button>' +
        '<div class="status" id="exit-status" role="status" aria-live="polite"></div></div>';
      var exportButton = document.getElementById('exit-export-button');
      var status = document.getElementById('exit-status');
      exportButton.addEventListener('click', async function () {
        if (exportButton.getAttribute('data-agent-id') !== selectedAgentId) {
          status.className = 'status error';
          status.textContent = '伙伴已切换，请重新点选后再导出。';
          return;
        }
        exportButton.disabled = true;
        exportButton.textContent = '正在导出…';
        status.className = 'status';
        status.textContent = '正在把' + data.name + '装进行李…';
        try {
          var payload = await callApi('card/visitor/export', { agentId: selectedAgentId });
          preview.innerHTML =
            '<div class="exit-done"><div class="exit-done-mark">✓</div>' +
            '<h3>' + escapeText(data.name) + ' 已经住进酒馆了</h3>' +
            '<p>角色卡已写入花酿酒馆角色库。页面正在刷新，马上就能在「选择角色」里找到 TA，随时邀请或开聊。这张卡是单向快照，不会影响 Hana 这边的' + escapeText(data.name) + '。</p>' +
            '</div>';
          setTimeout(function () {
            var params = new URLSearchParams(window.location.search);
            params.set('mode', 'to-hana');
            window.location.href = window.location.pathname + '?' + params.toString();
          }, 1600);
        } catch (error) {
          exportButton.disabled = false;
          exportButton.textContent = '导出到酒馆';
          status.className = 'status error';
          status.textContent = error.message || '导出失败，请再试一次。';
        }
      });
    }
  }());

  function pluginBase() {
    var injected = String(window.HANA_PLUGIN_BASE || '').trim();
    if (injected) return injected.replace(/\\\/$/, '');
    var marker = '/api/plugins/';
    var start = window.location.pathname.indexOf(marker);
    if (start < 0) throw new Error('角色来访路由无效。');
    var rest = window.location.pathname.slice(start + marker.length);
    var end = rest.indexOf('/');
    var pluginId = decodeURIComponent(end >= 0 ? rest.slice(0, end) : rest);
    return window.location.origin + '/api/plugins/' + encodeURIComponent(pluginId);
  }
  async function callApi(path, body) {
    var authParams = new URLSearchParams(window.location.search);
    var surfaceSession = authParams.get('pluginSurfaceSession') || '';
    var legacyToken = authParams.get('token') || '';
    if (!surfaceSession && !legacyToken) throw new Error('角色来访页面尚未拿到宿主会话凭证。');
    var hasBody = body !== undefined && body !== null;
    var apiUrl = pluginBase() + '/' + String(path).replace(/^\\/+/, '');
    var headers = { 'Content-Type': 'application/json' };
    if (legacyToken) {
      apiUrl += (apiUrl.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(legacyToken);
    } else {
      headers['X-Hana-Plugin-Surface-Session'] = surfaceSession;
    }
    var response = await fetch(apiUrl, {
      method: hasBody ? 'POST' : 'GET',
      headers: headers,
      body: hasBody ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(45000)
    });
    var payload = await response.json().catch(function () { return {}; });
    if (!response.ok || payload.ok === false) throw new Error(payload.error || ('请求失败（' + response.status + '）'));
    return payload;
  }
  function previewHtml(data, characterStatus) {
    var character = data.character || {};
    var history = data.history || {};
    var recent = Array.isArray(history.messages) ? history.messages : [];
    var memory = recent.length
      ? '<div class="memory"><div class="memory-label">最近带来的几句话</div>' + recent.map(function (message) {
          return '<div class="memory-line ' + (message.role === 'user' ? 'user' : '') + '">' +
            escapeText(message.role === 'user' ? '你：' : character.name + '：') + escapeText(message.content) + '</div>';
        }).join('') + '</div>'
      : '<div class="memory"><div class="memory-label">最近回忆</div><div class="memory-line">酒馆里还没有找到近期对话，这次只带角色设定。</div></div>';
    var statusBlock = '';
    if (characterStatus === 'resident') {
      statusBlock = '<div class="status-note"><span class="tip-mark">已入驻</span><span>TA 已经在 Hana 住下了，会出现在助手列表里。想让 TA 离开时，回到上方「正在 Hana 做客」区域操作。</span></div>';
    } else if (characterStatus === 'visiting') {
      statusBlock = '<div class="status-note"><span class="tip-mark">来访中</span><span>TA 正在 Hana 做客，等 TA 离开后才能再次邀请。</span></div>';
    }
    var action = characterStatus
      ? '<div class="actions"><button class="primary" id="invite-button" type="button" disabled>TA 已经在 Hana 了</button></div>'
      : '<div class="actions"><button class="primary" id="invite-button" type="button">请 TA 来 Hana</button></div>';
    return '<div class="preview-title">' + (character.avatarData
      ? '<span class="avatar is-img"><img src="' + character.avatarData + '" alt=""></span>'
      : '<span class="avatar">' + escapeText(Array.from(character.name || '花')[0] || '花') + '</span>') +
      '<div><h2>' + escapeText(character.name) + '</h2><p>' + escapeText((character.tags || []).join(' · ') || '角色卡') + '</p></div></div>' +
      '<div class="carry"><div class="carry-row"><span class="check">✓</span><span>带上完整角色设定、性格与世界观</span></div>' +
      '<div class="carry-row"><span class="check">✓</span><span>' + (history.messageCount ? '带上最近 ' + history.messageCount + ' 条酒馆对话' : '当前没有近期对话，将只带角色设定') + '</span></div></div>' +
      (statusBlock || '') +
      '<p class="description">' + escapeText(character.description || character.personality || '这张角色卡正在等你发出邀请。') + '</p>' + memory +
      action +
      '<div class="status" id="visitor-status" role="status" aria-live="polite"></div>';
  }
  var selectionRequestId = 0;
  document.querySelectorAll('[data-character-id]').forEach(function (button) {
    button.addEventListener('click', async function () {
      var requestId = ++selectionRequestId;
      document.querySelectorAll('[data-character-id]').forEach(function (item) { item.classList.remove('is-selected'); });
      button.classList.add('is-selected');
      var preview = document.getElementById('preview');
      preview.innerHTML = '<div class="preview-empty"><strong>正在整理角色资料…</strong><span>花酿正在看看 TA 会带来哪些回忆。</span></div>';
      try {
        var payload = await callApi('card/visitor/preview', { characterId: button.getAttribute('data-character-id') });
        if (requestId !== selectionRequestId) return;
        var status = CHARACTER_STATUS[button.getAttribute('data-character-id')] || '';
        preview.innerHTML = previewHtml(payload.preview, status);
        var invite = document.getElementById('invite-button');
        if (!invite.disabled) {
          var inviteStatus = document.getElementById('visitor-status');
          invite.addEventListener('click', async function () {
            invite.disabled = true;
            invite.textContent = '正在邀请…';
            inviteStatus.className = 'status';
            inviteStatus.textContent = '正在整理角色设定、创建临时身份和 Hana 会话…';
            try {
              await callApi('card/visitor/invite', { characterId: button.getAttribute('data-character-id') });
              window.location.reload();
            } catch (error) {
              invite.disabled = false;
              invite.textContent = '请 TA 来 Hana';
              inviteStatus.className = 'status error';
              inviteStatus.textContent = error.message || '邀请失败';
            }
          });
        }
      } catch (error) {
        if (requestId !== selectionRequestId) return;
        preview.innerHTML = '<div class="preview-empty"><strong>角色资料没有读出来</strong><span>' + escapeText(error.message || '请稍后再试') + '</span></div>';
      }
    });
  });
  var depart = document.getElementById('depart-button');
  function bindAction(button, endpoint, busyText, doneReload) {
    if (!button) return;
    button.addEventListener('click', async function () {
      var agentId = button.getAttribute('data-agent-id') || '';
      var status = document.querySelector('[data-status-for="' + agentId + '"]');
      button.disabled = true;
      var originalText = button.textContent;
      button.textContent = busyText;
      if (status) { status.className = 'status'; status.textContent = '正在处理…'; }
      try {
        await callApi(endpoint, agentId ? { agentId: agentId } : {});
        if (doneReload) window.location.reload();
      } catch (error) {
        button.disabled = false;
        button.textContent = originalText;
        if (status) { status.className = 'status error'; status.textContent = error.message || '操作失败，请再试一次。'; }
      }
    });
  }
  document.querySelectorAll('.depart').forEach(function (button) {
    bindAction(button, 'card/visitor/depart', '正在送回…', true);
  });
  document.querySelectorAll('.settle').forEach(function (button) {
    bindAction(button, 'card/visitor/settle', '正在安排住处…', true);
  });
  document.querySelectorAll('.uninvite').forEach(function (button) {
    button.addEventListener('click', async function () {
      var agentId = button.getAttribute('data-agent-id') || '';
      var status = document.querySelector('[data-status-for="' + agentId + '"]');
      // 请走入驻角色 = 重置，提醒记忆断层（酒馆续章会保留，Hana 侧记忆不延续）
      var ok = window.confirm('请走后再邀请 TA，会重新入驻一份新的人格。TA 在 Hana 里攒下的相处记忆不会延续（酒馆里的回忆会跟续章一起保留）。确定要请 TA 回去吗？');
      if (!ok) return;
      button.disabled = true;
      var originalText = button.textContent;
      button.textContent = '正在送 TA 回去…';
      if (status) { status.className = 'status'; status.textContent = '正在结束入驻并送回酒馆…'; }
      try {
        await callApi('card/visitor/uninvite', { agentId: agentId });
        window.location.reload();
      } catch (error) {
        button.disabled = false;
        button.textContent = originalText;
        if (status) { status.className = 'status error'; status.textContent = error.message || '操作失败，请再试一次。'; }
      }
    });
  });
  window.parent.postMessage({ protocol: 'hana.plugin.ui', version: 1, kind: 'event', type: 'hana.ready' }, '*');
  window.parent.postMessage({ type: 'ready' }, '*');
}());
</script>
</body>
</html>`;
}

async function parseJson(c) {
  try { return await c.req.json(); } catch { return {}; }
}

/**
 * 把酒馆角色卡头像转成 base64 data URL（内联到 img，不发起网络请求）。
 * 插件路由 /api/plugins/:id/* 都要 surface session 凭证，<img> 标签无法携带
 * X-Hana-Plugin-Surface-Session header，走 HTTP 端点必然 403，所以只能内联。
 * 读取失败返回 null（页面回退首字母头像）。
 */
function avatarDataUrl(avatarPath, ctx = {}) {
  const avatarName = String(avatarPath || '').trim();
  if (!avatarName || basename(avatarName) !== avatarName) return null;
  const ext = avatarName.toLowerCase().match(/\.(png|jpe?g|webp|gif)$/)?.[1];
  if (!ext) return null;
  const charactersRoot = paths(ctx).characters;
  const resolved = join(charactersRoot, avatarName);
  try {
    const stat = statSync(resolved);
    if (!stat.isFile()) return null;
    const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[ext];
    return `data:${mime};base64,${readFileSync(resolved).toString('base64')}`;
  } catch {
    return null;
  }
}

export default function registerVisitorRoutes(app, ctx = {}) {
  app.get('/card/visitor', async (c) => {
    const [characters, visitors] = await Promise.all([
      listVisitorCharacters(ctx),
      getVisitorState(ctx),
    ]);
    const url = new URL(c.req.url, 'http://hana.local');
    return c.html(renderVisitorPage({ characters, visitors }, ctx, {
      mode: url.searchParams.get('mode') || 'home',
      surfaceSession: url.searchParams.get('pluginSurfaceSession') || '',
      legacyToken: url.searchParams.get('token') || '',
    }));
  });

  app.post('/card/visitor/preview', async (c) => {
    const body = await parseJson(c);
    const characterId = String(body.characterId || '').trim();
    if (!characterId) return c.json({ ok: false, error: '请先选择一张角色卡。' }, 400);
    try {
      const preview = await getVisitorPreview(characterId, ctx);
      // 头像转 data URL 内联（<img> 无法带 surface session header，走 HTTP 必然 403）
      if (preview?.character) {
        const dataUrl = avatarDataUrl(preview.character.avatarPath, ctx);
        preview.character.avatarData = dataUrl;
      }
      return c.json({ ok: true, preview });
    } catch (error) {
      return c.json({ ok: false, error: error.message || '角色资料读取失败。' }, 404);
    }
  });

  // 伙伴出口：列出可导出的 Hana 助手
  app.get('/card/visitor/export/agents', async (c) => {
    try {
      const agents = listExportableAgents(ctx);
      return c.json({ ok: true, agents });
    } catch (error) {
      return c.json({ ok: false, error: error.message || '助手列表读取失败。' }, 500);
    }
  });

  // 伙伴出口：导出预览
  app.post('/card/visitor/export/preview', async (c) => {
    const body = await parseJson(c);
    const agentId = String(body.agentId || '').trim();
    if (!agentId) return c.json({ ok: false, error: '请先选择一位 Hana 伙伴。' }, 400);
    try {
      const preview = getAgentExportPreview(agentId, ctx);
      return c.json({ ok: true, preview });
    } catch (error) {
      return c.json({ ok: false, error: error.message || '伙伴资料读取失败。' }, 404);
    }
  });

  // 伙伴出口：执行导出
  app.post('/card/visitor/export', async (c) => {
    const body = await parseJson(c);
    const agentId = String(body.agentId || '').trim();
    if (!agentId) return c.json({ ok: false, error: '请先选择一位 Hana 伙伴。' }, 400);
    try {
      // 以酒馆当前 settings.json 的 username 为准，不接受页面传入的任意署名。
      const result = await exportAgentToTavern(agentId, { userName: tavernUserName(ctx) }, ctx);
      return c.json({ ok: true, result });
    } catch (error) {
      ctx.log?.error?.('[hanabrew-export] export failed:', error.message);
      return c.json({ ok: false, error: error.message || '导出失败。' }, 500);
    }
  });

  app.post('/card/visitor/invite', async (c) => {
    const body = await parseJson(c);
    const characterId = String(body.characterId || '').trim();
    if (!characterId) return c.json({ ok: false, error: '请先选择一张角色卡。' }, 400);
    try {
      const visitor = await inviteVisitor(characterId, ctx);
      return c.json({ ok: true, visitor });
    } catch (error) {
      ctx.log?.error?.('[hanabrew-visitor] invite failed:', error.message);
      return c.json({ ok: false, error: error.message || '角色邀请失败。' }, 500);
    }
  });

  app.post('/card/visitor/depart', async (c) => {
    const body = await parseJson(c);
    const agentId = String(body.agentId || '').trim();
    try {
      const visitor = await departVisitor(agentId || null, ctx);
      return c.json({ ok: true, visitor });
    } catch (error) {
      ctx.log?.error?.('[hanabrew-visitor] depart failed:', error.message);
      return c.json({ ok: false, error: error.message || '送回酒馆失败。' }, 500);
    }
  });

  app.post('/card/visitor/settle', async (c) => {
    const body = await parseJson(c);
    const agentId = String(body.agentId || '').trim();
    if (!agentId) return c.json({ ok: false, error: '缺少来访者编号。' }, 400);
    try {
      const visitor = await settleVisitor(agentId, ctx);
      return c.json({ ok: true, visitor });
    } catch (error) {
      ctx.log?.error?.('[hanabrew-visitor] settle failed:', error.message);
      return c.json({ ok: false, error: error.message || '入驻失败。' }, 500);
    }
  });

  app.post('/card/visitor/uninvite', async (c) => {
    const body = await parseJson(c);
    const agentId = String(body.agentId || '').trim();
    if (!agentId) return c.json({ ok: false, error: '缺少来访者编号。' }, 400);
    try {
      const visitor = await uninviteVisitor(agentId, ctx);
      return c.json({ ok: true, visitor });
    } catch (error) {
      ctx.log?.error?.('[hanabrew-visitor] uninvite failed:', error.message);
      return c.json({ ok: false, error: error.message || '请 TA 回去失败。' }, 500);
    }
  });
}
