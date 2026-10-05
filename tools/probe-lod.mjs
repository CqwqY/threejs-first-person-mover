// 自检：距离分级（src/world/Lod.js）
//   node tools/probe-lod.mjs
//
// 为什么要有这个：分级靠的是「包围球最近点距离」和两个阈值，一旦算错（比如用了中心距、
// 或者大对象的放宽公式写反），表现是「远处的东西该消失没消失 / 一转头整栋楼没了」——
// 这种错误在浏览器里很难稳定复现，用几个方块 + 几个距离直接断言最省事。
import * as THREE from 'three';
import { registerLodTarget, clearLodTargets, updateLod } from '../src/world/Lod.js';

let fail = 0;
function check(name, got, want) {
  const ok = got === want;
  if (!ok) fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + name + ' = ' + got + (ok ? '' : '（期望 ' + want + '）'));
}

function makeObj(size, x, z) {
  const g = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), new THREE.MeshBasicMaterial());
  mesh.castShadow = true;
  g.add(mesh);
  g.position.set(x, 0, z);
  return g;
}
const meshOf = (g) => g.children[0];

// --- 小物件（边长 2 → 半径约 1.7）：shadowDist≈93 / hideDist≈245 ---
console.log('小物件（2m 方块，位于原点）：');
clearLodTargets();
const small = makeObj(2, 0, 0);
registerLodTarget(small);

updateLod(new THREE.Vector3(10, 0, 0), true);          // 10m
check('10m 可见', small.visible, true);
check('10m 投影', meshOf(small).castShadow, true);

updateLod(new THREE.Vector3(150, 0, 0), true);         // 150m（>93 → 不投影）
check('150m 可见', small.visible, true);
check('150m 不投影', meshOf(small).castShadow, false);

updateLod(new THREE.Vector3(300, 0, 0), true);         // 300m（>245 → 隐藏）
check('300m 隐藏', small.visible, false);

// --- 大物件（边长 200 → 半径约 173）：阈值按尺寸放宽 ---
//   shadowDist = 90 + min(173*2, 160) = 250；hideDist = 240 + min(173*3, 360) = 600
//   所以「最近点距离」要超过 600 才会隐藏：相机在 700m 时最近点只有 527m，仍然可见（符合预期）。
console.log('大物件（200m 方块，位于原点，半径≈173）：');
clearLodTargets();
const big = makeObj(200, 0, 0);
registerLodTarget(big);
updateLod(new THREE.Vector3(400, 0, 0), true);         // 最近点 ≈ 227m < 250 → 还投影
check('400m 仍可见（阈值按尺寸放宽）', big.visible, true);
check('400m 还投影', meshOf(big).castShadow, true);
updateLod(new THREE.Vector3(700, 0, 0), true);         // 最近点 ≈ 527m：可见但不投影
check('700m 可见', big.visible, true);
check('700m 不投影', meshOf(big).castShadow, false);
updateLod(new THREE.Vector3(900, 0, 0), true);         // 最近点 ≈ 727m > 600 → 隐藏
check('900m 隐藏', big.visible, false);

// --- 原本不投影的网格：分级不能把它打开 ---
console.log('原本 castShadow=false 的网格：');
clearLodTargets();
const noShadow = makeObj(2, 0, 0);
meshOf(noShadow).castShadow = false;
registerLodTarget(noShadow);
updateLod(new THREE.Vector3(5, 0, 0), true);
check('近处也不会被强行打开投影', meshOf(noShadow).castShadow, false);

console.log(fail ? ('\n✗ ' + fail + ' 项不符') : '\n✓ 全部通过');
process.exit(fail ? 1 : 0);
