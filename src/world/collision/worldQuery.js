// 职责：「世界碰撞体」的通用查询——给抓钩（射线）、黑洞（飞行扫掠）、掉落物（小球物理）共用。
// 与玩家角色的解算器（characterSolver 的 AABB 子步进）相互独立：这里处理的是「射线 / 小球」。
//
// 覆盖三类碰撞体（与 PlayerPhysics 的拆分口径一致）：
//   · box    { cx,cy,cz,hx,hy,hz[,rotY] }  —— 可绕 Y 旋转，按 OBB 精确求交（不是外接盒近似）
//   · convex { vertices, faces? }          —— faces 是顶点索引三元组时按真实三角形，否则退回包围盒
//   · trimesh{ positions, query() }         —— 复杂建筑烘焙：BVH 粗筛 + 逐三角形精确
//
// 两条与场景约定的前提：
//   1) 地面不是碰撞体（物理按隐式平面 y = floorY 处理），所以射线/小球都要自带地面那一项；
//   2) 碰撞体创建后视为不可变——世界包围盒缓存在碰撞体自身（__qBox），
//      与 PlayerPhysics 的 _prepareConvex、projectileHit 的 __aabb 是同一个假设。
//
// 旋转约定与 PlayerPhysics 一致：本地 +X = (cos, -sin)，本地 +Z = (sin, cos)。

const EPS = 1e-9;

// ---- 复用缓冲（避免在每帧热路径里分配）----
const _n = { x: 0, y: 0, z: 0 };    // 最近一次求交的法线
const _cp = { x: 0, y: 0, z: 0 };   // 三角形上的最近点
const _tc = { nx: 0, ny: 0, nz: 0, depth: 0 }; // 球-面接触
const _mtv = { nx: 0, ny: 0, nz: 0, depth: 0 }; // 球-世界最深穿透
const _cand = [];                   // trimesh BVH 候选三角形编号

const _buffers = { ray: _n, closest: _cp, contact: _tc, mtv: _mtv, cand: _cand };

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

// 世界包围盒：盒直接算（rotY 取外接），凸包按顶点算一次并缓存；不可用返回 null
export function colliderBox(c) {
  if (!c) return null;
  if (c.__qBox !== undefined) return c.__qBox;
  let box = null;
  if (Number.isFinite(c.hx) && Number.isFinite(c.hy) && Number.isFinite(c.hz)) {
    const rot = c.rotY || 0;
    if (rot) {
      const cs = Math.abs(Math.cos(rot));
      const sn = Math.abs(Math.sin(rot));
      box = { cx: c.cx, cy: c.cy, cz: c.cz, hx: c.hx * cs + c.hz * sn, hy: c.hy, hz: c.hx * sn + c.hz * cs };
    } else {
      box = { cx: c.cx, cy: c.cy, cz: c.cz, hx: c.hx, hy: c.hy, hz: c.hz };
    }
  } else {
    const v = c.vertices || c.positions;
    if (v && v.length >= 3) {
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (let i = 0; i + 2 < v.length; i += 3) {
        const px = v[i], py = v[i + 1], pz = v[i + 2];
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
        if (pz < minZ) minZ = pz;
        if (pz > maxZ) maxZ = pz;
      }
      if (Number.isFinite(minX)) {
        box = {
          cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, cz: (minZ + maxZ) / 2,
          hx: (maxX - minX) / 2, hy: (maxY - minY) / 2, hz: (maxZ - minZ) / 2,
        };
      }
    }
  }
  c.__qBox = box;
  return box;
}

// 凸包 faces 是否为「顶点索引三元组」；不是就退回包围盒
function convexIndexTriples(b) {
  const f = b.faces;
  const verts = b.vertices;
  if (!Array.isArray(f) || !verts) return null;
  if (f.length < 3 || f.length % 3 !== 0) return null;
  const n = verts.length / 3;
  for (let i = 0; i < f.length; i++) {
    const k = f[i];
    if (!Number.isInteger(k) || k < 0 || k >= n) return null;
  }
  return f;
}

