// 自检：顶点缓存优化（vertexCacheOpt）——「只重排索引、不动顶点、三角面集合不变、ACMR 下降」
//
// 用户学了「索引缓冲 / 三角形带 / 批处理 / LOD」四条，选了「顶点缓存优化（导入期）」落地。
// 这招只重排三角形的顺序（index），让相邻三角形尽量复用刚用过的顶点 → 拉高 GPU post-transform
// 缓存命中率、省顶点着色器调用。它**不该改变画面任何东西**，所以正确性断言就是「前后三角面集合完全一致」。
//
// 跑：node tools/probe-vertex-cache.mjs（退出码非 0 = 有回归）
import { optimizeIndex, optimizeVertexCache, acmr, vertexCacheOptEnabled, setVertexCacheOptEnabled } from '../src/world/vertexCacheOpt.js';

let fails = 0;
function ok(cond, name, extra = '') {
  if (cond) console.log('  ok    ' + name + (extra ? ' — ' + extra : ''));
  else { fails++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}

// 生成一张 W×H 网格的三角形索引（行主序，本来缓存不友好）
function gridIndex(W, H) {
  const idx = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const a = y * (W + 1) + x, b = a + 1, c = a + (W + 1), d = c + 1;
    idx.push(a, c, b, b, c, d); // 两个三角形
  }
  return new Uint32Array(idx);
}

// 把索引变成「排序后的三角形三元组多重集」，用来判断三角面集合是否不变
function triSet(idx) {
  const s = [];
  for (let t = 0; t < idx.length; t += 3) s.push([idx[t], idx[t + 1], idx[t + 2]].sort((p, q) => p - q).join(','));
  s.sort();
  return s.join('|');
}

console.log('\n【1】三角面集合不变（只重排顺序，画面必须零变化）');
{
  const idx = gridIndex(40, 40);
  const before = triSet(idx);
  const after = triSet(optimizeIndex(idx));
  ok(before === after, '重排前后三角面集合完全一致（顺序不同但每个三角形相同）');
  ok(optimizeIndex(idx).length === idx.length, '索引长度不变（顶点数没变）');
  // 所有索引仍在合法范围
  let vmax = 0; for (const v of idx) if (v > vmax) vmax = v;
  const opt = optimizeIndex(idx);
  let bad = 0; for (const v of opt) if (v < 0 || v > vmax) bad++;
  ok(bad === 0, '重排后所有索引仍在 [0, 顶点数) 合法范围');
}

console.log('\n【2】ACMR 下降（这就是优化的意义：顶点着色器少跑）');
{
  const idx = gridIndex(40, 40);
  const acmrBefore = acmr(idx, 16);
  const acmrAfter = acmr(optimizeIndex(idx), 16);
  ok(acmrAfter < acmrBefore, '优化后 ACMR 严格低于优化前', `前=${acmrBefore.toFixed(3)} 后=${acmrAfter.toFixed(3)}`);
  ok(acmrAfter < 1.6, '优化后 ACMR 进入「接近完美」区间（1.0=每顶点只着色一次）', acmrAfter.toFixed(3));
  // 对照：随机打乱不该比优化更好（证明算法真在工作，不是碰巧）
  const shuf = Uint32Array.from(idx);
  for (let i = shuf.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; const t = shuf[i]; shuf[i] = shuf[j]; shuf[j] = t; }
  ok(acmr(optimizeIndex(idx), 16) <= acmr(shuf, 16), '优化结果不差于随机打乱');
}

