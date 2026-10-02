// 室内复杂碰撞的性能改动自检（全部用合成的小网格，三角形数以「个」计，毫秒级跑完）。
//
// 覆盖这几件事：
//   1) 子步数：新的 n = ceil(|Δ| / MAX_DIST) 是否守住「单步位移 ≤ MAX_DIST」这一防穿透不变式；
//   2) 防穿透：薄楼板（0.12m）在高速下落 + 大 dt 下是否仍不穿；
//   3) 逐建筑 AABB 早淘汰：远处建筑必须一次 query 都不进，且解算结果与「不做早淘汰」逐位一致；
//   4) SAT 复用烘焙法线：从源码里提出**线上真正会跑的那份 boxTriMTV**，与改动前的实现随机对拍；
//   5) 稳定 key：同一 url + 同一变换只烘一次；
//   6) 静态网格合并：并成一组的判定、世界空间（顶点 + 法线）逐个守恒、镜像场景的绕向补偿；
//   7) 绕向补偿对碰撞无害：整块几何翻绕向后解算轨迹逐位不变；
//   最后是静态接线断言（防改动被误删）。
//
// 注意「镜像」那一节不是凑数的边角情况：three 的渲染器按 matrixWorld.determinant() 的正负决定绕向怎么读，
// 合并会把镜像烘进几何体（新网格行列式变回正），不显式翻回绕向就会看到内壁。这类 bug 只比「顶点多重集」
// 是**查不出来**的（集合完全一样），必须仿真渲染器的剔除判定逐三角形比对。
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { Config } from './src/config.js';
import { bakeTriMesh, bakeTriMeshAsync } from './src/world/collision/trimesh.js';
import { resolveMove } from './src/world/collision/characterSolver.js';
import { PlayerPhysics } from './src/player/PlayerPhysics.js';

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log('  FAIL ' + msg); } else { console.log('  ok   ' + msg); } };
const eq = (a, b, msg) => ok(a === b, msg + '（实际 ' + JSON.stringify(a) + '，期望 ' + JSON.stringify(b) + '）');

// 数值 → 定点字符串。必须先量化再抹掉「符号零」：
// 合并会把「世界变换」拆成「相对变换 + 外层变换」两次矩阵乘法，浮点结合律会让结果差 ~1e-7，
// 于是本来恰好为 0 的分量可能变成 -1e-9，toFixed(3) 后写成 "-0.000" —— 看着像差异其实都是 0。
// 注意不能只判 `x === 0`：-1e-9 不是 0，但量化到 3 位后就是 0。
function fixed(x, digits) {
  const p = Math.pow(10, digits);
  const r = Math.round(x * p) / p;
  return (r === 0 ? 0 : r).toFixed(digits);
}
const f3 = (x) => fixed(x, 3);
const f4 = (x) => fixed(x, 4);

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

// 从源码里切出 function NAME(...) 的完整文本（按花括号配平，能正确处理嵌套）
function sliceFunction(src, name) {
  const at = src.indexOf('function ' + name + '(');
  if (at < 0) throw new Error('找不到函数 ' + name);
  let i = src.indexOf('{', at);
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(at, i);
}

// 造一个「只在被查询时计数」的 trimesh 桩，用于精确统计子步数
function makeCountStub(box) {
  const stub = {
    type: 'trimesh', triCount: 1, positions: new Float32Array(9), normals: new Float32Array(3),
    minX: box.minX, maxX: box.maxX, minY: box.minY, maxY: box.maxY, minZ: box.minZ, maxZ: box.maxZ,
    calls: 0,
    query(minX, minY, minZ, maxX, maxY, maxZ, out) { this.calls++; out.length = 0; return 0; },
  };
  return stub;
}

// 立方体块（12 三角形）→ 真实 trimesh：用来验防穿透
function slabTrimesh(w, h, d, y) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial());
  mesh.position.set(0, y, 0);
  return bakeTriMesh(mesh, { force: true });
}

// PlayerPhysics 需要的输入桩（无输入，只靠重力下落）
function idleInput() {
  return {
    forwarded: () => false, backwarded: () => false, strafeLeft: () => false, strafeRight: () => false,
    sprinting: () => false, isDown: () => false, consumeJump: () => false,
    joyX: 0, joyY: 0, joyMagnitude: () => 0,
  };
}

// 模拟一帧「先加重力、再解算」——与 PlayerPhysics 的顺序一致，但只走 trimesh 那条路
function fallFrame(state, velocity, trimeshes, dt) {
  velocity.y += Config.GRAVITY * dt;
  resolveMove(state, velocity, trimeshes, dt);
}

