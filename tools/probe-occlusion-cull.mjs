// 自检：遮挡剔除（OcclusionCull）——「被挡住的别画，能看见的一个都不能少」
//
// 用户提的思路来自 Minecraft：只渲染玩家看得见的部分。MC 是三层（面剔除 / 分块 / 遮挡剔除），
// 本模块补的是第三层。它的风险不在"省不下来"，而在**误剔** —— 少画一个能看见的东西比多画十个
// 更致命，所以这里每一条用例都在钉"该剔的剔掉、不该剔的必须留下"。
//
// ⚠ 两条必须世代相传的红线（都踩过）：
//   ① 只能用 layers 关渲染，**绝不能动 visible** —— trimesh 的 collectMeshes 有一句
//      `if (!isVisible(o)) return;`：不可见的网格不参与碰撞烘焙，一改就是「碰撞整块消失」。
//   ② three 的阴影 pass 看 **light.layers** 而不是 camera.layers，只关 layers 挡不住投影
//      ⇒ 剔除时必须同时关 castShadow，否则留下「墙上没物体却有它的影子」。
//
// 跑：node tools/probe-occlusion-cull.mjs（退出码非 0 = 有回归）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import {
  scanOcclusion, updateOcclusion, resetOcclusion, occlusionStats, occlusionCandidates,
  setOcclusionEnabled, occlusionEnabled, OCC_TILE, OCC_MAX_SIZE, OCC_TOP_OCCLUDERS,
} from '../src/world/OcclusionCull.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
function ok(cond, name, extra = '') {
  if (cond) console.log('  ok    ' + name + (extra ? ' — ' + extra : ''));
  else { fails++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = (s) => s.replace(/\/\/.*$/gm, '');
// 花括号配对抽函数体：⚠ 不能用 slice(indexOf(...)) 一路扫到文件末尾 —— 会把后面新加的函数
// 也断言进去（探针假阳性踩过）。必须从 `{` 起配对到对应的 `}`。
function blockAt(s, i) {
  if (i < 0) return '';
  let d = 0;
  const start = s.indexOf('{', i);
  if (start < 0) return '';
  for (let k = start; k < s.length; k++) {
    if (s[k] === '{') d++;
    else if (s[k] === '}') { d--; if (d === 0) return s.slice(start, k + 1); }
  }
  return '';
}

// ---------------------------------------------------------------------------
console.log('\n【1】源码红线：不许碰 visible；layers + castShadow + 标记三件套齐全');
{
  const s = strip(src('src/world/OcclusionCull.js'));
  ok(!/\.visible\s*=/.test(s), '本模块没有任何 visible 赋值（会毁掉碰撞烘焙）');
  ok(/layers\.disable\(0\)/.test(s) && /layers\.enable\(0\)/.test(s), '用 layers 的 enable/disable(0) 开关渲染');
  ok(/__occHidden\s*=\s*true/.test(s) && /__occHidden\s*=\s*false/.test(s), '写 userData.__occHidden 标记');
  ok(/castShadow\s*=\s*false/.test(s), '剔除时同时关掉 castShadow（防"无物有影"）');
  ok(/baseCast/.test(s), '记录 baseCast 以便恢复');
  ok(/OCC_MAX_SIZE/.test(src('src/world/OcclusionCull.js')), '有 OCC_MAX_SIZE 这条安全线（地面/天空不得当遮挡体）');
  ok(typeof OCC_TILE === 'number' && OCC_TILE >= 8 && OCC_TILE <= 128, 'OCC_TILE 合理', String(OCC_TILE));
  ok(OCC_MAX_SIZE > 0 && OCC_TOP_OCCLUDERS > 0, '常量已导出', `MAX_SIZE=${OCC_MAX_SIZE} TOP=${OCC_TOP_OCCLUDERS}`);
}

console.log('\n【2】接线：剔除跑在 Lod 之后，异常要兜底 + 报出来');
{
  const g = strip(src('src/core/Game.js'));
  ok(/import \{[\s\S]*?scanOcclusion[\s\S]*?\} from '\.\.\/world\/OcclusionCull\.js'/.test(g), 'Game 引入了遮挡剔除');
  ok(/updateLod\(this\.camera\.position\);[\s\S]{0,300}this\._updateOcclusion\(false\)/.test(g),
    '遮挡剔除跑在 updateLod 之后（两边都写 castShadow，必须让剔除最后拍板）');
  ok(/catch \(e\) \{[\s\S]{0,200}resetOcclusion\(\)/.test(g), '异常兜底：把剔除的东西全部放回来');
  ok(/console\.error\('\[occ\]/.test(g), '异常有 console.error（绝不静默）');
  const l = strip(src('src/world/Lod.js'));
  ok(/__occHidden/.test(l), 'Lod.js 的 castShadow 分级尊重 __occHidden（否则会把它设回 true）');
}

// ---------------------------------------------------------------------------
// 真跑：three 的相机投影不需要 WebGL，Node 里能算
// ---------------------------------------------------------------------------
function mkCamera(pos, lookAt) {
  const cam = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 500);
  cam.position.set(pos[0], pos[1], pos[2]);
  cam.lookAt(lookAt[0], lookAt[1], lookAt[2]);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
  return cam;
}
const mat = () => new THREE.MeshStandardMaterial({ color: 0x888888 });
function box(w, h, d, x, y, z, m) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m || mat());
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.updateMatrixWorld(true);
  return mesh;
}
const isHidden = (mesh) => !mesh.layers.test(new THREE.Layers());

// 相机在 (0,1.7,0) 看向 -Z：一堵墙挡住正后方的盒子，侧后方那个看得见
function sceneWall() {
  const scene = new THREE.Scene();
  const wall = box(6, 6, 0.6, 0, 3, -5);     // 遮挡体：近处的墙
  const behind = box(1, 1, 1, 0, 1, -12);    // 墙正后方 → 该剔
  const aside = box(1, 1, 1, 10, 1, -12);    // 墙侧后方（视线绕得过去）→ 该留
  scene.add(wall, behind, aside);
  return { scene, wall, behind, aside };
}

console.log('\n【3】真跑：墙后的剔掉、看得见的一个都不能少');
{
  setOcclusionEnabled(true);
  const { scene, behind, aside } = sceneWall();
  const cam = mkCamera([0, 1.7, 0], [0, 1.7, -1]);
  const n = scanOcclusion(scene);
  ok(n === 3, '三个网格都进了候选池', String(n));
  const culled = updateOcclusion(cam, true);
  const st = occlusionStats();
  ok(culled === 1, '只剔掉了 1 个（墙正后方那个）', `culled=${culled}`);
  ok(isHidden(behind), '墙正后方的盒子被剔除了');
  ok(!isHidden(aside), '墙侧后方（看得见）的盒子没有被剔除');
  ok(st.culledTris === 12, '剔除的三角面数 = 1 个盒子（12 个三角面）', String(st.culledTris));
  ok(st.occluders >= 1, '用到了遮挡体（那堵墙）', String(st.occluders));
  // 红线：visible 一个都不许动
  let visibleAll = true;
  scene.traverse((o) => { if (o.visible !== true) visibleAll = false; });
  ok(visibleAll, '全程没有任何 visible 被改成 false');
  // 影子：被剔的必须同时停投影，否则会留下"没有物体却有影子"
  ok(behind.castShadow === false, '被剔除的网格 castShadow 已关（防"无物有影"）');
  ok(aside.castShadow === true, '没被剔除的网格 castShadow 保持原样');
}

console.log('\n【4】恢复：resetOcclusion / 关闭功能都要把东西放回来');
{
  const { scene, behind } = sceneWall();
  const cam = mkCamera([0, 1.7, 0], [0, 1.7, -1]);
  scanOcclusion(scene);
  updateOcclusion(cam, true);
  ok(isHidden(behind), '先确认它确实被剔了');
  resetOcclusion();
  ok(!isHidden(behind), 'resetOcclusion 后恢复渲染');
  ok(behind.castShadow === true, 'castShadow 也还原回原本的 true');
  ok(occlusionStats().culled === 0, '统计归零');
  // ?occ=0：关掉后再跑一次，必须自动全放回来（否则关了功能画面永远缺东西）
  updateOcclusion(cam, true); // 先剔一次
  ok(isHidden(behind), '（再剔一次）');
  setOcclusionEnabled(false);
  ok(occlusionEnabled() === false, 'occlusionEnabled() 反映开关');
  updateOcclusion(cam, true);
  ok(!isHidden(behind), '功能关闭后自动全部恢复渲染');
  setOcclusionEnabled(true);
}

console.log('\n【5】安全线：地面 / 天空这种巨型 AABB 不能当遮挡体（否则全场被剔光）');
{
  const { scene, behind, aside } = sceneWall();
  const ground = box(200, 0.2, 200, 0, -0.1, 0); // 对角线 ≈ 283m
  scene.add(ground);
  const cam = mkCamera([0, 1.7, 0], [0, 1.7, -1]);
  const n = scanOcclusion(scene);
  updateOcclusion(cam, true);
  const st = occlusionStats();
  ok(!isHidden(ground), '地面自己没被剔（超过 OCC_MAX_CAND）');
  ok(!isHidden(aside), '有地面在场时，看得见的盒子仍然没被剔');
  ok(isHidden(behind), '墙后那个照样被剔（地面没有抢走遮挡判定）');
  ok(st.occluders >= 1 && st.occluders <= OCC_TOP_OCCLUDERS, '遮挡体数量在上限内', String(st.occluders));
  ok(n === 4 || n === 3, '地面按尺寸被排除或保留为不可剔候选', '候选=' + n);
  resetOcclusion();
}

console.log('\n【6】相机贴着 / 钻进遮挡体时：不许乱剔');
{
  const { scene, behind, aside } = sceneWall();
  // 相机移到墙内部：这堵墙不能当遮挡体（否则身边的人和物会被整片剔掉）
  const camIn = mkCamera([0, 3, -5], [0, 3, -20]);
  scanOcclusion(scene);
  updateOcclusion(camIn, true);
  const st = occlusionStats();
  ok(st.occluders === 0, '相机在墙里 → 这堵墙不当遮挡体', String(st.occluders));
  ok(!isHidden(behind) && !isHidden(aside), '此时一个都不剔');
  // 贴脸（< OCC_NEAR）的小盒子永远不剔
  const s2 = new THREE.Scene();
  const near = box(1, 1, 1, 0, 1.7, -3);
  const big = box(6, 6, 0.6, 0, 3, -1.2); // 贴脸的大墙（相机几乎贴着它）
  s2.add(near, big);
  const cam2 = mkCamera([0, 1.7, 0], [0, 1.7, -1]);
  scanOcclusion(s2);
  updateOcclusion(cam2, true);
  ok(!isHidden(near), '离相机很近的东西永不剔除');
  resetOcclusion();
}

console.log('\n【7】不参与的对象：蒙皮网格 / 半透明 / 显式排除标记');
{
  const scene = new THREE.Scene();
  const skin = new THREE.SkinnedMesh(new THREE.BoxGeometry(1, 2, 1), mat());
  skin.position.set(0, 1, -12);
  skin.updateMatrixWorld(true);
  const glass = box(2, 2, 2, 0, 1, -12, new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.5 }));
  const skip = box(2, 2, 2, 0, 1, -12, mat());
  skip.userData.__noOcc = true;
  const plain = box(2, 2, 2, 0, 1, -12, mat());
  scene.add(skin, glass, skip, plain);
  const n = scanOcclusion(scene);
  ok(n === 1, '只有普通不透明网格进了候选池（蒙皮/半透明/__noOcc 都排除）', '候选=' + n);
  resetOcclusion();
}

