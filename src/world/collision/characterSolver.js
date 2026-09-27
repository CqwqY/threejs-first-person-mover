// 室内复杂碰撞 · P4：玩家 AABB 对 trimesh 的解算器（characterSolver）
//
// 玩家形状保持 AABB（半宽 PLAYER_RADIUS、高 PLAYER_HEIGHT），不做胶囊/球。
// 与既有 simple 路径（盒 / 绕 Y 旋转 OBB / 凸包 SAT）完全独立，互不影响。
//
// 解算流程（每帧）：
//   1) 子步进：把本帧位移 Δ = v·dt 切成若干子步，保证单步位移 ≤ TRIMESH_SUBSTEP_MAX_DIST，
//      垂直分量同样被覆盖 —— 这是防「高速下落穿透薄楼板」的关键；
//   2) 每个子步：宽相位取候选三角形（trimesh.query）→ 逐个 SAT（盒 3 轴 + 三角面法线 + 9 根叉乘轴）；
//   3) 内部边缘过滤：共面三角形之间的接缝产生的「边轴/盒轴」伪接触被替换为面法线解析（或直接忽略），
//      贴墙走、走大合并地面时不会被绊住或被弹开；
//   4) 逐轮去穿透取最有价值的接触解析：可站立面（法线竖直分量达 SLOPE_MAX_NORMAL_Y）走「竖直吸附」，
//      天花板挡上升，其余（墙 / 陡面）沿法线推出并把速度去掉法向分量 → 沿墙滑动而不是硬停；
//   5) step-up：水平推进被竖直面挡住时，抬高 TRIMESH_STEP_UP_HEIGHT 内的高度重试，成功即上台阶。

import { Config } from '../../config.js';

const SKIN = 0.02;      // 查询膨胀（米）：让「刚好贴上」的接触也能被检出
const MIN_DEPTH = 1e-4; // 小于该穿透深度视为刚好接触，不再迭代

// 复用的接触结果对象（避免每帧大量临时对象）
const _hit = {
  depth: 0,
  nx: 0, ny: 0, nz: 0,
  plane: false,       // 获胜轴是否为三角面法线
  pdepth: 0,          // 三角面法线方向上的穿透深度（始终计算，供内部边缘过滤使用）
  pnx: 0, pny: 0, pnz: 0, // 朝向玩家一侧的三角面法线
};

// 玩家 AABB（中心 c，半尺寸 h）+ 三角形 的最小平移向量（MTV）。
// 13 根分离轴：3 根盒轴 + 1 根三角面法线 + 9 根 (盒轴 × 三角边) 叉乘轴。
// 返回复用的 _hit；不相交返回 null。
function boxTriMTV(cx, cy, cz, hx, hy, hz, ax, ay, az, bx, by, bz, ex, ey, ez) {
  // 三角面法线
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = ex - ax, vy = ey - ay, vz = ez - az;
  let fnx = uy * vz - uz * vy, fny = uz * vx - ux * vz, fnz = ux * vy - uy * vx;
  const nlen = Math.sqrt(fnx * fnx + fny * fny + fnz * fnz);
  if (!(nlen > 1e-12)) return null; // 退化三角形
  fnx /= nlen; fny /= nlen; fnz /= nlen;

  let bestDepth = Infinity, bnx = 0, bny = 0, bnz = 0, bestPlane = false;
  let planeDepth = 0, pnx = 0, pny = 0, pnz = 0;

  // 单根轴的 SAT 测试：返回 false 表示找到分离轴（肯定不相交）
  const test = (lx, ly, lz, isPlaneAxis) => {
    const len2 = lx * lx + ly * ly + lz * lz;
    if (len2 < 1e-12) return true; // 退化轴（平行边）不参与，跳过
    const inv = 1 / Math.sqrt(len2);
    lx *= inv; ly *= inv; lz *= inv;
    const rBox = hx * Math.abs(lx) + hy * Math.abs(ly) + hz * Math.abs(lz);
    const p0 = ax * lx + ay * ly + az * lz;
    const p1 = bx * lx + by * ly + bz * lz;
    const p2 = ex * lx + ey * ly + ez * lz;
    let tMin = p0, tMax = p0;
    if (p1 < tMin) tMin = p1; if (p1 > tMax) tMax = p1;
    if (p2 < tMin) tMin = p2; if (p2 > tMax) tMax = p2;
    const rTri = (tMax - tMin) * 0.5;
    const tC = (tMax + tMin) * 0.5;
    const d = (cx * lx + cy * ly + cz * lz) - tC;
    const depth = rBox + rTri - Math.abs(d);
    if (depth <= 0) return false; // 分离
    const s = d >= 0 ? 1 : -1;
    if (isPlaneAxis) {
      planeDepth = depth; pnx = lx * s; pny = ly * s; pnz = lz * s;
    }
    if (depth < bestDepth) {
      bestDepth = depth; bnx = lx * s; bny = ly * s; bnz = lz * s; bestPlane = isPlaneAxis;
    }
    return true;
  };

  // 3 根盒轴
  if (!test(1, 0, 0, false)) return null;
  if (!test(0, 1, 0, false)) return null;
  if (!test(0, 0, 1, false)) return null;
  // 三角面法线
  if (!test(fnx, fny, fnz, true)) return null;

  // 9 根叉乘轴（盒轴 × 三角边）：展开写避免临时数组
  const e0x = ux, e0y = uy, e0z = uz;
  const e1x = ex - bx, e1y = ey - by, e1z = ez - bz;
  const e2x = ax - ex, e2y = ay - ey, e2z = az - ez;
  // 盒 X 轴 × e = (0, -e.z, e.y)
  if (!test(0, -e0z, e0y, false)) return null;
  if (!test(0, -e1z, e1y, false)) return null;
  if (!test(0, -e2z, e2y, false)) return null;
  // 盒 Y 轴 × e = (e.z, 0, -e.x)
  if (!test(e0z, 0, -e0x, false)) return null;
  if (!test(e1z, 0, -e1x, false)) return null;
  if (!test(e2z, 0, -e2x, false)) return null;
  // 盒 Z 轴 × e = (-e.y, e.x, 0)
  if (!test(-e0y, e0x, 0, false)) return null;
  if (!test(-e1y, e1x, 0, false)) return null;
  if (!test(-e2y, e2x, 0, false)) return null;

  _hit.depth = bestDepth;
  _hit.nx = bnx; _hit.ny = bny; _hit.nz = bnz;
  _hit.plane = bestPlane;
  _hit.pdepth = planeDepth;
  _hit.pnx = pnx; _hit.pny = pny; _hit.pnz = pnz;
  return _hit;
}

