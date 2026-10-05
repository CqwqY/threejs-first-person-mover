// 职责：创建天空。优先加载本地的「晴天有云城市天际线」等距圆柱贴图作为背景，
// 离线/加载失败时回退到 Three.js 程序化 Sky（无需外部贴图）。两套天空都无缝。
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Config } from '../config.js';
import { track } from './loadTracker.js';
import { assetBlobURL } from './assetCache.js';

// ---- 环境贴图（scene.environment）----
// 为什么必须有：MeshStandardMaterial 的**金属/光滑**部分（metalness 高、roughness 接近 0）不是靠灯光，
// 而是靠**环境反射**出颜色的。没有 scene.environment 时这类材质会渲染成**纯黑**
// （导入的模型经常是 metalness=1 / roughness=0，就表现为"全黑、看不见"）。
// 天空贴图就绪前先用 RoomEnvironment 顶一份，保证任何时刻都有反射。
let _pmrem = null;
let _envRT = null;

// 只负责「等距圆柱贴图 → PMREM 环境贴图」，不动场景、也不释放任何东西 ——
// 调用方自己持有返回值并负责释放（时段天空要缓存 4 份，不能边生成边释放上一份）。
export function buildEnvMap(renderer, equirectTexture) {
  if (!renderer) return null;
  try {
    if (!_pmrem) _pmrem = new THREE.PMREMGenerator(renderer);
    return equirectTexture
      ? _pmrem.fromEquirectangular(equirectTexture)
      : _pmrem.fromScene(new RoomEnvironment(), 0.04);
  } catch (e) {
    console.warn('[sky] 环境贴图生成失败（金属材质可能偏黑）:', e);
    return null;
  }
}

// 生成并立刻应用，同时释放上一份。给「只要一份环境」的场景用（编辑器、单张天空）。
// 返回本次的 RT，方便调用方后续替换时释放。
export function applyEnvironment(scene, renderer, equirectTexture) {
  if (!scene || !renderer) return null;
  const rt = buildEnvMap(renderer, equirectTexture);
  if (!rt) return null;
  if (_envRT && _envRT !== rt) { try { _envRT.dispose(); } catch (e) { /* ignore */ } }
  _envRT = rt;
  scene.environment = rt.texture;
  return rt;
}

// ---- 各时段的环境光强度 ----
// 环境贴图现在**每个时段各有一份**（加载期预生成、缓存，切换时只换引用 → 零成本、不重编译），
// 所以贴图本身已经带足了色温与明暗（清晨的暖、夜晚的冷暗），这里只是轻微辅助。
const ENV_INTENSITY = { morning: 0.95, day: 1.0, night: 0.8, space: 0.7 };
// 过渡走到一半（a = 0.5）时才换贴图，并在前后把环境光压成一个"哑铃"（最低点在切换那一刻）：
// 亮度先降后升，**换色发生在最暗的一瞬**，肉眼最不容易察觉。
// ⚠ 这条曲线本身是连续的，所以直接赋值给 environmentIntensity 即可，不需要再做平滑
//   （再加平滑反而会让谷底对不齐切换点）。
// ⚠ 谷底不能压太深：一昼夜只有 240 秒，**清晨段仅 3 小时 = 现实 5.4 秒**，
//   过渡窗口（段的 18%）只有 1 秒出头。压到 0.55 时那 5 秒内会看到"暗一下又亮回来"，
//   像闪了一下。0.8（只压 20%）既够掩护换色，又在短段里也平缓 —— 每帧变化量控制在千分之几。
const ENV_DIP = 0.8;

// 城市天空贴图（相对当前页面根路径，随构建部署）
const CITY_SKY_URL = 'sky/city_sky.jpg';

