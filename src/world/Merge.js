// 职责：把「同一个模型内部」大量同材质的小静态网格合并成一个，减少 draw call。
//
// 独立成模块的原因：AssetLoader 加载每个模型后都要跑一次（家具/组合家具/编辑器摆放全都受益），
//   而 EditorBuildings 又依赖 AssetLoader —— 合并工具留在 EditorBuildings 里会造成循环依赖。
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ===========================================================================
// 静态网格合并（draw call 优化）
// ---------------------------------------------------------------------------
// 编辑器导入的模型常被导出成「几百个几十三角形的小网格」——用户自己导入的楼、以及仓库里的
// 军中.glb（66 个网格 / 17 种材质）就是典型。三角形数根本不是瓶颈，瓶颈是**提交次数**：
// 每个网格一次 draw call，开了阴影后主渲染 + 阴影贴图两趟各来一次。这正是「模型一多就卡」的主因。
//
// 这些都是静态景物（没有骨骼动画、没有 morph），把「几何属性布局一致 + 材质外观一致」的子网格
// 烘进一个几何体后，通常只剩几个网格。合并只在**游戏侧**做（编辑器要保留逐网格选中能力）。
// 顶点/索引布局或材质外观有任何差异都不会被合并，最坏情况是「没效果」而不是「画错」。
//
// 唯一的例外是镜像节点（scale.x = -1 之类，导出模型里的对称结构很常见）：这类子网格的矩阵行列式为负，
// 合并后新网格挂在 root 下、行列式变回正，three 的背面剔除判定会跟着翻 → 必须同时把绕向翻回来
// （见 flipTriangleWinding）。这不是「可以不管的边角情况」，漏了就会在模型上直接看到内壁。
// ===========================================================================

// 非渲染相关的材质字段：不参与外观指纹（改了它们不会改变画面）
const MATERIAL_SKIP_KEYS = new Set(['uuid', 'id', 'name', 'type', 'version', 'userData', 'defines', 'uniforms', 'needsUpdate']);

// 把任意材质属性值折成一个稳定字符串（深度受限，避免循环引用/巨对象）
function valueSig(v, depth) {
  if (v === null || v === undefined) return '-';
  const t = typeof v;
  if (t === 'number') return Number.isFinite(v) ? String(v) : 'nan';
  if (t === 'boolean') return v ? '1' : '0';
  if (t === 'string') return v;
  if (t === 'function') return 'fn';
  if (depth <= 0) return 'deep';
  if (Array.isArray(v)) return '[' + v.map((x) => valueSig(x, depth - 1)).join(';') + ']';
  if (typeof v.getHexString === 'function') return '#' + v.getHexString();       // Color
  if (typeof v.uuid === 'string') return 'u:' + v.uuid;                           // Texture 等
  if (typeof v.toArray === 'function') return '(' + v.toArray().map((x) => valueSig(x, 0)).join(',') + ')'; // Vector/Matrix
  const keys = Object.keys(v);
  if (!keys.length) return 'obj';
  return '{' + keys.map((k) => k + '=' + valueSig(v[k], depth - 1)).join(',') + '}';
}

// 指纹缓存：同一材质/几何实例在一份场景里会被反复用到（合并时要给每个网格算一次键），
// 缓存后 837 个网格只需算几十次，省掉大量重复的字符串拼接。
const _matSigCache = new WeakMap();
const _geoSigCache = new WeakMap();

// 材质外观指纹：外观一致的两个材质（哪怕是不相干的实例）合并后画面上没有区别。
// 用「首实例」作为合并网格的材质。这样既吃掉「导出器给每个 primitive 复制一份材质」的情况，
// 也不会把真正不同的材质并到一起。
export function materialSigKey(m) {
  if (!m) return 'null';
  const cached = _matSigCache.get(m);
  if (cached !== undefined) return cached;
  const keys = Object.keys(m).filter((k) => !MATERIAL_SKIP_KEYS.has(k)).sort();
  const parts = [];
  for (const k of keys) parts.push(k + '=' + valueSig(m[k], 3));
  const sig = parts.join('|');
  _matSigCache.set(m, sig);
  return sig;
}

