// 职责：导入期顶点缓存优化（Vertex Cache Optimization，Tom Forsyth 的「linear-speed」贪心算法）。
//
// 你学的那条「只存一份数据、用索引引用」= 索引几何（indexed geometry）。索引只省了「能共享」的顶点；
// 但 GPU 还有一道 **post-transform 缓存**：一个顶点被着色后会在缓存里待一会儿，紧挨着的三角形若复用它
// 就不必再跑一遍顶点着色器。三角形在索引里的**排列顺序**决定了这个缓存命中率 —— 顺序乱（GLB 导出常这样）
// 就频繁 miss，顶点着色器被重复跑。本模块把三角形**重排**（只动索引、绝不碰顶点数据），
// 让相邻三角形尽量共用刚用过的顶点，把「平均缓存未命中率 ACMR」压下来（典型 2.x → 1.0~1.5）。
//
// 收益性质（要讲清，免得白高兴）：
//   · 省的是**顶点着色器调用次数**，不是像素、不是 draw call、不是顶点数。
//   · 本项目桌面端瓶颈实测是**像素着色（~89%）**，几何提交侧已证伪非瓶颈 → 这招在桌面对帧率帮助有限；
//     但在**手机端**（CPU 弱、顶点处理更吃力）正该做。且它是**纯导入期、零观感风险**的免费优化。
//   · ACMR 下限是 1.0（每个顶点只着色一次），理论上限≈3（每三角形 3 个全新顶点）。
//
// 三条铁律（和遮挡剔除同一个脾气）：
//   ① 只重排 index，**绝不重排/改写顶点属性**（位置/法线/UV 一个字节都不动）→ 画面零变化。
//   ② 三角面的**集合不变**（只是顺序变）→ 把前后两版按三角形排序比对必须完全一致，否则就是 bug。
//   ③ 异常一律回退原索引（宁可不变，也不能把模型搞坏）。
import * as THREE from 'three';

const CACHE_SIZE = 32;      // 参与打分的 post-transform 缓存槽数（典型 GPU 16~32）
const CACHE_DECAY = 1.5;    // 越久没用的顶点得分衰减越快（指数）
const VALENCE_TIE = 0.5;    // 低度数顶点的微小优先（先收尾"死胡同"顶点）

let VCO_OVERRIDE = null;    // null = 看 URL；true/false = 单测/URL 强制
export function setVertexCacheOptEnabled(v) { VCO_OVERRIDE = (v === undefined ? null : !!v); }
export function vertexCacheOptEnabled() {
  if (VCO_OVERRIDE !== null) return VCO_OVERRIDE;
  try {
    if (typeof location !== 'undefined' && typeof location.search === 'string') {
      const p = new URLSearchParams(location.search);
      if (p.get('vco') === '0') return false;
      if (p.get('vco') === '1') return true;
    }
  } catch (e) { /* Node 自检 → 默认开 */ }
  return true;
}

// 顶点得分：在缓存里且越新越高；不在缓存给基线 0（被在缓存的压过，直到缓存被挤空才拉新顶点）。
// 加一个按度数倒数的小tiebreak（低度数顶点优先收尾）。
function _vscore(cachePos, valence) {
  let s = cachePos < 0 ? 0 : Math.pow((CACHE_SIZE - cachePos) / CACHE_SIZE, CACHE_DECAY);
  if (valence > 0) s += VALENCE_TIE / valence;
  return s;
}