// ---------------------------------------------------------------------------
console.log('== 1. 子步数：n = ceil(|Δ| / MAX_DIST)，不再是「至少 24 步」 ==');
{
  // 包围盒取得极大：本节的桩只用来**数子步**，不能让它因为 AABB 早淘汰而少算（那是第 3 节的事）
  const box = { minX: -1e6, maxX: 1e6, minY: -1e6, maxY: 1e6, minZ: -1e6, maxZ: 1e6 };
  const MAXD = Config.TRIMESH_SUBSTEP_MAX_DIST;
  const HARD = Config.TRIMESH_SUBSTEP_HARD_MAX;
  const cases = [
    { name: '走路 6 m/s @60fps', v: { x: 6, y: 0, z: 0 }, dt: 1 / 60 },
    { name: '冲刺 9.6 + 下坠 20 m/s @60fps', v: { x: 9.6, y: -20, z: 0 }, dt: 1 / 60 },
    { name: '自由落体 27 m/s @20fps', v: { x: 0, y: -27, z: 0 }, dt: 1 / 20 },
    { name: '极速 500 m/s @0.1s（触发安全上限）', v: { x: 0, y: -500, z: 0 }, dt: 0.1 },
  ];
  let capped = 0;
  for (const c of cases) {
    const stub = makeCountStub(box);
    const state = { x: 0, y: 0, z: 0, onGround: true };
    const vel = { x: c.v.x, y: c.v.y, z: c.v.z };
    const dist = Math.hypot(vel.x * c.dt, vel.y * c.dt, vel.z * c.dt);
    let want = Math.ceil(dist / MAXD);
    if (!(want >= 1)) want = 1;
    if (want > HARD) { want = HARD; capped++; }
    resolveMove(state, vel, [stub], c.dt);
    eq(stub.calls, want, c.name + ' → ' + stub.calls + ' 子步（|Δ|=' + dist.toFixed(3) + 'm）');
    const perStep = dist / stub.calls;
    if (stub.calls < HARD) {
      ok(perStep <= MAXD + 1e-9, c.name + ' 单步位移 ' + perStep.toFixed(4) + 'm ≤ ' + MAXD + 'm（防穿透不变式）');
    } else {
      // 触及安全上限时单步会超过 MAX_DIST —— 这是刻意的取舍：异常速度下宁可让步长，
      // 也不能让步数无限膨胀把一帧拖死。改动前后在这一点上行为完全相同。
      ok(perStep > MAXD, c.name + ' 触及上限 ' + HARD + ' 步，单步 ' + perStep.toFixed(2) + 'm（与改动前一致）');
    }
  }
  ok(capped === 1, '异常速度仍被 TRIMESH_SUBSTEP_HARD_MAX=' + HARD + ' 兜住');

  // 四档场景的子步数合计：直观看出省了多少
  let oldTotal = 0, newTotal = 0;
  for (const c of cases) {
    const dist = Math.hypot(c.v.x * c.dt, c.v.y * c.dt, c.v.z * c.dt);
    const clamp = (n) => (!(n >= 1) ? 1 : (n > HARD ? HARD : n));
    oldTotal += clamp(Math.ceil(dist / Math.min(MAXD, dist / 24)));
    newTotal += clamp(Math.ceil(dist / MAXD));
  }
  console.log('   （四档场景的子步数合计：改动前 ' + oldTotal + ' → 改动后 ' + newTotal + '）');

  // 对照：旧公式在「走路」这一档固定跑 24 子步
  const walkDist = Math.hypot(6 / 60, 0, 0);
  const oldStep = Math.min(MAXD, walkDist / 24);
  eq(Math.ceil(walkDist / oldStep), 24, '旧公式（min(MAX_DIST, |Δ|/24)）在走路时固定 24 子步 —— 本次去掉的就是它');
  eq(Math.ceil(walkDist / MAXD), 1, '新公式在走路时只要 1 子步 → 室内碰撞开销降到 1/24');
  ok(!/TRIMESH_SUBSTEP_MAX_COUNT/.test(readFileSync('./src/config.js', 'utf8')), 'config.js 里已移除 TRIMESH_SUBSTEP_MAX_COUNT');
}

// ---------------------------------------------------------------------------
console.log('\n== 2. 防穿透：薄楼板（0.12m）+ 高速下落 + 大 dt ==');
{
  // 楼板：厚 0.12m，顶面 y=1.0、底面 y=0.88，10×10
  const tm = slabTrimesh(10, 0.12, 10, 0.94);
  ok(tm && tm.triCount === 12, '合成楼板 trimesh 烘焙出 12 个三角形（实际 ' + (tm && tm.triCount) + '）');

  const phys = new PlayerPhysics();
  const input = idleInput();
  const cases = [
    { h: 12, dt: 1 / 60 }, { h: 20, dt: 1 / 30 }, { h: 30, dt: 1 / 20 }, { h: 60, dt: 0.05 },
  ];
  let worstFeet = Infinity;
  for (const c of cases) {
    const state = { x: 0, y: c.h, z: 0, yaw: 0, pitch: 0, onGround: false };
    let minFeet = Infinity;
    for (let i = 0; i < 240; i++) {
      phys.update(c.dt, input, 0, state, [tm]);
      minFeet = Math.min(minFeet, state.y - Config.PLAYER_HEIGHT);
      if (state.onGround && i > 30) break;
    }
    const feet = state.y - Config.PLAYER_HEIGHT;
    worstFeet = Math.min(worstFeet, minFeet);
    ok(feet > 1.0 - 1e-3 && feet < 1.0 + 0.05,
      '从 ' + c.h + 'm 高、dt=' + c.dt.toFixed(4) + ' 落下 → 停在楼板顶面（脚底 y=' + feet.toFixed(4) + '，楼板顶 1.0）');
  }
  ok(worstFeet > 0.88, '全程脚底从未低于楼板底面 0.88m（最小值 ' + worstFeet.toFixed(4) + ' → 没有穿板）');
}