// 复用的候选三角形编号数组
const _cand = [];

// 取当前最深接触并解析（多轮去穿透）。
function resolvePenetration(state, velocity, trimeshes) {
  const R = Config.PLAYER_RADIUS;
  const hh = Config.PLAYER_HEIGHT * 0.5;
  for (let iter = 0; iter < Config.TRIMESH_CONTACT_ITERATIONS; iter++) {
    const cx = state.x, cy = state.y - hh, cz = state.z;
    const minX = cx - R, minY = cy - hh, minZ = cz - R;
    const maxX = cx + R, maxY = cy + hh, maxZ = cz + R;

    let bestDepth = MIN_DEPTH;
    let bnx = 0, bny = 0, bnz = 0;

    for (let mi = 0; mi < trimeshes.length; mi++) {
      const tm = trimeshes[mi];
      tm.query(minX, minY, minZ, maxX, maxY, maxZ, _cand, SKIN);
      const p = tm.positions;
      for (let ci = 0; ci < _cand.length; ci++) {
        const t = _cand[ci];
        const o = t * 9;
        const hit = boxTriMTV(cx, cy, cz, R, hh, R,
          p[o], p[o + 1], p[o + 2], p[o + 3], p[o + 4], p[o + 5], p[o + 6], p[o + 7], p[o + 8]);
        if (!hit) continue;
        let dx, dy, dz, dep;
        if (hit.plane) {
          dx = hit.nx; dy = hit.ny; dz = hit.nz; dep = hit.depth;
        } else if (tm.hasCoplanarEdge[t]) {
          // ---- 内部边缘过滤 ----
          // 获胜轴不是面法线（是盒轴或边轴），而该三角形存在共面邻居 → 这是两块共面三角形接缝处的伪接触。
          // 用面法线穿透代替：共面邻居与该面同向，等价于「把整块平面当一个面」，于是贴墙走/走地面
          // 不会被接缝绊住，也不会被沿面方向的伪推出打停。面法线方向没有穿透则直接丢弃该接触。
          if (hit.pdepth <= MIN_DEPTH) continue;
          dx = hit.pnx; dy = hit.pny; dz = hit.pnz; dep = hit.pdepth;
        } else {
          dx = hit.nx; dy = hit.ny; dz = hit.nz; dep = hit.depth;
        }
        if (dep > bestDepth) {
          bestDepth = dep; bnx = dx; bny = dy; bnz = dz;
        }
      }
    }

    if (bestDepth <= MIN_DEPTH) break;
    applyContact(state, velocity, bnx, bny, bnz, bestDepth);
  }
}

