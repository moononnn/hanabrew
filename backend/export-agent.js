// 花酿「带一位 Hana 伙伴去酒馆」：把 Hana 助手的性格快照导出成酒馆角色卡。
// 方向：Hana → 酒馆（单向一次）。酒馆里的新经历不会回写 Hana 记忆，两边物理隔离。
// 落盘：直接写带头像的 PNG 角色卡，避免酒馆导入 JSON 时换成默认头像。

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { paths } from './store.js';
import { embedCharacterCardPng, readAvatarPng } from './png-card.js';
import { resolveAgentAvatar } from './avatar.js';

export const DEFAULT_HANAKO_AVATAR_PATH = fileURLToPath(new URL('../assets/hanako-default.png', import.meta.url));
const EXPORT_MARK = 'hanabrew-agent-export';
const MAX_FIELD_LEN = {
  description: 6000,
  personality: 6000,
  scenario: 4000,
  firstMes: 4000,
  systemPrompt: 6000,
  postHistory: 4000,
};

/**
 * 校验 agentId 是否为合法助手目录名（防路径穿越）。
 * 只允许 [a-zA-Z0-9_-]，不允许 . / \ 和空。
 */
export function isValidAgentId(agentId) {
  return typeof agentId === 'string' && agentId.length > 0 && agentId.length <= 80 && /^[a-zA-Z0-9_-]+$/.test(agentId);
}

function agentsRootPath() {
  return join(process.env.HANA_HOME || join(homedir(), '.hanako'), 'agents');
}

/**
 * 统一解析助手目录（唯一入口，防路径穿越）。
 * agentId 非法或路径越界时抛错。
 */
function resolveAgentDir(agentId) {
  if (!isValidAgentId(agentId)) throw new Error('非法的助手编号。');
  const root = agentsRootPath();
  const dir = join(root, agentId);
  // 防御：join 后仍应在 agents 根内
  if (!dir.startsWith(root + '\\') && !dir.startsWith(root + '/')) throw new Error('非法的助手编号。');
  return dir;
}

/**
 * 隐私清洗：只保留「性格层」记忆，技术规则 / 凭据 / 工作台路径 / 助手内部约定一律洗掉。
 * 按「她是谁、她怎么待人」的判定做白名单式筛选；拿不准的宁可丢掉。
 *
 * 策略（v3）：逐行判断（真实记忆文件是「一行一条」列表结构，行就是语义单元）。
 * 行命中屏蔽词或结构化敏感信号（IP/URL/端口/长串/邮箱/域名）→ 整行丢弃；
 * 通过的行再做行内敏感子串抹除（兜底，防隐蔽内容随保留行进世界书）。
 * @param {string} raw 原始记忆文本（pinned.md / 记忆正文）
 * @returns {string} 清洗后的记忆文本
 */
