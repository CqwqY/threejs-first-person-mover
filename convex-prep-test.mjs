// 碰撞优化等价性验证（纯 Node，不依赖浏览器/WebGL）
// 复刻优化前的 _resolveConvex / _convexStandHeight 逐帧算法，与优化版（预计算 + AABB 早淘汰）对随机玩家位置逐字段对比。
// 若全部一致 → 证明本次优化只削每帧冗余计算、未改碰撞结果语义。
import { PlayerPhysics } from './src/player/PlayerPhysics.js';
import { Config } from './src/config.js';

// ---- 构造测试凸包 ----
function makeBox() {
  const V = new Float64Array([
    -1, 0, -1,  1, 0, -1,  1, 0, 1,  -1, 0, 1,
    -1, 2, -1,  1, 2, -1,  1, 2, 1,  -1, 2, 1,
  ]);
  const F = [
    0, 1, 2, 0, 2, 3,
    4, 6, 5, 4, 7, 6,
    0, 1, 5, 0, 5, 4,
    1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6,
    3, 0, 4, 3, 4, 7,
  ];
  return { type: 'convex', vertices: Array.from(V), faces: F, cx: 0, cy: 1, cz: 0, minY: 0, maxY: 2 };
}
function makePyramid() {
  // 底面 4 顶点 + 尖顶 1 顶点（无水平顶面，用于验证 standFaces 边界）
  const V = new Float64Array([
    -1, 0, -1,  1, 0, -1,  1, 0, 1,  -1, 0, 1,  0, 2.5, 0,
  ]);
  const F = [0, 2, 1, 0, 3, 2, 0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4];
  return { type: 'convex', vertices: Array.from(V), faces: F, cx: 0, cy: 0.5, cz: 0, minY: 0, maxY: 2.5 };
}

// ---- 复刻优化前算法（逐帧叉乘 + toFixed + Set，无预计算 / 无 AABB 早淘汰）----
function origResolveConvex(ph, state, b, px, py, pz, pr, hh) {
  const V = b.vertices, F = b.faces;
  const pC = { x: px, y: py, z: pz };
  const cC = { x: b.cx, y: b.cy, z: b.cz };
  const axes = [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }];
  const seen = new Set();
  for (let i = 0; i + 2 < F.length; i += 3) {
    const i0 = F[i] * 3, i1 = F[i + 1] * 3, i2 = F[i + 2] * 3;
    const ax = V[i1] - V[i0], ay = V[i1 + 1] - V[i0 + 1], az = V[i1 + 2] - V[i0 + 2];
    const bx = V[i2] - V[i0], by = V[i2 + 1] - V[i0 + 1], bz = V[i2 + 2] - V[i0 + 2];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    let len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len < 1e-9) continue;
    nx /= len; ny /= len; nz /= len;
    const key = nx.toFixed(3) + ',' + ny.toFixed(3) + ',' + nz.toFixed(3);
    if (seen.has(key)) continue;
    seen.add(key);
    axes.push({ x: nx, y: ny, z: nz });
    if (axes.length >= 48) break;
  }
  let minOverlap = Infinity, minAxis = null;
  for (const L of axes) {
    const wA = pr * (Math.abs(L.x) + Math.abs(L.z)) + hh * Math.abs(L.y);
    const cA = pC.x * L.x + pC.y * L.y + pC.z * L.z;
    let vMin = Infinity, vMax = -Infinity;
    for (let i = 0; i < V.length; i += 3) {
      const d = V[i] * L.x + V[i + 1] * L.y + V[i + 2] * L.z;
      if (d < vMin) vMin = d; if (d > vMax) vMax = d;
    }
    const overlap = Math.min(cA + wA, vMax) - Math.max(cA - wA, vMin);
    if (overlap <= 1e-6) return;
    if (overlap < minOverlap) { minOverlap = overlap; minAxis = L; }
  }
  if (!minAxis) return;
  const isY = Math.abs(minAxis.y) > 0.999;
  if (isY) {
    if (py > b.maxY) { state.y = b.maxY + Config.PLAYER_HEIGHT * ph.sizeScale; if (ph.velocity.y < 0) ph.velocity.y = 0; state.onGround = true; }
    else if (py < b.minY) { state.y = b.minY; if (ph.velocity.y > 0) ph.velocity.y = 0; }
    else {
      let vMinX = Infinity, vMaxX = -Infinity, vMinZ = Infinity, vMaxZ = -Infinity;
      for (let i = 0; i < V.length; i += 3) { const vx = V[i], vz = V[i + 2]; if (vx < vMinX) vMinX = vx; if (vx > vMaxX) vMaxX = vx; if (vz < vMinZ) vMinZ = vz; if (vz > vMaxZ) vMaxZ = vz; }
      const ox = Math.min(px + pr, vMaxX) - Math.max(px - pr, vMinX);
      const oz = Math.min(pz + pr, vMaxZ) - Math.max(pz - pr, vMinZ);
      if (ox <= oz) state.x += px > b.cx ? ox : -ox; else state.z += pz > b.cz ? oz : -oz;
    }
    return;
  }
  const sd = (px - cC.x) * minAxis.x + (py - cC.y) * minAxis.y + (pz - cC.z) * minAxis.z;
  const dir = sd >= 0 ? 1 : -1;
  const nx = minAxis.x * dir, ny = minAxis.y * dir, nz = minAxis.z * dir;
  const absNy = Math.abs(ny);
  if (absNy >= Config.SLOPE_MAX_NORMAL_Y && absNy < 0.999 && minOverlap <= Config.GROUND_SNAP_DISTANCE) {
    const horiz = 1 - Config.SLOPE_GRIP;
    state.x += nx * minOverlap * horiz;
    state.z += nz * minOverlap * horiz;
    state.y += minOverlap * (1 - horiz * (1 - ny * ny)) / ny;
    if (ny > 0) { if (ph.velocity.y < 0) ph.velocity.y = 0; state.onGround = true; }
    else if (ph.velocity.y > 0) ph.velocity.y = 0;
    return;
  }
  state.x += minAxis.x * minOverlap * dir;
  state.y += minAxis.y * minOverlap * dir;
  state.z += minAxis.z * minOverlap * dir;
}

