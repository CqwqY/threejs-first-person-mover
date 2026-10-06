// 职责：投掷物（小球）与世界碰撞体的精确相交判定，供 Game 的投掷物使用。
// - 盒碰撞体：球-OBB 精确判定（含 rotY），并用「线段-盒」补一次扫描，防止高速穿墙。
// - trimesh（complex 模式烘焙）：走其 BVH.query 粗筛候选三角形，再做「球-三角形」与
//   「线段-三角形」精确求交。不能用包围盒近似——那会把整栋空心的楼当成实心块，
//   导致手雷刚进门就在楼体内爆炸。
// - convex（凸包 / 盒的凸包形式）：faces 能识别为顶点索引三元组时按真实三角形判定，
//   否则退回包围盒（凸包对其内部是实心，近似误差可接受）。
//
// 约定：positions 为「每 9 个 float 一个三角形」的扁平数组（与 trimesh.js 一致）。

const EPS = 1e-9;

// 点到三角形的最近距离平方（Ericson, Real-Time Collision Detection）
function distSqPointTri(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;

  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    const qx = ax + abx * v, qy = ay + aby * v, qz = az + abz * v;
    const dx = px - qx, dy = py - qy, dz = pz - qz;
    return dx * dx + dy * dy + dz * dz;
  }

  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    const qx = ax + acx * w, qy = ay + acy * w, qz = az + acz * w;
    const dx = px - qx, dy = py - qy, dz = pz - qz;
    return dx * dx + dy * dy + dz * dz;
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    const qx = bx + (cx - bx) * w, qy = by + (cy - by) * w, qz = bz + (cz - bz) * w;
    const dx = px - qx, dy = py - qy, dz = pz - qz;
    return dx * dx + dy * dy + dz * dz;
  }

  const denom = va + vb + vc;
  if (denom === 0) return apx * apx + apy * apy + apz * apz;
  const v = vb / denom, w = vc / denom;
  const qx = ax + abx * v + acx * w, qy = ay + aby * v + acy * w, qz = az + abz * v + acz * w;
  const dx = px - qx, dy = py - qy, dz = pz - qz;
  return dx * dx + dy * dy + dz * dz;
}

// 线段 A→B 是否穿过三角形（Möller–Trumbore）
function segmentHitsTri(ax, ay, az, bx, by, bz, v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z) {
  const e1x = v1x - v0x, e1y = v1y - v0y, e1z = v1z - v0z;
  const e2x = v2x - v0x, e2y = v2y - v0y, e2z = v2z - v0z;
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const hx = dy * e2z - dz * e2y;
  const hy = dz * e2x - dx * e2z;
  const hz = dx * e2y - dy * e2x;
  const a = e1x * hx + e1y * hy + e1z * hz;
  if (a > -EPS && a < EPS) return false; // 平行
  const f = 1 / a;
  const sx = ax - v0x, sy = ay - v0y, sz = az - v0z;
  const u = f * (sx * hx + sy * hy + sz * hz);
  if (u < 0 || u > 1) return false;
  const qx = sy * e1z - sz * e1y;
  const qy = sz * e1x - sx * e1z;
  const qz = sx * e1y - sy * e1x;
  const v = f * (dx * qx + dy * qy + dz * qz);
  if (v < 0 || u + v > 1) return false;
  const t = f * (e2x * qx + e2y * qy + e2z * qz);
  return t > -EPS && t < 1 + EPS;
}

// 线段是否与「以原点为中心、半长为 h」的盒相交（slab 法）
function segmentHitsAabb(ax, ay, az, bx, by, bz, hx, hy, hz) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  let t0 = 0, t1 = 1;
  const p = [ax, ay, az];
  const d = [dx, dy, dz];
  const h = [hx, hy, hz];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < EPS) {
      if (Math.abs(p[i]) > h[i]) return false;
    } else {
      const inv = 1 / d[i];
      let ta = (-h[i] - p[i]) * inv;
      let tb = (h[i] - p[i]) * inv;
      if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 > t1) return false;
    }
  }
  return true;
}

// 把凸包 faces 识别为「顶点索引三元组」；识别不了返回 null
// 凸包能否按真实三角形判定（faces 是一组合法的顶点索引三元组）。
// ⚠ 结果**缓存在碰撞体上**：原来每次调用都要把整个 faces 数组扫一遍做范围校验，
//   而碰撞体是静态的（编辑器保存的场景），faces 不会变 —— 属于纯粹的白扫。
function convexIndexTriples(b) {
  if (b.__convexIdx !== undefined) return b.__convexIdx;
  let result = null;
  const f = b.faces;
  const verts = b.vertices;
  if (Array.isArray(f) && verts && f.length >= 3 && f.length % 3 === 0) {
    const n = verts.length / 3;
    result = f;
    for (let i = 0; i < f.length; i++) {
      const k = f[i];
      if (!Number.isInteger(k) || k < 0 || k >= n) { result = null; break; }
    }
  }
  b.__convexIdx = result; // null 也缓存：表示"这个凸包没有可用索引"
  return result;
}

