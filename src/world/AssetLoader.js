// 职责：封装 GLTFLoader，对 GLB 模型做单例加载与 Promise 缓存，并暴露“克隆实例”与“占位兜底”能力。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

let _loader = null;

// url -> Promise<scene>，同一资源只请求一次，命中缓存直接复用
const cache = new Map();

// 把绝对路径转相对：去掉前导 '/'，让 GLB 相对当前页面 URL 解析。
// 兼容 GitHub Pages 根路径与子路径部署（如 https://host/repo/ 下 assets/building.glb 落到 /repo/assets/building.glb）。
function normalizeUrl(url) {
  if (typeof url === 'string' && url.startsWith('/')) return url.slice(1);
  return url;
}

// 加载并解析一个 GLB，返回解析后的根场景（Object3D）。
// 每个实例需自行 clone，因为解析结果只有一个共享的根节点。
function loadGLB(url) {
  url = normalizeUrl(url);
  if (cache.has(url)) return cache.get(url);

  if (!_loader) _loader = new GLTFLoader();
  const promise = new Promise((resolve, reject) => {
    _loader.load(
      url,
      (gltf) => resolve(gltf.scene),
      undefined,
      (err) => {
        console.warn('[AssetLoader] 加载失败:', url, err);
        reject(err);
      }
    );
  });

  cache.set(url, promise);
  return promise;
}

// 异步返回一个独立副本（克隆共享 geometry/material），供单个道具使用。
// 失败时 reject，由调用方继续使用占位模型。
export function instantiate(url) {
  return loadGLB(url).then((scene) => scene.clone(true));
}

// 生成一个简单占位道具：方块，失败兜底，避免场景里出现空缺/白屏。
export function createFallback({ color = 0x888888, width = 1, height = 1, depth = 1 } = {}) {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color });
  const box = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
  box.position.y = height / 2; // 方块立在 y=0 地面上
  group.add(box);
  return group;
}