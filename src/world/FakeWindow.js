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

// ===========================================================================
// 墙体挖洞（真开洞，零额外开销）
// ---------------------------------------------------------------------------
// 需求：障眼法窗户只是「贴一张窗外景色」，墙还是完整的 —— 走到侧面/贴近看，
//   墙的厚度、内壁都还在，穿帮。用户要「在墙上真的开个洞」。
//
// 为什么不做真几何开洞（把墙的 mesh 挖掉一块）：
//   本项目建筑是「整栋楼 = 1 mesh + 1 材质」，且**是闭合外壳、内部没有房间几何**。
//   真去删三角形要重建 geometry + 重烘碰撞 + 重算包围盒，成本与风险都极高，
//   而且挖出来的洞里看到的是「墙内侧背面」——一样穿帮，还不如直接 discard。
//
// 采用的方案 —— fragment 里 discard（**开销严格为 0**）：
//   给建筑的 MeshStandardMaterial 打一个 onBeforeCompile 补丁，在片元阶段把
//   「世界坐标落在某个窗洞盒里」的像素直接 discard 掉。于是：
//     · 墙被真正"看穿"了 —— 洞后面是什么就看见什么（隔壁建筑/天空/地面）
//     · draw call 0 增加、三角形 0 增加、渲染趟数 0 增加、显存 0 增加
//     · 只有被 discard 的像素省下了着色（略微更快）
//   ⚠ 唯一代价：材质需要重编译一次（onBeforeCompile 改的是 shader 源码），
//     所以**只在窗洞集合真正变化时**才 needsUpdate，不要每帧碰。
//
// ⚠⚠ 不能给"每个窗户各配一份参数"的材质 —— Merge.js 的 materialSigKey 指纹
//   **不包含** onBeforeCompile / uniforms / defines（见 Merge.js MATERIAL_SKIP_KEYS），
//   合并时会把"外观一致"（= 指纹相同）的材质并成一批、只保留**首实例**的材质。
//   若洞参数挂在材质自己的 uniform 上，合并后非首实例的洞会全部消失。
//   所以这里用**模块级共享 uniform 数组**：所有建筑材质引用同一个 holes 数组，
//   合并前后都有同一份数据，天然免疫指纹问题。
// ===========================================================================

// 每栋建筑最多能开的窗洞数。数组长度固定 → 改内容不触发重编译（shader 里是常量循环）。
export const MAX_HOLES = 24;
// 全部建筑材质共享的窗洞 uniform（**共享**是刻意的，理由见本节开头 ⚠⚠）。
//   uHoleCount 有效洞数量（0 = 全部关闭，此时 shader 立刻返回，等于没打补丁）
//   uHoles[i]  xyz = 洞的世界中心，w = 启用标志（1/0）
//   uHoleHalf[i]  洞在世界空间的三个半轴（轴对齐盒，比包围球紧得多）
export const holeUniforms = {
  uHoleCount: { value: 0 },
  uHoles: { value: Array.from({ length: MAX_HOLES }, () => new THREE.Vector4(0, 0, 0, 0)) },
  uHoleHalf: { value: Array.from({ length: MAX_HOLES }, () => new THREE.Vector3(0, 0, 0)) },
};

// 已打补丁的材质集合。**必须**用它来防重复包装 onBeforeCompile ——
// 一旦同一份材质被 patch 两次，onBeforeCompile 会变成两层包装，
// 而每层都会各注入一份 #define MAX_WINDOW_HOLES → shader 里出现重复定义 → 编译直接报错。
// （用 WeakSet 而非 Set：材质被 GC 后标记自动消失，不会永久占内存。）
let _holeAppliedMats = new WeakSet();

