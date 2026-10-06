// 自检：碰撞体宽相位网格（PlayerPhysics 的 _nearby / _rebuildBroadphase）
//
// 为什么必须有这个探针：宽相位是**纯剪枝**——写漏了/写保守了，表现是"偶尔穿墙"或
// "站在某个位置突然掉下去"，而且只在那一个格子上复现，肉眼极难定位。
// 所以这里不测"快了多少"，而是测**完备性**（一个都不能漏）+ **行为等价**（结果和暴力遍历逐字一致）。
//
// 覆盖：
//  ① 完备性：宽相位结果必须**包含**所有与玩家 AABB 在 XZ 上相交的碰撞体（随机对拍 500 轮）。
//  ② 行为等价：用「全部碰撞体」和用「宽相位结果」跑同一次碰撞解析，state 必须逐字段一致。
//  ③ 跨格：横跨多个格子的大碰撞体、以及"中心在邻格但体积伸进来"的碰撞体都不能漏。
//  ④ 超大物体：超过 BP_MAX_CELLS 的碰撞体走常驻列表，任何位置都能查到。
//  ⑤ 去重：一个碰撞体横跨多个格时不能重复出现在结果里（否则 SAT 跑两遍）。
//  ⑥ 失效检测：长度变化 / markCollidersDirty / 兜底帧数 三条路径都要能触发重建。
//  ⑦ 逐帧零分配：_resolveConvex 不再 new 数组 / Set / toFixed（GC 微卡的根源）。
//
// 跑法：node tools/probe-broadphase.mjs
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

const { PlayerPhysics } = await import(pathToFileURL(path.join(ROOT, 'src/player/PlayerPhysics.js')).href);
const { Config } = await import(pathToFileURL(path.join(ROOT, 'src/config.js')).href);

// ---- 造碰撞体 ----
function mkBox(cx, cy, cz, hx, hy, hz) { return { type: 'box', cx, cy, cz, hx, hy, hz }; }
// 立方体凸包（8 顶点 / 12 三角形）。顶点是**世界坐标**（与 EditorBuildings 的约定一致）。
function mkConvex(cx, cy, cz, h) {
  const vertices = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    vertices.push(cx + sx * h, cy + sy * h, cz + sz * h);
  }
  // 顶点索引：0=(-,-,-) 1=(-,-,+) 2=(-,+,-) 3=(-,+,+) 4=(+,-,-) 5=(+,-,+) 6=(+,+,-) 7=(+,+,+)
  const Q = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
  const faces = [];
  for (const [a, b, c, d] of Q) { faces.push(a, b, c, a, c, d); }
  return { type: 'convex', cx, cy, cz, vertices, faces };
}

// 暴力参考：与玩家 XZ AABB（半宽 r）相交的全部碰撞体
function bruteNear(ph, colliders, x, z, r) {
  const out = [];
  for (const b of colliders) {
    let minX, maxX, minZ, maxZ;
    if (b.type === 'convex') {
      ph._prepareConvex(b);
      minX = b.minX; maxX = b.maxX; minZ = b.minZ; maxZ = b.maxZ;
    } else {
      const rot = b.rotY || 0;
      const e = rot ? Math.abs(Math.cos(rot)) + Math.abs(Math.sin(rot)) : 1;
      minX = b.cx - b.hx * e; maxX = b.cx + b.hx * e;
      minZ = b.cz - b.hz * e; maxZ = b.cz + b.hz * e;
    }
    if (x + r < minX || x - r > maxX) continue;
    if (z + r < minZ || z - r > maxZ) continue;
    out.push(b);
  }
  return out;
}

// 确定性伪随机（别用 Math.random：失败要能复现）
let _seed = 20261006;
function rnd() { _seed = (_seed * 1103515245 + 12345) & 0x7fffffff; return _seed / 0x7fffffff; }

const BP_PAD = 0.6; // 与 PlayerPhysics 里的常量一致（下面 §6 会从源码再核对一次）