// asyncLoadSky(scene, fin)：异步加载并应用贴图天空，成功时移除程序化 Sky 兜底并设背景。
// 返回一个 Promise（供需要按时序处理的调用方等待；失败自动静默回退）。
// resolve 的是 **texture 本身**（原来是 true）—— 调用方写 `if (ok)` 依旧成立，还能顺手拿它做环境贴图。
export function loadSkyTexture(scene) {
  // 天空贴图也是「进游戏前要等的一件东西」（离线时它会失败并回退程序化天空，同样算完成）
  return track(new Promise((resolve) => {
    // 走本地缓存：1MB 的贴图每次进游戏都重下一次太亏。拿到的是 blob: URL，用完必须回收
    assetBlobURL(CITY_SKY_URL).then((url) => {
      const loader = new THREE.TextureLoader();
      loader.load(
        url,
        (texture) => {
          URL.revokeObjectURL(url);
          texture.mapping = THREE.EquirectangularReflectionMapping;
          texture.colorSpace = THREE.SRGBColorSpace;
          scene.background = texture;
          resolve(texture);
        },
        undefined,
        () => { URL.revokeObjectURL(url); resolve(false); } // 加载失败（离线/缺失）→ 保留程序化天空
      );
    }).catch(() => resolve(false));
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
// opts.renderer 传了就顺手维护 scene.environment（金属/光滑材质要靠它出颜色，否则全黑）。
export function attachSky(scene, opts = {}) {
  const renderer = opts.renderer || null;
  if (renderer) applyEnvironment(scene, renderer, null); // 立刻给一份基础环境，不等天空贴图
  const sky = createSky(scene, opts);
  loadSkyTexture(scene).then((tex) => {
    if (!tex) return;
    scene.remove(sky); // 贴图天空就绪后移除程序化兜底，避免叠在背景前面
    if (renderer) applyEnvironment(scene, renderer, tex); // 升级成真实天空的环境反射
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

// 纯逻辑：给定世界时刻，算出「环境反射该用哪张时段贴图」+「environmentIntensity 该是多少」。
// 抽成纯函数是为了能在 Node 里直接断言 —— 切换点（a=0.5）与哑铃曲线这里是**连着踩过两次坑**的地方：
//   第一次：时段一变就重建 PMREM（每分钟卡一帧 + 变色跳变）；
//   第二次：为了省事把贴图定死成白天那张，结果"一整天都在反射白天的天空"（清晨/黄昏的暖色全丢了）。
// 现在：4 张贴图各预生成一份缓存，切换只换引用；亮度走哑铃，换色发生在最暗的一瞬。
export function envAt(t) {
  const { from, to, a } = skyBlend(t);
  const iFrom = ENV_INTENSITY[from] ?? 1;
  const iTo = to ? (ENV_INTENSITY[to] ?? iFrom) : iFrom;
  const dip = Math.min(iFrom, iTo) * ENV_DIP; // 过渡最低点（切换贴图就发生在这里附近）
  let intensity = iFrom;
  if (to) {
    intensity = (a < 0.5)
      ? iFrom + (dip - iFrom) * (a / 0.5)        // 前半段：压到谷底
      : dip + (iTo - dip) * ((a - 0.5) / 0.5);   // 后半段：升到目标
  }
  return { from, to, a, key: (to && a >= 0.5) ? to : from, intensity };
}

// createTimeSky(scene, renderer)：生成四张天空球壳 + 程序化天空兜底，返回 { update(t, camera) }。
// update 每帧调用：按时刻决定哪张球壳可见并交叉淡入，同时让球壳跟随相机（无视差、不被裁剪）。
// ⚠ 一定要传 renderer：金属/光滑材质（metalness 高、roughness→0）靠 scene.environment 出颜色，
//   不建环境贴图这些材质会渲染成**纯黑**（导入的模型很常见）。
export function createTimeSky(scene, renderer) {
  const fallback = createSky(scene); // 贴图没加载出来前的兜底，加载成功后隐藏
  const domes = new Map();
  let anyLoaded = false;
  const envMaps = new Map();   // key -> 该时段的环境贴图（PMREM RT），加载期各生成一份
  let fallbackRT = null;       // RoomEnvironment 那份临时环境，第一张时段环境就绪后释放
  let envKey = null;           // 当前 scene.environment 用的是哪个时段

  if (renderer) fallbackRT = applyEnvironment(scene, renderer, null); // 基础环境，立刻生效

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

    // 四张全景图加起来 4MB 多，同样走本地缓存；blob: URL 用完回收。
    // ⚠ 整体包一层 track：**环境贴图的生成也算"加载的一部分"**。
    //   每张 PMREM 要渲染 6 个面 + mip 链（几十毫秒），4 张一起往渲染帧里塞就是连续卡 4 下；
    //   放在加载屏期间做完，玩家看不到。代价只是加载屏多等一两百毫秒。
    track(new Promise((resolve) => {
      assetBlobURL(SKYBOX_URLS[key]).then((url) => {
        new THREE.TextureLoader().load(
          url,
          (texture) => {
            URL.revokeObjectURL(url);
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.anisotropy = 4; // 贴图与视线接近平行时（近地平线）少糊一点
            mat.map = texture;
            mat.color.setHex(0xffffff);
            mat.needsUpdate = true;
            anyLoaded = true;
            fallback.visible = false;
            // 每个时段各生成一份环境贴图并缓存（切换时只换引用 = 零成本、不重编译）。
            // 这样清晨是清晨的暖光、夜晚是夜晚的冷暗 —— 而不是一整天都反射白天的天空。
            if (renderer) {
              const rt = buildEnvMap(renderer, texture);
              if (rt) {
                envMaps.set(key, rt);
                if (!envKey) {
                  envKey = key;
                  scene.environment = rt.texture;
                  if (fallbackRT) { try { fallbackRT.dispose(); } catch (e) { /* ignore */ } fallbackRT = null; }
                }
              }
            }
            resolve(true);
          },
          undefined,
          () => { URL.revokeObjectURL(url); console.warn('[sky] 时段天空盒加载失败:', SKYBOX_URLS[key]); resolve(false); }
        );
      }).catch(() => {
        console.warn('[sky] 时段天空盒加载失败:', SKYBOX_URLS[key]);
        resolve(false);
      });
    }));
  }

  function update(t, camera) {
    // 环境反射随天色走：贴图在过渡中点（a=0.5）才切换（与天空球壳的交叉淡入同步），
    // 亮度走哑铃曲线（换色发生在最暗的一瞬）。换贴图只是改一个引用，没有 PMREM 重建。
    // 具体计算见 envAt()（纯函数，有 tools/probe-skyenv.mjs 覆盖）。
    if (renderer && scene.environment) {
      const e = envAt(t);
      scene.environmentIntensity = e.intensity;
      if (e.key !== envKey) {
        const rt = envMaps.get(e.key);
        if (rt) { envKey = e.key; scene.environment = rt.texture; }
        // 目标时段的环境贴图还没生成好（首次加载中）→ 保持当前这份，下一帧再试
      }
    }

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