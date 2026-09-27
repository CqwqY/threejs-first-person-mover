// 室内复杂碰撞 · simple 模式生成器（P2）
//
// 职责：对任意 object3D（编辑器里的 holder）逐 mesh / 逐 primitive 抽取碰撞几何。
//   - 顶点恰好落在自身包围盒 8 个角点上的 primitive → 抽成一个轴对齐盒（物理走 AABB 快路径）
//   - 其余 primitive → 求三维凸包（物理走凸包 SAT）
//
// 三条硬约束（踩错任何一条都会毁掉室内可玩性）：
//   1) 绝对不做体素填充 / flood：构件之间的空腔（中庭、天井、房间、走廊）必须原样保留。
//      所以这里只逐 primitive 抽取，绝不把整个模型填成实心，也绝不复用编辑器里那套
//      「整体模型 flood + 体素化」的凸分解（那套正是把室内做成实心的错误做法）。
//   2) 所有输出坐标都在「物体本地未缩放空间」，与现有 collider / colliders / convex / convexParts
//      完全一致（游戏端用 holder.matrixWorld 再变换到世界）。生成前先抵消 object3D 自身的缩放。
//   3) 共面合并必须保守：只有「合并后的盒体积恰等于两盒之并（无任何多余体积）」才合并。
//      绝不允许「中间有小缝也合并」——那会把小窗、栏杆、镂空一类的构件糊死。
import * as THREE from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';

const EPS = 1e-3;                    // 角点/区间判定容差（米）
const QUANT = 1e-4;                  // 凸包输入顶点去重的量化步长
const DEFAULT_MAX_HULL_VERTS = 50000; // 单个 primitive 参与凸包的最大唯一顶点数（安全上限，防卡死）
const HULL_HINT_VERTS = 64;          // 超过该顶点数的 primitive 计入 skipped（本应交给 V-HACD 的重量级构件）

// 顶点去重键（量化后字符串化）
function qkey(x, y, z) {
  return Math.round(x / QUANT) + ',' + Math.round(y / QUANT) + ',' + Math.round(z / QUANT);
}

// 自身及所有祖先可见才算可见（隐藏的辅助网格不参与碰撞）
function isVisible(o) {
  let p = o;
  while (p) {
    if (p.visible === false) return false;
    p = p.parent;
  }
  return true;
}

// 是否位于碰撞体可视化节点（collider-vis）内部：生成时必须排除，
// 否则第二次生成会把上一次生成的半透明体积盒当成模型再抽一遍，产生滚雪球式的假碰撞。
function inColliderVis(o) {
  let p = o;
  while (p) {
    if (typeof p.name === 'string' && p.name.startsWith('collider-vis')) return true;
    p = p.parent;
  }
  return false;
}

// 按 group（primitive）切分几何体的索引区间；无 group 时整体视作一个 primitive。
// group.start / group.count 在有索引时指向索引缓冲，无索引时指向顶点缓冲（与 three 一致）。
function primitiveRanges(geo) {
  const pos = geo.attributes.position;
  const idx = geo.index;
  const total = idx ? idx.count : (pos ? pos.count : 0);
  const groups = geo.groups;
  if (Array.isArray(groups) && groups.length) {
    const rs = [];
    for (const g of groups) {
      const start = Math.max(0, g.start | 0);
      const count = Math.min(g.count | 0, total - start);
      if (count > 0) rs.push({ start, count });
    }
    if (rs.length) return rs;
  }
  return total > 0 ? [{ start: 0, count: total }] : [];
}

// 判断一组点是否恰好构成「轴对齐盒」：每个点都必须落在包围盒角点上，且 8 个角点齐全。
// 这样既能认 8 顶点的盒子，也能认按面拆成 24/36 顶点的盒子（后者只需顶点全在角点上）。
// 返回盒（本地空间半尺寸 + 中心）或 null。
function boxFromPoints(pts, min, max) {
  const ex = max.x - min.x, ey = max.y - min.y, ez = max.z - min.z;
  if (ex <= 2 * EPS || ey <= 2 * EPS || ez <= 2 * EPS) return null; // 太薄（薄片/玻璃）不算盒
  const near = (v, t) => Math.abs(v - t) <= EPS;
  let mask = 0;
  for (const p of pts) {
    let ci = 0;
    if (near(p.x, min.x)) { /* -X 位 */ }
    else if (near(p.x, max.x)) ci |= 4;
    else return null;
    if (near(p.y, min.y)) { /* -Y 位 */ }
    else if (near(p.y, max.y)) ci |= 2;
    else return null;
    if (near(p.z, min.z)) { /* -Z 位 */ }
    else if (near(p.z, max.z)) ci |= 1;
    else return null;
    mask |= (1 << ci);
  }
  if (mask !== 0xff) return null; // 8 个角点没凑齐 → 不是盒
  return {
    hx: ex / 2, hy: ey / 2, hz: ez / 2,
    ox: (min.x + max.x) / 2, oy: (min.y + max.y) / 2, oz: (min.z + max.z) / 2,
  };
}

