/**
 * 把 public/ui/keys/<name>.png 打成 ASCII 图，用来**肉眼核对键帽上到底是哪个字母**。
 *
 * 为什么需要：
 *   Kenney 图集没有命名文件，键位图块全靠 tools/extract-input-prompts.mjs 里手写的 (row,col) 坐标认。
 *   坐标一旦错位，图块就会显示成**别的按键**（例如想看 G、实际画的是 F），而 PNG 文件名却看不出问题。
 *   这个脚本把图块按亮度打成字符画，字母形状直接可读。
 *
 * 用法：
 *   node tools/dump-key-tile.mjs g b mouseL        # 一次看多个
 *   node tools/dump-key-tile.mjs w a s d          # 核对移动键
 *
 * 输出约定：空白=透明；'.'=键帽底色；'#'=亮的笔画（即字母本身，或鼠标的高亮块）。
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const DIR = 'public/ui/keys';

function decodePNG(file) {
  const buf = readFileSync(file);
  let off = 8, w = 0, h = 0, ct = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.slice(off + 4, off + 8).toString('ascii');
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = ct === 6 ? 4 : 3;
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[p++];
    for (let x = 0; x < stride; x++) {
      const rv = raw[p++];
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = (x >= bpp && y > 0) ? out[(y - 1) * stride + x - bpp] : 0;
      let v;
      if (ft === 0) v = rv;
      else if (ft === 1) v = rv + a;
      else if (ft === 2) v = rv + b;
      else if (ft === 3) v = rv + ((a + b) >> 1);
      else {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v = rv + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c));
      }
      out[y * stride + x] = v & 0xff;
    }
  }
  return { w, h, px: out, bpp };
}

const names = process.argv.slice(2);
if (!names.length) {
  console.log('用法：node tools/dump-key-tile.mjs <name> [name...]   例：g b mouseL');
  process.exit(0);
}

for (const n of names) {
  let d;
  try { d = decodePNG(`${DIR}/${n}.png`); }
  catch (e) { console.log(`\n=== ${n}.png 读取失败：${e.message}`); continue; }

  const { w, h, px, bpp } = d;
  const lums = [];
  for (let i = 0; i < w * h; i++) {
    const j = i * bpp;
    const a = bpp === 4 ? px[j + 3] : 255;
    if (a < 40) { lums.push(-1); continue; }
    lums.push((px[j] + px[j + 1] + px[j + 2]) / 3);
  }
  const solid = lums.filter((v) => v >= 0).sort((a, b) => a - b);
  const lo = solid.length ? solid[Math.floor(solid.length * 0.12)] : 0;
  const hi = solid.length ? solid[Math.floor(solid.length * 0.88)] : 255;
  const mid = (lo + hi) / 2;

  console.log(`\n=== ${n}.png  (${w}x${h}, 底色亮度=${lo.toFixed(0)}, 笔画亮度=${hi.toFixed(0)}) ===`);
  for (let y = 0; y < h; y++) {
    let s = '';
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * bpp;
      const a = bpp === 4 ? px[i + 3] : 255;
      if (a < 40) { s += ' '; continue; }
      const lum = (px[i] + px[i + 1] + px[i + 2]) / 3;
      s += lum > mid ? '#' : '.';
    }
    console.log('|' + s + '|');
  }
}