// 三角形上离 p 最近的点（Ericson）→ 写入 _cp，返回 _cp（调用方需立即取值）
function closestOnTri(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) { _cp.x = ax; _cp.y = ay; _cp.z = az; return _cp; }

  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) { _cp.x = bx; _cp.y = by; _cp.z = bz; return _cp; }

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    _cp.x = ax + abx * v; _cp.y = ay + aby * v; _cp.z = az + abz * v;
    return _cp;
  }

  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) { _cp.x = cx; _cp.y = cy; _cp.z = cz; return _cp; }

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    _cp.x = ax + acx * w; _cp.y = ay + acy * w; _cp.z = az + acz * w;
    return _cp;
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    _cp.x = bx + (cx - bx) * w; _cp.y = by + (cy - by) * w; _cp.z = bz + (cz - bz) * w;
    return _cp;
  }

  const denom = va + vb + vc;
  if (denom === 0) { _cp.x = ax; _cp.y = ay; _cp.z = az; return _cp; }
  const v = vb / denom, w = vc / denom;
  _cp.x = ax + abx * v + acx * w;
  _cp.y = ay + aby * v + acy * w;
  _cp.z = az + abz * v + acz * w;
  return _cp;
}

// ---------------------------------------------------------------------------
// 射线求交
// ---------------------------------------------------------------------------

// Möller–Trumbore：射线 × 三角形，返回 t（0..maxT）或 -1；法线（翻向射线来的一侧）写入 _n
function rayTri(ox, oy, oz, dx, dy, dz, ax, ay, az, bx, by, bz, cx, cy, cz, maxT) {
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const hx = dy * e2z - dz * e2y;
  const hy = dz * e2x - dx * e2z;
  const hz = dx * e2y - dy * e2x;
  const a = e1x * hx + e1y * hy + e1z * hz;
  if (a > -EPS && a < EPS) return -1; // 与三角形平行
  const f = 1 / a;
  const sx = ox - ax, sy = oy - ay, sz = oz - az;
  const u = f * (sx * hx + sy * hy + sz * hz);
  if (u < 0 || u > 1) return -1;
  const qx = sy * e1z - sz * e1y;
  const qy = sz * e1x - sx * e1z;
  const qz = sx * e1y - sy * e1x;
  const v = f * (dx * qx + dy * qy + dz * qz);
  if (v < 0 || u + v > 1) return -1;
  const t = f * (e2x * qx + e2y * qy + e2z * qz);
  if (t < 0 || t > maxT) return -1;

  let nx = e1y * e2z - e1z * e2y;
  let ny = e1z * e2x - e1x * e2z;
  let nz = e1x * e2y - e1y * e2x;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
  nx /= len; ny /= len; nz /= len;
  const dot = nx * dx + ny * dy + nz * dz;
  if (dot > 0) { nx = -nx; ny = -ny; nz = -nz; } // 让法线朝向射线来的那一侧
  _n.x = nx; _n.y = ny; _n.z = nz;
  return t;
}

// 射线 × OBB（rotY=0 时即 AABB）。起点在盒内（所有面都是背向）时视为不命中，
// 否则「自己正踩着/嵌着的盒」会把锚点吸到自己脚下。
function rayOBB(c, ox, oy, oz, dx, dy, dz, maxT) {
  const rot = c.rotY || 0;
  const cs = Math.cos(rot);
  const sn = Math.sin(rot);
  const rx = ox - c.cx, ry = oy - c.cy, rz = oz - c.cz;
  // 世界 → 本地（绕 Y 反向旋转）
  const lo = [rx * cs - rz * sn, ry, rx * sn + rz * cs];
  const ld = [dx * cs - dz * sn, dy, dx * sn + dz * cs];
  const h = [c.hx, c.hy, c.hz];

  let t0 = 0;
  let t1 = maxT;
  let axis = -1;
  let sign = 1;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(ld[i]) < EPS) {
      if (Math.abs(lo[i]) > h[i]) return -1; // 平行且在板外
      continue;
    }
    const inv = 1 / ld[i];
    let ta = (-h[i] - lo[i]) * inv;
    let tb = (h[i] - lo[i]) * inv;
    let sg = -1;               // ld>0：从 -h 面进入
    if (ta > tb) { const tt = ta; ta = tb; tb = tt; sg = 1; }
    if (ta > t0) { t0 = ta; axis = i; sign = sg; }
    if (tb < t1) t1 = tb;
    if (t0 > t1) return -1;
  }
  if (axis < 0) return -1; // 起点在盒内且没有穿过任何面 → 忽略
  if (t0 < 0 || t0 > maxT) return -1;

  const nlx = axis === 0 ? sign : 0;
  const nly = axis === 1 ? sign : 0;
  const nlz = axis === 2 ? sign : 0;
  _n.x = nlx * cs + nlz * sn;
  _n.y = nly;
  _n.z = -nlx * sn + nlz * cs;
  return t0;
}

