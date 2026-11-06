// 职责：WebGL2 下的「时域超分」(TSR, Temporal Super Resolution)。
//
// 为什么这不是上一版那个「降分辨率 + 单 pass 锐化」：
//   单 pass 只能把已有的低分辨率像素插值放大，信息量永远只有 1 帧 1 样本，
//   所以边缘糊、细线闪、斜边爬楼梯。DLSS / FSR2 / UE TSR 的画质来自**多帧重建**：
//     ① 每帧把投影矩阵偏移一个亚像素抖动（Halton 2,3），让每帧采样位置不同；
//     ② 静态场景在 8~32 帧内相当于被超采样，把这些样本按 jitter 相位汇到显示像素网格；
//     ③ 用深度把当前像素反投影回世界，再用上一帧 VP 找到它在历史图里的位置（reprojection）；
//     ④ 历史色做 YCoCg 方差裁剪 + 深度 disocclusion 权重，压住鬼影；
//     ⑤ 末尾 RCAS/CAS 锐化找回细节。
//   AI 网络（DLSS 4.5 的二代 Transformer）只是「重建器」的一种实现，需要 Tensor Core FP8/FP4
//   + DX12/Vulkan + Streamline；WebGL2 无法调用。但上面 ①~⑤ 是纯 shader，能在老卡上跑，
//   得到的就是 DLSS 那类「低分辨率看起来接近甚至好于原生」的效果。
//
// 功耗控制（本项目实测：像素着色占 89%，唯一有效杠杆是降分辨率）：
//   · 主场景仍渲在低分辨率 RT（0.5× 时像素量 1/4）；
//   · 历史累积跑在显示分辨率，但每帧只多 1 趟全屏 pass（Lanczos 权重走 256×1 LUT，
//     不在片元里算 sin）；原来的锐化 pass 变成「读历史图 + 8 邻域自适应锐化」，数量不变；
//   · ⚠ TSR 路径的 RT 强制 HalfFloat（Config.TSR_HDR_RT）：8bit 存线性色时 1/255 的
//     量化步长与相邻 jitter 相位的色差同量级，历史里根本存不进新信息 —— 这是
//     「开了 TSR 却看不出提升」的主因之一。单 pass CAS 路径仍可用 8bit 省带宽；
//   · 无 velocity buffer（要重渲整场景，老卡不划算）→ 相机运动靠深度重投影，
//     动态人物/球靠颜色方差裁剪与深度差异快速降权，而不是额外渲染一趟。
//   · 低分辨率会让 GPU 自动选更粗的 mip 层，纹理细节在采样瞬间就丢了；
//     Game 侧另行注入负 LOD bias（MipBias.js），这一步时域重建补不回来。
//
// 失败/降级：任何一步抛错或能力不足 → failed=true，Game 永久退回单 pass CAS，并出声 warn，
//   绝不静默半黑屏。kill-switch：Config.TSR_ENABLED=0 或 URL ?tsr=0。
import * as THREE from 'three';
import { Config } from '../config.js';

// Halton 低差异序列：抖动相位必须均匀铺满像素，随机序列会留下成片噪点。
function halton(index, base) {
  let f = 1;
  let r = 0;
  let i = index;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}

// Lanczos(a=2) 核：只在生成 LUT 时用一次，运行时由 tLut 查表。
function lanczos2(x) {
  const ax = Math.abs(x);
  if (ax < 1e-5) return 1;
  if (ax >= 2) return 0;
  const p = Math.PI * x;
  return 2 * Math.sin(p) * Math.sin(p / 2) / (p * p);
}

const VERT = [
  'varying vec2 vUv;',
  'void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
].join('\n');

