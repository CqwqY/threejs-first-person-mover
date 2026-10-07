// 把 Kenney 家具预览小图（E:/玩法/furniture/previews/*.png，尺寸不一、贴外框裁剪）
// 合成为统一 192x192 透明画布，输出到 public/furn-previews/<id>.png，供商店卡片做预览。
// 用法：node tools/gen-furn-previews.mjs
// 说明：
//   - 缩放用「盒式面积平均」（目标像素映射回源矩形取平均），alpha 预乘避免透明边缘发黑。
//   - furn_sofa（老 id）不在预览集里，用 furn_lounge_sofa 的图代替（同为布艺沙发，外形接近）。
//   - 预览缺失的商品在商店里自动回退为矢量图标（ShopPanel onerror），不依赖这里补齐。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePNG, encodePNG } from './lib-png.mjs';

const SRC_DIR = 'E:/玩法/furniture/previews';
// fileURLToPath 才能正确处理中文路径（pathname 是 URL 编码的，直接用会写到一个带 %xx 的假目录里）
const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'furn-previews');
const CANVAS = 192;      // 输出画布边长
const FIT = 168;         // 模型最长边在画布内占的像素
const PAD = (CANVAS - FIT) / 2;

fs.mkdirSync(OUT_DIR, { recursive: true });

// 盒式缩放：把 src(w,h,RGBA) 缩放到 (dw,dh)。alpha 预乘平均后再除回。
function resample(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  for (let dy = 0; dy < dh; dy++) {
    const y0 = Math.floor((dy * sh) / dh), y1 = Math.max(y0 + 1, Math.ceil(((dy + 1) * sh) / dh));
    for (let dx = 0; dx < dw; dx++) {
      const x0 = Math.floor((dx * sw) / dw), x1 = Math.max(x0 + 1, Math.ceil(((dx + 1) * sw) / dw));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let y = y0; y < y1 && y < sh; y++) {
        for (let x = x0; x < x1 && x < sw; x++) {
          const i = (y * sw + x) * 4;
          const al = src[i + 3] / 255;
          r += src[i] * al; g += src[i + 1] * al; b += src[i + 2] * al; a += al; n++;
        }
      }
      const o = (dy * dw + dx) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
        out[o + 3] = Math.round((a / n) * 255);
      }
    }
  }
  return out;
}

// 把缩放后的图贴到画布中央
function blit(canvas, img, dw, dh, ox, oy) {
  for (let y = 0; y < dh; y++) {
    const cy = oy + y;
    if (cy < 0 || cy >= CANVAS) continue;
    for (let x = 0; x < dw; x++) {
      const cx = ox + x;
      if (cx < 0 || cx >= CANVAS) continue;
      const si = (y * dw + x) * 4, di = (cy * CANVAS + cx) * 4;
      const sa = img[si + 3] / 255, da = canvas[di + 3] / 255;
      const oa = sa + da * (1 - sa);
      if (oa <= 0) continue;
      for (let k = 0; k < 3; k++) {
        canvas[di + k] = Math.round((img[si + k] * sa + canvas[di + k] * da * (1 - sa)) / oa);
      }
      canvas[di + 3] = Math.round(oa * 255);
    }
  }
}

// 调色板 PNG（ctype 3）展开成 RGBA：decodePNG 返回每像素 1 字节索引 + PLTE/tRNS 表
function expandPalette(dec) {
  if (!dec.plte) throw new Error('缺 PLTE 表');
  const rgba = Buffer.alloc(dec.w * dec.h * 4);
  for (let i = 0; i < dec.w * dec.h; i++) {
    const idx = dec.px[i];
    rgba[i * 4] = dec.plte[idx * 3];
    rgba[i * 4 + 1] = dec.plte[idx * 3 + 1];
    rgba[i * 4 + 2] = dec.plte[idx * 3 + 2];
    rgba[i * 4 + 3] = dec.trns && idx < dec.trns.length ? dec.trns[idx] : 255;
  }
  return rgba;
}

const names = fs.readdirSync(SRC_DIR).filter((f) => f.toLowerCase().endsWith('.png'));
if (!names.includes('furn_lounge_sofa.png')) throw new Error('源图里没有 furn_lounge_sofa.png，无法替补 furn_sofa');
const jobs = names.map((f) => [f.replace(/\.png$/i, ''), path.join(SRC_DIR, f)]);
jobs.push(['furn_sofa', path.join(SRC_DIR, 'furn_lounge_sofa.png')]); // 老 id 替补

let ok = 0;
const failed = [];
for (const [id, file] of jobs) {
  try {
    const raw = fs.readFileSync(file);
    const dec = decodePNG(raw);
    const px = dec.bpp === 4 ? dec.px : expandPalette(dec);
    const long = Math.max(dec.w, dec.h);
    let dw = Math.max(1, Math.round((dec.w * FIT) / long));
    let dh = Math.max(1, Math.round((dec.h * FIT) / long));
    if (dw > FIT) { dw = FIT; }
    if (dh > FIT) { dh = FIT; }
    const small = resample(px, dec.w, dec.h, dw, dh);
    const canvas = Buffer.alloc(CANVAS * CANVAS * 4);
    blit(canvas, small, dw, dh, Math.round(PAD - dw / 2) + Math.round(FIT / 2), Math.round(PAD - dh / 2) + Math.round(FIT / 2));
    fs.writeFileSync(path.join(OUT_DIR, id + '.png'), encodePNG(canvas, CANVAS, CANVAS));
    ok++;
  } catch (e) {
    failed.push(id + ' (' + e.message + ')');
  }
}
console.log('生成 ' + ok + '/' + jobs.length + ' 张 -> public/furn-previews/');
if (failed.length) console.log('失败（商店里会回退矢量图标）:\n  ' + failed.join('\n  '));
const total = fs.readdirSync(OUT_DIR).reduce((s, f) => s + fs.statSync(path.join(OUT_DIR, f)).size, 0);
console.log('总体积 ' + (total / 1024 / 1024).toFixed(2) + ' MB');