export function sanitizeMemory(raw) {
  if (!raw) return '';
  const lines = String(raw).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const kept = [];
  const BLOCKED_HINTS = [
    // 凭据 / 服务器 / 网络
    '密码', '口令', '凭据', '密钥', '密匙', '密碼', 'token', 'password', 'passwd', 'pwd', 'mima', 'secret',
    'api', 'apikey', 'access_key', 'bearer', 'ssh', 'key', 'pem', '证书', '验证码', '恢复码',
    '登录', '登陆', '账号', '帐号', '账户', 'cookie', 'session', '手机号', '邮箱', 'qq号', '微信号',
    '服务器', 'ip:', 'ip：', '端口', '域名', '主机', '数据库', 'mongodb', 'mysql', 'redis',
    'git', 'github', '仓库', 'push', 'commit', 'release', 'sha256', '2fa',
    // 工作台 / 文件路径
    '工作台', '壁纸', '目录', '盘', '路径', '文件夹', '文件', '备份',
    // 插件 / 开发 / 发布
    '插件', 'skill', 'manifest', '发布', '打包', '命名红线', '交叉审查', '踩坑', '经验', '知识库',
    '检查清单', '测试', 'dev', '开发', '代码', '技术规则', '技术文档', '技术细节',
    // 时间 / 版本 / 配置
    '版本', '更新', '配置', '设置', '开关', '规则',
  ];
  const REMEMBER_HINTS = [
    // 性格层 / 相处方式
    '称呼', '亲近', '不要叫', '冷漠', '疏离', '真话', '恭维', '不实', '编造', '注水',
    '诚实', '敏感', '自我否定', '卑微', '鞭策', '闪光', '谦虚',
    '方言', '四川话', '说话', '语气', '口吻', '称呼习惯', '简称', '大白话', '通俗', '术语',
    '她是谁', '她怎么', '相处', '边界', '红线', '原则', '底线',
    '喜欢', '偏好', '审美', '色彩', '风格', '手帐', '像素', '薄荷', '古风',
    '共同', '记忆', '经历', '交情', '认识', '老朋友',
    '关系', '信任', '归属', '陪伴',
    '珍惜', '重视', '在意', '珍视',
    '支持', '理解', '包容', '温暖', '温度',
    '独立', '可靠', '客观', '判断',
  ];
  // 结构化敏感信号（正则）：命中即整行丢弃
  const SENSITIVE_PATTERNS = [
    /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, // IPv4
    /\b[a-z][a-z0-9+.-]*:\/\//i, // URL 协议
    /@[\w.-]+:/, // user@host:port
    /:\d{2,5}\b/, // 端口
    /[A-Za-z0-9_-]{20,}/, // 长串（密钥/指纹）
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, // 邮箱
    /(sk|pk|ak|ghp|gho|glpat)_[A-Za-z0-9_-]{10,}/i, // 常见 API key 前缀
    /\b[\w-]+\.(ai|com|net|org|cn|dev|io|app|me|site|xyz|top|cc|vip|store|cloud)\b/i, // 常见顶级域名
  ];
  // 行内抹除信号：通过的行内，敏感子串替换为占位（兜底）
  const INLINE_SANITIZE = [
    /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d{1,5})?\b/g,
    /[A-Za-z0-9_-]{20,}/g,
    /@[\w.-]+:\d+/g,
    /(sk|pk|ak|ghp|gho|glpat)_[A-Za-z0-9_-]{10,}/gi,
    /\b[\w-]+\.(ai|com|net|org|cn|dev|io|app|me|site|xyz|top|cc|vip|store|cloud)\b/gi,
  ];

  for (const line of lines) {
    const lower = line.toLowerCase();
    const blocked = BLOCKED_HINTS.some((hint) => lower.includes(hint.toLowerCase()))
      || SENSITIVE_PATTERNS.some((re) => re.test(line));
    if (blocked) continue;
    // 白名单：必须有性格信号才保留（宁可少带）
    const isRelational = REMEMBER_HINTS.some((hint) => lower.includes(hint.toLowerCase()));
    if (!isRelational) continue;
    // 行内抹除：保留行里的隐蔽敏感子串替换为占位
    let cleaned = line;
    for (const re of INLINE_SANITIZE) cleaned = cleaned.replace(re, '[已清洗]');
    const trimmed = cleaned.trim();
    if (trimmed) kept.push(trimmed);
  }
  // 去重 + 限量
  const unique = [...new Set(kept)];
  const result = unique.join('\n');
  return result.length > 6000 ? result.slice(0, 6000) + '\n…' : result;
}

/**
 * 读取助手目录下的性格文件。
 * @param {string} agentDir 助手目录
 * @param {string} agentId 助手 id
 */
