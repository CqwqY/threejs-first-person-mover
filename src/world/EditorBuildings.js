// 职责：把编辑器（editor.html「保存场景」）写入 src/world/editorMapData.js 的地图数据
// 直接 import 并应用到游戏场景。保存即改动源码模块，游戏刷新即生效。
// 数据格式：{ scenery:[{key,x,y,z,rotY,scale:{x,y,z}}...], placed:[{name,url,x,y,z,rotY,scale:{x,y,z},collider:{...}}...] }
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { instantiate } from './AssetLoader.js';
import { editorMapData } from './editorMapData.js';
import { API_BASE } from '../config.js';
import { bakeTriMeshAsync } from './collision/trimesh.js';
import { track } from './loadTracker.js';
import {
  registerPointLight, unregisterPointLight, enableAreaShadow, releaseAreaShadow, clearShadowBudgets,
  AREA_LIGHT_DEFAULTS, LIGHT_SCALE,
} from './Lights.js';
import { registerLodTarget, clearLodTargets } from './Lod.js';

// 记录上一次已挂进场景的 holder（防止重复调用时旧建筑残留），再次构建前先清空
let _addedHolders = [];
// 本次构建的「模型加载」Promise 列表（不含 trimesh 烘焙）——
// optimizeEditorScene 要等它们全都 settle 才能做跨物件合并。
let _pendingLoads = [];
// 构建代数：异步 trimesh 烘焙是「先返回、后回调」的，
// 回调里必须校验代数，避免上一份场景的烘焙结果被 push 进重建后的碰撞体数组。
let _buildGen = 0;
function clearHolders(scene) {
  for (const h of _addedHolders) scene.remove(h);
  _addedHolders = [];
}

// 统一显隐「编辑器建筑」：进入对战独立竞技场时把城市建筑整组隐藏，退出时恢复。
// 编辑器建筑是直接挂在 scene 下的 holder，不在 buildScenery 的 roots 里，必须单独切换。
export function setEditorSceneVisible(visible) {
  for (const h of _addedHolders) h.visible = !!visible;
}

// 运行时从远程后端拉取最新编辑器场景（在线同步）；失败返回 null 由调用方回退到打包数据
export async function fetchRemoteScene() {
  try {
    const r = await fetch(API_BASE + '/api/scene');
    if (!r.ok) return null;
    const d = await r.json();
    return d && typeof d === 'object' ? d : null;
  } catch (e) {
    return null;
  }
}

// 从模型 url 推显示名：/assets/import-xxx-zhaji.glb → zhaji（去目录、去扩展名、解码中文）
function nameFromUrl(url) {
  if (!url) return '';
  const file = String(url).split('/').pop().split('?')[0];
  const bare = file.replace(/\.glb$/i, '');
  try { return decodeURIComponent(bare); } catch (e) { return bare; }
}

// scale 规范化：统一为 {x,y,z}，兼容旧的单数值
function normScale(s) {
  if (s && typeof s === 'object' && typeof s.x === 'number') {
    return { x: s.x, y: (typeof s.y === 'number' ? s.y : s.x), z: (typeof s.z === 'number' ? s.z : s.x) };
  }
  const v = (typeof s === 'number' && Number.isFinite(s)) ? s : 1;
  return { x: v, y: v, z: v };
}

// 合并工具独立在 Merge.js（AssetLoader 也要用，留在本文件会循环依赖）。
// ⚠ 必须写成 import + export 两条：`export { x } from './Merge.js'` **不会**在本文件产生局部绑定，
//   下面 mergeStaticMeshes / materialSigKey / countMeshes 等直接调用会变成未声明标识符
//   （node --check 与 esbuild 都抓不到，只在运行时炸 —— 踩过）。
import {
  mergeStaticMeshes, flipTriangleWinding, materialSigKey, geometrySigKey, countMeshes,
} from './Merge.js';
export { mergeStaticMeshes, flipTriangleWinding };