// ---------------------------------------------------------------------------
console.log('\n== 3. 逐建筑 AABB 早淘汰 ==');
{
  // A 栋在原点附近，B 栋在 200m 外；两者都是「只计数」的桩
  const A = makeCountStub({ minX: -10, maxX: 10, minY: 0, maxY: 8, minZ: -10, maxZ: 10 });
  const B = makeCountStub({ minX: 190, maxX: 210, minY: 0, maxY: 8, minZ: -10, maxZ: 10 });

  // ① 玩家站在 A 栋里：B 栋一次 query 都不该进
  const v1 = { x: 6, y: 0, z: 0 };
  const s1 = { x: 0, y: 4, z: 0, onGround: true };
  resolveMove(s1, v1, [A, B], 1 / 60);
  ok(A.calls > 0, 'A 栋在附近 → 正常查询（' + A.calls + ' 次）');
  eq(B.calls, 0, 'B 栋在 200m 外 → 一次 query 都不进（此前每帧白跑 n 子步 × 每栋一次）');

  // ② 结果必须与「只有 A」逐位一致
  const v2 = { x: 6, y: 0, z: 0 };
  const s2 = { x: 0, y: 4, z: 0, onGround: true };
  resolveMove(s2, v2, [A], 1 / 60);
  ok(s1.x === s2.x && s1.y === s2.y && s1.z === s2.z,
    '带早淘汰与不带早淘汰的解算结果完全一致（' + s1.x + ',' + s1.y + ',' + s1.z + '）');

  // ③ 反向：玩家紧贴 B 栋边界（只差半个 SKIN）时不能被误杀
  const B2 = makeCountStub({ minX: 10, maxX: 30, minY: 0, maxY: 8, minZ: -10, maxZ: 10 });
  const s3 = { x: 10 - Config.PLAYER_RADIUS - 0.01, y: 4, z: 0, onGround: true };
  resolveMove(s3, { x: 0.6, y: 0, z: 0 }, [B2], 1 / 60);
  ok(B2.calls > 0, '玩家盒子与建筑 AABB 仅差 0.01m 时仍会查询（SKIN 膨胀没漏判）');
}

