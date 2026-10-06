// 职责：把**片元着色器**的默认浮点精度从 highp 降到 mediump —— 移动 GPU 填充率的关键杠杆。
//
// ⚠ 为什么只降片元、绝不动顶点：
//   GLSL ES 的 `precision <q> float;` 对顶点/片元是**各自独立**的默认精度。
//   本项目世界约 160×310 米，世界坐标最大 ~155 米。mediump 浮点的相对精度是 2^-10 ≈ 1e-3，
//   在 155 米处的**绝对**精度只有 ~0.15 米 —— 顶点一旦降 mediump，物体会肉眼可见地抖动/跳动
//   （顶点位置误差随坐标量级线性放大）。片元则相反：它算的是颜色/光照，量级 O(1)，
//   mediump 的 1e-3 相对误差对最终像素颜色**看不出来**，而移动 GPU 上 mediump 的
//   ALU/填充率通常是 highp 的 2 倍（Mali/Adreno/Apple GPU 均如此）。
//   ⇒ 结论：顶点保 highp（不动），片元降 mediump。这是"既有收益又无风险"的那一刀。
//
// ⚠ 为什么不能直接用 `material.precision = 'mediump'`：
//   three 的 Material.precision 是**顶点/片元共用**的（WebGLPrograms 里只算出一个
//   parameters.precision 喂给 generatePrecision，同一个串拼进两个着色器）。
//   用它就会把顶点一起降级 → 上面说的抖动。所以必须走 onBeforeCompile 只改片元主体。
//
// 原理：three 的拼装顺序是
//     fragmentGlsl = versionString + prefixFragment(含 `precision highp float;`) + fragmentShader
//   而 `fragmentShader` 这个串就是 onBeforeCompile 能改到的那部分。GLSL ES 规范明确：
//   "Multiple precision statements for the same basic type can appear inside the same scope,
//    with later statements overriding earlier statements within that scope."
//   ⇒ 在片元主体最前面插一行 `precision mediump float;`，就**覆盖**掉了 prefix 里的 highp，
//     且作用域是整段主体（后续所有未显式限定精度的 float 声明都跟着变 mediump）。
//
// ⚠ 必须避开的两类材质：
//   ① ShaderMaterial（自己手写片元的，如障眼法窗户 FakeWindow）—— 它们的片元里可能已经写了
//      `highp vec2` 之类的**显式**精度（显式限定不受默认精度影响，插了也没用），
//      而且作者对精度有明确意图，不该由我们插手。
//   ② 深度材质变体（阴影 pass 用的 MeshDepthMaterial）—— 它们**不产生颜色**，降精度零收益，
//      反而可能影响深度写入的一致性。调用方按 isMeshDepthMaterial 跳过。
//
// ⚠ 幂等与可撤销：onBeforeCompile 会在**每次程序重建**时被重新调用（如材质 needsUpdate、
//   切换渲染器状态导致重编译），所以注入逻辑本身必须幂等（查标记字符串）。而**包装**动作
//   （替换 material.onBeforeCompile）必须防重复 —— 重复包装会叠层，且撤不掉。用 Map 记录原回调。
import * as THREE from 'three';

// 注入的精度声明。带一个标记注释，供幂等判断 —— 绝不能只查 'precision mediump float;'，
// 因为有些自定义着色器源码里本来就有这句（会被误判成"已注入"而跳过真正的注入）。
export const FRAG_MARK = '/* fpm-mediump */';
export const FRAG_DECL = FRAG_MARK + 'precision mediump float;\n';

// 已包装的材质 → 它原本的 onBeforeCompile（可能为 undefined / 空函数）。
// ⚠ 用 Map 而非 WeakSet：要能主动遍历它做还原，WeakSet 遍历不了。
//   强引用不构成泄漏：材质本来就活在场景里，场景销毁时一起走。
const _applied = new Map();

/**
 * 这个材质是否适合降片元精度。
 * @param {THREE.Material} mat
 * @returns {boolean}
 */
