// 自检：挖洞补丁的**施加范围**（空间筛选）
//
// ⚠⚠ 为什么必须严查这一条（2026-10-06「手机场景卡成啥了」的真凶）：
//   片元着色器里只要出现 `discard`，GPU 就必须放弃 early-Z / 隐藏面消除（HSR）。
//   手机 GPU 全是 TBDR 架构，HSR 一失效 = 整屏 overdraw 翻好几倍，帧率断崖式下跌。
//   （桌面独显带宽大、early-Z 收益相对小，所以当时在桌面上完全没看出来。）
//
//   最初的实现是"把**所有**摆放物件的材质都打上补丁"，理由写成"uHoleCount=0 时只是
//   一次 uniform 比较，几乎免费" —— 只看 CPU 侧成本，漏掉了"shader 里存在 discard
//   这件事本身就让整个材质丢掉 early-Z"。于是一个洞污染了全场景的材质。
//
// 正确行为：**只给包围盒真的碰到洞盒的物件打补丁**，其余保持原生材质。
//
// 跑法：node tools/probe-hole-patch-scope.mjs
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

const THREE = await import('three');
const FW = await import(pathToFileURL(path.join(ROOT, 'src/world/FakeWindow.js')).href);
const eb = fs.readFileSync(path.join(ROOT, 'src/world/EditorBuildings.js'), 'utf8');
const ed = fs.readFileSync(path.join(ROOT, 'src/editor/EditorApp.js'), 'utf8');

// 造一栋"楼"：一个带几何的 mesh（Box3.setFromObject 需要真的 boundingBox）
function mkBuilding(x, y, z, size) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), new THREE.MeshStandardMaterial());
  m.position.set(x, y, z);
  m.updateMatrixWorld(true);
  return m;
}

// ---------------------------------------------------------------- ① 导出
console.log('\n[1] 空间筛选 API 导出齐全');
for (const n of ['holeAabbOf', 'objectTouchesAnyHole', 'invalidateHoleBox']) ok(n in FW, `导出 ${n}`);

// ---------------------------------------------------------------- ② holeAabbOf
console.log('\n[2] holeAabbOf：洞盒的世界 AABB');
{
  const win = { x: 10, y: 3, z: -5, rotX: 0, rotY: 0, rotZ: 0, xw: 2, xh: 1 };
  const a = FW.holeAabbOf(win, 1.2);
  ok(a.minX < a.maxX && a.minY < a.maxY && a.minZ < a.maxZ, 'AABB 是合法的（min < max）');
  // ⚠ 用绝对值比较，别写 `min <= 期望 - eps`：那样等号在浮点边界上会翻向反侧（本探针踩过）。
  ok(Math.abs(a.minX - 9) < 1e-9 && Math.abs(a.maxX - 11) < 1e-9, 'X 方向精确包住窗户宽度（±w/2）');
  ok(Math.abs(a.minZ - (-5.6)) < 1e-9 && Math.abs(a.maxZ - (-4.4)) < 1e-9, 'Z 方向精确包住洞厚（±depth/2）');
  // 与 computeHoleBox 必须同源（否则筛选和实际挖洞位置会错位）
  const b = FW.computeHoleBox(win, 1.2);
  ok(Math.abs((a.maxX - a.minX) - b.hx * 2) < 1e-9, '尺寸与 computeHoleBox 完全一致（同源，不会错位）');
}