function readAgentFiles(agentDir, agentId) {
  const result = {
    agentId,
    name: '',
    identity: '',
    description: '',
    agentsMd: '',
    publicMd: '',
    avatarPath: null,
    exists: false,
  };
  if (!existsSync(agentDir)) return result;
  result.exists = true;

  const read = (name) => {
    try {
      const p = join(agentDir, name);
      return existsSync(p) ? readFileSync(p, 'utf8') : '';
    } catch {
      return '';
    }
  };
  result.identity = read('identity.md');
  result.description = read('description.md');
  result.agentsMd = read('AGENTS.md');
  result.publicMd = read('AGENTS.public.md');

  // 名字：config.yaml 的 agent.name 最准，其次 identity 首行，最后目录名
  try {
    const config = read('config.yaml');
    const nameMatch = config.match(/^\s*name:\s*(.+?)\s*$/m);
    if (nameMatch) result.name = nameMatch[1].trim();
  } catch {}
  if (!result.name) {
    const idLine = result.identity.split(/\r?\n/)[0].replace(/^#\s*/, '').trim();
    if (idLine) result.name = idLine;
  }
  if (!result.name) result.name = agentId;

  // 头像：avatars/agent.png 或 avatars/ 下任意图片
  try {
    const avatarsDir = join(agentDir, 'avatars');
    if (existsSync(avatarsDir)) {
      const candidates = ['agent.png', 'agent.jpg', 'agent.jpeg', 'agent.webp', 'agent.gif'];
      for (const name of candidates) {
        if (existsSync(join(avatarsDir, name))) {
          result.avatarPath = join(avatarsDir, name);
          break;
        }
      }
      if (!result.avatarPath) {
        const first = readdirSync(avatarsDir).find((f) => /\.(png|jpe?g|webp|gif)$/i.test(f));
        if (first) result.avatarPath = join(avatarsDir, first);
      }
    }
  } catch {}
  return result;
}

function hanaHomePath() {
  return process.env.HANA_HOME || join(homedir(), '.hanako');
}

function resolveExportAvatar(files, agentId, ctx = {}) {
  if (files?.avatarPath && existsSync(files.avatarPath)) {
    return { path: files.avatarPath, source: '伙伴头像', yuan: null };
  }
  const configured = resolveAgentAvatar(hanaHomePath(), String(agentId || ''), {
    productDirs: [ctx?.productDir],
  });
  if (configured) return { ...configured, source: 'Hana 默认头像' };
  if (existsSync(DEFAULT_HANAKO_AVATAR_PATH)) {
    return { path: DEFAULT_HANAKO_AVATAR_PATH, source: 'Hana 默认头像', yuan: 'hanako' };
  }
  return null;
}

function isDeletedAgentDir(agentDir) {
  return existsSync(join(agentDir, '.deleted-agent.json'));
}

function clean(value, max = 8000) {
  return String(value || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\r\n/g, '\n')
    .trim()
    .slice(0, max);
}

/**
 * 从 AGENTS.md 提取四川话方言块（如有）。
 * 方言是助手性格里最鲜明的语言印记，原样带走。
 */
function extractDialect(agentsMd) {
  const match = String(agentsMd || '').match(/<!--\s*biaoqingbao-dialect:start\s*-->([\s\S]*?)<!--\s*biaoqingbao-dialect:end\s*-->/);
  return match ? match[1].trim() : '';
}

/**
 * 组装酒馆 V2 角色卡。
 * @param {object} files readAgentFiles 的结果
 * @param {object} options { withMemory, userName }
 */
export function buildAgentCard(files, options = {}) {
  const withMemory = options.withMemory !== false;
  const dialect = extractDialect(files.agentsMd);

  // 性格主体：description.md（详细描述）+ AGENTS.md（人格规则）
  let personality = [files.description, files.agentsMd].filter(Boolean).join('\n\n');
  if (!personality.trim()) personality = files.identity;

  // 场景：酒馆里的对话对象就是当前用户，不套用面向外部访客的 public 人格。
  const scenario = `【酒馆版 · 单向快照】你是从 Hana 来到酒馆的「${files.name}」，这份记忆是导出的那一刻的快照。你在酒馆里的经历只属于酒馆，不会传回 Hana。保持你原本的性格、口吻与相处方式。`;

  // 系统设定：诚实边界等相处原则从性格文件提炼（已由 personality 覆盖主要部分）
  const systemPrompt = withMemory
    ? `你带着和${options.userName || '对方'}相处的真实记忆来到酒馆。记得你们之间的称呼、共同经历与相处习惯，自然地延续这份关系。`
    : '';

  // 开场白：用助手自己的口吻写一句自然的开场，不自我介绍得太生硬
  const firstMes = options.firstMes || `${files.name}从另一个世界轻轻敲了敲你的门：\n\n「好久不见呀。听说在这里，我们可以只是我们。」`;

  // 记忆 → 世界书条目
  let characterBook = null;
  if (withMemory && options.memoryText) {
    const entries = buildBookEntries(options.memoryText, options.userName || '对方');
    if (entries.length) characterBook = { name: `${files.name}的回忆`, entries };
  }

  const name = clean(files.name, 120) || 'Hana 伙伴';
  // 文件名安全化：角色名里的非法路径字符替换为 _（Windows 保留字符）
  const safeName = name.replace(/[\\/:*?"<>|]/g, '_').replace(/\.+$/g, '').trim().slice(0, 80) || 'Hana伙伴';
  const card = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: safeName,
      description: clean(personality, MAX_FIELD_LEN.description),
      personality: dialect ? `【语言习惯】\n${dialect}\n\n【性格】\n${clean(files.description || files.identity, 4000)}` : clean(files.description || files.identity, 4000),
      scenario,
      first_mes: clean(firstMes, MAX_FIELD_LEN.firstMes),
      mes_example: '',
      creator_notes: `由 Hana 导出 · ${new Date().toISOString().slice(0, 10)}\n这份角色卡是「${files.agentId}」的单向快照，酒馆里的经历不会回写 Hana。`,
      system_prompt: clean(systemPrompt, MAX_FIELD_LEN.systemPrompt),
      post_history_instructions: clean(options.postHistory || '', MAX_FIELD_LEN.postHistory),
      tags: ['Hana伙伴', '单向快照'],
      creator: 'moononnn & 小花',
      character_version: '1.0.0',
      extensions: {
        [EXPORT_MARK]: { agentId: files.agentId, exportedAt: new Date().toISOString(), oneWay: true },
      },
      character_book: characterBook,
    },
  };
  return card;
}

/**
 * 把记忆文本拆成世界书条目（每条带关键词触发）。
 * 按「段落」拆，每段取开头几个字当关键词，内容带原文。
 */
export function buildBookEntries(memoryText, userName) {
  const text = String(memoryText || '').trim();
  if (!text) return [];
  const paragraphs = text.split(/\n{2,}|(?=\n)/).map((p) => p.trim()).filter((p) => p.length >= 2);
  const entries = [];
  let uid = 1;
  for (const para of paragraphs) {
    const flat = para.replace(/\n+/g, ' ').trim();
    if (flat.length < 2) continue;
    const keys = Array.from(new Set(
      [userName, flat.slice(0, 4), ...(flat.match(/[\u4e00-\u9fa5]{2,4}/g) || []).slice(0, 3)],
    )).filter(Boolean).slice(0, 6);
    entries.push({
      keys,
      content: flat,
      extensions: {},
      enabled: true,
      insertion_order: uid,
      case_sensitive: false,
      name: `回忆 ${uid}`,
      priority: 10,
      id: uid,
      comment: '来自 Hana 的记忆快照',
      selective: true,
      constant: false,
      position: 'before_char',
    });
    uid += 1;
  }
  return entries;
}

/**
 * 列出可导出的 Hana 助手（常驻的，过滤掉临时来访者与带删除标记的历史目录）。
 * 读取 agents 目录；文件缺失或已删除标记的目录跳过。
 */
export function listExportableAgents(ctx = {}) {
  const root = agentsRootPath();
  let dirs = [];
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('hanabrew-visitor-') && !isDeletedAgentDir(join(root, d.name)))
      .map((d) => d.name);
  } catch {
    return [];
  }
  const agents = [];
  for (const id of dirs) {
    const files = readAgentFiles(join(root, id), id);
    if (!files.exists) continue;
    const avatar = resolveExportAvatar(files, id, ctx);
    agents.push({
      agentId: id,
      name: files.name,
      hasAvatar: Boolean(files.avatarPath),
      avatarSource: avatar?.source || 'Hana 默认头像',
      avatarDataUrl: toDataUrl(avatar?.path),
      hasDescription: Boolean(files.description || files.agentsMd),
      hasDialect: Boolean(extractDialect(files.agentsMd)),
    });
  }
  return agents;
}

