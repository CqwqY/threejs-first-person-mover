// 职责：把下载过的模型 / 贴图存到浏览器本地，第二次打开直接本地取，不再重复下载。
//
// 只缓存「体积大且几乎不变」的静态资源：GLB 模型、天空全景图。
// 场景 JSON、玩家状态、排行榜这类每次都变的一律不碰 —— 缓存它们会读到旧数据。
//
// 用 Cache API（直接存 Response，不必自己序列化；HTTPS / localhost 下可用）。
// 不可用时（旧 WebView、非安全上下文、隐私模式）自动退化成普通 fetch，功能完全不受影响。
//
// 失效：CACHE_NAME 里的版本号 +1 即可（旧的 fpm-assets-* 会在打开缓存时被删掉）；
//      想手动清就调 clearAssetCache()（设置面板里那个「清除模型缓存」按钮走的就是它）。

// ⚠ 模型/贴图换过内容就把这个版本号 +1，否则玩家会一直拿到本地那份旧的
// 本轮改用 tools/auto-rig.mjs 程序化自绑骨（放弃 Mixamo 重定向，骨与动画同坐标系），
// rig.glb 内容彻底重做，升到 v5 强制重新下载
const CACHE_NAME = 'fpm-assets-v6';
const PREFIX = 'fpm-assets-';

// 单件上限：超过就不缓存（正常模型最多几 MB，这里是防异常大文件把配额撑爆）
const MAX_ITEM_BYTES = 64 * 1024 * 1024;

let _handle = null;

// 打开（并顺手清理旧版本）缓存；拿不到就返回 null，调用方当「没缓存」处理
function cacheHandle() {
  if (_handle) return _handle;
  if (typeof caches === 'undefined' || !caches || typeof caches.open !== 'function') {
    _handle = Promise.resolve(null);
    return _handle;
  }
  _handle = (async () => {
    try {
      const c = await caches.open(CACHE_NAME);
      // 版本号变过 → 删掉上一版留下的缓存，否则旧模型永远不会被替换
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n !== CACHE_NAME && n.startsWith(PREFIX)).map((n) => caches.delete(n))
      );
      return c;
    } catch (e) {
      return null; // 隐私模式等场景下拿不到缓存：静默退化
    }
  })();
  return _handle;
}

// 只有 http(s) 的网址才进缓存：data: / blob: 本来就在内存里，没必要存
export function isCacheable(url) {
  if (typeof url !== 'string' || !url) return false;
  if (/^(data|blob):/i.test(url)) return false;
  try {
    const u = new URL(url, location.href);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

// 缓存键用绝对地址：相对路径（'assets/boy.glb'）在不同页面基准下会解析成不同的键
function cacheKey(url) {
  try {
    return new URL(url, location.href).href;
  } catch (e) {
    return url;
  }
}

// 同一地址并发请求只发一次网络：第一份下载完大家共用
const inflight = new Map();

// 带超时的 fetch：模型卡在某个连不上/不回包的主机上时，不能永远挂着
// （否则上层「加载完才可用」的逻辑会静默卡死，连报错都没有）。超时即 abort → 抛错 → 走失败兜底。
const FETCH_TIMEOUT_MS = 20000;
function fetchWithTimeout(url) {
  if (typeof AbortController === 'undefined') return fetch(url);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { signal: ac.signal }).finally(() => clearTimeout(t));
}

// 取字节：本地有就直接返回；没有就下载并顺手存一份。
// 返回 { buf, type, cached }；任何环节出问题都抛，由调用方按「加载失败」处理。
export function fetchAsset(url) {
  if (!isCacheable(url)) {
    return fetchWithTimeout(url).then(async (res) => {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' · ' + url);
      return { buf: await res.arrayBuffer(), type: res.headers.get('content-type') || '', cached: false };
    });
  }
  const key = cacheKey(url);
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const c = await cacheHandle();
    if (c) {
      try {
        const hit = await c.match(key);
        if (hit && hit.ok) {
          const buf = await hit.arrayBuffer();
          if (buf.byteLength) return { buf, type: hit.headers.get('content-type') || '', cached: true };
        }
      } catch (e) { /* 命中失败就当没缓存，走网络 */ }
    }
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error('HTTP ' + res.status + ' · ' + url);
    const buf = await res.arrayBuffer();
    const type = res.headers.get('content-type') || '';
    if (c && buf.byteLength > 0 && buf.byteLength < MAX_ITEM_BYTES) {
      // 写缓存不 await：配额满 / 存储被禁时不该拖慢或打断本次加载
      // slice(0) 复制一份给缓存，本体留给解析用（Response 会持有自己那份）
      c.put(key, new Response(buf.slice(0), { headers: { 'content-type': type } })).catch(() => {});
    }
    return { buf, type, cached: false };
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// 取一个能直接喂给 <img> / TextureLoader 的地址（blob: URL）。
// 用完必须 URL.revokeObjectURL() —— 天空全景图一张 1MB，四张常驻内存不划算。
export async function assetBlobURL(url) {
  const { buf, type } = await fetchAsset(url);
  return URL.createObjectURL(new Blob([buf], { type: type || 'application/octet-stream' }));
}

// 统计缓存规模（给设置面板显示）：{ count, bytes }
export async function assetCacheInfo() {
  const c = await cacheHandle();
  if (!c) return { count: 0, bytes: 0 };
  try {
    const list = await c.keys();
    let bytes = 0;
    for (const req of list) {
      try {
        const r = await c.match(req);
        const b = await r.arrayBuffer();
        bytes += b.byteLength;
      } catch (e) { /* 单个读不出就跳过 */ }
    }
    return { count: list.length, bytes };
  } catch (e) {
    return { count: 0, bytes: 0 };
  }
}

// 清空本地缓存（下次进游戏会重新下载一遍）
export async function clearAssetCache() {
  inflight.clear();
  try {
    const ok = await caches.delete(CACHE_NAME);
    _handle = null; // 下次再 open，重新建一份空的
    return !!ok;
  } catch (e) {
    _handle = null;
    return false;
  }
}
