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
// 环境光强度基准：IBL（天空反射，scene.environmentIntensity）要跟随"环境光"滑块时用的旧基准。
// design.ambient = 此值 时 IBL 保持原昼夜亮度；=0 时 IBL 也归零（解决"环境光=0 但还有环境光"）。
const AMBIENT_REF = 0.32;

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
// 环境贴图现在**每个时段各有一份**（加载期预生成、缓存，平时只换引用 → 零成本、不重编译），
// 所以贴图本身已经带足了色温（清晨的暖、夜晚的冷暗），这里只负责**明暗**。
// ⚠ 这几个数就是"白天亮、入夜暗"的全部来源，**别再往 1.0 收**：
//   之前被压平成 0.7~1.0，结果"环境光整天一个亮度"，昼夜节奏直接没了。
const ENV_INTENSITY = { morning: 0.85, day: 1.0, night: 0.45, space: 0.25 };
// 过渡时环境反射**不再瞬切**，而是分时档重建（见 ENV_MORPH_STEPS），所以不需要"哑铃"了。
// 亮度直接在两个时段之间单调插值：白天→夜晚就是一路变暗，中途不会出现"暗一下又亮回来"的凹谷。
// ⚠ 历史上这里用过 ENV_DIP（在换贴图那一瞬把亮度压出个谷底来掩护换色）——
//   那是"环境贴图只能瞬切"时代的权宜之计，代价是亮度曲线出现不自然的凹陷，看着像闪了一下。
//   现在贴图能渐变，就没有理由再压这个谷了。
//
// 过渡期环境反射的分档数：把 a∈[0,1] 切成这么多档，每档重建一次小图 PMREM。
// 12 档 → 一昼夜 4 个过渡共 48 次重建（一昼夜 600 秒 ≈ 每 12 秒一次，每次两三毫秒），既平滑又无卡顿风险。
const ENV_MORPH_STEPS = 12;
// 环境贴图降采样尺寸。反射本来就靠 PMREM 的模糊 mip，高频细节全部丢掉，
// 所以 256×128 与 4096×2048 的**反射结果几乎没差别**，但生成成本差两个数量级 ——
// 这也是过渡期能反复重建的前提（4096 的 PMREM 每张几十毫秒，绝不能放进帧循环）。
const ENV_W = 256, ENV_H = 128;
// 环境反射的色偏校正（只作用于 PMREM，天空球壳仍用原图 —— 天空该蓝还是蓝）。
// 为什么要校正：实测 night/space 两张图上半球的「蓝 − 绿」达 +48 / +44，蓝绿比 1.8~2.1
// （白天同样口径只有 1.25），反射到金属/光滑材质上就是**发紫**。
//   · ENV_DESAT：整体去饱和（0=不改，1=全灰）
//   · ENV_PURPLE_CUT：把「蓝比绿高出来」的那部分削掉这么多（专治紫）
const ENV_DESAT = 0.35;
const ENV_PURPLE_CUT = 0.55;

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
  // 单调插值：过渡就是一路从当前时段的亮度走到下一时段的亮度，中间不再有凹谷。
  const intensity = to ? iFrom + (iTo - iFrom) * a : iFrom;
  // 环境反射分档重建（step 变一次才重建一次 PMREM，见 createTimeSky）。
  // key 仍然给出"当前更接近哪张贴图"，非过渡期用它直接命中缓存。
  const step = to ? Math.round(a * ENV_MORPH_STEPS) : 0;
  return { from, to, a, step, key: (to && a >= 0.5) ? to : from, intensity };
}

// 环境反射的色偏校正（原地改 RGBA 数组）。抽成纯函数是为了能在 Node 里直接断言。
// 治的是"反射发紫"：夜空/深夜两张图蓝远大于绿，金属材质一反射就是脏紫。
//   ① 整体往灰度拉一点（ENV_DESAT）—— 反射本来就是低频信息，饱和度高只会显脏；
//   ② 再把"蓝比绿高出来"的那部分削掉（ENV_PURPLE_CUT）—— 专治紫，蓝天仍是蓝天。
// ⚠ 只作用于 PMREM 那份降采样图，**天空球壳仍用原图**，所以天空观感不受影响。
export function correctEnvColor(px) {
  for (let i = 0; i < px.length; i += 4) {
    let r = px[i], g = px[i + 1], b = px[i + 2];
    const gray = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    r += (gray - r) * ENV_DESAT;
    g += (gray - g) * ENV_DESAT;
    b += (gray - b) * ENV_DESAT;
    const excess = b - g;
    if (excess > 0) b -= excess * ENV_PURPLE_CUT; // 蓝压向绿；暖色（b<g）不动
    px[i] = r; px[i + 1] = g; px[i + 2] = b;
  }
  return px;
}