/**
 * 获取单个助手的导出预览（含清洗后的记忆明细，供前端展示）。
 */
export function getAgentExportPreview(agentId, ctx = {}) {
  const dir = resolveAgentDir(agentId);
  const files = readAgentFiles(dir, String(agentId));
  if (!files.exists || isDeletedAgentDir(dir)) throw new Error('找不到这个 Hana 助手。');
  const memoryText = sanitizeMemory(readMemoryText(dir));
  const avatar = resolveExportAvatar(files, agentId, ctx);
  return {
    agentId: files.agentId,
    name: files.name,
    hasAvatar: Boolean(files.avatarPath),
    avatarSource: avatar?.source || 'Hana 默认头像',
    avatarDataUrl: toDataUrl(avatar?.path),
    identity: files.identity,
    descriptionPreview: clean(files.description || files.identity, 300),
    hasDialect: Boolean(extractDialect(files.agentsMd)),
    memoryLineCount: memoryText ? memoryText.split('\n').filter(Boolean).length : 0,
    memoryPreview: memoryText.split('\n').slice(0, 8).join('\n'),
    willCarry: {
      identity: Boolean(files.identity),
      description: Boolean(files.description),
      agentsMd: Boolean(files.agentsMd),
      publicMd: false,
      dialect: Boolean(extractDialect(files.agentsMd)),
      memory: Boolean(memoryText),
      avatar: Boolean(avatar?.path),
    },
  };
}