/**
 * 计算一个窗户（世界空间）对应的「世界轴对齐挖洞盒」。
 *
 * 窗户本身是一个薄 quad（面法线朝 rotX/rotY/rotZ 方向），要挖出「穿过墙」的洞，
 * 洞盒必须在墙法线方向上有足够厚度（穿透墙厚），在面内方向刚好等于窗户宽高。
 * shader 用**世界轴对齐盒**判定（这样对任意朝向的墙都成立、无需知道建筑自身的旋转），
 * 所以这里把「窗户局部半尺寸 (±w/2, ±h/2, ±depth/2)」用窗户旋转矩阵变换到世界空间，
 * 三个世界轴的**投影长度之和**就是该盒的三个半轴 —— 比包围球紧、比忽略旋转准。
 *
 * ⚠ 这是**保守外扩**（旋转盒的轴对齐包围盒），斜着贴的窗洞会比视觉稍大一点；
 *   轴对齐贴墙时（绝大多数情况）它精确等于 (w/2, h/2, depth/2)，没有浪费。
 *
 * @param {object} win  {x,y,z,rotX,rotY,rotZ,xw,xh}（**弧度**）
 * @param {number} [depth] 洞在墙法线方向的厚度（米），默认 1.0（多数墙体 < 0.6m）
 * @returns {{cx:number,cy:number,cz:number,hx:number,hy:number,hz:number}}
 */
export function computeHoleBox(win, depth) {
  const w = Math.max(0.05, Number(win && win.xw) || WINDOW_DEFAULTS.w);
  const h = Math.max(0.05, Number(win && win.xh) || WINDOW_DEFAULTS.h);
  const d = Math.max(0.05, depth != null ? depth : 1.0);
  const cx = Number(win && win.x) || 0;
  const cy = Number(win && win.y) || 0;
  const cz = Number(win && win.z) || 0;
  // 窗户局部半轴。PlaneGeometry 在 xy 平面、法线 +z，所以厚度方向是 z。
  const e = new THREE.Euler(
    Number(win && win.rotX) || 0,
    Number(win && win.rotY) || 0,
    Number(win && win.rotZ) || 0,
    'XYZ'
  );
  const m = new THREE.Matrix4().makeRotationFromEuler(e);
  // 每个局部半轴被旋转后，在各世界轴上投影长度之和 = 该轴的轴对齐半长
  const e0 = new THREE.Vector3(w / 2, 0, 0).applyMatrix4(m);
  const e1 = new THREE.Vector3(0, h / 2, 0).applyMatrix4(m);
  const e2 = new THREE.Vector3(0, 0, d / 2).applyMatrix4(m);
  return {
    cx, cy, cz,
    hx: Math.abs(e0.x) + Math.abs(e1.x) + Math.abs(e2.x),
    hy: Math.abs(e0.y) + Math.abs(e1.y) + Math.abs(e2.y),
    hz: Math.abs(e0.z) + Math.abs(e1.z) + Math.abs(e2.z),
  };
}

/**
 * 把一组窗户写进共享 uniform。返回值 = 真正生效的洞数量（被 MAX_HOLES 截断后）。
 * ⚠ 本函数**只写数据**，不碰材质 —— 材质由 applyWindowHoles() 统一打补丁/刷新。
 *
 * @param {Array<object>} wins  窗户记录数组，角度必须是**弧度**
 * @param {number} [depth]      洞厚（米）
 */
export function setHoleList(wins, depth) {
  const list = Array.isArray(wins) ? wins : [];
  const count = Math.min(list.length, MAX_HOLES);
  const holes = holeUniforms.uHoles.value;
  const half = holeUniforms.uHoleHalf.value;
  for (let i = 0; i < count; i++) {
    const b = computeHoleBox(list[i], depth);
    holes[i].set(b.cx, b.cy, b.cz, 1);
    half[i].set(b.hx, b.hy, b.hz);
  }
  // 超出的洞位必须显式关掉（否则上一轮的残留会继续挖洞）
  for (let i = count; i < MAX_HOLES; i++) {
    holes[i].set(0, 0, 0, 0);
    half[i].set(0, 0, 0);
  }
  holeUniforms.uHoleCount.value = count;
  return count;
}

// 生成「挖洞判定」的 GLSL 公共段（片元与阴影深度材质共用同一份逻辑）。
// 世界坐标从 vFpmWorldPos 来（由我们自己在 vertex 注入的 varying，不依赖 three 的
// USE_ENVMAP / worldpos 开关 —— 建筑材质不一定开 envmap，靠 three 的 vWorldPosition 会翻车）。
function holeChunkGLSL() {
  return [
    '#define MAX_WINDOW_HOLES ' + MAX_HOLES,
    'uniform float uHoleCount;',
    'uniform vec4 uHoles[MAX_WINDOW_HOLES];',
    'uniform vec3 uHoleHalf[MAX_WINDOW_HOLES];',
    'bool inAnyWindowHole(vec3 wp) {',
    '  for (int i = 0; i < MAX_WINDOW_HOLES; i++) {',
    '    if (float(i) >= uHoleCount) break;',     // 未启用的槽位直接跳出（洞是紧凑排列的）
    '    vec4 hl = uHoles[i];',
    '    if (hl.w < 0.5) continue;',
    '    vec3 df = abs(wp - hl.xyz);',
    '    vec3 hf = uHoleHalf[i];',
    '    if (df.x <= hf.x && df.y <= hf.y && df.z <= hf.z) return true;',
    '  }',
    '  return false;',
    '}',
  ].join('\n');
}

