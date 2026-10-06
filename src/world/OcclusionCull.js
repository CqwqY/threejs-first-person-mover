// 职责：把「被前面的东西完全挡住」的静态网格从这一帧的渲染里摘掉 —— 遮挡剔除（occlusion culling）。
//
// ── 从 Minecraft 学来的那一招，拆开看是三层 ────────────────────────────────
//   ① 面剔除：相邻实心方块之间的面根本不生成（≈ 我们已有的 BackfaceCull 背面剔除）
//   ② 分块（chunk）：世界切成 16³ 的块，一次 draw call 一块，只提交玩家周围的块
//   ③ 遮挡剔除：从玩家所在块出发做邻接图 BFS，被实心块封死的分支整块不画
//   本项目 ① 已有（BackfaceCull.js），② 靠 mergeStaticMeshes 已把 draw call 压到 45，
//   缺的就是 ③ —— 本模块补上。
//
// ── 为什么不照搬 MC 的体素邻接图 ──────────────────────────────────────────
//   MC 之所以能"精确"，是因为方块是**密封**的：实心就一定挡光。我们的几何是稀疏三角网格，
//   开窗、开门、开洞，"实心"只是近似 ⇒ 只能做**保守**判定：宁可少剔，绝不误剔。
//   GPU 遮挡查询（WebGL2 ANY_SAMPLES_PASSED）最准，但要异步回读、移动端驱动行为不一，
//   一旦卡住整帧掉个位数 —— 本项目踩过太多"静默失效"，先不上。
//
// ── 本模块的判定：CPU 侧粗粒度分层遮挡缓冲（HZB 的近似版）──────────────────
//   1. 挑出离相机最近的 N 个「够大 + 不透明 + 静态」的网格当遮挡体（occluder）
//   2. 把它们的世界 AABB 投影到屏幕，写进一张 TILE×TILE 的粗深度图，
//      存的是该块**最远**的 NDC 深度（不是最近）—— 这是保守方向，见下面 _rasterize 的注释
//   3. 每个候选网格：把自己的 AABB 也投到屏幕，若它覆盖的每一格都被遮挡体占着，
//      且遮挡体的深度比它**最近**的角还要靠前 ⇒ 判定"完全被挡住" ⇒ 这一帧不画
//
// ── ⚠⚠ 剔除手段必须是 layers，绝不能是 visible ────────────────────────────
//   本项目有几处逻辑**依赖 visible**，踩过很疼（详见 Lod.js 顶部注释）：
//     · trimesh.js 的 collectMeshes：`if (!isVisible(o)) return;` → 不可见的网格不参与碰撞烘焙
//     · 编辑器拾取 / 射线同样跳过不可见对象
//   所以这里只动 `mesh.layers.disable(0)`（相机默认只看 layer 0），visible 始终保持 true。
//
// ── ⚠⚠ 顺带必须关掉 castShadow，否则会出现「墙上没物体、却有它的影子」────
//   three 的阴影 pass 用 **light.layers** 判定，不是 camera.layers：本项目太阳光只照
//   LAYER_DYNAMIC(=1)，所以光 disable(0) 的话物体照样投影。故剔除时同时关 castShadow
//   （记 base，恢复时还原），并把状态写进 userData.__occHidden —— Lod.js 那边也在改
//   castShadow，两边必须同一套口径（Lod.js 会读这个标记）。
import * as THREE from 'three';

