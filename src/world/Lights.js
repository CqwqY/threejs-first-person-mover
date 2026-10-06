// 职责：创建场景光照（环境光 + 方向光）。
// 返回 { group, sun, sunTarget }：sun 为投射阴影的方向光，sunTarget 为阴影聚焦目标，
// 调用方可每帧把 sunTarget 挪到玩家/相机附近，实现「阴影跟随、近处清晰」的效果。
import * as THREE from 'three';
import { DEFAULT_SETTINGS } from '../ui/SettingsPanel.js';

// ===========================================================================
// 阴影预算：点光源 + 面光源
// ---------------------------------------------------------------------------
// 成本要知道：点光源阴影是**立方体阴影**，6 个面各渲染一次 = 6 个 pass，很贵。
//   所以：① 阴影贴图压到 512；② far 交给 Three 按 light.distance 自动收紧（视锥变小 → 大量物体被剔除，
//   这条比降贴图省得多，所以灯一定要设 distance）；③ 同时最多 MAX_* 盏灯投影，超出只照亮、不遮挡。
//
// 名额怎么分配：**只看数量、不看身份** —— 挑离相机最近的 N 盏开阴影，其余关掉。
// 这样玩家身边的灯永远有遮挡，远处的灯不投影（也看不见区别）。
// ⚠ 关键不变量：**有阴影的灯的数量必须保持不变**。Three 的 program 缓存键里是
//   numPointLightShadows / numSpotLightShadows（都是**数量**），数量不变时换成员命中的是
//   同一份已编译 shader，**不会重编译**；一旦数量抖动就会全场材质重编译 → 卡顿。
// ===========================================================================
// ⚠⚠ 点光源的阴影名额是**趟数**的乘数：每盏 = cube 6 面 = 6 趟全场景投影。
//   4 盏 = 24 趟/阴影帧，30Hz 重渲 ≈ 每秒 3.6 万~4.5 万次 draw call 纯为阴影，
//   而且**完全不受 renderScale 影响**（所以"分辨率拉到最低还是卡"）。
//   这是最强的单一杠杆 → 改成**可调**（按画质档/设备给值，见 DEFAULT_MAX_POINT_SHADOW）。
const MAX_AREA_SHADOW = 2;   // 面光源的阴影代理（聚光灯，单张 2D 阴影贴图，比点光源便宜得多）
const SHADOW_MAP = 512;
// 默认名额：手机/触摸设备给 1（只保身边最近那盏），桌面给 3。
// 0 = 完全关掉点光源阴影（只留太阳方向光）—— 成本直接砍到 0，是弱机最有效的一档。
const DEFAULT_MAX_POINT_SHADOW = (() => {
  try {
    const coarse = typeof window !== 'undefined' &&
      (window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    if (coarse) return 1;
  } catch (e) { /* ignore */ }
  return 3;
})();
let _maxPointShadow = DEFAULT_MAX_POINT_SHADOW;
// ⚠⚠ 点光源阴影相机的 far **硬上限**（米）。绝不能交给 Three 按 light.distance 走 —— 见 configureShadow。
const POINT_SHADOW_FAR = 32;

// 全局「用户摆放光源」亮度倍率：想把所有面光源/点光源（编辑器与游戏端都算）统一调亮或调暗，改这一个值。
// 它压在每盏**用户灯**最终赋强度的地方，不影响编辑器面板/存档里你填的"设计值"——
// 滑块上看到的 20 仍是 20，只是实际渲染时统一乘了 LIGHT_SCALE。
// （太阳/环境/半球这类全局光不走这里，改 DEFAULT_SETTINGS 里的 sun/ambient/hemi。）
export const LIGHT_SCALE = 0.7;

const _pointCands = new Set(); // 已登记的点光源（场景灯 + 家具里的灯）
const _areaCands = new Set();  // 已登记的面光源阴影代理（SpotLight）
const _tmpV = new THREE.Vector3(); // rebalance 里取世界坐标用的临时量（避免每帧分配）

// ---- 面光源阴影：Three 的 RectAreaLight 没有 shadow 字段（LTC 模型不支持投影），是引擎硬限制 ----
// 解法：给每盏面光源配一盏**阴影代理聚光灯** —— 贴在发光面上、沿发光方向（本地 -Z）照射，由它投影。
//
// 亮度怎么分：**不能只加不减**（那房间会亮一倍）。把总亮度拆两份：
//   · 代理聚光灯拿走 AREA_SHADOW_SPLIT（这部分会被墙挡住 → 这才是「光不再穿墙」的来源）
//   · 面光源本体留 (1 - SPLIT)（保留面光特有的柔和衰减与质感；这部分仍会漏一点点）
//
// 单位换算：RectAreaLight 的 intensity 是亮度 L（尼特），正对方向 d 米处照度 ≈ L·A/d²（A = 宽×高）；
//   聚光灯的 intensity 是光强 I（坎德拉），照度 = I/d²。所以 **I = L·A** 两者才等亮
//   （three 里两者都是 uniforms.color = color × intensity，没有额外比例因子 —— 已核对源码）。
//
// ⚠⚠ 但上面这个等号**只在远场成立**，近处会翻车 —— 这是"面光源怎么突然这么强"的根因：
//   · 面光源：LTC 算出来的是形状因子，**上限是 1**，所以照度封顶在 **π·L**，贴多近都不会更亮；
//   · 聚光灯：照度 = I/d²，d 越小越亮，three 只把 pow(d,2) 夹在 0.01（等于没保护）。
//   例：4×3 的灯、L=3，正下方 1 米 —— 面光源实际照度 ≈ 7，而 I=L·A 的聚光灯给 36，亮 5 倍。
//
// 对策两条：
//   ① 代理沿发光方向**后退**一段（面积越大退越多，见 areaProxyBackoff）——把近处那段 1/d² 削平，
//      远场 d ≫ 后退量时又自动回到 I/d²，不影响正常照明距离。
//   ② 整体压一档（GAIN），因为聚光灯把光拢在 60° 锥里，主观上就是比面光"冲"。
const AREA_SHADOW_SPLIT = 0.3;              // 走代理（会被遮挡）的亮度占比——压低：让面光源本体（柔和面光）占主导，光型才像"面"而不是聚光灯的锥形尖斑
const AREA_SHADOW_DISTANCE = 14;            // 代理光衰减半径（米）
const AREA_SHADOW_ANGLE = (60 * Math.PI) / 180; // 张角：够盖住一间屋子
const AREA_SHADOW_PENUMBRA = 1;             // 全柔边，尽量接近面光的软阴影
const AREA_SHADOW_GAIN = 0.6;               // 亮度微调：整体偏暗就调大、偏亮调小
// 调试/自检用：亮度的三个旋钮集中在这里，改完跑 node tools/probe-areashadow.mjs
export const AREA_SHADOW_TUNING = {
  split: AREA_SHADOW_SPLIT, gain: AREA_SHADOW_GAIN, angle: AREA_SHADOW_ANGLE, distance: AREA_SHADOW_DISTANCE,
};

// ---- 面光源的**默认参数**（唯一来源）--------------------------------------
// ⚠⚠ 这是"面光源在家具里横转 90°"的根因区：之前四处的默认值各写各的 ——
//   游戏端 LIGHT_DEFAULTS.rotX = -90、组合家具 -90、编辑器新建 -90，
//   但**编辑器读存档那处写的是 rotX: 0**。于是「存档里没有 rotX 字段的灯」
//   载入后就是 rotX=0（发光面竖直、朝水平方向照）＝ 比朝下整整横过来 90°，
//   而游戏端同样缺失却按 -90 处理 —— 两端还对不上，编辑器和实机表现不一致。
//   分叉的默认值迟早出 bug，所以收敛到这一处，四处都从这里取。
export const AREA_LIGHT_DEFAULTS = {
  rotX: -90,  // 俯仰（度）：RectAreaLight 沿本地 -Z 发光，-90 = 发光面水平、朝下照（吸顶灯）；0 = 发光面竖直、朝水平照
  rotY: 0,    // 偏航（度）
  width: 4,
  height: 3,
  intensity: 3,
  distance: AREA_SHADOW_DISTANCE, // 阴影代理的衰减半径（面光源本体无衰减概念，这个只给代理用）
};

// 代理沿发光方向（本地 -Z）后退多少米。
// 面积越大，面光的"饱和"发生得越远，代理就得更靠后，否则近处照样爆。
// 用等面积圆的半径 r = √(A/π) 作尺度：r 正好是「远场公式开始失效」的距离。
function areaProxyBackoff(area) {
  const a = Math.max(0.01, (area.width || 1) * (area.height || 1));
  const r = Math.sqrt(a / Math.PI);
  return Math.min(1.6, Math.max(0.15, r * 0.35));
}

// ⚠ 标记只放**布尔/数字**，绝不存 Object3D：Object3D.copy 对 userData 走
//   `JSON.parse(JSON.stringify(...))`，塞进 Object3D 会因循环引用直接抛错。
//   基准亮度同理必须是数字（组合家具 clone(true) 时才能跟着一起被拷到克隆体上）。

function configureShadow(light, farOverride) {
  const sh = light.shadow;
  if (!sh) return;
  if (sh.mapSize) sh.mapSize.set(SHADOW_MAP, SHADOW_MAP);
  // 接缝处容易出条纹/漏光：bias 下压深度，normalBias 沿法线推开采样点
  sh.bias = -0.0015;
  sh.normalBias = 0.06;
  if (sh.camera) {
    sh.camera.near = light.isSpotLight ? 0.15 : 0.25;
    // ⚠⚠ 点光源阴影相机的 far **必须无条件钳制**（2026-10-06 「一靠近建筑就卡卡卡」的根因）。
    //
    //   旧写法是"没设 distance 时才兜 30m，设了就交给 Three 按 distance 收紧" ——
    //   这条假设只有在 distance 是**合理值**（20~30m）时才成立。而线上编辑器的灯
    //   大量 `distance: 100`（用户想"照得远"），Three 的 PointLightShadow.updateMatrices()
    //   直接拿 light.distance 当 cube shadow 的 camera.far
    //   → 每盏灯的阴影要覆盖**半径 100 米的球**，几乎整张地图。
    //
    //   代价：点光源阴影是 cube（6 面），4 盏带影 = 24 趟/阴影帧，每趟都要把 100m 内的
    //   物体全部重渲一遍 → 实测每秒 3.6 万~4.5 万次 draw call 纯粹为了阴影。
    //   而且**完全不受 renderScale 影响** —— 这正是「把分辨率拉到最低还是卡」的原因，
    //   也解释了「朝空方向看很快、一靠近建筑就卡」（建筑进得多，阴影 pass 就爆）。
    //
    //   far 只决定"这盏灯的影子能投多远"，32m 足够（超出范围的物体本来也不该被它照亮）。
    if (!light.isSpotLight) {
      const d = Number.isFinite(light.distance) && light.distance > 0 ? light.distance : POINT_SHADOW_FAR;
      sh.camera.far = Math.min(d, POINT_SHADOW_FAR);
      sh.camera.updateProjectionMatrix();
    }
    if (light.isSpotLight && farOverride) { sh.camera.far = farOverride; sh.camera.updateProjectionMatrix(); }
  }
}

// 找出挂在面光源上的代理聚光灯（没有则 null）
function areaProxyOf(area) {
  if (!area) return null;
  for (const c of area.children) {
    if (c.isSpotLight && c.userData && c.userData.__areaProxy) return c;
  }
  return null;
}

// 给一盏面光源接上阴影代理。返回代理（失败/非面光源返回 null）。
// opts: { intensity?, distance? } —— intensity 不传就用灯当前的（或记住的）基准亮度。
// 可重复调用（编辑器改参数后重算亮度；组合家具 clone 后重建代理）。
export function enableAreaShadow(area, opts = {}) {
  if (!area || !area.isRectAreaLight) return null;
  const base = Number.isFinite(opts.intensity)
    ? opts.intensity
    : (Number.isFinite(area.userData.__areaBase) ? area.userData.__areaBase : area.intensity);
  area.userData.__areaBase = base;
  const dist = Number(opts.distance) > 0 ? Number(opts.distance) : AREA_SHADOW_DISTANCE;

  // 已有代理就复用：clone(true) 会连子树一起拷，重复 new 会挂两盏灯
  let proxy = areaProxyOf(area);
  if (!proxy) {
    proxy = new THREE.SpotLight(new THREE.Color(0xffffff), 0, dist, 2, AREA_SHADOW_ANGLE, AREA_SHADOW_PENUMBRA);
    proxy.userData.__areaProxy = true;
    // 沿发光方向（本地 -Z）后退一段：既避免与「安装它的那面墙/天花板」产生自遮挡痤疮，
    // 也把聚光灯 1/d² 在近处的暴涨削平（详见上面「近处会翻车」的说明）
    proxy.position.set(0, 0, -areaProxyBackoff(area));
    area.add(proxy);
  }
  // ⚠ target 必须重新挂到**自己**的子树上：three 的 SpotLight.copy 做的是
  //   `this.target = source.target.clone()` —— 克隆出的是一个**游离节点**，不在场景图里，
  //   matrixWorld 永远不更新 → 光向会算错（组合家具 proto.clone(true) 就踩这条）。
  let tgt = null;
  for (const c of proxy.children) if (c.userData && c.userData.__areaTarget) { tgt = c; break; }
  if (!tgt) {
    tgt = new THREE.Object3D();
    tgt.userData.__areaTarget = true;
    tgt.position.set(0, 0, -1); // 代理在 (0,0,-0.06)，目标再往 -Z 走 1 → 方向就是本地 -Z
    proxy.add(tgt);
  }
  proxy.target = tgt;
  proxy.distance = dist;
  configureShadow(proxy, dist);
  _areaCands.add(proxy);
  syncAreaShadow(area);
  return proxy;
}

// 重新按「本体 + 代理」拆分亮度。面光源的强度/尺寸/颜色变了都要调一次。
export function syncAreaShadow(area) {
  if (!area || !area.isRectAreaLight) return;
  const proxy = areaProxyOf(area);
  if (!proxy) return;
  const base = Number.isFinite(area.userData.__areaBase) ? area.userData.__areaBase : area.intensity;
  const a = Math.max(0.01, (area.width || 1) * (area.height || 1));
  area.intensity = base * (1 - AREA_SHADOW_SPLIT) * LIGHT_SCALE;
  proxy.intensity = base * a * AREA_SHADOW_SPLIT * AREA_SHADOW_GAIN * LIGHT_SCALE;
  proxy.color.copy(area.color);
  // 尺寸在编辑器里能改 → 后退量跟着重算（面越大退越多，否则近处又爆）。
  // 光向不受影响：target 是代理的子节点，方向只取决于它相对代理的偏移，与代理自身位置无关。
  proxy.position.set(0, 0, -areaProxyBackoff(area));
  if (proxy.shadow && proxy.shadow.camera && proxy.distance) {
    proxy.shadow.camera.far = proxy.distance;
    proxy.shadow.camera.updateProjectionMatrix();
  }
}

// 编辑器里从数据改强度时用这个（直接写 light.intensity 会让基准值失真、下次同步就越调越暗）
export function setAreaBaseIntensity(area, v) {
  if (!area || !area.isRectAreaLight) return;
  area.userData.__areaBase = Number(v) || 0;
  syncAreaShadow(area);
}

// 改代理的衰减半径（面光源自己没有 distance，这个只作用于阴影代理）。
// 传 0 / 非法值 → 回到 AREA_SHADOW_DISTANCE。衰减半径同时决定阴影贴图的 far，
// 所以这是面光源阴影唯一需要手调的「范围」旋钮 —— 编辑器面板上必须能看到。
export function setAreaShadowDistance(area, d) {
  if (!area || !area.isRectAreaLight) return;
  const proxy = areaProxyOf(area);
  if (!proxy) return;
  const dist = Number(d) > 0 ? Number(d) : AREA_SHADOW_DISTANCE;
  proxy.distance = dist;
  configureShadow(proxy, dist);
  if (proxy.shadow && proxy.shadow.camera) {
    proxy.shadow.camera.far = dist;
    proxy.shadow.camera.updateProjectionMatrix();
  }
}

// 这盏面光源的代理**此刻**是否在投影（名额只有 MAX_AREA_SHADOW 盏，按离相机的距离分配）。
// 编辑器用它做可见反馈 —— 否则用户会以为「面光源没接上阴影」。
export function isAreaShadowCasting(area) {
  const proxy = areaProxyOf(area);
  return !!(proxy && proxy.castShadow);
}

// 面光源要销毁时归还名额，并把它本来的亮度还回去
export function releaseAreaShadow(area) {
  const proxy = areaProxyOf(area);
  if (!proxy) return;
  _areaCands.delete(proxy);
  proxy.castShadow = false;
  if (proxy.target) proxy.target.removeFromParent();
  proxy.removeFromParent();
  proxy.dispose && proxy.dispose();
  if (Number.isFinite(area.userData.__areaBase)) area.intensity = area.userData.__areaBase;
  delete area.userData.__areaBase;
}

// 登记一盏点光源，交由 updateShadowBudgets 统一分配阴影名额
export function registerPointLight(light) {
  if (light && light.isPointLight) { _pointCands.add(light); configureShadow(light); }
  return light;
}

// 移除时注销（灯从场景删掉后还留在集合里会白白占名额）
export function unregisterPointLight(light) {
  _pointCands.delete(light);
  if (light && light.isPointLight) light.castShadow = false;
}

// 灯是否还挂在场景图上（一直往上找到 Scene 才算）。
// ⚠ 只查 `l.parent` 是不够的：灯被 removeFromParent() 之后 parent 变 null，
//   但「整棵子树被摘掉」时（父级 Group 被移除）灯自己的 parent 还在 → 会一直白占名额。
function inScene(o) {
  let p = o.parent;
  while (p) { if (p.isScene) return true; p = p.parent; }
  return false;
}

// 按「离相机最近」重新分配阴影名额（点光源一组、面光源代理一组，各自独立计数）
// ⚠⚠ 距离判据只用 XZ 平面（忽略 Y）：灯的阴影该不该开，取决于「你在它水平方向多远」，
//   而不是「你在它楼上还是楼下」。旧写法把 dy² 也算进去 → 站在一楼抬头看二楼的灯，
//   因为高度差大、3D 距离超阈值，灯就丢了阴影（用户反馈"离灯有点距离就开始失去阴影"）。
//   改成纯水平距离后：同一竖井上下的灯（如楼梯间、复式）照样保住阴影，只有真水平走远才让出名额。
function rebalance(cands, max, cameraPos) {
  const list = [];
  const dead = [];
  for (const l of cands) {
    if (!l.parent || !inScene(l)) { dead.push(l); continue; } // 已从场景移除 → 顺便清出去
    l.getWorldPosition(_tmpV); // ⚠ 灯多数挂在 Group 里（家具），position 是局部坐标，必须取世界坐标
    const dx = _tmpV.x - cameraPos.x, dz = _tmpV.z - cameraPos.z; // 只看水平距离，忽略 Y
    list.push([dx * dx + dz * dz, l]);
  }
  for (const l of dead) { cands.delete(l); l.castShadow = false; }
  list.sort((a, b) => a[0] - b[0]);
  const want = Math.min(max, list.length);
  for (let i = 0; i < list.length; i++) {
    const l = list[i][1];
    const on = i < want;
    if (l.castShadow !== on) l.castShadow = on;
  }
}

// 场景整体重建时调用：把上一轮登记的名额全部作废（旧灯随后会被 disposeLight 逐个注销）。
// ⚠ 不清理的话，已删掉的灯会一直留在候选集合里抢名额，新灯的阴影就永远排不上。
//   在**渲染之前**同步调用，不会造成「有阴影的灯数量抖动」。
/**
 * 改「最多几盏点光源投影」。0 = 全关。
 *
 * ⚠ 调用时机：只有切画质档时（低频）。改这个值会改变 shader 里的 `numPointLightShadows`，
 *   Three 的 program 缓存键含它 → **全场景材质会重编译一次**。所以绝不能每帧调。
 *   重编译一次换掉 24 趟/帧的阴影，对弱机是明确的划算；对强机（保持 3~4 盏）没有影响。
 *
 * @returns {boolean} 值是否发生变化
 */
export function setMaxPointShadow(n) {
  const v = Math.max(0, Math.min(4, Math.floor(Number(n)) || 0));
  if (v === _maxPointShadow) return false;
  _maxPointShadow = v;
  // 先把所有候选灯关掉，避免出现"数量短暂抖动"以外的中间态；随后下一帧 rebalance 会按新名额开回来
  for (const l of _pointCands) if (l) l.castShadow = false;
  return true;
}

export function getMaxPointShadow() { return _maxPointShadow; }

export function clearShadowBudgets() {
  for (const l of _pointCands) if (l) l.castShadow = false;
  for (const l of _areaCands) if (l) l.castShadow = false;
  _pointCands.clear();
  _areaCands.clear();
}

// 每帧调用一次（内部很轻：几十个灯的距离排序）。
export function updateShadowBudgets(cameraPos) {
  if (!cameraPos) return;
  rebalance(_pointCands, _maxPointShadow, cameraPos); // 可调名额，见 setMaxPointShadow
  rebalance(_areaCands, MAX_AREA_SHADOW, cameraPos);
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