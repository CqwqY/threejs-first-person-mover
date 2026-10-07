// 编辑器光照烘焙：把「太阳直射 + 阴影」预计算进各网格的 lightMap（第二套 UV = uv1），
// 运行时静态体改用 lightMap、实时太阳只照动态层 → 静态世界每像素省掉一次阴影采样
// （实测约占填充率里动态光照成本的全部，见 fpm-perf JSON：关阴影 +2.4fps）。
//
// 为什么只烤太阳+阴影（用户选定）：面光源 LTC / 天空 IBL 在 JSON 里贡献≈0，烤了也白烤；
// 且只烤太阳能保持美术可控——静态体仍受环境光/编辑器点面光源实时照亮（那些灯便宜/少数）。
//
// ⚠ 实现要点（UV 空间渲染）：
//   - 给目标网格生成 uv1（基于法线 dominant axis 的 box 投影，确定性、运行时可重算一致）。
//   - 用 onBeforeCompile 把顶点着色器的 gl_Position 改写成 `vec4(uv1*2-1, 0, 1)`，
//     片段仍跑标准 PBR+阴影采样 → 输出 = 该表面被太阳照+被遮挡后的颜色，落进 RT 的 uv1 区域。
//   - 其它网格设 colorWrite=false（不画进 RT，但仍 castShadow → 把影子投进阴影贴图，目标因此被遮蔽）。
//   - 目标网格 castShadow=false（烘焙期间不往阴影贴图里塞垃圾）、depthTest/Write=false（平铺不互遮）。
//   - lightMap 设 1×1 占位纹理，强制 three 声明 uv1 属性（否则 onBeforeCompile 里 uv1 未定义会编译失败）。
import * as THREE from 'three';
import { LAYER_DYNAMIC } from './Lights.js';

// 共享 1×1 占位纹理：仅用于在烘焙时强制材质声明 uv1 属性通道。
let _dummyTex = null;
function dummyTex() {
  if (_dummyTex) return _dummyTex;
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 1, 1);
  _dummyTex = new THREE.CanvasTexture(c);
  _dummyTex.needsUpdate = true;
  return _dummyTex;
}

// box 投影生成 uv1（写进 geometry.attributes.uv1）。已存在则跳过。
// 返回是否写入了 uv1。运行时与烘焙端用同一算法 → 同一几何产生完全相同的 uv1，
// 所以存档只需存 lightMap 贴图、uv1 在加载时重算即可。
export function genLightmapUV(geo) {
  if (!geo || !geo.attributes || !geo.attributes.position || !geo.attributes.normal) return false;
  if (geo.attributes.uv1) return true; // 已有第二套 UV，直接复用
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const sx = Math.max(1e-3, bb.max.x - bb.min.x);
  const sy = Math.max(1e-3, bb.max.y - bb.min.y);
  const sz = Math.max(1e-3, bb.max.z - bb.min.z);
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nrm.getX(i)), ny = Math.abs(nrm.getY(i)), nz = Math.abs(nrm.getZ(i));
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let u, v;
    if (nx >= ny && nx >= nz) { u = (z - bb.min.z) / sz; v = (y - bb.min.y) / sy; }
    else if (ny >= nx && ny >= nz) { u = (x - bb.min.x) / sx; v = (z - bb.min.z) / sz; }
    else { u = (x - bb.min.x) / sx; v = (y - bb.min.y) / sy; }
    uv[i * 2] = Math.min(1, Math.max(0, u));
    uv[i * 2 + 1] = Math.min(1, Math.max(0, v));
  }
  geo.setAttribute('uv1', new THREE.BufferAttribute(uv, 2));
  return true;
}

