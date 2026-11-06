// 职责：只给「人物」做实时几何阴影，静态世界仍走 ShadowBaker 的烘焙图（永不重渲）。
//
// 为什么单独一趟：真实 shadow map 是每盏灯一张，重渲就是整世界所有 caster 重画一遍，
// 这正是本项目像素/填充率的最大头。这里把问题降维成：
//   ① 只有人物（本地代理 + 远端模型）挂到 LAYER_CHAR_SHADOW 层；
//   ② 一台正交相机沿太阳方向只渲这一层 → 256² RT，无 PBR / 无阴影采样 / 无天空；
//   ③ 一个贴地 quad 用投影纹理采样这张 RT，把人物轮廓按真实太阳方向投到地面。
// 成本 = 1 张小 RT + 1 趟纯几何 pass + 1 个全透明 quad，与全场景 shadow pass 差两个数量级。
// 静态建筑影仍由 sun.shadow.map（烘焙图）负责，两者互不干扰、可叠加。
//
// kill-switch：Config.CHAR_SHADOW_ENABLED = 0，或 URL ?charshadow=0。
import * as THREE from 'three';
import { Config } from '../config.js';

// 用第 2 层：第 0 层是主相机/环境光，第 1 层是太阳动态光照（Lights.LAYER_DYNAMIC），别撞。
export const LAYER_CHAR_SHADOW = 2;

function enabled() {
  if (!Config.CHAR_SHADOW_ENABLED) return false;
  try {
    if (typeof location !== 'undefined' &&
        new URLSearchParams(location.search).get('charshadow') === '0') return false;
  } catch (e) { /* 非浏览器环境忽略 */ }
  return true;
}

export class RealCharShadow {
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;
    this.on = enabled();
    this.failed = false;
    this.size = Config.CHAR_SHADOW_SIZE || 256;
    this.range = Config.CHAR_SHADOW_RANGE || 9;
    this.opacity = Config.CHAR_SHADOW_OPACITY != null ? Config.CHAR_SHADOW_OPACITY : 0.34;

