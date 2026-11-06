// 职责：给场景纹理采样加「负 LOD bias」—— 这是 DLSS / FSR2 在低内部分辨率下
//   保住纹理细节的**必需**一步，也是纯时域重建补不回来的那一环。
//
// 为什么必须有：
//   GPU 按屏幕空间导数 dFdx(uv)/dFdy(uv) 选 mip 层。内部渲染分辨率降到 0.67× 时，
//   同样的三角形只覆盖 0.67² 个像素，导数变大 → 自动选到更粗的 mip → 墙面/地面/路牌
//   的纹理细节**在采样那一刻就已经丢了**，后面无论多少帧抖动累积都重建不出来。
//   FSR2 的推荐值 = log2(渲染比例)：0.5× → -1.0，0.67× → -0.58，0.75× → -0.42。
//
// 实现约束（照抄 FragmentPrecision 已验证过的幂等包装模式）：
//   · 只包非 ShaderMaterial / 非深度 / 非 Sprite 的标准材质，且白名单采样器才改；
//   · 保留原 onBeforeCompile，防叠层、防吃掉别的优化模块；
//   · 注入标记幂等；uniform 用**共享对象**，改值不触发重编译；
//   · 一个采样都没替换成功就不插 uniform，避免无谓改变 program cache key；
//   · GLSL ES 1.00/3.00 的 fragment shader 都允许 texture2D(sampler, uv, float bias)，
//     three 在 WebGL2 下把 texture2D 宏映射成 texture()，三参数形式同样合法。
//
// 降级：WebGL1 / 注入抛错 / URL ?mipbias=0 / Config.TSR_MIP_BIAS=0 → bias 恒 0，
//   采样退化为原样（多传一个 0 bias 不改变结果），不会黑屏、不会静默失效。
import * as THREE from 'three';
import { Config } from '../config.js';

export const MIP_MARK = '/* fpm-mipbias */';
const DECL = MIP_MARK + 'uniform float fpmMipBias;\n';

// 所有注入材质共享这一个 uniform 对象：分辨率变化时只改 value，不需要重编译任何 shader。
export const mipBiasUniform = { value: 0 };

// 只改「按 uv 取颜色/数据贴图」的标准采样器。
// ⚠ 绝不碰 envMap（cube/equirect 采样签名不同）、shadowMap（depth compare）、
//   以及自定义 ShaderMaterial —— 那些替换错了会直接编不过 → 整块材质变黑。
const SAMPLERS = [
  'map', 'alphaMap', 'aoMap', 'lightMap', 'emissiveMap', 'bumpMap',
  'normalMap', 'roughnessMap', 'metalnessMap', 'specularMap',
  'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap',
  'sheenColorMap', 'sheenRoughnessMap', 'iridescenceMap',
  'transmissionMap', 'thicknessMap', 'anisotropyMap',
];
// 形如 texture2D( map, vMapUv )：第二参不含括号/逗号，正好覆盖 three 的 chunk 写法。
const SAMPLE_RE = new RegExp(
  '\\btexture2D\\(\\s*(' + SAMPLERS.join('|') + ')\\s*,\\s*([^(),]+?)\\s*\\)', 'g');
const INCLUDE_RE = /^[ \t]*#include +<([\w\d./]+)>/gm;

// ⚠⚠ 关键顺序坑：onBeforeCompile 拿到的 fragmentShader 是**未展开 #include** 的
//   ShaderLib 模板，里面只有 `#include <map_fragment>`，压根没有 texture2D(...) 字样
//   —— Three 要到 WebGLProgram 构造时才做 resolveIncludes()，那时已经改不了了。
//   所以这里必须自己先递归展开（照抄 Three 的 includePattern / includeReplacer），
//   否则注入是「零匹配的空操作」：探针全绿、跑起来却一点效果都没有。
//   找不到的 chunk 原样留给 Three 处理，不抛错。
function resolveIncludes(src, depth) {
  if (depth > 8) return src;
  return src.replace(INCLUDE_RE, (all, name) => {
    const chunk = THREE.ShaderChunk[name];
    return typeof chunk === 'string' ? resolveIncludes(chunk, depth + 1) : all;
  });
}

const _applied = new Map();
const _prevKeys = new Map(); // 撤销时还原 customProgramCacheKey

/** 内部渲染比例 → 负 LOD bias。关闭/原生/异常一律 0。 */
export function mipBiasFor(scale, enabled) {
  const k = Number(Config.TSR_MIP_BIAS);
  if (!enabled || !k || !isFinite(scale) || scale <= 0 || scale >= 0.999) return 0;
  const b = Math.log2(scale) * k;
  const lo = Number(Config.TSR_MIP_BIAS_MIN) || -1.5;
  return Math.max(lo, Math.min(0, b));
}

