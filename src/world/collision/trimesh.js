// 室内复杂碰撞 · P3：运行时 trimesh 烘焙 + 3D 宽相位 + BVH
//
// 背景（必须解决的畸形输入）：用户的室内模型把「一整块合并的大多边形地面」和多层楼板
// 全部合并进了同一个 mesh。simple 模式逐 mesh 求盒/凸包时，对这种网格只会得到一个把
// 整栋楼罩住的大凸包，完全不可用。所以 complex 模式**直接从渲染网格烘焙 trimesh**，
// 不做盒/凸包简化，三角形就是几何本身，多层楼板自然分层。
//
// 本文件职责（三层结构，逐层剪枝）：
//   1) 烘焙：把 object3D 下所有子 mesh 的三角形用 matrixWorld 变换到世界空间，得到三角形汤；
//      跳过名字以 collider-vis 开头的可视化子树；异步分批，避免一次性遍历大模型卡住画面。
//   2) 宽相位：3D 均匀网格（XZ 分格 + Y 分层）。多层建筑的各层三角形按 Y 分桶，
//      否则各层会挤进同一格、层数一多就退化成全量遍历；
//   3) 窄相位：每个 Y 层内对候选三角形建 BVH（bvh.js），做 AABB-三角形 相交查询。
//
// 结果缓存：同一个物体只烘焙一次，之后复用（WeakMap，不阻止物体被 GC）。

import { Config } from '../../config.js';
import { buildBVH, queryAABB } from './bvh.js';

const QUANT = 1e-4;                 // 顶点量化步长（米）：用于识别「同一条边」
const PLANAR_COS = 0.98;            // 两个三角形法线夹角余弦达该值即视为共面（约 11.5° 内）
const CELL_BIAS = 512;              // 网格坐标偏移，保证负坐标也能编码成整数键
const CELL_SPAN = 1024;             // 每个轴的编码跨度
const MAX_LAYERS_PER_TRI = 256;     // 单个三角形最多占用的 Y 层数（防御异常巨型三角形）

// 同一个物体只烘焙一次：WeakMap 不阻止 object3D 被回收
const bakeCache = new WeakMap();

// 自身及所有祖先可见才算可见（与 simpleGen 保持一致：隐藏的辅助网格不参与碰撞）
function isVisible(o) {
  let p = o;
  while (p) {
    if (p.visible === false) return false;
    p = p.parent;
  }
  return true;
}

// 是否位于碰撞体可视化节点（collider-vis）内部：烘焙时必须排除，
// 否则会把这些半透明体积盒当成模型烘进碰撞，产生滚雪球式的假碰撞。
function inColliderVis(o) {
  let p = o;
  while (p) {
    if (typeof p.name === 'string' && p.name.startsWith('collider-vis')) return true;
    p = p.parent;
  }
  return false;
}

// 收集参与烘焙的 mesh（跳过 collider-vis 子树、不可见、无 position 的网格）
function collectMeshes(object3D, out) {
  object3D.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    if (inColliderVis(o) || !isVisible(o)) return;
    const pos = o.geometry.attributes && o.geometry.attributes.position;
    if (!pos || pos.count < 3) return;
    out.push(o);
  });
}