    this.rt = null;
    this.cam = null;
    this.black = null;
    this.quad = null;
    this.proxy = null;
    this._roots = new Set();
    this._vp = new THREE.Matrix4();
    this._dir = new THREE.Vector3(0.5, 1, 0.35).normalize();
    this._prevColor = new THREE.Color();
  }

  _init() {
    if (this.failed || !this.on) return false;
    try {
      this.rt = new THREE.WebGLRenderTarget(this.size, this.size, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        depthBuffer: true,
        stencilBuffer: false,
      });
      this.rt.texture.generateMipmaps = false;

      const R = this.range;
      this.cam = new THREE.OrthographicCamera(-R, R, R, -R, 0.1, R * 8);
      this.cam.layers.set(LAYER_CHAR_SHADOW); // 只渲人物层，整世界一律不进这一趟

      // 覆盖材质：黑色、双面、不受雾影响。skinning 由 object.isSkinnedMesh 决定，
      // 与材质无关，所以 SkinnedMesh 的骨骼变形在这一趟照样生效。
      this.black = new THREE.MeshBasicMaterial({
        color: 0x000000, side: THREE.DoubleSide, fog: false, toneMapped: false,
      });

      // 地面投影 quad：顶点给世界坐标，片元用「太阳相机的 VP」把地面点投回阴影 RT。
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          tShadow: { value: this.rt.texture },
          uVP: { value: this._vp },
          uOpacity: { value: this.opacity },
        },
        vertexShader:
          'varying vec3 vW;\n' +
          'void main() {\n' +
          '  vec4 w = modelMatrix * vec4(position, 1.0);\n' +
          '  vW = w.xyz;\n' +
          '  gl_Position = projectionMatrix * viewMatrix * w;\n' +
          '}\n',
        fragmentShader:
          'uniform sampler2D tShadow;\n' +
          'uniform mat4 uVP;\n' +
          'uniform float uOpacity;\n' +
          'varying vec3 vW;\n' +
          'void main() {\n' +
          '  vec4 p = uVP * vec4(vW, 1.0);\n' +
          '  vec2 uv = p.xy / p.w * 0.5 + 0.5;\n' +
          '  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;\n' +
          '  float a = texture2D(tShadow, uv).a;\n' +
          '  if (a <= 0.002) discard;\n' +
          '  gl_FragColor = vec4(0.0, 0.0, 0.0, a * uOpacity);\n' +
          '}\n',
        transparent: true,
        depthWrite: false,
        depthTest: true,
      });
      const geo = new THREE.PlaneGeometry(R * 2, R * 2);
      this.quad = new THREE.Mesh(geo, mat);
      this.quad.rotation.x = -Math.PI / 2;
      this.quad.position.y = 0.035; // 略高于地面，防 z-fighting；仍受 depthTest 遮挡
      this.quad.renderOrder = 2;
      this.quad.frustumCulled = false;
      this.quad.layers.set(0); // 主相机可见，阴影相机（只看层 2）看不到它
      this.scene.add(this.quad);

      // 本地玩家第一人称模型是 visible=false（不进任何 pass），用一个只有层 2 的
      // 简化人形代理投出自己的影子：主相机看不到它，不改动既有可见性/动画逻辑。
      const pg = new THREE.CapsuleGeometry(0.32, 1.0, 4, 8);
      this.proxy = new THREE.Mesh(pg, new THREE.MeshBasicMaterial());
      this.proxy.layers.set(LAYER_CHAR_SHADOW);
      this.proxy.frustumCulled = false;
      this.scene.add(this.proxy);

      // 加载期先空渲一趟：把黑材质与投影 quad 的 shader 编掉，避免游戏中首帧编译卡顿。
      this._dir.copy(new THREE.Vector3(0.5, 1, 0.35)).normalize();
      const wd = this.range * 3;
      this.cam.position.set(this._dir.x * wd, this._dir.y * wd, this._dir.z * wd);
      this.cam.lookAt(0, 0, 0);
      this.cam.updateMatrixWorld(true);
      this._vp.multiplyMatrices(this.cam.projectionMatrix, this.cam.matrixWorldInverse);
      this._renderPass();
      return !this.failed;
    } catch (e) {
      this.failed = true;
      console.warn('[RealCharShadow] 初始化失败，退回 FakeShadow:', e);
      this.dispose();
      return false;
    }
  }

  // 远端玩家模型：整棵子树挂上层 2。异步加载进来的子网格每次 update 会补挂。
  _mark(obj) {
    obj.traverse((o) => {
      if (!o.layers || !o.isMesh) return; // Sprite / Line 一律排除
      if (o.userData && (o.userData.fakeShadow || o.userData.isHpBar)) return;
      o.layers.enable(LAYER_CHAR_SHADOW);
    });
  }

  registerModel(model) {
    if (!model || this.failed || !this.on) return;
    this._roots.add(model);
    this._mark(model);
  }

  // 每帧：注册新玩家 → 摆太阳相机 → 渲人物 RT → 更新投影矩阵与地面 quad。
  // pm: PlayerManager（用它的 players 拿远端模型，避免改 PlayerManager 的依赖）
  // state: 本地 PlayerState；sunOffset: 太阳方向（从地面指向太阳）
  update(pm, state, sunOffset) {
    if (!this.on || this.failed) return;
    if (!this.rt && !this._init()) return;
    const r = this.renderer;
    const sc = this.scene;
    if (!r || !sc || !state) return;

    // ① 登记人物层（远端模型可能异步换了子网格，补挂一次，幂等且很便宜）
    if (pm && pm.players) {
      for (const model of this._iterModels(pm)) {
        if (!this._roots.has(model)) this.registerModel(model);
        else this._mark(model);
      }
    }

    // ② 本地代理跟随玩家（state.y 是头顶/相机高度，模型原点在脚底）
    const s = state.size || 1;
    const feet = (Number.isFinite(state.y) ? state.y : Config.PLAYER_HEIGHT) - Config.PLAYER_HEIGHT * s;
    this.proxy.position.set(state.x, feet + 0.82 * s, state.z);
    this.proxy.rotation.y = state.yaw || 0;
    this.proxy.scale.setScalar(s);

    // ③ 太阳相机：从太阳方向看向玩家，正交范围只覆盖玩家附近 range 米
    if (sunOffset && Number.isFinite(sunOffset.x + sunOffset.y + sunOffset.z)) {
      this._dir.copy(sunOffset).normalize();
    }
    const cx = state.x, cz = state.z;
    const dist = this.range * 3;
    this.cam.position.set(cx + this._dir.x * dist, this._dir.y * dist, cz + this._dir.z * dist);
    this.cam.lookAt(cx, 0, cz);
    this.cam.updateMatrixWorld(true);
    this._vp.multiplyMatrices(this.cam.projectionMatrix, this.cam.matrixWorldInverse);

    this.quad.position.x = cx;
    this.quad.position.z = cz;

    // ④ 只渲人物：临时关背景（天空会覆盖 alpha）、换黑材质、清成透明
    this._renderPass();
  }

  _renderPass() {
    const r = this.renderer;
    const sc = this.scene;
    if (!r || !sc || !this.rt) return;
    const prevTarget = r.getRenderTarget();
    const prevBg = sc.background;
    const prevOverride = sc.overrideMaterial;
    const prevAlpha = r.getClearAlpha();
    const prevAuto = r.shadowMap.autoUpdate;
    const prevNeeds = r.shadowMap.needsUpdate;
    r.getClearColor(this._prevColor);
    const prevColor = this._prevColor.clone();
    try {
      sc.background = null;
      sc.overrideMaterial = this.black;
      r.shadowMap.autoUpdate = false;
      r.shadowMap.needsUpdate = false;
      r.setClearColor(0x000000, 0);
      r.setRenderTarget(this.rt);
      r.clear();
      r.render(sc, this.cam);
    } catch (e) {
      this.failed = true;
      console.warn('[RealCharShadow] 渲染失败，退回 FakeShadow:', e);
      if (this.quad) this.quad.visible = false;
    } finally {
      sc.background = prevBg;
      sc.overrideMaterial = prevOverride;
      r.shadowMap.autoUpdate = prevAuto;
      r.shadowMap.needsUpdate = prevNeeds;
      r.setClearColor(prevColor, prevAlpha);
      r.setRenderTarget(prevTarget);
    }
  }

  *_iterModels(pm) {
    for (const [id, rp] of pm.players) {
      if (id === pm.localId) continue; // 本地模型隐藏，走代理
      if (rp && rp.model) yield rp.model;
    }
  }

  dispose() {
    try { if (this.rt) this.rt.dispose(); } catch (e) { /* 忽略 */ }
    if (this.quad) { this.scene.remove(this.quad); this.quad.geometry.dispose(); this.quad.material.dispose(); }
    if (this.proxy) { this.scene.remove(this.proxy); this.proxy.geometry.dispose(); this.proxy.material.dispose(); }
    if (this.black) this.black.dispose();
    this.rt = null; this.quad = null; this.proxy = null; this.black = null;
  }
}