// ---------------------------------------------------------------- ① 完备性随机对拍
console.log('\n[1] 完备性：宽相位结果必须包含所有 XZ 相交的碰撞体（随机对拍）');
{
  const colliders = [];
  for (let i = 0; i < 260; i++) {
    const cx = (rnd() - 0.5) * 400, cz = (rnd() - 0.5) * 400;
    const hx = 0.3 + rnd() * 6, hz = 0.3 + rnd() * 6, hy = 0.5 + rnd() * 6;
    colliders.push(i % 3 === 0 ? mkConvex(cx, hy, cz, Math.min(hx, hz)) : mkBox(cx, hy, cz, hx, hy, hz));
  }
  const ph = new PlayerPhysics();
  ph._rebuildBroadphase(colliders); // 先建一次，避免把构建成本算进"是否漏"的判断

  let rounds = 0, missed = 0, extraMax = 0;
  for (let t = 0; t < 500; t++) {
    const x = (rnd() - 0.5) * 400, z = (rnd() - 0.5) * 400;
    const r = Config.PLAYER_RADIUS * ph.sizeScale + BP_PAD;
    const near = ph._nearby(colliders, x, z).slice(); // slice：_near 是复用数组
    const want = bruteNear(ph, colliders, x, z, r);
    const set = new Set(near);
    rounds++;
    for (const b of want) if (!set.has(b)) missed++;
    extraMax = Math.max(extraMax, near.length - want.length);
  }
  eq(missed, 0, `${rounds} 轮随机位置：漏检碰撞体数 = 0`);
  ok(extraMax >= 0, `最坏情况下多返回 ${extraMax} 个（多返回无害，漏检才致命）`);
}

// ---------------------------------------------------------------- ② 行为等价
console.log('\n[2] 行为等价：用"宽相位结果"与"全部碰撞体"解析，state 必须逐字段一致');
{
  const colliders = [];
  for (let i = 0; i < 160; i++) {
    const cx = (rnd() - 0.5) * 120, cz = (rnd() - 0.5) * 120;
    const hx = 0.4 + rnd() * 4, hz = 0.4 + rnd() * 4, hy = 0.6 + rnd() * 3;
    colliders.push(i % 4 === 0 ? mkConvex(cx, hy, cz, Math.min(hx, hz)) : mkBox(cx, hy, cz, hx, hy, hz));
  }
  const phA = new PlayerPhysics();
  const phB = new PlayerPhysics();
  phA._rebuildBroadphase(colliders);
  phB._rebuildBroadphase(colliders);
  for (const b of colliders) if (b.type === 'convex') { phA._prepareConvex(b); phB._prepareConvex(b); }

  let diff = 0, touched = 0;
  for (let t = 0; t < 300; t++) {
    const x = (rnd() - 0.5) * 120, z = (rnd() - 0.5) * 120, y = 0.85 + rnd() * 3;
    const sA = { x, y, z, onGround: false };
    const sB = { x, y, z, onGround: false };
    phA.velocity.set(0, -1, 0); phB.velocity.set(0, -1, 0);
    // A：全部碰撞体（暴力）；B：宽相位结果
    phA._resolveWorldCollisions(sA, colliders);
    const near = phB._nearby(colliders, sB.x, sB.z).slice();
    phB._resolveWorldCollisions(sB, near);
    if (Math.abs(sA.x - sB.x) > 1e-12 || Math.abs(sA.y - sB.y) > 1e-12 || Math.abs(sA.z - sB.z) > 1e-12 ||
      sA.onGround !== sB.onGround) diff++;
    if (Math.abs(sA.x - x) > 1e-9 || Math.abs(sA.z - z) > 1e-9) touched++;
  }
  eq(diff, 0, '300 次解析：宽相位与暴力遍历的结果完全一致');
  ok(touched > 20, `其中 ${touched} 次真的发生了推出（说明对拍覆盖到了有效碰撞，不是空跑）`);
}