console.log('\n【8】相机没动时不重算（节流），动了才重算');
{
  const { scene, behind } = sceneWall();
  const cam = mkCamera([0, 1.7, 0], [0, 1.7, -1]);
  scanOcclusion(scene);
  updateOcclusion(cam, true);
  ok(isHidden(behind), '先剔掉');
  resetOcclusion();
  // 不传 force 且相机没动 → 不应重算（behind 保持"没被剔"的状态）
  updateOcclusion(cam, false);
  ok(!isHidden(behind), '相机没动 → 跳过重算（不重复写状态）');
  // 相机移动足够远 → 重算
  cam.position.set(0, 1.7, 6);
  cam.updateMatrixWorld(true);
  updateOcclusion(cam, false);
  ok(true, '相机移动后重算不抛错', 'culled=' + occlusionStats().culled);
  resetOcclusion();
}

console.log('\n【9】整棵子树剪枝：noCull 挂在根节点时，下面的网格一个都不许进候选池');
{
  // 源码红线：scanOcclusion 不许用 root.traverse（traverse 会钻进标了 noCull 的 group 里）
  const occSrc = src('src/world/OcclusionCull.js');
  const sBody = blockAt(occSrc, occSrc.indexOf('export function scanOcclusion(root) {'));
  ok(!/\.traverse\(/.test(sBody), 'scanOcclusion 不用 root.traverse（否则会钻进 noCull 子树）');
  ok(/stack\.push\(/.test(sBody), 'scanOcclusion 用显式栈，便于整棵剪掉子树');

  // 真跑：人物 group 根挂 noCull，身下挂 3 个普通不透明网格
  const scene = new THREE.Scene();
  const player = new THREE.Group();
  player.userData.noCull = true;
  const m1 = box(0.5, 1.8, 0.3, 0, 0.9, 0);
  const m2 = box(0.4, 0.4, 0.4, 0, 1.6, 0);
  const m3 = box(0.3, 0.3, 0.3, 0, 0.2, 0);
  player.add(m1, m2, m3);
  // 子网格自己**没有**标记 —— 只有根节点有：这正是 traverse 会漏、显式栈不会漏的场景
  ok(!m1.userData.noCull && !m2.userData.noCull, '子网格自身没有标记（只有根节点有）');
  scene.add(player);

  const wall = box(6, 6, 0.6, 0, 3, -12); // 一面普通墙，它应该进池
  scene.add(wall);

  const n = scanOcclusion(scene);
  ok(n === 1, '人物整棵子树被剪掉，只剩墙进候选池', '候选=' + n);
  ok(!isHidden(m1) && !isHidden(m2) && !isHidden(m3), '人物身上的网格永远不会被剔（layers 没被动）');
  resetOcclusion();

  // 反过来：根节点没标记时，子网格正常进池（别把剪枝写成"全剪"）
  const s2 = new THREE.Scene();
  const g2 = new THREE.Group();
  const c1 = box(2, 2, 2, 0, 1, -12);
  g2.add(c1);
  s2.add(g2);
  ok(scanOcclusion(s2) === 1, '没标记的 group 下面的网格正常进池', '候选=' + scanOcclusion(s2));
  resetOcclusion();
}

console.log('\n【10】天空球壳必须排除遮挡剔除（否则夜晚剔球壳→露出近黑 background = 天变暗/闪白）');
{
  // 源码红线：SkyBox 必须在两处都打 __noOcc —— ① 程序化兜底天空（createSky）② 四张时段球壳
  const skySrc = src('src/world/SkyBox.js');
  let nMark = (skySrc.match(/__noOcc\s*=\s*true/g) || []).length;
  ok(nMark >= 2, 'SkyBox 给天空网格打了 __noOcc（程序化天空 + 时段球壳）', '标记数=' + nMark);

  // ⚠ 这个 bug 的真实形态：球壳扫描期是 radius=1 的小球壳在原点，会被收进候选池，
  //   之后每帧跟着相机走、缩放到 far*0.92 —— 候选框是陈旧的 2m@原点快照，
  //   一旦那块落在某堵墙后面就整片被剔，露出 scene.background（夜晚 intensity≈0 = 近黑 → "天变暗"，
  //   白天 intensity=1 = 浅蓝 → "闪白"），相机一动重投影又恢复。
  const s = new THREE.Scene();
  const wall = box(6, 6, 0.6, 0, 3, -12); // 一面普通墙当遮挡体
  s.add(wall);
  // 「扫描期的小球壳在原点」：没打标记时，它会被收进候选池（这就是隐患本身）
  const domeBad = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial());
  domeBad.position.set(0, 0, 0);
  s.add(domeBad);
  const cam = mkCamera([0, 1.7, 0], [0, 1.7, -1]);
  const nBad = scanOcclusion(s);
  ok(nBad === 2, '未打标记的小球壳在原点会被收进候选池（隐患：扫描期球壳就是这个样子）', '候选=' + nBad);

  // 补上 __noOcc（SkyBox 现在的做法）→ 无论如何都不进池、绝不被剔
  domeBad.userData.__noOcc = true;
  const nFixed = scanOcclusion(s);
  ok(nFixed === 1, '__noOcc 的小球壳被排除，只剩墙进池', '候选=' + nFixed);
  updateOcclusion(cam, true);
  ok(!isHidden(domeBad), '__noOcc 的天空球壳永远不会被剔除（layers 没被动）');
  resetOcclusion();
}

console.log('\n【11】测试键：按下实时开关遮挡剔除（现场 A/B 比对误剔）');
{
  const g = src('src/core/Game.js');
  // Game 必须引入可手动开关的两个函数
  ok(/setOcclusionEnabled,\s*occlusionEnabled/.test(g), 'Game 引入了 setOcclusionEnabled/occlusionEnabled');
  // 绑定到 OCC_KEY（KeyO），按下即翻转当前开关
  ok(/Config\.OCC_KEY/.test(g) && /setOcclusionEnabled\(!occlusionEnabled\(\)\)/.test(g),
    '按下 OCC_KEY 翻转遮挡剔除开关（关掉后被剔的网格会重新出现 = 验证误剔）');
  const cfg = src('src/config.js');
  ok(/OCC_KEY:\s*'KeyO'/.test(cfg), 'Config 定义了 OCC_KEY=KeyO（与已占用的 F/Q/P/E/Y/T 不冲突）');
}

console.log('\n【12】误剔修复：参数更保守 + 静止自愈（修「能看见的也被剔」）');
{
  const occ = src('src/world/OcclusionCull.js');
  // 源码红线：OCC_BIAS 调到更保守、OCC_MIN_SIZE 抬高（小装饰不当遮挡体）、OCC_HEAL_FRAMES 静止自愈
  ok(/OCC_BIAS\s*=\s*0\.00[2-9]|OCC_BIAS\s*=\s*0\.0[1-9]/.test(occ),
    'OCC_BIAS 调到更保守（>=0.002，宁可少剔绝不误剔）');
  ok(/OCC_MIN_SIZE\s*=\s*[5-9]|OCC_MIN_SIZE\s*=\s*1[0-9]/.test(occ),
    'OCC_MIN_SIZE 抬高到 >=5（花盆/栏杆/小装饰不再当遮挡体误剔旁边）');
  ok(/OCC_HEAL_FRAMES/.test(occ), '定义了 OCC_HEAL_FRAMES（静止自愈帧数）');
  // updateOcclusion 必须有「相机没动也按 OCC_HEAL_FRAMES 周期强制重算」的分支
  const ub = blockAt(occ, occ.indexOf('export function updateOcclusion(camera, force) {'));
  ok(/_occFrame\s*\+\+/.test(ub), 'updateOcclusion 每帧自增帧计数');
  ok(/_occFrame\s*%\s*OCC_HEAL_FRAMES/.test(ub), '按 OCC_HEAL_FRAMES 取模强制重算（世界变了相机没动也自愈）');
}

console.log(`\n${fails === 0 ? '全部通过' : fails + ' 项失败'}`);
process.exit(fails === 0 ? 0 : 1);