// 收集可被烘焙的静态网格（不透明、有位置+法线、非洞壁/窗户）。返回 { mesh, key } 列表。
export function collectBakeableMeshes(root) {
  const out = [];
  const seen = new Set();
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
    const list = Array.isArray(o.material) ? o.material : [o.material];
    let ok = true;
    for (const m of list) {
      if (!m) { ok = false; break; }
      if (m.transparent) { ok = false; break; }
      if (m.userData && m.userData.editorWindow) { ok = false; break; }
    }
    if (!ok) return;
    const key = (o.name && o.name.length) ? o.name : ('#' + out.length);
    if (seen.has(o)) return;
    seen.add(o);
    out.push({ mesh: o, key });
  });
  return out;
}

// 烘焙一组目标网格的太阳光照（含阴影）为 lightMap。
// renderer: WebGLRenderer（编辑器/游戏的渲染器）；scene: 含太阳与遮挡物的场景；
// targets: collectBakeableMeshes 的输出（{mesh,key}）；opts.size: 每网格光照图边长（px）。
// 返回 Promise<Array<{ key, dataURL, w, h }>>。
export async function bakeMeshLightmaps(renderer, scene, targets, opts = {}) {
  const size = opts.size || 256;
  const prevRT = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color()).getHex();
  const prevAlpha = renderer.getClearAlpha();
  const prevAutoClear = renderer.autoClear;
  const prevBg = scene.background;
  const dummy = dummyTex();

  // 占位 RT：浮点没必要，8bit 足够存光照颜色
  const rt = new THREE.WebGLRenderTarget(size, size, {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
    depthBuffer: false, stencilBuffer: false,
  });

  const results = [];
  const restore = []; // {mesh, colorWrite, depthWrite, depthTest, castShadow, material}
  try {
    renderer.setClearColor(0x000000, 0);
    renderer.autoClear = true;
    scene.background = null; // 烘焙时天空/背景会填满 RT，把目标光照图污染成天蓝色
    const cam = new THREE.Camera();

    for (const { mesh, key } of targets) {
      const geo = mesh.geometry;
      if (!genLightmapUV(geo)) continue;

      // ① 其它网格（含线/点类辅助物：网格线、坐标轴、灯光助手）：关 colorWrite（不污染 RT），
      //    仍可见→仍 castShadow（把影子投进阴影贴图，目标因此被遮蔽）。
      scene.traverse((o) => {
        if ((!o.isMesh && !o.isLine && !o.isLineSegments && !o.isPoints) || o === mesh) return;
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of ms) {
          if (!m) continue;
          restore.push({ m, colorWrite: m.colorWrite, depthWrite: m.depthWrite, depthTest: m.depthTest });
          m.colorWrite = false; m.depthWrite = false; m.depthTest = false;
        }
      });
      // ② 目标：克隆材质注入 uv1 位置；关 castShadow（烘焙期不往阴影图塞垃圾）；关深度测试平铺
      const origMat = mesh.material;
      const bakeMat = origMat.clone();
      bakeMat.lightMap = dummy; // 强制 three 声明 uv1 通道
      bakeMat.colorWrite = true;
      bakeMat.depthTest = false;
      bakeMat.depthWrite = false;
      bakeMat.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader.replace(
          '#include <project_vertex>',
          `vec4 mvPosition = vec4( transformed, 1.0 );
           #ifdef USE_INSTANCING
             mvPosition = instanceMatrix * mvPosition;
           #endif
           mvPosition = modelViewMatrix * mvPosition;
           gl_Position = vec4( uv1 * 2.0 - 1.0, 0.0, 1.0 );
           vViewPosition = - mvPosition.xyz;`
        );
      };
      // 让 three 重新编译（onBeforeCompile 已变更）
      bakeMat.needsUpdate = true;
      const prevCast = mesh.castShadow;
      mesh.castShadow = false;
      mesh.material = bakeMat;

      // ③ 渲进 RT
      renderer.setRenderTarget(rt);
      renderer.clear();
      renderer.render(scene, cam);
      renderer.setRenderTarget(null);

      // ④ 读像素 → canvas → dataURL（注意 WebGL 原点在左下，需翻转 Y）
      const buf = new Uint8Array(size * size * 4);
      renderer.readRenderTargetPixels(rt, 0, 0, size, size, buf);
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d');
      const img = ctx.createImageData(size, size);
      for (let y = 0; y < size; y++) {
        const sy = size - 1 - y;
        const dst = y * size * 4, src = sy * size * 4;
        img.data.set(buf.subarray(src, src + size * 4), dst);
      }
      ctx.putImageData(img, 0, 0);
      const dataURL = canvas.toDataURL('image/png');
      results.push({ key, dataURL, w: size, h: size });

      // ⑤ 还原目标
      mesh.material = origMat;
      mesh.castShadow = prevCast;
      // 还原其它网格
      for (const r of restore) { r.m.colorWrite = r.colorWrite; r.m.depthWrite = r.depthWrite; r.m.depthTest = r.depthTest; }
      restore.length = 0;
    }
  } finally {
    rt.dispose();
    renderer.setRenderTarget(prevRT);
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.autoClear = prevAutoClear;
    scene.background = prevBg;
  }
  return results;
}

