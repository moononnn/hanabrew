// 轻量 HTML 文本工具
//
// 这些函数原本定义在轻聊卡路由（routes/card.js）里，但角色来访页等模块也要用。
// 独立成模块后，公开版即使不携带轻聊卡，也不会因此缺少转义工具。

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"'\u2028\u2029]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
    '\u2028': '&#x2028;',
    '\u2029': '&#x2029;',
  })[char]);
}

export function initials(name) {
  const text = String(name || '花').trim();
  return Array.from(text).slice(0, 1).join('') || '花';
}

export function formatMessage(value) {
  return escapeHtml(value).replace(/\r?\n/g, '<br>');
}