// 把一张时段贴图降采样 + 校色成 ENV_W×ENV_H 的像素，供 PMREM 用。失败返回 null（回退到原图）。
function sampleEnvSource(image) {
  try {
    if (typeof document === 'undefined' || !image) return null;
    const cv = document.createElement('canvas');
    cv.width = ENV_W; cv.height = ENV_H;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, ENV_W, ENV_H);
    const d = ctx.getImageData(0, 0, ENV_W, ENV_H);
    correctEnvColor(d.data);
    return d.data;
  } catch (e) {
    console.warn('[sky] 环境贴图降采样失败（沿用原图反射）:', e);
    return null;
  }
}

// 把「校色后的小像素」还原成 equirect CanvasTexture（供生成已校色时段 PMREM 用）。
// 反射结果与原图几乎无差（PMREM 靠模糊 mip，高频信息全丢），但去掉了 night/space 的蓝绿失衡（治反射发紫）。
function colorTexFromSrc(px) {
  if (!px) return null;
  try {
    const cv = document.createElement('canvas');
    cv.width = ENV_W; cv.height = ENV_H;
    cv.getContext('2d', { willReadFrequently: true }).putImageData(new ImageData(px, ENV_W, ENV_H), 0, 0);
    const tex = new THREE.CanvasTexture(cv);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  } catch (e) { return null; }
}