// 烘焙后给网格分层：走了 lightMap 的网格「太阳跳过」（关掉第 1 层，只留第 0 层，靠 lightMap 提供太阳项），
// 没烘焙的网格仍开第 1 层（继续受太阳实时照亮）。
// ⚠ three 的阴影相机是独立相机（默认只渲染第 0 层），所以关掉第 1 层不会让烘焙体「不投影」——
// 它仍会在第 0 层被阴影相机抓到、照常把影子投到地面/动态物体上，只是不再接收实时太阳直射而已。
export function markBakedLayers(obj) {
  if (!obj) return;
  obj.traverse((o) => {
    if (!o.isMesh || !o.layers) return;
    const list = Array.isArray(o.material) ? o.material : [o.material];
    const baked = list.some((m) => m && m.lightMap);
    if (baked) o.layers.disable(LAYER_DYNAMIC); // 走 lightMap，太阳跳过
    else o.layers.enable(LAYER_DYNAMIC);        // 未烘焙 → 仍受太阳实时照
  });
}

// 运行时：把烘焙出的 dataURL 变成纹理并挂到材质上（异步，因为要 new Image）。
// 同时设 receiveShadow=false（静态体不再做实时阴影采样——填充率红利在此）、lightMapIntensity=1。
export function applyBakedLightmap(mesh, dataURL, intensity = 1) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const tex = new THREE.CanvasTexture(img);
      tex.colorSpace = THREE.NoColorSpace; // 光照图是线性辐照度，不该再走 sRGB
      tex.flipY = false; // 我们存时已翻转，纹理按原样采样
      tex.needsUpdate = true;
      genLightmapUV(mesh.geometry);
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of list) {
        if (!m) continue;
        m.lightMap = tex;
        m.lightMapIntensity = intensity;
        m.needsUpdate = true;
      }
      mesh.receiveShadow = false; // 关键：静态体不再实时接收太阳阴影
      mesh.castShadow = true;     // 仍投射阴影（给别人/动态体）
      resolve(tex);
    };
    img.onerror = (e) => reject(e);
    img.src = dataURL;
  });
}

// 编辑器内预览：与运行时一致地应用烘焙结果（同步把 dataURL 数组按 key 映射回网格）。
export async function applyBakedLightmapsToMeshes(meshes, lightmaps) {
  if (!Array.isArray(lightmaps) || !lightmaps.length) return 0;
  const byKey = new Map();
  for (const lm of lightmaps) if (lm && lm.key) byKey.set(lm.key, lm.dataURL);
  let n = 0;
  for (const { mesh, key } of meshes) {
    const url = byKey.get(key);
    if (!url) continue;
    await applyBakedLightmap(mesh, url, 1);
    n++;
  }
  return n;
}