// 射线 × 三角形列表（凸包 faces / trimesh 共用）
function rayTriList(pos, idx, ox, oy, oz, dx, dy, dz, maxT) {
  let best = Infinity;
  let bx = 0, by = 0, bz = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const o0 = idx[i] * 3, o1 = idx[i + 1] * 3, o2 = idx[i + 2] * 3;
    const t = rayTri(ox, oy, oz, dx, dy, dz,
      pos[o0], pos[o0 + 1], pos[o0 + 2],
      pos[o1], pos[o1 + 1], pos[o1 + 2],
      pos[o2], pos[o2 + 1], pos[o2 + 2], maxT);
    if (t >= 0 && t < best) { best = t; bx = _n.x; by = _n.y; bz = _n.z; }
  }
  if (best === Infinity) return -1;
  _n.x = bx; _n.y = by; _n.z = bz;
  return best;
}

// 射线 × trimesh：整体包围盒早淘汰 → BVH 取候选 → 逐三角形精确
function rayTrimesh(tm, ox, oy, oz, dx, dy, dz, maxT) {
  if (!tm.positions || !tm.triCount || typeof tm.query !== 'function') return -1;
  const ex = ox + dx * maxT;
  const ey = oy + dy * maxT;
  const ez = oz + dz * maxT;
  const minX = Math.min(ox, ex) - 0.05, maxX = Math.max(ox, ex) + 0.05;
  const minY = Math.min(oy, ey) - 0.05, maxY = Math.max(oy, ey) + 0.05;
  const minZ = Math.min(oz, ez) - 0.05, maxZ = Math.max(oz, ez) + 0.05;
  if (maxX < tm.minX || minX > tm.maxX || maxY < tm.minY || minY > tm.maxY || maxZ < tm.minZ || minZ > tm.maxZ) return -1;
  tm.query(minX, minY, minZ, maxX, maxY, maxZ, _cand, 0);
  if (!_cand.length) return -1;

  const p = tm.positions;
  let best = Infinity;
  let bx = 0, by = 0, bz = 0;
  for (let ci = 0; ci < _cand.length; ci++) {
    const o = _cand[ci] * 9;
    const t = rayTri(ox, oy, oz, dx, dy, dz,
      p[o], p[o + 1], p[o + 2], p[o + 3], p[o + 4], p[o + 5], p[o + 6], p[o + 7], p[o + 8], maxT);
    if (t >= 0 && t < best) { best = t; bx = _n.x; by = _n.y; bz = _n.z; }
  }
  if (best === Infinity) return -1;
  _n.x = bx; _n.y = by; _n.z = bz;
  return best;
}

// 单个碰撞体的射线求交：返回 t 或 -1（法线写入 _n）
function rayCollider(c, ox, oy, oz, dx, dy, dz, maxT) {
  if (c.type === 'trimesh') return rayTrimesh(c, ox, oy, oz, dx, dy, dz, maxT);

  if (c.type === 'convex') {
    const idx = convexIndexTriples(c);
    if (idx) {
      const box = colliderBox(c);
      if (box && rayBoxMiss(box, ox, oy, oz, dx, dy, dz, maxT)) return -1;
      return rayTriList(c.vertices, idx, ox, oy, oz, dx, dy, dz, maxT);
    }
    const box = colliderBox(c);
    if (!box) return -1;
    return rayAabbBox(box, ox, oy, oz, dx, dy, dz, maxT);
  }

  // 盒（含 rotY）
  if (Number.isFinite(c.hx) && Number.isFinite(c.hy) && Number.isFinite(c.hz)) {
    return rayOBB(c, ox, oy, oz, dx, dy, dz, maxT);
  }
  const box = colliderBox(c);
  if (!box) return -1;
  return rayAabbBox(box, ox, oy, oz, dx, dy, dz, maxT);
}