// ---------------------------------------------------------------------------
console.log('\n== 4. SAT 复用烘焙法线：与改动前的实现随机对拍 ==');
{
  const src = readFileSync('./src/world/collision/characterSolver.js', 'utf8');
  // 线上真正会跑的那份（新实现），连同它依赖的复用缓冲一起提出来
  const newSrc = sliceFunction(src, 'boxTriMTV');
  const newFactory = new Function('_hit', 'return ' + newSrc + ';');
  const hitNew = { depth: 0, nx: 0, ny: 0, nz: 0, plane: false, pdepth: 0, pnx: 0, pny: 0, pnz: 0 };
  const boxTriMTVNew = newFactory(hitNew);

  // 改动前的实现（法线在函数内部现算）——作为参考
  function boxTriMTVRef(cx, cy, cz, hx, hy, hz, ax, ay, az, bx, by, bz, ex, ey, ez) {
    const hit = {};
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = ex - ax, vy = ey - ay, vz = ez - az;
    let fnx = uy * vz - uz * vy, fny = uz * vx - ux * vz, fnz = ux * vy - uy * vx;
    const nlen = Math.sqrt(fnx * fnx + fny * fny + fnz * fnz);
    if (!(nlen > 1e-12)) return null;
    fnx /= nlen; fny /= nlen; fnz /= nlen;
    let bestDepth = Infinity, bnx = 0, bny = 0, bnz = 0, bestPlane = false;
    let planeDepth = 0, pnx = 0, pny = 0, pnz = 0;
    const test = (lx, ly, lz, isPlaneAxis) => {
      const len2 = lx * lx + ly * ly + lz * lz;
      if (len2 < 1e-12) return true;
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
      if (depth <= 0) return false;
      const s = d >= 0 ? 1 : -1;
      if (isPlaneAxis) { planeDepth = depth; pnx = lx * s; pny = ly * s; pnz = lz * s; }
      if (depth < bestDepth) { bestDepth = depth; bnx = lx * s; bny = ly * s; bnz = lz * s; bestPlane = isPlaneAxis; }
      return true;
    };
    if (!test(1, 0, 0, false)) return null;
    if (!test(0, 1, 0, false)) return null;
    if (!test(0, 0, 1, false)) return null;
    if (!test(fnx, fny, fnz, true)) return null;
    const e0x = ux, e0y = uy, e0z = uz;
    const e1x = ex - bx, e1y = ey - by, e1z = ez - bz;
    const e2x = ax - ex, e2y = ay - ey, e2z = az - ez;
    if (!test(0, -e0z, e0y, false)) return null;
    if (!test(0, -e1z, e1y, false)) return null;
    if (!test(0, -e2z, e2y, false)) return null;
    if (!test(e0z, 0, -e0x, false)) return null;
    if (!test(e1z, 0, -e1x, false)) return null;
    if (!test(e2z, 0, -e2x, false)) return null;
    if (!test(-e0y, e0x, 0, false)) return null;
    if (!test(-e1y, e1x, 0, false)) return null;
    if (!test(-e2y, e2x, 0, false)) return null;
    hit.depth = bestDepth; hit.nx = bnx; hit.ny = bny; hit.nz = bnz;
    hit.plane = bestPlane; hit.pdepth = planeDepth; hit.pnx = pnx; hit.pny = pny; hit.pnz = pnz;
    return hit;
  }

  // 确定性伪随机（mulberry32），保证可复现
  let seed = 20261002;
  const rnd = () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const R = (a, b) => a + rnd() * (b - a);

  const hitOld = {};
  let cmp = 0, bothNull = 0, degenerate = 0, maxErr = 0;
  for (let i = 0; i < 4000; i++) {
    const cx = R(-3, 3), cy = R(-3, 3), cz = R(-3, 3);
    const hx = R(0.2, 1), hy = R(0.2, 1), hz = R(0.2, 1);
    let ax = R(-2, 2), ay = R(-2, 2), az = R(-2, 2);
    let bx = R(-2, 2), by = R(-2, 2), bz = R(-2, 2);
    let ex = R(-2, 2), ey = R(-2, 2), ez = R(-2, 2);
    if (i % 97 === 0) { bx = ax; by = ay; bz = az; degenerate++; } // 掺入退化三角形

    const ref = boxTriMTVRef(cx, cy, cz, hx, hy, hz, ax, ay, az, bx, by, bz, ex, ey, ez);
    // 用「烘焙阶段同样的算法」算单位法线，喂给新实现（这正是 tm.normals 里的值）
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = ex - ax, vy = ey - ay, vz = ez - az;
    let fnx = uy * vz - uz * vy, fny = uz * vx - ux * vz, fnz = ux * vy - uy * vx;
    const len = Math.sqrt(fnx * fnx + fny * fny + fnz * fnz) || 1;
    fnx /= len; fny /= len; fnz /= len;
    const got = boxTriMTVNew(cx, cy, cz, hx, hy, hz, ax, ay, az, bx, by, bz, ex, ey, ez, fnx, fny, fnz);
    const gotObj = got ? { ...got } : null;

    if (!ref !== !gotObj) { fails++; console.log('  FAIL 命中判定不一致 @case ' + i); break; }
    if (!ref) { bothNull++; continue; }
    const err = Math.max(
      Math.abs(ref.depth - gotObj.depth), Math.abs(ref.nx - gotObj.nx),
      Math.abs(ref.ny - gotObj.ny), Math.abs(ref.nz - gotObj.nz),
      Math.abs(ref.pdepth - gotObj.pdepth), Math.abs(ref.pnx - gotObj.pnx),
      Math.abs(ref.pny - gotObj.pny), Math.abs(ref.pnz - gotObj.pnz)
    );
    if (ref.plane !== gotObj.plane) { fails++; console.log('  FAIL plane 标志不一致 @case ' + i); break; }
    if (err > maxErr) maxErr = err;
    cmp++;
  }
  eq(cmp + bothNull, 4000, '4000 组随机「盒 × 三角形」全部逐一比对（' + cmp + ' 组相交、' + bothNull + ' 组分离）');
  ok(cmp > 100, '样本里有足够多的相交组合（' + cmp + ' 组）才能说明问题');
  ok(maxErr < 1e-9, '复用烘焙法线后，MTV（深度/方向/面法线）与改动前逐位一致（最大偏差 ' + maxErr.toExponential(2) + '）');
  ok(degenerate > 0, '样本里含 ' + degenerate + ' 组退化三角形（两条实现都返回 null）');

  // 非单位法线兜底：故意喂一个未归一化的向量，结果应仍与参考一致
  const raw = { x: 3, y: 0, z: 0 };
  const g2 = boxTriMTVNew(0, 0, 0, 1, 1, 1, -1, -1, 0, 1, -1, 0, 0, 1, 2, raw.x, raw.y, raw.z);
  const r2 = boxTriMTVRef(0, 0, 0, 1, 1, 1, -1, -1, 0, 1, -1, 0, 0, 1, 2);
  ok(!g2 === !r2 && (!r2 || Math.abs(g2.depth - r2.depth) < 1e-9), '喂未归一化法线时兜底归一化，结果仍一致');
  hitOld.dummy = 1; // （参考实现用局部 hit，这里保留变量避免 lint 噪声）
}

// ---------------------------------------------------------------------------
console.log('\n== 5. 稳定 key：同一 url + 同一变换只烘一次 ==');
{
  const mk = (y) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial());
    m.position.set(0, y, 0);
    return m;
  };
  const a = mk(0), b = mk(0), c = mk(5);
  const pa = bakeTriMeshAsync(a, { key: 'url|x|0|0|0|1|1|1' });
  const pb = bakeTriMeshAsync(b, { key: 'url|x|0|0|0|1|1|1' }); // 同一 key：应共享
  const [ra, rb] = await Promise.all([pa, pb]);
  ok(ra && rb && ra === rb, '同一 key 的两次烘焙返回同一个 collider（只算一次）');
  ok(bakeTriMesh(a, { key: 'whatever' }) === ra, '同一 object3D 命中 WeakMap 缓存');
  ok(bakeTriMesh(mk(0), { key: 'url|x|0|0|0|1|1|1' }) === ra, '不同 object3D、同 key → 直接复用缓存（不再重烘）');
  const rc = await bakeTriMeshAsync(c, { key: 'url|x|5|0|0|1|1|1' });
  ok(rc !== ra, '变换不同 → key 不同 → 各自烘焙（换位置不会被错误复用）');
}

