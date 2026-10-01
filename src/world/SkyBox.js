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

// 夜空贴图（星空）——夜晚时叠在白天背景之上做交叉淡入
const NIGHT_SKY_URL = 'sky/night_sky.png';

// createNightSky(scene)：生成一个包住场景的夜空球壳，透明度由调用方按"夜的浓度"驱动。
// 用球壳而不是直接换 scene.background，是为了能和白天背景做平滑过渡（背景贴图没法直接混色）。
// 注意：球壳半径在 update 里按相机 far 动态缩放，否则用户把「视距」调小后整个球会被裁掉、夜空消失。
export function createNightSky(scene) {
  const mat = new THREE.MeshBasicMaterial({
    map: null,
    color: 0x05070f, // 贴图没加载成功时，至少天空会变暗而不是原样
    side: THREE.BackSide,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), mat);
  mesh.renderOrder = -1; // 与天空同层：先于地面/建筑绘制
  mesh.visible = false;  // 白天完全不参与绘制，零开销
  scene.add(mesh);

  new THREE.TextureLoader().load(
    NIGHT_SKY_URL,
    (texture) => {
      texture.colorSpace = THREE.SRGBColorSpace;
      mat.map = texture;
      mat.color.setHex(0xffffff); // 有贴图时按原色显示星空
      mat.needsUpdate = true;
      skyTextures.night = texture;
      console.log('[sky] 夜空贴图已加载');
    },
    undefined,
    () => {
      // 加载失败：保留深色兜底，并打一条日志便于定位路径问题
      console.warn('[sky] 夜空贴图加载失败，改用纯深色天空:', NIGHT_SKY_URL);
    }
  );

  return mesh;
}

// 让夜空球壳刚好套在相机可视范围内（跟随 far，避免被裁剪）
export function fitNightSky(mesh, camera) {
  if (!mesh || !camera) return;
  mesh.scale.setScalar(camera.far * 0.92);
}