function origStandHeight(ph, b, x, z, pr) {
  const V = b.vertices, F = b.faces;
  const minNy = Config.SLOPE_MAX_NORMAL_Y;
  let best = null;
  for (let i = 0; i + 2 < F.length; i += 3) {
    const i0 = F[i] * 3, i1 = F[i + 1] * 3, i2 = F[i + 2] * 3;
    const eax = V[i1] - V[i0], eay = V[i1 + 1] - V[i0 + 1], eaz = V[i1 + 2] - V[i0 + 2];
    const ebx = V[i2] - V[i0], eby = V[i2 + 1] - V[i0 + 1], ebz = V[i2 + 2] - V[i0 + 2];
    let nx = eay * ebz - eaz * eby, ny = eaz * ebx - eax * ebz, nz = eax * eby - eay * ebx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len < 1e-9) continue;
    nx /= len; ny /= len; nz /= len;
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
    if (ny < minNy) continue;
    const d = nx * V[i0] + ny * V[i0 + 1] + nz * V[i0 + 2];
    const h = (d - nx * x - nz * z + pr * (Math.abs(nx) + Math.abs(nz))) / ny;
    if (best !== null && h <= best) continue;
    if (!ph._pointInTriXZ(x, z, V[i0], V[i0 + 2], V[i1], V[i1 + 2], V[i2], V[i2 + 2])) continue;
    best = h;
  }
  return best;
}

// ---- 跑对比 ----
const ph = new PlayerPhysics();
let fails = 0, n = 0, standFails = 0;
const pr = Config.PLAYER_RADIUS, hh = Config.PLAYER_HEIGHT / 2;
for (const b of [makeBox(), makePyramid()]) {
  ph._prepareConvex(b);
  for (let t = 0; t < 200; t++) {
    const px = (Math.random() * 2 - 1) * 6;
    const py = Math.random() * 4;
    const pz = (Math.random() * 2 - 1) * 6;
    const sO = { x: px, y: py, z: pz, onGround: false };
    const sN = { x: px, y: py, z: pz, onGround: false };
    ph.velocity.y = 0;
    origResolveConvex(ph, sO, b, px, py - hh, pz, pr, hh);
    ph._resolveConvex(sN, b, px, py - hh, pz, pr, hh);
    n++;
    if (Math.abs(sO.x - sN.x) > 1e-6 || Math.abs(sO.y - sN.y) > 1e-6 ||
        Math.abs(sO.z - sN.z) > 1e-6 || sO.onGround !== sN.onGround) {
      fails++;
      if (fails <= 6) console.log('SAT MISMATCH', { px, py, pz }, 'orig', sO, 'new', sN);
    }
    const hO = origStandHeight(ph, b, px, pz, pr);
    const hN = ph._convexStandHeight(b, px, pz, pr);
    if ((hO === null) !== (hN === null) || (hO !== null && hN !== null && Math.abs(hO - hN) > 1e-6)) {
      standFails++;
      if (standFails <= 6) console.log('STAND MISMATCH', { px, pz }, 'orig', hO, 'new', hN);
    }
  }
}
console.log(`cases=${n}  SAT_fails=${fails}  STAND_fails=${standFails}`);
console.log(fails === 0 && standFails === 0 ? 'PASS ✅ 优化版与原版碰撞语义完全一致' : 'FAIL ❌');