// ---------------------------------------------------------------------------
console.log('\n== 6. mergeStaticMeshes：真实合并 ==');
{
  let mergeStaticMeshes = null;
  let mergeErr = '';
  try {
    ({ mergeStaticMeshes } = await import('./src/world/EditorBuildings.js'));
  } catch (e) {
    mergeErr = e.message;
  }
  if (!mergeStaticMeshes) {
    ok(false, '无法 import EditorBuildings（' + mergeErr + '）');
  } else {
    // 造一个「导出器风格」的模型：40 个子网格、共享材质、属性布局一致
    const root = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x8899aa });
    const totalTris = () => {
      let n = 0;
      root.traverse((o) => { if (o.isMesh) n += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; });
      return n;
    };
    for (let i = 0; i < 40; i++) {
      const g = new THREE.BoxGeometry(0.5, 0.5, 0.5);
      const m = new THREE.Mesh(g, mat);
      m.position.set((i % 8) * 1.5 - 6, Math.floor(i / 8) * 1.5 - 3, 0.25);
      m.rotation.y = i * 0.1;
      root.add(m);
    }
    root.updateMatrixWorld(true);
    const boxBefore = new THREE.Box3().setFromObject(root, true);
    const trisBefore = totalTris();
    const st = mergeStaticMeshes(root);
    const boxAfter = new THREE.Box3().setFromObject(root, true);
    const trisAfter = totalTris();
    eq(st.before, 40, '合并前 40 个子网格');
    ok(st.after <= 3, '合并后只剩 ' + st.after + ' 个网格（draw call 从 40 降到 ' + st.after + '）');
    eq(trisAfter, trisBefore, '三角形总数不变（' + trisBefore + '）');
    ok(boxBefore.min.distanceTo(boxAfter.min) < 1e-5 && boxBefore.max.distanceTo(boxAfter.max) < 1e-5,
      '世界包围盒不变（合并没有挪动几何）');

    // 布局不同的子网格必须留在各自组里，且合并失败要能优雅退化
    const root2 = new THREE.Group();
    const matA = new THREE.MeshStandardMaterial({ color: 0xff0000 });
    const matB = new THREE.MeshStandardMaterial({ color: 0x00ff00 });
    for (let i = 0; i < 6; i++) root2.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), matA));
    for (let i = 0; i < 6; i++) root2.add(new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 6), matB));
    root2.updateMatrixWorld(true);
    const st2 = mergeStaticMeshes(root2);
    eq(st2.after, 2, '两组「材质外观不同」的网格各自合并成 1 个 → 共 2 个');
  }
}