// 把一个 mesh 的全部三角形（世界空间）追加到 out（普通数组，每三角形 9 个 float）。
// 直接内联矩阵乘法，避免逐顶点创建 Vector3 造成的大量临时对象。
function extractMeshTriangles(mesh, out) {
  const geo = mesh.geometry;
  const pos = geo.attributes.position;
  const idx = geo.index;
  const e = mesh.matrixWorld.elements;
  const total = idx ? idx.count : pos.count;
  const arr = pos.array;
  const itemSize = pos.itemSize || 3;
  for (let i = 0; i + 2 < total; i += 3) {
    const a = idx ? idx.getX(i) : i;
    const b = idx ? idx.getX(i + 1) : i + 1;
    const c = idx ? idx.getX(i + 2) : i + 2;
    const ax = arr[a * itemSize], ay = arr[a * itemSize + 1], az = arr[a * itemSize + 2];
    const bx = arr[b * itemSize], by = arr[b * itemSize + 1], bz = arr[b * itemSize + 2];
    const cx = arr[c * itemSize], cy = arr[c * itemSize + 1], cz = arr[c * itemSize + 2];
    // 世界空间：v' = M * v（列主序）
    const wax = e[0] * ax + e[4] * ay + e[8] * az + e[12];
    const way = e[1] * ax + e[5] * ay + e[9] * az + e[13];
    const waz = e[2] * ax + e[6] * ay + e[10] * az + e[14];
    const wbx = e[0] * bx + e[4] * by + e[8] * bz + e[12];
    const wby = e[1] * bx + e[5] * by + e[9] * bz + e[13];
    const wbz = e[2] * bx + e[6] * by + e[10] * bz + e[14];
    const wcx = e[0] * cx + e[4] * cy + e[8] * cz + e[12];
    const wcy = e[1] * cx + e[5] * cy + e[9] * cz + e[13];
    const wcz = e[2] * cx + e[6] * cy + e[10] * cz + e[14];
    // 退化（零面积 / NaN）三角形直接丢弃
    const ux = wbx - wax, uy = wby - way, uz = wbz - waz;
    const vx = wcx - wax, vy = wcy - way, vz = wcz - waz;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (!(nx * nx + ny * ny + nz * nz > 1e-12)) continue;
    out.push(wax, way, waz, wbx, wby, wbz, wcx, wcy, wcz);
  }
}

// 把顶点坐标量化成字符串键（用于边识别）
function vkey(x, y, z) {
  return Math.round(x / QUANT) + ',' + Math.round(y / QUANT) + ',' + Math.round(z / QUANT);
}

// 3D 网格坐标 → 整数键
function cellKey(ix, iy, iz) {
  const cx = Math.max(-CELL_BIAS, Math.min(CELL_BIAS - 1, ix)) + CELL_BIAS;
  const cy = Math.max(-CELL_BIAS, Math.min(CELL_BIAS - 1, iy)) + CELL_BIAS;
  const cz = Math.max(-CELL_BIAS, Math.min(CELL_BIAS - 1, iz)) + CELL_BIAS;
  return (cx * CELL_SPAN + cy) * CELL_SPAN + cz;
}

