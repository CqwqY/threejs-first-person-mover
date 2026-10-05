// 自检：面光源的「阴影代理」聚光灯（tools 里跑：node tools/probe-areashadow.mjs）
//
// 为什么要测：Three 的 RectAreaLight **没有 shadow 字段**（LTC 不支持投影），
// 只能靠「贴一盏聚光灯代理」来投影。这里有三处极易写错、且在浏览器里很难稳定复现：
//   ① 光向 —— 代理必须沿面光源的**本地 -Z** 照射（rotX=-90° 应朝下）；
//   ② 亮度拆分 —— 总亮度要在「本体 + 代理」之间分，不能只加不减，也不能重复拆分越调越暗；
//   ③ 克隆 —— 组合家具走 proto.clone(true)，three 的 SpotLight.copy 把 target 拷成游离节点，
//      不重新挂回子树光向就会算错。
import * as THREE from 'three';
import {
  enableAreaShadow, syncAreaShadow, setAreaBaseIntensity, setAreaShadowDistance, isAreaShadowCasting,
  releaseAreaShadow, updateShadowBudgets, clearShadowBudgets, AREA_SHADOW_TUNING,
} from '../src/world/Lights.js';

const T = AREA_SHADOW_TUNING; // 亮度的旋钮（split/gain/angle）—— 期望值跟着真实常量走，改参数不用改自检

let fails = 0;
function check(name, got, want, eps = 1e-6) {
  const ok = (typeof want === 'number' && typeof got === 'number')
    ? Math.abs(got - want) <= eps
    : got === want;
  if (!ok) { fails++; console.log(`  ✗ ${name}\n      期望 ${want}\n      实际 ${got}`); }
  else console.log(`  ok    ${name} = ${typeof got === 'number' ? got.toFixed(4) : got}`);
}

const DEG = Math.PI / 180;
const scene = new THREE.Scene();

// ---------- ① 光向 ----------
console.log('① 代理必须沿面光源本地 -Z 照射：');
function dirOf(area) {
  scene.updateMatrixWorld(true);
  const proxy = area.children.find((c) => c.isSpotLight);
  const p = new THREE.Vector3(), t = new THREE.Vector3();
  proxy.getWorldPosition(p);
  proxy.target.getWorldPosition(t);
  return t.sub(p).normalize();
}
function vecEq(v, x, y, z) { return Math.abs(v.x - x) < 1e-4 && Math.abs(v.y - y) < 1e-4 && Math.abs(v.z - z) < 1e-4; }

{
  const a = new THREE.RectAreaLight(0xffffff, 5, 4, 3);
  a.rotation.order = 'YXZ';
  a.rotation.set(-90 * DEG, 0, 0); // 编辑器默认：垂直朝下
  scene.add(a);
  enableAreaShadow(a);
  const d = dirOf(a);
  check('rotX=-90° → 朝下 (0,-1,0)', vecEq(d, 0, -1, 0), true);
}
{
  const a = new THREE.RectAreaLight(0xffffff, 5, 4, 3);
  a.rotation.order = 'YXZ';
  a.rotation.set(0, 0, 0); // 无旋转 → 沿世界 -Z
  scene.add(a);
  enableAreaShadow(a);
  const d = dirOf(a);
  check('无旋转 → 沿世界 -Z (0,0,-1)', vecEq(d, 0, 0, -1), true);
}
{
  const a = new THREE.RectAreaLight(0xffffff, 5, 4, 3);
  a.rotation.order = 'YXZ';
  a.rotation.set(0, 90 * DEG, 0); // 偏航 90° → 沿世界 -X
  scene.add(a);
  enableAreaShadow(a);
  const d = dirOf(a);
  check('rotY=90° → 沿世界 -X (-1,0,0)', vecEq(d, -1, 0, 0), true);
}