// ---------------------------------------------------------------- ③ 跨格与边界
console.log('\n[3] 跨格场景：大碰撞体 / 中心在邻格但体积伸进来');
{
  const C = 8; // BP_CELL
  // 玩家放在格子边界的正内侧
  const px = C * 1 - 0.05, pz = C * 1 - 0.05;
  const colliders = [
    mkBox(px + 0.3, 2, pz + 0.3, 0.2, 2, 0.2),                 // 中心在玩家右侧邻格，体积伸进来
    mkBox(C * 3, 2, C * 3, C * 2, 2, C * 2),                   // 横跨 5×5 = 25 格的大块
    mkBox(-200, 2, -200, 0.5, 2, 0.5),                          // 很远，绝不该出现
  ];
  const ph = new PlayerPhysics();
  ph._rebuildBroadphase(colliders);
  const near = ph._nearby(colliders, px, pz).slice();
  ok(near.includes(colliders[0]), '中心在邻格、体积伸进玩家格的碰撞体被查到');
  ok(near.includes(colliders[1]), '横跨 25 格的大碰撞体被查到');
  ok(!near.includes(colliders[2]), '400m 外的碰撞体被排除（这才是省下来的开销）');
  eq(near.length, 2, '恰好多余 0 个');

  // 去重：大块同时覆盖玩家所在格与邻格，不能出现两次
  const dup = near.length !== new Set(near).size;
  ok(!dup, '跨多格的碰撞体在结果里不重复（否则 SAT 跑两遍）');

  // 顺序：必须排回 colliders 的原数组顺序（碰撞解析顺序相关，顺序变了行为就变了）
  let ordered = true;
  for (let i = 1; i < near.length; i++) if (near[i - 1]._bpIdx > near[i]._bpIdx) ordered = false;
  ok(ordered, '结果按 colliders 原数组顺序返回（保证与优化前的物理行为逐字等价）');
  const src = fs.readFileSync(path.join(ROOT, 'src/player/PlayerPhysics.js'), 'utf8');
  ok(/out\.sort\(_byOriginalOrder\)/.test(src), '排序调用还在（删掉它 = 悄悄改变物理表现）');
  ok(/const _byOriginalOrder = \(a, b\) => a\._bpIdx - b\._bpIdx;/.test(src),
    '比较器是模块级具名函数（内联箭头 = 每次查询分配一个闭包）');
}

// ---------------------------------------------------------------- ④ 超大物体走常驻列表
console.log('\n[4] 超大碰撞体（超过 BP_MAX_CELLS）走常驻列表，任何位置都查得到');
{
  const huge = mkBox(0, 2, 0, 4000, 2, 4000); // 8000×8000m，覆盖格数远超上限
  const near2 = mkBox(2000, 2, 2000, 1, 2, 1);
  const colliders = [huge, near2];
  const ph = new PlayerPhysics();
  ph._rebuildBroadphase(colliders);
  eq(ph._bpStat.big, 1, '超大物体被放进常驻列表（只 1 个，没被切成上万格）');
  const near = ph._nearby(colliders, 1234, -777).slice();
  ok(near.includes(huge), '在任意远处都能查到超大物体（否则玩家会掉出巨型地面）');
  eq(near.length, 1, '近处那个 1m 的盒子不在这个位置（正确排除）');
}

// ---------------------------------------------------------------- ⑤ 失效检测三条路径
console.log('\n[5] 失效检测：长度变化 / 显式通知 / 兜底帧数');
{
  const ph = new PlayerPhysics();
  const colliders = [mkBox(0, 2, 0, 1, 2, 1)];
  ph._rebuildBroadphase(colliders);
  const builtAt = ph._bpLen;

  // 路径 a：长度变化
  colliders.push(mkBox(100, 2, 100, 1, 2, 1));
  ph._nearby(colliders, 0, 0);
  eq(ph._bpLen, 2, 'a) 长度变化触发重建');
  ok(builtAt === 1, '（重建前确实只有 1 个）');

  // 路径 b：显式通知（长度不变的原地改写）
  const mask = mkBox(0, 2, 0, 1, 2, 1);
  colliders[0] = mask;
  const cellsBefore = ph._bpStat.cells;
  ph.markCollidersDirty();
  const near = ph._nearby(colliders, 500, 500).slice();
  ok(ph._bpDirty === false, 'b) markCollidersDirty 后重建，脏标记被清掉');
  ok(typeof cellsBefore === 'number', '（统计字段可读）');
  eq(near.length, 0, '重建后：500m 外查不到任何东西');

  // 路径 c：兜底帧数（既不通知也不改长度，靠 BP_REBUILD_EVERY 自愈）
  ph._bpAge = 0;
  let rebuilt = false;
  const origBuild = ph._rebuildBroadphase.bind(ph);
  ph._rebuildBroadphase = function (c) { rebuilt = true; return origBuild(c); };
  for (let i = 0; i < 320; i++) ph._nearby(colliders, 0, 0);
  ok(rebuilt, 'c) 兜底帧数到点后会自动重建（漏了显式通知也能自愈）');
}