// 往 shader 里注入挖洞逻辑。vertex 负责产出世界坐标 varying，fragment 负责 discard。
// shader 是 three 传进来的对象（{ vertexShader, fragmentShader, uniforms }），就地改写。
export function injectHoleCode(shader) {
  if (!shader || typeof shader.vertexShader !== 'string' || typeof shader.fragmentShader !== 'string') return false;
  // 幂等：已经注入过就跳过（onBeforeCompile 在程序重建时会被重新调用，可能重复进入）
  if (shader.fragmentShader.indexOf('inAnyWindowHole') !== -1) return false;

  const uni = shader.uniforms || (shader.uniforms = {});
  uni.uHoleCount = holeUniforms.uHoleCount;
  uni.uHoles = holeUniforms.uHoles;
  uni.uHoleHalf = holeUniforms.uHoleHalf;

  // ---- vertex：补一个世界坐标 varying ----
  // 首选锚点 '#include <fog_vertex>' —— 它一定排在 '#include <begin_vertex>'（transformed 诞生处）
  // 之后，所以此刻 transformed 已可用，且它在 main 体内。
  // 深度材质（ShaderLib.depth）没有 fog_vertex → 走兜底：插在 main 的最后一个 } 之前
  //   （已验证：depth.vertex 的最后一个 } 正是 main 的结束符）。
  const vDecl = 'varying vec3 vFpmWorldPos;\n';
  const vInject = 'vFpmWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\n';
  if (shader.vertexShader.indexOf('vFpmWorldPos') === -1) {
    // 'transformed' 是 three 顶点着色器的标准局部坐标变量（<begin_vertex> 之后就有）
    if (shader.vertexShader.indexOf('#include <fog_vertex>') !== -1) {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <fog_vertex>',
        vInject + '#include <fog_vertex>'
      );
    } else {
      // 兜底：直接挂在 main 的最后一个 } 之前
      const i = shader.vertexShader.lastIndexOf('}');
      shader.vertexShader = shader.vertexShader.slice(0, i) + vInject + shader.vertexShader.slice(i);
    }
    shader.vertexShader = vDecl + shader.vertexShader;
  }

  // ---- fragment：声明 + 判定函数 + discard ----
  shader.fragmentShader = 'varying vec3 vFpmWorldPos;\n' + holeChunkGLSL() + '\n' + shader.fragmentShader;
  // 插在 clipping_planes_fragment 之后（three 片元里最早、且已完成 discard 剪裁的阶段）。
  // 万一该 chunk 不存在（自定义材质），退到 'void main() {' 之后第一行 —— 但此时
  // vFpmWorldPos 已声明，位置信息不依赖任何后续代码，放在函数开头同样是安全的。
  if (shader.fragmentShader.indexOf('#include <clipping_planes_fragment>') !== -1) {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <clipping_planes_fragment>',
      '#include <clipping_planes_fragment>\n  if (uHoleCount > 0.5 && inAnyWindowHole(vFpmWorldPos)) discard;'
    );
  } else {
    shader.fragmentShader = shader.fragmentShader.replace(
      'void main() {',
      'void main() {\n  if (uHoleCount > 0.5 && inAnyWindowHole(vFpmWorldPos)) discard;'
    );
  }
  return true;
}

/**
 * 给一个建筑材质打「挖洞」补丁（幂等 —— 同一材质只包装一次 onBeforeCompile）。
 *
 * @param {THREE.Material} mat  建筑的渲染材质（MeshStandardMaterial 等）
 * @returns {boolean} 本次是否新打了补丁
 */
