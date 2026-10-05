// 障眼法窗户（fake window）
//
// 目的：有些建筑忘了做窗户，墙上光秃秃。这里在墙面上贴一块 quad，让它**看起来像窗外**。
//
// 性能取向 —— 为什么不做"真窗口"（第二个相机把墙外场景再渲一遍）：
//   本项目建筑是「整栋楼 = 1 个 mesh + 1 个材质」（窗户烘死在贴图里），
//   每多一扇真窗口就多一趟全场景渲染。当前场景约 42k 三角面，
//   2 扇真窗 = 渲染负载 +100%，而且会跟 Game._renderFrame() 的超分 RT 抢
//   render target / 打乱 renderer.info 统计（见 Game.js L970 注释）。
//   手机端直接判死刑。
//
// 所以这里走「**零额外渲染趟数**」的障眼法：
//   窗户 quad 不参与任何额外 pass，只是在主渲染里多花 2 个三角面 + 1 次 draw call，
//   fragment shader 从**已经存在的** scene.environment（PMREM 环境贴图）按视线方向采样，
//   于是「头一转，窗里的景色跟着转」——错觉成立，开销约等于 0。
//
// ⚠ 关键约束：
//   ① 绝不能 dispose scene.environment —— 那是 SkyBox 管理的共享贴图，
//      窗户材质只是**引用**它。本模块只 dispose 自己创建的材质。
//   ② 环境贴图是 PMREM 的 cubeUV 结构（mapping = CubeUVReflectionMapping），
//      fragment 里要用 Three 内置的 textureCubeUV() 采样，不能当普通 cube 用。
//   ③ uniform 里存**引用**而不是拷贝，环境贴图被 SkyBox 换掉时要能跟上 ——
//      用 setWindowEnv() 由外部在换环境时同步一次（不要每帧改，见下）。
import * as THREE from 'three';

// 窗户默认参数：**唯一来源**。编辑器新建、读档回填、游戏端构建都必须引用这里，
// 否则同一参数在四五处各写一份，迟早分叉（本项目已经栽过一次：面光源默认值分叉）。
export const WINDOW_DEFAULTS = Object.freeze({
  w: 1.6,          // 宽（米）
  h: 1.2,          // 高（米）
  glass: '#8fb8d8', // 玻璃染色（乘在采样到的环境色上）
  opacity: 0.28,   // 玻璃自身的不透明度（0 = 纯镜像，1 = 全玻璃色）
  mirror: 1.0,     // 环境采样强度（0 = 只看玻璃色，1 = 完整反射）
  rotX: 0,
  rotY: 0,
  rotZ: 0,
});

// 把 '#rrggbb' / 数字 / THREE.Color 统一成 THREE.Color。
function toColor(v, fallback) {
  try {
    if (v && typeof v === 'object' && v.isColor) return v.clone();
    if (v == null) return new THREE.Color(fallback);
    return new THREE.Color(v);
  } catch (e) {
    return new THREE.Color(fallback);
  }
}

/**
 * 创建障眼法窗户材质。
 *
 * @param {object} [opts]
 * @param {THREE.Texture|null} [opts.env]   环境贴图（通常是 scene.environment，PMREM cubeUV）。可后补。
 * @param {string|number|THREE.Color} [opts.glass]   玻璃染色
 * @param {number} [opts.opacity]  玻璃不透明度 0..1
 * @param {number} [opts.mirror]   环境采样强度 0..1
 * @param {number} [opts.fresnel]  边缘增强（越大越像玻璃、越"亮边"）
 * @returns {THREE.ShaderMaterial}
 */
