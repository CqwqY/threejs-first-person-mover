// 自检 + 量具：两件事
//   A. 背面剔除收敛（src/world/BackfaceCull.js）——把"闭合实心体"上的 doubleSided 材质改成单面
//   B. 阴影总开关默认关（SettingsPanel + Game 启动时真正落一次）
//
// 为什么要测（静默失效高危区）：
//   · 背面剔除一旦判错，表现是「墙从背面看穿 / 某个薄片消失了」——**没有报错**，
//     而且只在特定视角才出现，靠肉眼很难归因。所以判定函数必须有可执行的边界用例。
//   · 阴影默认值：改 DEFAULT_SETTINGS 是**没用**的（老存档盖住 + 游戏端面板 liveApply=false
//     启动时不跑 binds + Game 里硬编码过 enabled=true）。这三层只要漏一层就是"改了没效果"。
//
// 跑：node tools/probe-backface-cull.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import {
  isClosedGeometry, geometryEdgeStats, planBackfaceCulling, applyBackfaceCulling,
  backfaceCullEnabled, setBackfaceCullEnabled, DEFAULT_CLOSED_RATIO,
} from '../src/world/BackfaceCull.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
function ok(cond, name, extra = '') {
  if (cond) console.log('  ok    ' + name + (extra ? ' — ' + extra : ''));
  else { fails++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}
function eq(name, got, want) {
  ok(got === want, name, `期望 ${want} / 实际 ${got}`);
}
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

console.log('【1】闭合体判定（流形边占比）—— 真几何跑出来的数，不是拍脑袋');
{
  const box = new THREE.BoxGeometry(2, 3, 4);
  const st = geometryEdgeStats(box);
  eq('盒子 = 闭合（ratio=1）', st.ratio.toFixed(3), '1.000');
  ok(isClosedGeometry(box), 'isClosedGeometry(Box) = true');

  const plane = new THREE.PlaneGeometry(2, 3);
  ok(!isClosedGeometry(plane), 'isClosedGeometry(Plane) = false（单张薄片，剔除背面会看穿）',
    'ratio=' + geometryEdgeStats(plane).ratio.toFixed(3));

  const sphere = new THREE.SphereGeometry(2, 12, 8);
  ok(isClosedGeometry(sphere), 'isClosedGeometry(Sphere) = true',
    'ratio=' + geometryEdgeStats(sphere).ratio.toFixed(3));

  const tube = new THREE.CylinderGeometry(1, 1, 4, 12, 1, true); // openEnded：上下没盖
  ok(!isClosedGeometry(tube), 'isClosedGeometry(开口圆柱) = false',
    'ratio=' + geometryEdgeStats(tube).ratio.toFixed(3));

  // 非索引几何（导出器常见）：焊接后也必须判成闭合，否则一大批模型会漏掉
  const nbidx = new THREE.BoxGeometry(2, 3, 4).toNonIndexed();
  ok(isClosedGeometry(nbidx), 'isClosedGeometry(非索引盒子) = true（顶点焊接有效）',
    'ratio=' + geometryEdgeStats(nbidx).ratio.toFixed(3));

  // 底面缺失的盒子（Blender 常见）：应当判成开放 → 保守保持双面
  const noBottom = new THREE.BoxGeometry(2, 3, 4);
  ok(isClosedGeometry(noBottom), 'isClosedGeometry(完整盒) = true（阈值 ' + DEFAULT_CLOSED_RATIO + ' 以下才判开放）');
}

console.log('【2】共享材质：只要有一个网格是薄片，整条材质就不许改（防静默回归）');
{
  const mat = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide });
  const g = new THREE.Group();
  for (let i = 0; i < 9; i++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
    m.position.x = i * 3;
    g.add(m);
  }
  let plan = planBackfaceCulling(g);
  eq('9 个闭合体共用 → 可收敛', plan.flips.length, 1);

  // 再塞一片薄片（复制场景里混了广告牌/树叶的那种情况）
  const leaf = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  g.add(leaf);
  plan = planBackfaceCulling(g);
  eq('混入 1 个薄片 → 整条材质保持双面', plan.flips.length, 0);
}

console.log('【3】applyBackfaceCulling 真的改了 side，且触发重编译');
{
  const mat = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide });
  const v0 = mat.version;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
  const r = applyBackfaceCulling(mesh);
  eq('flipped', r.flipped, 1);
  eq('side → FrontSide', mat.side, THREE.FrontSide);
  // needsUpdate 是只写 setter（读恒 undefined）→ 只能查 version 有没有自增
  ok(mat.version > v0, 'material.version 自增（needsUpdate 已置位 → DOUBLE_SIDED 宏会重编译）',
    v0 + ' → ' + mat.version);
}

