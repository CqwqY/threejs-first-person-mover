// 自检：环境反射的色偏校正（src/world/SkyBox.js 的 correctEnvColor）
//   node tools/probe-envcolor.mjs
//
// 为什么要有这个：夜里/深夜的金属反射发紫，根因是那两张天空图"蓝远大于绿"
// （实测上半球「蓝 − 绿」+48 / +44，蓝绿比 1.8~2.1；白天同样口径只有 1.25）。
// 校正逻辑改坏了、或者哪天换了贴图，紫色就会悄悄回来 —— 这里直接拿**真实贴图的像素**验证。
import fs from 'node:fs';
import zlib from 'node:zlib';
import { correctEnvColor } from '../src/world/SkyBox.js';

let fail = 0;
function check(name, ok, extra = '') {
  if (!ok) fail++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (extra ? '  ' + extra : ''));
}

// 极简调色板 PNG 解码（这几张图是 colortype=3，索引 + PLTE）
function readPalPNG(path) {
  const b = fs.readFileSync(path);
  let p = 8, w = 0, h = 0, idat = [], plte = null;
  while (p < b.length) {
    const len = b.readUInt32BE(p);
    const type = b.toString('ascii', p + 4, p + 8);
    const d = b.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); }
    else if (type === 'PLTE') plte = d;
    else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(w * h);
  let ip = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[ip++];
    for (let x = 0; x < w; x++) {
      const rv = raw[ip++];
      const a = x > 0 ? out[y * w + x - 1] : 0;
      const bb = y > 0 ? out[(y - 1) * w + x] : 0;
      const c = (x > 0 && y > 0) ? out[(y - 1) * w + x - 1] : 0;
      let v;
      if (ft === 0) v = rv;
      else if (ft === 1) v = rv + a;
      else if (ft === 2) v = rv + bb;
      else if (ft === 3) v = rv + ((a + bb) >> 1);
      else {
        const pa = Math.abs(bb - c), pb = Math.abs(a - c), pc = Math.abs(a + bb - 2 * c);
        v = rv + (pa <= pb && pa <= pc ? a : (pb <= pc ? bb : c));
      }
      out[y * w + x] = v & 0xff;
    }
  }
  return { w, h, idx: out, plte };
}

// 只统计上半球（等距圆柱图的上半 = 天空），环境反射主要来自这里
function skyStats(path, correct) {
  const { w, h, idx, plte } = readPalPNG(path);
  const step = 8;
  const px = new Uint8ClampedArray(w * h * 4);
  let n = 0, sr = 0, sg = 0, sb = 0;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = idx[y * w + x] * 3;
      const o = n * 4;
      px[o] = plte[i]; px[o + 1] = plte[i + 1]; px[o + 2] = plte[i + 2]; px[o + 3] = 255;
      n++;
    }
  }
  const small = px.subarray(0, n * 4);
  if (correct) correctEnvColor(small);
  for (let k = 0; k < n; k++) {
    sr += small[k * 4]; sg += small[k * 4 + 1]; sb += small[k * 4 + 2];
  }
  const R = sr / n, G = sg / n, B = sb / n;
  return { R, G, B, blueOverGreen: B - G, blueOverRed: B - R };
}

const DIR = 'E:/玩法/first-person-mover/public/sky/';
console.log('上半球色偏（「蓝 − 绿」越大越紫）：');
for (const key of ['night', 'space', 'day', 'morning']) {
  const path = DIR + 'skybox-' + key + '.png';
  if (!fs.existsSync(path)) { console.log('  （跳过，缺 ' + path + '）'); continue; }
  const before = skyStats(path, false);
  const after = skyStats(path, true);
  console.log(
    `  ${key.padEnd(8)} 校正前 蓝−绿 ${before.blueOverGreen.toFixed(1).padStart(6)}` +
    `   校正后 ${after.blueOverGreen.toFixed(1).padStart(6)}`
  );
  if (key === 'night' || key === 'space') {
    // 判据：紫必须被压掉一半以上，且不能矫枉过正把天空压成灰（蓝仍应高于绿一点）
    check(`${key}：紫被压掉一半以上`, after.blueOverGreen < before.blueOverGreen * 0.5,
      `(${before.blueOverGreen.toFixed(1)} → ${after.blueOverGreen.toFixed(1)})`);
    check(`${key}：仍保留一点冷色（没被压成灰）`, after.blueOverGreen > 2, `(${after.blueOverGreen.toFixed(1)})`);
  }
  if (key === 'morning') {
    // 暖色不能被"去紫"误伤：清晨的蓝−绿是负的（偏橙），校正后不能变成正的
    check('morning：暖色没被误伤（蓝−绿仍为负）', after.blueOverGreen < 0, `(${after.blueOverGreen.toFixed(1)})`);
  }
}

// 纯函数基本性质
console.log('函数性质：');
const t1 = new Uint8ClampedArray([0, 0, 0, 255]);
correctEnvColor(t1);
check('纯黑仍是黑', t1[0] === 0 && t1[1] === 0 && t1[2] === 0, true);
const t2 = new Uint8ClampedArray([255, 255, 255, 255]);
correctEnvColor(t2);
check('纯白仍是白（灰度不受去饱和影响）', t2[0] === 255 && t2[1] === 255 && t2[2] === 255, true);
const t3 = new Uint8ClampedArray([255, 200, 100, 255]);
correctEnvColor(t3);
// 蓝(100) < 绿(200)：属于暖色，"蓝紫压制"应当完全不生效，只走去饱和。
// 去饱和会把偏暗的蓝往灰度提，所以 B 一定**上升** —— 断言它精确等于"只去饱和"的结果。
const gray3 = 0.2126 * 255 + 0.7152 * 200 + 0.0722 * 100;
const wantB = 100 + (gray3 - 100) * 0.35;
check('暖色：只去饱和，蓝紫压制未生效', Math.abs(t3[2] - wantB) < 1, `B=${t3[2]}（纯去饱和应为 ${wantB.toFixed(1)}）`);

console.log(fail ? `\n✗ ${fail} 项失败` : '\n✓ 全部通过');
process.exit(fail ? 1 : 0);