// 球是否剖到 trimesh 的真实三角形（BVH 粗筛 + 精确球/线段求交）
function sphereHitsTrimesh(tm, x, y, z, r, fx, fy, fz) {
  if (!tm || tm.triCount === 0 || typeof tm.query !== 'function') return false;
  const out = tm._projOut || (tm._projOut = []);
  // 扫描盒：当前球盒 ∪ 上一帧到当前帧的线段盒，二者取并，避免高速掠过薄墙
  const minX = Math.min(x, fx) - r - 0.1;
  const minY = Math.min(y, fy) - r - 0.1;
  const minZ = Math.min(z, fz) - r - 0.1;
  const maxX = Math.max(x, fx) + r + 0.1;
  const maxY = Math.max(y, fy) + r + 0.1;
  const maxZ = Math.max(z, fz) + r + 0.1;
  const n = tm.query(minX, minY, minZ, maxX, maxY, maxZ, out, 0);
  if (!n) return false;
  const pos = tm.positions;
  const r2 = r * r;
  for (let i = 0; i < n; i++) {
    const o = out[i] * 9;
    const ax = pos[o], ay = pos[o + 1], az = pos[o + 2];
    const bx = pos[o + 3], by = pos[o + 4], bz = pos[o + 5];
    const cx = pos[o + 6], cy = pos[o + 7], cz = pos[o + 8];
    if (distSqPointTri(x, y, z, ax, ay, az, bx, by, bz, cx, cy, cz) <= r2) return true;
    if (segmentHitsTri(fx, fy, fz, x, y, z, ax, ay, az, bx, by, bz, cx, cy, cz)) return true;
  }
  return false;
}

// 碰撞体的世界空间 AABB（**惰性缓存到碰撞体上**）。只用于主循环最前面那道廉价分离测试。
// 为什么值得：本函数每个投掷物每帧要跑一遍全部碰撞体，而其中凸包的成本是**遍历它所有的面**
//   （distSqPointTri + segmentHitsTri）。上百个凸包里真正在投掷物附近的通常一两个，
//   其余全在做无用功。用一次 AABB 比较把它们剔掉 —— 这正是 Unity/PhysX 说的 broadphase 思想，
//   只是这里不需要整张网格：投掷物数量少，一层线性 AABB 预筛就够。
// ⚠ 只对**静态**碰撞体安全：本项目碰撞体来自编辑器保存的场景（运行时几何不变），
//   缓存不会失配。若将来出现运行时改几何的碰撞体，必须清掉它的 __bbox。
function colliderAabb(b) {
  if (b.__bbox !== undefined) return b.__bbox;
  let box = null;
  if (b.type === 'convex') {
    if (Number.isFinite(b.minX) && Number.isFinite(b.maxX)) {
      box = { minX: b.minX, maxX: b.maxX, minY: b.minY, maxY: b.maxY, minZ: b.minZ, maxZ: b.maxZ };
    } else {
      const src = b.vertices;
      if (src && src.length >= 3) {
        let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let i = 0; i < src.length; i += 3) {
          const px = src[i], py = src[i + 1], pz = src[i + 2];
          if (px < minX) minX = px; if (px > maxX) maxX = px;
          if (py < minY) minY = py; if (py > maxY) maxY = py;
          if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
        }
        box = { minX, maxX, minY, maxY, minZ, maxZ };
      }
    }
  } else if (b.hx !== undefined) {
    // 盒 / 绕 Y 旋转盒：旋转后 XZ 半宽最多是 hx+hz（保守外扩，只多不少）
    const rot = b.rotY || 0;
    const e = rot ? Math.abs(Math.cos(rot)) + Math.abs(Math.sin(rot)) : 1;
    box = {
      minX: b.cx - b.hx * e, maxX: b.cx + b.hx * e,
      minY: b.cy - b.hy, maxY: b.cy + b.hy,
      minZ: b.cz - b.hz * e, maxZ: b.cz + b.hz * e,
    };
  }
  b.__bbox = box; // null 也缓存：表示"算不出 AABB" → 该碰撞体不做预筛
  return box;
}

