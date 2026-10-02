// 纯逻辑自检（不依赖浏览器/WebGL）：worldQuery 是黑洞 / 抓钩 / 掉落物共用的碰撞查询，
// 这里直接 import 线上模块（不是复刻），验证三类碰撞体 + 小球物理的数学正确性。
// 用法：node world-query-check.mjs
import { raycastWorld, sphereWorldMTV, moveSphereWorld } from './src/world/collision/worldQuery.js';

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log('  FAIL ' + msg); } else { console.log('  ok   ' + msg); } };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---- 造一个「三角形汤」碰撞体（query 用暴力遍历代替 BVH：本测试只验证数学）----
function triMesh(tris) {
  const positions = new Float32Array(tris.length * 9);
  tris.forEach((t, i) => positions.set(t, i * 9));
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i] < minX) minX = positions[i];
    if (positions[i] > maxX) maxX = positions[i];
    if (positions[i + 1] < minY) minY = positions[i + 1];
    if (positions[i + 1] > maxY) maxY = positions[i + 1];
    if (positions[i + 2] < minZ) minZ = positions[i + 2];
    if (positions[i + 2] > maxZ) maxZ = positions[i + 2];
  }
  return {
    type: 'trimesh', positions, triCount: tris.length, minX, minY, minZ, maxX, maxY, maxZ,
    query(qx0, qy0, qz0, qx1, qy1, qz1, out) {
      out.length = 0;
      for (let t = 0; t < tris.length; t++) {
        const o = t * 9;
        let tminX = Infinity, tmaxX = -Infinity, tminY = Infinity, tmaxY = -Infinity, tminZ = Infinity, tmaxZ = -Infinity;
        for (let k = 0; k < 3; k++) {
          const px = positions[o + k * 3], py = positions[o + k * 3 + 1], pz = positions[o + k * 3 + 2];
          if (px < tminX) tminX = px; if (px > tmaxX) tmaxX = px;
          if (py < tminY) tminY = py; if (py > tmaxY) tmaxY = py;
          if (pz < tminZ) tminZ = pz; if (pz > tmaxZ) tmaxZ = pz;
        }
        if (tmaxX < qx0 || tminX > qx1 || tmaxY < qy0 || tminY > qy1 || tmaxZ < qz0 || tminZ > qz1) continue;
        out.push(t);
      }
      return out.length;
    },
  };
}

// 半径 5 的地面（两块三角形）
const floorMesh = triMesh([
  [-5, 0, -5, -5, 0, 5, 5, 0, -5],
  [5, 0, -5, -5, 0, 5, 5, 0, 5],
]);
// 四面墙的空心盒子：x/z ∈ [-2,2]，高 3（没有顶和底 → 用来验证「从里面打出去」）
const shell = triMesh([
  [2, 0, -2, 2, 0, 2, 2, 3, -2], [2, 0, 2, 2, 3, 2, 2, 3, -2],       // +X 墙
  [-2, 0, -2, -2, 0, 2, -2, 3, -2], [-2, 0, 2, -2, 3, 2, -2, 3, -2], // -X 墙
  [-2, 0, 2, 2, 0, 2, -2, 3, 2], [2, 0, 2, 2, 3, 2, -2, 3, 2],       // +Z 墙
  [-2, 0, -2, 2, 0, -2, -2, 3, -2], [2, 0, -2, 2, 3, -2, -2, 3, -2], // -Z 墙
]);

const pillar = { cx: 0, cy: 1.5, cz: 0, hx: 0.6, hy: 1.5, hz: 0.6 }; // 顶面 y = 3

console.log('== 1. 射线 × 盒（AABB）==');
{
  const box = { cx: 0, cy: 2, cz: 0, hx: 1, hy: 2, hz: 1 };
  const h = raycastWorld([box], -5, 2, 0, 1, 0, 0, 20, { floor: false });
  ok(!!h, '正面命中');
  ok(h && near(h.t, 4, 1e-9), '距离 t = 4（实际 ' + (h && h.t) + '）');
  ok(h && near(h.nx, -1) && near(h.ny, 0) && near(h.nz, 0), '法线指向射线来的一侧 (-1,0,0)');
  ok(raycastWorld([box], -5, 2, 0, -1, 0, 0, 20, { floor: false }) === null, '背向 → 不命中');
  ok(raycastWorld([box], 0, 2, 0, 1, 0, 0, 20, { floor: false }) === null, '起点在盒内 → 不命中（不能勾自己脚下的盒）');
  ok(raycastWorld([box], -5, 5, 0, 1, 0, 0, 20, { floor: false }) === null, '从上方掠过 → 不命中');
}