export function canDowngrade(mat) {
  if (!mat || typeof mat !== 'object') return false;
  // ShaderMaterial / RawShaderMaterial：片元是作者手写的，显式精度不受默认精度影响，且意图明确
  if (mat.isShaderMaterial || mat.isRawShaderMaterial) return false;
  // 深度/距离/法线这类"纯数据"材质：不产生最终颜色，降精度零收益
  if (mat.isMeshDepthMaterial || mat.isMeshDistanceMaterial || mat.isMeshNormalMaterial) return false;
  // 需要 onBeforeCompile 才能挂上注入；没有这个钩子的材质跳过（极少数自定义材质）
  if (typeof mat.onBeforeCompile !== 'function') return false;
  return true;
}

/**
 * 给单个材质注入「片元 mediump」。幂等 —— 已包装过的直接返回 false。
 *
 * @param {THREE.Material} mat
 * @returns {boolean} 本次是否新包装了（true = 需要重编译）
 */
export function applyFragmentPrecision(mat) {
  if (!canDowngrade(mat)) return false;
  if (_applied.has(mat)) return false; // 已包装，防重复叠层
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = function (shader, renderer) {
    // 保留原回调（模型/其他优化模块可能也挂在上面；吃掉会静默丢功能）
    try {
      if (typeof prev === 'function') prev.call(this, shader, renderer);
    } catch (e) {
      console.warn('[fragprec] 原 onBeforeCompile 失败:', e);
    }
    injectFragmentPrecision(shader);
  };
  _applied.set(mat, prev);
  return true;
}

/**
 * 就地往 shader 的片元主体最前面插精度声明。幂等（查标记）。
 * 单独导出，方便其他模块（或探针）直接调用。
 *
 * @param {{fragmentShader?:string}} shader
 * @returns {boolean} 是否真的注入了
 */
export function injectFragmentPrecision(shader) {
  if (!shader || typeof shader.fragmentShader !== 'string') return false;
  if (shader.fragmentShader.indexOf(FRAG_MARK) !== -1) return false; // 幂等
  shader.fragmentShader = FRAG_DECL + shader.fragmentShader;
  return true;
}

/**
 * 遍历一个场景，给所有适合的材质注入片元 mediump。
 *
 * 调用时机：世界构建完成之后（加载屏之后、进游戏之前）**调一次**即可 ——
 * 那时场景里的材质已经齐了。之后再动态创建的对象（子弹、粒子等）由调用方
 * 对新材质单独调 applyFragmentPrecision（或再扫一次）。
 *
 * ⚠ 不在这里调 material.needsUpdate —— 由调用方在全部注入完成后统一触发一次编译，
 *   避免「每注入一个就重编译一次」的抖动（同 FakeWindow.patchBuildingMaterial 的约定）。
 *
 * @param {THREE.Object3D} scene
 * @returns {number} 被新包装的材质数
 */
export function applyFragmentPrecisionToScene(scene) {
  if (!scene || typeof scene.traverse !== 'function') return 0;
  let n = 0;
  const seen = new Set();
  scene.traverse((o) => {
    const m = o && o.material;
    if (!m) return;
    if (Array.isArray(m)) {
      for (const mm of m) {
        if (mm && !seen.has(mm)) { seen.add(mm); if (applyFragmentPrecision(mm)) n++; }
      }
    } else if (!seen.has(m)) {
      seen.add(m);
      if (applyFragmentPrecision(m)) n++;
    }
  });
  return n;
}

/**
 * 撤销**所有**注入，把材质恢复成原生 onBeforeCompile。
 * 主要给编辑器 / 排查用（例如怀疑某个材质在 mediump 下有瑕疵时快速回退）。
 *
 * @returns {number} 实际被还原的材质数
 */
export function unpatchAllFragmentPrecision() {
  let n = 0;
  for (const [mat, prev] of _applied) {
    try {
      mat.onBeforeCompile = prev;
      mat.needsUpdate = true;
      n++;
    } catch (e) { /* 材质可能已销毁：跳过 */ }
  }
  _applied.clear();
  return n;
}

/** 当前已被注入的材质数（调试/探针用）。 */
export function fragmentPrecisionCount() {
  return _applied.size;
}