// 三维凸包 → { vertices:[x,y,z,...], faces:[0,1,2,3,...] }（三角形汤，与现有 convex/convexParts 格式一致）。
// ConvexGeometry 输出的是无索引三角形汤，这里转成「顶点数组 + 顺序索引」。
function hullFromPoints(pts) {
  let geo;
  try {
    geo = new ConvexGeometry(pts);
  } catch (e) {
    return null; // 退化输入（共面/共线/点太少）会抛错，视作无法生成
  }
  const pa = geo.getAttribute('position');
  if (!pa || pa.count < 3) { geo.dispose(); return null; }
  const n = pa.count;
  const faces = new Array(n);
  for (let i = 0; i < n; i++) faces[i] = i;
  const hull = { vertices: Array.from(pa.array), faces };
  geo.dispose();
  return hull;
}

// 两个轴对齐盒能否合并为一个盒：三轴里必须有两轴区间完全相同，
// 剩下那轴必须「相接或重叠」（有缝就一律不合并）。成立时返回并集盒，否则 null。
function tryMergeBox(A, B) {
  const iv = (b) => [
    [b.ox - b.hx, b.ox + b.hx],
    [b.oy - b.hy, b.oy + b.hy],
    [b.oz - b.hz, b.oz + b.hz],
  ];
  const a = iv(A), c = iv(B);
  let eqCount = 0, adjAxis = -1;
  for (let i = 0; i < 3; i++) {
    const eq = Math.abs(a[i][0] - c[i][0]) <= EPS && Math.abs(a[i][1] - c[i][1]) <= EPS;
    if (eq) { eqCount++; continue; }
    // 非等轴：必须相接或重叠；且只能有一根非等轴，否则并集盒会引入多余体积
    const touch = a[i][1] >= c[i][0] - EPS && c[i][1] >= a[i][0] - EPS;
    if (!touch || adjAxis >= 0) return null;
    adjAxis = i;
  }
  if (eqCount < 2) return null;
  if (adjAxis < 0) return { ...A }; // 完全重合的两盒，合并为一个
  const lo = [
    Math.min(a[0][0], c[0][0]), Math.min(a[1][0], c[1][0]), Math.min(a[2][0], c[2][0]),
  ];
  const hi = [
    Math.max(a[0][1], c[0][1]), Math.max(a[1][1], c[1][1]), Math.max(a[2][1], c[2][1]),
  ];
  return {
    hx: (hi[0] - lo[0]) / 2, hy: (hi[1] - lo[1]) / 2, hz: (hi[2] - lo[2]) / 2,
    ox: (lo[0] + hi[0]) / 2, oy: (lo[1] + hi[1]) / 2, oz: (lo[2] + hi[2]) / 2,
  };
}

// 贪心保守合并：逐盒尝试并入已产出列表，能并就并，不能并再追加。
function mergeAdjacentBoxes(list) {
  const out = [];
  for (const b of list) {
    let cur = b;
    for (let guard = 0; guard < 1000; guard++) {
      let hit = -1;
      for (let i = 0; i < out.length; i++) {
        const m = tryMergeBox(out[i], cur);
        if (m) { hit = i; cur = m; break; }
      }
      if (hit < 0) break;
      out.splice(hit, 1);
    }
    out.push(cur);
  }
  return out;
}

// 抽取一段索引区间（一个 primitive）内、去重后的顶点，并变换到 holder 本地未缩放空间。
function collectPoints(geo, start, count, mtx, out, seen) {
  const posAttr = geo.attributes.position;
  const idx = geo.index;
  const end = Math.min(start + count, idx ? idx.count : posAttr.count);
  const v = new THREE.Vector3();
  for (let i = start; i < end; i++) {
    const vi = idx ? idx.getX(i) : i;
    v.fromBufferAttribute(posAttr, vi).applyMatrix4(mtx);
    const k = qkey(v.x, v.y, v.z);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v.clone());
  }
}