// ---------------------------------------------------------------------------
console.log('\n== 6b. mergeStaticMeshes：世界空间三角形必须逐个守恒 ==');
{
  const { mergeStaticMeshes } = await import('./src/world/EditorBuildings.js');
  const v = new THREE.Vector3();

  // 把每个三角形在世界空间下的三个顶点 + 世界空间顶点法线「排序后」拼成字符串，再整体排序
  // —— 得到与遍历顺序无关的（顶点 + 法线）多重集。顶点守恒只能证明位置没错，
  // 把法线一并纳入才能证明「非均匀缩放下法线矩阵也没算错」（法线错了就会一片黑/一面反光）。
  // 关键：世界空间法线必须用「逆转置矩阵」（normalMatrix）而不是 transformDirection。
  // transformDirection 是「3×3 直接乘法线 + 归一化」，只在均匀缩放/纯旋转下正确；
  // 一遇到非均匀缩放它算的就不是法线（会把本来同向的两个法线算成不同值），
  // 而 Geometry.applyMatrix4 内部用的正是正确的 normalMatrix —— 两边用不同算法比对必然假报警。
  const _nmat = new THREE.Matrix3();
  function worldTriSet(root) {
    root.updateMatrixWorld(true);
    const out = [];
    root.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry, p = g.attributes.position, idx = g.index, nAttr = g.attributes.normal;
      const n = idx ? idx.count : p.count;
      if (nAttr) _nmat.getNormalMatrix(o.matrixWorld);
      for (let i = 0; i + 2 < n; i += 3) {
        const tri = [];
        for (let k = 0; k < 3; k++) {
          const j = idx ? idx.getX(i + k) : i + k;
          v.fromBufferAttribute(p, j).applyMatrix4(o.matrixWorld);
          let s = f3(v.x) + ',' + f3(v.y) + ',' + f3(v.z);
          if (nAttr) {
            const nn = new THREE.Vector3().fromBufferAttribute(nAttr, j).applyMatrix3(_nmat).normalize();
            s += '@' + f3(nn.x) + ',' + f3(nn.y) + ',' + f3(nn.z);
          }
          tri.push(s);
        }
        out.push(tri.sort().join(' | '));
      }
    });
    return out.sort();
  }

  // 真实的复杂情形：嵌套 Group + 旋转 + 非均匀缩放 + 一个被缩放的外层容器
  const model = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x778899 });
  const inner = new THREE.Group();
  inner.position.set(1.5, 0.5, -2);
  inner.rotation.set(0.3, 0.9, -0.2);
  inner.scale.set(1.2, 0.7, 1.8); // 非均匀缩放：法线/顶点的变换最容易在这里出错
  model.add(inner);
  for (let i = 0; i < 12; i++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.9, 0.6), mat);
    m.position.set((i % 4) * 0.7, Math.floor(i / 4) * 0.8, 0.3);
    m.rotation.set(i * 0.05, i * 0.11, i * 0.07);
    m.scale.set(1 + i * 0.01, 1, 1 - i * 0.005);
    inner.add(m);
  }
  // 一个索引形式不同的网格（非索引）：不能与索引网格并到一起
  const nonIndexed = new THREE.BufferGeometry();
  nonIndexed.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0, 1, 0, 0, 0, 1, 0,
    0, 0, 0, 0, 1, 0, 0, 0, 1,
  ], 3));
  const niMesh = new THREE.Mesh(nonIndexed, mat);
  niMesh.position.set(4, 0, 0);
  inner.add(niMesh);
  // 一个材质外观不同的网格：不能被并进同一组
  const otherMat = new THREE.MeshStandardMaterial({ color: 0xaa3322, roughness: 0.4 });
  const otherMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), otherMat);
  otherMesh.position.set(-3, 1, 0);
  inner.add(otherMesh);
  // 骨骼网格：必须原样保留
  const skinMesh = new THREE.SkinnedMesh(new THREE.BoxGeometry(1, 1, 1), mat);
  skinMesh.position.set(0, 3, 0);
  inner.add(skinMesh);

  // 外层再套一个非均匀缩放的 holder，模拟 EditorBuildings 里的行为
  const holder = new THREE.Group();
  holder.scale.set(3.5, 1.4, 2.2);
  holder.rotation.y = 0.6;
  holder.add(model);

  const before = worldTriSet(holder);
  const st = mergeStaticMeshes(model);
  const after = worldTriSet(holder);

  eq(after.length, before.length, '三角形数量不变（' + before.length + ' 个）');
  let same = before.length === after.length;
  let firstDiff = '';
  for (let i = 0; same && i < before.length; i++) if (before[i] !== after[i]) { same = false; firstDiff = '\n        前 ' + before[i] + '\n        后 ' + after[i]; }
  ok(same, '合并前后「世界空间（顶点 + 法线）多重集」完全一致（嵌套旋转 + 非均匀缩放 + 外层缩放全部逐顶点守恒）' + firstDiff);

  const meshCount = (() => { let n = 0; model.traverse((o) => { if (o.isMesh) n++; }); return n; })();
  ok(st.after < st.before, '网格数确实下降：' + st.before + ' → ' + st.after);
  ok(meshCount >= 3, '索引/非索引、不同材质、骨骼网格各自保留 → 合并后仍有 ' + meshCount + ' 个网格（没有硬塞到一起）');

  // —— 镜像（负缩放）子场景 ——
  // 导出模型里的对称结构常被写成 scale.x = -1。three 的渲染器按「网格自身矩阵行列式的正负」
  // 决定绕向怎么读（WebGLRenderer: frontFaceCW = matrixWorld.determinant() < 0）。
  // 合并会把镜像烘进几何体、让新网格行列式变回正 —— 若不同时把绕向翻回来，这批三角形会被
  // 当背面剔除（模型上出现内壁）。而且只比「顶点+法线多重集」是**看不出来**的（集合完全一样），
  // 所以这里直接仿真渲染器的判定：是否渲染 = (几何法线指向相机) XOR (det < 0)，逐三角形比对。
  const CAM = new THREE.Vector3(6, 5, 9);
  function renderDecision(root) {
    root.updateMatrixWorld(true);
    const map = new Map();
    const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), cen = new THREE.Vector3();
    root.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry, p = g.attributes.position, idx = g.index;
      const n = idx ? idx.count : p.count;
      const detNeg = o.matrixWorld.determinant() < 0;
      for (let i = 0; i + 2 < n; i += 3) {
        const js = [0, 1, 2].map((k) => (idx ? idx.getX(i + k) : i + k));
        A.fromBufferAttribute(p, js[0]).applyMatrix4(o.matrixWorld);
        B.fromBufferAttribute(p, js[1]).applyMatrix4(o.matrixWorld);
        C.fromBufferAttribute(p, js[2]).applyMatrix4(o.matrixWorld);
        const geo = B.clone().sub(A).cross(C.clone().sub(A));
        cen.copy(A).add(B).add(C).multiplyScalar(1 / 3);
        const towardCam = geo.dot(CAM.clone().sub(cen)) > 0;
        const key = [A, B, C].map((v) => f4(v.x) + ',' + f4(v.y) + ',' + f4(v.z)).sort().join('|');
        map.set(key, towardCam !== detNeg);
      }
    });
    return map;
  }
  // 镜像组 + 普通组**共用同一几何与材质** → 会落进同一个合并分组，
  // 一次合并里同时含「要翻绕向」和「不要翻」两类三角形，是这条逻辑最难的情况。
  function mirrorScene() {
    const m = new THREE.Group();
    const shared = new THREE.MeshStandardMaterial({ color: 0x00aa88, side: THREE.FrontSide });
    const mirror = new THREE.Group();
    mirror.scale.set(-1, 1, 1);
    mirror.rotation.y = 0.4;
    m.add(mirror);
    const plain = new THREE.Group();
    plain.position.x = 3.4;
    m.add(plain);
    for (let i = 0; i < 10; i++) {
      const q = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.1, 0.3), shared);
      q.position.set(i * 0.6 - 1.5, i * 0.15, 0.25 * i);
      q.rotation.z = i * 0.13;
      mirror.add(q);
      if (i < 6) { // 普通（正行列式）网格，与镜像网格同组
        const p2 = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.1, 0.3), shared);
        p2.position.set(i * 0.55, i * 0.2, -0.4 * i);
        p2.rotation.y = i * 0.17;
        plain.add(p2);
      }
    }
    const h = new THREE.Group();
    h.scale.set(1.3, 2.1, 0.8); // 外层再套一个非均匀缩放
    h.add(m);
    return { holder: h, root: m };
  }
  {
    const { holder, root } = mirrorScene();
    const before = worldTriSet(holder);
    const decBefore = renderDecision(holder);
    const st2 = mergeStaticMeshes(root);
    const after = worldTriSet(holder);
    const decAfter = renderDecision(holder);
    eq(after.length, before.length, '镜像场景：三角形数量不变（' + before.length + ' 个）');
    let same2 = before.length === after.length;
    let d2 = '';
    for (let i = 0; same2 && i < before.length; i++) if (before[i] !== after[i]) { same2 = false; d2 = '\n        前 ' + before[i] + '\n        后 ' + after[i]; }
    ok(same2, '镜像（scale.x = -1）+ 旋转 + 外层非均匀缩放：「世界空间（顶点 + 法线）多重集」完全一致' + d2);

    ok(st2.after === 1, '镜像与普通网格共用几何/材质 → 确实并进了同一组（' + st2.before + ' → ' + st2.after + '）');
    eq(decAfter.size, decBefore.size, '镜像场景：三角形身份数量不变（' + decBefore.size + ' 个）');
    let cullDiff = 0, cullSample = '';
    for (const [k, v] of decBefore) {
      const w = decAfter.get(k);
      if (w === undefined || w !== v) { cullDiff++; if (!cullSample) cullSample = k + '（' + v + ' → ' + w + '）'; }
    }
    ok(cullDiff === 0, '镜像场景：每个三角形「渲染 / 被背面剔除」的判定逐个不变（负行列式子网格的绕向已翻回）'
      + (cullDiff ? '（' + cullDiff + ' 个判反，例：' + cullSample + '）' : ''));
  }
}

