// 职责：封装 GLTFLoader，对 GLB 模型做单例加载与 Promise 缓存，并暴露“克隆实例”与“占位兜底”能力。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { API_BASE } from '../config.js';
import { track } from './loadTracker.js';
import { fetchAsset, isCacheable } from './assetCache.js';

let _loader = null;

// url -> Promise<scene>，同一资源只请求一次，命中缓存直接复用
const cache = new Map();

// 本次运行里「命中本地缓存 / 走了网络」的件数，加载结束时打一行，便于确认缓存到底生效了没
const stat = { hit: 0, miss: 0, bytes: 0 };

// 把绝对路径转相对：去掉前导 '/'，让 GLB 相对当前页面 URL 解析。
// 兼容 GitHub Pages 根路径与子路径部署（如 https://host/repo/ 下 assets/building.glb 落到 /repo/assets/building.glb）。
function normalizeUrl(url) {
  if (typeof url === 'string' && url.startsWith('/')) return url.slice(1);
  return url;
}

// 统一模型地址解析：决定每个 url 该从哪台主机加载。
// - 已上传/导入到后端的模型（/assets/import-*.glb）→ 拼上 API_BASE 走远程后端；
// - 其余（内建 /assets/*、旧导入 /models/*）→ 相对当前页面解析（GitHub Pages 上随站点一起托管）。
function resolveUrl(url) {
  if (typeof url !== 'string') return url;
  if (/^https?:/i.test(url) || url.startsWith('//')) return url; // 已是绝对地址直接用
  if (url.startsWith('/assets/import-')) return API_BASE + url; // 后端托管的上传模型
  return normalizeUrl(url);
}

// 加载并解析一个 GLB，返回解析结果 gltf（scene + animations）；同一资源只请求一次。
// 每个实例需自行 clone，因为解析结果只有一个共享的根节点。
//
// 字节统一走 assetCache：第二次打开页面时模型从本地缓存直接取，不再重复下载
// （boy/girl 的人物模型各 1~1.6MB、四张天空全景图 4MB 多，每次重下太浪费）。
function loadGLB(url) {
  url = resolveUrl(url);
  if (cache.has(url)) return cache.get(url);

  if (!_loader) _loader = new GLTFLoader();
  const promise = new Promise((resolve, reject) => {
    const ok = (gltf) => resolve(gltf);
    const bad = (err) => {
      console.warn('[AssetLoader] 加载失败:', url, err);
      reject(err);
    };
    if (!isCacheable(url)) {
      _loader.load(url, ok, undefined, bad); // data:/blob: 这类本来就在内存里，直接走原路径
      return;
    }
    fetchAsset(url).then(({ buf, cached }) => {
      stat[cached ? 'hit' : 'miss']++;
      stat.bytes += buf.byteLength;
      // GLB 是自包含的（贴图内嵌），path 给空串即可
      _loader.parse(buf, '', ok, bad);
    }).catch(bad);
  });

  cache.set(url, track(promise)); // 登记到加载计数：进游戏前的加载动画据此判断「模型都到了没」
  return cache.get(url);
}

// 本次会话的缓存命中情况（调试用：控制台里看缓存到底有没有生效）
export function assetCacheStat() {
  return { ...stat };
}

// 异步返回一个独立副本（克隆共享 geometry/material），供单个道具使用。
// 失败时 reject，由调用方继续使用占位模型。
export function instantiate(url) {
  return loadGLB(url).then((gltf) => gltf.scene.clone(true));
}

// 带骨骼的模型（boy/girl 的人物模型）：返回 { root, animations }。
// ⚠ 必须用 SkeletonUtils.clone：Object3D.clone() 不会复制 SkinnedMesh 与骨架的绑定关系，
// 克隆出来的网格会共用原模型的骨头（动画一播，所有玩家一起动，甚至形变错乱）。
export function instantiateRigged(url) {
  return loadGLB(url).then((gltf) => ({
    root: cloneSkeleton(gltf.scene),
    animations: gltf.animations || [],
  }));
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