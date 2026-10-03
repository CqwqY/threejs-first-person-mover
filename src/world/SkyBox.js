// 职责：创建天空。优先加载本地的「晴天有云城市天际线」等距圆柱贴图作为背景，
// 离线/加载失败时回退到 Three.js 程序化 Sky（无需外部贴图）。两套天空都无缝。
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { Config } from '../config.js';
import { track } from './loadTracker.js';

// 城市天空贴图（相对当前页面根路径，随构建部署）
const CITY_SKY_URL = 'sky/city_sky.jpg';

// asyncLoadSky(scene, fin)：异步加载并应用贴图天空，成功时移除程序化 Sky 兜底并设背景。
// 返回一个 Promise（供需要按时序处理的调用方等待；失败自动静默回退）。
export function loadSkyTexture(scene) {
  // 天空贴图也是「进游戏前要等的一件东西」（离线时它会失败并回退程序化天空，同样算完成）
  return track(new Promise((resolve) => {
    const loader = new THREE.TextureLoader();
    loader.load(
      CITY_SKY_URL,
      (texture) => {
        texture.mapping = THREE.EquirectangularReflectionMapping;
        texture.colorSpace = THREE.SRGBColorSpace;
        scene.background = texture;
        resolve(true);
      },
      undefined,
      () => resolve(false) // 加载失败（离线/缺失）→ 保留程序化天空
    );
  }));
}

// createSky(scene, opts)：生成程序化天空立即作为兜底，同时异步加载城市贴图替换。
// opts: { elevation, azimuth, turbidity, rayleigh, mieCoefficient, mieDirectionalG }
export function createSky(scene, opts = {}) {
  const sky = new Sky();
  sky.scale.setScalar(400); // 足够大，包裹整个场景，且小于相机 far 避免被裁剪
  sky.renderOrder = -1; // 先画天空，避免遮挡后续地面/模型

  const uniforms = sky.material.uniforms;
  uniforms.turbidity.value = opts.turbidity ?? 8;
  uniforms.rayleigh.value = opts.rayleigh ?? 2;
  uniforms.mieCoefficient.value = opts.mieCoefficient ?? 0.005;
  uniforms.mieDirectionalG.value = opts.mieDirectionalG ?? 0.8;

  // 太阳位置由仰角/方位角换算为方向向量
  const elevation = opts.elevation ?? 15;
  const azimuth = opts.azimuth ?? 200;
  const phi = THREE.MathUtils.degToRad(90 - elevation);
  const theta = THREE.MathUtils.degToRad(azimuth);
  const sunDir = new THREE.Vector3(
    Math.sin(phi) * Math.cos(theta),
    Math.cos(phi),
    Math.sin(phi) * Math.sin(theta)
  );
  uniforms.sunPosition.value.copy(sunDir);

  scene.add(sky);
  return sky;
}

// attachSky(scene, opts)：游戏/编辑器统一入口 —— 先加程序化兜底，再异步换成城市贴图。
export function attachSky(scene, opts = {}) {
  const sky = createSky(scene, opts);
  loadSkyTexture(scene).then((ok) => {
    if (ok) scene.remove(sky); // 贴图天空就绪后移除程序化兜底，避免叠在背景前面
  });
  return sky;
}

// ---- 时段天空盒：按「现实作息」把一天切成四段，用四张 2:1 全景图交叉淡入 ----
// 每张图各自一个「跟随相机」的球壳（BackSide），而不是 scene.background：
// 背景是贴在屏幕上的（转视角时天空不动，很晕），球壳才是钉在世界里的天空。
// 这些是标准等距圆柱（equirect）全景图，直接贴到球面 UV 上比例正好，无需平铺。
const SKYBOX_URLS = {
  morning: 'sky/skybox-morning.png', // 清晨
  day: 'sky/skybox-day.png',         // 白天
  night: 'sky/skybox-night.png',     // 夜晚
  space: 'sky/skybox-space.png',     // 深夜
};