// 投掷物是否被世界碰撞体挡住：prev=(fx,fy,fz) 上一帧位置，cur=(x,y,z) 当前帧位置，r 球半径
export function projectileHitsWorld(colliders, x, y, z, r, fx, fy, fz) {
  if (!colliders || !colliders.length) return false;
  // 扫掠包围盒（当前球 ∪ 上一帧到当前帧的线段）—— 与 sphereHitsTrimesh 里那个盒同一口径。
  // 用同一个盒对每个碰撞体做一次廉价分离测试：不相交就跳过它整段昂贵的三角形遍历。
  const sxMin = Math.min(x, fx) - r, sxMax = Math.max(x, fx) + r;
  const syMin = Math.min(y, fy) - r, syMax = Math.max(y, fy) + r;
  const szMin = Math.min(z, fz) - r, szMax = Math.max(z, fz) + r;
  for (const b of colliders) {
    if (!b) continue;

    if (b.type === 'trimesh') {
      if (sphereHitsTrimesh(b, x, y, z, r, fx, fy, fz)) return true;
      continue;
    }

    // ---- 廉价 AABB 预筛（凸包/盒）----
    // ⚠ 必须在 convex 的 `convexIndexTriples(b)` **之前**：那个函数会建索引表，
    //   而它才是每帧的大头。AABB 不相交时连索引都不用建。
    {
      const bb = colliderAabb(b);
      if (bb && (sxMax < bb.minX || sxMin > bb.maxX ||
        syMax < bb.minY || syMin > bb.maxY ||
        szMax < bb.minZ || szMin > bb.maxZ)) continue;
    }

    if (b.type === 'convex') {
      const idx = convexIndexTriples(b);
      if (idx) {
        const v = b.vertices;
        const r2 = r * r;
        for (let i = 0; i < idx.length; i += 3) {
          const o0 = idx[i] * 3, o1 = idx[i + 1] * 3, o2 = idx[i + 2] * 3;
          const ax = v[o0], ay = v[o0 + 1], az = v[o0 + 2];
          const bx = v[o1], by = v[o1 + 1], bz = v[o1 + 2];
          const cx = v[o2], cy = v[o2 + 1], cz = v[o2 + 2];
          if (distSqPointTri(x, y, z, ax, ay, az, bx, by, bz, cx, cy, cz) <= r2) return true;
          if (segmentHitsTri(fx, fy, fz, x, y, z, ax, ay, az, bx, by, bz, cx, cy, cz)) return true;
        }
        continue;
      }
      // faces 不是索引：退回包围盒（凸包内部是实心，误差可接受）
      if (hitsByAabb(b, x, y, z, r, fx, fy, fz)) return true;
      continue;
    }

    // 盒碰撞体（可带 rotY）：转到盒局部坐标做精确判定
    const c = Math.cos(b.rotY || 0);
    const s = Math.sin(b.rotY || 0);
    const lx = (x - b.cx) * c - (z - b.cz) * s;
    const lz = (x - b.cx) * s + (z - b.cz) * c;
    const ly = y - b.cy;
    if (Math.abs(lx) < b.hx + r && Math.abs(ly) < b.hy + r && Math.abs(lz) < b.hz + r) return true;
    const flx = (fx - b.cx) * c - (fz - b.cz) * s;
    const flz = (fx - b.cx) * s + (fz - b.cz) * c;
    const fly = fy - b.cy;
    if (segmentHitsAabb(flx, fly, flz, lx, ly, lz, b.hx + r, b.hy + r, b.hz + r)) return true;
  }
  return false;
}

// 凸包没有可用索引三角形时的兜底：用顶点算包围盒（结果缓存在碰撞体上）
function hitsByAabb(b, x, y, z, r, fx, fy, fz) {
  let box = b.__aabb;
  if (box === undefined) {
    const src = b.vertices || b.positions;
    if (!src || src.length < 3) { b.__aabb = null; box = null; } else {
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (let i = 0; i < src.length; i += 3) {
        const px = src[i], py = src[i + 1], pz = src[i + 2];
        if (px < minX) minX = px; if (px > maxX) maxX = px;
        if (py < minY) minY = py; if (py > maxY) maxY = py;
        if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
      }
      box = { minX, minY, minZ, maxX, maxY, maxZ };
      b.__aabb = box;
    }
  }
  if (!box) return false;
  const hx = (box.maxX - box.minX) / 2 + r;
  const hy = (box.maxY - box.minY) / 2 + r;
  const hz = (box.maxZ - box.minZ) / 2 + r;
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  const cz = (box.minZ + box.maxZ) / 2;
  if (Math.abs(x - cx) < hx && Math.abs(y - cy) < hy && Math.abs(z - cz) < hz) return true;
  return segmentHitsAabb(fx - cx, fy - cy, fz - cz, x - cx, y - cy, z - cz, hx, hy, hz);
}