console.log('== 2. 射线 × OBB（rotY）==');
{
  for (const deg of [15, 30, 45, 60, 90, 123]) {
    const rot = deg * Math.PI / 180;
    const box = { cx: 0, cy: 1, cz: 0, hx: 1, hy: 1, hz: 0.6, rotY: rot };
    const h = raycastWorld([box], 0, 1, -6, 0, 0, 1, 30, { floor: false });
    if (!h) { ok(false, deg + '° 应当命中'); continue; }
    // 命中点回到盒本地坐标后必须落在面上（|l|/h 的最大值 ≈ 1）
    const cs = Math.cos(rot), sn = Math.sin(rot);
    const rx = h.x - box.cx, rz = h.z - box.cz;
    const lx = rx * cs - rz * sn, lz = rx * sn + rz * cs, ly = h.y - box.cy;
    const m = Math.max(Math.abs(lx) / box.hx, Math.abs(ly) / box.hy, Math.abs(lz) / box.hz);
    ok(near(m, 1, 1e-6), deg + '° 命中点在盒面上（max|local|/h = ' + m.toFixed(6) + '）');
    // 世界法线转回本地应当只剩一个 ±1 分量
    const nlx = h.nx * cs - h.nz * sn, nlz = h.nx * sn + h.nz * cs;
    const parts = [Math.abs(nlx), Math.abs(h.ny), Math.abs(nlz)].sort((a, b) => b - a);
    ok(near(parts[0], 1, 1e-6) && near(parts[1], 0, 1e-6) && near(parts[2], 0, 1e-6),
      deg + '° 法线是盒的某个轴（' + parts.map((v) => v.toFixed(3)).join(',') + '）');
  }
}

console.log('== 3. 射线 × trimesh（复杂建筑）==');
{
  const h1 = raycastWorld([floorMesh], 0, 5, 0, 0, -1, 0, 20, { floor: false });
  ok(h1 && near(h1.t, 5, 1e-6), '地面命中 t = 5（实际 ' + (h1 && h1.t) + '）');
  ok(h1 && h1.ny > 0.99, '地面法线朝上');
  // 站在空盒里朝 +X 打：应当打到 2m 外的墙（而不是像包围盒近似那样在 0 处就命中）
  const h2 = raycastWorld([shell], 0, 1.5, 0, 1, 0, 0, 20, { floor: false });
  ok(h2 && near(h2.t, 2, 1e-6), '从空盒内部打到墙 t = 2（实际 ' + (h2 && h2.t) + '）');
  ok(h2 && near(h2.nx, -1, 1e-6), '墙法线朝内 (-1,0,0)');
  // 站在盒外朝里打：打到近侧墙 t = 4（从 x=-6 出发 → 到 x=-2）
  const h3 = raycastWorld([shell], -6, 1.5, 0, 1, 0, 0, 20, { floor: false });
  ok(h3 && near(h3.t, 4, 1e-6), '从盒外打到近侧墙 t = 4（实际 ' + (h3 && h3.t) + '）');
  // 整体包围盒早淘汰：射线打到天上不该命中
  ok(raycastWorld([shell], -6, 9, 0, 1, 0, 0, 20, { floor: false }) === null, '高于屋顶 → 不命中');
  // 隐式地面（世界里地面不是碰撞体）：朝下必须能命中
  const h4 = raycastWorld([], 0, 4, 0, 0, -1, 0, 20, {});
  ok(h4 && near(h4.t, 4, 1e-6) && near(h4.ny, 1), '隐式地面命中（t = ' + (h4 && h4.t) + '）');
}

console.log('== 4. 小球 × 世界（球-面穿透）==');
{
  const m = sphereWorldMTV([pillar], 0, 3.2, 0, 0.32);
  ok(!!m, '压在柱顶上 → 有穿透');
  ok(m && near(m.ny, 1) && near(m.depth, 0.12, 1e-6), '法线朝上、深度 0.12（实际 ' + (m && m.depth.toFixed(4)) + '）');
  ok(sphereWorldMTV([pillar], 0, 3.4, 0, 0.32) === null, '离柱顶还有 0.08 → 无穿透');
  ok(sphereWorldMTV([pillar], 5, 1, 0, 0.32) === null, '远离柱子 → 无穿透');
  const side = sphereWorldMTV([pillar], 0.85, 1.5, 0, 0.32);
  ok(side && near(side.nx, 1, 1e-6), '贴住柱子侧面 → 法线沿 +X');
  const tri = sphereWorldMTV([floorMesh], 0, 0.2, 0, 0.32);
  ok(tri && near(tri.ny, 1) && near(tri.depth, 0.12, 1e-6), '压在 trimesh 地面上 → 深度 0.12');
}

