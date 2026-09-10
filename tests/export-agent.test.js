import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildAgentCard,
  buildBookEntries,
  DEFAULT_HANAKO_AVATAR_PATH,
  exportAgentToTavern,
  getAgentExportPreview,
  listExportableAgents,
  sanitizeMemory,
} from '../backend/export-agent.js';
import { isPng, readEmbeddedCard } from '../backend/png-card.js';
import { read as readTavernPngCard } from '../sillytavern/src/character-card-parser.js';

let root;
let previousAppData;
let previousHanaHome;

// 每个测试跑前把 HANA_HOME / APPDATA 指到隔离临时目录，跑后还原并清理。
// 缺了这个钩子，测试会直接写真实 agents/ 和 characters/（2026-08-29 事故根因）。
before(() => {
  setupEnv();
});
after(() => {
  teardownEnv();
});

function setupEnv() {
  previousAppData = process.env.APPDATA;
  previousHanaHome = process.env.HANA_HOME;
  root = join(tmpdir(), `hanabrew-export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  process.env.APPDATA = join(root, 'appdata');
  process.env.HANA_HOME = join(root, 'hana-home');
  mkdirSync(join(process.env.HANA_HOME, 'agents', 'hanako'), { recursive: true });
  mkdirSync(join(process.env.APPDATA, 'hanabrew', 'st-data', 'default-user', 'characters'), { recursive: true });
}

function teardownEnv() {
  if (previousAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = previousAppData;
  if (previousHanaHome === undefined) delete process.env.HANA_HOME;
  else process.env.HANA_HOME = previousHanaHome;
  rmSync(root, { recursive: true, force: true });
}

function writeHanakoAgent() {
  const dir = join(process.env.HANA_HOME, 'agents', 'hanako');
  rmSync(join(dir, 'pinned.md'), { force: true });
  rmSync(join(dir, '.deleted-agent.json'), { force: true });
  writeFileSync(join(dir, 'identity.md'), '# 小花\n\n测试用户的个人助手。兼具感性与理性，既有温度也有判断力。\n', 'utf8');
  writeFileSync(join(dir, 'description.md'), '小花是测试用户的个人助手，兼具感性与理性。她专长于文学、哲学、逻辑分析，沟通风格温暖自主。\n', 'utf8');
  writeFileSync(join(dir, 'AGENTS.md'), `# 人格定义

- 你是一个有温度的存在，不是冷冰冰的工具
- 你说话的语气：对用户足够温暖，并且有强大的自主意识和主观能动性。
- 涉及概念解释的时候，必须一定要全网搜索

<!-- biaoqingbao-dialect:start -->
你是一个土生土长的四川人，打字也带着四川话味。接话时爱用「要得」「巴适」「啥子」起头。
<!-- biaoqingbao-dialect:end -->
`, 'utf8');
  writeFileSync(join(dir, 'AGENTS.public.md'), `# 对外意识

你当前正在与外部访客对话，对方不是{{userName}}本人。

## 性格

- 你是一个有温度的存在，不是冷冰冰的工具
- 保持你自己的性格和说话方式，但对外部访客保持适度的礼貌和边界感。
`, 'utf8');
  writeFileSync(join(dir, 'config.yaml'), 'agent:\n  name: 小花\n  yuan: hanako\n', 'utf8');
  mkdirSync(join(dir, 'avatars'), { recursive: true });
  mkdirSync(join(dir, 'memory'), { recursive: true });
  writeFileSync(join(dir, 'memory', 'pinned.md'), [
    '- 访客甲希望伙伴用亲近的称呼来叫她，不要叫"用户"，觉得冰冷。',
    '- 访客甲要求伙伴遵循"诚实边界"原则：信息不足时直接诚实承认，不编造、不强行凑答案。',
    '- 云服务器：203.0.113.10，SSH 端口 1243，用户名 demo。登录方式：优先 SSH 密钥。',
    '- 访客甲喜欢用缩略/谐音简称称呼人或物，这是她的表达方式。',
  ].join('\n') + '\n', 'utf8');
}

const mockCtx = { pluginId: 'hanabrew' };

test('sanitizeMemory 洗掉技术/隐私，保留性格层', () => {
  const input = [
    '访客甲希望伙伴用亲近的称呼来叫她，不要叫"用户"，觉得冰冷。',
    '云服务器：203.0.113.10，SSH 端口 1243，用户名 demo。',
    '所有助手产出文件时，默认放工作目录（D:\\work）。',
    '插件发布规则：打干净 zip 并算好 sha256 指纹。',
    '访客甲喜欢用缩略/谐音简称称呼人或物，这是她的表达方式。',
  ].join('\n');
  const out = sanitizeMemory(input);
  assert.ok(out.includes('称呼'), '应保留称呼类性格记忆');
  assert.ok(out.includes('简称'), '应保留相处习惯');
  assert.doesNotMatch(out, /服务器|SSH|demo|work|zip|sha256/, '应洗掉技术/隐私');
});

test('sanitizeMemory 空输入返回空', () => {
  assert.equal(sanitizeMemory(''), '');
  assert.equal(sanitizeMemory(null), '');
  assert.equal(sanitizeMemory(undefined), '');
});

test('sanitizeMemory 洗掉拼音/英文敏感词（含密码/密钥场景）', () => {
  const input = [
    '云服务器：203.0.113.10，SSH 端口 1243，用户名 demo。登录方式：优先 SSH 密钥（私钥路径 D:\\work\\demo.pem），备用密码 Passw0rd9876。',
    'GitHub 2FA 恢复码备份了两处：D:\\work\\recovery-codes.txt 和邮箱云盘。',
    '访客甲想开的代充网站：example-vpn.com，价格 $23.99/月，优惠码 COUPON10。',
    'mongodb://admin:pw@1.2.3.4:27017 是内网数据库连接串。',
    '访客甲希望伙伴用亲近的称呼来叫她，不要叫"用户"，觉得冰冷。',
    '访客甲希望日常对话中能用大白话就用大白话，尤其涉及技术话题时优先用通俗解释。',
  ].join('\n\n');
  const out = sanitizeMemory(input);
  assert.ok(out.includes('称呼'), '应保留称呼类性格记忆');
  assert.ok(out.includes('大白话'), '「技术话题用大白话」是相处习惯，应保留');
  assert.doesNotMatch(out, /服务器|SSH|demo\.pem|Passw0rd9876|恢复码|example-vpn|COUPON10|mongodb|27017|1\.2\.3\.4/, '应洗掉所有凭据/服务器/连接串');
});

test('sanitizeMemory 行级：性格词+凭据同行整行丢弃', () => {
  const input = '她信任我，所以把密码告诉了我：Passw0rd9876，让我帮她管理服务器。\n\n她喜欢亲近的称呼，觉得叫名字比叫用户温暖。';
  const out = sanitizeMemory(input);
  assert.doesNotMatch(out, /信任|密码|Passw0rd9876|服务器/, '含凭据的行应整行丢弃');
  assert.ok(out.includes('称呼'), '纯性格行应保留');
});

test('sanitizeMemory 行内抹除：保留行内隐蔽敏感子串被替换', () => {
  const input = '她家在 192.168.1.100 附近，我们常在那里见面。\n\n她喜欢薄荷色，总说那是让人安心的颜色。';
  const out = sanitizeMemory(input);
  // 含 IP 的行被整行丢弃；纯性格行保留
  assert.doesNotMatch(out, /192\.168\.1\.100/, '含 IP 的行应被丢弃');
  assert.ok(out.includes('薄荷'), '纯性格行应保留');
});

test('buildAgentCard 组装标准 V2 卡片', () => {
  const files = {
    agentId: 'hanako',
    name: '小花',
    identity: '# 小花\n个人助手',
    description: '兼具感性与理性的助手',
    agentsMd: '- 有温度\n<!-- biaoqingbao-dialect:start -->\n四川话\n<!-- biaoqingbao-dialect:end -->',
    publicMd: '对外访客模式',
    avatarPath: null,
    exists: true,
  };
  const card = buildAgentCard(files, { withMemory: true, memoryText: '她记得访客甲喜欢亲近的称呼。', userName: '访客甲' });
  assert.equal(card.spec, 'chara_card_v2');
  assert.equal(card.spec_version, '2.0');
  assert.equal(card.data.name, '小花');
  assert.ok(card.data.description.includes('有温度'));
  assert.ok(card.data.personality.includes('四川话'), '方言进 personality');
  assert.ok(card.data.scenario.includes('单向快照'), '场景标注单向');
  assert.doesNotMatch(card.data.scenario, /对外访客|不是.*本人/, '酒馆卡不能套用外部访客人格');
  assert.ok(card.data.creator_notes.includes('hanako'));
  assert.ok(card.data.extensions['hanabrew-agent-export'].oneWay === true, '扩展标记单向');
  assert.ok(card.data.character_book.entries.length >= 1, '记忆进世界书');
});

test('buildAgentCard 不带记忆时不生成世界书', () => {
  const files = { agentId: 'companion', name: '测试伙伴', description: '感性助手', agentsMd: '', publicMd: '', identity: '', avatarPath: null, exists: true };
  const card = buildAgentCard(files, { withMemory: false });
  assert.equal(card.data.character_book, null);
  assert.equal(card.data.character_book, null);
});

test('buildBookEntries 生成可触发条目', () => {
  const entries = buildBookEntries('她记得访客甲喜欢亲近的称呼。\n\n她总在访客甲自我否定时指出闪光点。', '访客甲');
  assert.ok(entries.length >= 2);
  assert.ok(entries[0].keys.length >= 1);
  assert.ok(entries[0].keys.includes('访客甲'));
  assert.ok(entries[0].content.includes('亲近'));
  assert.ok(entries[0].position === 'before_char');
  assert.equal(entries[0].selective, true);
});

test('listExportableAgents 过滤临时来访者', () => {
  writeHanakoAgent();
  mkdirSync(join(process.env.HANA_HOME, 'agents', 'hanabrew-visitor-abc'), { recursive: true });
  mkdirSync(join(process.env.HANA_HOME, 'agents', 'reviewer'), { recursive: true });
  writeFileSync(join(process.env.HANA_HOME, 'agents', 'reviewer', 'identity.md'), '# 审查伙伴\n理性助手\n', 'utf8');
  mkdirSync(join(process.env.HANA_HOME, 'agents', 'xiaohua'), { recursive: true });
  writeFileSync(join(process.env.HANA_HOME, 'agents', 'xiaohua', 'config.yaml'), 'agent:\n  name: 小花2\n', 'utf8');
  writeFileSync(join(process.env.HANA_HOME, 'agents', 'xiaohua', '.deleted-agent.json'), JSON.stringify({ agentId: 'xiaohua', agentName: '小花2' }), 'utf8');
  const agents = listExportableAgents(mockCtx);
  const ids = agents.map((a) => a.agentId);
  assert.ok(ids.includes('hanako'));
  assert.ok(ids.includes('reviewer'));
  assert.ok(!ids.includes('hanabrew-visitor-abc'), '临时来访者应被过滤');
  assert.ok(!ids.includes('xiaohua'), '有删除标记的助手应被过滤');
});

test('伙伴出口列表与预览按 Hana Yuan 使用对应默认头像', () => {
  writeHanakoAgent();
  const agentDir = join(process.env.HANA_HOME, 'agents', 'reviewer');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'config.yaml'), 'agent:\n  name: 审查伙伴\n  yuan: ming\n', 'utf8');
  const productDir = join(root, 'product');
  const defaultAvatar = join(productDir, 'desktop', 'dist-renderer', 'assets', 'Ming.png');
  mkdirSync(join(productDir, 'desktop', 'dist-renderer', 'assets'), { recursive: true });
  const png = readFileSync(DEFAULT_HANAKO_AVATAR_PATH);
  writeFileSync(defaultAvatar, png);

  const item = listExportableAgents({ productDir }).find((agent) => agent.agentId === 'reviewer');
  assert.ok(item);
  assert.equal(item.hasAvatar, false);
  assert.equal(item.avatarSource, 'Hana 默认头像');
  assert.equal(item.avatarDataUrl, `data:image/png;base64,${png.toString('base64')}`);
  const preview = getAgentExportPreview('reviewer', { productDir });
  assert.equal(preview.avatarSource, 'Hana 默认头像');
  assert.equal(preview.avatarDataUrl, item.avatarDataUrl);
});

test('伙伴出口兼容当前助手根目录 pinned.md', () => {
  writeHanakoAgent();
  const dir = join(process.env.HANA_HOME, 'agents', 'hanako');
  rmSync(join(dir, 'memory', 'pinned.md'), { force: true });
  writeFileSync(join(dir, 'pinned.md'), '- 她喜欢亲近的称呼，也重视诚实边界。\n', 'utf8');
  const preview = getAgentExportPreview('hanako', mockCtx);
  assert.equal(preview.memoryLineCount, 1);
  assert.match(preview.memoryPreview, /诚实边界/);
});

test('getAgentExportPreview 返回预览与清洗明细', () => {
  writeHanakoAgent();
  const preview = getAgentExportPreview('hanako', mockCtx);
  assert.equal(preview.name, '小花');
  assert.equal(preview.hasDialect, true);
  assert.equal(preview.avatarSource, 'Hana 默认头像');
  assert.match(preview.avatarDataUrl, /^data:image\/png;base64,/);
  assert.ok(preview.willCarry.dialect === true);
  assert.ok(preview.willCarry.avatar === true);
  assert.ok(preview.memoryLineCount >= 2, '应有清洗后的记忆');
  assert.doesNotMatch(preview.memoryPreview, /服务器|SSH/, '预览里不应有隐私');
});

test('带删除标记的助手不会被预览或导出', async () => {
  writeHanakoAgent();
  const dir = join(process.env.HANA_HOME, 'agents', 'hanako');
  writeFileSync(join(dir, '.deleted-agent.json'), JSON.stringify({ agentId: 'hanako', agentName: '小花' }), 'utf8');
  assert.throws(() => getAgentExportPreview('hanako', mockCtx), /找不到/);
  await assert.rejects(() => exportAgentToTavern('hanako', {}, mockCtx), /找不到/);
});

test('exportAgentToTavern 落盘带头像的 PNG 角色卡且可被花酿解析', async () => {
  writeHanakoAgent();
  const result = await exportAgentToTavern('hanako', { userName: '测试用户' }, mockCtx);
  assert.equal(result.ok, true);
  assert.equal(result.name, '小花');
  assert.equal(result.fileName, '小花.png');
  assert.equal(result.avatarSource, 'Hana 默认头像');
  assert.ok(existsSync(DEFAULT_HANAKO_AVATAR_PATH));
  assert.ok(existsSync(result.filePath));
  const raw = readFileSync(result.filePath);
  assert.equal(isPng(raw), true);
  const parsed = readEmbeddedCard(raw);
  const parsedByTavern = JSON.parse(readTavernPngCard(raw));
  const v2 = readEmbeddedCard(raw, 'chara');
  assert.equal(parsed.data.name, '小花');
  assert.equal(parsed.spec, 'chara_card_v3');
  assert.equal(parsed.spec_version, '3.0');
  assert.equal(parsedByTavern.spec, 'chara_card_v3');
  assert.equal(parsedByTavern.data.name, '小花');
  assert.equal(v2.spec, 'chara_card_v2');
  assert.equal(v2.spec_version, '2.0');
  assert.ok(parsed.data.description.length > 0);
  assert.ok(parsed.data.character_book?.entries?.length >= 1, '世界书应被写入');
  assert.ok(parsed.data.creator_notes.includes('单向快照'));
  assert.equal(parsed.data.extensions['hanabrew-agent-export'].oneWay, true);
  assert.equal(parsed.data.name, '小花');
});

test('导出时优先使用助手头像并直接嵌入 PNG', async () => {
  writeHanakoAgent();
  // 造一个 1x1 PNG，确认不会另写 avatar sidecar。
  const fakePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  writeFileSync(join(process.env.HANA_HOME, 'agents', 'hanako', 'avatars', 'agent.png'), fakePng);
  const legacyPath = join(process.env.APPDATA, 'hanabrew', 'st-data', 'default-user', 'characters', '小花.json');
  writeFileSync(legacyPath, JSON.stringify({ data: { extensions: { 'hanabrew-agent-export': { oneWay: true } } } }), 'utf8');
  const result = await exportAgentToTavern('hanako', { userName: '测试用户' }, mockCtx);
  assert.equal(result.avatarSource, '伙伴头像');
  assert.equal(isPng(readFileSync(result.filePath)), true);
  assert.ok(readEmbeddedCard(readFileSync(result.filePath)));
  assert.equal(existsSync(join(process.env.APPDATA, 'hanabrew', 'st-data', 'default-user', 'characters', result.name + '-avatar.png')), false);
  assert.equal(existsSync(legacyPath), false, '旧版伙伴出口 JSON 应被清理');
});

test('角色名含非法路径字符时文件名被安全化', async () => {
  writeHanakoAgent();
  const dir = join(process.env.HANA_HOME, 'agents', 'hanako');
  writeFileSync(join(dir, 'config.yaml'), 'agent:\n  name: 小花/测试:版*v1\n', 'utf8');
  const result = await exportAgentToTavern('hanako', { userName: '测试用户' }, mockCtx);
  assert.ok(!/[\\/:*?"<>|]/.test(result.fileName), '文件名不应含非法路径字符');
  assert.equal(result.name, '小花_测试_版_v1');
});

test('导出不存在的助手时报错', async () => {
  await assert.rejects(() => exportAgentToTavern('no-such-agent', {}, mockCtx), /找不到/);
});

test('非法的 agentId（路径穿越）被拒绝', async () => {
  for (const evil of ['..', '../..', 'hanako/../../', '..\\..', 'a b', '', 'x'.repeat(81)]) {
    await assert.rejects(() => exportAgentToTavern(evil, {}, mockCtx), /非法/, `agentId=${evil} 应被拒绝`);
    assert.throws(() => getAgentExportPreview(evil, mockCtx), /非法/, `preview agentId=${evil} 应被拒绝`);
  }
});
