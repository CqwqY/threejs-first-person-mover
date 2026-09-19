// 职责：把编辑器（editor.html「保存场景」）写入 src/world/editorMapData.js 的地图数据
// 直接 import 并应用到游戏场景。保存即改动源码模块，游戏刷新即生效。
// 数据格式：{ scenery:[{key,x,y,z,rotY,scale:{x,y,z}}...], placed:[{name,url,x,y,z,rotY,scale:{x,y,z},collider:{...}}...] }
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { instantiate } from './AssetLoader.js';
import { editorMapData } from './editorMapData.js';

// scale 规范化：统一为 {x,y,z}，兼容旧的单数值
function normScale(s) {
  if (s && typeof s === 'object' && typeof s.x === 'number') {
    return { x: s.x, y: (typeof s.y === 'number' ? s.y : s.x), z: (typeof s.z === 'number' ? s.z : s.x) };
  }
  const v = (typeof s === 'number' && Number.isFinite(s)) ? s : 1;
  return { x: v, y: v, z: v };
}

// buildEditorBuildings(scene, roots)：roots 为 buildScenery 返回的统一可编辑根列表，
// 数组下标即 scenery 的 key，两侧顺序完全一致。
// 返回世界空间碰撞体数组 [{cx,cy,cz,hx,hy,hz}]，供玩家碰撞使用。
export function buildEditorBuildings(scene, roots) {
  let data = editorMapData || {};
  // 兼容旧格式：纯数组（仅含 placed）
  if (Array.isArray(data)) data = { scenery: [], placed: data };

  // ---- 1) 把保存的景物变换按 key 套回到已构建好的景物对象上 ----
  const scenery = Array.isArray(data.scenery) ? data.scenery : [];
  if (Array.isArray(roots)) {
    scenery.forEach((s) => {
      const root = roots[s && s.key];
      if (!root) return;
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
    holder.name = it.name || 'editor-object';
    holder.position.set(it.x ?? 0, it.y ?? 0, it.z ?? 0);
    holder.scale.set(sc.x, sc.y, sc.z);
    holder.rotation.y = it.rotY ?? 0;
    scene.add(holder);

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

    // 碰撞体：AABB（忽略旋转），按 holder 的缩放换算到世界尺寸
    const c = it.collider;
    if (c && c.enabled !== false) {
      colliders.push({
        cx: it.x ?? 0,
        cy: (it.y ?? 0) + (c.oy ?? 0) * sc.y,
        cz: it.z ?? 0,
        hx: (c.hx ?? 0) * sc.x,
        hy: (c.hy ?? 0) * sc.y,
        hz: (c.hz ?? 0) * sc.z,
      });
    }
  });
  return colliders;
}

function enableShadows(obj) {
  obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
}