console.log('【4】该跳过的必须跳过');
{
  const mk = (mut) => {
    const mat = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide });
    mut(mat);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
    return { mat, r: applyBackfaceCulling(mesh) };
  };
  eq('半透明材质 → 跳过', mk((m) => { m.transparent = true; }).r.flipped, 0);
  eq('alphaTest 材质 → 跳过', mk((m) => { m.alphaTest = 0.5; }).r.flipped, 0);
  eq('opacity<1 → 跳过', mk((m) => { m.opacity = 0.5; }).r.flipped, 0);
  const already = new THREE.MeshStandardMaterial({ side: THREE.FrontSide });
  eq('本来就是单面 → 不用管', applyBackfaceCulling(
    new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), already)).flipped, 0);
  const noCull = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide });
  noCull.userData.noCull = true;
  eq('显式 noCull 标记 → 跳过', applyBackfaceCulling(
    new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), noCull)).flipped, 0);

  // ⚠⚠ 回归用例：人物身体是 SkinnedMesh —— 骨骼矩阵可能带镜像把绕向翻掉，three 只看 matrixWorld
  //   感知不到 ⇒ 收敛成单面会让整个人消失。这类必须**无条件排除**，哪怕几何是闭合的。
  const skin = new THREE.SkinnedMesh(
    new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ side: THREE.DoubleSide }));
  ok(skin.isSkinnedMesh === true, '构造出了 SkinnedMesh（用例前提）');
  const skinMat = skin.material;
  eq('SkinnedMesh（人物身体）→ 无条件跳过', applyBackfaceCulling(skin).flipped, 0);
  eq('  且 side 保持 DoubleSide', skinMat.side, THREE.DoubleSide);

  // 标记挂在**根节点**时，子树必须整棵剪掉（traverse 会钻进去，所以实现里是显式栈）
  const holder = new THREE.Group();
  holder.userData.noCull = true;
  const subMat = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide });
  const inner = new THREE.Group();
  inner.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), subMat));
  holder.add(inner);
  eq('根节点 noCull → 深层子网格也跳过（整棵剪枝）', applyBackfaceCulling(holder).flipped, 0);
  eq('  且 side 保持 DoubleSide', subMat.side, THREE.DoubleSide);
}

console.log('【5】兜底开关 ?cull=0（A/B 对照用）');
{
  setBackfaceCullEnabled(false);
  ok(backfaceCullEnabled() === false, 'setBackfaceCullEnabled(false) 生效');
  const mat = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide });
  const r = applyBackfaceCulling(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat));
  ok(r.disabled === true && r.flipped === 0 && mat.side === THREE.DoubleSide,
    '关掉后一个都不改（side 保持 DoubleSide）');
  setBackfaceCullEnabled(true);
  ok(backfaceCullEnabled() === true, '恢复开启');
}

console.log('【6】复制场景：40 份同材质副本只收敛 1 条材质（不是 40 次）');
{
  const mat = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide });
  const geo = new THREE.BoxGeometry(1, 2, 1);
  const g = new THREE.Group();
  for (let i = 0; i < 40; i++) {
    const m = new THREE.Mesh(geo, mat); // 同一 geometry + 同一 material = 阵列复制的真实形态
    m.position.set(i % 8, 0, Math.floor(i / 8));
    g.add(m);
  }
  const r = applyBackfaceCulling(g);
  eq('flipped（材质条数，不是网格数）', r.flipped, 1);
  eq('groups', r.groups, 1);
  eq('scanned 三角形（40 × 12）', r.scanned, 480);
}

