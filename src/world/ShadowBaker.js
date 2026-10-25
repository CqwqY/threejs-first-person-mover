// 四时段整世界阴影烘焙（重做版，替代旧 LightBaker 的逐网格 UV 光照图方案——那个跑不出来）。
//
// 原理：加载完成后，把 4 个时段的太阳方向各渲染一次「覆盖整个世界」的阴影贴图
// （GPU shadow pass，直接渲进我们预建的 4 张 RT），把每张的 shadow.matrix 快照下来。
// 运行时按时段切换 sun.shadow.map + sun.shadow.matrix —— 换图即可，**永不重渲**：
// renderer.shadowMap.needsUpdate 不再置位 ⇒ 整个 shadow pass 被跳过（这是填充率大头），
// 而建筑/景物的影子全部保留、方向按 4 时段稳定不漂移。
//
// 为什么整世界可行：阴影相机改成覆盖全图的固定正交体（不再跟随玩家），
// 矩阵是世界→UV 的固定映射，玩家走到哪影子都在。代价是 texel 变大（~17cm @2048），
// 换来的是零重渲 + 全域有效。
//
// 动态体处理：烘焙期间只保留「静态根」（景物 roots + 编辑器建筑 holders）的原有投影开关，
// 其余网格（玩家/掉落物/载具/道具）castShadow 临时关掉 —— 不把会动的东西烤死在图里。
// 玩家/商人/Boss/载具本来就挂 FakeShadow 假阴影斑，烘焙后观感几乎无损。
//
// kill-switch：URL 带 ?bake=0（Lights.bakeFeatureEnabled）时不烘焙，退回实时阴影。
import * as THREE from 'three';

// 与 ui/SettingsPanel.computeSunOffset 同一套球面公式（归一化成纯方向，长度烘焙时另定）
function sunDir(elev, az) {
  const e = (elev * Math.PI) / 180;
  const a = (az * Math.PI) / 180;
  return new THREE.Vector3(
    Math.cos(e) * Math.sin(a),
    Math.sin(e),
    Math.cos(e) * Math.cos(a)
  ).normalize();
}

export class ShadowBaker {
  constructor() {
    this.rts = [];       // phase → WebGLRenderTarget（three 阴影 pass 直接渲进它）
    this.mats = [];      // phase → shadow.matrix 快照（bias*proj*view，运行时整块换上）
    this.size = 2048;    // 每张整世界阴影图边长（4 张 RGBA8 ≈ 64MB VRAM）
    this.ready = false;
    this.failed = false;
  }

  // opts: { renderer, scene, camera, sun, sunTarget, phases:[{elev,az}], bounds, staticRoots, maxY? }
  bake(opts) {
    const o = opts || {};
    if (this.ready || this.failed) return this.ready;
    try {
      const renderer = o.renderer;
      const sun = o.sun;
      const sunTarget = o.sunTarget;
      const phases = o.phases || [];
      if (!renderer || !sun || !sunTarget || !sun.castShadow || !renderer.shadowMap.enabled) return false;
      if (!phases.length) return false;

      const b = o.bounds || { minX: -180, maxX: 180, minZ: -200, maxZ: 200 };
      const cx = (b.minX + b.maxX) / 2;
      const cz = (b.minZ + b.maxZ) / 2;
      const half = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) / 2 + 24; // 留边防裁
      const maxY = o.maxY || 80;
      const maxTex = renderer.capabilities.maxTextureSize || 2048;
      const size = Math.min(this.size, maxTex);
      this.size = size;

      // ① 静态根打标 → 全场景网格按标记关掉动态体投影（静态体保留各自原有开关）
      for (const r of o.staticRoots || []) {
        r.traverse((m) => { if (m.isMesh) m.userData.__staticCaster = true; });
      }
      const saved = [];
      scene.traverse((m) => {
        if (!m.isMesh) return;
        saved.push([m, m.castShadow]);
        if (m.userData.__staticCaster !== true) m.castShadow = false;
      });

      // ② 建 4 张 RT（RGBA8 深度打包，与 three 阴影 pass 输出一致；重烘焙先清旧的防泄漏）
      for (const rt of this.rts) rt.dispose();
      this.rts = [];
      for (let i = 0; i < phases.length; i++) {
        const rt = new THREE.WebGLRenderTarget(size, size, {
          minFilter: THREE.NearestFilter,
          magFilter: THREE.NearestFilter,
          format: THREE.RGBAFormat,
          depthBuffer: true,
          stencilBuffer: false,
        });
        rt.texture.generateMipmaps = false;
        this.rts.push(rt);
      }

      const cam = sun.shadow.camera;
      const prevTarget = sunTarget.position.clone();
      const prevSunPos = sun.position.clone();
      const prevBias = sun.shadow.bias;

      try {
        // ③ 逐相位渲染 shadow pass（方向与 Game._updateDayNight 的相位偏移同源）
        this.mats = [];
        const dist = half * 2 + maxY + 80; // 光源拉远：方向不变，保证全图都在 near/far 内
        const texel = (2 * half) / size;
        for (let p = 0; p < phases.length; p++) {
          const dir = sunDir(phases[p].elev, phases[p].az);
          sunTarget.position.set(cx, 0, cz);
          sunTarget.updateMatrixWorld();
          sun.position.copy(sunTarget.position).addScaledVector(dir, dist);
          cam.left = -half;
          cam.right = half;
          cam.top = half;
          cam.bottom = -half;
          cam.near = 1;
          cam.far = dist + maxY + 80;
          cam.updateProjectionMatrix();
          // 大 texel 需要更大 normalBias 压 acne（旧 follow 相机 texel ~6cm / normalBias 1.0）
          sun.shadow.normalBias = Math.max(1.0, texel * 1.5);
          sun.shadow.map = this.rts[p];
          renderer.shadowMap.needsUpdate = true;
          renderer.render(scene, o.camera);
          this.mats.push(sun.shadow.matrix.clone());
        }
      } finally {
        // 无论成败都归还现场：动态体投影开关 / 灯光位置（bias/normalBias 在成功路径上保留烘焙值）
        for (const [m, v] of saved) {
          m.castShadow = v;
          delete m.userData.__staticCaster;
        }
        sunTarget.position.copy(prevTarget);
        sunTarget.updateMatrixWorld();
        sun.position.copy(prevSunPos);
      }

      // ④ 收尾：切到相位 0；相机保持「整世界」配置（万一被手动重渲也仍然全域有效）；
      //    normalBias 保留烘焙值（采样时用的就是它，必须和贴图 texel 匹配）
      sun.shadow.map = this.rts[0];
      sun.shadow.matrix.copy(this.mats[0]);
      renderer.shadowMap.autoUpdate = false;
      renderer.shadowMap.needsUpdate = false;
      sun.shadow.bias = prevBias;
      this.ready = true;
      return true;
    } catch (e) {
      this.failed = true;
      for (const rt of this.rts) { try { rt.dispose(); } catch (_) { /* 忽略 */ } }
      this.rts = [];
      this.mats = [];
      console.warn('[ShadowBaker] 烘焙失败，退回实时阴影:', e);
      return false;
    }
  }

  // 运行时切相位：换贴图 + 换矩阵（光照方向/强度仍由昼夜系统管，互不干扰）
  apply(sun, phaseIdx) {
    if (!this.ready || !sun || !this.rts.length) return false;
    const i = Math.max(0, Math.min(this.rts.length - 1, phaseIdx | 0));
    sun.shadow.map = this.rts[i];
    sun.shadow.matrix.copy(this.mats[i]);
    return true;
  }
}
