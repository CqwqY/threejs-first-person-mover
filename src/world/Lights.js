// 职责：创建场景光照（环境光 + 方向光）。
// 返回 { group, sun, sunTarget }：sun 为投射阴影的方向光，sunTarget 为阴影聚焦目标，
// 调用方可每帧把 sunTarget 挪到玩家/相机附近，实现「阴影跟随、近处清晰」的效果。
import * as THREE from 'three';
import { DEFAULT_SETTINGS } from '../ui/SettingsPanel.js';

// ---- 点光源阴影（让室内/家具的灯不再"穿透"墙体）----
// ⚠ 成本要知道：点光源阴影是**立方体阴影**，6 个面各渲染一次 = 6 个 pass，非常贵。
//   所以：① 阴影贴图压到 512；② far 交给 Three 按 light.distance 自动收紧（视锥变小 → 大量物体被剔除，
//   这条比降贴图省得多，所以灯一定要设 distance）；③ 同时最多 MAX_POINT_SHADOW 盏灯投影，
//   超出预算的灯只照亮、不遮挡。
//
// 名额怎么分配：**只看数量、不看身份** —— 每帧（实际按 updatePointLightShadows 的节流）挑离相机最近的
// N 盏灯开阴影，其余关掉。这样玩家身边的灯永远有遮挡，远处的灯不投影（也看不见区别）。
// ⚠ 关键不变量：**有阴影的灯的数量必须保持不变**。Three 的 program 缓存键里是 numPointLightShadows（数量），
//   数量不变时换成员命中的是同一份已编译 shader，**不会重编译**；一旦数量抖动就会全场材质重编译 → 卡顿。
//   所以下面只在「候选总数 < MAX」时才让数量变化（罕见）。
// ⚠ 编辑器里的「面光源」是 RectAreaLight —— Three 的 LTC 光照模型**根本不支持阴影**，必然穿墙。
//   要遮挡只能用点光源 / 聚光灯。
const MAX_POINT_SHADOW = 4;
const POINT_SHADOW_MAP = 512;
const _shadowCands = new Set(); // 已登记的点光源（场景灯 + 家具里的灯）
const _shadowOn = new Set();    // 当前开着阴影的那些
const _tmpV = new THREE.Vector3();

// 给一处点光源配置阴影参数（不决定开不开）
function configureShadow(light) {
  const sh = light.shadow;
  if (!sh) return;
  if (sh.mapSize) sh.mapSize.set(POINT_SHADOW_MAP, POINT_SHADOW_MAP);
  // 立方体阴影接缝处容易出条纹/漏光：bias 下压深度，normalBias 沿法线推开采样点
  sh.bias = -0.0015;
  sh.normalBias = 0.06;
  if (sh.camera) {
    sh.camera.near = 0.25;
    if (!light.distance) { sh.camera.far = 30; sh.camera.updateProjectionMatrix(); }
  }
}

// 登记一盏点光源，交由 updatePointLightShadows 统一分配阴影名额
export function registerPointLight(light) {
  if (light && light.isPointLight) { _shadowCands.add(light); configureShadow(light); }
  return light;
}

// 移除时注销（灯从场景删掉后还留在集合里会白白占名额）
export function unregisterPointLight(light) {
  _shadowCands.delete(light);
  if (_shadowOn.delete(light)) light.castShadow = false;
}

// 按相机位置重新分配阴影名额。cameraPos 传 Vector3。
// 建议每帧调用（内部很轻：几十个灯的距离排序），或按需节流。
export function updatePointLightShadows(cameraPos) {
  if (!cameraPos) return;
  const list = [];
  for (const l of _shadowCands) {
    if (!l.parent) continue; // 已从场景移除
    l.getWorldPosition(_tmpV); // ⚠ 灯多数挂在 Group 里（家具），position 是局部坐标，必须取世界坐标
    const dx = _tmpV.x - cameraPos.x, dy = _tmpV.y - cameraPos.y, dz = _tmpV.z - cameraPos.z;
    list.push([dx * dx + dy * dy + dz * dz, l]);
  }
  list.sort((a, b) => a[0] - b[0]);
  const want = Math.min(MAX_POINT_SHADOW, list.length);
  for (let i = 0; i < list.length; i++) {
    const l = list[i][1];
    const on = i < want;
    if (l.castShadow === on) continue;
    l.castShadow = on;
    if (on) _shadowOn.add(l); else _shadowOn.delete(l);
  }
}

export function createLights() {
  const group = new THREE.Group();

  // 环境光：提供全局均匀的底色照明（偏暗以拉开明暗对比），可在「画面」面板调整
  const ambient = new THREE.AmbientLight(0xffffff, DEFAULT_SETTINGS.ambient);
  group.add(ambient);

  // 半球光：按法线方向给天空色/地面色，模拟间接/弹射光的明暗层次。
  // 朝上的面（地板/桌面）更亮，朝下的面（天花板/底面）更暗——解决室内被主阴影统一盖暗后失去区别的问题。
  const hemi = new THREE.HemisphereLight(0xffffff, 0x222230, DEFAULT_SETTINGS.hemi);
  group.add(hemi);

  // 阳光聚焦目标：shadow 相机以它为中心，跟随玩家移动
  const sunTarget = new THREE.Object3D();
  group.add(sunTarget);

  // 方向光：模拟太阳，带明显明暗对比；同时投影阴影（近处跟随清晰）
  const offset = new THREE.Vector3(30, 40, 20); // 阳光相对 target 的固定偏移，保持整体光向不变
  const directional = new THREE.DirectionalLight(0xffffff, DEFAULT_SETTINGS.sun);
  directional.castShadow = true;
  directional.shadow.mapSize.set(DEFAULT_SETTINGS.shadowSize, DEFAULT_SETTINGS.shadowSize);
  // 阴影痤疮修复：bias 轻微下压深度，normalBias 沿法线推开采样点，消除平面上的「一条一条」条纹
  directional.shadow.bias = -0.0004;
  directional.shadow.normalBias = 1.0;
  const R = DEFAULT_SETTINGS.shadowR; // 阴影覆盖半宽（以 sunTarget 为中心）
  directional.shadow.camera.left = -R;
  directional.shadow.camera.right = R;
  directional.shadow.camera.top = R;
  directional.shadow.camera.bottom = -R;
  directional.shadow.camera.near = 0.5;
  directional.shadow.camera.far = 120;
  directional.target = sunTarget;
  directional.position.copy(sunTarget.position).add(offset);
  group.add(directional);

  return { group, sun: directional, sunTarget, offset, ambient, hemi };
}