// buildEditorBuildings(scene, roots, dataOverride, outColliders)：roots 为 buildScenery 返回的统一可编辑根列表，
// 数组下标即 scenery 的 key，两侧顺序完全一致。
// dataOverride 可选：传入运行时拉取到的后端场景数据时，用它替换打包的 editorMapData；
// 缺省则使用打包数据，保证离线也能显示。
// outColliders 可选：碰撞体的输出数组（调用方传入自己的「共享数组」，异步烘焙结果也会 push 进同一个引用）；
// 缺省则新建一个数组并返回。
// 返回世界空间碰撞体数组 [{cx,cy,cz,hx,hy,hz}]（complex 物体额外异步 push {type:'trimesh',...}）。
export function buildEditorBuildings(scene, roots, dataOverride, outColliders) {
  clearHolders(scene); // 重跑前先移除上一次添加的 holder，避免重复叠加
  clearLodTargets(); // 场景重建 → 上一轮的 LOD 登记全部作废
  clearShadowBudgets(); // 同理：上一轮的阴影名额登记全部作废（旧灯会被 disposeLight 逐个注销，这里先兜底防漏）
  const gen = ++_buildGen; // 本次构建代数（异步烘焙回调据此丢弃过期结果）
  _pendingLoads = [];  // 本次构建的模型加载 Promise（供 optimizeEditorScene 等待「都加载完」）
  let data = dataOverride || editorMapData || {};
  // 兼容旧格式：纯数组（仅含 placed）
  if (Array.isArray(data)) data = { scenery: [], placed: data };

  // ---- 1) 把保存的景物变换按 key 套回到已构建好的景物对象上 ----
  const scenery = Array.isArray(data.scenery) ? data.scenery : [];
  if (Array.isArray(roots)) {
    scenery.forEach((s) => {
      const root = roots[s && s.key];
      if (!root) return;
      if (s.id != null) root.userData.id = s.id; // 编辑器分配的数字 id
      if (typeof s.x === 'number') root.position.x = s.x;
      if (typeof s.y === 'number') root.position.y = s.y;
      if (typeof s.z === 'number') root.position.z = s.z;
      if (typeof s.rotY === 'number') root.rotation.y = s.rotY;
      if (s.scale) {
        const sc = normScale(s.scale);
        root.scale.set(sc.x, sc.y, sc.z);
      }
    });
  }

  // ---- 2) 渲染编辑器新建的建筑，并收集其世界空间碰撞体 ----
  const colliders = outColliders || [];
  const placed = Array.isArray(data.placed) ? data.placed : [];
  placed.forEach((it) => {
    if (!it) return;
    const sc = normScale(it.scale);
    // 统一挂到 holder，应用位置/轴向缩放/朝向
    const holder = new THREE.Group();
    holder.name = it.name || nameFromUrl(it.url) || 'editor-object';
    holder.userData.id = (it.id ?? ''); // 编辑器分配的数字 id，运行时可据此定位
    holder.position.set(it.x ?? 0, it.y ?? 0, it.z ?? 0);
    holder.scale.set(sc.x, sc.y, sc.z);
    holder.rotation.y = it.rotY ?? 0;
    scene.add(holder);
    _addedHolders.push(holder); // 记录以便下次重建时移除

    // ---- complex 模式：模型加载完成后，从渲染网格异步烘焙 trimesh（运行时零存储）----
    // 为什么必须在这里烘焙：室内模型常把「一整块合并的大地面 + 多层楼板」放进同一个 mesh，
    // 逐 mesh 求盒/凸包只会得到一个罩住整栋楼的大凸包，完全不可用；trimesh 直接取三角形本身，
    // 再配合 3D 宽相位（XZ 分格 + Y 分层）与 BVH，多层楼板才能各自正确碰撞。
    const isComplex = it.collisionMode === 'complex';
    // 跨 object3D 的稳定缓存键：同一 url + 同一变换只烘一次（场景重建时可直接复用，含位置/朝向/缩放）
    const bakeKey = it.url
      ? [it.url, it.x ?? 0, it.y ?? 0, it.z ?? 0, it.rotY ?? 0, sc.x, sc.y, sc.z].join('|')
      : '';
    const bakeComplex = () => {
      holder.updateMatrixWorld(true);
      bakeTriMeshAsync(holder, { key: bakeKey })
        .then((tm) => {
          // 场景已重建 → 丢弃过期结果（否则上一份场景的碰撞体会混进新场景）
          if (gen !== _buildGen) return;
          if (tm && tm.triCount > 0) colliders.push(tm);
        })
        // ⚠ 这里曾经是 .catch(() => {})：2026-10-05 那次「碰撞全没了、控制台却不报错」就是它干的 ——
        //    回调里一个 ReferenceError 被静默吞掉，碰撞体永远 push 不进去。现在必须打日志。
        .catch((e) => { console.error('[EditorBuildings] trimesh 烘焙失败:', e); });
    };

    // 模型加载完成后的统一处理：合并静态子网格 → 开阴影 → 按需烘焙 trimesh
    const setupModel = (m) => {
      holder.add(m);
      holder.updateMatrixWorld(true); // 合并要用正确的 matrixWorld（相对 root 烘几何）
      const st = mergeStaticMeshes(m);
      if (st.after < st.before) {
        console.info('[EditorBuildings] ' + (holder.name || 'model') + ' 网格合并 ' + st.before + ' → ' + st.after +
          '（主渲染 + 阴影贴图两趟各少 ' + (st.before - st.after) + ' 次 draw call）');
      }
      enableShadows(m);
      // 标记「可以参与跨物件合并」：complex 物体要靠渲染网格烘 trimesh 碰撞，
      // 合并会把网格搬走，可能让还在后台跑的烘焙算一半 —— 宁可少合也不出错。
      holder.userData.__batchable = !isComplex;
      if (isComplex) bakeComplex();
    };

    // 统一绝对路径 /assets/xxx.glb 调用；兼容旧的内嵌 data URL 记录
    if (it.url) {
      _pendingLoads.push(instantiate(it.url).then(setupModel).catch(() => {}));
    } else if (it.data) {
      // 旧的内嵌 data URL 记录：不走 AssetLoader 缓存，这里手动登记进加载计数
      _pendingLoads.push(track(new Promise((resolve) => {
        const loader = new GLTFLoader();
        loader.load(it.data, (gltf) => { resolve(gltf.scene); setupModel(gltf.scene); }, undefined, () => resolve(null));
      })));
    }

    // 碰撞体：OBB（有向包围盒），把朝向 rotY（Y 轴旋转角）一并给出，使碰撞体随模型旋转。
    // 盒尺寸按 holder 的缩放换算到世界尺寸；多盒优先：存在 colliders 数组时按每个盒生成，否则回退单盒 collider。
    // P1：逐盒支持 ox/oz（水平偏移）与可选四元数（逐盒朝向）。缺省 ox/oz=0、无四元数 → 与旧行为完全一致。
    //   - 合成朝向为纯 Y 旋转 → 仍走盒快路径（物理侧 OBB/rotY），无需新增代码路径
    //   - 合成朝向含 X/Z 分量 → 展开 8 角点为凸包（复用现有凸包 SAT）
    holder.updateMatrixWorld(true);
    const _corner = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    // 盒的 8 角点索引：bit2=+X, bit1=+Y, bit0=+Z；面按外法线 CCW 缠绕
    const BOX_FACES = [
      4, 6, 7, 4, 7, 5, // +X
      0, 1, 3, 0, 3, 2, // -X
      2, 3, 7, 2, 7, 6, // +Y
      0, 4, 5, 0, 5, 1, // -Y
      1, 5, 7, 1, 7, 3, // +Z
      0, 2, 6, 0, 6, 4, // -Z
    ];
    const mkColl = (cb) => {
      const hx = cb.hx ?? 0, hy = cb.hy ?? 0, hz = cb.hz ?? 0;
      const ox = cb.ox ?? 0, oy = cb.oy ?? 0, oz = cb.oz ?? 0;
      const bx = hx * sc.x, by = hy * sc.y, bz = hz * sc.z; // 世界半尺寸
      // 盒本地中心 → 世界中心（经 holder 矩阵，含位置/rotY/缩放）
      _corner.set(ox, oy, oz).applyMatrix4(holder.matrixWorld);
      const cx = _corner.x, cy = _corner.y, cz = _corner.z;

      // 合成朝向 = 物体朝向(仅 rotY) ∘ 盒四元数
      let pureY = true;
      let rotY = it.rotY ?? 0;
      if (typeof cb.qw === 'number') {
        _q.set(cb.qx ?? 0, cb.qy ?? 0, cb.qz ?? 0, cb.qw);
        if (Math.abs(cb.qx ?? 0) > 1e-6 || Math.abs(cb.qz ?? 0) > 1e-6) pureY = false;
        else rotY = (it.rotY ?? 0) + 2 * Math.atan2(cb.qy ?? 0, cb.qw);
      }

      if (pureY) {
        colliders.push({ cx, cy, cz, hx: bx, hy: by, hz: bz, rotY });
        return;
      }

      // 含非 Y 分量：展开 8 角点为世界凸包（物理侧走凸包 SAT）
      const verts = new Float64Array(24);
      const _v = new THREE.Vector3();
      for (let i = 0; i < 8; i++) {
        const sx = (i & 4) ? 1 : -1, sy = (i & 2) ? 1 : -1, sz = (i & 1) ? 1 : -1;
        // 先按盒四元数绕盒中心旋转，再加上盒偏移，最后经 holder 矩阵变换到世界
        _v.set(sx * hx, sy * hy, sz * hz);
        if (typeof cb.qw === 'number') _v.applyQuaternion(_q);
        _corner.set(ox + _v.x, oy + _v.y, oz + _v.z).applyMatrix4(holder.matrixWorld);
        verts[i * 3] = _corner.x; verts[i * 3 + 1] = _corner.y; verts[i * 3 + 2] = _corner.z;
      }
      let minY = Infinity, maxY = -Infinity;
      for (let i = 1; i < 24; i += 3) { if (verts[i] < minY) minY = verts[i]; if (verts[i] > maxY) maxY = verts[i]; }
      colliders.push({
        type: 'convex',
        vertices: Array.from(verts),
        faces: BOX_FACES.slice(),
        minY, maxY,
        cx, cy, cz,
      });
    };
    // collisionMode：simple（默认）走逐盒/凸包生成；complex 由运行时从渲染网格烘焙，此处不生成
    if (it.collisionMode !== 'complex') {
      if (Array.isArray(it.colliders) && it.colliders.length) {
        for (const cb of it.colliders) mkColl(cb);
      } else {
        const c = it.collider;
        if (c && c.enabled !== false) mkColl(c);
      }
    }

    // 凸包碰撞体（优先于盒类）：把本地凸包顶点按 holder 的 位置/旋转(rotY)/缩放 变换到世界空间。
    // 玩家物理按凸包面法线 + 世界三轴做 SAT 检测。多凸包(convexParts，V-HACD 凸分解)优先于单凸包。
    const pushHull = (hull, mtx) => {
      const sv = hull.vertices;
      if (!Array.isArray(sv) || sv.length < 9) return;
      const wv = new Float64Array(sv.length);
      const p = new THREE.Vector3();
      let minY = Infinity, maxY = -Infinity;
      let cx = 0, cy = 0, cz = 0;
      for (let i = 0; i < sv.length; i += 3) {
        p.set(sv[i], sv[i + 1], sv[i + 2]).applyMatrix4(mtx);
        wv[i] = p.x; wv[i + 1] = p.y; wv[i + 2] = p.z;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
        cx += p.x; cy += p.y; cz += p.z;
      }
      const n = sv.length / 3;
      colliders.push({
        type: 'convex',
        vertices: Array.from(wv),
        faces: hull.faces.slice(),
        minY, maxY,
        cx: cx / n, cy: cy / n, cz: cz / n, // 世界空间质心，用于解析方向判断
      });
    };
    if (Array.isArray(it.convexParts) && it.convexParts.length) {
      if (!isComplex) { // complex：碰撞完全由 trimesh 提供，不再产出凸包（避免与 trimesh 重复/罩住整栋楼）
        holder.updateMatrixWorld(true);
        for (const hull of it.convexParts) pushHull(hull, holder.matrixWorld);
      }
    } else if (it.convex && Array.isArray(it.convex.vertices) && Array.isArray(it.convex.faces) && it.convex.faces.length >= 3) {
      if (!isComplex) {
        holder.updateMatrixWorld(true);
        pushHull(it.convex, holder.matrixWorld);
      }
    }
  });
  return colliders;
}