// 包围盒粗筛：射线完全擦不到就直接跳过（不做精确判定）
function rayBoxMiss(b, ox, oy, oz, dx, dy, dz, maxT) {
  let t0 = 0;
  let t1 = maxT;
  const lo = [ox - b.cx, oy - b.cy, oz - b.cz];
  const ld = [dx, dy, dz];
  const h = [b.hx, b.hy, b.hz];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(ld[i]) < EPS) {
      if (Math.abs(lo[i]) > h[i]) return true;
      continue;
    }
    const inv = 1 / ld[i];
    let ta = (-h[i] - lo[i]) * inv;
    let tb = (h[i] - lo[i]) * inv;
    if (ta > tb) { const tt = ta; ta = tb; tb = tt; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return true;
  }
  return false;
}

// 纯 AABB 求交（凸包退回包围盒时用；起点在盒内按不命中处理）
function rayAabbBox(b, ox, oy, oz, dx, dy, dz, maxT) {
  let t0 = 0;
  let t1 = maxT;
  let axis = -1;
  let sign = 1;
  const lo = [ox - b.cx, oy - b.cy, oz - b.cz];
  const ld = [dx, dy, dz];
  const h = [b.hx, b.hy, b.hz];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(ld[i]) < EPS) {
      if (Math.abs(lo[i]) > h[i]) return -1;
      continue;
    }
    const inv = 1 / ld[i];
    let ta = (-h[i] - lo[i]) * inv;
    let tb = (h[i] - lo[i]) * inv;
    let sg = -1;
    if (ta > tb) { const tt = ta; ta = tb; tb = tt; sg = 1; }
    if (ta > t0) { t0 = ta; axis = i; sign = sg; }
    if (tb < t1) t1 = tb;
    if (t0 > t1) return -1;
  }
  if (axis < 0) return -1;
  _n.x = axis === 0 ? sign : 0;
  _n.y = axis === 1 ? sign : 0;
  _n.z = axis === 2 ? sign : 0;
  return t0;
}

// 主入口：射线 × 世界（碰撞体 + 隐式地面）。
// 返回 { t, x, y, z, nx, ny, nz } 或 null。opts.floorY 地面高度（默认 0）；opts.floor=false 关掉地面。
export function raycastWorld(colliders, ox, oy, oz, dx, dy, dz, maxT, opts) {
  let best = maxT;
  let found = false;
  let bnx = 0, bny = 0, bnz = 0;

  const useFloor = !opts || opts.floor !== false;
  if (useFloor && dy < -EPS) {
    const fy = (opts && Number.isFinite(opts.floorY)) ? opts.floorY : 0;
    const t = (fy - oy) / dy;
    if (t >= 0 && t <= best) { best = t; bnx = 0; bny = 1; bnz = 0; found = true; }
  }

  if (colliders && colliders.length) {
    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i];
      if (!c) continue;
      const t = rayCollider(c, ox, oy, oz, dx, dy, dz, best);
      if (t >= 0 && t < best) {
        best = t;
        bnx = _n.x; bny = _n.y; bnz = _n.z;
        found = true;
      }
    }
  }
  if (!found) return null;
  return { t: best, x: ox + dx * best, y: oy + dy * best, z: oz + dz * best, nx: bnx, ny: bny, nz: bnz };
}

// ---------------------------------------------------------------------------
// 小球（掉落物）求交
// ---------------------------------------------------------------------------

// 球 × 三角形：写入 _tc，返回是否有穿透
function triContact(px, py, pz, r, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const q = closestOnTri(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz);
  const dx = px - q.x, dy = py - q.y, dz = pz - q.z;
  const d2 = dx * dx + dy * dy + dz * dz;
  const r2 = r * r;
  if (d2 >= r2) return false;
  if (d2 > 1e-12) {
    const d = Math.sqrt(d2);
    _tc.nx = dx / d; _tc.ny = dy / d; _tc.nz = dz / d;
    _tc.depth = r - d;
    return true;
  }
  // 球心正好落在三角形上：用面法线推出
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  let nx = e1y * e2z - e1z * e2y;
  let ny = e1z * e2x - e1x * e2z;
  let nz = e1x * e2y - e1y * e2x;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
  _tc.nx = nx / len; _tc.ny = ny / len; _tc.nz = nz / len;
  _tc.depth = r;
  return true;
}