// ---------------------------------------------------------------- ③ 核心：只命中碰得到的
console.log('\n[3] 只给"包围盒碰到洞盒"的物件打补丁（核心）');
{
  const win = { x: 0, y: 2, z: 0, rotX: 0, rotY: 0, rotZ: 0, xw: 2, xh: 1.5 };
  const aabbs = [FW.holeAabbOf(win, 1.2)];

  const near = mkBuilding(0, 2, 0, 3);       // 洞就在它身上
  const neighbor = mkBuilding(4, 2, 0, 3);   // 隔壁（紧邻，可能也被挖到 → 允许命中）
  const far = mkBuilding(200, 2, 200, 3);    // 200m 外

  ok(FW.objectTouchesAnyHole(near, aabbs, 0.5) === true, '洞所在的建筑 → 命中（必须打补丁）');
  ok(FW.objectTouchesAnyHole(far, aabbs, 0.5) === false, '200m 外的建筑 → 不命中（这才是省下来的）');
  // 紧邻那栋：距离 4-1.5=2.5m 空隙，pad 0.5 不够 → 不该命中
  ok(FW.objectTouchesAnyHole(neighbor, aabbs, 0.5) === false, '2.5m 外的邻居 → 不命中');

  // 数量级对比：这是本次修复的全部意义
  const many = [];
  for (let i = 0; i < 40; i++) many.push(mkBuilding(i * 30 + 100, 2, 0, 6));
  const hitCount = [near, ...many].filter((o) => FW.objectTouchesAnyHole(o, aabbs, 0.5)).length;
  eq(hitCount, 1, `41 栋楼里只有 1 栋被打补丁（修复前是 41 栋 → early-Z 全丢）`);
}

// ---------------------------------------------------------------- ④ 边界与缓存
console.log('\n[4] 边界情况与缓存');
{
  const win = { x: 0, y: 0, z: 0, rotX: 0, rotY: 0, rotZ: 0, xw: 1, xh: 1 };
  const aabbs = [FW.holeAabbOf(win, 1.0)];

  ok(FW.objectTouchesAnyHole(null, aabbs, 0.5) === false, 'obj 为 null → false（不炸）');
  ok(FW.objectTouchesAnyHole(mkBuilding(0, 0, 0, 1), [], 0.5) === false, '没有洞 → false（无洞时不该打任何补丁）');

  // 空对象（模型还没加载完）：返回 false 且**不缓存**，等下次再试
  const empty = new THREE.Group();
  empty.updateMatrixWorld(true);
  eq(FW.objectTouchesAnyHole(empty, aabbs, 0.5), false, '空节点（模型未加载）→ false');
  eq(empty.userData.__holeBox3, undefined, '空节点不缓存包围盒（下次还会重试，不会永久漏掉）');

  // 正常对象要缓存（避免每次 syncHoles 都遍历几万顶点）
  const b1 = mkBuilding(0, 0, 0, 2);
  FW.objectTouchesAnyHole(b1, aabbs, 0.5);
  ok(!!b1.userData.__holeBox3, '命中判定后包围盒已缓存');
  const cached = b1.userData.__holeBox3;
  FW.objectTouchesAnyHole(b1, aabbs, 0.5);
  ok(b1.userData.__holeBox3 === cached, '第二次复用同一份缓存（不重算）');

  // 移动后必须能失效，否则筛选会按旧位置判断 → 漏打/错打
  FW.invalidateHoleBox(b1);
  eq(b1.userData.__holeBox3, undefined, 'invalidateHoleBox 清掉了缓存');
  ok(/invalidateHoleBox\(rec\.obj\)/.test(ed), '编辑器在物体变换变化时调用了 invalidateHoleBox');
}

// ---------------------------------------------------------------- ⑤ 源码接线
console.log('\n[5] 两端都做了筛选 + 都有兜底');
{
  ok(/objectTouchesAnyHole\(h, aabbs, 0\.5\)/.test(eb), '游戏端 applyEditorHoles 用包围盒筛选');
  ok(/objectTouchesAnyHole\(rec\.obj, aabbs, 0\.5\)/.test(ed), '编辑器 collectHoleTargets 用包围盒筛选');
  ok(/holeAabbOf\(w, HOLE_DEPTH\)/.test(eb) && /holeAabbOf\(w, HOLE_DEPTH\)/.test(ed), '两端都用 holeAabbOf 生成洞盒');

  // 兜底：万一一栋都没筛到（模型未加载完）也不能"不出洞"
  ok(/回退为全量打补丁/.test(eb), '游戏端有"筛不到就全量"的兜底');
  ok(/回退为全量打补丁/.test(ed), '编辑器有同样的兜底');

  // 反向：确保没人把筛选删回"全量"
  ok(!/收集范围：本函数把\*\*所有编辑器摆放的物件\*\*/.test(eb), '旧的"全量打补丁"注释与实现已移除');

  // 收集函数必须在筛选**之后**才 traverse（否则等于没筛）
  const iCheck = eb.indexOf('objectTouchesAnyHole(h, aabbs, 0.5)');
  const iCollect = eb.indexOf('const collect = (h) => {');
  ok(iCheck > 0 && iCollect > 0 && iCollect < iCheck, '先定义 collect，再在筛选中调用（结构正确）');
}