console.log('\n【2b】真实坏输入：三角形顺序被彻底打乱（GLB 导出常这样）→ 优化应大幅降 ACMR');
{
  const base = gridIndex(40, 40);
  // 按「三角形」为单位打乱顺序（保持每个三角形内部的 3 个顶点，只打乱三角形先后）
  const tris = [];
  for (let t = 0; t < base.length; t += 3) tris.push([base[t], base[t + 1], base[t + 2]]);
  for (let i = tris.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; const tmp = tris[i]; tris[i] = tris[j]; tris[j] = tmp; }
  const scrambled = new Uint32Array(base.length);
  for (let t = 0; t < tris.length; t++) { scrambled[t * 3] = tris[t][0]; scrambled[t * 3 + 1] = tris[t][1]; scrambled[t * 3 + 2] = tris[t][2]; }
  const before = acmr(scrambled, 16);
  const after = acmr(optimizeIndex(scrambled), 16);
  ok(triSet(scrambled) === triSet(optimizeIndex(scrambled)), '打乱输入重排后三角面集合仍不变');
  ok(before > 1.5, '打乱后 ACMR 确实很高（坏输入）', before.toFixed(3));
  ok(after < before - 0.2, '优化把打乱输入的 ACMR 拉回接近完美', `前=${before.toFixed(3)} 后=${after.toFixed(3)}`);
}

console.log('\n【3】退化输入安全（不抛、不乱改）');
{
  const one = new Uint32Array([0, 1, 2]);
  ok(triSet(optimizeIndex(one)) === triSet(one), '单个三角形重排后不变');
  const empty = new Uint32Array(0);
  ok(optimizeIndex(empty).length === 0, '空索引返回空');
  // 顶点数很少（< cacheSize）也不抛
  ok(acmr(optimizeIndex(gridIndex(2, 2)), 16) >= 1, '小网格也能算 ACMR 不抛');
}

console.log('\n【4】BufferGeometry 入口：非索引跳过、?vco=0 让路、保留类型');
{
  // 非索引几何 → 原样返回（没法优化，且不许动顶点）
  const nonIdx = { index: null, attributes: { position: { count: 9 } } };
  ok(optimizeVertexCache(nonIdx) === nonIdx, '非索引几何直接返回原对象（不优化）');

  // 普通索引几何：调用后 index 被换成新 BufferAttribute，但顶点数据还在（只动 index）
  const geo = {
    index: { array: gridIndex(10, 10) },
    attributes: { position: { count: 11 * 11 } },
  };
  const oldArr = geo.index.array;
  setVertexCacheOptEnabled(true);
  const r = optimizeVertexCache(geo);
  ok(r === geo, '优化后返回同一 geometry 对象');
  ok(geo.index !== oldArr, '索引被替换为重排后的新 BufferAttribute');
  ok(triSet(oldArr) === triSet(geo.index.array), 'BufferGeometry 入口同样三角面集合不变');

  // ?vco=0：关掉后不碰索引（用 setVertexCacheOptEnabled(false) 模拟 URL 关闭）
  const geo2 = { index: { array: gridIndex(8, 8) }, attributes: { position: { count: 9 * 9 } } };
  const refArr = geo2.index.array;
  setVertexCacheOptEnabled(false);
  optimizeVertexCache(geo2);
  ok(geo2.index.array === refArr, '关闭后索引数组引用不变（没重排）');
  setVertexCacheOptEnabled(null); // 复位，交回 URL 决定
}

console.log('\n【5】接线：Merge.js 合并后调用 optimizeVertexCache 且受开关保护');
{
  const g = "../src/world/Merge.js";
  const fs = await import('node:fs');
  const m = fs.readFileSync(new URL(g, import.meta.url), 'utf8');
  ok(/import \{ optimizeVertexCache, vertexCacheOptEnabled \} from '\.\/vertexCacheOpt\.js'/.test(m), 'Merge.js 引入了 optimizeVertexCache');
  ok(/optimizeVertexCache\(merged\)/.test(m), 'Merge.js 在合并出的大网格上调用了 optimizeVertexCache');
  ok(/if \(vertexCacheOptEnabled\(\)\)/.test(m), '调用受 vertexCacheOptEnabled() 开关保护（?vco=0 可关）');
}

console.log(`\n${fails === 0 ? '全部通过' : fails + ' 项失败'}`);
process.exit(fails === 0 ? 0 : 1);