// 球 × 「顶点索引三元组」列表（凸包 faces）：取最深的一个接触
function triListContact(pos, idx, px, py, pz, r) {
  let bestDepth = 0;
  let bnx = 0, bny = 0, bnz = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const o0 = idx[i] * 3, o1 = idx[i + 1] * 3, o2 = idx[i + 2] * 3;
    if (!triContact(px, py, pz, r,
      pos[o0], pos[o0 + 1], pos[o0 + 2],
      pos[o1], pos[o1 + 1], pos[o1 + 2],
      pos[o2], pos[o2 + 1], pos[o2 + 2])) continue;
    if (_tc.depth > bestDepth) { bestDepth = _tc.depth; bnx = _tc.nx; bny = _tc.ny; bnz = _tc.nz; }
  }
  if (bestDepth <= 0) return false;
  _tc.depth = bestDepth; _tc.nx = bnx; _tc.ny = bny; _tc.nz = bnz;
  return true;
}

// 球 × 「三角形编号」列表（trimesh 的 BVH 候选）：取最深的一个接触。
// 注意区分：BVH 给的是「第几个三角形」，凸包 faces 给的是「第几个顶点」。
function candContact(positions, cand, px, py, pz, r) {
  let bestDepth = 0;
  let bnx = 0, bny = 0, bnz = 0;
  for (let ci = 0; ci < cand.length; ci++) {
    const o = cand[ci] * 9;
    if (!triContact(px, py, pz, r,
      positions[o], positions[o + 1], positions[o + 2],
      positions[o + 3], positions[o + 4], positions[o + 5],
      positions[o + 6], positions[o + 7], positions[o + 8])) continue;
    if (_tc.depth > bestDepth) { bestDepth = _tc.depth; bnx = _tc.nx; bny = _tc.ny; bnz = _tc.nz; }
  }
  if (bestDepth <= 0) return false;
  _tc.depth = bestDepth; _tc.nx = bnx; _tc.ny = bny; _tc.nz = bnz;
  return true;
}

// 球 × OBB（rotY=0 即 AABB）：写入 _tc
function obbContact(c, px, py, pz, r) {
  const rot = c.rotY || 0;
  const cs = Math.cos(rot);
  const sn = Math.sin(rot);
  const rx = px - c.cx, rz = pz - c.cz;
  const lx = rx * cs - rz * sn;
  const lz = rx * sn + rz * cs;
  const ly = py - c.cy;
  const qx = Math.max(-c.hx, Math.min(c.hx, lx));
  const qy = Math.max(-c.hy, Math.min(c.hy, ly));
  const qz = Math.max(-c.hz, Math.min(c.hz, lz));
  const dx = lx - qx, dy = ly - qy, dz = lz - qz;
  const d2 = dx * dx + dy * dy + dz * dz;

  if (d2 > 1e-12) {
    if (d2 >= r * r) return false;
    const d = Math.sqrt(d2);
    const nlx = dx / d, nly = dy / d, nlz = dz / d;
    _tc.nx = nlx * cs + nlz * sn;
    _tc.ny = nly;
    _tc.nz = -nlx * sn + nlz * cs;
    _tc.depth = r - d;
    return true;
  }
  // 球心在盒内：沿最小穿透轴推出
  const penX = c.hx - Math.abs(lx);
  const penY = c.hy - Math.abs(ly);
  const penZ = c.hz - Math.abs(lz);
  let nlx = 0, nly = 0, nlz = 0, pen;
  if (penX <= penY && penX <= penZ) { nlx = lx >= 0 ? 1 : -1; pen = penX + r; }
  else if (penY <= penZ) { nly = ly >= 0 ? 1 : -1; pen = penY + r; }
  else { nlz = lz >= 0 ? 1 : -1; pen = penZ + r; }
  _tc.nx = nlx * cs + nlz * sn;
  _tc.ny = nly;
  _tc.nz = -nlx * sn + nlz * cs;
  _tc.depth = pen;
  return true;
}