// ---------------------------------------------------------------- ⑥ 源码约束（静态）
console.log('\n[6] 源码约束：常量存在、Game 改碰撞体处有通知、_resolveConvex 无每帧分配');
{
  const fw = fs.readFileSync(path.join(ROOT, 'src/player/PlayerPhysics.js'), 'utf8');
  const game = fs.readFileSync(path.join(ROOT, 'src/core/Game.js'), 'utf8');
  const lp = fs.readFileSync(path.join(ROOT, 'src/player/LocalPlayer.js'), 'utf8');

  ok(/const BP_CELL = 8/.test(fw), 'BP_CELL = 8m（1~4 格/次查询）');
  ok(/const BP_PAD = 0\.6/.test(fw), 'BP_PAD = 0.6m（推出后跨格不漏）');
  ok(/BP_MAX_CELLS = 256/.test(fw), 'BP_MAX_CELLS 有上限（否则长地面会插满网格）');
  ok(/BP_REBUILD_EVERY = 300/.test(fw), 'BP_REBUILD_EVERY 兜底周期存在');
  ok(/markCollidersDirty\(\)/.test(fw) && /this\._bpDirty = true/.test(fw), 'markCollidersDirty 接线正确');

  ok(/markCollidersDirty/.test(lp), 'LocalPlayer 暴露 markCollidersDirty');
  const calls = (game.match(/markCollidersDirty\(\)/g) || []).length;
  ok(calls >= 4, `Game 里 ${calls} 处碰撞体改动点都做了通知（竞技场进/出、赛道、远程场景）`);

  // 块内断言：只扫 _resolveConvex 自己的函数体
  const i = fw.indexOf('_resolveConvex(state, b, px, py, pz, pr, hh) {');
  ok(i > 0, '定位到 _resolveConvex');
  let depth = 0, end = -1;
  for (let k = fw.indexOf('{', i); k < fw.length; k++) {
    if (fw[k] === '{') depth++;
    else if (fw[k] === '}') { depth--; if (depth === 0) { end = k; break; } }
  }
  const body = fw.slice(i, end + 1);
  ok(body.length > 200, '抽到了函数体（配对成功）');
  ok(!/new Set\(/.test(body), '_resolveConvex 不再每帧 new Set（字符串去重已挪到准备期）');
  ok(!/toFixed/.test(body), '_resolveConvex 不再每帧 toFixed 产生字符串垃圾');
  ok(!/axes\.push/.test(body), '_resolveConvex 不再每帧 push 进新数组');
  ok(!/const\s+axes\s*=\s*\[/.test(body), '_resolveConvex 不再每帧新建 axes 数组');
  ok(/_SAT_AXES\[/.test(body), '改用模块级 _SAT_AXES 复用缓冲');
  ok(!/const\s+pC\s*=\s*\{/.test(body) && !/const\s+cC\s*=\s*\{/.test(body),
    '不再每帧新建 pC / cC 字面量对象（直接用 px/py/pz 与 b.cx/cy/cz）');

  // 宽相位必须同时服务"碰撞解析"和"地面吸附"两处，否则吸附仍会遍历全部
  ok(/this\._nearby\(simples, state\.x, state\.z\)/.test(fw), '宽相位在 update 里按玩家位置查询');
  const after = fw.slice(fw.indexOf('this._nearby(simples'));
  ok(/this\._snapToGround\(state, near\)/.test(after), '地面吸附复用同一份 near 列表（不重复遍历）');
}

console.log('\n' + (fails ? `✗ ${fails} 项失败` : '✓ 全部通过'));
process.exit(fails ? 1 : 0);