// createTimeSky(scene, renderer)：生成四张天空球壳 + 程序化天空兜底，返回 { update(t, camera) }。
// update 每帧调用：按时刻决定哪张球壳可见并交叉淡入，同时让球壳跟随相机（无视差、不被裁剪）。
// ⚠ 一定要传 renderer：金属/光滑材质（metalness 高、roughness→0）靠 scene.environment 出颜色，
//   不建环境贴图这些材质会渲染成**纯黑**（导入的模型很常见）。
export function createTimeSky(scene, renderer, opts = {}) {
  const fallback = createSky(scene); // 贴图没加载出来前的兜底，加载成功后隐藏
  const domes = new Map();
  let anyLoaded = false;
  const envMaps = new Map();   // key -> 该时段的环境贴图（PMREM RT），加载期各生成一份
  const envSrc = new Map();    // key -> 降采样 + 校色后的小像素（Uint8ClampedArray），过渡期用来混合
  let fallbackRT = null;       // RoomEnvironment 那份临时环境，第一张时段环境就绪后释放
  let curEnvId = null;         // 当前 scene.environment 用的是谁（时段 key，或过渡的 'from>to#step'）
  // 过渡期混合用的复用画布/贴图/RT：避免每次重建都新建 canvas 与 texture
  let morphCanvas = null, morphCtx = null, morphTex = null, morphRT = null;
  let morphDisabled = false;   // 过渡期重建失败过 → 永久退回"整段贴图"，避免每帧重试 PMREM
  // 环境贴图换新时的回调（可选）。用途：障眼法窗户等「直接采样 scene.environment」的自定义材质
  // 需要重新绑定贴图引用。**不要每帧调用** —— 只在引用真的变了时触发。
  // 用回调而不是让本模块 import EditorBuildings，避免 SkyBox ⇄ EditorBuildings 循环依赖。
  const notifyEnv = () => { if (typeof opts.onEnvChange === 'function') { try { opts.onEnvChange(scene.environment); } catch (e) { console.warn('[sky] onEnvChange 回调失败:', e); } } };

  if (renderer) fallbackRT = applyEnvironment(scene, renderer, null); // 基础环境，立刻生效

  for (const key of Object.keys(SKYBOX_URLS)) {
    const mat = new THREE.MeshBasicMaterial({
      map: null,
      color: 0x000000, // 贴图未就绪时先保持全黑，避免闪白
      side: THREE.BackSide,
      transparent: true,   // update 里按是否处于过渡期动态切 opaque/transparent（见下）：当前时段恒不透明，杜绝两张透明球壳抢序
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
    // 把这张时段贴图**降采样 + 色偏校正**成一份小像素，留着给 PMREM 用（含过渡期的分档混合）。
    // 4096×2048 的 PMREM 每张几十毫秒，绝不能进帧循环；256×128 只要两三毫秒，才能反复重建。
    envSrc.set(key, sampleEnvSource(texture.image));
    if (renderer) {
      // ⚠ 时段环境贴图用「校色后的小图」生成：256×128 校色处理掉 night/space 的蓝绿失衡（治反射发紫），
      // 反射结果与原图几乎无差（PMREM 本就靠模糊 mip，高频信息全丢）。这样非过渡期也不发紫。
      const srcPx = envSrc.get(key);
      const colorTex = srcPx ? colorTexFromSrc(srcPx) : texture;
      const rt = buildEnvMap(renderer, colorTex);
      if (colorTex && colorTex !== texture) { try { colorTex.dispose(); } catch (e) { /* ignore */ } }
              if (rt) {
                envMaps.set(key, rt);
                if (!curEnvId) {
                  curEnvId = key;
                  scene.environment = rt.texture;
                  notifyEnv(); // 首张时段环境就绪 → 通知窗户等自定义材质重新绑定
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
  // 环境反射随天色走：平时直接用该时段缓存好的 PMREM（只换引用，零成本）；
  // 过渡期则把两张小图按进度混合后重建，**分档重建**（ENV_MORPH_STEPS 档）而不是每帧重建 ——
  // 既让反射跟着天空一起渐变（不再"啪"一下换色），又把 PMREM 开销压到每十几毫秒一次。
  if (renderer && scene.environment) {
    const e = envAt(t);
    // 把"环境光强度"也作用到 IBL（天空反射）上：IBL 是独立通道，不受 AmbientLight.intensity 控制，
    // 否则用户把环境光拉到 0 时金属/光滑材质仍被天空照得锃亮（"环境光=0 但还有环境光"）。
    // ambient 取 design.ambient（游戏端恒定，不随昼夜变）；AMBIENT_REF = 旧基准，ambient=0 → IBL 也归零。
    let envI = e.intensity;
    if (opts && typeof opts.ambientRef === 'function') {
      const ar = Number(opts.ambientRef()) || 0;
      envI *= Math.min(2, Math.max(0, ar / AMBIENT_REF));
    }
    scene.environmentIntensity = envI;
    // ⚠ 过渡期不再逐档重建 PMREM：每档一次 buildEnvMap 在弱机是 5~15ms 的卡顿尖峰，
    // 一昼夜几十次 → 时段切换时明显卡。四个时段已校色的 PMREM 在加载期各生成一份，
    // 这里只换贴图引用（free），亮度由上面的 environmentIntensity 平滑，
    // 反射色跳变落在过渡中点（a=0.5，最暗）几乎无感。
    useCachedEnv(e.key);
  }

  // 切回某个时段缓存好的环境贴图；顺手把过渡期那份临时 RT 释放掉（只在已经换走之后才 dispose）。
  function useCachedEnv(key) {
    if (curEnvId === key) return;
    const rt = envMaps.get(key);
    if (!rt) return; // 该时段还没生成好（首次加载中）→ 保持当前这份，下一帧再试
    scene.environment = rt.texture;
    curEnvId = key;
    notifyEnv(); // 换时段 → 通知窗户等自定义材质重新绑定（一昼夜只在时段切换时触发，成本可忽略）
    releaseMorphRT();
  }

  function releaseMorphRT() {
    if (morphRT) { try { morphRT.dispose(); } catch (e) { /* ignore */ } morphRT = null; }
  }

  // 把两张小图按 k 混合 → 写进复用画布 → PMREM。返回新的 RT（旧的由本函数释放）。
  function buildMorphEnv(pxFrom, pxTo, k) {
    try {
      if (!morphCanvas) {
        morphCanvas = document.createElement('canvas');
        morphCanvas.width = ENV_W; morphCanvas.height = ENV_H;
        morphCtx = morphCanvas.getContext('2d', { willReadFrequently: true });
      }
      if (!morphCtx) return null;
      const out = new Uint8ClampedArray(pxFrom.length);
      for (let i = 0; i < out.length; i++) out[i] = pxFrom[i] + (pxTo[i] - pxFrom[i]) * k;
      morphCtx.putImageData(new ImageData(out, ENV_W, ENV_H), 0, 0);
      if (!morphTex) {
        morphTex = new THREE.CanvasTexture(morphCanvas);
        morphTex.mapping = THREE.EquirectangularReflectionMapping;
        morphTex.colorSpace = THREE.SRGBColorSpace;
      }
      morphTex.needsUpdate = true;
      const rt = buildEnvMap(renderer, morphTex);
      if (!rt) return null;
      releaseMorphRT(); // ⚠ 先把上一份释放掉，再接管新的（顺序反了会把正在用的贴图释放掉）
      morphRT = rt;
      return rt;
    } catch (e) {
      console.warn('[sky] 过渡环境贴图重建失败（沿用上一份）:', e);
      return null;
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
      const mat = mesh.material;
      // ⚠ 防整屏白黑闪（尤其手机 TBDR）：过渡期「当前(from)」与「下一(to)」两张球壳若都为
      //   transparent 且同位，部分 GPU 逐帧深度排序不确定 → 整屏在亮(白天)/暗(夜晚)间闪。
      //   解法：当前时段(from)始终设为不透明背景层，透明球壳数量恒 ≤ 1（只剩 to），
      //   不再有两张同位透明球壳抢序。transparent 翻转要 needsUpdate，只在翻转那一帧置位
      //   （每昼夜仅 4 次相位切换），不每帧重编译。
      const wantTransparent = opacity < 0.999;
      if (mat.transparent !== wantTransparent) { mat.transparent = wantTransparent; mat.needsUpdate = true; }
      mat.opacity = opacity;
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