// 小球在世界里的最深穿透：返回复用的 { nx, ny, nz, depth } 或 null
export function sphereWorldMTV(colliders, x, y, z, r) {
  if (!colliders || !colliders.length) return null;
  let bestDepth = 0;
  let bnx = 0, bny = 0, bnz = 0;

  for (let i = 0; i < colliders.length; i++) {
    const c = colliders[i];
    if (!c) continue;
    const box = colliderBox(c);
    if (!box) continue;
    // 宽相位：球的外接盒与碰撞体世界包围盒不相交 → 直接跳过（远处碰撞体的开销只有 6 次比较）
    if (Math.abs(x - box.cx) > box.hx + r) continue;
    if (Math.abs(y - box.cy) > box.hy + r) continue;
    if (Math.abs(z - box.cz) > box.hz + r) continue;

    let hit = false;
    if (c.type === 'trimesh') {
      if (c.positions && c.triCount && typeof c.query === 'function') {
        c.query(x - r, y - r, z - r, x + r, y + r, z + r, _cand, 0.02);
        if (_cand.length) hit = candContact(c.positions, _cand, x, y, z, r);
      }
    } else if (c.type === 'convex') {
      const idx = convexIndexTriples(c);
      if (idx) hit = triListContact(c.vertices, idx, x, y, z, r);
      else hit = obbContact(box, x, y, z, r);
    } else if (Number.isFinite(c.hx) && Number.isFinite(c.hy) && Number.isFinite(c.hz)) {
      hit = obbContact(c, x, y, z, r);
    } else {
      hit = obbContact(box, x, y, z, r);
    }

    if (hit && _tc.depth > bestDepth) {
      bestDepth = _tc.depth; bnx = _tc.nx; bny = _tc.ny; bnz = _tc.nz;
    }
  }

  if (bestDepth <= 0) return null;
  _mtv.nx = bnx; _mtv.ny = bny; _mtv.nz = bnz; _mtv.depth = bestDepth;
  return _mtv;
}

// 小球的一帧推进（直接改写 s = { x,y,z,vx,vy,vz }）：
//   重力 → 子步进（单步位移 ≤ 半径，防穿薄墙/薄楼板）→ 隐式地面 → 碰撞体去穿透 + 弹跳。
// 返回是否踩到可站立面（供掉落物判定「落地静止」）。
// opts: { gravity=-24, restitution=0.34, friction=0.72, floorY=0 }
export function moveSphereWorld(colliders, s, dt, r, opts) {
  const o = opts || {};
  const gravity = Number.isFinite(o.gravity) ? o.gravity : -24;
  const rest = Number.isFinite(o.restitution) ? o.restitution : 0.34;
  const fric = Number.isFinite(o.friction) ? o.friction : 0.72;
  const floorY = Number.isFinite(o.floorY) ? o.floorY : 0;
  const slope = 0.7; // 可站立面的法线竖直分量阈值

  s.vy += gravity * dt;

  const dx = s.vx * dt, dy = s.vy * dt, dz = s.vz * dt;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  // 子步长 ≤ 0.8r：这样单步最多把球心推进 0.8r，不会从「贴着面」一步跨到面的另一侧
  // （即使遇到零厚度的薄墙也不会钻过去，弹回后的方向变化也能在同一帧内生效）
  let n = 1;
  if (dist > r * 0.8) n = Math.min(8, Math.ceil(dist / (r * 0.8)));
  const sub = dt / n;

  let grounded = false;
  for (let step = 0; step < n; step++) {
    // 每个子步按「当前速度」推进：墙/柱子的接触会立刻改变速度，剩下的子步就该按新速度走
    s.x += s.vx * sub;
    s.y += s.vy * sub;
    s.z += s.vz * sub;

    // 隐式地面（世界里地面不是碰撞体）
    if (s.y - r < floorY) {
      s.y = floorY + r;
      s.vy = Math.abs(s.vy) > 1.6 ? -s.vy * rest : 0;
      grounded = true;
    }

    // 碰撞体去穿透：每子步最多解算 3 轮（取最深接触逐个消掉）
    for (let it = 0; it < 3; it++) {
      const hit = sphereWorldMTV(colliders, s.x, s.y, s.z, r);
      if (!hit) break;
      s.x += hit.nx * hit.depth;
      s.y += hit.ny * hit.depth;
      s.z += hit.nz * hit.depth;
      const vn = s.vx * hit.nx + s.vy * hit.ny + s.vz * hit.nz;
      if (vn < 0) {
        s.vx -= (1 + rest) * vn * hit.nx;
        s.vy -= (1 + rest) * vn * hit.ny;
        s.vz -= (1 + rest) * vn * hit.nz;
      }
      if (hit.ny >= slope) {
        grounded = true;
        if (Math.abs(s.vy) > 1.6) s.vy = -s.vy * rest; else s.vy = 0;
      }
    }
  }

  // 地面摩擦（每帧一次，避免子步里反复衰减）
  if (grounded) {
    s.vx *= fric;
    s.vz *= fric;
  }
  return grounded;
}

// 便于单测：暴露内部复用缓冲（只读用途）
export const __buffers = _buffers;