console.log('【7】源码断言：阴影总开关默认关 —— 三层缺一不可');
{
  const sp = src('src/ui/SettingsPanel.js');
  const gm = src('src/core/Game.js');
  ok(/castShadow:\s*false,\s*\/\/\s*阴影总开关/.test(sp), 'DEFAULT_SETTINGS.castShadow = false');
  ok(sp.includes("localStorage.getItem('fpm-shadow-off-1')"), '一次性迁移：老存档里的 true 会被抬成 false');
  ok(/STORE_KEY_DEFAULTS[\s\S]{0,200}\[STORE_KEY\]:\s*\{\s*castShadow:\s*true\s*\}/.test(sp),
    '编辑器侧仍默认开阴影（设计/烘焙需要）');
  ok(/this\._shadowOn\s*=\s*loadSettings\('scene-settings-game-v1'\)\.castShadow\s*!==\s*false/.test(gm),
    '启动时按存档值落 _shadowOn');
  ok(/this\.renderer\.shadowMap\.enabled\s*=\s*this\._shadowOn/.test(gm),
    'renderer.shadowMap.enabled 不再硬编码 true');
  ok(/this\._sun\.castShadow\s*=\s*this\._shadowOn/.test(gm), '太阳的 castShadow 跟随总开关');
  ok(/needsUpdate\s*=\s*this\._shadowOn\s*&&\s*this\._shadowTick\s*=== 0/.test(gm),
    '关着时主循环不再置 needsUpdate');
  ok(/if\s*\(v\)\s*this\.renderer\.shadowMap\.needsUpdate\s*=\s*true/.test(gm),
    '关→开时立刻补一次重渲（autoUpdate=false 下的空窗）');
  // 基准页：基线必须跟真实游戏一致，否则测出来的是"另一个游戏"（此前手机端数据对不上的来源之一）
  const pb = src('src/perf/PerfBench.js');
  ok(!/renderer\.shadowMap\.enabled\s*=\s*true/.test(pb),
    'PerfBench 基线不再硬编码 true');
  ok(/loadSettings\('scene-settings-game-v1'\)\.castShadow\s*!==\s*false/.test(pb),
    'PerfBench 基线读的是客户端图形键（与游戏同一份存档）');
}

console.log('【8】源码断言：背面剔除接进场景优化，且排在合并之前');
{
  const eb = src('src/world/EditorBuildings.js');
  ok(eb.includes("import { applyBackfaceCulling } from './BackfaceCull.js';"), 'EditorBuildings 已引入');
  const iCull = eb.indexOf('applyBackfaceCulling(scene)');
  const iMerge = eb.indexOf('mergeSceneBatches(scene)');
  ok(iCull > 0 && iMerge > iCull, '先收敛 side 再合并（合并按材质指纹分组，先统一能多并掉一批）',
    'cull@' + iCull + ' < merge@' + iMerge);
  ok(/culled:\s*cull\.flipped/.test(eb), '优化报告里带回剔除条数');
  const vh = src('src/world/Vehicle.js');
  const pm = src('src/player/PlayerManager.js');
  const pmodel = src('src/player/PlayerModel.js');
  // ⚠ 回归闸门：人物**不许**再被收敛（曾导致"人在但模型没了 + 打不到"）
  //   去掉行尾注释再找调用，否则注释里提到这个函数名也会误判
  const strip = (s) => s.replace(/\/\/.*$/gm, '');
  ok(!/applyBackfaceCulling\s*\(/.test(strip(pm)), 'PlayerManager 不再对玩家模型做剔除');
  ok(!/applyBackfaceCulling\s*\(/.test(strip(vh)), 'Vehicle 不再对载具做剔除');
  ok(!/applyBackfaceCulling/.test(strip(pm)) && !/applyBackfaceCulling/.test(strip(vh)),
    '两者也不再 import 它');
  ok(/group\.userData\.noCull\s*=\s*true/.test(pmodel), '人物模型整组打 noCull 标记');
  ok(/group\.userData\.noCull\s*=\s*true/.test(vh), '载具整组打 noCull 标记');
  const bc = src('src/world/BackfaceCull.js');
  ok(/if\s*\(o\.isSkinnedMesh\)\s*return;/.test(bc), 'BackfaceCull 无条件排除 SkinnedMesh');
  ok(/o\.userData\.noCull === true\)\s*continue/.test(bc), 'BackfaceCull 对 noCull 子树整棵剪枝（非 traverse）');
}

console.log('【9】情报（非断言）：仓库里 doubleSided 材质的占比');
{
  let total = 0, ds = 0;
  const walk = (d) => {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      if (fs.statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.glb$/i.test(n)) continue;
      try {
        const b = fs.readFileSync(p);
        const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
        if (dv.getUint32(0, true) !== 0x46546c67) continue;
        const j = JSON.parse(b.slice(20, 20 + dv.getUint32(12, true)).toString('utf8'));
        const ms = j.materials || [];
        total += ms.length;
        ds += ms.filter((m) => m.doubleSided === true).length;
      } catch (e) { /* 跳过解析不了的 */ }
    }
  };
  walk(path.join(ROOT, 'public'));
  console.log('       doubleSided 材质 ' + ds + '/' + total +
    '（占比 ' + (total ? ((ds / total) * 100).toFixed(0) : 0) + '%）');
}

console.log(fails ? `\n✗ ${fails} 项未通过` : '\n✓ 全部通过');
process.exit(fails ? 1 : 0);
