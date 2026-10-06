// 职责：把「关掉也看不出差别」的双面材质收敛成单面（开背面剔除），砍掉复制场景里成片
//   永远看不见的背面三角面。
//
// ── 为什么要做（有数据，不是猜的）───────────────────────────────────────────
//   · 扫过仓库里全部 GLB：**49 个材质有 39 个（80%）是 glTF 的 `doubleSided:true`**
//     —— 这是导出器的默认值，three.js 照单全收成 `THREE.DoubleSide` → **关掉背面剔除**。
//     楼体 / 树 / 人物 / 车 / 军中.glb(16/16) 全中。
//   · 实心楼体是闭合体：内壁永远看不见，却照样进片元着色器。阵列复制一多，这就是成片的浪费。
//   · 本项目已实测确认瓶颈是**填充率**（0.5× 分辨率 → 帧率 2.7 倍），砍片元 = 砍帧时间。
//   · 附带收益：`material.shadowSide` 留空时 three.js 按 side 自动映射（FrontSide → BackSide），
//     阴影趟只画背面，阴影贴图的填充率也跟着减半。
//
// ── 判定「能不能安全剔除」：流形边占比 ────────────────────────────────
//   闭合体 = 每条形边恰好被两个三角形共用 ⇒ 内外分明 ⇒ 剔除背面安全（楼/箱/球/人物）。
//   开放面片 = 存在「只被一个三角形用到的边」⇒ 不闭合 ⇒ 保持双面（单张平面、树叶片、
//   没厚度的墙纸、开了口的圆柱）。
//   ⇒ 树/草/布告栏这类**本来靠 doubleSided 才看得见的薄片**不会被误伤，这正是它存在的意义。
//
// ⚠ 一条材质可能被多个网格共用：**只有用到它的所有网格都判定为闭合且不透明**才改，
//   否则会出现「某个薄片突然变单面、从背面看不见了」的静默回归（见 MEMORY 静默失效系列）。
//
// 兜底开关：`?cull=0` 关闭本优化（A/B 对照用）；单测用 setBackfaceCullEnabled()。
import * as THREE from 'three';

// 判定为「闭合体」的流形边占比阈值。0.9 偏保守：底面缺失的盒子（Blender 常见）≈0.78，
// 会被判成开放从而保持双面 —— 宁可少优化一点，也不要让墙从背面看穿。
export const DEFAULT_CLOSED_RATIO = 0.9;
// 单趟扫描的三角形总预算：超了就收工（宁可少优化，也不让加载屏多卡几百毫秒）
export const DEFAULT_TRI_BUDGET = 400000;

// 扫描结果缓存：同一份几何在合并/复制场景里会被反复问到（阵列复制 = 同一 geometry 几十份）
const _geoCache = new WeakMap();

let CULL_OVERRIDE = null; // null = 看 URL；true/false = 单测强制

export function setBackfaceCullEnabled(v) {
  CULL_OVERRIDE = !!v;
}

// 是否启用本优化。默认开；`?cull=0` 可整块关掉做 A/B 对照。
export function backfaceCullEnabled() {
  if (CULL_OVERRIDE !== null) return CULL_OVERRIDE;
  try {
    if (typeof location !== 'undefined' && typeof location.search === 'string') {
      const p = new URLSearchParams(location.search);
      if (p.get('cull') === '0') return false;
      if (p.get('cull') === '1') return true;
    }
  } catch (e) {
    /* 无 location（Node 单测）→ 走默认 */
  }
  return true;
}

// 量化精度：1e-4（米）。够吃掉导出器的浮点误差，又不至于把相邻顶点并错。
const Q = 10000;

// 返回 { ratio, tris }：ratio = 流形边（恰好被两个三角形共用）占全部不同边的比例。
// tris < 2 或无 position 时 ratio = 0（判不出 ⇒ 当作开放，保守）。
export function geometryEdgeStats(geometry) {
  const cached = _geoCache.get(geometry);
  if (cached) return cached;
  const out = { ratio: 0, tris: 0 };
  const put = (g, v) => {
    _geoCache.set(g, v);
    return v;
  };
  if (!geometry || !geometry.attributes) return put(geometry, out);
  const pos = geometry.attributes.position;
  if (!pos || !pos.count) return put(geometry, out);
  const idx = geometry.index;
  const idxArr = idx ? idx.array : null;
  const vcount = pos.count;
  const vcount3 = idx ? idx.count : vcount;
  const tris = Math.floor(vcount3 / 3);
  out.tris = tris;
  if (tris < 2) return put(geometry, out);

  // ① 焊接：位置量化后归并，消掉 UV 缝 / 非索引几何里的重复顶点（不焊的话流形边永远判不出来）
  const weld = new Map(); // 量化键 -> 焊后索引
  const remap = new Int32Array(vcount);
  let n = 0;
  for (let i = 0; i < vcount; i++) {
    const k =
      Math.round(pos.getX(i) * Q) + ',' + Math.round(pos.getY(i) * Q) + ',' + Math.round(pos.getZ(i) * Q);
    let w = weld.get(k);
    if (w === undefined) {
      w = n++;
      weld.set(k, w);
    }
    remap[i] = w;
  }
  // ② 数边：一条边被几个三角形用到
  const stride = n + 1; // 边键 = min * stride + max（n < 2^25 时不会超出安全整数）
  const edges = new Map();
  for (let t = 0; t + 2 < vcount3; t += 3) {
    const a = remap[idxArr ? idxArr[t] : t];
    const b = remap[idxArr ? idxArr[t + 1] : t + 1];
    const c = remap[idxArr ? idxArr[t + 2] : t + 2];
    if (a === b || b === c || a === c) continue; // 退化三角形：不计
    bump(edges, a, b, stride);
    bump(edges, b, c, stride);
    bump(edges, c, a, stride);
  }
  let manifold = 0;
  for (const cnt of edges.values()) if (cnt === 2) manifold++;
  out.ratio = edges.size ? manifold / edges.size : 0;
  return put(geometry, out);
}