// ---- 可调参数（模块级具名常量：探针要断言它们，别散落魔法数字）----
// 粗深度图分辨率。32×32 对"整栋楼挡住整间房"这种粗判定够了；调高更准但线性变贵。
export const OCC_TILE = 32;
// 每帧最多用几个遮挡体。按"离相机最近"取前 N：近处的墙/楼才真正挡得住东西。
export const OCC_TOP_OCCLUDERS = 24;
// 当遮挡体的尺寸门槛（AABB 对角线，米）。太小（花盆/栏杆/小装饰）挡不住什么，却会因 AABB 投影偏大
// 把旁边看得见的东西误剔 → 调高到 5，只让"够厚实"的墙/楼当遮挡体（⚠ 调太高会漏掉真实挡视线的薄墙）。
export const OCC_MIN_SIZE = 5;
// 当遮挡体的尺寸上限（米）。⚠ 这条是**安全线**：地面/天空盒是对角线上百米的巨型 AABB，
// 一旦当成遮挡体就会盖满整张深度图，把全场（包括它自己上方的所有东西）整片剔掉。
export const OCC_MAX_SIZE = 60;
// 候选的尺寸上限（米）：超过它的（地面、天空、超长跑道）**永不剔除** —— 大件宁可多画，
// 它的 AABB 覆盖格子太多，粗粒度判定误伤风险最高。
export const OCC_MAX_CAND = 120;
// 离相机这么近（米，AABB 最近点）的永不剔除：贴脸的东西一闪一闪最刺眼，收益也最小。
export const OCC_NEAR = 10;
// NDC 深度容差：遮挡体必须比候选近这么多才认定"挡住了"。偏大 = 更保守 = 更不容易误剔看得见的东西。
// ⚠ 这是「能看见的也被剔」的主要缓冲：宁可少剔，绝不误剔。0.004 仍远小于远处墙/楼的真实深度差。
export const OCC_BIAS = 0.004;
// 评估节流（毫秒）。相机不动时连节流都不触发（见 _needRun）。
export const OCC_TICK_MS = 120;
// ⚠ 静止自愈帧数：相机不动时，每这么多帧**强制**重算一次遮挡。否则世界变了（门开了 / 遮挡物被移走 /
// 物体被摧毁）但相机没动，旧的「被剔」状态不会自己消失 → 玩家看到"明明能看见却被剔了"。
// 代价极小（重算本身很轻），换来"误剔最多存活 OCC_HEAL_FRAMES 帧就自愈"。
export const OCC_HEAL_FRAMES = 15;
// 默认开关。`?occ=0` 整块关掉做 A/B 对照（与 BackfaceCull 的 `?cull=0` 同一套习惯）。
const DEFAULT_ON = true;

let OVERRIDE = null; // null = 看 URL；true/false = 单测强制

export function setOcclusionEnabled(v) {
  OVERRIDE = !!v;
  resetOcclusion();
}

export function occlusionEnabled() {
  if (OVERRIDE !== null) return OVERRIDE;
  try {
    if (typeof location !== 'undefined' && typeof location.search === 'string') {
      const p = new URLSearchParams(location.search);
      if (p.get('occ') === '0') return false;
      if (p.get('occ') === '1') return true;
    }
  } catch (e) {
    /* 无 location（Node 自检）→ 走默认 */
  }
  return DEFAULT_ON;
}

// ---- 状态 ----
const cands = [];            // { mesh, box, center, radius, size, tris, baseCast, hidden }
const _tile = new Float32Array(OCC_TILE * OCC_TILE);
const _mat = new THREE.Matrix4();
const _inv = new THREE.Matrix4();
const _box = new THREE.Box3();
const _v = new THREE.Vector3();
// 8 个角的世界坐标缓冲（复用，避免每次评估分配）
const _corners = new Float32Array(24);
// 投影结果：{ minX, maxX, minY, maxY, nearZ, farZ, ok }
const _proj = { minX: 0, maxX: 0, minY: 0, maxY: 0, nearZ: 0, farZ: 0, ok: false };

let _lastRun = -Infinity;
let _lastPos = new THREE.Vector3(NaN, NaN, NaN);
let _lastQuat = new THREE.Quaternion();
let _culled = 0;
let _culledTris = 0;
let _occUsed = 0;
let _lastMs = 0;
let _occFrame = 0; // 累计帧数，用于静止自愈（OCC_HEAL_FRAMES）