function enableShadows(obj) {
  obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
}

// ---- 编辑器光源（点光源 / 面光源）----
// 数据字段：{ id, type:'point'|'area', x, y, z, color, intensity, distance, decay, width, height, rotY, rotX }
// 其中 distance/decay 仅 point 使用，width/height/rotY/rotX 仅 area 使用。
// RectAreaLight 的 LTC 查找表只初始化一次即可，用模块级标志位保证幂等（重复 init 会重复生成纹理）。
let _rectAreaLibReady = false;
function ensureRectAreaLib() {
  if (_rectAreaLibReady) return;
  RectAreaLightUniformsLib.init();
  _rectAreaLibReady = true;
}

// 各字段缺省值（与编辑器约定保持一致）。
// ⚠ 面光源那几个字段**必须**从 AREA_LIGHT_DEFAULTS 取 —— 分叉写死过一次默认值，
//   结果「存档里没有 rotX 的灯」在编辑器里是横的、在游戏端是朝下的（横转 90° 那个 bug）。
const LIGHT_DEFAULTS = {
  color: '#ffffff', intensity: 1, distance: 12, decay: 2,
  width: AREA_LIGHT_DEFAULTS.width, height: AREA_LIGHT_DEFAULTS.height,
  rotY: AREA_LIGHT_DEFAULTS.rotY, rotX: AREA_LIGHT_DEFAULTS.rotX,
};
// 面光源没有 distance/decay（LTC 自带平方反比），但阴影代理需要一个衰减半径，这里给个默认值
const AREA_SHADOW_DEFAULT_DISTANCE = AREA_LIGHT_DEFAULTS.distance;