// 收尾：从扁平三角形汤构建法线表、共面边标记、Y 分层 BVH、3D 宽相位网格占用表。
function finalizeTriMesh(posArr, object3D) {
  const triCount = Math.floor(posArr.length / 9);
  const positions = new Float32Array(triCount * 9);
  for (let i = 0; i < triCount * 9; i++) positions[i] = posArr[i];

  const normals = new Float32Array(triCount * 3);
  const triMinX = new Float32Array(triCount), triMinY = new Float32Array(triCount), triMinZ = new Float32Array(triCount);
  const triMaxX = new Float32Array(triCount), triMaxY = new Float32Array(triCount), triMaxZ = new Float32Array(triCount);

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    const ax = positions[o], ay = positions[o + 1], az = positions[o + 2];
    const bx = positions[o + 3], by = positions[o + 4], bz = positions[o + 5];
    const cx = positions[o + 6], cy = positions[o + 7], cz = positions[o + 8];
    // 面法线（单位化）
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    normals[t * 3] = nx / len; normals[t * 3 + 1] = ny / len; normals[t * 3 + 2] = nz / len;
    // 三角形 AABB
    const mnx = Math.min(ax, bx, cx), mny = Math.min(ay, by, cy), mnz = Math.min(az, bz, cz);
    const mxx = Math.max(ax, bx, cx), mxy = Math.max(ay, by, cy), mxz = Math.max(az, bz, cz);
    triMinX[t] = mnx; triMinY[t] = mny; triMinZ[t] = mnz;
    triMaxX[t] = mxx; triMaxY[t] = mxy; triMaxZ[t] = mxz;
    if (mnx < minX) minX = mnx; if (mny < minY) minY = mny; if (mnz < minZ) minZ = mnz;
    if (mxx > maxX) maxX = mxx; if (mxy > maxY) maxY = mxy; if (mxz > maxZ) maxZ = mxz;
  }

  // ---- 邻接边表 → 标记「存在共面邻居的边」的三角形 ----
  // 用途：解算时对这类三角形产生的「边轴」接触做内部边缘过滤，
  // 避免贴墙 / 走地时被两块共面三角形之间的接缝绊住或弹开。
  const hasCoplanarEdge = new Uint8Array(triCount);
  const edgeMap = new Map();
  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    const k0 = vkey(positions[o], positions[o + 1], positions[o + 2]);
    const k1 = vkey(positions[o + 3], positions[o + 4], positions[o + 5]);
    const k2 = vkey(positions[o + 6], positions[o + 7], positions[o + 8]);
    const keys = [k0 + '|' + k1, k1 + '|' + k2, k2 + '|' + k0];
    for (const k of keys) {
      let list = edgeMap.get(k);
      if (!list) { list = []; edgeMap.set(k, list); }
      list.push(t);
    }
  }
  for (const list of edgeMap.values()) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        const d = normals[a * 3] * normals[b * 3] + normals[a * 3 + 1] * normals[b * 3 + 1] + normals[a * 3 + 2] * normals[b * 3 + 2];
        if (d > PLANAR_COS) { hasCoplanarEdge[a] = 1; hasCoplanarEdge[b] = 1; }
      }
    }
  }
  edgeMap.clear();

  // ---- 3D 宽相位：XZ 分格 + Y 分层 ----
  const cellSize = Config.TRIMESH_CELL_SIZE;
  const layerHeight = Config.TRIMESH_LAYER_HEIGHT;
  const layerTris = new Map(); // iy → 该层的三角形编号数组
  const occupied = new Set();  // 被占用的 (ix,iy,iz) 格子
  for (let t = 0; t < triCount; t++) {
    const iy0 = Math.floor(triMinY[t] / layerHeight);
    let iy1 = Math.floor(triMaxY[t] / layerHeight);
    if (iy1 - iy0 > MAX_LAYERS_PER_TRI) iy1 = iy0 + MAX_LAYERS_PER_TRI;
    for (let iy = iy0; iy <= iy1; iy++) {
      let list = layerTris.get(iy);
      if (!list) { list = []; layerTris.set(iy, list); }
      list.push(t);
    }
    const ix0 = Math.floor(triMinX[t] / cellSize), ix1 = Math.floor(triMaxX[t] / cellSize);
    const iz0 = Math.floor(triMinZ[t] / cellSize), iz1 = Math.floor(triMaxZ[t] / cellSize);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iz = iz0; iz <= iz1; iz++) {
        for (let iy = iy0; iy <= iy1; iy++) occupied.add(cellKey(ix, iy, iz));
      }
    }
  }

  // ---- 窄相位：每层内建 BVH ----
  const layers = new Map();
  for (const [iy, list] of layerTris) {
    layers.set(iy, { bvh: buildBVH(positions, list), triCount: list.length });
  }

  const collider = {
    type: 'trimesh',
    source: object3D,
    positions,
    triCount,
    normals,
    hasCoplanarEdge,
    layers,
    cellSize,
    layerHeight,
    minX, minY, minZ, maxX, maxY, maxZ,
    // 查询复用缓冲：避免每帧分配
    _tmp: [],
    _stamp: new Int32Array(triCount),
    _stampVal: 0,

    // 宽相位 + 窄相位查询：把与 [min,max] 相交的候选三角形编号写入 out（去重），返回数量。
    // expand：把查询盒向外扩大（解算时用，保证擦边接触不被漏掉）。
    query(minX2, minY2, minZ2, maxX2, maxY2, maxZ2, out, expand = 0) {
      out.length = 0;
      if (triCount === 0) return 0;
      const lo = expand;
      const ix0 = Math.floor((minX2 - lo) / cellSize), ix1 = Math.floor((maxX2 + lo) / cellSize);
      const iz0 = Math.floor((minZ2 - lo) / cellSize), iz1 = Math.floor((maxZ2 + lo) / cellSize);
      const iy0 = Math.floor((minY2 - lo) / layerHeight), iy1 = Math.floor((maxY2 + lo) / layerHeight);
      // 时间戳去重：同一个三角形可能同时落在相邻两层里
      if (this._stampVal >= 2000000000) { this._stamp.fill(0); this._stampVal = 0; }
      const stamp = ++this._stampVal;
      const tmp = this._tmp;
      for (let iy = iy0; iy <= iy1; iy++) {
        const layer = layers.get(iy);
        if (!layer) continue;
        // 宽相位粗筛：该层在玩家 XZ 覆盖范围内根本没有三角形 → 整层跳过（Y 分层剪枝）
        let any = false;
        for (let ix = ix0; ix <= ix1 && !any; ix++) {
          for (let iz = iz0; iz <= iz1; iz++) {
            if (occupied.has(cellKey(ix, iy, iz))) { any = true; break; }
          }
        }
        if (!any) continue;
        // 窄相位：层内 BVH 精确取候选
        tmp.length = 0;
        queryAABB(layer.bvh, minX2 - lo, minY2 - lo, minZ2 - lo, maxX2 + lo, maxY2 + lo, maxZ2 + lo, tmp);
        for (let i = 0; i < tmp.length; i++) {
          const t = tmp[i];
          if (this._stamp[t] === stamp) continue;
          this._stamp[t] = stamp;
          out.push(t);
        }
      }
      return out.length;
    },
  };
  return collider;
}