// ---------------------------------------------------------------------------
// 扫描：把场景里的静态不透明网格收成候选池（同时是遮挡体池）
// ---------------------------------------------------------------------------
export function scanOcclusion(root) {
  resetOcclusion();
  cands.length = 0;
  if (!root || typeof root.children === 'undefined') return 0;
  // ⚠ 用显式栈而不用 root.traverse：**要能整棵剪掉子树**（与 BackfaceCull.js 同一套口径）。
  //   noCull 标记挂在人物 / 载具的 group 根节点上，traverse 照样会钻进它下面的网格里；
  //   而本模块有「候选为空时每帧补扫」的兜底（场景异步建起来的），补扫发生在游戏进行中 ——
  //   那时玩家已经进场，人物身上的网格就会被收进候选池，一旦判定被挡就整只消失
  //   （正是「人在但模型没了」那条坑）。⇒ 见 noCull 就整棵子树跳过，一个都不要。
  const stack = [root];
  while (stack.length) {
    const o = stack.pop();
    if (!o) continue;
    if (o.userData && (o.userData.__noOcc === true || o.userData.noCull === true)) continue;
    if (o.isMesh) visit(o);
    const ch = o.children;
    if (!ch) continue;
    for (let i = 0; i < ch.length; i++) stack.push(ch[i]);
  }
  return cands.length;

  function visit(o) {
    if (!o || !o.isMesh) return;
    // ⚠ 蒙皮网格一律不参与：骨骼矩阵可带镜像（负行列式）翻掉三角形绕向，
    //   这类动态体本来就每帧都在动，剔除它没有意义，风险却最大（见 BackfaceCull.js 的坑）。
    if (o.isSkinnedMesh) return;
    const m = o.material;
    if (!m || Array.isArray(m)) return;
    // 半透明 / alphaTest / 线框：它们"能透过去"，既不能当遮挡体，也不该被粗粒度判定剔掉
    if (m.transparent || m.wireframe) return;
    if ((m.alphaTest || 0) > 0) return;
    const g = o.geometry;
    if (!g || !g.attributes || !g.attributes.position) return;

    o.updateWorldMatrix(true, false);
    if (!g.boundingBox) g.computeBoundingBox();
    if (!g.boundingBox) return;
    _box.copy(g.boundingBox).applyMatrix4(o.matrixWorld);
    if (_box.isEmpty()) return;

    const size = _box.min.distanceTo(_box.max); // 对角线长度
    if (!Number.isFinite(size) || size <= 0) return;
    _box.getCenter(_v);
    const tris = g.index ? Math.floor(g.index.count / 3) : Math.floor(g.attributes.position.count / 3);
    cands.push({
      mesh: o,
      box: _box.clone(),
      center: _v.clone(),
      radius: size * 0.5,
      size,
      tris,
      baseCast: !!o.castShadow,
      hidden: false,
    });
  }
}

// 全部恢复渲染（切场景 / 关闭功能 / 异常兜底）。⚠ 只动 layers 与 castShadow，绝不碰 visible。
export function resetOcclusion() {
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    if (!c.mesh) continue;
    if (c.mesh.layers) c.mesh.layers.enable(0);
    if (c.mesh.userData) c.mesh.userData.__occHidden = false;
    if (c.mesh.castShadow !== c.baseCast) c.mesh.castShadow = c.baseCast;
    c.hidden = false;
  }
  _culled = 0;
  _culledTris = 0;
  _occUsed = 0;
}

export function occlusionCandidates() { return cands.length; }

export function occlusionStats() {
  return {
    on: occlusionEnabled(),
    candidates: cands.length,
    culled: _culled,
    culledTris: _culledTris,
    occluders: _occUsed,
    ms: _lastMs,
  };
}