// 数值容错：非有限数取默认值
function finiteOr(v, dflt) {
  return (typeof v === 'number' && Number.isFinite(v)) ? v : dflt;
}

// 颜色容错：仅接受 #rrggbb / #rgb / 有限数值，否则用默认白
function colorOf(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return new THREE.Color(v);
  if (typeof v === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v.trim())) return new THREE.Color(v.trim());
  return new THREE.Color(LIGHT_DEFAULTS.color);
}

// 释放光源：Light 本身不占 GPU 资源，但仍按需清理其子树可能携带的几何/材质，避免残留。
// 同时从阴影管理器注销 —— 本函数会被调用两次（打包数据 + 远端数据），不注销的话旧灯会一直占着名额。
function disposeLight(obj) {
  // ⚠ 面光源要先归还阴影代理（它会把本体亮度改回去并注销名额），再走下面的子树清理
  if (obj.isRectAreaLight) releaseAreaShadow(obj);
  obj.traverse((o) => {
    if (o.isRectAreaLight) releaseAreaShadow(o);
    if (o.isLight) unregisterPointLight(o);
    if (o.geometry && o.geometry.dispose) o.geometry.dispose();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) if (m && m.dispose) m.dispose();
    }
  });
}

// ===========================================================================
// 跨物件同材质合并（draw call 优化的第二步）
// ---------------------------------------------------------------------------
// 第一步 mergeStaticMeshes 已经把「一个模型内部」的几百个小网格合掉了；
// 但「同一棵树摆了 4 遍」这种**跨物件**的同材质网格仍是各画各的，这里再合一轮。
//
// 为什么按空间格切块：合并之后就只剩「整块显隐」这一种控制粒度了。切成 BATCH_GRID 米的格子、
// 每格一批，Lod.js 才能按距离整块剔除 —— 合并与 LOD 才不互相打架。
//
// ⚠ 只合并不透明的静态网格：透明物体合并会打乱排序，骨骼/morph 网格的几何会随动画变。
// ⚠ 只合并 __batchable（没有 complex 碰撞）的物件：complex 靠渲染网格烘 trimesh 碰撞，
//   合并会把网格搬走，可能让还在后台跑的烘焙算一半。
// ===========================================================================
const BATCH_GRID = 48; // 空间格边长（米）

