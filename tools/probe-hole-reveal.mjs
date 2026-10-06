// 自检：洞壁 / reveal（FakeWindow.js 的 reveal 部分）
//
// 背景：挖洞只 discard 出一个通孔，墙的两层壳之间**没有侧壁** —— 看上去是个没厚度的纸片洞。
// 洞壁就是补上的那一圈"墙的剖面"（矩形管）。它有 4 个极易静默失效的点，必须真跑真验：
//  ① **法线必须朝管中轴**（= 只渲染内壁）。这是它能"不精确测量墙厚"的前提：
//     管壁外面是背面 → 被剔除 → 即便管子伸出墙面，站在墙外也看不到它。
//     方向写反的表现是「墙上戳出一根方管」或「洞里什么都看不见」，而且编译/运行零报错。
//  ② **必须用独立于建筑的材质**。建筑材质打了挖洞补丁，而洞壁的世界坐标正好压在洞盒边界上，
//     一旦被同一个补丁命中就会被自己挖掉（现象：洞壁整块消失 / 闪烁）。
//     patchBuildingMaterial 里那道 userData.fpmReveal 守卫不能被人删掉。
//  ③ **单向延伸**（z ∈ [−depth, 0]）：窗户贴在墙面上，往"窗户背面"才是墙内。
//     若做成双向，一半管子会伸到墙外。
//  ④ 共享材质**不能被 disposeReveal 释放** —— 释放一次，后面所有洞壁都变黑/报错。
//
// 跑法：node tools/probe-hole-reveal.mjs
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
function near(a, b, eps, msg) {
  const d = Math.abs(a - b);
  if (d <= (eps == null ? 1e-6 : eps)) console.log('  PASS  ' + msg + `  (${a})`);
  else { console.log('  FAIL  ' + msg + `  got ${a} want ${b} (|d|=${d})`); fails++; }
}

const THREE = await import('three');
const FW = await import(pathToFileURL(path.join(ROOT, 'src/world/FakeWindow.js')).href);

const W = 1.6, H = 1.2, D = 0.35;

// ---------------------------------------------------------------- ① 导出齐全
console.log('\n[1] 洞壁 API 导出齐全');
for (const name of ['REVEAL_DEPTH', 'REVEAL_COLOR', 'getRevealMaterial', 'isRevealMaterial',
  'createRevealGeometry', 'createRevealMesh', 'disposeReveal']) {
  ok(name in FW, `导出 ${name}`);
}
ok(FW.REVEAL_DEPTH > 0 && FW.REVEAL_DEPTH < 1, `REVEAL_DEPTH 是合理的墙厚量级（${FW.REVEAL_DEPTH}m）`);

// ---------------------------------------------------------------- ② 几何结构
console.log('\n[2] createRevealGeometry：矩形管结构');
const geo = FW.createRevealGeometry(W, H, D);
{
  const pos = geo.attributes.position;
  const idx = geo.index;
  eq(pos.count, 16, '顶点数 = 4 面 × 4');
  eq(idx.count, 24, '索引数 = 4 面 × 6（8 个三角形）');
  ok(!!geo.attributes.normal, '有 normal 属性（computeVertexNormals 跑过）');
  ok(!!geo.attributes.uv, '有 uv 属性');
  eq(geo.attributes.normal.count, 16, 'normal 与顶点一一对应');

  // 包围盒 = 洞口尺寸 × 单向洞深
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  near(bb.min.x, -W / 2, 1e-6, '包围盒 min.x = −w/2');
  near(bb.max.x, W / 2, 1e-6, '包围盒 max.x = +w/2');
  near(bb.min.y, -H / 2, 1e-6, '包围盒 min.y = −h/2');
  near(bb.max.y, H / 2, 1e-6, '包围盒 max.y = +h/2');
  near(bb.max.z, 0, 1e-6, '包围盒 max.z = 0（洞口与窗面齐平）');
  near(bb.min.z, -D, 1e-6, '包围盒 min.z = −depth（单向朝墙内，不越过窗面）');
}
geo.dispose();

