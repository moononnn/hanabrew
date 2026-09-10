import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCharacter,
  importCharacter,
  listCharacters,
  updateCharacter,
} from '../backend/characters.js';
import { isPng, readEmbeddedCard } from '../backend/png-card.js';

let root;
let previousAppData;

before(() => {
  previousAppData = process.env.APPDATA;
  root = join(tmpdir(), `hanabrew-characters-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  process.env.APPDATA = join(root, 'appdata');
  mkdirSync(join(process.env.APPDATA, 'hanabrew', 'st-data', 'default-user', 'characters'), { recursive: true });
});

after(() => {
  if (previousAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = previousAppData;
  rmSync(root, { recursive: true, force: true });
});

test('新建角色保存为 SillyTavern 可识别的 PNG 卡片', async () => {
  const result = await createCharacter({
    id: 'new-character',
    name: '新角色',
    prompt: '温柔又可靠',
    greeting: '你好呀',
  });
  const filePath = join(process.env.APPDATA, 'hanabrew', 'st-data', 'default-user', 'characters', result.fileName);
  assert.equal(result.fileName, 'new-character.png');
  assert.ok(existsSync(filePath));
  const raw = readFileSync(filePath);
  assert.equal(isPng(raw), true);
  const card = readEmbeddedCard(raw);
  assert.equal(card.data.name, '新角色');
  assert.equal(card.data.first_mes, '你好呀');
  assert.equal(card.spec, 'chara_card_v3');
  const listed = (await listCharacters()).find((item) => item.id === 'new-character');
  assert.equal(listed.prompt, '温柔又可靠');
  assert.equal(listed.greeting, '你好呀');
});

test('角色导入支持 JSON/YAML/PNG，并保留卡片字段与 PNG 头像', async () => {
  const complexCard = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      id: 'complex-card',
      name: '复杂角色',
      description: '完整设定',
      personality: '耐心',
      scenario: '在书房',
      first_mes: '欢迎。',
      mes_example: '<START>\\n{{user}}：你好\\n{{char}}：你好。',
      alternate_greetings: ['另一种开场'],
      character_book: { name: '内嵌世界书', entries: [{ keys: ['书房'], content: '有一盏灯。' }] },
      extensions: { mvu: { schema: { affection: 'number' } }, custom: { enabled: true } },
    },
  };
  const jsonResult = await importCharacter({ text: JSON.stringify(complexCard) });
  const jsonPath = join(process.env.APPDATA, 'hanabrew', 'st-data', 'default-user', 'characters', jsonResult.fileName);
  const jsonData = readEmbeddedCard(readFileSync(jsonPath)).data;
  assert.equal(jsonData.name, '复杂角色');
  assert.deepEqual(jsonData.character_book, complexCard.data.character_book);
  assert.deepEqual(jsonData.extensions, complexCard.data.extensions);
  assert.deepEqual(jsonData.alternate_greetings, complexCard.data.alternate_greetings);

  const yamlText = ['name: YAML角色', 'description: YAML设定', 'first_mes: YAML开场', 'tags:', '  - 测试', ''].join('\n');
  const yamlResult = await importCharacter({ text: yamlText });
  const yamlPath = join(process.env.APPDATA, 'hanabrew', 'st-data', 'default-user', 'characters', yamlResult.fileName);
  const yamlData = readEmbeddedCard(readFileSync(yamlPath)).data;
  assert.equal(yamlData.name, 'YAML角色');
  assert.equal(yamlData.description, 'YAML设定');
  assert.deepEqual(yamlData.tags, ['测试']);

  const source = await createCharacter({ id: 'source-card', cardData: complexCard.data });
  const sourcePath = join(process.env.APPDATA, 'hanabrew', 'st-data', 'default-user', 'characters', source.fileName);
  const pngResult = await importCharacter({ filePath: sourcePath });
  const pngPath = join(process.env.APPDATA, 'hanabrew', 'st-data', 'default-user', 'characters', pngResult.fileName);
  assert.notEqual(pngResult.fileName, source.fileName, '导入同目录 PNG 不应覆盖来源卡');
  assert.deepEqual(readEmbeddedCard(readFileSync(pngPath)).data.character_book, complexCard.data.character_book);
  assert.equal(isPng(readFileSync(pngPath)), true);
});

test('旧 JSON 角色更新后生成 PNG，并在 Hana 兼容扫描中去重', async () => {
  const charDir = join(process.env.APPDATA, 'hanabrew', 'st-data', 'default-user', 'characters');
  writeFileSync(join(charDir, 'legacy-id.json'), JSON.stringify({
    data: {
      id: 'legacy-id',
      name: '方淮',
      description: '旧设定',
      personality: '旧设定',
      first_mes: '旧开场',
      tags: [],
    },
  }), 'utf8');

  const result = await updateCharacter({ id: 'legacy-id', prompt: '更新后的设定' });
  const pngPath = join(charDir, 'legacy-id.png');
  assert.equal(result.fileName, 'legacy-id.png');
  assert.ok(existsSync(pngPath));
  assert.equal(readEmbeddedCard(readFileSync(pngPath)).data.description, '更新后的设定');

  const characters = await listCharacters({}, { shallow: false });
  assert.equal(characters.filter((item) => item.name === '方淮').length, 1);
  assert.equal(characters.find((item) => item.name === '方淮')._fileType, 'png');
});