// 应用一个接触：
//   - 可站立面（法线竖直分量 ≥ SLOPE_MAX_NORMAL_Y，含斜面）：只做竖直吸附（与 simple 路径 SLOPE_GRIP=1 等价），
//     水平不回推 → 输入为零时能稳稳停在坡上；同时清掉向下速度并标记着地。
//   - 天花板（法线竖直分量 ≤ -阈值）：沿法线（朝下）推出并挡掉向上速度 → 跳跃/上升不会穿顶。
//   - 墙 / 陡面：沿法线推出，并把速度的法向分量去掉 → 沿墙滑动而不是硬停。
function applyContact(state, velocity, nx, ny, nz, depth) {
  const slope = Config.SLOPE_MAX_NORMAL_Y;
  if (ny >= slope) {
    state.y += depth / ny;
    if (velocity.y < 0) velocity.y = 0;
    state.onGround = true;
    return;
  }
  if (ny <= -slope) {
    state.x += nx * depth; state.y += ny * depth; state.z += nz * depth;
    if (velocity.y > 0) velocity.y = 0;
    return;
  }
  state.x += nx * depth; state.y += ny * depth; state.z += nz * depth;
  const vn = velocity.x * nx + velocity.y * ny + velocity.z * nz;
  if (vn < 0) {
    velocity.x -= nx * vn;
    velocity.y -= ny * vn;
    velocity.z -= nz * vn;
  }
}

// 单个子步：推进位移 → 去穿透 → 水平被挡时尝试 step-up。
function substep(state, velocity, trimeshes, mx, my, mz) {
  const px = state.x, py = state.y, pz = state.z;

  state.x += mx; state.y += my; state.z += mz;
  resolvePenetration(state, velocity, trimeshes);

  const wantH = Math.sqrt(mx * mx + mz * mz);
  if (wantH <= 1e-6) return; // 纯垂直位移：阶梯逻辑无关
  const gotH = Math.sqrt((state.x - px) * (state.x - px) + (state.z - pz) * (state.z - pz));
  if (gotH >= wantH * 0.5) return; // 水平推进没被明显挡住，正常行走，不触发 step-up

  // ---- step-up：抬脚到 STEP_UP_HEIGHT 高度后重走，能走通才算上台阶 ----
  const bx = state.x, by = state.y, bz = state.z;
  const bvx = velocity.x, bvy = velocity.y, bvz = velocity.z;
  state.x = px; state.y = py + Config.TRIMESH_STEP_UP_HEIGHT; state.z = pz;
  state.x += mx; state.z += mz;
  resolvePenetration(state, velocity, trimeshes);
  const gotH2 = Math.sqrt((state.x - px) * (state.x - px) + (state.z - pz) * (state.z - pz));
  const climbed = state.y - py;
  if (gotH2 > gotH + 1e-3 && climbed <= Config.TRIMESH_STEP_UP_HEIGHT + 1e-4) {
    return; // 抬脚成功：保留新位置（后续子步的重力会把玩家落到台阶面上）
  }
  // 抬脚失败：回退到被挡住的结果，避免凭空上升
  state.x = bx; state.y = by; state.z = bz;
  velocity.x = bvx; velocity.y = bvy; velocity.z = bvz;
}

// 主入口：把本帧位移交给子步进解算（state 直接被改写；velocity 的法向分量会被消掉）。
// trimeshes：complex 模式烘焙出的 trimesh 碰撞体数组。
export function resolveMove(state, velocity, trimeshes, dt) {
  if (!trimeshes || trimeshes.length === 0) return;
  const dx = velocity.x * dt, dy = velocity.y * dt, dz = velocity.z * dt;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(dist > 1e-9)) return;

  // 子步长自适应：step = min(单步最大位移, |Δ| / 步数基准)。
  // 保证「任何速度下单步位移都不超过 TRIMESH_SUBSTEP_MAX_DIST」，
  // 因此下落再快也是一步步贴过去，不会一帧跨过薄楼板（厚度可低至 0.12m）。
  const stepDist = Math.min(Config.TRIMESH_SUBSTEP_MAX_DIST, dist / Config.TRIMESH_SUBSTEP_MAX_COUNT);
  let n = Math.ceil(dist / stepDist);
  if (!(n >= 1)) n = 1;
  if (n > Config.TRIMESH_SUBSTEP_HARD_MAX) n = Config.TRIMESH_SUBSTEP_HARD_MAX;
  const sx = dx / n, sy = dy / n, sz = dz / n;
  for (let i = 0; i < n; i++) substep(state, velocity, trimeshes, sx, sy, sz);
}