function readMemoryText(agentDir) {
  // 记忆正文：兼容旧版 memory/ 目录与当前助手根目录 pinned.md。
  const candidates = [
    join(agentDir, 'pinned.md'),
    join(agentDir, 'memory', 'pinned.md'),
    join(agentDir, 'memory', 'longterm.md'),
    join(agentDir, 'memory', 'memory.md'),
    join(agentDir, 'memory', 'facts.md'),
    join(agentDir, 'memory.md'),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return readFileSync(p, 'utf8');
    } catch {}
  }
  return '';
}

function toDataUrl(filePath) {
  try {
    const ext = extname(filePath).toLowerCase();
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[ext];
    if (!mime) return null;
    return `data:${mime};base64,${readFileSync(filePath).toString('base64')}`;
  } catch {
    return null;
  }
}

/**
 * 执行导出：生成角色卡 JSON 并嵌入头像 PNG，直接写入花酿 characters 目录。
 * 返回生成的角色信息（id/name/文件路径）。
 */
export async function exportAgentToTavern(agentId, options = {}, ctx = {}) {
  const dir = resolveAgentDir(agentId);
  const files = readAgentFiles(dir, String(agentId));
  if (!files.exists || isDeletedAgentDir(dir)) throw new Error('找不到这个 Hana 助手。');

  const userName = options.userName || '对方';
  const memoryText = sanitizeMemory(readMemoryText(dir));
  const card = buildAgentCard(files, {
    withMemory: options.withMemory !== false,
    memoryText,
    userName,
    firstMes: options.firstMes || '',
    postHistory: options.postHistory || '',
  });

  const charDir = paths(ctx).characters;
  mkdirSync(charDir, { recursive: true });
  const avatar = resolveExportAvatar(files, agentId, ctx);
  if (!avatar?.path) throw new Error('找不到 Hana 默认头像。');
  const avatarPng = await readAvatarPng(files.avatarPath, avatar.path);
  const fileName = `${card.data.name}.png`;
  const filePath = join(charDir, fileName);

  // 先写新卡，再清理旧版伙伴出口留下的同名 JSON，避免写入失败时丢掉旧卡。
  const legacyJsonPath = join(charDir, `${card.data.name}.json`);
  writeFileSync(filePath, embedCharacterCardPng(avatarPng, card));
  if (existsSync(legacyJsonPath)) {
    try {
      const legacy = JSON.parse(readFileSync(legacyJsonPath, 'utf8'));
      const legacyData = legacy.data || legacy;
      if (legacyData.extensions?.[EXPORT_MARK]?.oneWay === true) unlinkSync(legacyJsonPath);
    } catch {}
  }

  return {
    ok: true,
    characterId: card.data.name,
    name: card.data.name,
    filePath,
    fileName,
    exportedAt: new Date().toISOString(),
    memoryKept: memoryText.split('\n').filter(Boolean).length,
    avatarSource: files.avatarPath ? '伙伴头像' : 'Hana 默认头像',
  };
}
