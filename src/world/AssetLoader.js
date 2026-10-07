// 职责：封装 GLTFLoader，对 GLB 模型做单例加载与 Promise 缓存，并暴露“克隆实例”与“占位兜底”能力。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { API_BASE } from '../config.js';
import { track } from './loadTracker.js';
import { fetchAsset, isCacheable } from './assetCache.js';
import { mergeStaticMeshes, countMeshes } from './Merge.js';

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

// 运行时探明的「站点上没有、只有服务端有」的 url：第一次按同源加载会 404，
// 记下来后直接走 API_BASE，避免同一件模型反复 404。
const remoteOnly = new Set();
function canTryRemote(rawUrl) {
  return typeof rawUrl === 'string' && /^\/(assets|models)\//.test(rawUrl) && !remoteOnly.has(rawUrl);
}

// 统一模型地址解析：决定每个 url 该从哪台主机加载。
// - **服务端上传目录**的模型（/assets/import-*.glb 编辑器上传、/assets/furn_*.glb 商店家具）→
//   拼上 API_BASE 走远程后端。这两类文件只存在于服务器的 data/assets，**站点上根本没有**。
//   ⚠ 漏了 furn_ 就是「全都模型失败」：浏览器会拿 /assets/furn_xxx.glb 去问 GitHub Pages，
//   而 Pages 的 public/assets 里只有内建模型 → 404 → 家具全部回退占位方块。
// - 其余（内建 /assets/*、旧导入 /models/*）→ 相对当前页面解析（GitHub Pages 上随站点一起托管）。
function resolveUrl(url) {
  if (typeof url !== 'string') return url;
  if (/^https?:/i.test(url) || url.startsWith('//')) return url; // 已是绝对地址直接用
  if (remoteOnly.has(url)) return API_BASE + url;                // 已探明「只有服务端有」
  if (/^\/assets\/(import-|furn_)/.test(url)) return API_BASE + url; // 服务端托管：上传模型 / 家具
  return normalizeUrl(url);
}

// 加载后立刻做一次「同材质小网格合并」（导出模型常是几百个几十三角形的小网格，
// 三角形不是瓶颈、**提交次数**才是：开阴影后主渲染 + 阴影贴图各一趟）。
//
// 为什么放在加载期而不是摆放时：缓存里的原型合并一次，之后每次 instantiate 只是 clone ——
//   家具 / 组合家具 / 编辑器摆放 / 景物**全部**受益，且不用在每个调用点各写一遍。
//   （线上那两栋室内模型是 828 / 837 个网格，合并后只剩个位数。）
//
// ⚠ 两条硬约束（漏一条就是"模型动不了 / 骨架断了"）：
//   ① 有**动画**的模型不能合并：合并把顶点烘进 root 局部空间，节点动画就没得动了；
//   ② 有**骨骼**的模型不能合并：mergeStaticMeshes 内部已整体跳过（连同"清空气节点"，
//      否则末端骨头会被当成空节点删掉）。
//   这两类模型本来就只有几个网格，收益为 0，风险却是满的。
export function optimizeLoadedModel(gltf, url) {
  try {
    const scene = gltf && gltf.scene;
    if (!scene) return null;
    if (gltf.animations && gltf.animations.length) return null; // ① 动画模型：不合并
    const before = countMeshes(scene);
    if (before < 8) return null; // 网格太少，合并收益抵不上开销
    const st = mergeStaticMeshes(scene);
    if (st.after < st.before) {
      console.info('[AssetLoader] ' + (url || 'model') + ' 网格合并 ' + st.before + ' → ' + st.after +
        '（' + st.mergedGroups + ' 批；主渲染 + 阴影贴图两趟各少 ' + (st.before - st.after) + ' 次 draw call）');
    }
    return st;
  } catch (e) {
    console.warn('[AssetLoader] 模型合并失败（保持原样）:', url, e);
    return null;
  }
}

// 加载并解析一个 GLB，返回解析结果 gltf（scene + animations）；同一资源只请求一次。
// 每个实例需自行 clone，因为解析结果只有一个共享的根节点。
//
// 字节统一走 assetCache：第二次打开页面时模型从本地缓存直接取，不再重复下载
// （boy/girl 的人物模型各 1~1.6MB、四张天空全景图 4MB 多，每次重下太浪费）。
function loadGLB(rawUrl) {
  const url = resolveUrl(rawUrl);
  if (cache.has(url)) return cache.get(url);

  if (!_loader) _loader = new GLTFLoader();
  const promise = new Promise((resolve, reject) => {
    // 解析完立刻合并同材质小网格（缓存的是合并后的原型，之后每个实例都是它的克隆）
    const ok = (gltf) => { optimizeLoadedModel(gltf, url); resolve(gltf); };
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

  let tracked = track(promise); // 登记到加载计数：进游戏前的加载动画据此判断「模型都到了没」
  // 兜底：站点同源上确实没有这个文件（上传/家具类模型只在服务端），再试一次远程。
  // 命中后记进 remoteOnly，之后同一 url 直接走 API_BASE，不再多一次 404。
  if (canTryRemote(rawUrl)) {
    tracked = track(tracked.catch(() => {
      remoteOnly.add(rawUrl);
      cache.delete(url);
      return loadGLB(rawUrl);
    }));
  }
  // ⚠ 失败**不能**永久留在缓存里：一次瞬时失败（弱网 / 20s 超时 / 被导航打断 / 缓存里取到坏字节）
  //   会把这条 url 毒死一整场 —— 后面每个玩家都拿不到身体，且不报错、不重试。
  //   表现为「名牌和手持物都在、人没了」，是最难查的一类静默失效。
  tracked.catch(() => {
    if (cache.get(url) === tracked) cache.delete(url);
  });
  cache.set(url, tracked);
  return tracked;
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