function bump(edges, i, j, stride) {
  const key = i < j ? i * stride + j : j * stride + i;
  const v = edges.get(key);
  edges.set(key, v === undefined ? 1 : v + 1);
}

// 这个网格的几何是不是闭合体（可以安全剔除背面）
export function isClosedGeometry(geometry) {
  const st = geometryEdgeStats(geometry);
  return st.tris >= 2 && st.ratio >= DEFAULT_CLOSED_RATIO;
}

// 遍历 root，给出「哪些材质可以收敛成单面」的方案（不修改任何东西，纯统计 —— 便于先审计再改）。
// 返回 { scanned, flips: Material[], groups, budgetHit }
export function planBackfaceCulling(root, opts = {}) {
  const ratio = opts.ratio || DEFAULT_CLOSED_RATIO;
  const budget = opts.budget || DEFAULT_TRI_BUDGET;
  const groups = new Map(); // Material -> { mat, closed, open }
  let scanned = 0;
  let budgetHit = false;
  if (!root || typeof root.traverse !== 'function') return { scanned, flips: [], groups: 0, budgetHit };

  root.traverse((o) => {
    if (budgetHit) return;
    if (!o.isMesh || !o.material) return;
    if (o.isLine || o.isPoints || o.isSprite) return; // 线/点本来就没有背面概念
    const mat = o.material;
    if (Array.isArray(mat)) return; // 多材质网格：保守跳过
    // 洞壁 / 障眼法窗户等自定义 shader：它们自己管 side，别碰
    if (mat.userData && (mat.userData.fpmReveal === true || mat.userData.noCull === true)) return;
    if (o.userData && o.userData.noCull === true) return;
    if (mat.userData && mat.userData.fpmFakeWindow === true) return;
    // 半透明 / alphaTest / 线框：双面是"必须"的（薄片、玻璃、公告板），不能剔
    if (mat.transparent || mat.wireframe) return;
    if ((mat.alphaTest || 0) > 0) return;
    if (typeof mat.opacity === 'number' && mat.opacity < 1) return;
    if (mat.side !== THREE.DoubleSide) return; // 已经是单面（或 BackSide），不用管
    const g = o.geometry;
    if (!g || !g.attributes || !g.attributes.position) return;
    const st = geometryEdgeStats(g);
    scanned += st.tris;
    if (scanned > budget) {
      budgetHit = true;
      return;
    }
    let e = groups.get(mat);
    if (!e) {
      e = { mat, closed: 0, open: 0 };
      groups.set(mat, e);
    }
    if (st.tris >= 2 && st.ratio >= ratio) e.closed++;
    else e.open++;
  });

  // 只有「用它的所有网格都是闭合体」才收敛 —— 漏一个薄片就是一次静默回归
  const flips = [];
  for (const e of groups.values()) if (e.open === 0 && e.closed > 0) flips.push(e.mat);
  return { scanned, flips, groups: groups.size, budgetHit };
}

// 真正改材质：DoubleSide → FrontSide。返回统计，方便打日志做对照。
export function applyBackfaceCulling(root, opts = {}) {
  if (!backfaceCullEnabled()) return { scanned: 0, flipped: 0, groups: 0, budgetHit: false, disabled: true };
  const plan = planBackfaceCulling(root, opts);
  let flipped = 0;
  for (const m of plan.flips) {
    m.side = THREE.FrontSide;
    // ⚠ side 会进 shader 的 DOUBLE_SIDED 宏（法线按 gl_FrontFacing 翻转），必须触发重编译；
    //   needsUpdate 是只写 setter（读恒为 undefined），这里只写不读。
    m.needsUpdate = true;
    flipped++;
  }
  return { scanned: plan.scanned, flipped, groups: plan.groups, budgetHit: plan.budgetHit, disabled: false };
}
