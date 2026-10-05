/**
 * 重绘鼠标键位图块（mouseL / mouseM / mouseR）。
 *
 * 为什么需要它：
 *   tools/extract-input-prompts.mjs 里的切图坐标 mouseL:[3,11] / mouseR:[3,12] / mouseM:[3,13]
 *   取到的三张图**高亮块位置互相错位**——mouseL 的高亮正好压在滚轮位（看起来就是中键），
 *   玩家认不出哪个是左键。原图集不在仓库里没法重新认图，所以这里按 Kenney 的配色风格直接画。
 *
 * 画法（16x16，透明背景，与其它图块同规格）：
 *   竖放的鼠标：上方是左右键（左 4 列 / 中缝 2 列 / 右 4 列），下方是手掌；
 *   中缝里放一个滚轮；被按下的那个键填亮蓝，滚轮固定黄。
 */
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const OUT_DIR = 'public/ui/keys';
const W = 16, H = 16;

// 配色（与 Kenney Input Prompts 观感一致）
const STROKE = [0x39, 0x42, 0x4f, 255];  // 外描边（深灰）
const BODY   = [0x7b, 0x8a, 0x9c, 255];  // 鼠标主体（中灰）
const HI     = [0x2e, 0xa8, 0xf5, 255];  // 按下高亮（亮蓝）
const WHEEL  = [0xff, 0xd2, 0x3f, 255];  // 滚轮（黄）
const NONE   = [0, 0, 0, 0];             // 透明

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
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 圆角矩形判定：中心线内外推 r 的圆角
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r + 0.35;
}

// 键盘分区：鼠标外框 x2..13 / y0..15；主体 x3..12 / y1..14
// 左右键区 y1..6；左键 x3..6，中缝 x7..8（放滚轮），右键 x9..12
const inMouse = (x, y) => inRoundRect(x, y, 2, 0, 13, 15, 4);
const inBody  = (x, y) => inRoundRect(x, y, 3, 1, 12, 14, 3);
const inLeft  = (x, y) => inBody(x, y) && y <= 6 && x >= 3 && x <= 6;
const inRight = (x, y) => inBody(x, y) && y <= 6 && x >= 9 && x <= 12;
const inSeam  = (x, y) => inBody(x, y) && y <= 6 && x >= 7 && x <= 8;
const inWheel = (x, y) => x >= 7 && x <= 8 && y >= 3 && y <= 5;

// which: 'L' 左键高亮 | 'R' 右键高亮 | 'M' 滚轮高亮
function draw(which) {
  const rgba = Buffer.alloc(W * H * 4);
  const put = (x, y, c) => {
    const i = (y * W + x) * 4;
    rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = c[3];
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!inMouse(x, y)) { put(x, y, NONE); continue; }
      if (!inBody(x, y)) { put(x, y, STROKE); continue; } // 外描边

      // 被按下的键 → 高亮蓝
      if (which === 'L' && inLeft(x, y)) { put(x, y, HI); continue; }
      if (which === 'R' && inRight(x, y)) { put(x, y, HI); continue; }
      if (which === 'M' && inWheel(x, y)) { put(x, y, HI); continue; }

      // 滚轮（固定黄）
      if (inWheel(x, y)) { put(x, y, WHEEL); continue; }
      // 中缝淡一点，做出左右键的分隔感
      if (inSeam(x, y)) { put(x, y, STROKE); continue; }
      put(x, y, BODY);
    }
  }
  return encodePNG(rgba, W, H);
}

for (const [name, which] of [['mouseL', 'L'], ['mouseM', 'M'], ['mouseR', 'R']]) {
  writeFileSync(`${OUT_DIR}/${name}.png`, draw(which));
  console.log('written', `${OUT_DIR}/${name}.png`, `(highlight=${which})`);
}
