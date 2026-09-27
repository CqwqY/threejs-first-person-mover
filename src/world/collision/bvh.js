// 室内复杂碰撞 · 三角形 BVH（P3 窄相位）
//
// 职责：对三角形汤（每个三角形 9 个 float 的世界空间顶点）构建扁平化 BVH，并提供 AABB 查询。
// 设计要点：
//   1) 所有节点数据放在 TypedArray 里（不建对象）：查询零分配、缓存友好，适合每帧调用；
//   2) 中位切分：每次沿质心包围盒的最长轴按中位数二分，树高约 log2(n)；
//   3) 叶子按区间存三角形，叶子里的值统一是「三角形汤里的全局三角形编号」；
//   4) 纯数据 + 纯函数，不依赖 three，方便在 Node 里做数值仿真。
//
// 用法：
//   const bvh = buildBVH(positions, subset);      // positions：Float32Array(9*T)；subset：参与构建的三角形编号（可空=全部）
//   const n = queryAABB(bvh, minX, minY, minZ, maxX, maxY, maxZ, out); // 命中的三角形编号写入 out

const LEAF_SIZE = 4; // 叶子最多容纳的三角形数（越小查询越快、树越大）
const QUERY_EPS = 1e-4; // 三角形 AABB 粗筛容差（米），避免擦边漏检

// 构建 BVH。
// positions：三角形汤顶点缓冲，长度 = 9 * 三角形总数，三角形 t 的顶点为 [9t .. 9t+8]。
// subset：参与构建的全局三角形编号（Uint32Array / 普通数组）；不传则使用全部三角形。
export function buildBVH(positions, subset) {
  const triCount = subset ? subset.length : Math.floor(positions.length / 9);
  const idx = new Uint32Array(triCount);
  for (let i = 0; i < triCount; i++) idx[i] = subset ? subset[i] : i;

  const maxNodes = Math.max(1, triCount * 2 + 1);
  const nodeMin = new Float32Array(maxNodes * 3);
  const nodeMax = new Float32Array(maxNodes * 3);
  const nodeLeft = new Int32Array(maxNodes);
  const nodeRight = new Int32Array(maxNodes);
  const leafStart = new Int32Array(maxNodes);
  const leafCount = new Int32Array(maxNodes);
  let used = 0;

  const tmp = [0, 0, 0];
  // 三角形 t 的质心坐标（用于切分排序）
  const centroidOf = (t, out) => {
    const o = t * 9;
    out[0] = (positions[o] + positions[o + 3] + positions[o + 6]) / 3;
    out[1] = (positions[o + 1] + positions[o + 4] + positions[o + 7]) / 3;
    out[2] = (positions[o + 2] + positions[o + 5] + positions[o + 8]) / 3;
  };

  // 递归构建区间 [lo, hi) 的子树，返回节点下标
  const build = (lo, hi) => {
    const node = used++;
    nodeLeft[node] = -1;
    nodeRight[node] = -1;
    // 该区间的 AABB（即节点包围盒）
    let mnx = Infinity, mny = Infinity, mnz = Infinity;
    let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    for (let i = lo; i < hi; i++) {
      const o = idx[i] * 9;
      for (let k = 0; k < 3; k++) {
        const x = positions[o + k * 3];
        const y = positions[o + k * 3 + 1];
        const z = positions[o + k * 3 + 2];
        if (x < mnx) mnx = x; if (y < mny) mny = y; if (z < mnz) mnz = z;
        if (x > mxx) mxx = x; if (y > mxy) mxy = y; if (z > mxz) mxz = z;
      }
    }
    nodeMin[node * 3] = mnx; nodeMin[node * 3 + 1] = mny; nodeMin[node * 3 + 2] = mnz;
    nodeMax[node * 3] = mxx; nodeMax[node * 3 + 1] = mxy; nodeMax[node * 3 + 2] = mxz;

    if (hi - lo <= LEAF_SIZE) {
      leafStart[node] = lo;
      leafCount[node] = hi - lo;
      return node;
    }

    // 质心包围盒 → 选最长轴
    let cmnx = Infinity, cmny = Infinity, cmnz = Infinity;
    let cmxx = -Infinity, cmxy = -Infinity, cmxz = -Infinity;
    for (let i = lo; i < hi; i++) {
      centroidOf(idx[i], tmp);
      if (tmp[0] < cmnx) cmnx = tmp[0]; if (tmp[0] > cmxx) cmxx = tmp[0];
      if (tmp[1] < cmny) cmny = tmp[1]; if (tmp[1] > cmxy) cmxy = tmp[1];
      if (tmp[2] < cmnz) cmnz = tmp[2]; if (tmp[2] > cmxz) cmxz = tmp[2];
    }
    const ex = cmxx - cmnx, ey = cmxy - cmny, ez = cmxz - cmnz;
    const axis = ex >= ey && ex >= ez ? 0 : (ey >= ez ? 1 : 2);

    // 按该轴质心排序后取中点切分（中位切分；一次性构建，排序开销可接受）
    const slice = new Array(hi - lo);
    for (let i = lo; i < hi; i++) slice[i - lo] = idx[i];
    slice.sort((a, b) => {
      centroidOf(a, tmp); const ka = tmp[axis];
      centroidOf(b, tmp); const kb = tmp[axis];
      return ka - kb;
    });
    for (let i = 0; i < slice.length; i++) idx[lo + i] = slice[i];

    const mid = (lo + hi) >> 1;
    nodeLeft[node] = build(lo, mid);
    nodeRight[node] = build(mid, hi);
    return node;
  };

  const root = triCount > 0 ? build(0, triCount) : -1;
  return {
    positions, // 顶点缓冲（查询叶子时用）
    root,
    nodeMin,
    nodeMax,
    nodeLeft,
    nodeRight,
    leafStart,
    leafCount,
    triIndex: idx, // 叶子区间里存放的全局三角形编号（已重排）
    nodeTotal: used,
    triCount,
    _stack: new Int32Array(256), // 查询用栈（复用，避免每帧分配）
  };
}

