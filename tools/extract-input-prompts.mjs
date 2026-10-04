/**
 * 从 Kenney "Input Prompts Pixel" 图集里切出我们用到的键位图块，存成独立 PNG。
 *
 * 为什么需要这个：
 *   官方只给了 816 个 16x16 图块的图集（34 x 24），**没有任何命名文件**，
 *   想用某个键必须自己认图。这里把认出来的坐标固化成本脚本，
 *   以后升级素材只要重跑一次即可，不必再靠肉眼比对。
 *
 * 坐标是 (row, col)，0 起算，row 向下、col 向右。
 * 认图方法：把图集按 17px 网格切片放大后逐块读出来（见 docs 里的记录）。
 *
 * 输出：public/ui/keys/<name>.png（16x16，透明背景）
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';

const TILE = 17;      // 每块 17x17（16px 图形 + 1px 间隙）
const COLS = 34;

// (row, col) → 语义名。认图结果见下表。
// ⚠ 认图方法：把图集按 17px 网格切片放大后逐块读。字母区从 (2,17)=Q 起是
//   「每行第一个字母在第 17 列」这个规律推出来的 —— 字母表 26 个正好铺 3 行。
// ⚠ SPACE 是**跨 3 格的宽键**（占满第 6 行最右三列到图集边缘），单独标了 spanW。
const TILES = {
  // ---- 字母区（第 2~4 行，第 17 列起）----
  // 字母区 26 个字母不是整齐 3 行：第 2 行 10 个(Q~P)、第 3 行 9 个(A~L)、
  // 第 4 行第 17 列先是一个「上档位」符号，字母从第 18 列的 Z 才开始。
  q: [2, 17], w: [2, 18], e: [2, 19], r: [2, 20], t: [2, 21], y: [2, 22], u: [2, 23],
  i: [2, 24], o: [2, 25], p: [2, 26],
  a: [3, 17], s: [3, 18], d: [3, 19], f: [3, 20], g: [3, 21], h: [3, 22],
  j: [3, 23], k: [3, 24], l: [3, 25],
  z: [4, 18], x: [4, 19], c: [4, 20], v: [4, 21], b: [4, 22], n: [4, 23], m: [4, 25],

  // ---- 数字（第 1 行，col 17 = 1）----
  d1: [1, 17], d2: [1, 18], d3: [1, 19], d4: [1, 20], d5: [1, 21],
  d6: [1, 22], d7: [1, 23], d8: [1, 24], d9: [1, 25], d0: [1, 26],

  // ---- 功能键（🔴 第 8 行，不是第 7 行！ESC 在 col 17）----
  esc: [8, 17],
  f1: [8, 18], f2: [8, 19], f3: [8, 20], f4: [8, 21], f5: [8, 22],
  f6: [8, 23], f7: [8, 24], f8: [8, 25], f9: [8, 26], f10: [8, 27], f11: [8, 28], f12: [8, 29],

  // ---- 修饰键（第 6 行）----
  home: [6, 20], pageup: [6, 21], pagedown: [6, 22],
  del: [6, 27],

  // ---- 鼠标（第 3 行前段）----
  mouseL: [3, 11], mouseR: [3, 12], mouseM: [3, 13],
};

// 跨格的宽键：名字 → [row, col, 宽多少格]
// CTRL / SHIFT / SPACE 都是横跨两格以上的长条，不是 16x16 的方块 —— 硬按方块切会只拿到半个字。
const WIDE = {
  shift: [7, 17, 2],
  ctrl: [6, 17, 2],
  caps: [6, 19, 2],
  space: [6, 31, 3],   // 占满最右三列直到图集边缘
};

// ---- 极简 PNG 编码（只需 8bit RGBA，无交错）----
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- 解 PNG（只支持我们自己需要的那类：8bit RGBA/灰度+alpha，非交错）----
function decodePNG(buf) {
  let p = 8, w = 0, h = 0, depth = 0, ctype = 0, inter = 0;
  let palette = null, trns = null;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      ctype = data[9];
      inter = data[12];
      if (inter !== 0) throw new Error('不支持隔行扫描的 PNG');
    } else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'tRNS') trns = Buffer.from(data);
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (depth !== 8) throw new Error('只支持 8bit，收到 ' + depth);
  // 调色板模式下每像素是 1 字节索引，先按索引解出来再展开成 RGBA
  const indexed = ctype === 3;
  const ch = indexed ? 1 : { 0: 1, 2: 3, 4: 2, 6: 4 }[ctype];
  if (!ch) throw new Error('不支持的 color type ' + ctype);
  if (indexed && !palette) throw new Error('调色板模式但缺少 PLTE');
  // 解压 + 反滤波
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(w * h * ch);
  let ip = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[ip++];
    const line = raw.subarray(ip, ip + stride);
    ip += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 0xff;
    }
  }
  // 调色板 → RGBA
  if (indexed) {
    const rgba = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const idx = out[i];
      rgba[i * 4] = palette[idx * 3];
      rgba[i * 4 + 1] = palette[idx * 3 + 1];
      rgba[i * 4 + 2] = palette[idx * 3 + 2];
      rgba[i * 4 + 3] = trns && idx < trns.length ? trns[idx] : 255;
    }
    return { w, h, ch: 4, data: rgba };
  }
  return { w, h, ch, data: out };
}

const src = process.argv[2];
const outDir = process.argv[3];
if (!src || !outDir) {
  console.error('用法: node tools/extract-input-prompts.mjs <tilemap.png> <输出目录>');
  process.exit(1);
}

const img = decodePNG(readFileSync(src));
console.log(`源图集 ${img.w}x${img.h} (${img.ch} 通道)`);
if (img.w !== COLS * TILE) {
  console.error(`宽度 ${img.w} 与预期 ${COLS * TILE} 不符，确认素材版本`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

// 从图集取一个矩形区域并输出 PNG。
// 注意：图块内容是 16x16，网格步长 17（右侧/下侧各 1px 间隙），
// 所以跨 N 格的宽键实际宽度是 N*17-1，取到右边缘时不能越界。
function cut(row, col, spanW = 1) {
  const w = spanW * TILE - (col + spanW === COLS ? 0 : 1);
  const px = Buffer.alloc(w * 16 * 4);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < w; x++) {
      const sx = col * TILE + x, sy = row * TILE + y;
      const si = (sy * img.w + sx) * img.ch;
      const di = (y * w + x) * 4;
      if (img.ch >= 3) {
        px[di] = img.data[si];
        px[di + 1] = img.data[si + 1];
        px[di + 2] = img.data[si + 2];
        px[di + 3] = img.ch === 4 ? img.data[si + 3] : 255;
      } else {
        const g = img.data[si];
        px[di] = px[di + 1] = px[di + 2] = g;
        px[di + 3] = img.ch === 2 ? img.data[si + 1] : 255;
      }
    }
  }
  return { px, w };
}

let n = 0;
for (const [name, [row, col]] of Object.entries(TILES)) {
  const { px, w } = cut(row, col, 1);
  writeFileSync(`${outDir}/${name}.png`, encodePNG(px, w, 16));
  n++;
}
for (const [name, [row, col, spanW]] of Object.entries(WIDE)) {
  const { px, w } = cut(row, col, spanW);
  writeFileSync(`${outDir}/${name}.png`, encodePNG(px, w, 16));
  n++;
}
console.log(`已导出 ${n} 个键位图块 → ${outDir}`);