// ---------------------------------------------------------------- ⑥ 洞消失后必须撤销补丁
console.log('\n[6] 洞全没了必须把补丁撤掉（否则材质永远带着 discard、永远丢 early-Z）');
{
  ok('unpatchAllHoleMaterials' in FW, '导出 unpatchAllHoleMaterials');

  const mat = new THREE.MeshStandardMaterial();
  const original = mat.onBeforeCompile;
  const patched = FW.patchBuildingMaterial(mat);
  eq(patched, true, '先给材质打上补丁');
  ok(mat.onBeforeCompile !== original, 'onBeforeCompile 已被包装');
  // 反证：包装后的 shader 里会有 discard 判定
  {
    const shader = { vertexShader: '#include <fog_vertex>\n', fragmentShader: '#include <clipping_planes_fragment>\n', uniforms: {} };
    mat.onBeforeCompile(shader);
    ok(shader.fragmentShader.includes('discard'), '打补丁后 shader 里确实出现了 discard（early-Z 会被放弃）');
  }
  eq(FW.patchBuildingMaterial(mat), false, '重复打补丁被拒绝（不会两层包装）');

  // 洞数 = 0 → 自动撤销
  const st = FW.applyWindowHoles([], [mat], [], {});
  eq(st.count, 0, 'applyWindowHoles 收到空洞列表 → count = 0');
  ok(st.restored >= 1, `撤销了 ${st.restored} 个材质`);
  ok(mat.onBeforeCompile === original, 'onBeforeCompile 恢复成了原函数（身份一致）');

  // 恢复后重新注入判定：不再有 discard
  {
    const shader = { vertexShader: '#include <fog_vertex>\n', fragmentShader: '#include <clipping_planes_fragment>\n', uniforms: {} };
    mat.onBeforeCompile(shader);
    ok(!shader.fragmentShader.includes('discard'), '恢复后 shader 里不再有 discard（early-Z 回来了）');
  }

  // 撤销后还能重新打（可反复开关）
  eq(FW.patchBuildingMaterial(mat), true, '撤销后可以重新打补丁（勾选/取消可反复）');
  const st2 = FW.applyWindowHoles([], [mat], [], {});
  ok(st2.restored >= 1 && mat.onBeforeCompile === original, '再撤一次仍然正确恢复');

  // 有洞时**不能**误撤
  const mat2 = new THREE.MeshStandardMaterial();
  const orig2 = mat2.onBeforeCompile;
  FW.applyWindowHoles([{ x: 0, y: 0, z: 0, rotX: 0, rotY: 0, rotZ: 0, xw: 1, xh: 1 }], [mat2], [], {});
  ok(mat2.onBeforeCompile !== orig2, '有洞时正常打补丁（没被误撤）');
  FW.applyWindowHoles([], [], [], {}); // 收尾：清干净，避免影响后续用例

  // resetHolePatches 也要先恢复再清表
  const src = fs.readFileSync(path.join(ROOT, 'src/world/FakeWindow.js'), 'utf8');
  const iReset = src.indexOf('export function resetHolePatches()');
  ok(iReset > 0 && /unpatchAllHoleMaterials\(\)/.test(src.slice(iReset, iReset + 300)),
    'resetHolePatches 内部调了 unpatchAllHoleMaterials（只清表会永久恢复不回去）');
}

console.log('\n' + (fails ? `✗ ${fails} 项失败` : '✓ 全部通过'));
process.exit(fails ? 1 : 0);