// ---------- ② 亮度拆分 ----------
console.log('\n② 总亮度 = 本体 + 代理，且可重复拆分（不能越调越暗）：');
{
  const a = new THREE.RectAreaLight(0xffffff, 5, 4, 3); // L=5, A=12
  scene.add(a);
  enableAreaShadow(a);
  const proxy = a.children.find((c) => c.isSpotLight);
  const A = 4 * 3, SPLIT = T.split, GAIN = T.gain;
  check(`本体亮度 = L×(1-${SPLIT})`, a.intensity, 5 * (1 - SPLIT), 1e-6);
  check(`代理亮度 = L×A×${SPLIT}×${GAIN}（坎德拉）`, proxy.intensity, 5 * A * SPLIT * GAIN, 1e-6);
  // 重复同步 5 次亮度必须不变（基准值存在于 userData，不受本体被改影响）
  const i0 = a.intensity, p0 = proxy.intensity;
  for (let i = 0; i < 5; i++) syncAreaShadow(a);
  check('重复 sync 5 次后本体亮度不变', a.intensity, i0, 1e-9);
  check('重复 sync 5 次后代理亮度不变', proxy.intensity, p0, 1e-9);
  // 改强度必须走 setAreaBaseIntensity（编辑器改面板走这条）
  setAreaBaseIntensity(a, 10);
  check(`改为 L=10 后本体 = 10×(1-${SPLIT})`, a.intensity, 10 * (1 - SPLIT), 1e-6);
  check('改为 L=10 后代理 = 10×12×SPLIT×GAIN', proxy.intensity, 10 * A * SPLIT * GAIN, 1e-6);
  // 改尺寸后代理照度要跟着面积走
  a.width = 2; a.height = 2; syncAreaShadow(a);
  check('尺寸改成 2×2 后代理 = 10×4×SPLIT×GAIN', proxy.intensity, 10 * 4 * SPLIT * GAIN, 1e-6);
  // 归还后亮度要还原
  releaseAreaShadow(a);
  check('release 后本体亮度还原为基准 10', a.intensity, 10, 1e-6);
  check('release 后代理已摘除', a.children.filter((c) => c.isSpotLight).length, 0);
}

// ---------- ③ 克隆（组合家具 proto.clone(true)）----------
console.log('\n③ clone(true) 后重建代理：不许重复挂灯、光向必须仍正确：');
{
  const proto = new THREE.Group();
  const a = new THREE.RectAreaLight(0xffffff, 6, 4, 3);
  a.rotation.order = 'YXZ';
  a.rotation.set(-90 * DEG, 0, 0);
  proto.add(a);
  enableAreaShadow(a);
  scene.add(proto);

  const clone = proto.clone(true); // three 会把 target 拷成游离节点
  const ca = clone.children.find((c) => c.isRectAreaLight);
  check('克隆体上带着 1 盏代理（克隆来的）', ca.children.filter((c) => c.isSpotLight).length, 1);
  // 游离 target：不在场景图里 → 重新挂回
  enableAreaShadow(ca);
  check('重建后仍只有 1 盏代理（不重复挂）', ca.children.filter((c) => c.isSpotLight).length, 1);
  scene.add(clone);
  clone.position.set(30, 0, -20); // 挪到别处，若 target 没挂回子树光向就会错
  const d = dirOf(ca);
  check('克隆体挪位后仍朝下 (0,-1,0)', vecEq(d, 0, -1, 0), true);
  const cp = ca.children.find((c) => c.isSpotLight);
  check('克隆体代理亮度按基准 6 重算', cp.intensity, 6 * 12 * T.split * T.gain, 1e-6);
  check('target 挂在自己子树里（不是游离节点）', !!cp.target.parent, true);
}

// ---------- ④ 阴影名额：数量恒定 ----------
console.log('\n④ 阴影名额（有阴影的灯数量必须恒定，否则全场材质重编译）：');
{
  // ⚠ 候选集合是模块级的（游戏里就一份），①②③ 留下来的灯会跟这一组抢名额，
  //   所以开跑前必须像「场景重建」那样清一次。
  clearShadowBudgets();
  const areas = [];
  for (let i = 0; i < 4; i++) {
    const a = new THREE.RectAreaLight(0xffffff, 3, 4, 3);
    a.position.set(i * 5, 3, 0); // 越往后离相机越远
    scene.add(a);
    enableAreaShadow(a);
    areas.push(a);
  }
  const cam = new THREE.Vector3(0, 3, 0);
  updateShadowBudgets(cam);
  let on = 0;
  for (const a of areas) if (a.children.find((c) => c.isSpotLight).castShadow) on++;
  check('4 盏面光源中只有 2 盏投影（MAX_AREA_SHADOW）', on, 2);
  // 相机移到远处那头 → 仍是 2 盏（成员换了，数量不变）
  updateShadowBudgets(new THREE.Vector3(100, 3, 0));
  let on2 = 0;
  for (const a of areas) if (a.children.find((c) => c.isSpotLight).castShadow) on2++;
  check('相机移开后数量仍是 2（只换成员）', on2, 2);
}