// AABB 查询：把与 [min,max] 相交的三角形编号追加写入 out，返回写入数量。
// out 由调用方传入并复用（本函数只 push，不清空）。
export function queryAABB(bvh, minX, minY, minZ, maxX, maxY, maxZ, out) {
  if (!bvh || bvh.root < 0) return 0;
  const positions = bvh.positions;
  const { nodeMin, nodeMax, nodeLeft, nodeRight, leafStart, leafCount, triIndex } = bvh;
  let stack = bvh._stack;
  let sp = 0;
  stack[sp++] = bvh.root;
  let written = 0;
  while (sp > 0) {
    const node = stack[--sp];
    const b = node * 3;
    if (nodeMin[b] - QUERY_EPS > maxX || nodeMax[b] + QUERY_EPS < minX) continue;
    if (nodeMin[b + 1] - QUERY_EPS > maxY || nodeMax[b + 1] + QUERY_EPS < minY) continue;
    if (nodeMin[b + 2] - QUERY_EPS > maxZ || nodeMax[b + 2] + QUERY_EPS < minZ) continue;
    const l = nodeLeft[node];
    if (l < 0) {
      const s = leafStart[node];
      const c = leafCount[node];
      for (let i = 0; i < c; i++) {
        const t = triIndex[s + i];
        const o = t * 9;
        // 三角形自身 AABB 粗筛
        let tmnx = Infinity, tmny = Infinity, tmnz = Infinity;
        let tmxx = -Infinity, tmxy = -Infinity, tmxz = -Infinity;
        for (let k = 0; k < 3; k++) {
          const x = positions[o + k * 3], y = positions[o + k * 3 + 1], z = positions[o + k * 3 + 2];
          if (x < tmnx) tmnx = x; if (y < tmny) tmny = y; if (z < tmnz) tmnz = z;
          if (x > tmxx) tmxx = x; if (y > tmxy) tmxy = y; if (z > tmxz) tmxz = z;
        }
        if (tmnx - QUERY_EPS > maxX || tmxx + QUERY_EPS < minX) continue;
        if (tmny - QUERY_EPS > maxY || tmxy + QUERY_EPS < minY) continue;
        if (tmnz - QUERY_EPS > maxZ || tmxz + QUERY_EPS < minZ) continue;
        out.push(t);
        written++;
      }
    } else {
      if (sp + 2 > stack.length) {
        // 极端退化时扩展栈（中位切分下不会发生，纯防御）
        const bigger = new Int32Array(stack.length * 2);
        bigger.set(stack);
        stack = bigger;
        bvh._stack = bigger;
      }
      stack[sp++] = l;
      stack[sp++] = nodeRight[node];
    }
  }
  return written;
}