// ---------------------------------------------------------------------------
// 镜像补偿（flipTriangleWinding）会改三角形绕向，而 trimesh 的面法线是由绕向算出来的。
// 所以必须证明「整块几何翻绕向之后，碰撞解算逐位不变」——否则镜像建筑（正是 scale.x = -1 那些部位）
// 会出现「被楼板弹开 / 贴墙卡住」之类的怪事。
// 论证要点（配套实证）：SAT 里每根轴的方向都由 `s = d >= 0 ? 1 : -1` 决定（朝向盒心一侧），
// 法线与边向量整体变号时 `axis × s` 不变，深度只取 |d| 与投影半径 → MTV 与法线符号无关。
console.log('\n== 7. 翻转绕向（镜像补偿）不影响碰撞解算 ==');
{
  const { flipTriangleWinding } = await import('./src/world/EditorBuildings.js');
  const mkMat = () => new THREE.MeshBasicMaterial();

  // 一间小房间：薄楼板 + 两面墙 + 斜柱 + 斜靠的板
  function room(flip) {
    const g = new THREE.Group();
    const add = (mesh) => { if (flip) flipTriangleWinding(mesh.geometry); g.add(mesh); return mesh; };
    const floor = add(new THREE.Mesh(new THREE.BoxGeometry(6, 0.12, 6), mkMat()));
    floor.position.set(0, 1, 0);
    const w1 = add(new THREE.Mesh(new THREE.BoxGeometry(0.2, 3, 6), mkMat()));
    w1.position.set(-3, 2.5, 0);
    const w2 = add(new THREE.Mesh(new THREE.BoxGeometry(6, 3, 0.2), mkMat()));
    w2.position.set(0, 2.5, -3);
    const col = add(new THREE.Mesh(new THREE.BoxGeometry(0.4, 3, 0.4), mkMat()));
    col.position.set(1.2, 2.5, 1.0);
    col.rotation.set(0.3, 0.7, 0.2);
    const ramp = add(new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.12, 1.2), mkMat()));
    ramp.position.set(-1.5, 1.7, 0.6);
    ramp.rotation.z = 0.35;
    // 一级台阶 + 第二根斜柱：制造「薄板 + 相邻共面 + 多接触」的组合
    const step = add(new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.4, 1.2), mkMat()));
    step.position.set(-2.1, 1.26, -1.6);
    const col2 = add(new THREE.Mesh(new THREE.BoxGeometry(0.3, 2.4, 0.4), mkMat()));
    col2.position.set(-0.6, 2.3, 1.9);
    col2.rotation.set(-0.2, 0.35, 0.15);
    return g;
  }

  const tmNormal = bakeTriMesh(room(false), { force: true });
  const tmFlipped = bakeTriMesh(room(true), { force: true });
  eq(tmFlipped.triCount, tmNormal.triCount, '整块几何翻绕向：三角形数量不变（' + tmNormal.triCount + ' 个）');
  ok(tmNormal.triCount >= 84, '场景足够复杂（' + tmNormal.triCount + ' 个三角形：薄楼板/斜面/台阶/两根斜柱）');

  // 轨迹：从楼板上方落下 → 贴墙滑行 → 撞斜柱 → 被挤向角落，把各类接触都走一遍
  function run(tm) {
    const phys = new PlayerPhysics();
    const input = idleInput();
    const state = { x: 2.6, y: 3.4, z: 2.4, yaw: 0, pitch: 0, onGround: false };
    const trace = [];
    for (let i = 0; i < 180; i++) {
      // 前半段朝墙走，后半段朝斜柱走
      state.x += (i < 90 ? -1 : 1) * 0.02;
      state.z += (i < 90 ? 0 : -1) * 0.02;
      phys.update(1 / 60, input, 0, state, [tm]);
      trace.push(state.x, state.y, state.z, state.onGround ? 1 : 0);
    }
    return { trace, state };
  }
  const a = run(tmNormal);
  const b = run(tmFlipped);
  let diffIdx = -1, maxd = 0;
  for (let i = 0; i < a.trace.length; i++) {
    const d = Math.abs(a.trace[i] - b.trace[i]);
    if (d > maxd) maxd = d;
    if (d !== 0 && diffIdx < 0) diffIdx = i;
  }
  ok(diffIdx < 0,
    '180 帧轨迹（下滑 → 贴墙 → 撞斜柱 → 落地）逐位一致（最大偏差 ' + maxd.toExponential(2) + '）'
    + (diffIdx >= 0 ? '，首个不同在第 ' + Math.floor(diffIdx / 4) + ' 帧的第 ' + (diffIdx % 4) + ' 项' : ''));
  ok(a.state.onGround === b.state.onGround, '最终 onGround 状态一致（' + a.state.onGround + '）');
  ok(Math.abs(a.state.y - b.state.y) < 1e-12, '最终离地高度一致（' + a.state.y.toFixed(6) + ' / ' + b.state.y.toFixed(6) + '）');
}