// 同步烘焙（核心实现；Node 数值仿真与编辑器同步场景都可用）。
// opts: { force? }  force=true 时忽略缓存重新烘焙。
export function bakeTriMesh(object3D, opts = {}) {
  if (!object3D) return null;
  if (!opts.force) {
    const cached = bakeCache.get(object3D);
    if (cached) return cached;
  }
  const meshes = [];
  object3D.updateMatrixWorld(true);
  collectMeshes(object3D, meshes);
  const posArr = [];
  for (const m of meshes) extractMeshTriangles(m, posArr);
  const collider = finalizeTriMesh(posArr, object3D);
  collider.meshCount = meshes.length;
  bakeCache.set(object3D, collider);
  return collider;
}

// 让出主线程一次，避免长任务卡住画面（浏览器用 rAF，Node 退化为 setTimeout）
function yieldToMain(fn) {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => fn());
  else if (typeof setTimeout === 'function') setTimeout(fn, 0);
  else queueMicrotask(fn);
}

// 异步分批烘焙：把「逐 mesh 提取三角形」切成若干片，每片累积到一定三角形数就让出主线程。
// 返回 Promise<TriMeshCollider>。烘焙是静态几何的一次性开销，切片后基本不影响帧率。
export function bakeTriMeshAsync(object3D, opts = {}) {
  if (!object3D) return Promise.resolve(null);
  if (!opts.force) {
    const cached = bakeCache.get(object3D);
    if (cached) return Promise.resolve(cached);
  }
  object3D.updateMatrixWorld(true);
  const meshes = [];
  collectMeshes(object3D, meshes);
  const chunk = Math.max(1, Math.floor(opts.chunkTris || Config.TRIMESH_BAKE_CHUNK_TRIS));
  const posArr = [];
  let i = 0;
  return new Promise((resolve) => {
    const step = () => {
      const base = posArr.length / 9;
      while (i < meshes.length) {
        extractMeshTriangles(meshes[i], posArr);
        i++;
        if (posArr.length / 9 - base >= chunk) break;
      }
      if (i < meshes.length) {
        yieldToMain(step); // 还有剩余，让出主线程后继续
        return;
      }
      const collider = finalizeTriMesh(posArr, object3D);
      collider.meshCount = meshes.length;
      bakeCache.set(object3D, collider);
      resolve(collider);
    };
    if (meshes.length === 0) {
      const collider = finalizeTriMesh(posArr, object3D);
      collider.meshCount = 0;
      bakeCache.set(object3D, collider);
      resolve(collider);
      return;
    }
    yieldToMain(step);
  });
}