// 几何布局指纹：mergeGeometries 要求索引有无一致、属性集合/分量数/类型一致、morph 相对性一致。
// 把这几项编进分组键，就能保证 mergeGeometries 不会因不兼容而返回 null。
export function geometrySigKey(g) {
  const cached = _geoSigCache.get(g);
  if (cached !== undefined) return cached;
  const names = Object.keys(g.attributes || {}).sort();
  let s = g.index ? 'idx' : 'non';
  if (g.drawMode !== undefined && g.drawMode !== 0) s += ':dm' + g.drawMode; // 非三角形图元不合并
  s += g.morphTargetsRelative ? ':mr' : '';
  for (const n of names) {
    const a = g.attributes[n];
    s += '|' + n + ':' + a.itemSize + ':' + (a.array ? a.array.constructor.name : '?') + ':' + (a.normalized ? 1 : 0);
  }
  _geoSigCache.set(g, s);
  return s;
}

// 翻转每个三角形的顶点绕向（索引网格换两个索引；非索引网格把每个三角形的第 2、3 个顶点整份对调）。
// 只动「顺序」，不动任何属性值 —— 所以顶点位置和法线都不会变，光照不受影响，只有背面剔除的判定会翻过来。
//
// 为什么必须做：three 的 WebGLRenderer 里
//   const frontFaceCW = ( object.isMesh && object.matrixWorld.determinant() < 0 );
// 即绕向怎么解读取决于**网格自身矩阵行列式的正负**。合并把镜像烘进了几何体（新网格挂在 root 下、
// 行列式为正），若这里的子网格相对矩阵行列式为负而不翻绕向，那批三角形就会被当成背面剔掉 ——
// 表现是模型上出现「内壁/破面」。导出模型里的对称结构常被写成 scale.x = -1，所以这条必不能漏。
//
// 导出出来也为了让自检能直接用它翻一整个房间，验证「翻绕向不影响碰撞解算」。
export function flipTriangleWinding(g) {
  const idx = g.index;
  if (idx) {
    const a = idx.array;
    for (let i = 0; i + 2 < a.length; i += 3) { const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t; }
    idx.needsUpdate = true;
    return;
  }
  const pos = g.attributes.position;
  if (!pos) return;
  const count = pos.count;
  for (const name of Object.keys(g.attributes)) {
    const at = g.attributes[name];
    const arr = at.array, it = at.itemSize;
    for (let i = 0; i + 2 < count; i += 3) {
      for (let k = 0; k < it; k++) {
        const i1 = (i + 1) * it + k, i2 = (i + 2) * it + k;
        const t = arr[i1]; arr[i1] = arr[i2]; arr[i2] = t;
      }
    }
    at.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// 属性归一化：吃掉「导出器只给部分网格多塞属性」造成的碎片化
// ---------------------------------------------------------------------------
// 现象：同一个材质下几百个网格，几何明明一样，却因为**其中一部分多带了 uv1 / tangent / color**
//   而被切成几十批（mergeGeometries 要求属性集合完全一致）。用户看到的就是「合了但没合干净」。
//
// 做法：以**最大的那批**为基准（基准的属性一个不动），只把「比基准多出来、
//   且这个材质确实用不上」的属性从候选批上删掉，然后并进基准批。
//   ⚠ 只在**克隆体**上删（合并时本来就要克隆），源几何一个字节都不动 ——
//     同一个源几何可能被另一个「真需要 uv1」的材质用着，动源就出大事。
//
// 会用到 UV 通道的贴图层（判断某个 uvN 能不能丢）：three 里贴图有 channel 字段，
// 默认 0（普通贴图），aoMap/lightMap 常是 1（对应 uv1 属性）。
const UV_TEXTURE_KEYS = [
  'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap',
  'bumpMap', 'displacementMap', 'lightMap', 'specularMap', 'clearcoatMap', 'clearcoatNormalMap',
  'clearcoatRoughnessMap', 'sheenColorMap', 'iridescenceMap', 'anisotropyMap', 'transmissionMap', 'thicknessMap',
];

function uvChannelUsed(material, ch) {
  if (!material) return false;
  for (const k of UV_TEXTURE_KEYS) {
    const t = material[k];
    if (t && (t.channel === undefined ? 0 : t.channel) === ch) return true;
  }
  return false;
}

// 这个属性删掉后画面会不会变？（只回答「能不能删」，不回答「要不要删」）
function attributeDroppable(name, material) {
  if (name === 'position' || name === 'normal') return false; // 少了就没法画
  const m = /^uv(\d*)$/.exec(name);
  if (m) return !uvChannelUsed(material, m[1] === '' ? 0 : Number(m[1]));
  if (name === 'color') return !(material && material.vertexColors); // 没开顶点色就没人读它
  if (name === 'tangent') return true; // 没有它 three 会在着色器里自行推导切线
  return false; // 不认识的属性一律保守保留
}

function attrsOf(g) { return new Set(Object.keys((g && g.attributes) || {})); }

// 把一个材质下的网格切成若干批；每批是 [{ o, drop }]，drop 为要从该网格克隆体上删掉的属性名数组。
function planBatches(list, material, normalize) {
  const bySig = new Map();
  for (const o of list) {
    const k = geometrySigKey(o.geometry);
    let arr = bySig.get(k);
    if (!arr) { arr = []; bySig.set(k, arr); }
    arr.push(o);
  }
  const subs = [...bySig.values()].sort((a, b) => b.length - a.length);
  const members = (arr, drop) => arr.map((o) => ({ o, drop: drop || null }));
  if (!normalize || subs.length < 2) return subs.map((l) => members(l, null));

  const base = subs[0];
  const baseAttrs = attrsOf(base[0].geometry);
  const out = members(base, null);
  const batches = [out];
  for (let i = 1; i < subs.length; i++) {
    const candAttrs = attrsOf(subs[i][0].geometry);
    const extra = [...candAttrs].filter((a) => !baseAttrs.has(a));
    const missing = [...baseAttrs].filter((a) => !candAttrs.has(a));
    // 基准有的属性它却没有 → 只能让基准跟着删，这会动到基准批（不接受）→ 单独留一批
    if (missing.length) { batches.push(members(subs[i], null)); continue; }
    if (extra.some((a) => !attributeDroppable(a, material))) { batches.push(members(subs[i], null)); continue; }
    out.push(...members(subs[i], extra.length ? extra : null));
  }
  return batches;
}

// 把 root 下的静态子网格按「几何布局 + 材质外观」合并，返回 { before, after, mergedGroups } 供日志。
// opts: { minMeshes? = 8, pruneEmpty? = true, normalizeAttributes? = true }
export function mergeStaticMeshes(root, opts = {}) {
  const minMeshes = Number.isFinite(opts.minMeshes) ? opts.minMeshes : 8;
  const pruneEmpty = opts.pruneEmpty !== false;
  const normalize = opts.normalizeAttributes !== false;

  const meshes = [];
  root.traverse((o) => { if (o.isMesh && o.geometry && o.geometry.attributes && o.geometry.attributes.position) meshes.push(o); });
  const before = meshes.length;

  // ⚠ 带骨骼的模型**整个跳过**，不是只跳过骨骼网格：
  //   ① 合并会把顶点烘到 root 局部空间，骨骼/morph 网格一动就错位；
  //   ② 末尾的「清空空节点」会把没有子节点的**末端骨头**删掉 —— 骨架直接断，动画全废。
  //   （boy/girl 这种人物模型就是这种情况，合并收益为 0，风险却是满的。）
  let rigged = false;
  root.traverse((o) => { if (o.isSkinnedMesh || o.isBone) rigged = true; });
  if (rigged) return { before, after: before, mergedGroups: 0, skipped: 'rigged' };
  if (before < minMeshes) return { before, after: before, mergedGroups: 0 }; // 网格太少，合并收益抵不上开销

  root.updateMatrixWorld(true);
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const rel = new THREE.Matrix4();

  // 先按「材质外观」分组（同一材质下再按几何属性布局分批）
  const matGroups = new Map(); // matSig -> { material, list: [mesh] }
  for (const o of meshes) {
    // 不能合并的：骨骼/morph 网格（几何会随动画变）、材质数组网格（各部分要各自渲染）。
    // 注意**不要**按 geometry.groups 跳过：three 里只有「材质是数组」时才会按 group 分开提交，
    // 单材质的网格即使有 6 个 group 也只有 1 次 draw call（而 Box/Sphere 等内置几何默认就是多 group），
    // 按 group 跳过会让内置几何与不少导出模型完全无法合并。
    if (o.isSkinnedMesh || (o.morphTargetInfluences && o.morphTargetInfluences.length)) continue;
    if (Array.isArray(o.material)) continue;
    const ms = materialSigKey(o.material);
    let mg = matGroups.get(ms);
    if (!mg) { mg = { material: o.material, list: [] }; matGroups.set(ms, mg); }
    mg.list.push(o);
  }

  // 分批（含「属性归一化」）：见 planBatches
  const batches = [];
  for (const mg of matGroups.values()) {
    for (const b of planBatches(mg.list, mg.material, normalize)) batches.push({ material: mg.material, members: b });
  }

  let mergedGroups = 0;
  for (const grp of batches) {
    if (grp.members.length < 2) continue; // 单件没有合并收益
    const geos = [];
    for (const mem of grp.members) {
      const o = mem.o;
      // 必须克隆：instantiate 是浅克隆，geometry 与缓存的源模型共享，直接 applyMatrix4 会污染源模型
      const g = o.geometry.clone();
      // 归一化：把「多出来、且材质用不上」的属性从**克隆体**上删掉（不动源几何，别的影响不到）
      if (mem.drop) for (const n of mem.drop) g.deleteAttribute(n);
      rel.multiplyMatrices(toRoot, o.matrixWorld);
      g.applyMatrix4(rel);
      // 相对矩阵行列式为负（镜像节点）→ 顶点被镜像、绕向却还留在原处，
      // 而新网格自身的行列式为正，three 的 frontFace 判定会据此翻转 → 必须显式翻回来。
      if (rel.determinant() < 0) flipTriangleWinding(g);
      geos.push(g);
    }
    let merged = null;
    try { merged = mergeGeometries(geos, false); } catch (e) { merged = null; }
    if (!merged) {
      for (const g of geos) g.dispose();
      continue; // 属性布局意外不一致：保留原件，画面不受影响
    }
    for (const g of geos) g.dispose(); // 中间克隆体已烘进 merged

    const mesh = new THREE.Mesh(merged, grp.material);
    mesh.name = (grp.material && grp.material.name) ? 'merged-' + grp.material.name : 'merged';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh); // 几何已烘到 root 局部空间，所以直接挂在 root 下、保持单位变换
    for (const mem of grp.members) mem.o.removeFromParent();
    mergedGroups++;
  }

  // 清掉被掏空的中转节点：合并后模型树里会留下大量空 Group，
  // 它们每帧仍要走一次 updateMatrixWorld，也拖慢 setEditorSceneVisible 之类的遍历。
  // ⚠ 三条不删（漏一条就是"看不见的功能没了"）：
  //   ① **有名**的节点 —— 模型里的空 Object3D 常被当挂点标记（枪口/手把/出生点），删了就永远找不到位置；
  //   ② 带 userData 的（glTF extras 常挂在这里）；
  //   ③ 灯/相机/骨头 —— 它们本来就不是网格，删了等于丢功能。
  for (let pass = 0; pass < 6; pass++) {
    const dead = [];
    root.traverse((o) => {
      if (o === root || o.isMesh) return;
      if (o.children.length) return;
      if (o.isLight || o.isCamera || o.isBone) return;
      if (o.name) return;
      if (o.userData && Object.keys(o.userData).length) return;
      dead.push(o);
    });
    if (!dead.length) break;
    for (const o of dead) o.removeFromParent();
  }

  return { before, after: countMeshes(root), mergedGroups };
}

export function countMeshes(root) {
  let n = 0;
  root.traverse((o) => { if (o.isMesh) n++; });
  return n;
}
