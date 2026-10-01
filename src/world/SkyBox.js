// 职责：创建天空。优先加载本地的「晴天有云城市天际线」等距圆柱贴图作为背景，
// 离线/加载失败时回退到 Three.js 程序化 Sky（无需外部贴图）。两套天空都无缝。
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

// 城市天空贴图（相对当前页面根路径，随构建部署）
const CITY_SKY_URL = 'sky/city_sky.jpg';

// 已加载的天空贴图引用：供 Game 在「白天/夜晚」之间直接切换 scene.background 用
const skyTextures = { day: null, night: null };
export function getSkyTextures() {
  return skyTextures;
}

// asyncLoadSky(scene, fin)：异步加载并应用贴图天空，成功时移除程序化 Sky 兜底并设背景。
// 返回一个 Promise（供需要按时序处理的调用方等待；失败自动静默回退）。
export function loadSkyTexture(scene) {
  return new Promise((resolve) => {
    const loader = new THREE.TextureLoader();
    loader.load(
      CITY_SKY_URL,
      (texture) => {
        texture.mapping = THREE.EquirectangularReflectionMapping;
        texture.colorSpace = THREE.SRGBColorSpace;
        scene.background = texture;
        skyTextures.day = texture;
        resolve(true);
      },
      undefined,
      () => resolve(false) // 加载失败（离线/缺失）→ 保留程序化天空
    );
  });
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

// 夜空贴图（星空）——夜晚时整屏铺在 scene.background 上。
// 这张图是一张普通照片（不是 360° 全景等距圆柱图），所以不能贴到球壳上：
// 球壳会把整张图绕满 360°，而一个视锥只有 70° 左右，等于只看到图片的一小块，
// 星空会被放大成一片模糊光斑、星系本体完全看不到。直接当整屏背景才是正常显示。
const NIGHT_SKY_URL = 'sky/night_sky.png';

// loadNightSkyTexture()：预加载夜空贴图，成功后缓存到 skyTextures.night 供 Game 切背景用。
export function loadNightSkyTexture() {
  return new Promise((resolve) => {
    new THREE.TextureLoader().load(
      NIGHT_SKY_URL,
      (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        skyTextures.night = texture;
        resolve(true);
      },
      undefined,
      () => {
        // 加载失败：夜里退回纯深色天空，并打一条日志便于定位路径问题
        console.warn('[sky] 夜空贴图加载失败，夜里将退回纯深色天空:', NIGHT_SKY_URL);
        resolve(false);
      }
    );
  });
}