// ---------------------------------------------------------------------------
// 每帧评估（内部节流）。返回本帧剔除的网格数。
// ---------------------------------------------------------------------------
export function updateOcclusion(camera, force) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  if (!camera || !cands.length) {
    if (!cands.length) { _culled = 0; _culledTris = 0; }
    _lastMs = 0;
    return 0;
  }
  if (!occlusionEnabled()) {
    // 关掉时必须把之前剔掉的都放回来（否则 ?occ=0 之后画面永远缺东西）
    if (_culled > 0) resetOcclusion();
    _lastMs = 0;
    return 0;
  }
  _occFrame++;
  if (!force && !_needRun(camera, t0)) {
    // ⚠ 静止自愈：相机没动时本应跳过，但世界可能变了（门开了 / 遮挡物被移走 / 物体被摧毁），
    // 旧的「被剔」状态不会自己消失 → 玩家看到"明明能看见却没了"。每 OCC_HEAL_FRAMES 帧强算一次，
    // 误剔最多存活这么久就自愈。相机一动则 _needRun 立即触发，无需等。
    if (_occFrame % OCC_HEAL_FRAMES !== 0) { _lastMs = 0; return _culled; }
  }
  _lastRun = t0;
  _lastPos.copy(camera.position);
  _lastQuat.copy(camera.quaternion);

  camera.updateMatrixWorld();
  _inv.copy(camera.matrixWorld).invert();
  _mat.multiplyMatrices(camera.projectionMatrix, _inv);

  // ---- 1. 建粗深度图 ----
  _tile.fill(Infinity);
  // 按「AABB 最近点距离」升序，取最近的若干个当遮挡体（近处的墙/楼才真的挡得住东西）
  const order = cands.slice().sort((a, b) =>
    a.box.distanceToPoint(camera.position) - b.box.distanceToPoint(camera.position));
  let used = 0;
  for (let i = 0; i < order.length && used < OCC_TOP_OCCLUDERS; i++) {
    const c = order[i];
    if (c.size < OCC_MIN_SIZE || c.size > OCC_MAX_SIZE) continue;
    // ⚠ 相机在这个盒子里面 → 它不能当遮挡体（否则会把身边的人和物全剔掉）
    if (c.box.containsPoint(camera.position)) continue;
    if (!_projectBox(c.box, _mat, _proj)) continue;
    if (_proj.nearZ > 1) continue;                 // 整体在远平面之外
    if (_proj.maxX < -1 || _proj.minX > 1 || _proj.maxY < -1 || _proj.minY > 1) continue; // 屏幕外
    _rasterize(_proj);
    used++;
  }
  _occUsed = used;

  // ---- 2. 逐个候选判定 ----
  let culled = 0;
  let tris = 0;
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    const wantRender = _isVisible(c, camera);
    // ⚠ 判定"要不要改状态"必须用「想渲染」对「正在渲染(=!hidden)」：
    //   写反了（wantRender === hidden）会让"该恢复渲染的"永远恢复不了 —— 一次误判就是永久缺东西。
    if (wantRender === !c.hidden) {
      if (!wantRender) { culled++; tris += c.tris; }
      continue;
    }
    if (wantRender) {
      c.mesh.layers.enable(0);
      c.mesh.userData.__occHidden = false;
      if (c.mesh.castShadow !== c.baseCast) c.mesh.castShadow = c.baseCast;
      c.hidden = false;
    } else {
      c.mesh.layers.disable(0);
      c.mesh.userData.__occHidden = true;
      if (c.mesh.castShadow) c.mesh.castShadow = false;
      c.hidden = true;
      culled++;
      tris += c.tris;
    }
  }
  _culled = culled;
  _culledTris = tris;
  _lastMs = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
  return culled;
}

// 是否需要重跑：相机没动（位移 < 0.4m 且转动 < 2°）就完全跳过 —— 遮挡关系没变，算了也白算
function _needRun(camera, now) {
  if (now - _lastRun < OCC_TICK_MS) return false;
  if (!Number.isFinite(_lastPos.x)) return true;
  if (_lastPos.distanceTo(camera.position) > 0.4) return true;
  return Math.abs(_lastQuat.dot(camera.quaternion)) < 0.9994; // ≈ 2°
}