export function patchBuildingMaterial(mat) {
  if (!mat || typeof mat.onBeforeCompile !== 'function') return false;
  if (_holeAppliedMats.has(mat)) return false;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = function (shader, renderer) {
    // 保留原回调（模型可能自带；吃掉会静默丢功能）
    try { if (typeof prev === 'function') prev.call(this, shader, renderer); } catch (e) { console.warn('[hole] 原 onBeforeCompile 失败:', e); }
    injectHoleCode(shader);
  };
  // ⚠ 改 shader 源码必须重编译。但**不要**在这里调 needsUpdate —— 由调用方在「洞集合真的变了」
  //   之后统一调一次，避免每次 patch 都触发一次全场重编译尖峰。
  _holeAppliedMats.add(mat);
  return true;
}

/**
 * 阴影也要挖洞 —— 否则墙上有个「没被挖掉」的影子，穿帮更明显。
 * three 的阴影走**独立的深度材质**（DirectionalLightShadow 用 MeshDepthMaterial），
 * 主材质的 onBeforeCompile 对它完全无效，必须单独处理：
 *   ① 把灯光的 shadow 深度材质换成开了 alphaTest 的自定义深度材质（能 discard）；
 *   ② 同样注入挖洞 GLSL。
 *
 * @param {THREE.Light} light  带 shadow 的光源（本项目 = 太阳方向光）
 * @returns {boolean} 是否处理成功
 */
export function patchShadowMaterial(light) {
  if (!light || !light.shadow) return false;
  if (light.shadow.__fpmHolePatched) return false;
  const prevMat = light.shadow.customDepthMaterial;
  // 基于 three 默认的深度材质属性造一个「允许 discard」的深度材质
  const depth = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
    // ⚠ alphaTest 是关键：three 的深度材质只有在 alphaTest > 0 时才在 shader 里保留
    //   #include <alphatest_fragment>，否则 discard 会被优化掉。
    alphaTest: 0.5,
  });
  depth.onBeforeCompile = function (shader) { injectHoleCode(shader); };
  light.shadow.customDepthMaterial = depth;
  light.shadow.__fpmHolePatched = true;
  light.shadow.__fpmPrevDepthMat = prevMat || null;
  return true;
}

/**
 * 一次性把「洞集合 + 要挖洞的材质/光影」都处理掉 —— 调用方只需要这一个入口。
 *
 * @param {Array<object>} wins        窗户记录数组（角度为**弧度**）
 * @param {Array<THREE.Material>} mats 要打补丁的建筑材质
 * @param {Array<THREE.Light>} lights  要打补丁阴影的光源
 * @param {object} [opts]
 * @param {number} [opts.depth]  洞厚（米）
 * @returns {{count:number, patched:number, shadow:number}}
 */
export function applyWindowHoles(wins, mats, lights, opts = {}) {
  const count = setHoleList(wins, opts.depth);
  let patched = 0;
  for (const m of (Array.isArray(mats) ? mats : [])) {
    if (patchBuildingMaterial(m)) patched++;
  }
  let shadow = 0;
  for (const l of (Array.isArray(lights) ? lights : [])) {
    if (patchShadowMaterial(l)) shadow++;
  }
  // 洞的**数量**没变时 shader 结构不变、无需重编译（uniform 数组内容变化是免费上传的）；
  // 但如果从 0 个洞变成有洞（或反之），shader 里那个 `uHoleCount > 0.5` 分支的代价
  // 仍然只是 uniform 判断 —— 真正需要重编译的只有「onBeforeCompile 首次挂上」那一次，
  // 已经由 patchBuildingMaterial 内部完成。这里对已打补丁的材质补一次 needsUpdate，
  // 保证首次运行时新挂上的 shader 一定会被编译（而不是复用旧的已编译程序）。
  if (patched > 0 || shadow > 0) {
    for (const m of (Array.isArray(mats) ? mats : [])) { if (m) m.needsUpdate = true; }
  }
  return { count, patched, shadow };
}

// 场景重建时调用：清掉「已打补丁」的记录。
// — 若重建后材质实例被复用（AssetLoader 有模型缓存），它们本来就在集合里、无需重打；
// — 若换成了新实例，新实例不在集合里、会被正常打补丁。
// 两种情况都不需要重置。保留此导出仅供「确知材质被整体换掉且想强制重打」的场景。
export function resetHolePatches() {
  _holeAppliedMats = new WeakSet();
}