const FRAG = [
  'uniform sampler2D tColor;',
  'uniform sampler2D tDepth;',
  'uniform sampler2D tHistory;',
  'uniform sampler2D tLut;',
  'uniform vec2 uRenderSize;',
  'uniform vec2 uInvRenderSize;',
  'uniform vec2 uJitter;',
  'uniform mat4 uInvVP;',
  'uniform mat4 uPrevVP;',
  'uniform float uHistoryValid;',
  'uniform float uFeedback;',
  'uniform float uHistoryMax;',
  'uniform float uHistoryMin;',
  'uniform float uVarGamma;',
  'uniform float uNear;',
  'uniform float uFar;',
  'varying vec2 vUv;',
  '',
  'float lanczos2(float d) {',
  '  float t = clamp(abs(d) * 0.5, 0.0, 1.0);',
  '  return max(texture2D(tLut, vec2(t, 0.5)).r * 1.25 - 0.25, 0.0);',
  '}',
  'vec3 toYCoCg(vec3 c) {',
  '  return vec3(dot(c, vec3(0.25, 0.5, 0.25)), 0.5 * (c.r - c.b), dot(c, vec3(-0.25, 0.5, -0.25)));',
  '}',
  'vec3 toRGB(vec3 y) {',
  '  return vec3(y.x + y.y - y.z, y.x + y.z, y.x - y.y - y.z);',
  '}',
  '',
  'void main() {',
  '  // 本帧渲染样本 i 在显示网格中的位置 = (i + 0.5 + jitter) / scale。',
  '  // 反解出显示像素对应的渲染像素坐标；投影矩阵那侧改的是 e[8]/e[9]，符号与这里一致。',
  '  vec2 src = vUv * uRenderSize - 0.5 - uJitter;',
  '  vec2 base = floor(src);',
  '  vec2 f = src - base;',
  '  float wx0 = lanczos2(f.x + 0.5);',
  '  float wx1 = lanczos2(f.x - 0.5);',
  '  float wx2 = lanczos2(f.x - 1.5);',
  '  float wy0 = lanczos2(f.y + 0.5);',
  '  float wy1 = lanczos2(f.y - 0.5);',
  '  float wy2 = lanczos2(f.y - 1.5);',
  '  vec2 centerUv = clamp((base + 0.5) * uInvRenderSize, uInvRenderSize * 0.5, 1.0 - uInvRenderSize * 0.5);',
  '  float centerD = texture2D(tDepth, centerUv).r;',
  '',
  '  vec3 acc = vec3(0.0);',
  '  float wsum = 0.0;',
  '  vec3 mn = vec3(1e6), mx = vec3(-1e6);',
  '  vec3 sumY = vec3(0.0), sumY2 = vec3(0.0);',
  '  for (int j = 0; j < 3; j++) {',
  '    for (int i = 0; i < 3; i++) {',
  '      float wi = (i == 0) ? wx0 : ((i == 1) ? wx1 : wx2);',
  '      float wj = (j == 0) ? wy0 : ((j == 1) ? wy1 : wy2);',
  '      vec2 q = base + vec2(float(i) - 1.0, float(j) - 1.0) + 0.5;',
  '      vec2 uv = clamp(q * uInvRenderSize, uInvRenderSize * 0.5, 1.0 - uInvRenderSize * 0.5);',
  '      vec3 c = texture2D(tColor, uv).rgb;',
  '      float w = max(wi * wj, 0.0);',
  '      acc += c * w;',
  '      wsum += w;',
  '      mn = min(mn, c);',
  '      mx = max(mx, c);',
  '      vec3 y = toYCoCg(c);',
  '      sumY += y;',
  '      sumY2 += y * y;',
  '    }',
  '  }',
  '  vec3 cur = (wsum > 1e-5) ? (acc / wsum) : texture2D(tColor, centerUv).rgb;',
  '  cur = clamp(cur, mn, mx); // anti-ringing：Lanczos 负瓣不允许越过邻域极值',
  '',
  '  // 线性视深 + sqrt 编码：8bit alpha 也能分辨近处 (1m/500m 直接存会被量化成 0)',
  '  float linZ = (uNear * uFar) / max(uFar - (uFar - uNear) * centerD, 1e-4);',
  '  float curA = sqrt(clamp(linZ / uFar, 0.0, 1.0));',
  '',
  '  // 第一帧 / 重投影落到屏幕外 / 相机瞬移：完全不碰未初始化的历史图，',
  '  // 否则 0 * NaN 还是 NaN，整屏会花（记忆里那条 NaN 静默失效）。',
  '  // clip.xy 必须用「显示像素」的 NDC：重投影出来的是显示分辨率历史图上的 uv。',
  '  // 若误用渲染像素中心 centerUv，静止画面 puv 会被量化到低分辨率网格（最多差 1 个显示像素），',
  '  // 历史每天被平移一次 → 越积越糊。深度仍取最近渲染像素，误差只在边缘，属保守。',
  '  vec4 clip = vec4(vUv * 2.0 - 1.0, centerD * 2.0 - 1.0, 1.0);',
  '  vec4 wp = uInvVP * clip;',
  '  wp /= wp.w;',
  '  vec4 pc = uPrevVP * vec4(wp.xyz, 1.0);',
  '  float behind = step(1e-4, pc.w);',
  '  vec2 puv = pc.xy / max(pc.w, 1e-4) * 0.5 + 0.5;',
  '  // 深度为 1 = 没写入几何（天空/背景）。它们跟随相机、没有真实距离，',
  '  // 按 far 平面反投影会在相机平移时算出假视差 → 天空拖影。强制原地累积。',
  '  float isFar = step(0.9999, centerD);',
  '  puv = mix(puv, vUv, isFar);',
  '  float inside = behind * step(0.0, puv.x) * step(puv.x, 1.0) * step(0.0, puv.y) * step(puv.y, 1.0);',
  '  inside = mix(inside, 1.0, isFar);',
  '  if (uHistoryValid < 0.5 || inside < 0.5) {',
  '    gl_FragColor = vec4(cur, curA);',
  '    return;',
  '  }',
  '',
  '  vec4 h = texture2D(tHistory, puv);',
  '  vec3 mu = sumY / 9.0;',
  '  vec3 sigma = sqrt(max(sumY2 / 9.0 - mu * mu, vec3(0.0)));',
  // ⚠⚠ 这里曾把「sigma AABB」与「当前帧 3x3 min/max」取**交集**，等于双重限幅：
  //   平坦区 sigma≈0 → AABB 塌成一个点 → 上一帧里由别的 jitter 相位采到的亚像素细节
  //   全部被裁掉，历史等于没存进新信息，TSR 退化成「单帧 Lanczos + 锐化」。
  //   标准 TSR/FSR2 的 variance clipping 只用 mu±γσ（或只用 neighborhood min/max），
  //   不能两者取交集。这里改取**并集**：至少不比当前帧邻域范围更窄。
  '  vec3 mnY = toYCoCg(mn) - 0.02;',
  '  vec3 mxY = toYCoCg(mx) + 0.02;',
  '  vec3 loY = min(mnY, mu - uVarGamma * sigma);',
  '  vec3 hiY = max(mxY, mu + uVarGamma * sigma);',
  '  vec3 hY = toYCoCg(h.rgb);',
  '  vec3 cY = clamp(hY, loY, hiY); // variance clipping：只压明显脱离邻域的鬼影',
  '  vec3 histClipped = toRGB(cY);',
  // 置信度过严也会把历史整体丢弃：旧版 length*3 + 下限 0.08、深度 0.018~0.09，
  // 相机一动（重投影双线性 + 8bit alpha）大量像素 a<0.1 → 又变回单帧上采样。
  '  float colorConf = clamp(1.0 - length(hY - cY) * 1.5, 0.0, 1.0);',
  '  float depthConf = 1.0 - smoothstep(0.035, 0.16, abs(curA - h.a));',
  // uFeedback 由 JS 按累积帧数与相机运动算好（静止几帧就拉到 HISTORY_MAX，
  // 运动时降到 MOTION_FEEDBACK），这里只夹到 [HistoryMin, HistoryMax] 护栏内。
  '  float fb = clamp(uFeedback, uHistoryMin, uHistoryMax);',
  '  float a = fb * max(colorConf, 0.35) * max(depthConf, 0.4);',
  '  gl_FragColor = vec4(mix(cur, histClipped, a), curA);',
  '}',
].join('\n');