// ---------------------------------------------------------------- ③ 法线朝管中轴（核心）
console.log('\n[3] 所有面法线都朝管中轴（这是"只渲染内壁"的根本）');
{
  const g = FW.createRevealGeometry(W, H, D);
  const P = g.attributes.position.array;
  const I = g.index.array;
  let outward = 0, degenerate = 0;
  for (let t = 0; t + 2 < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ax = P[b] - P[a], ay = P[b + 1] - P[a + 1], az = P[b + 2] - P[a + 2];
    const bx = P[c] - P[a], by = P[c + 1] - P[a + 1], bz = P[c + 2] - P[a + 2];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) { degenerate++; continue; }
    nx /= len; ny /= len; nz /= len;
    // 重心 → 管中轴的向量（中轴 = (0,0,z)）
    const gx = (P[a] + P[b] + P[c]) / 3, gy = (P[a + 1] + P[b + 1] + P[c + 1]) / 3;
    // 该面向量应指向中轴：n · (−gx, −gy, 0) > 0
    if (nx * -gx + ny * -gy <= 0) outward++;
  }
  eq(degenerate, 0, '没有退化三角形（面积为 0）');
  eq(outward, 0, '8 个三角形全部朝内（没有一个朝管外 → 管外看不见它）');

  // 顶点法线也必须朝内（材质是 FrontSide，靠它决定哪些像素被画）
  let vOut = 0;
  const N = g.attributes.normal.array;
  for (let i = 0; i < N.length; i += 3) {
    const x = P[i], y = P[i + 1];
    const dot = N[i] * -x + N[i + 1] * -y;
    // 顶点可能正好在轴线上（两轴都为 0）——那种顶点法线方向无从判断，跳过
    if (Math.abs(x) < 1e-9 && Math.abs(y) < 1e-9) continue;
    if (dot <= 0) vOut++;
  }
  eq(vOut, 0, '16 个顶点法线全部朝内');
  g.dispose();
}

// ---------------------------------------------------------------- ④ 材质
console.log('\n[4] 洞壁材质：共享 / 单面 / 带识别标记');
{
  const m1 = FW.getRevealMaterial();
  const m2 = FW.getRevealMaterial();
  ok(m1 === m2, 'getRevealMaterial 返回同一实例（共享，不随窗户数增长）');
  ok(m1.isMeshStandardMaterial === true, '是 MeshStandardMaterial（吃 scene.environment，洞里不会死黑）');
  eq(m1.side, THREE.FrontSide, 'side = FrontSide（只画内壁；管壁外面被背面剔除）');
  ok(FW.isRevealMaterial(m1) === true, 'isRevealMaterial(自身) = true');
  ok(FW.isRevealMaterial(FW.createWindowMaterial({})) === false, 'isRevealMaterial(窗户材质) = false');
  ok(FW.isRevealMaterial(new THREE.MeshStandardMaterial()) === false, 'isRevealMaterial(普通材质) = false');
  ok(FW.isRevealMaterial(null) === false, 'isRevealMaterial(null) = false（不炸）');
}

// ---------------------------------------------------------------- ⑤ 挖洞补丁必须跳过洞壁（核心）
console.log('\n[5] 挖洞补丁绝不碰洞壁材质（否则洞壁会被自己挖掉）');
{
  const rv = FW.getRevealMaterial();
  const before = rv.onBeforeCompile;
  const patched = FW.patchBuildingMaterial(rv);
  eq(patched, false, 'patchBuildingMaterial(洞壁材质) 返回 false（明确拒绝）');
  ok(rv.onBeforeCompile === before, '洞壁材质的 onBeforeCompile 没被包装（身份不变）');
  ok(FW.isRevealMaterial(rv), '标记仍在（没被覆盖）');

  // 反证：普通建筑材质是会被打上补丁的
  const plain = new THREE.MeshStandardMaterial();
  const p2 = FW.patchBuildingMaterial(plain);
  eq(p2, true, '普通建筑材质会被打补丁（对照组，说明上面的 false 不是因为函数失效）');
  ok(typeof plain.onBeforeCompile === 'function' && plain.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile,
    '普通材质的 onBeforeCompile 已被换成包装函数');
}

// ---------------------------------------------------------------- ⑥ 网格属性
console.log('\n[6] createRevealMesh：挂载属性与阴影取舍');
{
  const mesh = FW.createRevealMesh({ w: W, h: H, depth: D });
  ok(mesh.isMesh === true, '是 Mesh');
  eq(mesh.userData.fpmReveal, true, 'userData.fpmReveal = true（识别标记）');
  eq(mesh.castShadow, false, 'castShadow = false（洞壁不投影，省一趟阴影）');
  eq(mesh.receiveShadow, true, 'receiveShadow = true（吃墙的阴影 → 洞里暗、洞口亮 = 厚度感）');
  ok(mesh.material === FW.getRevealMaterial(), '用的是共享材质');
  eq(mesh.geometry.attributes.position.count, 16, '几何尺寸由 opts 决定');
  // 深度可覆盖
  const m2 = FW.createRevealMesh({ w: 1, h: 1, depth: 0.9 });
  m2.geometry.computeBoundingBox();
  near(m2.geometry.boundingBox.min.z, -0.9, 1e-6, 'opts.depth 生效');
  m2.geometry.dispose();

  // disposeReveal 只释放几何，绝不释放共享材质
  const shared = FW.getRevealMaterial();
  let disposed = false;
  const origDispose = shared.dispose;
  shared.dispose = function () { disposed = true; return origDispose.apply(this, arguments); };
  FW.disposeReveal(mesh);
  shared.dispose = origDispose;
  eq(disposed, false, 'disposeReveal 没有释放共享材质');
  FW.disposeReveal(null); // 不炸
  ok(true, 'disposeReveal(null) 不抛异常');
}

