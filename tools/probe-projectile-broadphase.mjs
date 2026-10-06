// 自检：投掷物的廉价 AABB 预筛 + 凸包索引表缓存（projectileHit.js）
//
// 投掷物每帧要拿"上一帧→这一帧的线段"跟**全部**碰撞体求交。凸包那一支的成本是
// **遍历它所有的面**，所以上百个凸包里只要有一两个在附近，其余全在做无用功。
// 这里加了一层 AABB 分离测试把它们剔掉（Unity/PhysX 的 broadphase 思想，线性版）。
//
// 这一层最危险的失效方式是**预筛盒比真实几何小** → 偶尔漏检 → "手雷穿墙"，
// 而且只在特定角度/位置复现。所以探针重点验两件事：
//   ① 预筛盒是**保守上界**（真实顶点/角点一个都不能跑到盒外）；
//   ② 开/关预筛的结果**完全一致**（随机对拍）。
//
// 跑法：node tools/probe-projectile-broadphase.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
function ok(cond, msg) {
  if (cond) console.log('  PASS  ' + msg);
  else { console.log('  FAIL  ' + msg); fails++; }
}
function eq(a, b, msg) {
  if (a === b) console.log('  PASS  ' + msg + `  (${a})`);
  else { console.log('  FAIL  ' + msg + `  got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); fails++; }
}

const mod = await import(pathToFileURL(path.join(ROOT, 'src/world/collision/projectileHit.js')).href);
const { projectileHitsWorld } = mod;
const src = fs.readFileSync(path.join(ROOT, 'src/world/collision/projectileHit.js'), 'utf8');

let _seed = 424242;
function rnd() { _seed = (_seed * 1103515245 + 12345) & 0x7fffffff; return _seed / 0x7fffffff; }

// ---- 造碰撞体 ----
function mkBox(cx, cy, cz, hx, hy, hz, rotY) { return { type: 'box', cx, cy, cz, hx, hy, hz, rotY }; }
function mkConvex(cx, cy, cz, h, rotY) {
  const c = Math.cos(rotY || 0), s = Math.sin(rotY || 0);
  const vertices = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const lx = sx * h, ly = sy * h, lz = sz * h;
    vertices.push(cx + lx * c + lz * s, cy + ly, cz - lx * s + lz * c);
  }
  const Q = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
  const faces = [];
  for (const [a, b, cc, d] of Q) faces.push(a, b, cc, a, cc, d);
  return { type: 'convex', cx, cy, cz, vertices, faces };
}

// ---------------------------------------------------------------- ① 预筛盒是保守上界
console.log('\n[1] 预筛盒必须包住真实几何（比真实几何小 = 偶尔漏检 = 手雷穿墙）');
{
  // 直接调用内部逻辑：靠"命中判定必须仍为 true"反推。
  // 这里用一组**必须命中**的构造：投掷物正落在几何内部/表面。
  const cases = [];
  // 轴对齐盒：中心处
  cases.push([mkBox(10, 2, 10, 1, 1, 1, 0), 10, 2, 10]);
  // 旋转 45° 的盒：从对角线方向逼近中心（这是最能暴露"盒比几何小"的位置）
  cases.push([mkBox(10, 2, 10, 1, 1, 1, Math.PI / 4), 10, 2, 10]);
  cases.push([mkBox(-30, 1.5, 8, 2, 1.5, 2, Math.PI / 3), -30, 1.5, 8]);
  // 旋转凸包
  cases.push([mkConvex(5, 3, -5, 1.2, Math.PI / 5), 5, 3, -5]);
  cases.push([mkConvex(0, 1, 0, 0.8, 0.9), 0, 1, 0]);
  let bad = 0;
  for (const [b, x, y, z] of cases) {
    // 高速扫掠：从很远处飞进来，必须被拦住
    const hit = projectileHitsWorld([b], x, y, z, 0.16, x - 8, y, z - 8);
    if (!hit) { bad++; console.log('       漏检: ' + JSON.stringify(b.type)); }
  }
  eq(bad, 0, '几何内部的投掷物全部被判定命中（预筛没有误杀）');

  // 反向：把投掷物放在离得很远的地方，必须**不**命中（预筛确实在剔）
  let falsePos = 0;
  for (const [b] of cases) {
    if (projectileHitsWorld([b], 500, 20, 500, 0.16, 500, 20, 500)) falsePos++;
  }
  eq(falsePos, 0, '500m 外不误报命中');
}

// ---------------------------------------------------------------- ② 开关预筛的结果完全一致
console.log('\n[2] 开/关预筛的结果必须逐次一致（随机对拍）');
{
  // 关预筛的做法：把 __bbox 显式设为 null（colliderAabb 见 null 就不筛）
  const mkWorld = () => {
    const arr = [];
    for (let i = 0; i < 120; i++) {
      const cx = (rnd() - 0.5) * 80, cz = (rnd() - 0.5) * 80;
      const h = 0.5 + rnd() * 3;
      const rot = (rnd() - 0.5) * Math.PI;
      arr.push(i % 2 ? mkBox(cx, 1 + rnd() * 3, cz, h, 0.5 + rnd() * 2, h, rot)
        : mkConvex(cx, 1 + rnd() * 3, cz, h, rot));
    }
    return arr;
  };
  const on = mkWorld();
  const off = on.map((b) => {
    // 结构相同但对象独立（避免 __bbox 缓存互相污染）
    const c = b.type === 'convex'
      ? mkConvex(b.cx, b.cy, b.cz, (b.vertices[0] - b.cx), 0)
      : mkBox(b.cx, b.cy, b.cz, b.hx, b.hy, b.hz, b.rotY);
    c.__bbox = null; // 关闭预筛
    return c;
  });
  // 让两边几何真正一致：用深拷贝顶点
  for (let i = 0; i < on.length; i++) {
    if (on[i].type === 'convex') {
      off[i].vertices = Array.from(on[i].vertices);
      off[i].faces = Array.from(on[i].faces);
      off[i].__bbox = null;
      delete off[i].__convexIdx;
    } else {
      off[i].__bbox = null;
    }
  }

  let diff = 0, hitsOn = 0;
  for (let t = 0; t < 800; t++) {
    const x = (rnd() - 0.5) * 80, z = (rnd() - 0.5) * 80, y = rnd() * 8;
    const dx = (rnd() - 0.5) * 4, dz = (rnd() - 0.5) * 4, dy = (rnd() - 0.5) * 2;
    const a = projectileHitsWorld(on, x, y, z, 0.16, x - dx, y - dy, z - dz);
    const b = projectileHitsWorld(off, x, y, z, 0.16, x - dx, y - dy, z - dz);
    if (a !== b) diff++;
    if (a) hitsOn++;
  }
  eq(diff, 0, '800 轮随机扫掠：有预筛与无预筛结果完全一致');
  ok(hitsOn > 20, `其中 ${hitsOn} 次真的命中（对拍覆盖到了有效场景，不是空跑）`);
}

// ---------------------------------------------------------------- ③ 预筛确实剔掉了大多数凸包
console.log('\n[3] 预筛确实把远处的凸包挡在"遍历面"之外');
{
  const near = mkConvex(0, 2, 0, 1, 0);
  let touched = 0;
  const verts = near.vertices;
  Object.defineProperty(near, 'vertices', { get() { touched++; return verts; }, configurable: true });
  const far = [];
  for (let i = 0; i < 299; i++) {
    const b = mkConvex(200 + i * 3, 2, 200, 1, 0);
    const v = b.vertices;
    Object.defineProperty(b, 'vertices', { get() { touched++; return v; }, configurable: true });
    far.push(b);
  }
  const all = [near, ...far];
  // ⚠ 先预热一遍：第一次调用会顺带建立 __bbox / __convexIdx，而 colliderAabb 读 vertices
  //   也会计入计数器。不预热的话数出来的是"300 个都读了"，看不出预筛的效果。
  //   ⚠ 扫掠起点必须在凸包**外面**：本函数的凸包判定是"球面到三角形的距离"，
  //     球心落在凸包内部时到各面都有距离，得靠线段穿面才能命中。
  projectileHitsWorld(all, 0, 2, 0, 0.16, 0, 2, -5);
  touched = 0;
  const hit = projectileHitsWorld(all, 0, 2, 0, 0.16, 0, 2, -5);
  ok(hit === true, '命中近处那个凸包');
  ok(touched <= 4, `只有 ${touched} 个凸包进入三角形遍历（共 300 个）—— 预筛挡掉了剩下的`);
  ok(touched >= 1, '近处那个确实被检查了（不是靠"全跳过"蒙对的）');

  // ⚠ 这里**故意不做**"紧密堆叠应全部进入遍历"的断言：
  //   本函数命中即 return true（早退是设计），堆叠时只会检查到第一个命中的那个；
  //   而"盒相交但不与几何相交"对**轴对齐**凸包根本不存在（AABB 就等于几何的外接盒），
  //   要构造它得用斜置凸包，得不偿失。
  //   "预筛不是无脑跳过"由 §2 的 800 轮对拍保证 —— 若它无脑跳过，对拍必然出现少报命中。
}

// ---------------------------------------------------------------- ④ 缓存
console.log('\n[4] AABB 与凸包索引表都缓存在碰撞体上（静态碰撞体，不重复算）');
{
  const b = mkConvex(1, 1, 1, 1, 0.3);
  projectileHitsWorld([b], 1, 1, 1, 0.16, 1, 1, 1);
  ok(b.__bbox !== undefined, '首次调用后 __bbox 已缓存');
  ok('__convexIdx' in b, '首次调用后 __convexIdx 已缓存（faces 不再每帧全量校验）');
  const bbox = b.__bbox;
  projectileHitsWorld([b], 1, 1, 1, 0.16, 1, 1, 1);
  ok(b.__bbox === bbox, '第二次调用复用同一份 __bbox 对象（没重算）');

  // 无 faces 的凸包：__convexIdx 缓存为 null，走包围盒兜底
  const noFace = { type: 'convex', cx: 0, cy: 0, cz: 0, vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0] };
  projectileHitsWorld([noFace], 0, 0, 0, 0.5, 0, 0, 0);
  eq(noFace.__convexIdx, null, 'faces 不合法时缓存 null（下次不再全量校验）');
}

// ---------------------------------------------------------------- ⑤ 源码约束
console.log('\n[5] 源码约束');
{
  ok(/function colliderAabb\(b\)/.test(src), '有 colliderAabb（惰性缓存的世界 AABB）');
  ok(/b\.__bbox = box/.test(src), 'AABB 缓存在 __bbox 上');
  ok(/_SAT_|__convexIdx/.test(src), '凸包索引表有缓存字段 __convexIdx');
  // 预筛必须排在 convex 分支之前 —— 排在后面等于没做（索引表已经建完了）
  const iPre = src.indexOf('const bb = colliderAabb(b);');
  // 用"真正花时间的那句"作锚点：凸包索引表 + 面遍历都在这句之后
  const iCost = src.indexOf('const idx = convexIndexTriples(b);');
  ok(iPre > 0 && iCost > 0 && iPre < iCost,
    '预筛排在 convexIndexTriples 之前（先 AABB 再建索引表/遍历面，否则白筛）');
  // trimesh 不受影响：它有自己的 BVH 粗筛
  const iTri = src.indexOf("if (b.type === 'trimesh') {");
  ok(iTri > 0 && iTri < iPre, 'trimesh 分支在预筛之前（BVH 自带粗筛，不该被 AABB 二次限制）');
}

console.log('\n' + (fails ? `✗ ${fails} 项失败` : '✓ 全部通过'));
process.exit(fails ? 1 : 0);