export class TemporalUpscale {
  // WebGL2 才有可靠的 DEPTH_COMPONENT24 深度纹理；WebGL1 一律退回单 pass CAS。
  static supported(renderer) {
    try {
      const gl = renderer && renderer.getContext ? renderer.getContext() : null;
      return !!(gl && renderer.capabilities && renderer.capabilities.isWebGL2);
    } catch (e) {
      console.warn('[TSR] 能力检测失败，退回单 pass 锐化:', e);
      return false;
    }
  }

  constructor(renderer) {
    this.renderer = renderer;
    this.failed = false;
    this.sceneRT = null;       // 主场景低分辨率 RT，带可读 depthTexture
    this.hist = [null, null];  // 显示分辨率历史图，ping-pong
    this.histIdx = 0;          // 指向「下一帧要读」的那张
    this.renderW = 2;
    this.renderH = 2;
    this.displayW = 2;
    this.displayH = 2;
    this._hasHistory = false;
    this._seq = 0;
    this._phases = 8;
    this._accum = 0;            // 连续有效累积帧数（驱动反馈权重快速爬升）
    this._motion = 1;           // 平滑后的相机运动量，0=完全静止，1=明显在动
    this._feedback = Config.TSR_FEEDBACK_MIN || 0.3;
    this._jitterApplied = false;
    this._hasCam = false;

    this._scene = null;
    this._cam = null;
    this._mat = null;
    this._quad = null;
    this._lut = null;

    this._curVP = new THREE.Matrix4();   // 当前帧「未抖动」VP（重投影基准）
    this._prevVP = new THREE.Matrix4();  // 上一帧「未抖动」VP
    this._savedProj = new THREE.Matrix4();
    this._savedProjInv = new THREE.Matrix4();
    this._jitter = new THREE.Vector2();
    this._prevPos = new THREE.Vector3();
    this._prevQuat = new THREE.Quaternion();
    this._tmpPos = new THREE.Vector3();
    this._tmpQuat = new THREE.Quaternion();
  }