// ---------------------------------------------------------------- ⑦ 与挖洞孔径一致
console.log('\n[7] 洞壁孔径 = 窗户尺寸（与挖洞盒同源，不会一大一小）');
{
  for (const [w, h] of [[1.6, 1.2], [3, 0.5], [0.4, 2.2]]) {
    const g = FW.createRevealGeometry(w, h, D);
    g.computeBoundingBox();
    const bb = g.boundingBox;
    const okW = Math.abs((bb.max.x - bb.min.x) - w) < 1e-6;
    const okH = Math.abs((bb.max.y - bb.min.y) - h) < 1e-6;
    ok(okW && okH, `${w}×${h} 的洞口孔径精确一致`);
    g.dispose();
  }
  // 极小尺寸不炸（面板允许输入 0.1）
  const tiny = FW.createRevealGeometry(0.1, 0.1, 0.01);
  ok(tiny.attributes.position.count === 16, '极小尺寸仍产出完整几何（有下限保护，不会 NaN）');
  const tp = tiny.attributes.position.array;
  ok(tp.every((v) => Number.isFinite(v)), '极小尺寸下没有 NaN 顶点');
  tiny.dispose();
}

// ---------------------------------------------------------------- ⑧ 编辑器 / 游戏端接线
console.log('\n[8] 编辑器与游戏端的接线（静态断言：接错就是"洞有壁没壁"式静默失效）');
{
  const ed = fs.readFileSync(path.join(ROOT, 'src/editor/EditorApp.js'), 'utf8');
  const gb = fs.readFileSync(path.join(ROOT, 'src/world/EditorBuildings.js'), 'utf8');
  const fw = fs.readFileSync(path.join(ROOT, 'src/world/FakeWindow.js'), 'utf8');

  ok(/createRevealMesh/.test(ed) && /disposeReveal/.test(ed) && /REVEAL_DEPTH/.test(ed),
    'EditorApp 引入了 createRevealMesh / disposeReveal / REVEAL_DEPTH');
  ok(/function\s+windowMeshOf/.test(ed), 'EditorApp 有 windowMeshOf（按标记取窗户 mesh）');
  ok(/function\s+rebuildReveal/.test(ed), 'EditorApp 有 rebuildReveal');
  ok(/function\s+clearWindowChildren/.test(ed), 'EditorApp 有 clearWindowChildren（释放窗户+洞壁）');
  // 窗户相关代码里不得再依赖子节点顺序（洞壁会变成 children[1]）
  ok(/windowMeshOf\(rec\)/.test(ed), 'EditorApp 用 windowMeshOf 取窗户 mesh');
  const staleChild0 = /const\s+mesh\s*=\s*rec\.obj\.children\[0\]/.test(ed);
  ok(!staleChild0, 'EditorApp 不再用 rec.obj.children[0] 取窗户 mesh（洞壁会占位）');
  ok(/rebuildReveal\(rec\)/.test(ed), '勾选/尺寸变化时会重建洞壁');

  ok(/createRevealMesh/.test(gb), 'EditorBuildings（游戏端）会创建洞壁');
  ok(/holder\.add\(createRevealMesh\(/.test(gb), '洞壁挂在窗户的 holder 下（跟随同一变换）');

  ok(/isRevealMaterial\(mat\)/.test(fw), 'patchBuildingMaterial 里有洞壁守卫');
  ok(/userData\.fpmReveal\s*=\s*true/.test(fw), '洞壁材质/网格带 fpmReveal 标记');

  // 洞盒深度与洞壁深度必须是两套：别把 REVEAL_DEPTH 当 HOLE_DEPTH 用
  ok(/HOLE_DEPTH\s*=\s*1\.2/.test(ed), '编辑器洞盒深度仍是 1.2（保证挖穿）');
  ok(!/applyWindowHoles\([^)]*REVEAL_DEPTH/.test(ed), 'REVEAL_DEPTH 没有被误当作洞盒深度传给 applyWindowHoles');
}

console.log('\n' + (fails ? `✗ ${fails} 项失败` : '✓ 全部通过'));
process.exit(fails ? 1 : 0);