{
  const solver = readFileSync('./src/world/collision/characterSolver.js', 'utf8');  const trimesh = readFileSync('./src/world/collision/trimesh.js', 'utf8');
  const eb = readFileSync('./src/world/EditorBuildings.js', 'utf8');
  const game = readFileSync('./src/core/Game.js', 'utf8');

  ok(/let n = Math\.ceil\(dist \/ Config\.TRIMESH_SUBSTEP_MAX_DIST\)/.test(solver), '子步数按 |Δ| / MAX_DIST 计算');
  ok(!/dist \/ Config\.TRIMESH_SUBSTEP_MAX_COUNT/.test(solver), '旧的「至少 24 子步」下限已删除');
  ok(/minX - SKIN > tm\.maxX/.test(solver), 'resolvePenetration 里有逐建筑 AABB 早淘汰');
  ok(/nrm\[t \* 3\]/.test(solver), 'boxTriMTV 用 tm.normals 里的烘焙法线');

  ok(/const bakeByKey = new Map\(\)/.test(trimesh), 'trimesh 有按稳定 key 的烘焙缓存');
  ok(/pending: promise/.test(trimesh), '进行中的烘焙用 Promise 共享');
  ok(/\{ key: bakeKey \}/.test(eb), 'EditorBuildings 传了稳定 key');
  ok(/mergeGeometries/.test(eb) && /mergeStaticMeshes\(m\)/.test(eb), 'EditorBuildings 合并静态子网格');
  ok(/rel\.determinant\(\) < 0\) flipTriangleWinding\(g\)/.test(eb),
    '负行列式（镜像）子网格在合并前会翻转绕向 —— 否则会被 three 当背面剔除、模型出现内壁');
  ok(/frontFaceCW/.test(readFileSync('./node_modules/three/build/three.module.js', 'utf8')),
    '前提仍然成立：three 的渲染器确实按 matrixWorld.determinant() 决定绕向解读');

  ok(/this\._perf = perfEnabled\(\)/.test(game), 'Game 里有 #perf 开关');
  ok(/this\._updatePerfHud\(dt, _pt2 - _pt1, now - _pt3, now - _pt0\)/.test(game), '主循环里接上了 物理/渲染/其他 三段计时');
}

console.log('\n' + (fails ? 'FAILED：' + fails + ' 项未通过' : 'PASS 全部通过'));
process.exit(fails ? 1 : 0);