  // 历史图（显示分辨率）的当前可读纹理；present pass 拿它做 RCAS。
  get historyTexture() {
    const t = this.hist[this.histIdx];
    return t ? t.texture : null;
  }

  /** 连续有效累积帧数（HUD 诊断用：静止时应稳定涨到 60+）。 */
  get accumFrames() { return this._accum; }

  /** 当前帧历史反馈权重（HUD 诊断用）。 */
  get feedback() { return this._feedback; }

  // 尺寸/格式变化时重建全部 RT 并清历史。调用频率：每帧一次，尺寸没变时是几个整数比较。
  ensure(rw, rh, dw, dh, type) {
    if (this.failed) return false;
    rw = Math.max(2, Math.floor(rw));
    rh = Math.max(2, Math.floor(rh));
    dw = Math.max(2, Math.floor(dw));
    dh = Math.max(2, Math.floor(dh));
    // ⚠ 8bit RT 存的是**线性**色：1/255 ≈ 0.0039 的量化步长，正好和相邻 jitter 相位
    //   之间的颜色差同量级 → 写进历史图时细节被量化抹平，多帧累积等于白做。
    //   TSR 路径（sceneRT + 2 张历史图）一律 HalfFloat；单 pass CAS 路径仍可用 8bit 省带宽。
    if (Config.TSR_HDR_RT) type = THREE.HalfFloatType;
    const same = this.sceneRT && this.hist[0] && this.hist[1]
      && this.renderW === rw && this.renderH === rh
      && this.displayW === dw && this.displayH === dh
      && this.sceneRT.texture.type === type;
    if (same) return true;
    try {
      this._disposeTargets();
      this.renderW = rw;
      this.renderH = rh;
      this.displayW = dw;
      this.displayH = dh;

      const depth = new THREE.DepthTexture(rw, rh, THREE.UnsignedIntType);
      depth.format = THREE.DepthFormat;
      depth.minFilter = THREE.NearestFilter;
      depth.magFilter = THREE.NearestFilter;
      depth.generateMipmaps = false;
      this.sceneRT = new THREE.WebGLRenderTarget(rw, rh, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        type,
        depthTexture: depth,
        depthBuffer: true,
        stencilBuffer: false,
        // MSAA 与 depthTexture 不能共存，且降分辨率时 MSAA 本来就是纯填充开销。
        samples: 0,
      });
      this.sceneRT.texture.generateMipmaps = false;

      for (let i = 0; i < 2; i++) {
        const rt = new THREE.WebGLRenderTarget(dw, dh, {
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
          type,
          depthBuffer: false,
          stencilBuffer: false,
          samples: 0,
        });
        rt.texture.generateMipmaps = false;
        this.hist[i] = rt;
      }
      this._ensurePass();
      this.reset();
      return true;
    } catch (e) {
      console.warn('[TSR] 渲染目标创建失败，退回单 pass 锐化:', e);
      this.failed = true;
      this._disposeTargets();
      return false;
    }
  }

  _ensurePass() {
    if (this._mat) return;
    const N = 256;
    const data = new Uint8Array(N * 4);
    for (let i = 0; i < N; i++) {
      const v = lanczos2((i / (N - 1)) * 2);
      const enc = Math.round(((Math.max(-0.25, Math.min(1, v)) + 0.25) / 1.25) * 255);
      data[i * 4] = enc;
      data[i * 4 + 1] = enc;
      data[i * 4 + 2] = enc;
      data[i * 4 + 3] = 255;
    }
    this._lut = new THREE.DataTexture(data, N, 1, THREE.RGBAFormat);
    this._lut.minFilter = THREE.LinearFilter;
    this._lut.magFilter = THREE.LinearFilter;
    this._lut.wrapS = THREE.ClampToEdgeWrapping;
    this._lut.wrapT = THREE.ClampToEdgeWrapping;
    this._lut.generateMipmaps = false;
    this._lut.needsUpdate = true;

    this._mat = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: null },
        tDepth: { value: null },
        tHistory: { value: null },
        tLut: { value: this._lut },
        uRenderSize: { value: new THREE.Vector2(this.renderW, this.renderH) },
        uInvRenderSize: { value: new THREE.Vector2(1 / this.renderW, 1 / this.renderH) },
        uJitter: { value: new THREE.Vector2() },
        uInvVP: { value: new THREE.Matrix4() },
        uPrevVP: { value: new THREE.Matrix4() },
        uHistoryValid: { value: 0 },
        uFeedback: { value: this._feedback },
        uHistoryMax: { value: Config.TSR_HISTORY_MAX },
        uHistoryMin: { value: Config.TSR_FEEDBACK_MIN || 0.3 },
        uVarGamma: { value: Config.TSR_VAR_GAMMA },
        uNear: { value: 0.1 },
        uFar: { value: 500 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._mat);
    this._quad.frustumCulled = false;
    this._scene = new THREE.Scene();
    this._scene.add(this._quad);
    this._cam = new THREE.Camera();
  }

  // 加载期把 resolve 程序编掉，避免游戏中第一次触发时单帧卡顿。
  precompile(renderer) {
    if (this.failed || !this._scene) return;
    try {
      if (typeof renderer.compile === 'function') renderer.compile(this._scene, this._cam);
    } catch (e) {
      console.warn('[TSR] 预热编译失败（忽略，运行时再编译）:', e);
    }
  }

  // 每帧渲染主场景前调用：记录干净 VP、检测相机跳变、应用亚像素抖动。
  // 返回 Vector2（单位=渲染像素，范围 [-0.5,0.5)）；失败返回 null，调用方退回 CAS。
  beginFrame(camera) {
    if (this.failed || !this.sceneRT) return null;
    try {
      camera.updateMatrixWorld();
      camera.getWorldPosition(this._tmpPos);
      camera.getWorldQuaternion(this._tmpQuat);
      // 相机运动量：位移 0.15m/帧 或转角约 3.6°/帧 视为「明显在动」。
      // 重投影在运动时误差大（双线性采样 + 无 velocity buffer），反馈要降下来防拖影。
      let motion = 1;
      if (this._hasCam) {
        const dist = this._prevPos.distanceTo(this._tmpPos);
        const spin = 1 - Math.abs(this._prevQuat.dot(this._tmpQuat));
        const jump = dist > (Config.TSR_RESET_DIST || 30);
        // dot 是 cos(半角)；0.25 对应约 151 度，正常甩鼠标不会误判。
        const snap = spin > 0.75;
        if (jump || snap) this.reset();
        motion = Math.min(1, dist / 0.15 + spin / 0.002);
      }
      this._prevPos.copy(this._tmpPos);
      this._prevQuat.copy(this._tmpQuat);
      this._hasCam = true;
      // 反馈权重自加速：旧版固定 0.88 → 每帧新样本只占 12%，要 ~30 帧才收敛，
      // 走动一次又清零，玩家根本等不到「变清楚」的那一刻。
      // 现在按累积帧数 n/(n+1) 起步（0.5→0.67→0.75→0.83→…），静止 3~5 帧即见效。
      this._motion = this._motion * 0.5 + motion * 0.5;
      this._accum = Math.min(64, this._accum + 1);
      const ramp = this._accum / (this._accum + 1);
      const stillFb = Math.min(Config.TSR_HISTORY_MAX, Math.max(ramp, 0.5));
      const movFb = Config.TSR_MOTION_FEEDBACK || 0.62;
      this._feedback = Math.max(Config.TSR_FEEDBACK_MIN || 0.3,
        movFb + (stillFb - movFb) * (1 - this._motion));

      // 重投影必须使用「消掉 jitter」的 VP：否则静止画面也会因相位变化被反复重采样，
      // 累积永远收敛不了（等于自己把超采样打散）。
      this._curVP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

      const scale = Math.min(1, this.renderW / Math.max(2, this.displayW));
      this._phases = Math.max(8, Math.ceil(8 / Math.max(0.0625, scale * scale)));
      const seq = (this._seq % this._phases) + 1;
      this._seq++;
      let jx = halton(seq, 2) - 0.5;
      let jy = halton(seq, 3) - 0.5;
      // FSR2 要求抖动序列不产生零向量，否则该帧与上一帧完全同相位。
      if (Math.abs(jx) < 1e-4 && Math.abs(jy) < 1e-4) jx = 0.25;

      this._savedProj.copy(camera.projectionMatrix);
      this._savedProjInv.copy(camera.projectionMatrixInverse);
      const e = camera.projectionMatrix.elements;
      // makePerspective 的 e[8]/e[9] 是 NDC 平移量；+2*j/w 等价于内容平移 -j 个渲染像素。
      e[8] += (2 * jx) / this.renderW;
      e[9] += (2 * jy) / this.renderH;
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
      this._jitter.set(jx, jy);
      this._jitterApplied = true;
      return this._jitter;
    } catch (e) {
      console.warn('[TSR] 抖动应用失败，退回单 pass 锐化:', e);
      this.failed = true;
      this.endFrame(camera);
      return null;
    }
  }

  // 渲染主场景后立刻恢复：交互/射线检测看到的永远是干净投影矩阵。
  endFrame(camera) {
    if (!this._jitterApplied) return;
    this._jitterApplied = false;
    camera.projectionMatrix.copy(this._savedProj);
    camera.projectionMatrixInverse.copy(this._savedProjInv);
  }

  // 把当前帧样本汇入历史（写显示分辨率 RT）。成功返回 true。
  resolve(renderer, camera, jitter) {
    if (this.failed || !this.sceneRT || !this._mat || !jitter) return false;
    const read = this.hist[this.histIdx];
    const write = this.hist[1 - this.histIdx];
    if (!read || !write) return false;
    try {
      const u = this._mat.uniforms;
      u.tColor.value = this.sceneRT.texture;
      u.tDepth.value = this.sceneRT.depthTexture;
      u.tHistory.value = read.texture;
      u.uRenderSize.value.set(this.renderW, this.renderH);
      u.uInvRenderSize.value.set(1 / this.renderW, 1 / this.renderH);
      u.uJitter.value.copy(jitter);
      u.uInvVP.value.copy(this._curVP).invert();
      u.uPrevVP.value.copy(this._prevVP);
      u.uHistoryValid.value = this._hasHistory ? 1 : 0;
      u.uFeedback.value = this._feedback;
      u.uNear.value = camera.near;
      u.uFar.value = camera.far;
      renderer.setRenderTarget(write);
      renderer.render(this._scene, this._cam);
      renderer.setRenderTarget(null);
      this._prevVP.copy(this._curVP);
      this._hasHistory = true;
      this.histIdx = 1 - this.histIdx;
      return true;
    } catch (e) {
      console.warn('[TSR] 时域累积失败，退回单 pass 锐化:', e);
      this.failed = true;
      try { renderer.setRenderTarget(null); } catch (e2) { console.warn('[TSR] 恢复渲染目标失败:', e2); }
      return false;
    }
  }

  // 任何「画面不连续」的事件都要清：瞬移/重生/换房、分辨率变化、resize、开关切换。
  reset() {
    this._hasHistory = false;
    this._seq = 0;
    this._hasCam = false;
    this._accum = 0;
    this._motion = 1;
    this._feedback = Config.TSR_FEEDBACK_MIN || 0.3;
  }

  _disposeTargets() {
    for (const rt of [this.sceneRT, this.hist[0], this.hist[1]]) {
      if (!rt) continue;
      try {
        if (rt.depthTexture) rt.depthTexture.dispose();
        rt.dispose();
      } catch (e) {
        console.warn('[TSR] 释放渲染目标失败:', e);
      }
    }
    this.sceneRT = null;
    this.hist[0] = null;
    this.hist[1] = null;
  }

  dispose() {
    this._disposeTargets();
    if (this._quad) {
      try { this._quad.geometry.dispose(); } catch (e) { console.warn('[TSR] 释放 quad 失败:', e); }
      this._quad = null;
    }
    if (this._mat) {
      try { this._mat.dispose(); } catch (e) { console.warn('[TSR] 释放材质失败:', e); }
      this._mat = null;
    }
    if (this._lut) {
      try { this._lut.dispose(); } catch (e) { console.warn('[TSR] 释放 LUT 失败:', e); }
      this._lut = null;
    }
    this._scene = null;
    this._cam = null;
  }
}