// ⚠⚠ 默认关闭（2026-10-05）：用户报「碰撞没了」，而**唯一会"把网格搬走"的改动就是这里**。
//   已知的危险交互：trimesh.js 的 collectMeshes 里有 `if (!isVisible(o)) return;`
//   —— 不可见的网格**不参与碰撞烘焙**。LOD 会把远处对象设成 visible=false，
//   一旦烘焙的收集时机与隐藏重叠，就会烘出空碰撞体（碰撞直接消失）。
//   在把「合并 / LOD / 烘焙」三者的时序彻底理清之前，先把跨物件合并关掉，恢复"碰撞必定正常"。
//   要重新启用：改成 true 并确认放置/移动/对战隐藏都不会与烘焙打架。
const ENABLE_BATCH_MERGE = false;

export function whenEditorLoadsSettled() {
  const list = _pendingLoads.slice();
  return Promise.all(list.map((p) => (p && p.catch) ? p.catch(() => {}) : p));
}

// 返回 { before, after, batches } 供日志；失败时原样保留，画面不受影响。
// holdersOverride 仅供自检注入（正常调用不传）。
export function mergeSceneBatches(scene, holdersOverride) {
  if (!ENABLE_BATCH_MERGE) return { before: 0, after: 0, batches: 0, disabled: true };
  const holders = (holdersOverride || _addedHolders).filter((h) => h.parent && h.userData && h.userData.__batchable);
  const srcMeshes = [];
  for (const h of holders) {
    h.updateMatrixWorld(true);
    h.traverse((o) => {
      if (!o.isMesh || o.isSkinnedMesh) return;
      if (o.morphTargetInfluences && o.morphTargetInfluences.length) return;
      if (Array.isArray(o.material)) return;      // 材质数组的网格各部分要各自渲染
      const g = o.geometry;
      if (!g || !g.attributes || !g.attributes.position) return;
      if (!o.material || o.material.transparent) return;
      srcMeshes.push(o);
    });
  }
  const before = srcMeshes.length;
  if (before < 4) return { before, after: before, batches: 0 }; // 太少，收益抵不上开销

  const _p = new THREE.Vector3();
  const groups = new Map(); // 空间格 + 几何布局 + 材质外观 → 一批
  for (const o of srcMeshes) {
    _p.setFromMatrixPosition(o.matrixWorld);
    const cell = Math.floor(_p.x / BATCH_GRID) + '_' + Math.floor(_p.z / BATCH_GRID);
    const key = cell + '#' + geometrySigKey(o.geometry) + '#' + materialSigKey(o.material);
    let grp = groups.get(key);
    if (!grp) { grp = { material: o.material, list: [] }; groups.set(key, grp); }
    grp.list.push(o);
  }

  const batchRoot = new THREE.Group();
  batchRoot.name = 'scene-batches';
  let batches = 0;
  for (const grp of groups.values()) {
    if (grp.list.length < 2) continue; // 单件没有合并收益
    const geos = [];
    for (const o of grp.list) {
      const g = o.geometry.clone(); // 必须克隆：instantiate 是浅克隆，几何与缓存源模型共享
      g.applyMatrix4(o.matrixWorld); // 直接烘到世界坐标（批次挂在 scene 下、单位变换）
      // 镜像节点（行列式为负）合并后绕向会反，必须翻回来，否则出现内壁/破面
      if (o.matrixWorld.determinant() < 0) flipTriangleWinding(g);
      geos.push(g);
    }
    let merged = null;
    try { merged = mergeGeometries(geos, false); } catch (e) { merged = null; }
    for (const g of geos) g.dispose(); // 中间克隆体已烘进 merged
    if (!merged) continue; // 属性布局意外不一致：保留原件，画面不受影响

    const mesh = new THREE.Mesh(merged, grp.material);
    mesh.name = 'batch-' + (grp.material && grp.material.name ? grp.material.name : batches);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false; // 单位变换，不必每帧重算矩阵
    mesh.updateMatrix();
    batchRoot.add(mesh);
    for (const o of grp.list) o.removeFromParent();
    batches++;
  }
  if (!batches) return { before, after: before, batches: 0 };

  scene.add(batchRoot);
  _addedHolders.push(batchRoot); // 重建时随 clearHolders 一起清掉；对战隐藏也靠它

  // 被掏空的 holder 从场景摘掉（留着只会让每帧的矩阵遍历更长）
  for (const h of holders) {
    let hasMesh = false;
    h.traverse((o) => { if (o.isMesh) hasMesh = true; });
    if (hasMesh) continue;
    h.removeFromParent();
    const i = _addedHolders.indexOf(h);
    if (i >= 0) _addedHolders.splice(i, 1);
  }

  const after = countMeshes(batchRoot);
  console.info('[EditorBuildings] 跨物件同材质合并 ' + before + ' → ' + after +
    ' 个网格（' + batches + ' 批，按 ' + BATCH_GRID + 'm 空间格切块以便远处整块剔除）');
  return { before, after, batches };
}