// 纯函数：输入三角形列表索引（长度 = 3T，任意 TypedArray），返回重排后的 Uint32Array（同长度）。
// 不动顶点数据、不改变三角面集合。失败返回原索引的拷贝（不抛）。
export function optimizeIndex(src) {
  try {
    const n = src.length;
    if (n % 3 !== 0 || n === 0) return new Uint32Array(src);
    const T = (n / 3) | 0;
    let vmax = 0;
    for (let i = 0; i < n; i++) { const v = src[i]; if (v > vmax) vmax = v; }
    const V = vmax + 1;

    // 邻接：顶点 -> 包含它的三角形下标
    const adj = new Array(V);
    for (let v = 0; v < V; v++) adj[v] = [];
    for (let t = 0; t < T; t++) {
      const a = src[t * 3], b = src[t * 3 + 1], c = src[t * 3 + 2];
      adj[a].push(t); adj[b].push(t); adj[c].push(t);
    }
    const valence = new Int32Array(V);
    for (let v = 0; v < V; v++) valence[v] = adj[v].length;

    const added = new Uint8Array(T);
    const triScore = new Float64Array(T);
    const cachePos = new Int32Array(V).fill(-1);
    const cache = new Int32Array(CACHE_SIZE).fill(-1);
    let cacheLen = 0;

    const updateTri = (t) => {
      if (added[t]) { triScore[t] = -1; return; }
      const a = src[t * 3], b = src[t * 3 + 1], c = src[t * 3 + 2];
      triScore[t] = _vscore(cachePos[a], valence[a]) + _vscore(cachePos[b], valence[b]) + _vscore(cachePos[c], valence[c]);
    };
    const pushCache = (v) => {
      let evicted = -1;
      if (cacheLen >= CACHE_SIZE) evicted = cache[CACHE_SIZE - 1];
      for (let i = Math.min(cacheLen, CACHE_SIZE - 1); i > 0; i--) cache[i] = cache[i - 1];
      cache[0] = v;
      if (cacheLen < CACHE_SIZE) cacheLen++;
      if (evicted >= 0) cachePos[evicted] = -1;
      for (let i = 0; i < cacheLen; i++) cachePos[cache[i]] = i;
    };

    for (let t = 0; t < T; t++) updateTri(t);

    const out = new Uint32Array(n);
    let outN = 0;
    const cand = [];                       // 候选三角形（碰到在缓存里的顶点的，优先）
    const addCand = (t) => { if (!added[t] && triScore[t] >= 0) cand.push(t); };

    let addedCount = 0;
    while (addedCount < T) {
      // 从候选里挑分最高的（顺便清掉已添加的）
      let best = -1, bestS = -Infinity;
      for (let i = 0; i < cand.length; i++) {
        const t = cand[i];
        if (added[t]) { cand[i] = cand[cand.length - 1]; cand.pop(); i--; continue; }
        if (triScore[t] > bestS) { bestS = triScore[t]; best = t; }
      }
      if (best < 0) {
        // 候选为空（剩余三角形都不碰在缓存里的顶点）→ 开新簇：挑度数和最大的未加三角形做种子
        let seedV = -1;
        for (let t = 0; t < T; t++) {
          if (added[t]) continue;
          const s = valence[src[t * 3]] + valence[src[t * 3 + 1]] + valence[src[t * 3 + 2]];
          if (s > seedV) { seedV = s; best = t; }
        }
      }
      const a = src[best * 3], b = src[best * 3 + 1], c = src[best * 3 + 2];
      out[outN++] = a; out[outN++] = b; out[outN++] = c;
      added[best] = 1; addedCount++;
      // 这三个顶点进缓存（c 最前 = 最常驻，鼓励下一三角形复用）
      pushCache(a); pushCache(b); pushCache(c);
      for (const v of [a, b, c]) for (const t of adj[v]) if (!added[t]) { updateTri(t); addCand(t); }
    }
    return out;
  } catch (e) {
    console.warn('[vco] 顶点缓存优化失败，回退原索引:', e);
    return new Uint32Array(src);
  }
}

// 给 BufferGeometry 用：重排它的 index（保留原类型：能放 Uint16 就放 Uint16）。顶点数据不动。
export function optimizeVertexCache(geometry) {
  if (!geometry || !geometry.index) return geometry;       // 非索引几何：没法优化（且不改顶点）
  if (!vertexCacheOptEnabled()) return geometry;
  const src = geometry.index.array;
  const V = geometry.attributes && geometry.attributes.position ? geometry.attributes.position.count : 0;
  const optimized = optimizeIndex(src);
  let outArr;
  if ((src instanceof Uint16Array) && V <= 65535) {
    outArr = new Uint16Array(optimized.length); outArr.set(optimized);
  } else {
    outArr = optimized; // Uint32（vertexCount 超 65535 时必须）
  }
  geometry.index = new THREE.BufferAttribute(outArr, 1);
  return geometry;
}

// 模拟一次「缓存未命中率」测量（cacheSize 个槽的 post-transform 缓存），供自检断言优化有效。
// 返回 ACMR = 平均每个三角形miss的顶点数（1.0 = 完美，3.0 = 全 miss）。
export function acmr(idx, cacheSize = 16) {
  const n = idx.length; const T = (n / 3) | 0;
  let vmax = 0; for (let i = 0; i < n; i++) if (idx[i] > vmax) vmax = idx[i];
  const V = vmax + 1;
  const cp = new Int32Array(V).fill(-1);
  const cache = new Int32Array(cacheSize).fill(-1);
  let len = 0, misses = 0;
  const push = (v) => {
    let ev = -1; if (len >= cacheSize) ev = cache[cacheSize - 1];
    for (let i = Math.min(len, cacheSize - 1); i > 0; i--) cache[i] = cache[i - 1];
    cache[0] = v; if (len < cacheSize) len++;
    if (ev >= 0) cp[ev] = -1;
    for (let i = 0; i < len; i++) cp[cache[i]] = i;
  };
  for (let t = 0; t < T; t++) for (let k = 0; k < 3; k++) { const v = idx[t * 3 + k]; if (cp[v] < 0) misses++; push(v); }
  return misses / T;
}