export function createWindowMaterial(opts = {}) {
  const glass = toColor(opts.glass, WINDOW_DEFAULTS.glass);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      tEnv: { value: opts.env || null },
      uGlass: { value: new THREE.Vector3(glass.r, glass.g, glass.b) },
      uOpacity: { value: opts.opacity != null ? opts.opacity : WINDOW_DEFAULTS.opacity },
      uMirror: { value: opts.mirror != null ? opts.mirror : WINDOW_DEFAULTS.mirror },
      uFresnel: { value: opts.fresnel != null ? opts.fresnel : 0.55 },
      // PMREM 采样需要的系数（Three 内部会根据纹理尺寸设，这里给安全默认，
      // 由 setWindowEnv() 在拿到真贴图时校正）。
      uCubeUV: { value: new THREE.Vector4(1, 1, 0, 0) },
      uEnvReady: { value: 0 },
      // CUBEUV_MAX_MIP / TEXEL_WIDTH / TEXEL_HEIGHT 在 Three 内置着色器里是 #define，
      // 由 WebGLProgram 注入；这里用裸 ShaderMaterial，所以要自己带（由 setWindowEnv 按贴图实算）。
      uCubeUVMaxMip: { value: 9.0 },
      uCubeUVTexelW: { value: 1 / 256 },
      uCubeUVTexelH: { value: 1 / 256 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;
      void main() {
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D tEnv;
      uniform vec3  uGlass;
      uniform float uOpacity;
      uniform float uMirror;
      uniform float uFresnel;
      uniform vec4  uCubeUV;
      uniform float uEnvReady;
      uniform float uCubeUVMaxMip;
      uniform float uCubeUVTexelW;
      uniform float uCubeUVTexelH;
      #define CUBEUV_MAX_MIP uCubeUVMaxMip
      #define CUBEUV_TEXEL_WIDTH uCubeUVTexelW
      #define CUBEUV_TEXEL_HEIGHT uCubeUVTexelH

      varying vec2 vUv;
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;

      // === Three.js 的 cubeUV 采样 ===
      // PMREM 贴图不是普通 cubemap，而是一张被「3 面 × 2 行 + mip 链」打包进 2D 的图。
      // 下面这段是从 three/src/renderers/shaders/ShaderChunk/cube_uv_reflection_fragment.glsl.js
      // **逐行照搬**的（只把 mip 选择固定在最清晰的 base 层，省掉 roughness 换算与 mip 混合）——
      // 自己凭印象写必然错位，本项目已经栽过一次（tools/lib-png.mjs 的调色板 PNG）。
      #define cubeUV_minMipLevel 4.0
      float cubeUV_getFace(vec3 direction) {
        vec3 absDirection = abs(direction);
        float face = -1.0;
        if (absDirection.x > absDirection.z) {
          if (absDirection.x > absDirection.y) face = direction.x > 0.0 ? 0.0 : 3.0;
          else                                face = direction.y > 0.0 ? 1.0 : 4.0;
        } else {
          if (absDirection.z > absDirection.y) face = direction.z > 0.0 ? 2.0 : 5.0;
          else                                 face = direction.y > 0.0 ? 1.0 : 4.0;
        }
        return face;
      }
      vec2 cubeUV_getUV(vec3 direction, float face) {
        vec2 uv;
        if      (face == 0.0) uv = vec2( direction.z,  direction.y) / abs(direction.x);
        else if (face == 1.0) uv = vec2(-direction.x, -direction.z) / abs(direction.y);
        else if (face == 2.0) uv = vec2(-direction.x,  direction.y) / abs(direction.z);
        else if (face == 3.0) uv = vec2(-direction.z,  direction.y) / abs(direction.x);
        else if (face == 4.0) uv = vec2(-direction.x,  direction.z) / abs(direction.y);
        else                  uv = vec2( direction.x,  direction.y) / abs(direction.z);
        return 0.5 * (uv + 1.0);
      }
      vec3 sampleEnv(vec3 direction) {
        // 固定取最清晰层：窗户反射要"利"不要"糊"，而且省掉一次双线性 mip 混合
        float mipInt  = cubeUV_minMipLevel;
        float faceSize = exp2(mipInt);              // = 16
        float face = cubeUV_getFace(direction);
        highp vec2 uv = cubeUV_getUV(direction, face) * (faceSize - 2.0) + 1.0;
        if (face > 2.0) { uv.y += faceSize; face -= 3.0; }
        uv.x += face * faceSize;
        // filterInt = max(cubeUV_minMipLevel - mipInt, 0) = 0，所以略过 filterInt 那一行
        uv.y += 4.0 * (exp2(CUBEUV_MAX_MIP) - faceSize);
        uv.x *= CUBEUV_TEXEL_WIDTH;
        uv.y *= CUBEUV_TEXEL_HEIGHT;
        return texture2D(tEnv, uv).rgb;
      }

      void main() {
        if (uEnvReady < 0.5) { gl_FragColor = vec4(uGlass, 1.0); return; }

        vec3 N = normalize(vWorldNormal);
        vec3 V = normalize(cameraPosition - vWorldPos);
        // 视线在窗面上的反射方向 —— 头一偏，反射方向就变，窗里景色跟着转
        vec3 R = reflect(-V, N);

        vec3 env = sampleEnv(R);

        // 菲涅尔：越掠射（视线越贴窗面）反射越强，正视时更透
        float f = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
        float mirror = clamp(uMirror * (0.35 + 0.65 * f) + uFresnel * f, 0.0, 1.0);

        // 玻璃色 + 环境反射：反射占 mirror，剩下是玻璃本体色
        vec3 col = mix(uGlass, env, mirror);
        // 玻璃色本身也提一点亮，避免阴天/夜里窗户是死黑一块
        col = max(col, uGlass * uOpacity * 0.6);

        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }
    `,
    // 窗户是贴墙的薄片：
    //  · depthTest 保持开（默认 true）—— 别的墙挡在前面时窗户必须被正确遮挡
    //  · depthWrite 关 —— 窗户不遮挡它后面的东西（否则会挡住同面墙上的其它细节）
    //  · 双面 —— 从墙的两侧看都不会"消失"
    //  · polygonOffset 负值 —— 与墙面**共面**时把窗户往相机方向拉一点，避免 z-fighting 闪烁
    side: THREE.DoubleSide,
    transparent: false,
    depthTest: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  return mat;
}

/**
 * 把环境贴图绑到窗户材质上。由外部在「环境贴图就绪 / 被替换」时调用一次，
 * **不要每帧调用**（每帧写 uniform 会白白脏化材质程序缓存判断）。
 *
 * @param {THREE.ShaderMaterial} mat  createWindowMaterial 的产物
 * @param {THREE.Texture|null} env    通常是 scene.environment
 */
export function setWindowEnv(mat, env) {
  if (!mat || !mat.uniforms) return;
  const u = mat.uniforms;
  u.tEnv.value = env || null;
  u.uEnvReady.value = env ? 1 : 0;
  if (!env) return;
  // 按 Three 的做法反推 cubeUV 布局参数。**必须与 Three 的 generateCubeUVSize() 逐字一致**
  // （three/src/renderers/webgl/WebGLProgram.js）：
  //   maxMip      = log2(imageHeight) - 2
  //   texelHeight = 1 / imageHeight
  //   texelWidth  = 1 / (3 * max(2^maxMip, 7*16))
  // 之前我凭印象写成 1/(w*2+2) / 1/(h*3)，是错的 —— 采样会整体错位。
  const h = (env.image && env.image.height) || env.source?.data?.height || 0;
  const w = (env.image && env.image.width) || env.source?.data?.width || 0;
  if (h > 0) {
    const maxMip = Math.log2(h) - 2;
    u.uCubeUVMaxMip.value = maxMip;
    u.uCubeUVTexelH.value = 1 / h;
    u.uCubeUVTexelW.value = 1 / (3 * Math.max(Math.pow(2, maxMip), 7 * 16));
    if (w > 0) u.uCubeUV.value.set(w, h, 1 / w, 1 / h);
  }
}

/**
 * 创建一个障眼法窗户网格。
 *
 * @param {object} [opts]  透传给 createWindowMaterial，另加：
 * @param {number} [opts.w] 宽
 * @param {number} [opts.h] 高
 * @param {THREE.Texture|null} [opts.env]
 * @returns {THREE.Mesh}  （材质在 mesh.material，网格信息在 mesh.userData.fakeWindow）
 */
export function createWindowMesh(opts = {}) {
  const w = opts.w != null ? opts.w : WINDOW_DEFAULTS.w;
  const h = opts.h != null ? opts.h : WINDOW_DEFAULTS.h;
  const geo = new THREE.PlaneGeometry(w, h, 1, 1);
  const mat = createWindowMaterial(opts);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = true;
  // 标记：编辑器/游戏端靠这个识别"这是障眼法窗户"，而不是普通模型
  mesh.userData.fakeWindow = true;
  mesh.userData.windowSize = { w, h };
  return mesh;
}

/**
 * 从既有 mesh 读取窗户参数（用于编辑器面板回填 / 序列化）。
 * 返回的对象字段与 WINDOW_DEFAULTS 对齐。
 */
export function readWindowParams(mesh) {
  const out = { w: WINDOW_DEFAULTS.w, h: WINDOW_DEFAULTS.h, glass: WINDOW_DEFAULTS.glass, opacity: WINDOW_DEFAULTS.opacity, mirror: WINDOW_DEFAULTS.mirror };
  if (!mesh) return out;
  const size = mesh.userData && mesh.userData.windowSize;
  if (size) { out.w = size.w; out.h = size.h; }
  else if (mesh.geometry && mesh.geometry.parameters) {
    out.w = mesh.geometry.parameters.width;
    out.h = mesh.geometry.parameters.height;
  }
  const u = mesh.material && mesh.material.uniforms;
  if (u) {
    if (u.uGlass) { const c = new THREE.Color(u.uGlass.value.x, u.uGlass.value.y, u.uGlass.value.z); out.glass = '#' + c.getHexString(); }
    if (u.uOpacity) out.opacity = u.uOpacity.value;
    if (u.uMirror) out.mirror = u.uMirror.value;
  }
  return out;
}

/**
 * 释放窗户占用的资源。
 * ⚠ **绝不释放 env 贴图**（那是共享的 scene.environment），只释放自己的 geometry/material。
 */
export function disposeWindow(mesh) {
  if (!mesh) return;
  try { if (mesh.geometry) mesh.geometry.dispose(); } catch (e) { /* ignore */ }
  try {
    const m = mesh.material;
    if (m) {
      // 环境贴图是共享引用，不在这里 dispose —— 只清自己的 uniform 引用
      if (m.uniforms && m.uniforms.tEnv) m.uniforms.tEnv.value = null;
      m.dispose();
    }
  } catch (e) { /* ignore */ }
}
