// 职责：按「离相机的距离」给场景对象分级，砍掉远处的渲染开销。
//
// 三档：
//   近（<= shadowDist）：可见 + 投影（参与阴影贴图）
//   中（<= hideDist）  ：可见，但**不投影** —— 阴影贴图是要把整个场景再画一遍的，
//                        远处物体对阴影几乎没有贡献，却照样要过一遍。这是最划算的一刀。
//   远（> hideDist）   ：整块不渲染
//
// ⚠ 距离取「包围球最近点」(dist - radius)，不是中心距：否则大建筑（中心很远、人却贴着墙走）
//   会被误判成"远"而整栋消失。
// ⚠ 评估节流到 300ms：距离变化远没有帧率快，没必要进逐帧热路径。
// ⚠ 只关"原本就投影"的网格（记录 base），不会把本来不投影的小装饰打开。
import * as THREE from 'three';

const SHADOW_DIST = 90;  // 超过它就不再投影（米，会按对象尺寸放宽）
const HIDE_DIST = 240;   // 超过它整块隐藏（米，会按对象尺寸放宽）
const TICK_MS = 300;     // 评估间隔

// ⚠⚠ 「整块隐藏」默认关闭（2026-10-05）：项目里有几处逻辑是**依赖 visible 的**，踩过一次很疼：
//   · trimesh.js 的 collectMeshes：`if (inColliderVis(o) || !isVisible(o)) return;`
//     —— 不可见的网格**不参与碰撞烘焙**。一旦隐藏与烘焙的时机重叠，就烘出空碰撞体（碰撞直接没了）。
//   · 射线拾取 / 编辑器选中同样会跳过不可见对象。
//   而"不投影"这一档才是真正的大头（阴影贴图要把整个场景再画一遍），且完全不影响上面任何逻辑。
//   所以默认只做投影分级；要把隐藏打开，先确认时序不会与烘焙打架。
const ENABLE_LOD_HIDE = false;

const targets = [];
let _lastRun = 0;
const _v = new THREE.Vector3();
const _box = new THREE.Box3();
const _sphere = new THREE.Sphere();

// 登记一个可分级对象（Group / Mesh 都行）。返回登记记录。
export function registerLodTarget(obj, opts = {}) {
  if (!obj) return null;
  _box.setFromObject(obj);
  if (_box.isEmpty()) return null; // 空组（比如只剩空 holder）不登记
  _box.getBoundingSphere(_sphere);
  const r = _sphere.radius || 0;

  // 网格列表必须提前收集：给 Group 设 castShadow 是没用的，得落到每个子 Mesh 上
  const meshes = [];
  obj.traverse((o) => { if (o.isMesh) meshes.push({ mesh: o, base: !!o.castShadow }); });

  const rec = {
    obj,
    meshes,
    center: _sphere.center.clone(),
    radius: r,
    // 尺寸越大阈值越宽：整栋楼的主体不该在 240 米处整块消失，小装饰则可以早点丢
    shadowDist: opts.shadowDist ?? (SHADOW_DIST + Math.min(r * 2, 160)),
    hideDist: opts.hideDist ?? (HIDE_DIST + Math.min(r * 3, 360)),
    // ⚠ noHide：**绝不隐藏**（但可以关投影）。给「碰撞要从渲染网格烘焙」的对象用 ——
    //   trimesh.js 的 collectMeshes 里有一句 `if (!isVisible(o)) return;`：
    //   不可见的网格**不参与碰撞烘焙**。要是把这类对象隐藏了，任何一次重新烘焙都会烘出
    //   空碰撞体（碰撞直接消失）。宁可少省这点绘制，也不能让碰撞没了。
    noHide: !!opts.noHide,
  };
  targets.push(rec);
  return rec;
}

export function clearLodTargets() { targets.length = 0; }

export function lodTargetCount() { return targets.length; }

// 每帧调用（内部节流）。force=true 忽略节流（切换场景后立刻重算一次）。
export function updateLod(cameraPos, force) {
  if (!cameraPos || !targets.length) return;
  const now = performance.now();
  if (!force && now - _lastRun < TICK_MS) return;
  _lastRun = now;

  for (const t of targets) {
    // 包围球最近点距离：负数说明相机就在包围球里，当成 0
    const d = Math.max(0, _v.copy(t.center).distanceTo(cameraPos) - t.radius);
    if (ENABLE_LOD_HIDE && !t.noHide) {
      const visible = d <= t.hideDist;
      if (t.obj.visible !== visible) t.obj.visible = visible;
      if (!visible) continue; // 藏起来了就不用管投影了
    }
    const cast = d <= t.shadowDist;
    for (const it of t.meshes) {
      const want = it.base && cast;
      if (it.mesh.castShadow !== want) it.mesh.castShadow = want;
    }
  }
}