/** 全局设置 bias（所有已注入材质同时生效）。只允许 <=0，正值会放大 mip 模糊。 */
export function setMipBias(v) {
  const n = Number(v);
  mipBiasUniform.value = isFinite(n) ? Math.max(-3, Math.min(0, n)) : 0;
  return mipBiasUniform.value;
}

export function getMipBias() { return mipBiasUniform.value; }

export function canInjectBias(mat) {
  if (!mat || typeof mat !== 'object') return false;
  if (mat.isShaderMaterial || mat.isRawShaderMaterial) return false;
  if (mat.isMeshDepthMaterial || mat.isMeshDistanceMaterial || mat.isMeshNormalMaterial) return false;
  // Sprite/Points 的小贴图与文字：负 bias 在亚像素尺寸下容易闪，收益也低
  if (mat.isSpriteMaterial || mat.isPointsMaterial || mat.isLineBasicMaterial) return false;
  if (typeof mat.onBeforeCompile !== 'function') return false;
  return true;
}

/** 就地改写 shader 源码。幂等；返回是否真的改了。 */
export function injectMipBias(shader) {
  if (!shader || typeof shader.fragmentShader !== 'string') return false;
  if (shader.fragmentShader.indexOf(MIP_MARK) !== -1) return false;
  const expanded = resolveIncludes(shader.fragmentShader, 0);
  let n = 0;
  const src = expanded.replace(SAMPLE_RE, (all, name, uv) => {
    n++;
    return 'texture2D(' + name + ', ' + uv.trim() + ', fpmMipBias)';
  });
  if (!n) return false;
  shader.fragmentShader = DECL + src;
  if (shader.uniforms) shader.uniforms.fpmMipBias = mipBiasUniform;
  return true;
}

/** 包装单个材质。幂等 —— 已包装过返回 false。 */
export function applyMipBias(mat) {
  if (!canInjectBias(mat)) return false;
  if (_applied.has(mat)) return false;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = function (shader, renderer) {
    try {
      if (typeof prev === 'function') prev.call(this, shader, renderer);
    } catch (e) {
      console.warn('[mipbias] 原 onBeforeCompile 失败:', e);
    }
    try {
      injectMipBias(shader);
    } catch (e) {
      // 单材质注入失败不能拖垮整个 program：退回原始采样（bias 恒 0 也无害）
      console.warn('[mipbias] 注入失败，该材质退回原采样:', e);
    }
  };
  _applied.set(mat, prev);
  // ⚠ program cache key 必须把「已注入」和「未注入」的材质分开：
  //   three 默认 customProgramCacheKey() = onBeforeCompile.toString()，而本模块与
  //   FragmentPrecision 用的是同一段包装函数源码 —— 被排除的材质（Sprite/深度/自定义）
  //   与注入过的材质会拿到同一个 key，却对应两份不同的 shader，可能被错误复用。
  //   追加一个后缀即可区分；原 key（若材质自定义过）保留在前面。
  const prevKey = typeof mat.customProgramCacheKey === 'function'
    ? mat.customProgramCacheKey.bind(mat) : null;
  _prevKeys.set(mat, mat.customProgramCacheKey);
  mat.customProgramCacheKey = function () {
    return (prevKey ? prevKey() : '') + '|fpm-mipbias';
  };
  return true;
}

/**
 * 遍历场景注入一次。
 * @param {THREE.Object3D} scene
 * @param {(mat: THREE.Material) => void} [onNew] 只对新包装的材质回调；
 *   运行期补扫时用它单独标 needsUpdate，避免把全场材质重编译一遍。
 * @returns {number} 新包装的材质数
 */
export function applyMipBiasToScene(scene, onNew) {
  if (!scene || typeof scene.traverse !== 'function') return 0;
  let n = 0;
  const seen = new Set();
  scene.traverse((o) => {
    const m = o && o.material;
    if (!m) return;
    if (Array.isArray(m)) {
      for (const mm of m) {
        if (mm && !seen.has(mm)) {
          seen.add(mm);
          if (applyMipBias(mm)) { n++; if (typeof onNew === 'function') onNew(mm); }
        }
      }
    } else if (!seen.has(m)) {
      seen.add(m);
      if (applyMipBias(m)) { n++; if (typeof onNew === 'function') onNew(m); }
    }
  });
  return n;
}

/** 全部撤销（排查用）。 */
export function unpatchAllMipBias() {
  let n = 0;
  for (const [mat, prev] of _applied) {
    try {
      mat.onBeforeCompile = prev;
      const k = _prevKeys.get(mat);
      if (k) mat.customProgramCacheKey = k;
      else delete mat.customProgramCacheKey;
      mat.needsUpdate = true;
      n++;
    } catch (e) { console.warn('[mipbias] 还原失败:', e); }
  }
  _applied.clear();
  _prevKeys.clear();
  setMipBias(0);
  return n;
}

export function mipBiasCount() { return _applied.size; }