// 盒输出格式（无四元数即单位四元数，这里显式写出便于数据自解释）
function toBox(b) {
  return { hx: b.hx, hy: b.hy, hz: b.hz, ox: b.ox, oy: b.oy, oz: b.oz, qx: 0, qy: 0, qz: 0, qw: 1 };
}

// 主入口：object3D 为编辑器里的 holder（Group）。
// opts: { maxHullVerts?, merge? }
// 返回 { boxes:[{hx,hy,hz,ox,oy,oz,qx,qy,qz,qw}], hulls:[{vertices,faces}], skipped:number }
export async function generateSimple(object3D, opts = {}) {
  const boxes = [];
  const hulls = [];
  let skipped = 0;
  const empty = { boxes, hulls, skipped };
  if (!object3D) return empty;

  const maxHullVerts = Math.max(HULL_HINT_VERTS, Math.floor(opts.maxHullVerts || DEFAULT_MAX_HULL_VERTS));
  const doMerge = opts.merge !== false;

  object3D.updateMatrixWorld(true);
  // inv(holder.matrixWorld) × mesh.matrixWorld = 网格几何 → holder 本地（未缩放）空间的变换矩阵。
  // 先抵消 holder 自身的位置/旋转/缩放，保证产出坐标与 collider/colliders/convex 的存储空间一致。
  const inv = new THREE.Matrix4().copy(object3D.matrixWorld).invert();
  const mtx = new THREE.Matrix4();
  const pts = [];
  const seen = new Set();
  const min = new THREE.Vector3();
  const max = new THREE.Vector3();

  // 求点集包围盒（写到复用的 min/max 上）
  const aabbOf = (list) => {
    min.set(Infinity, Infinity, Infinity);
    max.set(-Infinity, -Infinity, -Infinity);
    for (const p of list) { min.min(p); max.max(p); }
  };

  // 处理一个 primitive（pts 已就绪）：盒 → boxes；否则 → 凸包 / 计入 skipped
  const emitPrimitive = () => {
    aabbOf(pts);
    const b = boxFromPoints(pts, min, max);
    if (b) { boxes.push(toBox(b)); return; }
    let failed = false;
    if (pts.length > maxHullVerts) {
      failed = true; // 超大 primitive 直接跳过，避免卡死（这里不跑重型 V-HACD）
    } else {
      const h = hullFromPoints(pts);
      if (h) hulls.push(h);
      else failed = true;
    }
    if (pts.length > HULL_HINT_VERTS) skipped++; // 记录「本应交给 V-HACD 的重量级构件」
    else if (failed) skipped++;
  };

  object3D.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    if (!o.geometry.attributes.position) return;
    if (!isVisible(o)) return;
    if (inColliderVis(o)) return; // 跳过上一次生成的碰撞体可视化产物

    mtx.multiplyMatrices(inv, o.matrixWorld);
    const ranges = primitiveRanges(o.geometry);
    if (!ranges.length) return;

    // ---- 先整体判定：整个 mesh 就是一个轴对齐盒 ----
    // 必要：three 的 BoxGeometry 等会把一个盒子按面拆成 6 个 group，
    // 若只按 group 抽，盒子会退化成 6 张零厚度薄片。整体判定可避免这种退化。
    pts.length = 0;
    seen.clear();
    collectPoints(o.geometry, 0, Infinity, mtx, pts, seen);
    if (pts.length >= 4) {
      aabbOf(pts);
      const wholeBox = boxFromPoints(pts, min, max);
      if (wholeBox) { boxes.push(toBox(wholeBox)); return; }
    }

    // ---- 再逐 primitive（group）抽取 ----
    for (const r of ranges) {
      if (ranges.length > 1) {
        pts.length = 0;
        seen.clear();
        collectPoints(o.geometry, r.start, r.count, mtx, pts, seen);
      }
      if (pts.length < 4) { skipped++; continue; } // 面片/点线：构不成立体
      emitPrimitive();
    }
  });

  // ---- 保守共面合并（只减少盒数量，不改变体积）----
  const finalBoxes = doMerge ? mergeAdjacentBoxes(boxes) : boxes;
  return { boxes: finalBoxes, hulls, skipped };
}