console.log('== 5. 小球一帧推进（掉落物物理）==');
{
  // 5.1 从空中落到柱子顶上并停住（不能穿过去）
  const s = { x: 0, y: 5, z: 0, vx: 0, vy: 0, vz: 0 };
  const r = 0.32;
  let grounded = false;
  for (let i = 0; i < 240; i++) grounded = moveSphereWorld([pillar], s, 1 / 60, r, { floorY: 0 });
  ok(s.y > 3.3 - 1e-3 && s.y < 3.33, '停在柱顶（y ≈ 3.32，实际 ' + s.y.toFixed(4) + '）');
  ok(grounded === true, '最后一帧仍判定踩在可站立面上');

  // 5.2 落到旁边：应当停在隐式地面上（y = r），不是柱顶
  const s2 = { x: 3, y: 5, z: 0, vx: 0, vy: 0, vz: 0 };
  for (let i = 0; i < 240; i++) moveSphereWorld([pillar], s2, 1 / 60, r, { floorY: 0 });
  ok(near(s2.y, r, 1e-3), '落在柱外地面 y = 0.32（实际 ' + s2.y.toFixed(4) + '）');

  // 5.3 正面撞墙：被弹回来，不穿墙（墙在 z = -1，厚 0.5）。
  // 必须让球在空中（贴地时每帧 0.72 的地面摩擦会立刻把水平速度磨没，走不到墙边）
  const wall = { cx: 0, cy: 1.5, cz: -1, hx: 5, hy: 1.5, hz: 0.25 };
  const s3 = { x: 0, y: 1.0, z: -3.5, vx: 0, vy: 0, vz: 30 };
  let maxZ = -Infinity;
  for (let i = 0; i < 20; i++) {
    moveSphereWorld([wall], s3, 1 / 60, r, { floorY: 0 });
    if (s3.z > maxZ) maxZ = s3.z;
  }
  ok(maxZ <= -1.25 - r + 1e-3, '最远只推进到墙面（max z = ' + maxZ.toFixed(4) + '，墙面 z = ' + (-1.25 - r).toFixed(2) + '）');
  ok(s3.vz < 0, '被墙弹回（vz = ' + s3.vz.toFixed(4) + '）');

  // 5.4 薄墙 + 高速：子步进不允许一帧跨过（薄墙厚 0.12，侧面 40m/s 冲过去）
  const thin = { cx: 0, cy: 1.5, cz: 0, hx: 5, hy: 1.5, hz: 0.06 };
  const s4 = { x: 0, y: 1.0, z: -2.5, vx: 0, vy: 0, vz: 40 };
  let crossed = false;
  for (let i = 0; i < 30; i++) {
    moveSphereWorld([thin], s4, 1 / 60, r, { floorY: 0 });
    if (s4.z > 0.06 + r) crossed = true;
  }
  ok(!crossed, '高速(40m/s)没有穿过 0.12 厚的薄墙（最终 z = ' + s4.z.toFixed(4) + '）');

  // 5.5 不传碰撞体时行为与老实现一致：落到 y = r 并弹一下
  const s5 = { x: 0, y: 3, z: 0, vx: 0, vy: 0, vz: 0 };
  let bouncedUp = false;
  for (let i = 0; i < 120; i++) {
    moveSphereWorld([], s5, 1 / 60, r, { floorY: 0 });
    if (s5.vy > 0.2) bouncedUp = true;
  }
  ok(near(s5.y, r, 1e-3), '空世界落到 y = 0.32');
  ok(bouncedUp, '落地有回弹（与旧实现一致）');
}

console.log('== 6. 黑洞飞行扫掠（每帧一次射线）==');
{
  const wall = { cx: 0, cy: 3, cz: -1, hx: 6, hy: 3, hz: 0.3 };
  const colliders = [wall];
  const rad = 0.35;
  const pos = { x: 0, y: 2, z: -5 };
  const vel = { x: 0, y: 0, z: 14 };
  let settled = false;
  for (let f = 0; f < 180 && !settled; f++) {
    // 与 Game._updateHoles 的飞行分支同一套算法
    vel.y += -30 * 0.35 * (1 / 60);
    const dt = 1 / 60;
    const sx = vel.x * dt, sy = vel.y * dt, sz = vel.z * dt;
    const len = Math.hypot(sx, sy, sz);
    let landed = false;
    if (len > 1e-6) {
      const hit = raycastWorld(colliders, pos.x, pos.y, pos.z, sx / len, sy / len, sz / len, len + rad, { floor: false });
      if (hit) {
        const back = rad * 0.9;
        pos.x = hit.x - (sx / len) * back;
        pos.y = Math.max(hit.y - (sy / len) * back, 0.9);
        pos.z = hit.z - (sz / len) * back;
        landed = true;
      }
    }
    if (!landed) {
      pos.x += vel.x * dt; pos.y += vel.y * dt; pos.z += vel.z * dt;
      if (pos.y <= 0.9) { pos.y = 0.9; landed = true; }
    }
    if (landed) settled = true;
  }
  ok(settled, '撞墙后停下（而不是继续飞）');
  // 墙面在 z = -1.3，球心停在「墙面 - 半径」附近（回退 0.315），也就是贴近但不穿过去
  ok(pos.z > -1.3 - rad * 0.95 && pos.z < -1.3, '停在墙面前侧（z = ' + pos.z.toFixed(3) + '，墙面 -1.300）');
}

console.log(fails === 0 ? '\nPASS 全部通过' : '\nFAIL 共 ' + fails + ' 项不通过');
process.exit(fails === 0 ? 0 : 1);
