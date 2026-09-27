// 职责：把编辑器（editor.html「保存场景」）写入 src/world/editorMapData.js 的地图数据
// 直接 import 并应用到游戏场景。保存即改动源码模块，游戏刷新即生效。
// 数据格式：{ scenery:[{key,x,y,z,rotY,scale:{x,y,z}}...], placed:[{name,url,x,y,z,rotY,scale:{x,y,z},collider:{...}}...] }
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { instantiate } from './AssetLoader.js';
import { editorMapData } from './editorMapData.js';
import { API_BASE } from '../config.js';

// 记录上一次已挂进场景的 holder（防止重复调用时旧建筑残留），再次构建前先清空
let _addedHolders = [];
function clearHolders(scene) {
  for (const h of _addedHolders) scene.remove(h);
  _addedHolders = [];
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

// buildEditorBuildings(scene, roots, dataOverride)：roots 为 buildScenery 返回的统一可编辑根列表，
// 数组下标即 scenery 的 key，两侧顺序完全一致。
// dataOverride 可选：传入运行时拉取到的后端场景数据时，用它替换打包的 editorMapData；
// 缺省则使用打包数据，保证离线也能显示。
// 返回世界空间碰撞体数组 [{cx,cy,cz,hx,hy,hz}]，供玩家碰撞使用。
export function buildEditorBuildings(scene, roots, dataOverride) {
  clearHolders(scene); // 重跑前先移除上一次添加的 holder，避免重复叠加
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
  const colliders = [];
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

    // 统一绝对路径 /assets/xxx.glb 调用；兼容旧的内嵌 data URL 记录
    if (it.url) {
      instantiate(it.url)
        .then((m) => { holder.add(m); enableShadows(m); })
        .catch(() => {});
    } else if (it.data) {
      const loader = new GLTFLoader();
      loader.load(
        it.data,
        (gltf) => { holder.add(gltf.scene); enableShadows(gltf.scene); },
        undefined,
        () => {}
      );
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
      holder.updateMatrixWorld(true);
      for (const hull of it.convexParts) pushHull(hull, holder.matrixWorld);
    } else if (it.convex && Array.isArray(it.convex.vertices) && Array.isArray(it.convex.faces) && it.convex.faces.length >= 3) {
      holder.updateMatrixWorld(true);
      pushHull(it.convex, holder.matrixWorld);
    }
  });
  return colliders;
}

function enableShadows(obj) {
  obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
}