// 把世界 AABB 的 8 个角投到 NDC。任一只角在相机后方（w <= 0）就判失败：
// 这种情况下透视除法会把坐标翻到屏幕另一侧，算出来的屏幕矩形是错的 —— 保守起见直接放弃。
function _projectBox(box, m, out) {
  const min = box.min;
  const max = box.max;
  let n = 0;
  for (let i = 0; i < 8; i++) {
    _corners[n++] = (i & 1) ? max.x : min.x;
    _corners[n++] = (i & 2) ? max.y : min.y;
    _corners[n++] = (i & 4) ? max.z : min.z;
  }
  const e = m.elements;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let nearZ = Infinity, farZ = -Infinity;
  for (let i = 0; i < 24; i += 3) {
    const x = _corners[i], y = _corners[i + 1], z = _corners[i + 2];
    const w = e[3] * x + e[7] * y + e[11] * z + e[15];
    if (w <= 1e-6) { out.ok = false; return false; }
    const iw = 1 / w;
    const nx = (e[0] * x + e[4] * y + e[8] * z + e[12]) * iw;
    const ny = (e[1] * x + e[5] * y + e[9] * z + e[13]) * iw;
    const nz = (e[2] * x + e[6] * y + e[10] * z + e[14]) * iw;
    if (nx < minX) minX = nx;
    if (nx > maxX) maxX = nx;
    if (ny < minY) minY = ny;
    if (ny > maxY) maxY = ny;
    if (nz < nearZ) nearZ = nz;
    if (nz > farZ) farZ = nz;
  }
  out.minX = minX; out.maxX = maxX; out.minY = minY; out.maxY = maxY;
  out.nearZ = nearZ; out.farZ = farZ; out.ok = true;
  return true;
}

// 把一个遮挡体的屏幕矩形写进粗深度图。
// ⚠ 写的是 **farZ（最远的那个角）而不是 nearZ**：AABB 只是真实几何的外包盒，
//   真实表面通常比 AABB 的近面更靠后；用最远角当"这格被挡到什么深度"，
//   得到的深度偏保守（偏大＝偏远），于是"目标被挡"更难成立 —— 这正是我们要的保守方向。
function _rasterize(p) {
  const x0 = _tileIndex(p.minX);
  const x1 = _tileIndex(p.maxX);
  const y0 = _tileIndex(p.minY);
  const y1 = _tileIndex(p.maxY);
  if (x1 < x0 || y1 < y0) return;
  const z = p.farZ;
  for (let ty = y0; ty <= y1; ty++) {
    const row = ty * OCC_TILE;
    for (let tx = x0; tx <= x1; tx++) {
      const k = row + tx;
      if (z < _tile[k]) _tile[k] = z; // 取更靠前的遮挡深度
    }
  }
}

function _tileIndex(ndc) {
  const t = Math.floor((ndc * 0.5 + 0.5) * OCC_TILE);
  return t < 0 ? 0 : (t >= OCC_TILE ? OCC_TILE - 1 : t);
}

// 候选是否"应该渲染"。返回 true = 保留（保守：有任何不确定就返回 true）。
function _isVisible(c, camera) {
  // 超大件（地面 / 天空 / 长跑道）永不剔除：AABB 覆盖格子太多，误伤代价最高
  if (c.size > OCC_MAX_CAND) return true;
  // 贴脸的永不剔除
  if (c.box.distanceToPoint(camera.position) < OCC_NEAR) return true;
  // 相机就在这个盒子里 → 一定是可见的
  if (c.box.containsPoint(camera.position)) return true;
  if (_occUsed === 0) return true;
  if (!_projectBox(c.box, _mat, _proj)) return true; // 有角在相机后 → 保守放行
  const p = _proj;
  // 完全在屏幕外：剔除它没意义（three 的视锥剔除本来就会干），放行
  if (p.maxX < -1 || p.minX > 1 || p.maxY < -1 || p.minY > 1) return true;

  const x0 = _tileIndex(p.minX);
  const x1 = _tileIndex(p.maxX);
  const y0 = _tileIndex(p.minY);
  const y1 = _tileIndex(p.maxY);
  // 只要有一格没被任何遮挡体覆盖 ⇒ 至少这部分露在外面 ⇒ 保留
  for (let ty = y0; ty <= y1; ty++) {
    const row = ty * OCC_TILE;
    for (let tx = x0; tx <= x1; tx++) {
      if (_tile[row + tx] >= p.nearZ - OCC_BIAS) return true; // 遮挡体不够靠前 / 这格空着
    }
  }
  return false; // 覆盖的每一格都被更靠前的遮挡体占着 ⇒ 判定被完全挡住
}
