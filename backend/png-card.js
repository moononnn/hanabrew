import { existsSync, readFileSync } from 'node:fs';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function isPng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < PNG_SIGNATURE.length || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > buffer.length) return false;
    if (buffer.toString('ascii', offset + 4, offset + 8) === 'IEND') return true;
    offset = end;
  }
  return false;
}

async function convertWithJsJimp(buffer) {
  // ST 的 jimp.js 优先使用 WASM 编码器；Node 直接读本地 buffer 时，某些
  // WASM 版本会把 wasm 文件当 fetch URL，故给 JPG/GIF/BMP 留一个纯 JS 兜底。
  const [core, jpeg, png, gif, bmp] = await Promise.all([
    import('../sillytavern/node_modules/@jimp/core/dist/esm/index.js'),
    import('../sillytavern/node_modules/@jimp/js-jpeg/dist/esm/index.js'),
    import('../sillytavern/node_modules/@jimp/js-png/dist/esm/index.js'),
    import('../sillytavern/node_modules/@jimp/js-gif/dist/esm/index.js'),
    import('../sillytavern/node_modules/@jimp/js-bmp/dist/esm/index.js'),
  ]);
  const JsJimp = core.createJimp({ formats: [jpeg.default, png.default, gif.default, bmp.default] });
  const image = await JsJimp.read(buffer);
  return image.getBuffer('image/png');
}

/**
 * 头像统一成 PNG。Hana 当前保存的助手头像通常已经是 PNG；Jimp 只在遇到
 * JPG/WebP/GIF 时按需加载，避免正常导出额外启动图像解析依赖。
 */
export async function readAvatarPng(avatarPath, fallbackPath) {
  for (const candidate of [avatarPath, fallbackPath]) {
    if (!candidate || !existsSync(candidate)) continue;
    let buffer;
    try { buffer = readFileSync(candidate); } catch { continue; }
    if (isPng(buffer)) return buffer;
    try {
      const { Jimp, JimpMime } = await import('../sillytavern/src/jimp.js');
      const image = await Jimp.read(buffer);
      return await image.getBuffer(JimpMime.png);
    } catch {
      try {
        return await convertWithJsJimp(buffer);
      } catch {
        // 头像损坏或格式不受支持时继续尝试 fallback。
      }
    }
  }
  throw new Error('找不到可用的 PNG 头像。');
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  typeBuffer.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return out;
}

function makeTextChunk(keyword, value) {
  return makeChunk('tEXt', Buffer.concat([
    Buffer.from(keyword, 'latin1'),
    Buffer.from([0]),
    Buffer.from(value, 'latin1'),
  ]));
}

/**
 * 把完整角色卡 JSON 写进标准 PNG tEXt 的 chara 与 ccv3 字段。
 * 原头像的像素相关 chunk 原样保留，酒馆只需要读这两份元数据即可。
 */
export function embedCharacterCardPng(avatarPng, card) {
  if (!isPng(avatarPng)) throw new Error('头像必须是 PNG。');
  const encoded = Buffer.from(JSON.stringify(card), 'utf8').toString('base64');
  // SillyTavern 优先读取 ccv3；它要求元数据自身标成 V3。chara 仍保留
  // 原始 V2，兼容只读取旧字段的导入器。
  const v3Card = JSON.parse(JSON.stringify(card));
  v3Card.spec = 'chara_card_v3';
  v3Card.spec_version = '3.0';
  const encodedV3 = Buffer.from(JSON.stringify(v3Card), 'utf8').toString('base64');
  const chunks = [];
  let offset = 8;
  let foundIend = false;

  while (offset + 12 <= avatarPng.length) {
    const length = avatarPng.readUInt32BE(offset);
    const type = avatarPng.toString('ascii', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > avatarPng.length) throw new Error('PNG chunk 越界。');

    let keep = true;
    if (type === 'tEXt') {
      const data = avatarPng.subarray(offset + 8, offset + 8 + length);
      const separator = data.indexOf(0);
      const keyword = separator >= 0 ? data.toString('latin1', 0, separator).toLowerCase() : '';
      if (keyword === 'chara' || keyword === 'ccv3') keep = false;
    }

    if (type === 'IEND') {
      chunks.push(makeTextChunk('chara', encoded));
      chunks.push(makeTextChunk('ccv3', encodedV3));
      foundIend = true;
    }
    if (keep) chunks.push(avatarPng.subarray(offset, end));
    offset = end;
    if (type === 'IEND') break;
  }

  if (!foundIend) throw new Error('PNG 缺少 IEND。');
  return Buffer.concat([PNG_SIGNATURE, ...chunks]);
}

export function readEmbeddedCard(pngBuffer, preferredKeyword = 'ccv3') {
  if (!isPng(pngBuffer)) return null;
  const cards = new Map();
  let offset = 8;
  while (offset + 12 <= pngBuffer.length) {
    const length = pngBuffer.readUInt32BE(offset);
    const type = pngBuffer.toString('ascii', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > pngBuffer.length) return null;
    if (type === 'tEXt') {
      const data = pngBuffer.subarray(offset + 8, offset + 8 + length);
      const separator = data.indexOf(0);
      if (separator >= 0) {
        const keyword = data.toString('latin1', 0, separator).toLowerCase();
        if (keyword === 'chara' || keyword === 'ccv3') {
          try {
            const encoded = data.toString('latin1', separator + 1);
            cards.set(keyword, JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')));
          } catch { return null; }
        }
      }
    }
    offset = end;
    if (type === 'IEND') break;
  }
  return cards.get(String(preferredKeyword).toLowerCase()) || cards.get('chara') || null;
}