// 场景优化统一入口：等模型加载完 → 跨物件合并 → 把结果登记进距离分级（Lod.js）。
// 合并后的每个批次、以及没被合并的物件（complex 碰撞的、透明的、单件的）都要登记，
// 否则它们永远是全细节渲染。
export async function optimizeEditorScene(scene) {
  await whenEditorLoadsSettled();
  let st = { before: 0, after: 0, batches: 0 };
  try {
    st = mergeSceneBatches(scene);
  } catch (e) {
    console.warn('[EditorBuildings] 场景合并失败（保持原样）:', e);
  }
  for (const h of _addedHolders) {
    if (!h.parent) continue;
    if (h.name === 'scene-batches') {
      for (const b of h.children) registerLodTarget(b);
    } else {
      // ⚠ complex 碰撞（trimesh）的物件：碰撞是从**渲染网格**烘出来的，而烘焙会跳过不可见网格
      //   （trimesh.js: `if (!isVisible(o)) return;`）→ 这类对象只许关投影，**绝不许隐藏**。
      const noHide = h.userData && h.userData.__batchable === false;
      registerLodTarget(h, { noHide });
    }
  }
  return st;
}

// buildEditorLights(scene, dataOverride)：把编辑器保存的光源渲染进场景。
// dataOverride 可选：传运行时拉取的后端数据时以其为准，缺省则用打包的 editorMapData（旧存档没有 lights 字段 → 按空数组处理）。
// 去重策略（关键）：本函数会被调用两次（先打包数据、再远端数据）。所有光源都挂在一个 Group 下，
// 并把该 Group 记在 scene.userData.__editorLights 上，每次调用先整体移除并释放这个 Group 再重建，
// 因此不会重复叠加。（注意不能逐个 scene.remove(light)：光源的父节点是 Group 不是 scene，那样删不掉。）
// 返回本次创建的光源 Group（已 add 进 scene）。
export function buildEditorLights(scene, dataOverride) {
  // 先清掉上一次创建的那一整组光源
  const prev = scene.userData ? scene.userData.__editorLights : null;
  if (prev) {
    scene.remove(prev);
    disposeLight(prev);
  }

  const group = new THREE.Group();
  group.name = 'editor-lights';

  const data = dataOverride || editorMapData || {};
  const lights = (!Array.isArray(data) && data && Array.isArray(data.lights)) ? data.lights : [];

  for (const it of lights) {
    if (!it || typeof it !== 'object') continue;

    // 坐标必须是有限数，否则跳过该条
    const x = it.x, y = it.y, z = it.z;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;

    const color = colorOf(it.color);
    const intensity = finiteOr(it.intensity, LIGHT_DEFAULTS.intensity);

    if (it.type === 'point') {
      const light = new THREE.PointLight(
        color,
        intensity * LIGHT_SCALE,
        finiteOr(it.distance, LIGHT_DEFAULTS.distance),
        finiteOr(it.decay, LIGHT_DEFAULTS.decay)
      );
      light.position.set(x, y, z);
      // 点光源登记进阴影管理器 → 光被墙挡住，不会照进隔壁房间
      // （谁真正投影由 Lights.updateShadowBudgets 按离相机远近决定，最多 4 盏）
      registerPointLight(light);
      group.add(light);
    } else if (it.type === 'area') {
      ensureRectAreaLib(); // 面光源使用前必须初始化一次 LTC 查找表
      const light = new THREE.RectAreaLight(
        color,
        intensity,
        finiteOr(it.width, LIGHT_DEFAULTS.width),
        finiteOr(it.height, LIGHT_DEFAULTS.height)
      );
      light.position.set(x, y, z);
      // RectAreaLight 沿本地 -Z 发光：rotX 为俯仰（度，负值朝下），默认 -90 即垂直向下。
      // 用 YXZ 顺序（先偏航 rotY 再俯仰 rotX），与相机朝向约定一致。
      light.rotation.order = 'YXZ';
      light.rotation.set(
        THREE.MathUtils.degToRad(finiteOr(it.rotX, LIGHT_DEFAULTS.rotX)),
        THREE.MathUtils.degToRad(finiteOr(it.rotY, LIGHT_DEFAULTS.rotY)),
        0
      );
      // 面光源自己不能投影（RectAreaLight 没有 shadow 字段，LTC 模型不支持）→ 配一盏阴影代理聚光灯。
      // 代理会分走大部分亮度并真正被墙挡住，本体留一小部分保留面光质感。见 Lights.enableAreaShadow。
      enableAreaShadow(light, { distance: finiteOr(it.distance, AREA_SHADOW_DEFAULT_DISTANCE) });
      group.add(light);
    } else {
      continue; // 未知类型跳过
    }
  }

  scene.add(group);
  scene.userData.__editorLights = group;
  return group;
}