// ---------- ⑤ 灯被摘掉后不许继续占名额 ----------
console.log('\n⑤ 已脱离场景的灯必须让出名额（否则新灯的阴影永远排不上）：');
{
  clearShadowBudgets();
  const near = [];
  for (let i = 0; i < 2; i++) {
    const a = new THREE.RectAreaLight(0xffffff, 3, 4, 3);
    a.position.set(0, 3, 0);
    scene.add(a);
    enableAreaShadow(a);
    near.push(a);
  }
  // 两盏近灯占满名额
  updateShadowBudgets(new THREE.Vector3(0, 3, 0));
  let on = near.filter((a) => a.children.find((c) => c.isSpotLight).castShadow).length;
  check('近处 2 盏全开', on, 2);

  // 把整棵父级 Group 摘掉（灯自己的 parent 还在，只有往上找 Scene 才查得出来）
  const holder = new THREE.Group();
  scene.add(holder);
  for (const a of near) holder.add(a);
  scene.remove(holder);
  updateShadowBudgets(new THREE.Vector3(0, 3, 0));
  on = near.filter((a) => a.children.find((c) => c.isSpotLight).castShadow).length;
  check('父级被摘掉后不再占名额', on, 0);

  // 新灯立刻能拿到名额
  const fresh = new THREE.RectAreaLight(0xffffff, 3, 4, 3);
  fresh.position.set(1, 3, 0);
  scene.add(fresh);
  enableAreaShadow(fresh);
  updateShadowBudgets(new THREE.Vector3(0, 3, 0));
  check('新灯能拿回名额', fresh.children.find((c) => c.isSpotLight).castShadow, true);
  releaseAreaShadow(fresh);
}

// ---------- ⑥ 近处不许爆亮 ----------
// 面光源的照度有上限（LTC 形状因子 ≤ 1 → 照度 ≤ π·L），聚光灯是 1/d² 没有上限。
// 代理若不后退、亮度若不压，灯下方 1 米内会比原来亮好几倍（用户反馈"面光源那么强"）。
console.log('\n⑥ 近处不许爆亮（代理照度不得超过面光源自身的饱和上限 π·L）：');
{
  clearShadowBudgets();
  for (const [w, h] of [[4, 3], [8, 6], [2, 2]]) {
    const L = 5;
    const a = new THREE.RectAreaLight(0xffffff, L, w, h);
    scene.add(a);
    enableAreaShadow(a);
    const proxy = a.children.find((c) => c.isSpotLight);
    const b = -proxy.position.z; // 后退量
    const cap = Math.PI * L;     // 面光源自己的照度天花板
    const e = (d) => proxy.intensity / ((d + b) * (d + b)); // 代理在轴向 d 米处的照度
    console.log(`  ${w}×${h}：后退 ${b.toFixed(2)}m，代理光强 ${proxy.intensity.toFixed(1)}cd`);
    check(`${w}×${h} 在 0.5m 处不超过 1.6×π·L`, e(0.5) <= cap * 1.6, true);
    check(`${w}×${h} 在 1m 处不超过 π·L`, e(1) <= cap, true);
    // 远场别为了压近处把照明也压没了：6m 处总照度至少还有理想值的一半
    const ideal = (L * w * h) / 36;                 // 远场 L·A/d²
    const body = ((1 - T.split) * L * w * h) / 36;  // 本体那一份（远场同样成立）
    check(`${w}×${h} 在 6m 处仍有理想值的 50% 以上`, (body + e(6)) / ideal >= 0.5, true);
    releaseAreaShadow(a);
  }
}

// ---------- ⑦ 编辑器改「照射距离」必须真的作用到代理 ----------
// 面光源自身没有 distance，这个值只喂给阴影代理：既是照射半径，也是阴影贴图的 far。
// 编辑器面板上能改，就必须能传到代理上，否则拖滑块毫无反应。
console.log('\n⑦ 改 distance 必须作用到代理（否则编辑器里拖滑块没反应）：');
{
  clearShadowBudgets();
  const a = new THREE.RectAreaLight(0xffffff, 3, 4, 3);
  scene.add(a);
  enableAreaShadow(a);
  const proxy = a.children.find((c) => c.isSpotLight);
  check('默认取 AREA_SHADOW_DISTANCE', proxy.distance, T.distance, 1e-6);
  setAreaShadowDistance(a, 6);
  check('改为 6 后代理 distance = 6', proxy.distance, 6, 1e-6);
  check('阴影贴图 far 跟着收到 6', proxy.shadow.camera.far, 6, 1e-6);
  setAreaShadowDistance(a, 0); // 非法值 → 回默认
  check('传 0 回落到默认值', proxy.distance, T.distance, 1e-6);
  releaseAreaShadow(a);
}

console.log(fails ? `\n✗ ${fails} 项失败` : '\n✓ 全部通过');
process.exit(fails ? 1 : 0);