// 时段划分（世界时刻 t：0 = 00:00，0.5 = 12:00）。按现实作息切：
//   05:00-08:00 清晨 / 08:00-17:00 白天 / 17:00-22:00 夜晚 / 22:00-05:00 深夜（跨零点）
// 数组按 start 升序；每段的结束时间即下一段的开始时间（最后一段绕回第一段）。
const SKY_PHASES = [
  { key: 'morning', start: 5 / 24 },
  { key: 'day', start: 8 / 24 },
  { key: 'night', start: 17 / 24 },
  { key: 'space', start: 22 / 24 },
];

// 计算当前时刻的天空混合：返回正在显示的时段 from、即将接替的时段 to，以及过渡进度 a（0~1）。
// a = 0 表示完全显示 from（不处于过渡期）。
function skyBlend(t) {
  const n = SKY_PHASES.length;
  let i = n - 1; // 默认落在最后一段（深夜），它跨越 22:00-05:00
  for (let k = 0; k < n; k++) {
    if (t >= SKY_PHASES[k].start) i = k;
  }
  const cur = SKY_PHASES[i];
  const next = SKY_PHASES[(i + 1) % n];
  const end = next.start > cur.start ? next.start : next.start + 1; // 处理跨零点
  const len = end - cur.start;
  const p = (t >= cur.start ? t - cur.start : t + 1 - cur.start) / len; // 本段进度 0~1
  const FADE = Config.SKY_FADE_RATIO; // 每段结尾这段比例用于交叉淡入下一张
  if (p > 1 - FADE) {
    return { from: cur.key, to: next.key, a: (p - (1 - FADE)) / FADE };
  }
  return { from: cur.key, to: null, a: 0 };
}

// createTimeSky(scene)：生成四张天空球壳 + 程序化天空兜底，返回 { update(t, camera) }。
// update 每帧调用：按时刻决定哪张球壳可见并交叉淡入，同时让球壳跟随相机（无视差、不被裁剪）。
export function createTimeSky(scene) {
  const fallback = createSky(scene); // 贴图没加载出来前的兜底，加载成功后隐藏
  const domes = new Map();
  let anyLoaded = false;

  for (const key of Object.keys(SKYBOX_URLS)) {
    const mat = new THREE.MeshBasicMaterial({
      map: null,
      color: 0x000000, // 贴图未就绪时先保持全黑，避免闪白
      side: THREE.BackSide,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false,
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), mat);
    mesh.renderOrder = -1;
    mesh.visible = false;
    scene.add(mesh);
    domes.set(key, mesh);

    new THREE.TextureLoader().load(
      SKYBOX_URLS[key],
      (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = 4; // 贴图与视线接近平行时（近地平线）少糊一点
        mat.map = texture;
        mat.color.setHex(0xffffff);
        mat.needsUpdate = true;
        anyLoaded = true;
        fallback.visible = false;
      },
      undefined,
      () => {
        console.warn('[sky] 时段天空盒加载失败:', SKYBOX_URLS[key]);
      }
    );
  }

  function update(t, camera) {
    const { from, to, a } = skyBlend(t);
    for (const [key, mesh] of domes) {
      let opacity = 0;
      let order = -1;
      if (key === from) {
        opacity = 1; // 当前时段全不透明（先把整片天盖住）
        order = -2;
      } else if (key === to) {
        opacity = a; // 下一时段叠在上面淡入，最终呈现 = a*下一张 + (1-a)*当前张
        order = -1;
      }
      mesh.material.opacity = opacity;
      mesh.renderOrder = order;
      mesh.visible = opacity > 0.001;
      if (!mesh.visible) continue;
      // 球壳刚好套在相机可视范围内：跟着 far 缩放，避免把「视距」调小后整个球被裁掉
      mesh.scale.setScalar(camera.far * 0.92);
      mesh.position.copy(camera.position); // 天空不该有视差，跟着相机走
    }
    fallback.visible = !anyLoaded;
  }

  return { update };
}