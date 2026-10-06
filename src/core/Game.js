// 职责：游戏主类，负责装配三大件（渲染器/场景/相机）、输入、玩家，并驱动主循环。
import * as THREE from 'three';
import { Config, API_BASE } from '../config.js';
import { buildScenery } from '../world/buildScenery.js';
import { createTimeSky } from '../world/SkyBox.js';
import { createLights, updateShadowBudgets, setAreaBaseIntensity, setMaxPointShadow, enableDynamicLighting } from '../world/Lights.js';
import { createSettingsPanel, loadSettings, computeSunOffset, DEFAULT_SETTINGS } from '../ui/SettingsPanel.js';
import { icon } from '../ui/icons.js';
import { keyBadge } from '../ui/KeyHints.js';
import { fullscreenSupported, isFullscreen, toggleFullscreen, onFullscreenChange } from '../ui/fullscreen.js';
import { createPlayerHUD } from '../ui/PlayerHUD.js';
import { createNpcChat } from '../ui/NpcChat.js';
import { createChatBox } from '../ui/ChatBox.js';
import { createAiNpc } from '../world/AiNpc.js';
import { createVehicle } from '../world/Vehicle.js';
import { createTeacherBoss } from '../world/TeacherBoss.js';
import { createMerchant } from '../world/Merchant.js';
import { createShopPanel } from '../ui/ShopPanel.js';
import { loadWallet, buyItem, rewardBossKill, redeemCode, SHOP_ITEMS, setCatalog, furnitureNames, migrateFurnitureToBag, itemByName, isOwned } from '../player/Shop.js';
import { buildEditorBuildings, buildEditorLights, fetchRemoteScene, setEditorSceneVisible, optimizeEditorScene, syncFakeWindowEnvs } from '../world/EditorBuildings.js';
import { updateLod } from '../world/Lod.js';
import { initBuildingTool, setBuildAreas } from '../world/BuildingTool.js';
import { defaultBoundary, normalizeBoundary, boundaryWallSpecs, BOUNDARY_THICKNESS } from '../world/Boundary.js';
import { defaultTrack, normalizeTrack, gateSpecs, isTrackRunnable, startPose, inGate, nextGateIndex } from '../world/Track.js';
import { buildTrackPath, buildTrackCollision } from '../world/TrackViz.js';
import { bakeTriMesh } from '../world/collision/trimesh.js';
import { buildArena } from '../world/CombatArena.js';
import { buildGrappleArena } from '../world/GrappleArena.js';
import { isCoarsePointer } from '../util/isCoarse.js';
import { judge, spawnForMode, trainingScore, formatClock, bestKey, parseBest, isBetter, modeRule } from '../game/MatchRules.js';
import { projectileHitsWorld } from '../world/collision/projectileHit.js';
import { raycastWorld, moveSphereWorld } from '../world/collision/worldQuery.js';
import { Input, isEditableTarget } from '../core/Input.js';
import { PlayerManager } from '../player/PlayerManager.js';
import { PlayerState } from '../player/PlayerState.js';
import { LocalPlayer } from '../player/LocalPlayer.js';
import { setModelScale, setHeldItem, setNameTagsVisible, setHealthBarsVisible, createHeldWeapon, tickPlayerModels, spinHeldBarrels } from '../player/PlayerModel.js';
import { getBagKey, addToBag, loadBag, removeFromBag, setBagAccount, bagCloudEnabled, syncBag, takeGuestBag } from '../player/Inventory.js';
import { markSaveDirty } from '../player/CloudSave.js';
import { itemIconSvg, itemIconKeyFor } from '../ui/itemIcons.js';
import { createSkillSlots, SLOT_COUNT } from '../ui/SkillSlots.js';
import { onRelayout, readLayout, currentMode, viewportSize } from '../ui/layout.js';
import { Network } from '../net/Network.js';
import { addDebugRig } from '../debug/SkeletonDebug.js';
import { setBgmVolume } from '../audio/Bgm.js';
import { clearAssetCache } from '../world/assetCache.js';
import { ensureTheme } from '../ui/theme.js';
import { installUiHotkey } from '../util/UiVisibility.js';
import { startRenderSample, sampleFrame, waitRenderSample, report as reportTelemetry, telemetryAutoGet, telemetryAutoSet } from '../util/Telemetry.js';
import { applyFragmentPrecisionToScene, applyFragmentPrecision } from '../world/FragmentPrecision.js';

// 在线同步辅助：拉取后端最新场景，成功则用其重建场景建筑并写入同一份碰撞体数组。
// target 必须是 LocalPlayer 持有的那条共享数组：buildEditorBuildings 会把同步碰撞体与
// 异步烘焙出的 trimesh 都 push 进这个引用，否则异步结果会落进一个没人读的临时数组。
// game 用于把场景里保存的 boundary（编辑器「边界」模式调出来的空气墙）应用到物理与场景上。
async function _fetchRemoteScene(game, scene, roots, target) {
  const data = await fetchRemoteScene();
  if (!data) return; // 拉取失败：保持打包的 editorMapData 兜底
  try {
    target.length = 0;
    buildEditorBuildings(scene, roots, data, target);
    buildEditorLights(scene, data); // 远端光源覆盖打包数据；函数内部会先清掉上一次的光源，不会重复叠加
    game._applyBoundary(data.boundary); // 边界（空气墙）：没有该字段时保持默认，行为与改动前一致
    game._applyTrack(data.track);       // 赛道（校园狂飙）：没有该字段时保持默认演示赛道
  } catch (e) {
    console.warn('[Game] 应用远程场景失败，回退打包数据:', e);
  }
}

// 老师 Boss 的阶段名（1 起，索引 0 占位）
const BOSS_PHASE_NAMES = ['', '一阶段', '二阶段', '三阶段'];

// 是否开启性能 HUD：地址栏里带 perf 即开（#perf / ?perf=1 都行）。
// 用 URL 开关而不是快捷键，一是手机上也能用，二是不用去抢已经排满的键位。
function perfEnabled() {
  try {
    return (String(location.search || '') + String(location.hash || '')).includes('perf');
  } catch (e) {
    return false;
  }
}

// 圆锥几何默认朝 +Y，制导导弹用它转到飞行方向
const UP_Y = new THREE.Vector3(0, 1, 0);

// ---- 投掷物共享资源（对象池 + 共享几何/材质）----
// 原实现每发都 `new SphereGeometry + new MeshStandardMaterial`，命中后再 `dispose()` 两者。
// 互掷起来（能量球 / 粉笔头 / 陨石 / 技能投掷）就是**每次开火一次 GPU 几何上传 + 一次材质分配**，
// 以及命中时的一次释放 —— 高频时是典型"打起来就掉帧、还偶尔卡一下"的来源。
// 现在：几何全场共用一份，材质按颜色缓存（本项目只用到 4 种色），mesh 走池复用。
// ⚠ 共享资源**绝不能 dispose**（一处误 dispose = 全场投掷物变黑/报错），所以销毁路径统一走
//   _releaseProjMesh()，别再写 mesh.geometry.dispose()/material.dispose()。
const PROJ_RADIUS = 0.16;
const PROJ_GEO = new THREE.SphereGeometry(PROJ_RADIUS, 12, 12);
const PROJ_POOL_MAX = 32; // 池上限：超过就真回收，避免一波爆发后常驻占内存
const _projMats = new Map();
function projMaterial(color) {
  let m = _projMats.get(color);
  if (m) return m;
  m = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.1 });
  _projMats.set(color, m);
  return m;
}

// 每帧复用的临时向量（抓钩绳索起点 / 光点瞄准方向 / 子弹朝向），避免在热路径里新建对象
const _gpA = new THREE.Vector3();
const _gHand = new THREE.Vector3();
const _gDir = new THREE.Vector3();
const _bDir = new THREE.Vector3();

// 对战玩法表：新增模式时这里加一条，服务端也要放行同名 mode。
// tip 给「玩家匹配」用，soloTip 给「训练场」用；win 文案由 MatchRules.MODE_RULES 决定判定方式。
const COMBAT_MODES = {
  meteor: {
    name: '躲避陨石混战',
    tip: '陨石不断砸落，中被砸 200 血；也能用左键能量球打人',
    soloTip: '自己练走位，退出时看存活时长与最高记录',
    win: '活到最后的人获胜',
  },
  grapple: {
    name: '疯狂抓钩',
    tip: '把准星对上柱顶的光点按攻击，钩爪就带你飞过去；在柱子间吃金币，掉进岩浆出局',
    soloTip: '限时 ' + Config.COMBAT_ROUND_SECONDS + ' 秒，自己练抓钩与吃金币',
    win: '限时内吃到金币最多的人获胜',
  },
  // 校园狂飙：不开竞技场，直接在校园大世界里跑编辑器画的那条赛道（见 world/Track.js）。
  circuit: {
    name: '校园狂飙',
    tip: '骑上电动车，按顺序穿过 1 → N 号门计圈；跑满圈数、用时最短者获胜',
    soloTip: '自己跑圈计时，刷自己的最好成绩',
    win: '跑满圈数用时最短者获胜',
  },
};

// 光源「开启时段」判定：win 由 EditorBuildings.parseOnWindow 给出（{ mode, from, to }），
// hours 为当前时刻的小时数（0–24）。custom 的窗口允许跨午夜（如 22 点开、6 点关）。
function lightIsOn(win, hours) {
  if (win.mode === 'day') return hours >= 6 && hours < 18;     // 仅白天 06:00–18:00
  if (win.mode === 'night') return hours < 6 || hours >= 18;   // 仅夜晚 18:00–06:00
  const from = ((win.from % 24) + 24) % 24;
  const to = ((win.to % 24) + 24) % 24;
  if (from === to) return true;                                // 起止相同 → 视作常亮
  if (from < to) return hours >= from && hours < to;
  return hours >= from || hours < to;                          // 跨午夜
}

export class Game {
  // 与服务器一致的昼夜周期（秒）：联机时以服务器权威时间为准，这里用于两次快照之间的外推
  // ⚠ 必须等于服务端 server-remote/index.js 的 DAY_SECONDS（当前 600 = 一昼夜 10 分钟）。
  //   两边不一致时，客户端每收到一次快照就会被拉回服务器时刻，表现为世界时间忽快忽慢地「抖」。
  static SYNC_DAY_SECONDS = 600;
  // 联机世界时刻突变（进服/重连/重进房间）→ 平滑过渡，避免整屏明暗硬跳（"突然变很暗"）
  static DAY_SYNC_BLEND = 4;   // 过渡时长（秒）
  static DAY_SYNC_JUMP = 0.2;  // 显示时刻与服务器目标相差超过此比例（≈4.8h）才触发过渡

  // token：登录会话 token（游客为空串）；profile：登录成功返回的用户资料（点名牌用）
  constructor(token = '', profile = null, gender = 'boy') {
    this._token = token;
    // 玩家自己选的性别（登录界面选，持久化在 localStorage 的 fpm-gender）；
    // 只影响「本机看到的自己」的人物素材，远端玩家仍按各自选择/序号奇偶显示。
    this._gender = gender === 'girl' ? 'girl' : 'boy';
    this._profile = profile;
    this._placed = false; // 是否已用服务端出生点定位过（断线重连不再重定位，避免被拉回出生点）

    // UI 主题：注入 Kenney UI 样式表，必须在任何 UI 元素创建之前完成
    ensureTheme();

    // ---- 渲染器 ----
    this._qualityDpr = 2; // 画质档可调的 dpr 封顶：high=2 / mid=1.5 / low=1（默认 2，quality='mid' 时由 _applyQuality 降到 1.5）
    // MSAA 只在低密度屏（dpr<2，主要是桌面显示器）开：手机 dpr 普遍 2.6~3，像素已经很密，
    // MSAA 在此几乎是纯 GPU 开销（填充率大户），关掉肉眼无差 —— 这是移动端最大的单项省耗。
    // 注意 antialias 无法运行时切换，只能在构造期按设备定死。
    // MSAA 无法运行时开关（作用于画布），只能构造期定死；走超分时则由 RT 的 samples 决定，
    // 那个是每帧可改的（RT 重建即可）。设置项写 localStorage，下次启动读它。
    let noAA = false;
    try { noAA = localStorage.getItem('fpm-noaa') === '1'; } catch (e) { /* 隐私模式下忽略 */ }
    this._aaOn = !noAA;
    this.renderer = new THREE.WebGLRenderer({
      antialias: !noAA && (window.devicePixelRatio || 1) < 2,
      // 双显卡笔记本默认可能选中集成显卡，这里明确要独显
      powerPreference: 'high-performance',
    });
    // dpr 封顶：iPhone 的 dpr=3，按 3 渲染像素量翻倍；且缩放导致 dpr 变化时
    // 会反复触发 canvas 重算（掉帧/抖动的隐藏来源）
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this._qualityDpr));
    // 自适应分辨率系数：1 = 画质档封顶值；帧率不够时自动往下压（最低 0.6），
    // 富余时慢慢升回。老卡/入门卡（填充率是真瓶颈）靠这个自动保帧率。
    this._dynScale = 1;
    this._dynLast = 0;
    // 帧率采样累加器：主循环每帧 _fpsAcc += dt、_fpsN++，满 0.5s 结算一次
    // （驱动自适应分辨率 + 帧数角标）。⚠ 必须显式初始化 —— 漏了的话
    // `undefined += dt` 会变成 NaN，`NaN >= 0.5` 恒为 false，整块永不执行，
    // 且不报错（静默失效）。这正是此前「帧数角标一直显示 --」与
    // 「自适应分辨率其实从未生效」的共同根因。
    this._fpsAcc = 0;
    this._fpsN = 0;
    // 超分（低分辨率渲染 + 锐化升采样）：_sharpen=0 表示关闭，退回浏览器直接拉伸
    this._sharpen = 0.5;
    this._upRT = null; this._upScene = null; this._upCam = null; this._upMat = null;
    this._upFailed = false;
    // 阴影总开关：**默认关**（实测填充率是唯一瓶颈，阴影是最贵的那一趟）。
    // ⚠ 光改 DEFAULT_SETTINGS 是**没用的** —— 游戏端面板 liveApply=false，binds 只在点「应用设置」时跑，
    //   而这里以前又硬编码 enabled=true ⇒ 启动时必须显式按存档值落一次，否则默认值永远是摆设。
    //   存档里没有该项（新玩家）时 `!== false` 落到 DEFAULT_SETTINGS.castShadow = false。
    this._shadowOn = loadSettings('scene-settings-game-v1').castShadow !== false;
    this.renderer.shadowMap.enabled = this._shadowOn;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // 阴影贴图不再每帧全量重渲（GPU 大头），改为主循环里隔帧置 needsUpdate ——
    // 太阳是平行光、阴影变化极慢，30Hz 更新肉眼无差；画质档切换时的单次重渲
    // 仍由 _applyQuality 里的一次性 needsUpdate 兜底（最迟 2 帧内会被循环置位）。
    this.renderer.shadowMap.autoUpdate = false;
    this._shadowTick = 0;
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    // ---- 距离分级材质 LOD（填充率优化，对应文章的 LOD / 削减片元成本思路）----
    // 不透明材质没有 discard（之前修过 early-Z 污染），所以「墙后的房间」已被 early-Z 在深度阶段剔除，
    // 真正烧填充率的是**看得见**的像素跑完整 PBR + 阴影采样。
    // 这台机器的杠杆：离相机够远（只看水平 XZ 距离）的表面，换成一份"不接收阴影 + 关环境反射"的
    // 廉价副本材质 —— 远处本就看不清阴影/IBL 细节，主 pass 每像素少一次阴影采样 + 一次环境贴图采样，
    // 直接砍掉远处像素的片元成本。近处（玩家身边）永远是原材质，观感零变化。
    // ⚠ 只换 material 引用、**绝不碰 visible**（碰 visible 会连碰撞/烘焙一起干掉，见 MEMORY 静默失效#3）；
    //   副本按 base.uuid 缓存，共享几何/贴图，材质程序在 _precompileShaders 里一次性预热，游戏中零重编译。
    this._lodCands = [];        // [{ mesh, base, cx, cz }]
    this._cheapCache = new Map(); // base.uuid -> 廉价副本材质
    this._lodOn = true;         // 默认开；_applyQuality 按画质档纠正（high 关）
    this._lodDist = 42;         // 水平距离阈值（米），超过即视为"远处"
    this._lodFrame = 0;         // 每 6 帧评估一次，摊薄遍历成本
    // 色调映射：用 ACES 把（太阳光 + 环境 IBL + 用户摆放的灯）的累加柔和压回 [0,1]，
    // 高光不再硬 clip 成死白 —— 解决"白天光跟着太阳叠加更亮、且发硬不柔"。
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = DEFAULT_SETTINGS.exposure; // 之后会被编辑器设计值覆盖
    document.getElementById('app').appendChild(this.renderer.domElement);

    // ---- 场景与相机 ----
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x87ceeb); // 天空浅蓝（兜底，时段天空球壳覆盖其上）
    // 时段天空盒：清晨/白天/夜晚/深夜四张全景图，按世界时刻交叉淡入（内部含程序化天空兜底）
    // onEnvChange：环境贴图（引用）变化时重新绑定障眼法窗户的采样源 —— 窗户 shader 直接采样
    //   scene.environment，换了时段天空就得跟着换，否则窗里永远是旧天空。
    //   只在「首张就绪」和「时段切换」时触发，不是每帧。
    this._timeSky = createTimeSky(this.scene, this.renderer, {
      ambientRef: () => this._ambient.intensity,
      onEnvChange: () => syncFakeWindowEnvs(this.scene),
    }); // 传 renderer：要生成环境贴图，否则金属材质全黑；ambientRef 让环境光=0 时 IBL 也归零

    const aspect = window.innerWidth / window.innerHeight;
    this.camera = new THREE.PerspectiveCamera(70, aspect, 0.1, 500);
    this.camera.rotation.order = 'YXZ';

    // ---- 静态世界（地面/道路/墙体 + 道具），返回统一的可编辑根列表 ----
    const roots = buildScenery(this.scene);
    // 太阳只照第 1 层：让整个静态世界默认开第 1 层（受太阳实时照）；
    // 烘焙过的静态体在 buildEditorBuildings 里会被 markBakedLayers 关掉第 1 层改走 lightMap。
    enableDynamicLighting(this.scene);
    this._cityRoots = roots; // 进入对战时整组隐藏（换成竞技场），退出再整组恢复
    // 灯光单独挂载（不作为可编辑景物）；阴影聚焦目标随玩家移动
    const lights = createLights();
    this.scene.add(lights.group);
    this._sunTarget = lights.sunTarget;
    this._sunOffset = lights.offset;
    this._sun = lights.sun;
    this._ambient = lights.ambient; // 供画面面板绑定；游戏端不透出强度调整
    this._hemi = lights.hemi;
    // 太阳的投影开关跟随总开关：createLights 里默认开了，这里按存档/默认值纠正一次。
    this._sun.castShadow = this._shadowOn;

    // ---- 手电筒：沿相机视线方向（含俯仰）照射，用于夜里补光 / 氛围 ----
    // 不挂成相机子节点（相机未必在场景图里，子节点 matrixWorld 不保证更新）；
    // 改为每帧把灯位置/目标点同步到相机世界坐标，方向用 camera.getWorldDirection（含 yaw+pitch）。
    this._initFlashlight();

    // 应用编辑器保存的「光照设计」：环境光/半球光/阳光强度、阳光角度，使客户端与编辑器保持一致；
    // 若编辑器从未保存过，则自动落到 DEFAULT_SETTINGS 的默认值。
    const design = loadSettings('scene-settings-v1');
    this._ambient.intensity = design.ambient;
    this._hemi.intensity = design.hemi;
    this._sun.intensity = design.sun;
    // 曝光随编辑器设计值：编辑器里调"整体曝光"滑块会写进同一份设计键。
    this.renderer.toneMappingExposure = Number(design.exposure) || DEFAULT_SETTINGS.exposure;
    const dOff = computeSunOffset(design.sunElev, design.sunAz);
    this._sunOffset.set(dOff.x, dOff.y, dOff.z);

    // ---- 昼夜循环：以编辑器保存的光照设计作为「正午」基准，随时刻连续变化 ----
    const gset = loadSettings('scene-settings-game-v1');
    this._dayEnabled = gset.dayNight !== undefined ? !!gset.dayNight : true;
    this._dayCycle = Math.max(30, Number(gset.dayCycle) || 600);
    this._dayTime = Config.DAY_START;
    this._dayBaseSun = design.sun;
    this._dayBaseAmbient = design.ambient;
    this._dayBaseHemi = design.hemi;
    this._dayAzDeg = design.sunAz;
    // 服务器时间同步：快照里带世界时刻，收到后以此为基准帧间外推，保证所有客户端时间一致
    this._netDayTime = null;
    this._netDayAt = 0;
    this._netDayBlending = false; // 联机世界时刻突变时是否正在平滑过渡
    this._dayBlendFrom = 0;       // 过渡起点（本地显示时刻，一天比例）
    this._dayBlendT = 0;          // 过渡进度 0~1
    this._hudTimeText = '';
    // 本地时刻偏移（小时→一天比例）：只用于本地预览（想马上看夜晚就拖它），不参与联机同步
    this._dayOffset = (Number(gset.dayOffset) || 0) / 24;

    // ---- 编辑器开发的地图：import src/world/editorMapData.js 渲染保存的建筑 ----
    this.colliders = buildEditorBuildings(this.scene, roots);
    buildEditorLights(this.scene); // 编辑器保存的点光源 / 面光源（用打包数据）

    // 在线同步：运行时从后端拉取最新场景（编辑器保存的那份），拉到则替换打包数据重建。
    // 拉取失败会自动回退到上面打包的 editorMapData，保证离线时也有内容。
    // 注意：LocalPlayer 持有 this.colliders 的同一条数组引用，因此原地改写而不是整体替换。
    // 远端场景拉取（含它触发的那些 GLB 加载）：进游戏前的加载动画会等它。
    // 拉取失败会静默回退打包数据，所以这里不能 reject，否则加载屏会卡住。
    // 之后再跑一次「场景优化」：跨物件同材质合并 + 登记距离分级（Lod.js）。
    // 放在加载屏期间做，玩家看不到合并那一下的开销；失败也不影响玩法。
    this._sceneReady = _fetchRemoteScene(this, this.scene, roots, this.colliders)
      .then(() => {
        // 远端场景是**原地改写** this.colliders 的 → 碰撞体宽相位网格必须重建
        if (this.localPlayer) this.localPlayer.markCollidersDirty();
        return optimizeEditorScene(this.scene);
      })
      .then(() => this._precompileShaders())   // 预编译材质变体，灭掉首帧重编译冻结（在加载屏期间执行）
      .catch((e) => { console.warn('[Game] 场景优化失败（保持原样）:', e); });

    // ---- 输入 ----
    this.input = new Input();
    this.input.setCanvas(this.renderer.domElement);

    // ---- 玩家管理器：维护所有玩家（本地 + 远程） ----
    // 本地玩家的真实 id 在收到服务器 welcome 时才确定，先前保持 null
    this.playerManager = new PlayerManager(this.scene);

    // 本地玩家的可序列化状态（id 稍后由 welcome 消息填充）
    this.localState = new PlayerState('', 0, Config.PLAYER_HEIGHT, 0);
    this.localState.gender = this._gender; // 本机自己选的性别；服务端已转发 gender 字段给同房其他人

    // 本地玩家逻辑
    this.localPlayer = new LocalPlayer(this.camera, this.input, this.localState, this.colliders);

    // ---- 场地边界（空气墙）----
    // boundary 由编辑器「边界」模式调、随场景 JSON 一起保存；这里默认用地面范围，
    // 拉到远程场景后 _applyBoundary 会覆盖它。注意必须在 localPlayer 建好之后同步一次。
    this.boundary = defaultBoundary();
    this._boundaryWalls = null;
    this._syncBoundary();

    // ---- 赛道（校园狂飙）----
    // track 由编辑器「赛道」模式调、随场景 JSON 一起保存；这里默认给一条演示赛道，
    // 拉到远程场景后 _applyTrack 会覆盖它。数据/几何/判定都在 world/Track.js（与编辑器共用同一份）。
    this.track = defaultTrack();
    this._trackGroup = null;
    this._trackCollider = null; // 路面烘出来的 trimesh 碰撞体（重建赛道时摘掉重烘）
    this._buildTrackViz();
    // 校园狂飙：本机正在跑圈时的状态（null = 没在跑）；HUD 元素；「每人一辆车」的载具池
    this._race = null;
    this._raceHud = null;
    this._raceHudLast = '';
    this._vehPool = null;
    // 车速表（骑电动车时才显示）：元素与「上次写进 DOM 的读数」缓存
    this._spdHud = null;
    this._spdNum = null;
    this._spdUnit = null;
    this._spdVal = null;
    this._spdNeedle = null;
    this._spdLast = -1;      // 上次显示的整数 km/h（-1 = 还没写过）
    this._spdRev = false;    // 上次是不是倒车态（用于单位文案切换）
    // 表盘满量程：按最高车速换算成 km/h 再向上取整到 10 —— 改 VEHICLE_SPEED 后表盘自动跟着走
    this._spdMax = Math.max(10, Math.ceil(Config.VEHICLE_SPEED * 3.6 / 10) * 10);

    // ---- 网络连接 ----
    this.network = new Network(Config.RELAY_URL, this._token);
    this.network.onMessage((msg) => this._onNetworkMessage(msg));
    // 连接状态 UI：重连中显示角标，5 次失败显示「网络错误」面板
    this._netBadge = null;   // 顶部「正在重连 (n/5)…」角标
    this._netErrorEl = null; // 全屏「网络错误」面板
    this._netWasDown = false; // 是否经历过掉线（用于重连成功时提示「已重新连接」）
    this.network.onStatus((s, info) => this._onNetworkStatus(s, info));
    this.network.connect();

    // 计时器与 RAF 句柄（便于停止）
    this.clock = new THREE.Clock();
    this._raf = 0;

    // 调试：URL 带 ?rigdebug 时，在场景中放一个可见调试模型并画出骨骼与坐标轴
    this.debugRig = /\brigdebug\b/.test(location.search) ? addDebugRig(this.scene) : null;
    // 第三人称相机（F5 切换，可看到自己的角色）
    this.thirdPerson = false;
    this._tpTime = 0;
    this._tpPrevX = 0;
    this._tpPrevZ = 0;
    window.addEventListener('keydown', (e) => {
      if (e.key === 'F5') {
        e.preventDefault(); // 阻止浏览器默认刷新
        this.toggleThirdPerson();
      }
    });

    // ---- 手电筒开关（L）：沿视线方向照，夜里补光/氛围 ----
    // 必须拥有（在小满的杂货铺买过）才能用；没买按 L 提示去哪买
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyL' && !e.repeat) {
        if (!isOwned(this._profile, 'flashlight')) {
          this._toast('手电筒要先去小满的杂货铺买（喷泉边找小满）');
          return;
        }
        this._toggleFlashlight();
      }
    });

    // ---- 一键隐藏 / 显示全部游戏 UI（截图、录屏、沉浸看画面用）----
    // 实现在 util/UiVisibility.js：给 body 加类 + 一条 CSS 隐藏 body 直属的 UI 层，
    // 不做元素清单（本项目 UI 是几十处各自 append 到 body 的，逐个维护必漏）。
    this._offUiHotkey = installUiHotkey(Config.HIDE_UI_KEY, {
      onToggle: (hidden) => this._toast(hidden ? 'UI 已隐藏（再按 ' + Config.HIDE_UI_KEY.slice(3) + ' 显示）' : 'UI 已显示'),
    });

    // ---- 窗口尺寸自适应 ----
    window.addEventListener('resize', () => this._onResize());

    // 触屏判定：设置面板要不要带「画面元素」区块、顶部按钮排布、载具按键提示都要用，
    // 所以在这里就算一次（后面 _vehKeyHint / _coarsePointer 直接复用，别再各判一份）。
    // 统一走 isCoarsePointer()（多信号 OR，覆盖 WebView / Capacitor / 真机）。
    const coarsePointer = isCoarsePointer();
    this._coarsePointer = coarsePointer; // 提前落定：顶部按钮排布 / 准星 / 攻击键都要读它
    // 骑车「软跟随相机」（转弯时视角被慢慢拖过去 + 可掰开的自由视角）：**电脑与手机都开**。
    // 手机右半屏的拖拽走的是同一条视角通道（MobileControls → input.addLookDelta），所以一样能用。
    // 不骑车时这一层恒等于 state.yaw，等于没开（见 LocalPlayer.update）。
    if (this.localPlayer) this.localPlayer.rideLookEnabled = true;

    // ---- 设置面板（游戏端）：只开放视距 + 阴影等图形项，不开放光照强度 ----
    this.settingsPanel = createSettingsPanel(      {
        // 触屏设备不显示「操作说明」区块（没有物理键盘，列 WASD 只是占地方）
        coarsePointer: this._coarsePointer,
        viewFar: (v) => {
          this.camera.far = v;
          this.camera.updateProjectionMatrix();
        },
        // 渲染分辨率：auto = 交给自适应（掉帧自动降、富余自动升）；
        // 手动档则钉死该比例，不再自动调整（给知道自己机器极限的用户兜底）。
        renderScale: (v) => this._setRenderScale(v),
        // 抗锯齿：走超分路径时立即生效（RT 会重建）；不降分辨率时是画布的 MSAA，
        // 那个只能在构造期决定，改完要刷新页面才生效。
        antiAlias: (v) => {
          this._aaOn = v !== 'off';
          try { localStorage.setItem('fpm-noaa', this._aaOn ? '0' : '1'); } catch (e) { /* 忽略 */ }
          if (this._upRT) { try { this._upRT.dispose(); } catch (e) { /* 忽略 */ } this._upRT = null; }
          this._applyRenderScale();
        },
        // 超分锐化强度：0=关（降分辨率后由浏览器拉伸，会糊）；越大越锐利，过头会有锯齿感
        sharpen: (v) => {
          this._sharpen = Number(v) || 0;
          this._applyRenderScale();
        },
        // 手机技能槽排布：切到「2行竖列」时槽位从轮盘搬到网格里。
        // ⚠ 这里只切技能槽排布，**绝不因此把整个 App 强推成手机模式**。
        //   旧版曾在此 replaceState 往地址栏塞 ?touch=1 再重载 → 只要在电脑上点过这个设置，
        //   地址栏就永久带上 ?touch=1（= 强制手机，优先级高于一切媒体查询）→ 电脑变手机。
        //   技能槽切不动时用 URL ?touch=1 手动开手机分支即可，不要在代码里自动塞参数。
        skillLayout: (v) => {
          if (this.skillSlots && typeof this.skillSlots.setMobileLayout === 'function') {
            this.skillSlots.setMobileLayout(v === '2行竖列' ? 'grid' : 'wheel');
          }
        },
        shadowR: (v) => {
          const cam = this._sun.shadow.camera;
          cam.left = -v;
          cam.right = v;
          cam.top = v;
          cam.bottom = -v;
          cam.updateProjectionMatrix();
        },
        shadowSize: (v) => {
          this._sun.shadow.mapSize.set(v, v);
          if (this._sun.shadow.map) {
            this._sun.shadow.map.dispose();
            this._sun.shadow.map = null;
          }
        },
        castShadow: (v) => {
          this._shadowOn = !!v;
          this.renderer.shadowMap.enabled = !!v;
          this._sun.castShadow = !!v;
          // 关→开：shadowMap.autoUpdate=false，不手动置位的话第一张阴影图要等主循环隔帧才画，
          //   会有一段"开了开关但还没影子"的空窗；这里立刻补一次。
          if (v) this.renderer.shadowMap.needsUpdate = true;
        },
        nameTag: (v) => {
          setNameTagsVisible(v);   // 玩家头顶名牌总开关
          setHealthBarsVisible(v); // 血条跟着一起开关
        },
        // 常驻帧数角标开关
        showFps: (v) => {
          if (!this._fpsBadge) return;
          this._fpsBadge.el.style.display = v ? '' : 'none';
        },
        // 昼夜循环开关。关掉后就没有「当前时刻」的概念了，必须把按时段关掉的灯全部点亮，
        // 否则上次被时段关掉的灯会一直是黑的（_updateDayNight 在关闭时直接 return，不会重算）。
        dayNight: (v) => { this._dayEnabled = !!v; if (!v) this._applyEditorLightDayState(null); },
        dayCycle: (v) => { this._dayCycle = Math.max(30, Number(v) || 600); }, // 一昼夜秒数
        bgmVolume: (v) => setBgmVolume(v), // 背景音乐音量（0 = 静音）
        dayOffset: (v) => { this._dayOffset = (Number(v) || 0) / 24; }, // 本地时刻偏移（小时→一天比例）
        // 骑车视角：视角操控（自由视角）/ 锁视角（相机恒在车后）
        rideView: (v) => {
          if (this.localPlayer) this.localPlayer.setRideViewLocked(v === '锁视角');
          this._syncRideViewBtn();
        },
        quality: (v) => this._applyQuality(v), // 画质档：聚合控制阴影分辨率 / dpr 封顶 / 阴影类型
        // 模型/贴图缓存：清掉本机那份，下次进游戏重新下载（换过模型时用）
        assetCache: () => this._clearAssetCache(),
        // 数据采集：测帧率 + 收集加载耗时/设备信息并上报（见 _runTelemetry）
        telemetry: () => this._runTelemetry(),
        // 自动上报总开关：写持久化键；若开启且已在游戏中，立即安排一次自动采集
        telemetryAuto: (v) => { telemetryAutoSet(!!v); if (v && this._started) this._scheduleTelemetry(); },
      },
      {
        fields: ['quality', 'renderScale', 'sharpen', 'antiAlias', 'viewFar', 'shadowR', 'shadowSize', 'castShadow', 'nameTag', 'showFps', 'skillLayout', 'rideView', 'dayNight', 'dayCycle', 'bgmVolume', 'dayOffset', 'assetCache'],
        storeKey: 'scene-settings-game-v1',
        modal: true,   // 游戏端用居中弹窗；编辑器仍走右上浮层（调光照时要能看着场景）
        title: '设置',
      }
    );
    // 骑车「自由视角 / 锁视角」切换按钮：按需懒创建，仅驾驶位显示
    this._ensureRideViewBtn();
    // 设置入口统一在顶部校卡右侧的「设置」按钮，不再额外挂悬浮齿轮（旧按钮定位与顶部重复）

    // 顶部校卡：显示当前账号名字，点击展开查看详情，并可在卡内退出登录
    this.playerHUD = createPlayerHUD(this._profile, !!this._token);
    // 顶部校卡两侧：左侧「背包」、右侧「设置」
    this._createTopButtons();

    // ---- AI 商人 NPC：出生点旁喷泉处的阿花，靠近按 F 或点右侧选项卡打开对话栏 ----
    this.aiChat = createNpcChat();
    this.aiChat.setOnSend((text) => this._npcSend(text));
    // NPC 对话（跟阿花说话）也要打字：同样把手机控件整组藏掉，免得边聊边走
    this.aiChat.setOnOpen(() => {
      this._setChatLock(true);
      if (this.mobileControls) this.mobileControls.setHidden(true);
    });
    this.aiChat.setOnClose(() => {
      this._setChatLock(false);
      if (this.mobileControls) this.mobileControls.setHidden(false);
    });
    this.aiNpc = createAiNpc();
    this.aiNpc.setInteract(() => this._openChat());
    this.scene.add(this.aiNpc.group);
    // 屏幕中心右侧的「与阿花对话」选项卡：仅在靠近阿花时显示，点击开/关对话栏
    this._createChatTab();
    this.aiNpc.onRange((r) => { this._chatTab.style.display = r ? '' : 'none'; });

    // ---- 电动车：双人载具，停在出生点旁的 (-7, 144) ----
    this.vehicle = createVehicle(this.scene);
    // 载具是动态物体：开第 1 层让太阳实时照它（createVehicle 内部异步加载的模型也会在加载后补开）。
    if (this.vehicle && this.vehicle.group) enableDynamicLighting(this.vehicle.group);
    this._vehDriver = null; // 后座时记住驾驶员的玩家 id
    this._vehPaxResend = 0; // 刚坐上后座时的上报重发窗口（秒）：让服务器尽快知道有乘客，好让驾驶员开始代报
    // 触屏不显示按键提示，桌面端补上 "(F)"（coarsePointer 在上面设置面板前已判好）
    this._vehKeyHint = coarsePointer ? '' : (' (' + Config.VEHICLE_KEY.slice(-1) + ')');
    this._vehHint = this._createVehicleHint();
    window.addEventListener('keydown', (e) => {
      if (e.code !== Config.VEHICLE_KEY) return;
      if (isEditableTarget(document.activeElement)) return;
      if (this.aiChat && this.aiChat.isOpen()) return; // 对话中不响应
      this._toggleVehicle();
    });

    // ---- 玩家聊天：PC 按 T 开输入框，手机点左下角的「聊」按钮 ----
    this.chat = createChatBox({ logMax: Config.CHAT_LOG_MAX, lineLife: Config.CHAT_LINE_LIFE, fade: Config.CHAT_LINE_FADE });
    this.chat.setOnSend((text) => this._sendChat(text));
    this.chat.setOnOpen(() => {
      document.exitPointerLock && document.exitPointerLock(); // 打字时别让鼠标继续转视角
      if (this.input) this.input.clearKeys();                 // 丢掉打开前按住的键，免得边打字边走路
      // 手机：把摇杆/按键整组藏起来（独立输入界面本身有遮罩，但看不见的控件仍会被摸到）
      if (this.mobileControls) this.mobileControls.setHidden(true);
    });
    this.chat.setOnClose(() => {
      if (this.mobileControls) this.mobileControls.setHidden(false);
    });
    this.chat.add({ sys: true, text: coarsePointer ? '点左下角「聊」可以和大家说话' : ('按 ' + Config.CHAT_KEY.slice(-1) + ' 键可以和大家说话') });
    window.addEventListener('keydown', (e) => {
      if (e.code !== Config.CHAT_KEY) return;
      if (isEditableTarget(document.activeElement)) return; // 正在打字：这一下算输入内容，不开关面板
      e.preventDefault();
      this.chat.open();
    });

    // 技能槽：阿花给的物品在此变为可点/可按数字键触发的技能；恢复上次指定的槽位
    this.skillSlots = createSkillSlots({
      dropModifier: Config.DROP_MODIFIER_KEY,
      gestureMs: Config.DROP_GESTURE_MS,
      gestureDy: Config.DROP_GESTURE_DY,
      // 手机端排布：'2行竖列' = 技能直接铺成网格；其余（含默认）= 单按钮 + 拖出轮盘
      mobileLayout: gset.skillLayout === '2行竖列' ? 'grid' : 'wheel',
    });
    this._skillMap = this._loadSkillSlots();
    this._restoreSkills();
    // 丢弃物品：PC 按住 Y + 数字键，手机长按技能槽上滑 → 由 Game 执行扣除与抛出
    this.skillSlots.setDropHandler((index) => this._dropSlot(index));

    // ---- 传送门与「老师」Boss：位于 (11,142)，靠近点「召唤老师」10 秒后出现 ----
    // 三阶段：一阶段弹幕 → 白光+世界变红 → 二阶段旋转激光（跳着躲）→ 三阶段高激光（手动开护盾挡）
    this.boss = createTeacherBoss(this.scene);
    this.boss.setOnEvent((msg) => this.network.sendBoss(msg));
    this.boss.setOnLocalDamage((dmg) => this._changeHealth(-dmg));
    this.boss.setOnLocalKill(() => { if (!this._dead) this._changeHealth(-Config.HEALTH_MAX * 2); });
    this.boss.setOnPhase((kind, ph) => this._onBossPhase(kind, ph));
    this.boss.setOnStatus(() => this._updateBossUI());
    this._portalHint = this._createPortalHint();
    // 准星：屏幕正中的瞄准点。PC 上只在指针锁定时显示（没锁定＝玩家在点 UI 或还没进画面），
    // 手机没有指针锁定，常显。
    this._crosshair = this._createCrosshair();
    this._crosshairShown = null;  // 三态：null = 还没写过 DOM，true/false = 当前显隐
    this._aimHot = false;         // 准星当前是否压住了可攻击目标（疯狂抓钩的柱顶光点）
    // 手机端「攻击」是圆形，且排在跳跃键正上方：这两个标记供布局变化时重算位置
    this._attackCoarse = coarsePointer;
    this._attackShown = false;  // 攻击键当前是否显示（只在显隐翻转时重算位置，避免每帧量 DOM）
    this._attackBtn = this._createAttackButton();
    // 视口变化（旋转/地址栏）后重算攻击键位置；本回调在布局层里靠后注册，
    // 所以执行时跳跃键/技能槽已经排好，_placeAttackBtn 末尾再让技能槽跟着重排一次
    onRelayout(() => this._placeAttackBtn());
    this._shieldBtn = this._createShieldButton();
    this._bossBar = this._createBossBar();
    this._redOverlay = this._createRedOverlay();
    this._flashEl = this._createFlashOverlay();
    // 被控制枪抓住时的全屏蓝色滤镜（只有「被控的那个人」自己看得到）
    this._ctrlOverlayShown = false;
    this._ctrlOverlay = this._createCtrlOverlay();
    this._chalkAt = 0;
    this._shieldUntil = 0;      // 护盾生效截止时间（performance.now）
    this._shieldReadyAt = 0;    // 护盾冷却结束时间
    this._redWorld = false;     // 当前是否处于「世界变红」的阶段
    this._lightColors = {       // 记下原始灯光颜色，狂暴结束后还原
      sun: this._sun.color.clone(),
      ambient: this._ambient.color.clone(),
      hemi: this._hemi.color.clone(),
    };
    // 玩家身上的护盾罩子（只在三阶段开盾时显示）
    const shieldMat = new THREE.MeshBasicMaterial({
      color: 0x7fe3ff, transparent: true, opacity: 0.3,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    applyFragmentPrecision(shieldMat);
    this._shieldMesh = new THREE.Mesh(
      new THREE.SphereGeometry(1.15, 20, 14),
      shieldMat
    );
    this._shieldMesh.visible = false;
    this.scene.add(this._shieldMesh);

    // 超级激光（技能槽 0 号位）：对老师累计造成 SUPER_CHARGE 伤害后充能，可发射一次追踪导弹
    this._superDmg = 0;         // 本轮已对老师造成的伤害
    this._superCharged = false; // 是否已充能完毕
    this._superActive = false;  // 0 号槽当前是否被超级激光占用
    this._superLabel = '';      // 0 号槽当前文案（用于去重）
    this._missiles = [];        // 在飞的追踪导弹

    // ---- 商人与商店：(-12,144) 的小满，靠近点按钮开店 ----
    this.merchant = createMerchant();
    this.scene.add(this.merchant.group);
    this._merchantHint = this._createMerchantHint();
    // 「拾取」按钮：走到别人（或自己）丢在地上的物品旁边就冒出来，手机点它 / PC 按 E 都能捡
    this._pickupHint = this._createPickupHint();
    // PC：靠近掉落物时按 E 拾取（鼠标被指针锁定，点不到 DOM 按钮）
    window.addEventListener('keydown', (e) => {
      if (e.code !== Config.PICKUP_KEY) return;
      if (isEditableTarget(document.activeElement)) return;
      if (this.aiChat && this.aiChat.isOpen()) return; // 对话中不响应
      if (!this._pickupTarget) return;
      e.preventDefault();
      this._pickupNearest();
    });
    this.merchant.onRange((r) => { this._merchantNear = !!r; });
    // 商店面板：「道具 / 家具」两个标签页同处一个「小满的杂货铺」弹层（不再分两个入口/两个按钮）
    this.shop = createShopPanel({
      onBuy: (id) => this._buyShopItem(id),
      onRedeem: (code) => this._redeemCode(code),
      getProfile: () => this._profile,
      onPlace: () => {
        if (this._buildTool && this._buildTool.hasHammer()) { this.shop.close(); this._buildTool.enter(); }
        else this._toast('先在小满杂货铺的「道具」页买「建造锤」，再用技能槽里的它进入建造模式');
      },
    });
    this.shop.setState(() => loadWallet(this._profile));
    // 学币不再单独挂一块牌：余额并进校卡（小牌右端 + 展开后资料里的一行），顶部只留校卡一个入口。
    this._refreshCoins();

    // ---- 玩家建造（教学楼）：买过的教学楼才能摆，联机共享 + 限流防爆 ----
    const shopBase = Config.RELAY_URL.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
    this._buildTool = initBuildingTool(this.scene, this.camera, this.renderer.domElement, this.network, {
      getProfile: () => this._profile,
      serverBase: shopBase,
      onToast: (m) => this._toast(m),
      onCoins: () => { this._refreshCoins(); if (this.shop) this.shop.render(); },
      // 进入/退出建造模式：切 body 类（隐藏顶栏/校卡/技能槽）、血条换成家具条位、攻击键改文案
      onActiveChange: (active) => {
        document.body.classList.toggle('kui-build', !!active);
        if (this._hpBox) this._hpBox.style.display = active ? 'none' : '';
        if (this._attackBtnLabel) this._attackBtnLabel.textContent = active ? '放置' : '攻击';
        this._bossUiKey = null;           // 强制重算攻击键显隐
        this._updateBossUI();
        this._updateSkillBarVisibility();
        if (active && this._attackCoarse && this._attackBtn) { this._attackBtn.style.display = ''; this._placeAttackBtn(); }
      },
    });
    // 拉服务端商店目录（含最新价格与教学楼），覆盖本地写死的 SHOP_ITEMS；失败则回退本地。
    fetch(shopBase + '/api/shop')
      .then((r) => r.json())
      .then((d) => {
        if (d && d.ok && Array.isArray(d.items)) {
          setCatalog(d.items);
          migrateFurnitureToBag(this._profile); // 老版记在 owned 的家具搬进背包（幂等）
          this._buildTool.refresh();
        }
      })
      .catch(() => {});
    // 建造范围：服务端配置优先（编辑器里改、全服即时生效）；拉不到就用 Config.BUILD_AREAS 兜底
    fetch(shopBase + '/api/buildareas')
      .then((r) => r.json())
      .then((d) => { if (d && d.ok && Array.isArray(d.areas)) setBuildAreas(d.areas); })
      .catch(() => {});

    // 背包云存档：登录后把背包同步到账号（换设备也是同一份）。游客不参与（没有账号可挂）。
    this._syncBagFromCloud();

    // ---- 棍子：挂在相机下的手持模型（技能槽里装备了棍子就一直握在手上，挥动时才播动画）----
    // 相机要进场景图，否则挂在它下面的模型不会被渲染
    this.scene.add(this.camera);
    this._clubRig = this._createClubRig();
    this._clubAt = 0;
    this._clubSwing = null;     // { t, hit }
    this._skillSig = '';        // 技能槽签名缓存（供 _hasSkillKind 判断手里该拿什么）
    this._skillKinds = null;

    // ---- 加特林：技能槽切换开火模式，按住左键持续扫射，会过热 ----
    this._gatlingOn = false;
    this._gatlingHeld = false;
    this._gatlingHeat = 0;          // 0~100，满 100 过热
    this._gatlingOverheated = false;
    this._gatlingCd = 0;
    this._gatlingCoolDelay = 0;     // 松开扳机后的散热延迟倒计时（见 _updateGatling）
    this._bullets = [];             // 在飞的子弹（只做视觉，命中是瞬时判定）
    // 弹道做成「一小段亮黄色曳光条」而不是一个小球：直径 16cm 的球飞出几米外就剩一个像素，
    // 隔远了谁都看不见（自己打出去的那几发同样遭殃，别人更是完全看不到）。
    // 圆柱高 1m 靠 scale.y 拉成实际长度，沿飞行方向摆好 → 任何距离都读得出弹道走向。
    this._bulletGeo = new THREE.CylinderGeometry(0.05, 0.05, 1, 6);
    this._bulletMat = new THREE.MeshBasicMaterial({ color: 0xffe27a });

    // ---- 控制枪：抓住一个玩家吊在视线前方，移动视角拖着走；对方按空格挣脱 ----
    this._ctrl = null;              // 控制者侧：{ id, until, acc, lastAx, lastAy, lastAz }
    this._ctrlBy = null;            // 被控侧：{ from, until, ax, ay, az }
    this._ctrlImmuneUntil = 0;      // 挣脱后的免疫截止时刻（performance.now 毫秒）
    this._ctrlBeam = null;          // 控制激光线（控制者侧可见）
    this._ctrlRig = this._createCtrlRig();   // 第一人称手持模型（挂在相机下）
    this._ctrlFireAt = 0;           // 最近一次开火时刻，用于后坐动画
    this._ctrlOn = false;           // 是否「装备」控制枪（技能槽切换，左键开火）
    this._gatlingRig = this._createGatlingRig(); // 开启加特林时握在手上（枪管会转）
    this._gatlingBar = this._createGatlingBar();

    // ---- 黑洞：扔出去不断变大，10 秒后把范围内的人吸过去 ----
    this._holes = [];

    // ---- 捉迷藏玩具：变成任意颜色的方块，每 30 秒给抓的人报一次模糊方向 ----
    this._morphs = new Map();   // 玩家 id -> { mesh }（变成方块的那位）
    this._hide = null;          // { hider, seeker, color }
    this._hideHintDeg = null;   // 最近一次收到的方向（世界方位角）
    this._hideReportTimer = Config.HIDE_REPORT_INTERVAL;
    this._hidePanel = this._createHidePanel();
    this._hideArrow = this._createHideArrow();
    this._hideTxtCache = '';

    // 三阶段按 Q 手动开护盾（手机端用「护盾」按钮）
    window.addEventListener('keydown', (e) => {
      if (e.code !== Config.BOSS_SHIELD_KEY) return;
      if (isEditableTarget(document.activeElement)) return;
      if (this.aiChat && this.aiChat.isOpen()) return;
      this._activateShield();
    });

    // 灵魂出窍：P 键切换（肉身留在原地，视角脱离身体自由飞行）
    window.addEventListener('keydown', (e) => {
      if (e.code !== Config.SOUL_KEY) return;
      if (isEditableTarget(document.activeElement)) return;
      if (this.aiChat && this.aiChat.isOpen()) return;
      this._toggleSoul();
    });

    // Boss 战期间鼠标左键投掷粉笔头（指针锁定时 click 不会走画布锁定逻辑，直接在这里派发攻击）；
    // 开了加特林就改成「按住持续扫射」
    this.renderer.domElement.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (document.pointerLockElement !== this.renderer.domElement) return;
      if (this._gatlingOn) { this._gatlingHeld = true; return; }
      if (this._ctrlOn) { this._fireCtrlGun(); return; }
      this._primaryAttack();
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button !== 0) return;
      this._gatlingHeld = false;
    });

    // 本地可拾取的「生成物品」发光道具
    this._pickups = [];

    // 血量与战斗：血量存在 localState 里（会随状态同步给其他玩家）
    this.localState.health = Config.HEALTH_MAX;
    this._dead = false;
    this._createHealthBar();
    this._projectiles = []; // 在飞的投掷物
    this._projPool = [];    // 投掷物 mesh 复用池（回收时 visible=false 并移出场景）
    this._projSeq = 0;      // 投掷物自增 id，用于和别人同步「哪一颗爆炸了」
    this._fx = [];          // 在播的爆炸特效

    // ---- 对战模式：匹配 + 单独竞技场（第一个模式「躲避陨石混战」）----
    this._combat = null;        // { room, mode, isOwner, members, spawn, roundStart, alive }
    this._room = null;          // 当前房间 id（大厅为 null）
    this._lobbySpawn = null;    // 进入对战前记下的大厅出生点，退出时还原
    this._mainColliders = [];   // 进入对战时快照的主世界碰撞体（退出还原）
    this._arena = null;         // 当前竞技场实例 { group, colliders, dispose() }
    this._meteors = [];         // 在飞的陨石 { x, y, z, vy, r, mesh, marker }
    this._meteorTimer = 0;      // 房主生成陨石的倒计时
    // 陨石共用资源：几何/材质/落点警戒圈（按半径缩放复用，避免每颗都新建导致 GC 抖动）
    this._meteorGeo = null;
    this._meteorMat = null;
    this._warnGeo = null;
    this._warnMat = null;
    this._combatAt = 0;         // 对战基础攻击（能量球）冷却计时
    this._matchMode = 'meteor';
    this._combatOverlay = null; // 「匹配中…」浮层
    this._combatHud = null;     // 对战状态条
    this._failEl = null;        // 屏幕中央「失败」字样（非弹窗）

    // ---- 训练场 / 输赢 / 观战 ----
    // _matchStats：本局战绩表 id → { id, nick, color, alive, diedAt, coins, kills, gone }
    //   · 存活状态来自同房快照里的 health（服务器会同步每个人的血量），阵亡时刻由本机时钟记；
    //   · coins 只有靠服务端在 coin 广播里带 from 才统计得到别人（否则只有自己的准）；
    //   · kills 靠阵亡者自己广播 {t:'die', by:最后一击的人}（只有阵亡这一侧知道是谁打死的）。
    this._matchStats = new Map();
    this._matchTotal = 0;       // 开局参与者数（判「活到最后」用固定分母，不能因为有人退房就变小）
    this._roundOver = false;    // 本局是否已判出结果（判出后不再重复弹结算）
    this._lastJudge = null;     // 最近一次名次判定结果（HUD 复用，避免同帧算两遍）
    this._hudKey = null;        // 状态条文字去重键（避免每帧写 DOM）
    this._resultPanel = null;   // 结算面板
    this._spectate = null;      // 观战：{ order: [id...], idx }——order 里是本局其他人
    this._spectateHud = null;   // 观战提示条（切换视角 / 提前退出）
    this._lastHitBy = null;     // 最近一次打到我的人（阵亡时用来归因击杀）
    this._lastHitAt = 0;
    this._scoreReady = false;   // 服务端是否已广播过战绩（coin.from / died）→ 结算里决定是否提示降级
    this._trainPending = null;  // 训练场：正在等服务端给单人房（超时则本机兜底）
    this._trainTimer = 0;       // 上面那个等待的倒计时（秒）
    this._trainLocal = false;   // 训练场本机兜底：隐藏大厅玩家 + 暂停自身状态上报
    this._trainBest = { meteor: null, grapple: null }; // 本机训练场最高记录
    this._soul = null;          // P 键灵魂出窍：{ x, y, z, yaw, pitch }，null 表示未出窍
    this._drops = [];           // 丢在地上的物品 { id, item, x,y,z,vx,vy,vz, resting, life, mesh, label }
    this._dropSeq = 0;          // 本机丢弃物自增序号（拼出全场唯一的掉落物 id，供拾取同步）
    this._pickupTarget = null;  // 当前可拾取的掉落物（离得最近那一件），null 表示够不到
    this._pickupLabel = null;   // 按钮上正在显示哪件物品（避免每帧重写 textContent）
    this._pickupShown = false;  // 「拾取」按钮显隐去抖（避免每帧写 style）
    // 抓钩（技能槽物品 / 疯狂抓钩模式）：锚点 + 绳索视觉
    this._grapple = null;       // { x,y,z 锚点, fx,fy,fz 钩爪当前坐标, flying, t 剩余时间 }
    this._grappleCd = 0;        // 抓钩冷却（秒）
    this._grappleHold = null;   // 我们写进 physics.velocityHold 的那个对象（松手时只清自己那份）
    this._grappleRope = null;   // 绳索（Line）
    this._grappleHook = null;   // 钩爪（Cone）
    // 别人的抓钩：id → { rope, hook, ax,ay,az 锚点, fx,fy,fz 钩爪, flying, t }
    // 只画别人甩出的那一条（自己的由 _grappleRope/_grappleHook 负责），两端共用同一套画法。
    this._remoteGrapples = new Map();
    this._beacons = null;       // 疯狂抓钩模式的柱顶光点（瞄准靶），仅在该模式下有值
    // 疯狂抓钩模式：金币与岩浆
    this._coins = [];           // 在空中的金币 { id, x,y,z, mesh, life }
    this._coinSeq = 0;          // 本机生成金币的自增序号（拼出全场唯一 id）
    this._coinTimer = 0;        // 房主生成金币的倒计时
    this._coinCount = 0;        // 本场吃到的金币数（HUD 显示）
    this._dropGeo = null;       // 丢弃物共用几何（立方体，避免每件都新建）
    this._dropLabelTex = new Map(); // 物品名 → Canvas 贴图（缓存，同名共用）
    this._dropLabelMat = new Map(); // 物品名 → Sprite 材质（缓存，同名共用）
    // 性能 HUD：地址栏带 perf（#perf / ?perf）时出现，用于定位「卡在哪」（物理 / 渲染 / 其他）
    this._perf = perfEnabled() ? this._createPerfHud() : null;
    // 常驻帧数角标（右上角）：默认可见、可在「设置 → 显示」关掉
    this._fpsBadge = this._createFpsBadge();
    this._fpsBadge.el.style.display = (loadSettings('scene-settings-game-v1').showFps === false) ? 'none' : '';
    if (this._fpsBadge.el.style.display !== 'none') this._fpsBadge.shown = true;
  }

  // ============ 性能 HUD ============
  // 为什么要有它：室内帧率问题靠「猜」会一直猜错（碰撞？渲染？提交次数？），
  // 直接把一帧拆成物理 / 渲染 / 其他三段摆在屏幕上，一眼就能定位。
  _createPerfHud() {
    const el = document.createElement('div');
    // z-index 必须压过所有游戏 UI（顶部按钮行 9500 / 学币牌 9500 / 校卡 900 / 编辑模式完成条 9700），
    // 否则 HUD 会被它们盖住 —— 而 HUD 恰恰是「渲染压力大」时唯一的诊断入口，被挡住等于工具失效。
    // 位置：左侧中部（top 50% 垂直居中）。
    // 屏幕四边都被占了，逐个排除：顶部=校卡(窄屏168/展开268, top14~402) + 按钮行(左184起)；
    // 底部=摇杆(118, left20/bottom26) + 血条(底边居中)；右侧=视角触控区(50vw)。
    // 左边从校卡下沿(382)到血条上沿之间是唯一整片空白，故垂直居中贴左。
    // 另加 max-width 防止长数字换行，max-height 防止横屏超出屏幕。
    el.style.cssText =
      'position:fixed;left:calc(env(safe-area-inset-left, 0px) + 8px);top:50%;' +
      'transform:translateY(-50%);z-index:9900;pointer-events:none;' +
      'font:11px/1.55 ui-monospace,Menlo,Consolas,monospace;white-space:pre;' +
      'max-width:min(78vw,340px);max-height:calc(var(--app-vh,100vh) - 24px);overflow:hidden;' +
      'background:rgba(0,0,0,.72);color:#7CFFB0;padding:6px 8px;border-radius:6px;' +
      'border:1px solid rgba(124,255,176,.35);' +
      'text-shadow:0 1px 2px rgba(0,0,0,.85);';
    el.textContent = '性能统计中…';
    document.body.appendChild(el);
    return { el, frames: 0, phys: 0, render: 0, acc: 0, t: 0, txt: '', gpu: null };
  }

  // GPU 型号（用于判断是否落到软件渲染：SwiftShader / WARP 意味着浏览器没开硬件加速，
  // 此时再怎么优化场景都没用 —— 那是浏览器设置问题，不是代码问题）。
  // ⚠ 旧实现依赖 this._perf（性能 HUD 对象）才去查 WebGL，导致 HUD 未创建时自动上报拿到 '-'、
  // 根本没读 GPU。改为自缓存、与 HUD 解耦；扩展被屏蔽时再退 gl.RENDERER。
  _gpuName() {
    if (this._gpuCache !== undefined) return this._gpuCache;
    let name = '-';
    try {
      const gl = this.renderer && this.renderer.getContext();
      if (gl) {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        const raw = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
                        : gl.getParameter(gl.RENDERER);
        name = String(raw || '未知').slice(0, 160);
      }
    } catch (e) { /* 扩展被屏蔽时保持 '-' */ }
    this._gpuCache = name;
    this._gpuIsSoftware = /swiftshader|software|llvmpipe|microsoft basic render|mesa offscreen|angle \(google, vulkan.*swiftshader/i.test(name);
    if (this._gpuIsSoftware) console.warn('[fpm] 检测到软件渲染(GPU 回退): ' + name + ' —— 帧率受限于 CPU，请在浏览器开启硬件加速（edge://gpu / chrome://gpu）');
    return name;
  }

  // 设备是否移动端：仅用于「画质起点更保守」这类默认，不用于控制功能开关。
  // 判定：UA 命中移动关键字，或「触屏 + 粗指针」（手机/平板，排除桌面 fine 指针鼠标）。
  _isMobileDevice() {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    if (/iPhone|iPad|iPod|Android|Mobile|Windows Phone|webOS|BlackBerry|IEMobile/i.test(ua)) return true;
    try {
      if ((navigator.maxTouchPoints || 0) > 0 && typeof matchMedia === 'function'
          && matchMedia('(pointer: coarse)').matches) return true;
    } catch (e) { /* matchMedia 不可用时忽略 */ }
    return false;
  }

  // 渲染分辨率设置项：'auto' 交给自适应；数字串（'80'）钉死为该百分比，不再自动调整。
  // 自动模式下按画质档给一个"接近稳态"的起点：弱档开局就低，跳过 1.0× 卡顿爬坡。
  // 集中在这里，_applyQuality 与 _setRenderScale 共用，避免初始化顺序把起点冲掉。
  // ⚠ 移动端（尤其苹果 3× DPR）起点额外压低：前几秒别烧满分辨率，自适应再慢慢升回
  //   （_adaptResolution 在 fps>54 时会 s+=0.08 回升，不会把强机永久锁死在低画质）。
  _autoStartScale() {
    const q = this._quality || 'mid';
    let s = q === 'high' ? 1 : q === 'mid' ? 0.85 : 0.7;
    if (this._isMobileDevice()) s = Math.min(s, q === 'high' ? 0.8 : q === 'mid' ? 0.6 : 0.5);
    return s;
  }

  _setRenderScale(v) {
    const n = Number(v);
    if (v === 'auto' || !isFinite(n) || n <= 0) {
      this._autoScale = true;
      this._dynScale = this._autoStartScale(); // 自动模式从"接近稳态"的起点往下探
    } else {
      this._autoScale = false;
      this._dynScale = Math.max(0.4, Math.min(1, n / 100));
    }
    this._applyRenderScale();
  }

  // 把「画质档 dpr 封顶 × 自适应/手动系数」写到渲染器。
  // 只改 drawingBuffer（setSize 第三参 false），不动 CSS 尺寸，否则布局会被撑变形。
  // 传入 w/h 时同时更新 CSS 尺寸（窗口缩放用）；不传则只改 drawingBuffer（改分辨率用）。
  _applyRenderScale(w, h) {
    const base = Math.min(window.devicePixelRatio || 1, this._qualityDpr);
    // 走超分时画布保持原生分辨率（最后由升采样那趟铺满屏幕），低分辨率只在 RT 里；
    // 不超分时才是老做法：直接把 drawingBuffer 压小，让浏览器拉伸。
    const up = this._useUpscale();
    this.renderer.setPixelRatio(base * (up ? 1 : (this._dynScale || 1)));
    this.renderer.setSize(w || window.innerWidth, h || window.innerHeight, !!(w && h));
    if (up) this._ensureRT();
    else if (this._upRT) { try { this._upRT.dispose(); } catch (e) { /* 忽略 */ } this._upRT = null; }
  }

  // ---- 超分（低分辨率渲染 + 锐化升采样）----
  // 降分辨率最直接，但画面会糊。这里把场景渲进低分辨率 RT，再用 5 抽样
  // 非锐化掩膜（中心放大、四邻负权重）放大到屏幕：边缘重新变利，比浏览器
  // 的双线性拉伸清楚得多，代价只是一趟很便宜的全屏 quad。

  // 只有「确实在降分辨率」且「用户没把锐化关掉」时才走超分路径
  _useUpscale() {
    return !this._upFailed && (this._sharpen || 0) > 0.001 && (this._dynScale || 1) < 0.98;
  }

  _ensureUpscale() {
    if (this._upScene) return true;
    try {
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          tDiffuse: { value: null },
          uTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
          uSharp: { value: 0.6 },
        },
        vertexShader:
          'varying vec2 vUv;\n' +
          'void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }\n',
        fragmentShader:
          'uniform sampler2D tDiffuse;\n' +
          'uniform vec2 uTexel;\n' +
          'uniform float uSharp;\n' +
          'varying vec2 vUv;\n' +
          'void main() {\n' +
          '  vec3 c = texture2D(tDiffuse, vUv).rgb;\n' +
          '  vec3 l = texture2D(tDiffuse, vUv - vec2(uTexel.x, 0.0)).rgb;\n' +
          '  vec3 r = texture2D(tDiffuse, vUv + vec2(uTexel.x, 0.0)).rgb;\n' +
          '  vec3 u = texture2D(tDiffuse, vUv + vec2(0.0, uTexel.y)).rgb;\n' +
          '  vec3 d = texture2D(tDiffuse, vUv - vec2(0.0, uTexel.y)).rgb;\n' +
          '  vec3 blur = (l + r + u + d) * 0.25;\n' +
          // 非锐化掩膜：把「中心与邻域的差」按比例加回去
          '  vec3 sharp = c + (c - blur) * uSharp * 2.0;\n' +
          // 限幅到邻域范围（CAS 的做法）：不允许超出局部极值，
          // 否则过冲会变成亮/暗描边，锯齿和噪点也会被一起放大成毛边。
          '  vec3 mn = min(min(l, r), min(u, d));\n' +
          '  vec3 mx = max(max(l, r), max(u, d));\n' +
          '  sharp = clamp(sharp, mn, mx);\n' +
          '  gl_FragColor = vec4(clamp(sharp, 0.0, 1.0), 1.0);\n' +
          '  #include <colorspace_fragment>\n' +
          '}\n',
        depthTest: false,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
      mesh.frustumCulled = false;
      this._upScene = new THREE.Scene();
      this._upScene.add(mesh);
      this._upCam = new THREE.Camera();
      this._upMat = mat;
      return true;
    } catch (e) {
      this._upFailed = true; // 着色器编译失败就永久退回直渲，别每帧重试
      return false;
    }
  }

  // 超分 RT 的多重采样档。**填充率瓶颈下 MSAA 是纯像素带宽开销**：RT 的样本数就是它的带宽倍数，
  // 4× 样本 ≈ 4 倍 RT 写入/解析带宽；而低内部分辨率下 MSAA 的边际价值本来就在下降
  // （写进去的像素变少了，代价却没变），且随后那趟锐化会把边缘对比拉回来。
  // 所以按内部分辨率分档：≤0.7× 直接关、≤0.85× 用 2×、其余才 4×。
  // ⚠ 画质档 dpr 封顶已降级时（手机）画布本来就没开 MSAA，`_aaOn` 为 false → 一律 0。
  _upSamples(s) {
    if (!this._aaOn) return 0;
    // ⚠ 仅**原生分辨率**才上 MSAA：降分辨率时主 pass 像素已被砍到 1/4~1/2，
    //   MSAA 的 2~4× 填充乘数不划算（填充率是大头，见 fpm-perf-20261006-102317.json）。
    //   锐化升采样已把降采样的锯齿补回来，弱机（恒在降分辨率）直接省掉这层填充 → 帧率更稳。
    if (s >= 0.999) return 4;
    return 0;
  }

  _ensureRT() {
    const base = Math.min(window.devicePixelRatio || 1, this._qualityDpr);
    const s = this._dynScale || 1;
    const w = Math.max(2, Math.floor(window.innerWidth * base * s));
    const h = Math.max(2, Math.floor(window.innerHeight * base * s));
    const samples = this._upSamples(s);
    // ⚠ 复用判据必须连 samples 一起比：分辨率刚好没变但采样档变了（跨 0.85 边界）时必须重建，
    //   否则 samples 永远停在旧值上。
    if (this._upRT && this._upRT.width === w && this._upRT.height === h && this._upRT.samples === samples) return true;
    try {
      if (this._upRT) this._upRT.dispose();
      this._upRT = new THREE.WebGLRenderTarget(w, h, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        type: THREE.HalfFloatType, // 避免线性空间 8bit 在暗部产生色带
        depthBuffer: true,
        stencilBuffer: false,
        // 多重采样：场景渲进 RT 后就没了画布那层 MSAA，必须在 RT 上补回来，
        // 否则降分辨率 + 锐化会把锯齿放大得很明显。但样本数是 RT 带宽的直接倍数，故分档（见 _upSamples）。
        samples,
      });
      return true;
    } catch (e) {
      this._upFailed = true;
      return false;
    }
  }

  // 加载期预热：把"第一次看见某个材质 / 第一次渲阴影"才会发生的**着色器编译**全部挪到加载屏里，
  // 避免游戏中边走边卡（单帧几百毫秒~数秒的长帧，是"卡一下"最主要的来源）。
  //
  // ⚠⚠ 这里**只有一句 renderer.compile(scene, camera) 是不够的**（旧版就这一句，注释还写着"含阴影"——错的）：
  //   Three 的 WebGLRenderer.compile() 只遍历**当前视锥内**的可见对象、且**只编主 pass**：
  //     · 不覆盖阴影深度（depth）材质变体 —— 阴影 pass 用另一套 depth 程序
  //     · 不覆盖背对相机 / 视锥外的材质 —— 转个身第一次看见那栋楼就当场编译
  //   所以下面补两步：① 临时关掉视锥剔除渲一帧，把所有材质都提交给编译器；
  //                   ② 临时打开阴影自动更新，让深度变体也编掉。两者都在 finally 里还原。
  // 前提：投影灯数量恒定（Lights.updateShadowBudgets 永远恰好 MAX_POINT_SHADOW+MAX_AREA_SHADOW 盏），
  //   编译出的 program 在游戏中可复用，不会随走动触发全场重编译。
  _precompileShaders() {
    if (this._shadersCompiled) return;
    this._shadersCompiled = true; // 先置位：失败也不重入（否则每帧重试 = 每帧卡）
    const r = this.renderer;
    if (!r) return;
    // LOD 候选登记（只需一次；世界重建时由 _rescanLod 重新扫）：世界已在加载屏期间构建好
    if (this._lodCands.length === 0) this._scanLodCandidates();
    // 片元降 mediump：移动 GPU 填充率 ~2×（顶点保持 highp，见 FragmentPrecision.js 的论证）。
    // ⚠ 必须排在下面的 compile 之前 —— 注入改的是 shader 源码，注入后再 compile 才是新程序；
    //   反过来（先编再注入）会白编一遍、游戏中首次看见材质时重编 = 卡顿尖峰。
    // ⚠ 也会把材质标 needsUpdate，让本来已缓存的高精度程序失效。注入是幂等的，重复调用安全。
    let _fragN = 0;
    try {
      _fragN = applyFragmentPrecisionToScene(this.scene);
      if (_fragN > 0) {
        this.scene.traverse((o) => {
          const m = o && o.material;
          if (!m) return;
          if (Array.isArray(m)) { for (const mm of m) { if (mm) mm.needsUpdate = true; } }
          else m.needsUpdate = true;
        });
      }
    } catch (e) {
      console.warn('[Game] 片元精度注入失败（忽略，保留 highp）:', e);
    }
    try {
      if (typeof updateShadowBudgets === 'function') updateShadowBudgets(this.camera.position);
      // ① 当前视锥内的主 pass（最便宜的一层，也会把 renderer 内部状态预热好）
      if (typeof r.compile === 'function') r.compile(this.scene, this.camera);

      // ② 视锥剔除临时全关 → 一帧之内把所有对象的材质都提交上去（含背对/远处/画面外）
      const toggled = [];
      this.scene.traverse((o) => {
        if (o && o.frustumCulled === true) { toggled.push(o); o.frustumCulled = false; }
      });
      const prevAuto = r.shadowMap.autoUpdate;
      const prevNeed = r.shadowMap.needsUpdate;
      const prevTarget = r.getRenderTarget();
      try {
        r.shadowMap.autoUpdate = true;   // 平时是关的（主循环隔帧置 needsUpdate），这里强制渲一次
        r.shadowMap.needsUpdate = true;
        r.render(this.scene, this.camera);
      } finally {
        r.shadowMap.autoUpdate = prevAuto;
        r.shadowMap.needsUpdate = prevNeed;
        r.setRenderTarget(prevTarget);
        for (const o of toggled) o.frustumCulled = true;
      }

      // ②·补 LOD 廉价材质预热：临时把所有候选挂上廉价副本再 compile 一次，
      //   把"不接收阴影/关 IBL"的那套 program 也编掉，避免游戏中首次切到远处时当场编译卡顿。
      if (this._lodCands.length) {
        const prevMats = new Array(this._lodCands.length);
        for (let i = 0; i < this._lodCands.length; i++) {
          prevMats[i] = this._lodCands[i].mesh.material;
          this._lodCands[i].mesh.material = this._lodCheap(this._lodCands[i].base);
          this._lodCands[i].mesh.userData.__lodFar = false;
        }
        try { if (typeof r.compile === 'function') r.compile(this.scene, this.camera); } catch (e2) { /* 忽略 */ }
        for (let i = 0; i < this._lodCands.length; i++) this._lodCands[i].mesh.material = prevMats[i];
      }

      // ③ 超分那套（HalfFloat RT + 锐化着色器）平时要等自适应把分辨率压下去才第一次建，
      //    第一帧会同时吃「分配 RT + 编锐化程序」两笔开销 → 表现为"某次掉帧特别深"。
      //    这里提前备好：程序用 compile 编掉（不真渲染，不会闪一帧黑屏）。
      if ((this._sharpen || 0) > 0.001 && typeof this._ensureUpscale === 'function') {
        this._ensureUpscale();
        if (this._upScene && typeof r.compile === 'function') r.compile(this._upScene, this._upCam);
        const prevScale = this._dynScale;
        this._dynScale = 0.7; // 用一个"一定会走超分"的系数把 RT 真建出来（换系数时会自动 dispose 旧的）
        try { if (typeof this._ensureRT === 'function') this._ensureRT(); } finally { this._dynScale = prevScale; }
      }
      } catch (e) {
      console.warn('[Game] 着色器预热失败（忽略，退回运行时编译）:', e);
    }
  }

  // ============ 距离分级材质 LOD（填充率优化）============
  // 收集场景里所有"不透明 MeshStandardMaterial"网格作为候选（排除透明/天空/线/精灵/UI）。
  // 中心用世界坐标的 XZ 缓存，静态建筑只算一次。
  _scanLodCandidates() {
    this._lodCands.length = 0;
    this._cheapCache.clear();
    const tmp = new THREE.Vector3();
    this.scene.traverse((o) => {
      if (!o.isMesh) return;
      const m = o.material;
      if (!m || !m.isMeshStandardMaterial || m.transparent) return; // 天空(Basic)/精灵/线/透明 UI 自然排除
      if (o.userData && o.userData.__noLod) return;
      o.updateWorldMatrix(true, false);
      let bs = o.geometry && o.geometry.boundingSphere;
      if (!bs || !isFinite(bs.radius)) { o.geometry.computeBoundingSphere(); bs = o.geometry.boundingSphere; }
      if (!bs || !isFinite(bs.radius)) return;
      tmp.copy(bs.center).applyMatrix4(o.matrixWorld); // 世界中心
      this._lodCands.push({ mesh: o, base: m, cx: tmp.x, cz: tmp.z });
    });
  }

  // 拿 base 的廉价副本：关 receiveShadow + 关 envMapIntensity（远处这两者贡献≈0，见 perf JSON E1/E4）。
  // 按 base.uuid 缓存 → 同一份基础材质的所有网格共享一个副本，材质程序也只编译一次。
  _lodCheap(base) {
    let c = this._cheapCache.get(base.uuid);
    if (c) return c;
    c = base.clone();
    c.receiveShadow = false;   // 主 pass 少一次阴影采样（阴影才是远处 LOD 的主要省帧来源）
    // ⚠ 不再把 envMapIntensity 归零：远处金属/光滑物体一旦失去 IBL 反射会明显变暗发黑，
    //   而 perf E4 实测「关 IBL」只省 ~0.3fps（收益可忽略、视觉代价大），故保留 IBL 反射。
    c.needsUpdate = true;
    this._cheapCache.set(base.uuid, c);
    return c;
  }

  // 每 6 帧评估一次：远处挂廉价副本、近处还原原材质。__lodFar 标记避免重复赋值。
  _updateLod(camPos) {
    if (!this._lodOn || !camPos) return;
    // 兜底：若预热期世界还没建好导致候选为空，首次评估时补扫一次（之后 _lodCands 非空就跳过）
    if (this._lodCands.length === 0) this._scanLodCandidates();
    if (this._lodCands.length === 0) return;
    this._lodFrame = (this._lodFrame + 1) % 6;
    if (this._lodFrame !== 0) return;
    const d2 = this._lodDist * this._lodDist;
    for (let i = 0; i < this._lodCands.length; i++) {
      const e = this._lodCands[i];
      const dx = e.cx - camPos.x, dz = e.cz - camPos.z;
      const far = (dx * dx + dz * dz) > d2;
      const isFar = e.mesh.userData.__lodFar === true;
      if (far && !isFar) {
        e.mesh.userData.__lodFar = true;
        e.mesh.material = this._lodCheap(e.base);
      } else if (!far && isFar) {
        e.mesh.userData.__lodFar = false;
        e.mesh.material = e.base;
      }
    }
  }

  // 切画质档时调用：high 关 LOD 并把所有已切换的网格还原原材质；low/mid 开。
  _setLod(on) {
    const was = this._lodOn;
    this._lodOn = on;
    if (!on && was) {
      for (let i = 0; i < this._lodCands.length; i++) {
        const e = this._lodCands[i];
        if (e.mesh.userData.__lodFar) { e.mesh.userData.__lodFar = false; e.mesh.material = e.base; }
      }
    }
  }

  // 世界重建（进了新一局 / 编辑器重新生成场景）后调用：重新登记候选并立即按当前档位评估一次。
  // ⚠ 不清空 _cheapCache —— 基础材质副本可跨局复用（几何/贴图引用共享，不泄漏）。
  _rescanLod() {
    this._scanLodCandidates();
    this._updateLod(this.camera ? this.camera.position : null);
  }

  _renderFrame() {
    // 点光源阴影名额：按「离相机最近」分配（最多 4 盏，见 Lights.js）。
    // 只在渲染前跑一次，成本是几十个灯的距离排序；数量恒定所以不会触发 shader 重编译。
    updateShadowBudgets(this.camera.position);
    // 兜底：若加载期没编译完（异常路径），首帧在这里一次性预编译，避免游戏中边走边卡
    if (!this._shadersCompiled) this._precompileShaders();
    // 距离分级：远处物体不投影、更远整块隐藏（内部 300ms 节流）。
    // 对战中城市建筑已整组隐藏，这边不再插手（否则会把它们设回可见，与对战隐藏打架）。
    if (!this._combat) updateLod(this.camera.position);
    const up = this._useUpscale() && this._ensureUpscale() && this._ensureRT();
    if (!up) {
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.camera);
      this._sceneCalls = this.renderer.info.render.calls;
      this._sceneTris = this.renderer.info.render.triangles;
      return;
    }
    this.renderer.setRenderTarget(this._upRT);
    this.renderer.render(this.scene, this.camera);
    // 立刻取走场景那一趟的统计：下一趟升采样会重置 renderer.info
    this._sceneCalls = this.renderer.info.render.calls;
    this._sceneTris = this.renderer.info.render.triangles;
    this.renderer.setRenderTarget(null);
    const u = this._upMat.uniforms;
    u.tDiffuse.value = this._upRT.texture;
    u.uSharp.value = this._sharpen || 0;
    u.uTexel.value.set(1 / this._upRT.width, 1 / this._upRT.height);
    this.renderer.render(this._upScene, this._upCam);
  }

  // 自适应分辨率：按实测真实帧率动态调整 pixelRatio。
  // 老卡/入门卡（如 640 级）是真·填充率瓶颈，画面分辨率是唯一有效杠杆 ——
  // 与其让用户手动调画质档，不如自动保帧率：掉帧就降，富余就慢慢升回。
  // 节流 1s：改 pixelRatio 会重建 drawingBuffer，频繁做本身会卡，但 1s 足够跟手又不抖。
  //
  // ⚠ 地板 0.5 是实测定的（见 fpm-perf-20261006-102317.json）：GT640 上
  //   0.5× → 49.4fps（对比 1.0× 的 18.2，2.7×）；再低画面发虚、且 0.5 已把
  //   像素量砍到 1/4，继续降收益递减、锯齿/噪点反而更扎眼。故锁 0.5。
  // ⚠ DROP/RAISE 之间留 12 帧迟滞：避免"刚降到 44 又升回、升到 55 又降"的横跳。
  _adaptResolution(fps) {
    if (this._autoScale === false) return; // 用户手钉了分辨率，不再自动干预
    const now = performance.now();
    if (now - this._dynLast < 1000) return;
    const FLOOR = 0.5;   // 实测甜点（E5）：再低不划算
    const DROP = 42;     // 低于此帧率就降（留余量，别等卡到 30 才动）
    const RAISE = 54;    // 高于此才升回（与 DROP 拉开迟滞，防横跳）
    let s = this._dynScale;
    if (fps < DROP && s > FLOOR) s = Math.max(FLOOR, s - 0.15);
    else if (fps > RAISE && s < 1) s = Math.min(1, s + 0.08);
    else return;
    if (Math.abs(s - this._dynScale) < 0.01) return;
    this._dynScale = s;
    this._dynLast = now;
    this._applyRenderScale();
  }

  _updatePerfHud(dt, physMs, renderMs, totalMs) {
    const p = this._perf;
    if (!p) return;
    p.frames++;
    p.phys += physMs; p.render += renderMs; p.acc += totalMs; p.t += dt;
    if (p.t < 0.25) return; // 每 0.25 秒刷新一次，避免读屏本身影响测量
    const n = Math.max(1, p.frames);
    const frame = p.acc / n;
    const phys = p.phys / n;
    const rend = p.render / n;
    // 真实帧率：帧数 ÷ 真实流逝时间（rAF 间隔），受屏幕 vsync 封顶（60/120Hz）。
    // 之前用 1000/CPU耗时 是「CPU 吞吐」，GPU 卡住时它照样显示 500+，有误导性；
    // CPU 耗时单独保留一列，两者对比正好能判断瓶颈在 CPU 还是 GPU。
    const fps = p.t > 0 ? n / p.t : 0;
    p.frames = 0; p.phys = 0; p.render = 0; p.acc = 0; p.t = 0;

    // 碰撞体规模：判断「卡」是不是真的来自碰撞（复杂建筑的数量与三角形总数）
    let boxes = 0, hulls = 0, tms = 0, tris = 0, meshCount = 0;
    for (const c of this.colliders) {
      if (!c) continue;
      if (c.type === 'trimesh') { tms++; tris += c.triCount || 0; meshCount += c.meshCount || 0; }
      else if (c.type === 'convex') hulls++;
      else boxes++;
    }
    const txt =
      'FPS ' + fps.toFixed(0).padStart(3) +
      '   CPU ' + frame.toFixed(1) + ' ms\n' +
      '物理 ' + phys.toFixed(2) + ' ms   渲染 ' + rend.toFixed(2) +
      ' ms   其他 ' + Math.max(0, frame - phys - rend).toFixed(2) + ' ms\n' +
      '碰撞体 盒' + boxes + ' 凸包' + hulls + ' trimesh' + tms +
      '   三角形 ' + tris.toLocaleString() + '\n' +
      '绘制 ' + (this._sceneCalls || 0) + ' 次   三角面 ' +
      (this._sceneTris || 0).toLocaleString() + '\n' +
      // 实际渲染缓冲的像素数：窗口小时若它也跟着变小、而 FPS 明显回升，
      // 配合这一格就能判断是「我们画得太满」还是「显示链路按像素限速」。
      '缓冲 ' + (this.renderer.domElement.width || 0) + '×' + (this.renderer.domElement.height || 0) +
      '   内部 ' + (this._dynScale || 1).toFixed(2) + '×' +
      (this._useUpscale() ? ' 超分锐化' + (this._sharpen || 0).toFixed(1) : '') + '\n' +
      'GPU ' + this._gpuName() + (this._gpuIsSoftware ? '  ⚠软件渲染·请开硬件加速' : '');
    if (txt !== p.txt) { p.el.textContent = txt; p.txt = txt; }
  }

  // ============ 常驻帧数角标（右上角）============
  // 与 #perf 那套「完整诊断 HUD」不同：这里只要一个数字，默认可见、可关（设置项 showFps）。
  // 开销极小：复用主循环里已经算好的 _fpsAcc/_fpsN，不额外采样。
  _createFpsBadge() {
    const el = document.createElement('div');
    // ⚠ 位置避开右上角：那里从上到下是「对战匹配」按钮(top:10px) + 对战状态条(top:56px)，
    //   右上角放帧数对战时必被挡住。改贴左上角、校卡下方（校卡居中 50%、高约 44px，
    //   顶部按钮行从 left:184px 起，左边缘整片空着）。pointer-events:none 保证不挡触控。
    el.style.cssText =
      'position:fixed;top:calc(env(safe-area-inset-top, 0px) + 6px);' +
      'left:calc(env(safe-area-inset-left, 0px) + 8px);z-index:9400;' +
      'pointer-events:none;font:600 12px/1.2 ui-monospace,Menlo,Consolas,monospace;' +
      'padding:3px 7px;border-radius:6px;color:#9df5bd;background:rgba(0,0,0,.55);' +
      'border:1px solid rgba(157,245,189,.3);text-shadow:0 1px 2px rgba(0,0,0,.8);' +
      'font-variant-numeric:tabular-nums;white-space:nowrap;';
    el.textContent = '-- FPS';
    el.style.display = 'none'; // 先藏，等首帧算出帧率再显示
    document.body.appendChild(el);
    return { el, txt: '', shown: false };
  }

  _updateFpsBadge(fps) {
    const b = this._fpsBadge;
    if (!b) return;
    const n = Math.round(fps);
    // 颜色分级：>=55 绿（流畅）/ >=30 黄（可接受）/ 其余红（卡）
    const color = n >= 55 ? '#9df5bd' : (n >= 30 ? '#ffd76a' : '#ff8a8a');
    const txt = n + ' FPS';
    if (txt !== b.txt) { b.el.textContent = txt; b.txt = txt; }
    // 数字与边框都按档位着色（一眼看出流畅/可接受/卡）
    b.el.style.color = color;
    b.el.style.borderColor = color;
    if (!b.shown) { b.el.style.display = ''; b.shown = true; }
  }

  // 左下角血量条：数值 + 横条，满血绿色、越低越红
  _createHealthBar() {
    const coarse = !!this._coarsePointer; // 触屏判定统一在构造函数里算一次
    const box = document.createElement('div');
    box.className = 'hp-box'; // 供手机端「按键布局调整」定位与检查
    // PC 维持左下角；手机端挪到「屏幕下方正中」——左右两侧是摇杆与跳跃/攻击键的势力范围，
    // 底部中间是唯一空着的带状区域，横条形状放这里也最自然（不窄不挤、双手拇指都够不着）。
    // 用 left:50% + translateX(-50%) 居中：布局系统按中心点比例存取（placeWithRatio 会把
    // transform 置 none 并改写 left/top），所以拖动过的用户仍能自由摆放，未拖动的走这里的居中默认值。
    box.style.cssText = coarse
      ? 'position:fixed;left:50%;transform:translateX(-50%);' +
        'bottom:calc(env(safe-area-inset-bottom, 0px) + 8px);z-index:53;width:min(300px,62vw);' +
        'font:12px/1.3 var(--kui-font);color:var(--kui-paper);user-select:none;pointer-events:none;' +
        'text-shadow:0 1px 3px rgba(0,0,0,.6);'
      : 'position:fixed;left:18px;bottom:22px;z-index:53;width:min(240px,42vw);' +
        'font:12px/1.3 var(--kui-font);color:var(--kui-paper);user-select:none;pointer-events:none;';
    const row = document.createElement('div');
    // 手机端血条移到屏幕下方正中，背景可能是任意 3D 画面 → 加一层半透明底衬保证可读。
    // PC 端在左下角、原本没有底衬，保持原样不动。
    row.style.cssText = coarse
      ? 'display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:4px;' +
        'padding:3px 10px;border-radius:999px;' +
        'background:color-mix(in srgb, var(--kui-ink) 55%, transparent);' +
        'text-shadow:0 1px 2px rgba(0,0,0,.7);'
      : 'display:flex;justify-content:space-between;margin-bottom:4px;text-shadow:0 1px 3px rgba(0,0,0,.6);';
    const label = document.createElement('span');
    label.textContent = '生命';
    const num = document.createElement('span');
    num.textContent = Config.HEALTH_MAX + ' / ' + Config.HEALTH_MAX;
    row.appendChild(label);
    row.appendChild(num);
    // 进度条外观交给主题类；高度仍用内联保持原尺寸，填充色由 _updateHealthBar 按血量动态写入
    const track = document.createElement('div');
    track.className = 'kui-bar';
    // 手机端与上方圆角文字条同一套圆角/底衬，避免「圆角数字 + 直角进度条」拼在一起显得不搭
    track.style.cssText = coarse
      ? 'height:10px;border-radius:999px;overflow:hidden;'
      : 'height:10px;';
    const fill = document.createElement('div');
    fill.className = 'kui-bar__fill';
    fill.style.cssText = 'width:100%;background:var(--kui-ok);transition:width .18s ease,background .18s ease;';
    track.appendChild(fill);
    box.appendChild(row);
    box.appendChild(track);
    document.body.appendChild(box);
    this._hpBox = box; // 建造模式要把血条整块换成家具条 → 需要句柄
    this._hpNum = num;
    this._hpFill = fill;
  }

  // 刷新血量条显示
  _updateHealthBar() {
    if (!this._hpFill) return;
    const max = Config.HEALTH_MAX;
    const hp = Math.max(0, Math.min(max, Math.round(this.localState.health)));
    const ratio = hp / max;
    this._hpFill.style.width = (ratio * 100).toFixed(1) + '%';
    // 三档配色走语义变量（--kui-ok / --kui-warn / --kui-danger），别再写死 Material 色
    this._hpFill.style.background = ratio > 0.5 ? 'var(--kui-ok)' : (ratio > 0.2 ? 'var(--kui-warn)' : 'var(--kui-danger)');
    this._hpNum.textContent = hp + ' / ' + max;
  }

  // 扣血/回血（正数回血、负数扣血）；到 0 触发死亡重生
  _changeHealth(delta) {
    const max = Config.HEALTH_MAX;
    const next = Math.max(0, Math.min(max, this.localState.health + delta));
    this.localState.health = next;
    this._updateHealthBar();
    if (next <= 0 && !this._dead) this._die();
  }

  // 死亡：锁住操控；对战中记战绩并转观战（训练场则延迟复活），大厅里延迟重生回出生点
  _die() {
    this._dead = true;
    // 死了就立刻收掉「抓钩无视碰撞」，别让倒地后的这一帧还穿墙
    if (this.localPlayer && this.localPlayer.physics) this.localPlayer.physics.noClip = false;
    this._setChatLock(true); // 名字叫「聊天锁」，实际锁的是移动（physics.controlLock）
    if (this._soul) this._soul = null; // 死亡先收回灵魂，避免相机卡在自由飞行
    const c = this._combat;
    if (c) {
      this._noteLocalDeath(); // 记阵亡时刻 + 广播（含击杀归因）
      if (c.solo) {
        // 训练场没有对手，死了就爬起来接着练（和主世界一致）
        this._toast('你被击倒了，即将在训练场重生');
        setTimeout(() => this._respawn(), Config.RESPAWN_DELAY * 1000);
        return;
      }
      // 匹配：弹「阵亡」后转观战。**不退房** —— 要留在房里等这局分出胜负，
      // 否则「活到最后者胜」永远等不到那个结果，输赢也就无从谈起。
      this._showFailText('阵亡');
      this._enterSpectate();
      return;
    }
    this._toast('你被击倒了，即将在出生点重生');
    setTimeout(() => this._respawn(), Config.RESPAWN_DELAY * 1000);
  }

  // 出生点高度换算：spawn.y 是「脚底」高度（抓钩模式的起始平台顶面 = 6m），
  // 而 localState.y 存的是「玩家顶部 / 相机高度」= 脚底 + 身高。
  // ⚠️ 首次进场与阵亡重生**必须**共用这一套换算：只按地面高度放人时，
  //    抓钩模式（唯一出生点高于地面的模式）重生会直接落在岩浆面上 → 死 → 重生 → 死循环。
  _feetToTop(spY) {
    const lift = Config.PLAYER_HEIGHT * this.localPlayer.physics.sizeScale;
    return (Number.isFinite(spY) ? spY : 0) + lift;
  }

  // 重生：满血、清速度，回到服务器分配的出生点
  _respawn() {
    const sp = this._spawn || { x: 0, y: 0, z: 0, yaw: 0 };
    if (this.localState.ride) this._dismountVehicle(); // 死亡时若在车上，先下车
    this.localState.health = Config.HEALTH_MAX;
    this.localState.x = sp.x;
    this.localState.z = sp.z;
    this.localState.yaw = sp.yaw || 0;
    this.localState.y = this._feetToTop(sp.y);
    this.localPlayer.physics.velocity.set(0, 0, 0);
    this._dead = false;
    // 训练场里复活后要重新算作「活着」，否则状态条会一直挂着 0 人
    const c = this._combat;
    if (c && c.solo) {
      const me = this._matchStats.get(String(this.localState.id));
      if (me) { me.alive = true; me.diedAt = null; }
    }
    this._setChatLock(false);
    this._updateHealthBar();
    this._toast('已在出生点重生');
  }

  // 一天比例（0~1）的最短弧线性插值：处理跨零点（0.95→0.05 应走 +0.1 而非 -0.9）
  _lerpDay(a, b, t) {
    let d = b - a;
    while (d > 0.5) d -= 1;
    while (d < -0.5) d += 1;
    return ((a + d * t) % 1 + 1) % 1;
  }
  // 两个一天比例之间的最短弧距离（0~0.5）
  _circularDayDist(a, b) {
    let d = Math.abs(b - a) % 1;
    return d > 0.5 ? 1 - d : d;
  }
  _smoothstep(t) { return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t); }

  // 昼夜循环推进：0 = 午夜、0.5 = 正午。太阳高度角与强度、环境光/半球光、
  // 天空亮度与夜空贴图都随时间连续变化；关闭时保持编辑器设计的光照。
  _updateDayNight(dt) {
    if (!this._dayEnabled) return;

    // 时间来源：联机时以服务器快照里的世界时刻为准（帧间用服务器同一周期外推，所有人一致）；
    // 未联机时本地按设置里的「一昼夜时长」推进。最后叠加本地预览偏移。
    let base;
    if (this._netDayTime !== null) {
      const elapsed = (performance.now() - this._netDayAt) / 1000;
      const target = (this._netDayTime + elapsed / Game.SYNC_DAY_SECONDS) % 1;
      // ⚠ 进服/重连/重进房间时，本地显示时刻（多半在正午附近）与服务器权威时刻可能相差很大。
      // 若直接采用 target，太阳/环境光/半球光/背景强度会整屏同时突变 → 即"突然变很暗"。
      // 改为：相差超过阈值时启动几秒平滑过渡，期间按最短弧从本地时刻滑向服务器时刻。
      if (this._netDayBlending) {
        this._dayBlendT = Math.min(1, this._dayBlendT + dt / Game.DAY_SYNC_BLEND);
        base = this._lerpDay(this._dayBlendFrom, target, this._smoothstep(this._dayBlendT));
        if (this._dayBlendT >= 1) this._netDayBlending = false;
      } else if (this._circularDayDist(this._dayTime, target) > Game.DAY_SYNC_JUMP) {
        this._dayBlendFrom = this._dayTime;
        this._dayBlendT = 0;
        this._netDayBlending = true;
        base = this._dayBlendFrom; // 首帧保持当前，下一帧起平滑滑出
      } else {
        base = target;
      }
    } else {
      base = (this._dayTime + dt / this._dayCycle) % 1;
    }
    this._dayTime = base;
    const t = ((base + this._dayOffset) % 1 + 1) % 1; // 叠加本地偏移后的实际时刻

    const s = Math.sin((t - 0.25) * Math.PI * 2); // -1（午夜）~ 1（正午）
    const sunUp = Math.max(0, s);
    const off = computeSunOffset(s * 90, this._dayAzDeg);
    this._sunOffset.set(off.x, off.y, off.z);
    this._sun.intensity = this._dayBaseSun * sunUp;
    this._ambient.intensity = this._dayBaseAmbient * (0.3 + 0.7 * sunUp);
    this._hemi.intensity = this._dayBaseHemi * (0.25 + 0.75 * sunUp);
    // 兜底背景色日落后压暗（时段天空球壳正常覆盖时看不见它）
    if ('backgroundIntensity' in this.scene) {
      this.scene.backgroundIntensity = sunUp;
    }

    // 时段天空盒：按当前时刻选图并交叉淡入，同时跟随相机（无视差、不被裁剪）
    if (this._timeSky) this._timeSky.update(t, this.camera);

    // 校卡上的时间（0 = 00:00，0.5 = 12:00）：只在整分钟变化时写 DOM
    const mins = Math.floor(t * 1440);
    const text = String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0');
    if (text !== this._hudTimeText) {
      this._hudTimeText = text;
      if (this.playerHUD && this.playerHUD.setTime) this.playerHUD.setTime(text);
    }

    // 用户摆放光源的「开启时段」：按当前时刻自动开关灯（路灯天黑亮、白炽灯夜里亮等）
    this._applyEditorLightDayState(t);
  }

  // ---- 手电筒：沿相机视线方向（含俯仰）照射，L 键开关 ----
  _initFlashlight() {
    if (this._flash) return;
    // 暖白光锥：半角 30°，半影 0.35，射程 100m，decay 1.2（比物理 2 软，远处也够亮）。
    // 强度按现有光照量级调：three r170 是物理光照（SpotLight 强度单位为 candela），
    // 衰减随距离上升，11cd 在 10~15m 处已接近 0，夜里根本看不见 → 提到 60cd 保证「有光」。
    const fl = new THREE.SpotLight(0xfff2cc, 0, 100, Math.PI / 6, 0.35, 1.2);
    fl.castShadow = false; // 默认不投影：夜里氛围靠光锥打在墙面/地面即可，投影另开成本高
    fl.visible = false;
    // 挂在相机上：光照方向 = 相机视线，自动跟随位置与朝向（含俯仰），
    // 由 three 渲染管线同步 worldMatrix，无需每帧手动填世界坐标。
    // 旧实现每帧 cam.getWorldPosition + getWorldDirection 手填，相机矩阵未刷新时会退化成
    // 零向量/重合点 → 光锥方向退化 → 整灯不亮（表现为「按了没光」）。挂相机子节点彻底规避。
    this.camera.add(fl);
    fl.position.set(0, 0, 0.15); // 略前移，避免与眼睛精确重合
    this.camera.add(fl.target);
    fl.target.position.set(0, 0, -1); // 相机本地坐标：正前方 1m
    fl.target.updateMatrixWorld();
    // 相机加入场景图：确保其 worldMatrix（及子光源）在渲染前被 scene.updateMatrixWorld 更新
    if (this.camera.parent !== this.scene) this.scene.add(this.camera);
    this._flash = fl;
    this._flashDir = new THREE.Vector3(0, 0, -1);
    this._flashOn = false;
    this._flashMax = 60; // 开灯强度（candela，可调）
    // 调试浮层（仅 ?flashdbg 时）：实时打印 owned/可见/强度/世界坐标，定位「没光」到底是没开还是渲染问题
    if (location.search.indexOf('flashdbg') >= 0) {
      const d = document.createElement('div');
      d.id = 'flashdbg';
      d.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99999;background:rgba(0,0,0,.72);color:#3f6;font:12px/1.5 monospace;padding:6px 9px;border-radius:6px;white-space:pre;pointer-events:none';
      document.body.appendChild(d);
      this._flashDbg = d;
      this._flashDbgV = new THREE.Vector3();
      this._flashDbgT = new THREE.Vector3();
    }
  }

  _toggleFlashlight() {
    if (!this._flash) return;
    // 防御：任何路径触发前都确认拥有（在小满的杂货铺买过），避免被免费调起
    if (!isOwned(this._profile, 'flashlight')) {
      this._toast('手电筒要先去小满的杂货铺买（喷泉边找小满）');
      return;
    }
    this._flashOn = !this._flashOn;
    this._flash.visible = this._flashOn;
    if (this._flashOn) this._flash.intensity = this._flashMax;
    this._toast(this._flashOn ? '手电筒 已开（再按一次关）' : '手电筒 已关');
  }

  _updateFlashlight() {
    // 手电筒已作为相机子节点，跟随位置/朝向由 three 渲染管线自动处理，无需手动同步世界坐标
    // （旧逻辑每帧 cam.getWorldPosition + getWorldDirection 手填，相机矩阵未刷新时会退化成零向量
    //  → 光锥方向退化 → 整灯不亮；且与「挂相机子节点」的局部坐标冲突，必须弃用）。
    // 这里仅做强度兜底：开启后若强度被别处重置，重新拉回 _flashMax。
    if (this._flash && this._flash.visible && this._flash.intensity !== this._flashMax) {
      this._flash.intensity = this._flashMax;
    }
    // 调试浮层
    if (this._flashDbg) {
      this._flash.getWorldPosition(this._flashDbgV);
      this._flash.target.getWorldPosition(this._flashDbgT);
      const prof = this._profile ? (this._profile.username || this._profile.nickname || '?') : 'NULL';
      this._flashDbg.textContent =
        'FLASH dbg (vis=' + this._flash.visible + ' I=' + this._flash.intensity + ')\n' +
        'owned=' + isOwned(this._profile, 'flashlight') + '  prof=' + prof + '\n' +
        'pos=' + this._flashDbgV.x.toFixed(1) + ',' + this._flashDbgV.y.toFixed(1) + ',' + this._flashDbgV.z.toFixed(1) + '\n' +
        'tgt=' + this._flashDbgT.x.toFixed(1) + ',' + this._flashDbgT.y.toFixed(1) + ',' + this._flashDbgT.z.toFixed(1) + '\n' +
        'lightInScene=' + (this.scene.getObjectById(this._flash.id) != null);
    }
  }

  // 按当前时刻开关编辑器摆放的光源。tf 为一天的比例（0=00:00，0.5=12:00）；
  // 传 null 表示「无时刻概念」（昼夜循环关闭）→ 全部按常亮处理。
  // 每盏灯的开关窗口由 EditorBuildings.buildEditorLights 存在 userData.__onWindow 上。
  _applyEditorLightDayState(tf) {
    const grp = this.scene && this.scene.userData ? this.scene.userData.__editorLights : null;
    if (!grp) return;
    const hours = (tf === null || tf === undefined) ? null : ((tf * 24) % 24 + 24) % 24;
    for (const light of grp.children) {
      const win = light.userData ? light.userData.__onWindow : null;
      const on = (!win || tf === null || tf === undefined) ? true : lightIsOn(win, hours);
      if (light.isRectAreaLight) {
        // 面光源必须走 setAreaBaseIntensity：亮度被拆成本体 + 阴影代理两份，
        // 直接写 light.intensity 会让基准值失真（下次同步就越调越暗）。
        setAreaBaseIntensity(light, on ? (light.userData.__onBase || 0) : 0);
      } else {
        light.intensity = on ? (light.userData.__baseIntensity || 0) : 0;
      }
    }
  }

  // 窗口尺寸变化时更新相机纵横比和渲染器尺寸
  _onResize() {
    // 用可视视口（visualViewport）而不是 innerWidth/Height：iOS 上后者含地址栏，
    // 会让 canvas 与用户实际看到的区域不一致
    const vv = window.visualViewport;
    const w = vv && vv.width ? vv.width : window.innerWidth;
    const h = vv && vv.height ? vv.height : window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // dpr 封顶跟随画质档，再乘自适应/手动系数（缩放/切画质档后都不能把它丢了）
    this._applyRenderScale(w, h); // 传尺寸 → 连 CSS 一起更新，避免窗口缩放后画布被拉伸
  }

  // 画质档：聚合控制阴影贴图分辨率 / dpr 封顶 / 阴影采样类型，一键降级提帧。
  // 在画面设置面板初始化与改动时都会被调用（bind 'quality'）；默认 'mid'。
  _applyQuality(q) {
    // ⚠ pointShadow = 允许几盏**点光源**投影。这是阴影成本的最大乘数：
    //   每盏点光源 = cube 6 面 = 6 趟全场景投影，30Hz 重渲。
    //   4 盏 ≈ 每秒 3.6~4.5 万次 draw call 纯为阴影，**且不受 renderScale 影响** ——
    //   这就是"分辨率拉到最低还是卡 / 一靠近建筑就卡"的地板。
    //   低档直接 0（只留太阳阴影），中档 1（保身边最近那盏），高档 3。
    const presets = {
      high: { shadowSize: 2048, dpr: 2, type: THREE.PCFSoftShadowMap, pointShadow: 3 },
      mid: { shadowSize: 1024, dpr: 1.5, type: THREE.PCFShadowMap, pointShadow: 1 },
      low: { shadowSize: 512, dpr: 1, type: THREE.BasicShadowMap, pointShadow: 0 },
    };
    const p = presets[q] || presets.mid;
    // ⚠ 会触发一次全场景材质重编译（shader 里的 numPointLightShadows 变了）——
    //   所以只在切画质档时调，别放进每帧路径。
    try { setMaxPointShadow(p.pointShadow); } catch (e) { /* 老版本没有这个导出时忽略 */ }
    if (this._sun && this._sun.shadow) {
      this._sun.shadow.mapSize.set(p.shadowSize, p.shadowSize);
      if (this._sun.shadow.map) {
        this._sun.shadow.map.dispose();
        this._sun.shadow.map = null; // 强制用新分辨率重建
      }
    }
    this._qualityDpr = p.dpr;
    this._quality = q; // 供 _autoStartScale 按档取起点
    // 距离分级材质 LOD：high 关（原材质最保真），low/mid 开（远处换廉价副本砍片元成本）
    this._setLod(q !== 'high');
    // 画质档变了：自动模式从一个更低的起点重新探测（弱档开局就给 0.7~0.85×，
    //   跳过"1.0× 只有 ~18fps、自适应爬 5 秒才降到甜点"的卡顿观感）；手动模式保留用户钉的比例。
    //   主意：起点不是越低越好——太低会先糊一帧再升回，0.7/0.85 是"开局即接近稳态"的折中。
    if (this._autoScale !== false) this._dynScale = this._autoStartScale();
    this.renderer.shadowMap.type = p.type;
    this.renderer.shadowMap.needsUpdate = true; // 类型变了要重渲
    // 用统一入口落 dynScale（含超分 RT 复用判据），替代手写 setPixelRatio/setSize
    this._applyRenderScale();
  }

  // 设置面板里「清除模型缓存」：清掉本机那份 GLB/天空贴图缓存，下次进游戏重新下载
  // （换过模型 / 想腾空间时用；清空后本次会话内已加载的模型不受影响，下一局才重新拉取）
  async _clearAssetCache() {
    try {
      const ok = await clearAssetCache();
      console.log('[asset] 模型缓存已清除:', ok);
    } catch (e) {
      console.warn('[asset] 清除模型缓存失败:', e);
    }
  }

  // 处理服务器发来的消息（中继协议）
  _onNetworkMessage(msg) {
    switch (msg.t) {
      case 'auth': {
        // 服务端确认登录结果：刷新本地资料（昵称/颜色用于 HUD 与自己的名牌）
        if (msg.ok && msg.profile) {
          // 合并而非整体覆盖：这份 profile 来自 WS 鉴权（公开字段），不含登录记录（login），
          // 直接覆盖会把「本次/上次登录 IP 与时间」擦掉。
          this._profile = { ...this._profile, ...msg.profile };
          this.playerHUD.setProfile(msg.profile);
          this._refreshLocalLabel();
          this._syncBagFromCloud(); // 账号确定后（昵称/用户名到位）再同步一次背包
          if (this._buildTool) this._buildTool.refresh(); // 登录态变化后刷新可摆教学楼额度
        } else if (!msg.ok) {
          // 令牌失效：清掉本地会话，退回游客态（下次进入会重新弹登录）
          localStorage.removeItem('fp_token');
          this._profile = null;
          this.playerHUD.setProfile(null, false);
          this._refreshLocalLabel();
          setBagAccount(null, null); // 关掉云同步，别把游客包写到别人账号上
        }
        break;
      }
      case 'welcome': {
        // 确定本地 id，注册自己（模型隐藏），并加入服务器已存在的玩家
        const firstPlace = !this._placed; // 仅首次进入才用出生点；重连保留当前位置
        this.localState.id = msg.id;
        // 用服务端分配的出生点初始化本地位置/朝向，避免都堆在原点
        if (firstPlace) {
          this.localState.x = msg.spawn.x;
          this.localState.z = msg.spawn.z;
          this.localState.yaw = msg.spawn.yaw;
          this._placed = true;
        }
        this._spawn = msg.spawn; // 记住出生点，死亡重生时用
        this._lobbySpawn = msg.spawn; // 大厅出生点单独记一份，退出对战回主世界时用
        this.localState.num = msg.num; // 本地也要知道自己序号，保证第三人称看到的男女与别人看到的一致
        this.playerManager.setLocal(msg.id);
        // 本地名牌：登录了用昵称，否则游客样式
        const myNick = this._profile ? (this._profile.nickname || this._profile.username || `玩家${msg.num}`) : `玩家${msg.num}`;
        const myColor = this._profile ? (this._profile.nicknameColor || '#ffffff') : '#ffffff';
        this.playerManager.addPlayer(msg.id, this.localState, myNick, myColor, this._gender);
        for (const p of msg.players) {
          this.playerManager.addPlayer(p.id, p, p.nick || `玩家${p.num}`, p.color || '#ffffff');
        }
        // 服务器为准：移除不在当前在线列表中的远程模型/名牌（清除未加入或已断开连接的残留）
        this.playerManager.pruneTo(msg.players.map((p) => p.id));
        // 唤醒加载屏：至此玩家模型才刚发起加载，由 loadTracker 计数、调用方继续等归零
        this._resolveWelcomeWaiters();
        break;
      }
      case 'join': {
        // 训练场本机兜底（老服务端）：本机没进房间，别人进的是「大厅」，不该出现在竞技场里
        if (this._trainLocal) break;
        // 有新玩家加入：注册并显示模型（名牌用服务端下发的昵称/颜色）
        this.playerManager.addPlayer(msg.id, msg.state, msg.state.nick || `玩家${msg.state.num}`, msg.state.color || '#ffffff');
        // 如果本机是 Boss 的 owner，补发一次当前状态，让新玩家立刻看到老师
        if (this.boss) this.boss.broadcastNow();
        break;
      }
      case 'leave': {
        // 玩家断开：移除模型（leave 是删除的权威来源，立即生效，不吃快照缺席的宽限）
        this.playerManager.removePlayer(msg.id, 'leave 消息');
        // 对战中有人退房 = 出局（按「出局」，不是按「阵亡」记，结算里会区分显示）
        if (this._matchStats.has(String(msg.id))) this._markGone(msg.id);
        break;
      }
      case 'build': {
        // 玩家建造（教学楼）：服务端回执/广播的增删
        if (this._buildTool) this._buildTool.handleBuild(msg);
        break;
      }
      case 'chat': {
        // 别人的发言（同房间 / 同大厅）：昵称与颜色取服务端下发的那份，文本按纯文本显示
        if (this.chat) {
          this.chat.add({
            nick: msg.nick || '玩家',
            color: msg.color || '#ffffff',
            text: String(msg.text || ''),
          });
        }
        break;
      }
      case 'snapshot': {
        // 周期快照：同步远程玩家（本地由 applySnapshot 内部跳过）+ 世界时刻
        if (typeof msg.time === 'number') {
          this._netDayTime = msg.time;   // 服务器权威时间
          this._netDayAt = performance.now();
        }
        // 训练场本机兜底（老服务端）：此时本机没进房间，快照是「大厅」的，套进来会让
        // 大厅玩家凭空出现在竞技场里，所以直接跳过。
        if (!this._trainLocal) this.playerManager.applySnapshot(msg.players);
        // 对战中：人数即「同场人数」，供对战状态条显示
        if (this._combat) this._combat.alive = (msg.players || []).length;
        // 战绩：别人（和观战前的自己）的血量到 0 就是阵亡，时刻按本机时钟记
        if (this._combat) this._syncAliveFromSnapshot(msg.players || []);
        break;
      }
      case 'hit': {
        // 别人用投掷物打中了我：扣血（伤害已由服务端钳制），并记下是谁打的——
        // 这是唯一能让阵亡者知道「谁补的最后一击」的来源，用于结算里的击杀归因。
        const dmg = Number(msg.damage) || 0;
        if (dmg > 0 && !this._dead) {
          this._lastHitBy = msg.from ? String(msg.from) : null;
          this._lastHitAt = performance.now();
          this._changeHealth(-dmg);
          this._toast('受到 ' + dmg + ' 点伤害');
        }
        break;
      }
      case 'died': {
        // 有人阵亡（由阵亡者自己的客户端上报）：记战绩 + 播一行提示（等价于「击杀播报」）
        this._onRemoteDied(msg);
        break;
      }
      case 'fx': {
        // 被别人投掷物的范围效果覆盖：在本机直接生效
        this._applyEffect(msg.effect);
        this._toast('受到范围效果：' + this._describeEffect(msg.effect));
        break;
      }
      case 'knock': {
        // 被别人的棍子扫到：由本机给自己施加击飞（冲量来自挥棍的人）
        this._applyKnock(msg);
        break;
      }
      case 'ctrl': {
        // 控制枪：别人抓住我 / 松开我
        this._applyCtrlMsg(msg);
        break;
      }
      case 'bh': {
        // 别人扔的黑洞：投掷者已经算完飞行，这里直接在落点摆一个同样的黑洞
        this._spawnRemoteBlackHole(msg);
        break;
      }
      case 'hide': {
        // 别人的捉迷藏事件：开始 / 方向提示 / 结束
        this._onHideNet(msg);
        break;
      }
      case 'shot': {
        // 别人的加特林开了一枪：在同一位置复刻一颗子弹，并让他手里的枪管转起来
        this._onRemoteShot(msg);
        break;
      }
      case 'grapple': {
        // 别人的抓钩：甩出 / 收回
        this._onRemoteGrapple(msg);
        break;
      }
      case 'proj': {
        // 别人扔了一颗投掷物：复刻一颗只播画面的小球
        this._spawnRemoteProjectile(msg);
        break;
      }
      case 'boss': {
        // 别人的「老师」事件：召唤 / 位姿 / 弹幕 / 伤害 / 死亡
        if (this.boss) this.boss.netEvent(msg);
        break;
      }
      case 'boom': {
        // 别人的投掷物炸了：先把他那颗小球悄悄收掉，再在同一位置播爆炸特效
        const rid = String(msg.id || '');
        for (let i = this._projectiles.length - 1; i >= 0; i--) {
          const pr = this._projectiles[i];
          if (pr.visualOnly && pr.id === rid) {
            this._releaseProjMesh(pr.mesh);
            this._projectiles.splice(i, 1);
          }
        }
        const bx = Number(msg.x);
        const by = Number(msg.y);
        const bz = Number(msg.z);
        if ([bx, by, bz].every(Number.isFinite)) {
          this._playExplosion(new THREE.Vector3(bx, by, bz), Number(msg.radius) || 3, Number(msg.damage) || 0);
        }
        break;
      }
      case 'match_queued': {
        // 已进入匹配队列：显示「匹配中…」浮层
        const name = (COMBAT_MODES[this._matchMode] || COMBAT_MODES.meteor).name;
        this._showMatchOverlay('匹配中…', '正在为你寻找「' + name + '」对手', true);
        break;
      }
      case 'match_canceled': {
        // 服务端确认取消匹配
        if (this._combatOverlay) this._combatOverlay.style.display = 'none';
        this._toast('已取消匹配');
        break;
      }
      case 'match_found': {
        // 匹配成功 / 训练场开房成功：进入独立竞技场。
        // 注意 room 必须通过 opts 传进 _enterCombat —— 它开头会先做一次防御性退场，
        // 那次退场会把 this._room 清成 null，若在外面先 set 就被抹掉了（重开一局时必现）。
        this._trainPending = null; // 训练场已确认（也可能本来就是普通匹配）
        if (this._combatOverlay) this._combatOverlay.style.display = 'none';
        const members = new Map();
        for (const mm of (msg.members || [])) members.set(mm.id, mm);
        const isOwner = msg.owner === this.localState.id;
        this._enterCombat(msg.mode || 'meteor', msg.spawn || this._spawn, isOwner, members, { room: msg.room });
        break;
      }
      case 'match_left': {
        // 服务端确认离开房间：回到主世界（大厅）。已本地退出时该方法内部会直接返回
        this._exitCombat(msg.spawn || this._lobbySpawn);
        break;
      }
      case 'room_owner': {
        // 房主转移（原房主离开）：由新房主负责驱动陨石生成
        if (this._combat) this._combat.isOwner = (msg.owner === this.localState.id);
        break;
      }
      case 'meteor': {
        // 别人的陨石：复刻同一颗，保证全场落点一致
        if (this._combat) {
          this._spawnMeteor({ x: Number(msg.x), z: Number(msg.z), vy: Number(msg.vy), r: Number(msg.r) });
        }
        break;
      }
      case 'drop': {
        // 别人丢弃的物品：用同样的初始状态在本地复现，全员可见
        this._spawnDrop({
          id: msg.id,
          item: msg.item,
          x: Number(msg.x), y: Number(msg.y), z: Number(msg.z),
          vx: Number(msg.vx), vy: Number(msg.vy), vz: Number(msg.vz),
        });
        break;
      }
      case 'pickup': {
        // 别人把地上的东西捡走了：本地移除同一件，避免「已经没了还留在地上」
        this._pickupRemote(msg.id);
        break;
      }
      case 'coin_spawn': {
        // 房主生成的金币：用同一坐标在本地复现
        if (this._combat && this._combat.mode === 'grapple') {
          this._spawnCoin({ id: msg.id, x: Number(msg.x), y: Number(msg.y), z: Number(msg.z) });
        }
        break;
      }
      case 'coin': {
        // 别人吃掉了金币：本地移除同一枚，并按 from 记到那个人的战绩里
        this._removeCoinById(msg.id);
        if (msg.from) {
          this._scoreReady = true; // 服务端已支持带 from 的 coin 广播 → 金币排名可用
          const st = this._matchStats.get(String(msg.from));
          if (st) st.coins++;
        }
        break;
      }
      default:
        break;
    }
  }

  // 启动主循环
  start() {
    this.clock.start();
    this._loop();
  }

  // F5 切换第一/第三人称视角；第三人称时显示自己的模型
  toggleThirdPerson() {
    this.thirdPerson = !this.thirdPerson;
    this.playerManager.setLocalVisible(this.thirdPerson);
  }

  // 刷新本地玩家头顶名牌（登录资料晚于 welcome 到达时调用；第三人称可见）
  _refreshLocalLabel() {
    const local = this.playerManager.getLocalPlayer();
    if (!local) return;
    if (this._profile) {
      local.setLabel(
        this._profile.nickname || this._profile.username || '',
        this._profile.nicknameColor || '#ffffff'
      );
    } else {
      local.setLabel(`玩家${this.localState.num}`);
    }
  }

  // 打开对话栏：退出指针锁定并锁定操控（对话期间移动键不响应）
  _openChat() {
    if (this.aiChat.isOpen()) return;
    document.exitPointerLock && document.exitPointerLock();
    this.aiChat.open();
  }
  _setChatLock(locked) {
    if (this.localPlayer && this.localPlayer.physics) this.localPlayer.physics.controlLock = !!locked;
  }

  // ---- 玩家聊天 ----

  // 发送一句：文本先清洗限长再上行；本地立刻回显（服务端只转发给别人，不会回来造成两条）。
  // 昵称/颜色取本地登录资料，与服务端在别人那里补的是同一份。
  _sendChat(text) {
    const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, Config.CHAT_MAX_LEN);
    if (!s || !this.chat) return;
    const nick = this._profile
      ? (this._profile.nickname || this._profile.username || ('玩家' + this.localState.num))
      : ('玩家' + this.localState.num);
    const color = this._profile ? (this._profile.nicknameColor || '#ffffff') : '#ffffff';
    this.chat.add({ nick, color, text: s, me: true });
    this.network.sendChat(s);
  }

  // ---- 电动车：上车 / 下车 / 每帧摆放 ----

  // 上车/下车按钮：手机端没有 F 键，必须给一个可点的按钮；
  // 放在屏幕下方中间（居中于两个拇指区之间），跟随安全区，尺寸用 vmin 以免旋转跳变。
  _createVehicleHint() {
    const el = document.createElement('div');
    el.className = 'kui-btn kui-btn--grey';
    el.style.cssText =
      'position:fixed;left:50%;transform:translateX(-50%);z-index:62;display:none;cursor:pointer;' +
      'bottom:calc(env(safe-area-inset-bottom, 0px) + 17%);' +
      'min-width:clamp(58px,16vmin,92px);box-sizing:border-box;text-align:center;' +
      'padding:clamp(4px,1.4vmin,6px) clamp(9px,2.6vmin,14px);' +
      'user-select:none;-webkit-user-select:none;touch-action:none;';
    // 按下即响应：多点触控下（另一只手推摇杆）click 可能不派发
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._toggleVehicle();
    });
    document.body.appendChild(el);
    return el;
  }

  // 载具当前占用的座位（driver / passenger 为玩家 id，null 表示空）
  _vehicleSeats() {
    const out = { driver: null, passenger: null };
    const consider = (id, st) => {
      if (!st || st.veh !== Config.VEHICLE_ID) return;
      if (st.ride === 1) out.driver = id;
      else if (st.ride === 2) out.passenger = id;
    };
    consider(this.localState.id || '__local', this.localState);
    for (const [id, rp] of this.playerManager.players) {
      if (id === this.localState.id) continue;
      consider(id, rp.state);
    }
    return out;
  }

  _playerStateById(id) {
    if (!id) return null;
    if (id === this.localState.id) return this.localState;
    const rp = this.playerManager.players.get(id);
    return rp ? rp.state : null;
  }

  // 载具当前位置（有人驾驶时在驾驶员脚下，否则在停放点）
  _vehiclePos() {
    const seats = this._vehicleSeats();
    const d = this._playerStateById(seats.driver);
    if (d) return { x: d.x, z: d.z };
    return { x: Config.VEHICLE_POS.x, z: Config.VEHICLE_POS.z };
  }

  _nearVehicle() {
    const p = this._vehiclePos();
    return Math.hypot(this.localState.x - p.x, this.localState.z - p.z) <= Config.VEHICLE_PROXIMITY;
  }

  _toggleVehicle() {
    if (this.localState.ride) { this._dismountVehicle(); return; }
    if (!this._nearVehicle()) return;
    const seats = this._vehicleSeats();
    if (!seats.driver) this._mountVehicle(1);
    else if (!seats.passenger) this._mountVehicle(2, seats.driver);
    else this._toast('电动车已经坐满了');
  }

  // seat：1 = 驾驶位，2 = 后座；driverId 仅后座需要
  _mountVehicle(seat, driverId) {
    const st = this.localState;
    const phys = this.localPlayer.physics;
    st.ride = seat;
    st.veh = Config.VEHICLE_ID;
    this.input.consumeJump(); // 清掉待处理的跳跃请求
    phys.canJump = false;      // 骑乘时不能跳
    // 骑乘 / 赛车状态：整组隐藏顶栏、校卡、技能槽（CSS body.kui-ride，对齐对战隐藏集）
    document.body.classList.add('kui-ride');
    this._bossUiKey = null;    // 强制重算攻击键/传送门显隐（骑乘时收起）
    this._updateBossUI();
    this._updateSkillBarVisibility();
    if (seat === 1) {
      phys.speedMult = Config.VEHICLE_SPEED / Config.MOVE_SPEED; // 兜底：真实速度由 LocalPlayer._driveVehicle 接管
      if (this.mobileControls) this.mobileControls.setDriving(true); // 手机：把「跳」换成转向键，摇杆变油门键，技能槽被刹车顶替
      this._toast(this._coarsePointer
        ? '已上车（驾驶位）：按住左下「油门」前进 · 旁边「前/倒」换挡倒车 · ◀ ▶ 转向 · 技能槽位置的「刹」刹车'
        : '已上车（驾驶位）：W/S 前进后退 · A/D 转向 · 空格刹车');
    } else {
      this._vehDriver = driverId || null;
      phys.controlLock = true; // 后座不参与操控
      phys.velocity.set(0, 0, 0);
      // 后座位置之后全由驾驶员代报；但服务器必须先知道「我坐上了后座」，
      // 驾驶员才会开始代报，所以这里开一个短重发窗口，防单包丢失导致双方互相等待。
      this._vehPaxResend = 0.6;
      this._toast('已上车（后座）');
    }
  }

  _dismountVehicle() {
    const st = this.localState;
    // 比赛用车：一弃车就等于弃赛 —— 狂飙用的那辆车是发给你专门跑圈的，下车就别继续计时了。
    // （完赛的 _finishRace 会先把 this._race 置空再调本函数，所以正常冲线不会被这里当成中途弃赛。）
    const quitRace = !!(this._race && st.ride === 1);
    if (quitRace) this._exitRace(null); // 文案并到下面那条 toast，别让两条互相顶掉
    st.ride = 0;
    st.veh = '';
    this._vehDriver = null;
    document.body.classList.remove('kui-ride'); // 下车：恢复顶栏/校卡/技能槽
    if (this.mobileControls) this.mobileControls.setDriving(false); // 手机：驾驶键组换回「跳」
    this.localPlayer.resetRideLook(); // 骑行自由视角回正（否则下车后镜头还歪着）
    const phys = this.localPlayer.physics;
    phys.canJump = true;
    // 别把对话栏的操控锁一起解掉
    phys.controlLock = !!(this.aiChat && this.aiChat.isOpen());
    phys.speedMult = 1;
    phys.speedMode = 'walk';
    this._bossUiKey = null; // 强制重算：恢复主世界的攻击键/传送门提示显隐
    this._updateBossUI();
    this._updateSkillBarVisibility(); // 恢复技能栏
    this._toast(quitRace ? '已下车，狂飙结束' : '已下车');
  }

  // 按需给「某个骑手」配一辆车（一辆车一个 mesh，不骑了就隐藏 —— 池化，不销毁）。
  // 车的模型走资源缓存，重复创建不会重复下载。
  _vehFor(id) {
    if (!this._vehPool) this._vehPool = new Map();
    let v = this._vehPool.get(id);
    if (!v) {
      v = createVehicle(this.scene);
      this._vehPool.set(id, v);
    }
    return v;
  }

  _updateVehicle(dt) {
    const st = this.localState;
    const seats = this._vehicleSeats();

    // 1) 停放点那辆车：有人**真的骑着它**就跟驾驶员走，否则回停放点。
    //    ⚠ 校园狂飙「开赛自动发的那辆车」不算 —— 否则一开赛，校门口那辆车就被"骑"走了
    //    （用户报「校门口的车车没了」）。狂飙的车走下面的池子，各画各的。
    const localId = this.localState.id || '__local';
    const raceGranted = !!(this._race && this.localState.ride === 1 && seats.driver === localId);
    let mainDriver = null;
    if (seats.driver && !raceGranted) {
      const d = this._playerStateById(seats.driver);
      if (d) {
        this.vehicle.setPose(d.x, d.y - Config.PLAYER_HEIGHT * (d.size || 1), d.z, d.yaw);
        mainDriver = seats.driver;
      } else {
        this.vehicle.park();
      }
    } else {
      this.vehicle.park();
    }

    // 1.2) 其他骑手（含开狂飙的本地玩家）：每人各一辆车（多人同时骑时用）。
    // 车体只是视觉，位置从各自的 player state 推出来 —— 所以「每人一辆」不用改网络协议
    // （ride / veh 本来就在状态广播里，远端玩家照样能看到你骑着车）。
    const inUse = new Set();
    const drawDriver = (id, s2) => {
      if (!s2 || s2.veh !== Config.VEHICLE_ID || s2.ride !== 1) return;
      inUse.add(id);
      if (id === mainDriver) return; // 这辆已经由停放点那辆车画过了
      const v = this._vehFor(id);
      v.group.visible = true;
      v.setPose(s2.x, s2.y - Config.PLAYER_HEIGHT * (s2.size || 1), s2.z, s2.yaw);
    };
    drawDriver(this.localState.id || '__local', this.localState);
    for (const [id, rp] of this.playerManager.players) {
      if (id === this.localState.id) continue;
      drawDriver(id, rp.state);
    }
    if (this._vehPool) {
      for (const [id, v] of this._vehPool) if (!inUse.has(id)) v.group.visible = false;
    }

    // 1.5) 驾驶员：后座乘客由他统一上报，乘客自己不再单独广播。
    // 用驾驶员本地权威坐标算出发放位置，让乘客在所有屏幕上都稳稳挂在车后方。
    if (st.ride === 1 && seats.passenger) {
      const back = Config.VEHICLE_SEAT_BACK;
      const driver = this._playerStateById(seats.driver);
      if (driver) {
        this.network.sendVehPax(
          seats.passenger,
          driver.x + Math.sin(driver.yaw) * back,
          driver.y,
          driver.z + Math.cos(driver.yaw) * back,
          driver.yaw
        );
      }
    }

    // 2) 后座：把本地玩家钉在驾驶位后方；驾驶员不在了就自动下车
    if (st.ride === 2) {
      const d = this._playerStateById(seats.driver);
      if (d) {
        const back = Config.VEHICLE_SEAT_BACK;
        st.x = d.x + Math.sin(d.yaw) * back;
        st.z = d.z + Math.cos(d.yaw) * back;
        st.y = d.y;
        st.yaw = d.yaw;
        st.pitch = d.pitch;
        this.localPlayer.physics.velocity.set(0, 0, 0);
      } else {
        this._dismountVehicle();
        this._toast('驾驶员离开了，已下车');
      }
    }

    // 3) 上车 / 下车按钮（触屏显示纯文字，桌面额外带按键提示）
    if (st.ride) {
      this._vehHint.textContent = '下车' + this._vehKeyHint;
      this._vehHint.style.display = '';
      this._vehHint.style.opacity = '1';
    } else if (this._nearVehicle()) {
      const occupied = this._vehicleSeats();
      const full = occupied.driver && occupied.passenger;
      this._vehHint.textContent = full ? '已满员' : ('上车' + this._vehKeyHint);
      this._vehHint.style.display = '';
      this._vehHint.style.opacity = full ? '0.55' : '1';
    } else {
      this._vehHint.style.display = 'none';
    }

    // 4) 车速表：只有自己坐在驾驶位时才显示（后座 / 走路 / 对战中都不露）
    if (st.ride === 1) {
      this._speedHudShow(true);
      this._speedHudTick(this.localPlayer._vehSpeed || 0);
      if (this._rideViewBtn) this._rideViewBtn.style.display = '';
    } else {
      this._speedHudShow(false);
      if (this._rideViewBtn) this._rideViewBtn.style.display = 'none';
    }
  }

  // 传送门附近的「召唤老师」按钮：和上下车按钮同一位置（传送门与电动车相距 18 米，不会同时出现）
  _createPortalHint() {
    const el = document.createElement('div');
    el.className = 'kui-btn kui-btn--yellow';
    el.style.cssText =
      'position:fixed;left:50%;transform:translateX(-50%);z-index:62;display:none;cursor:pointer;' +
      'bottom:calc(env(safe-area-inset-bottom, 0px) + 17%);' +
      'min-width:clamp(58px,16vmin,92px);box-sizing:border-box;text-align:center;' +
      'padding:clamp(4px,1.4vmin,6px) clamp(9px,2.6vmin,14px);' +
      'user-select:none;-webkit-user-select:none;touch-action:none;';
    el.textContent = '召唤老师';
    // 按下即响应：多点触控下（另一只手推摇杆）click 可能不派发
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.boss.mode !== 'idle') return;
      this.boss.summon();
      this._toast('老师将在 ' + Config.BOSS_SPAWN_DELAY + ' 秒后出现');
    });
    document.body.appendChild(el);
    return el;
  }

  // 「攻击」按钮：手机没有鼠标左键，必须给可点按钮。
  // 手机端做成**圆形**并排在**跳跃键正上方**（拇指自然落点，也不挡准星）：
  // 尺寸与跳跃键一致，位置每帧由 _placeAttackBtn 按跳跃键的实际矩形重算。
  // 桌面端保留原来的底部居中长条（桌面用左键，按钮只是提示）。
  _createAttackButton() {
    const el = document.createElement('div');
    if (this._attackCoarse) {
      // 不用 .kui-btn：那套样式带 border-image 与 min-width，套在圆上会被撑成方块
      el.className = 'mc-atk';
      el.style.cssText =
        'position:fixed;right:20px;z-index:62;display:none;cursor:pointer;' +
        'width:clamp(56px,15vmin,78px);height:clamp(56px,15vmin,78px);border-radius:50%;' +
        'box-sizing:border-box;text-align:center;padding:0;' +
        'line-height:clamp(56px,15vmin,78px);overflow:hidden;' +
        'color:var(--kui-paper);font-weight:600;letter-spacing:1px;font-family:var(--kui-font);' +
        'font-size:clamp(13px,3.6vmin,16px);' +
        // 与跳跃键同一套观感（半透明底 + 描边），换成危险色区分「攻击」
        'background:color-mix(in srgb, var(--kui-danger) 34%, transparent);' +
        'border:2px solid color-mix(in srgb, var(--kui-danger) 78%, transparent);' +
        // 首帧兜底：跳到跳跃键（同尺寸 clamp(56,15vmin,78) + 底距 24px）上方一点点
        'bottom:calc(env(safe-area-inset-bottom, 0px) + 24px + clamp(56px,15vmin,78px) + clamp(10px,2.6vmin,16px));' +
        'user-select:none;-webkit-user-select:none;touch-action:none;';
    } else {
      el.className = 'kui-btn kui-btn--red kui-btn--key';
      el.style.cssText =
        'position:fixed;left:50%;transform:translateX(-50%);z-index:62;display:none;cursor:pointer;' +
        'bottom:calc(env(safe-area-inset-bottom, 0px) + 27%);' +
        'min-width:clamp(54px,15vmin,86px);box-sizing:border-box;text-align:center;' +
        'padding:clamp(4px,1.4vmin,6px) clamp(9px,2.6vmin,14px);' +
        'user-select:none;-webkit-user-select:none;touch-action:none;';
    }
    // 电脑端这颗按钮只是**提示**：真正的攻击是鼠标左键，所以把「左键」图块直接贴上去，
    // 玩家不用去设置面板查「攻击是按哪个」。手机端那颗圆键本身就是操作入口，贴鼠标没意义。
    // ⚠ 别把文字塞回 el.textContent：那会把图块一起抹掉（按钮内容现在是 [图块][文字] 两个节点）。
    el.textContent = '';
    if (!this._attackCoarse) el.appendChild(keyBadge('mouseL'));
    const atkLabel = document.createElement('span');
    atkLabel.textContent = '攻击';
    el.appendChild(atkLabel);
    this._attackBtnLabel = atkLabel; // 建造模式下要把它改成「放置」
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this._isBuildActive()) { this._buildTool.place(); return; } // 建造模式：攻击键=放置
      // 开了加特林就改成按住持续扫射（松手停火）
      if (this._gatlingOn) { this._gatlingHeld = true; return; }
      if (this._ctrlOn) { this._fireCtrlGun(); return; }
      this._primaryAttack();
    });
    el.addEventListener('pointerup', () => { this._gatlingHeld = false; });
    el.addEventListener('pointercancel', () => { this._gatlingHeld = false; });
    document.body.appendChild(el);
    return el;
  }

  // 手机端：把圆形攻击键摆到跳跃键正上方（与跳跃键同一条竖线，留一点缝）。
  // 跳跃键支持在「画面元素」里拖动，所以不能写死 CSS，得按它的实际矩形算。
  // 攻击键**自己也**可以在「画面元素」里拖动（LAYOUT_ITEMS 里 key='attack'）：一旦用户摆过，
  // 就以保存的位置为准（只夹进屏幕），不再贴跳跃键——否则每次它一出现就把用户摆好的位置冲掉。
  _placeAttackBtn() {
    const el = this._attackBtn;
    if (!el || !this._attackCoarse) return;
    if (el.style.display === 'none') return; // 隐藏时量不到尺寸，等显示那次再摆
    const j = document.querySelector('.mc-jump');
    if (!j) return; // 触屏控件还没创建（初始化顺序），等下一次布局回调
    const jr = j.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (!jr.width || !r.width) return;

    let cx = null;
    let cy = null;
    const { width: vw, height: vh } = viewportSize();
    // 用户是否在「画面元素」里摆过攻击键？（按横竖屏分别存，跟技能槽同一套）
    const conf = readLayout(currentMode()) || {};
    const p = conf.attack;
    if (p && Number.isFinite(p.cx) && Number.isFinite(p.cy)) {
      cx = p.cx * vw;
      cy = p.cy * vh;
    }
    if (cx === null) {
      // 没摆过：默认贴着跳跃键正上方（同一条竖线，间距按跳跃键直径算）
      const gap = Math.max(6, Math.round(Math.min(18, jr.height * 0.16)));
      cx = jr.left + jr.width / 2;
      cy = jr.top - gap - r.height / 2;
    }
    // 夹进屏幕，避免按钮被挤出可视区
    cx = Math.max(4 + r.width / 2, Math.min(vw - 4 - r.width / 2, cx));
    cy = Math.max(4 + r.height / 2, Math.min(vh - 4 - r.height / 2, cy));
    el.style.left = Math.round(cx - r.width / 2) + 'px';
    el.style.top = Math.round(cy - r.height / 2) + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    el.style.transform = 'none';
    // 技能键默认也排在跳跃键上方，这里要让它改挂到攻击键上方，避免两个圆叠在一起
    this._relayoutSkillBtn();
  }

  // 让技能键按「当前显示在跳跃键上方的那些键」重排（攻击键在就挂在攻击键上方）
  _relayoutSkillBtn() {
    if (this.skillSlots && typeof this.skillSlots.relayout === 'function') this.skillSlots.relayout();
  }

  // 屏幕正中的准星：四条短线 + 中心点。样式与 is-hot 高亮态都在 theme.js 的 .kui-crosshair 里。
  // 用 CSS 画而不是 public/ui/crosshair_a.png：那张是纯黑图，柱林/岩浆这种深色场景里几乎看不见。
  _createCrosshair() {
    const el = document.createElement('div');
    el.className = 'kui-crosshair';
    el.style.display = 'none'; // 等 _updateAimUI 判定（PC 要先锁定指针）
    for (const k of ['t', 'b', 'l', 'r', 'c']) {
      const bar = document.createElement('i');
      bar.className = k;
      el.appendChild(bar);
    }
    document.body.appendChild(el);
    return el;
  }

  // 准星显隐 + 「瞄中目标」反馈（准星变色放大、手机攻击键亮起）。
  // 只在状态翻转时写 style/class：这几个 getter 每帧读没问题，但每帧写 DOM 会让样式反复失效。
  _updateAimUI() {
    // 打开任何需要鼠标/键盘的面板时收起准星（这时候屏幕上有光标，画个准星是误导）
    const panel =
      (this.aiChat && this.aiChat.isOpen()) ||
      (this.chat && typeof this.chat.isOpen === 'function' && this.chat.isOpen()) ||
      (this.shop && typeof this.shop.isOpen === 'function' && this.shop.isOpen());
    const vis = !this._dead && !this._soul && !panel &&
      (this._coarsePointer || !!(this.input && this.input.locked));
    if (vis !== this._crosshairShown) {
      this._crosshairShown = vis;
      if (this._crosshair) this._crosshair.style.display = vis ? '' : 'none';
    }

    // 「可攻击」= 准星压住了柱顶光点（只有疯狂抓钩模式才有光点）
    const hot = !!this._beaconAimed && !this._dead && !this._soul && !panel;
    if (hot !== this._aimHot) {
      this._aimHot = hot;
      if (this._crosshair) this._crosshair.classList.toggle('is-hot', hot);
      // 手机攻击键是自绘的圆形（行内样式），亮起态由 .mc-atk--hot 用 !important 覆盖；
      // 桌面端是长条且用鼠标左键，不需要变亮
      if (this._attackBtn && this._attackCoarse) this._attackBtn.classList.toggle('mc-atk--hot', hot);
    }
  }

  // 三阶段的「护盾」按钮（手机没有 Q 键，靠点它；电脑端贴 Q 图块提示真按键）
  _createShieldButton() {
    const el = document.createElement('div');
    el.className = 'kui-btn kui-btn--green' + (this._coarsePointer ? '' : ' kui-btn--key');
    el.style.cssText =
      'position:fixed;left:50%;transform:translateX(-50%);z-index:62;display:none;cursor:pointer;' +
      'bottom:calc(env(safe-area-inset-bottom, 0px) + 37%);' +
      'min-width:clamp(54px,15vmin,86px);box-sizing:border-box;text-align:center;' +
      'padding:clamp(4px,1.4vmin,6px) clamp(9px,2.6vmin,14px);' +
      'user-select:none;-webkit-user-select:none;touch-action:none;';
    // 电脑端贴「Q」图块：盾是按 Q 开的，按钮只是提示（和攻击按钮贴左键一个道理）。
    // 手机端没有 Q，这颗按钮就是操作入口本身，不贴图块。
    el.textContent = '';
    if (!this._coarsePointer) el.appendChild(keyBadge('q'));
    const shieldLabel = document.createElement('span');
    shieldLabel.textContent = '护盾';
    el.appendChild(shieldLabel);
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._activateShield();
    });
    document.body.appendChild(el);
    return el;
  }

  // 商人附近的「找小满买东西」按钮
  _createMerchantHint() {
    // 靠近小满只显示一个按钮，打开「小满的杂货铺」；道具 / 家具在其内部用标签页切换
    const el = document.createElement('div');
    el.className = 'kui-btn kui-btn--primary';
    el.style.cssText =
      'position:fixed;left:50%;transform:translateX(-50%);z-index:62;display:none;cursor:pointer;' +
      'bottom:calc(env(safe-area-inset-bottom, 0px) + 17%);' +
      'min-width:clamp(66px,18vmin,104px);box-sizing:border-box;text-align:center;' +
      'padding:clamp(4px,1.4vmin,6px) clamp(9px,2.6vmin,14px);' +
      'user-select:none;-webkit-user-select:none;touch-action:none;';
    el.textContent = '找小满买东西';
    // 按下即响应：多点触控下（另一只手推摇杆）click 可能不派发
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.shop.toggle();
      this._updateMerchantHint();
    });
    document.body.appendChild(el);
    return el;
  }

  // 掉落物旁边的「拾取」按钮：靠近就出现，点一下把地上的东西捡回背包
  _createPickupHint() {
    const el = document.createElement('div');
    el.className = 'kui-btn kui-btn--primary';
    // 放在准星正下方一点：底部中间的按钮位（上下车/召唤/攻击/护盾）已经排满，这里不会打架
    el.style.cssText =
      'position:fixed;left:50%;transform:translateX(-50%);top:calc(50% + 52px);z-index:63;display:none;cursor:pointer;' +
      'min-width:clamp(66px,18vmin,104px);box-sizing:border-box;text-align:center;' +
      'padding:clamp(4px,1.4vmin,6px) clamp(9px,2.6vmin,14px);' +
      'user-select:none;-webkit-user-select:none;touch-action:none;';
    el.textContent = '拾取';
    // PC 上光标被指针锁定，点不到 DOM 按钮，所以在按钮上标出快捷键。
    // 复用构造时算好的 this._coarsePointer —— 触屏判定只该有一处，别再单独 matchMedia。
    this._pickupKeySuffix = this._coarsePointer ? '' : (' (' + Config.PICKUP_KEY.slice(-1) + ')');
    // 按下即响应：多点触控下（另一只手推摇杆）click 可能不派发
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._pickupNearest();
    });
    document.body.appendChild(el);
    return el;
  }

  // 拾取按钮显隐 + 文案：找离自己最近、且在拾取范围内的一件掉落物
  _updatePickupHint() {
    if (!this._pickupHint) return;
    const s = this.localState;
    const R = Config.DROP_PICKUP_RANGE;
    const HY = Config.DROP_PICKUP_HEIGHT;
    let best = null;
    let bestD = Infinity;
    for (const d of this._drops) {
      const dh = d.y - s.y; // 物品比自己高/低太多就够不到（比如还飞在半空）
      if (dh > HY || dh < -HY - 2) continue;
      const dist = Math.hypot(s.x - d.x, s.z - d.z);
      if (dist <= R && dist < bestD) { best = d; bestD = dist; }
    }
    // 灵魂出窍 / 已倒地时只飘着看，不提示拾取（也不允许按 E 捡）
    const allow = !this._dead && !this._soul;
    this._pickupTarget = allow ? best : null;
    const show = !!this._pickupTarget;
    if (this._pickupShown !== show) {
      this._pickupShown = show;
      this._pickupHint.style.display = show ? '' : 'none';
    }
    if (show && this._pickupLabel !== best.item) {
      this._pickupLabel = best.item;
      this._pickupHint.textContent = '拾取「' + best.item + '」' + (this._pickupKeySuffix || '');
    }
  }

  // 捡起当前目标掉落物：进背包、有空槽就装备上，然后通知同场其他人把它移除
  _pickupNearest() {
    const d = this._pickupTarget;
    if (!d) return;
    const i = this._drops.indexOf(d);
    if (i < 0) { this._pickupTarget = null; this._pickupLabel = null; return; } // 已被移除（过期/被别人捡走）
    const item = d.item;
    // 先把自己这边移除，避免重复点击重复入包
    this._pickupTarget = null;
    this._pickupLabel = null;
    this._removeDrop(d); this._drops.splice(i, 1);
    if (d.id) this.network.sendPickup(d.id); // 让其他人也看到它被捡走了
    this._pickupShown = false;
    if (this._pickupHint) this._pickupHint.style.display = 'none';

    const n = addToBag(getBagKey(this._profile), item, 1);
    // 捡到别人丢的东西时，本机可能还不知道它的效果（自己没买过）：
    // 从商店目录按名字补一份效果，这样捡回来的物品是真的能用，而不是「未识别」兜底
    if (!this._loadItemEffect(item)) {
      const catalog = SHOP_ITEMS.find((it) => it.name === item);
      if (catalog && catalog.effect) this._storeItemEffect(item, catalog.effect);
    }
    // 已经装在某个槽里就只加背包；否则挑第一个空槽装上去
    let slot = Object.keys(this._skillMap).find((k) => this._skillMap[k] === item);
    if (slot != null) slot = Number(slot);
    else {
      for (let k = 0; k < SLOT_COUNT; k++) { if (!(k in this._skillMap)) { slot = k; break; } }
      if (slot != null && slot >= 0) this._setSlot(slot, item);
    }
    this._toast('已拾取「' + item + '」，背包 ' + n + ' 个'
      + (slot != null && slot >= 0 ? '（' + (slot + 1) + ' 号技能槽）' : ''));
  }

  // 别人捡走了掉落物：本地把同 id 的那件移除（不重复入包）
  _pickupRemote(id) {
    if (!id) return;
    const i = this._drops.findIndex((d) => d.id && d.id === id);
    if (i >= 0) {
      if (this._pickupTarget === this._drops[i]) { this._pickupTarget = null; this._pickupLabel = null; }
      this._removeDrop(this._drops[i]);
      this._drops.splice(i, 1);
    }
  }

  // 学币变化后刷新校卡上的余额（小牌右端 + 展开后资料里的一行）与商店里的余额。
  // 2026-10-04 之前这里还负责左上角一块独立的「学币」小牌，那块牌跟 3D 画面格格不入，已并进校卡。
  _refreshCoins() {
    const w = loadWallet(this._profile);
    if (this.playerHUD && this.playerHUD.setCoins) this.playerHUD.setCoins(w.coins);
    if (this.shop && this.shop.isOpen()) this.shop.render();
  }

  // 背包同步到账号：拉服务端那份，按修订号决定谁覆盖谁（策略见 Inventory.js 顶部注释）。
  // 游客（无 token）不参与；拉不到（老服务端 / 断网）就静默降级，背包还是本地那份，不影响玩。
  _syncBagFromCloud() {
    setBagAccount(this._token, this._profile);
    if (!bagCloudEnabled()) return; // 游客、或资料还没到（此时背包键还是 guest，同步会串号）
    migrateFurnitureToBag(this._profile); // 家具搬进背包（幂等），保证被一起同步
    // 游客时捡的东西先并进账号（背包按账号分键，不并的话一登录就像清空了）
    if (takeGuestBag(getBagKey(this._profile))) this._toast('游客背包已并入账号');
    syncBag().then((r) => {
      if (!r || !r.changed) return;
      // 背包界面正开着就重画一次，否则显示的还是同步前的旧内容
      if (this._bagOv && this._bagOv.style.display !== 'none') this._renderBag();
      this._toast('背包已与账号同步');
    });
  }

  // 商人按钮显隐：靠近 + 商店没开着
  _updateMerchantHint() {
    if (!this._merchantHint) return;
    const show = !!this._merchantNear && !this.shop.isOpen();
    if (this._merchantHintShown === show) return;
    this._merchantHintShown = show;
    this._merchantHint.style.display = show ? '' : 'none';
  }

  // 购买：道具永久进背包+技能槽；家具(building)只进 owned（摆放额度），不进背包/技能槽
  _buyShopItem(id) {
    const r = buyItem(this._profile, id);
    if (!r.ok) { this._toast(r.reason); return; }
    const item = r.item;
    if (item.kind === 'building') {
      // 家具进背包（背包「家具」页签可见，且随背包云同步到账号）；摆放时从背包消耗
      const n = addToBag(getBagKey(this._profile), item.name, 1);
      this._refreshCoins();
      if (this.shop) this.shop.render();
      if (this._bagOv && this._bagOv.style.display !== 'none') this._renderBag();
      if (this._buildTool) this._buildTool.refresh();
      this._toast('买下家具「' + item.name + '」（背包 ' + n + ' 件可摆），还剩 ' + r.coins + ' 学币');
      return;
    }
    const n = addToBag(getBagKey(this._profile), item.name, 1);
    this._storeItemEffect(item.name, item.effect);
    this._equipItemSkill(item.name);
    this._refreshCoins();
    this.shop.render();
    if (this._buildTool) this._buildTool.refresh();
    this._toast('买下「' + item.name + '」（背包 ' + n + ' 个），还剩 ' + r.coins + ' 学币');
  }

  // 兑换码：校验在服务端（码表已搬走，客户端不再内置），这里只传 token 并处理结果。
  // 成功后刷新顶部余额并让商店重绘；返回 Promise，调用方（商店面板）要 await。
  async _redeemCode(code) {
    const r = await redeemCode(this._profile, code, this._token);
    if (r.ok) {
      this._refreshCoins();
      this.shop.render();
    }
    return r;
  }

  // 世界变红的全屏滤镜（pointer-events:none，只做视觉）
  _createRedOverlay() {
    const el = document.createElement('div');
    el.style.cssText =
      'position:fixed;inset:0;z-index:56;pointer-events:none;opacity:0;' +
      'transition:opacity .8s ease;' +
      'background:radial-gradient(circle at 50% 45%, rgba(255,60,60,.22) 0%, rgba(120,0,0,.62) 100%);';
    document.body.appendChild(el);
    return el;
  }

  // 白光一闪用的全屏白幕
  _createFlashOverlay() {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;inset:0;z-index:57;pointer-events:none;opacity:0;background:#fff;';
    document.body.appendChild(el);
    return el;
  }

  // 被控制枪抓住时的全屏蓝色滤镜（只有被控者自己看得到，pointer-events:none 只做视觉）。
  // z-index 比红光滤镜(56)低一档：万一打 Boss 的世界变红期间又被控制，红光仍在上层。
  _createCtrlOverlay() {
    const el = document.createElement('div');
    el.style.cssText =
      'position:fixed;inset:0;z-index:55;pointer-events:none;opacity:0;' +
      'transition:opacity .35s ease;' +
      'background:radial-gradient(circle at 50% 45%, rgba(110,190,255,.12) 0%, rgba(18,88,210,.58) 100%);';
    document.body.appendChild(el);
    return el;
  }

  // 只在状态翻转时写 DOM（_applyCtrlMsg 会被 20Hz 的锚点同步反复调用）
  _setCtrlOverlay(on) {
    const v = !!on;
    if (this._ctrlOverlayShown === v) return;
    this._ctrlOverlayShown = v;
    if (this._ctrlOverlay) this._ctrlOverlay.style.opacity = v ? '1' : '0';
  }

  // 全屏闪一下（老师阶段切换 / 被击败时的白光）
  _flash(color, ms) {
    const el = this._flashEl;
    if (!el) return;
    el.style.transition = 'none';
    el.style.background = color;
    el.style.opacity = '0.95';
    void el.offsetWidth; // 强制重排，保证紧接着改 opacity 能触发过渡动画
    el.style.transition = 'opacity ' + ms + 'ms ease-out';
    el.style.opacity = '0';
  }

  // 世界变红 / 还原：全屏红色滤镜 + 把阳光、环境光、半球光染红
  _setWorldRed(on) {
    if (this._redWorld === on) return;
    this._redWorld = on;
    if (this._redOverlay) this._redOverlay.style.opacity = on ? '1' : '0';
    const c = this._lightColors;
    if (!c) return;
    if (on) {
      this._sun.color.setHex(0xff4a3a);
      this._ambient.color.setHex(0xff6a5a);
      this._hemi.color.setHex(0xff3b2f);
    } else {
      this._sun.color.copy(c.sun);
      this._ambient.color.copy(c.ambient);
      this._hemi.color.copy(c.hemi);
    }
  }

  // 老师阶段变化：切换白光、世界变红、提示当前阶段的应对方式
  _onBossPhase(kind, ph) {
    if (kind === 'shift') {
      this._flash('#ffffff', 700); // 一阶段被打死：先发白光
      this._setWorldRed(true);     // 然后世界变红
      this._toast('老师狂暴了');
    } else if (kind === 'enter') {
      const tips = ['', '', '跳起来躲开旋转激光！', '按 ' + Config.BOSS_SHIELD_KEY.slice(-1) + ' 开护盾挡下激光'];
      this._toast('老师进入' + BOSS_PHASE_NAMES[ph] + '：' + tips[ph]);
    } else if (kind === 'dead') {
      this._setWorldRed(false);
      this._flash('#ffffff', 600);
      const coins = rewardBossKill(this._profile);
      this._refreshCoins();
      this._toast('老师已被击败，获得 ' + Config.BOSS_COIN_REWARD + ' 学币（共 ' + coins + '）');
    }
    this._updateBossUI();
  }

  // 手动开护盾：只在三阶段可用，有冷却
  _activateShield() {
    if (!this.boss || this._dead) return;
    if (this.boss.mode !== 'alive' || this.boss.phase < 3) return;
    const now = performance.now();
    if (now < this._shieldReadyAt) return;
    this._shieldUntil = now + Config.BOSS_SHIELD_DURATION * 1000;
    this._shieldReadyAt = now + Config.BOSS_SHIELD_COOLDOWN * 1000;
    this._updateBossUI();
  }

  // 对老师造成的伤害累计到超级激光的充能进度里
  _addSuperCharge(dmg) {
    if (this._superCharged || !(dmg > 0)) return;
    this._superDmg += dmg;
    if (this._superDmg >= Config.SUPER_CHARGE) {
      this._superDmg = Config.SUPER_CHARGE;
      this._superCharged = true;
      this._toast('超级激光充能完成，按 1 发射追踪导弹');
    }
  }

  // Boss 战期间把 0 号技能槽改成超级激光；打完后还原原本装在 0 号槽的物品
  _updateSuperSlot() {
    if (!this.skillSlots) return;
    const active = this.boss && this.boss.mode !== 'idle' && this.boss.mode !== 'dead';
    if (active) {
      const label = this._superCharged
        ? '追踪导弹'
        : ('充能 ' + Math.min(Config.SUPER_CHARGE, Math.floor(this._superDmg)) + '/' + Config.SUPER_CHARGE);
      if (this._superActive && this._superLabel === label) return;
      this._superActive = true;
      this._superLabel = label;
      this.skillSlots.assign(0, { label, onActivate: () => this._fireHomingMissile() });
      return;
    }
    if (!this._superActive) return;
    // 战斗结束：还原 0 号槽（不写回 localStorage，原来装的是什么就还原什么）
    this._superActive = false;
    this._superLabel = '';
    this._superDmg = 0;
    this._superCharged = false;
    const item = this._skillMap ? this._skillMap[0] : null;
    if (item) {
      const eff = this._effectForItem(item);
      // 同 _restoreSkills：0 号槽还原时也要把 noCd 带回去（否则原本免冷却的抓钩在打完 Boss 后开始卡顿）
      this.skillSlots.assign(0, { label: eff.label, onActivate: eff.run, noCd: eff.noCd === true });
    } else {
      this.skillSlots.clearSlot(0);
    }
  }

  // 发射追踪导弹：命中老师造成大额伤害，用完重新充能
  _fireHomingMissile() {
    if (!this._superCharged) {
      this._toast('超级激光充能中 ' + Math.floor(this._superDmg) + '/' + Config.SUPER_CHARGE);
      return;
    }
    if (!this.boss || this.boss.mode !== 'alive') {
      this._toast('现在没有可锁定的目标');
      return;
    }
    this._superCharged = false;
    this._superDmg = 0;
    this._superLabel = ''; // 强制下一帧刷新槽位文案

    const s = this.localState;
    const cosP = Math.cos(s.pitch);
    const sinP = Math.sin(s.pitch);
    const dir = new THREE.Vector3(-Math.sin(s.yaw) * cosP, sinP, -Math.cos(s.yaw) * cosP).normalize();
    const mesh = new THREE.Mesh(
      new THREE.ConeGeometry(0.22, 0.9, 10),
      new THREE.MeshBasicMaterial({ color: 0x7ff0ff })
    );
    mesh.position.set(s.x, s.y, s.z).addScaledVector(dir, 0.9);
    mesh.quaternion.setFromUnitVectors(UP_Y, dir); // 圆锥默认朝 +Y，转到飞行方向
    this.scene.add(mesh);
    this._missiles.push({ mesh, dir, life: Config.SUPER_MISSILE_LIFE });
    this._toast('追踪导弹已发射');
  }

  // 追踪导弹推进：朝老师缓慢转向（制导），贴近后爆炸并结算伤害
  _updateMissiles(dt) {
    if (!this._missiles.length) return;
    const alive = this.boss && this.boss.mode === 'alive';
    const bp = alive ? this.boss.pos : null;
    for (let i = this._missiles.length - 1; i >= 0; i--) {
      const m = this._missiles[i];
      m.life -= dt;
      if (bp) {
        const want = new THREE.Vector3(bp.x - m.mesh.position.x, Config.BOSS_HEIGHT * 0.5 - m.mesh.position.y, bp.z - m.mesh.position.z);
        if (want.lengthSq() > 1e-6) {
          want.normalize();
          m.dir.lerp(want, Math.min(1, dt * 3.2)).normalize();
          m.mesh.quaternion.setFromUnitVectors(UP_Y, m.dir);
        }
      }
      m.mesh.position.addScaledVector(m.dir, Config.SUPER_MISSILE_SPEED * dt);

      const hit = !!bp
        && Math.hypot(m.mesh.position.x - bp.x, m.mesh.position.z - bp.z) < 1.4
        && m.mesh.position.y < Config.BOSS_HEIGHT + 1.2;
      if (hit) {
        this._playExplosion(m.mesh.position.clone(), 2.6, Config.SUPER_MISSILE_DAMAGE);
        this.boss.hurtBy(Config.SUPER_MISSILE_DAMAGE);
      }
      if (hit || m.life <= 0) {
        this.scene.remove(m.mesh);
        m.mesh.geometry.dispose();
        m.mesh.material.dispose();
        this._missiles.splice(i, 1);
      }
    }
  }

  // 顶部的 Boss 血条：倒计时显示剩余秒数，出现后显示血量
  _createBossBar() {
    const box = document.createElement('div');
    box.style.cssText =
      'position:fixed;left:50%;transform:translateX(-50%);z-index:58;display:none;' +
      'top:calc(env(safe-area-inset-top, 0px) + clamp(56px,11vmin,78px));' +
      'width:min(420px,62vw);user-select:none;pointer-events:none;' +
      'font:clamp(11px,2.8vmin,13px)/1.3 var(--kui-font);color:var(--kui-paper);';
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;justify-content:space-between;margin-bottom:4px;text-shadow:0 1px 3px rgba(0,0,0,.7);';
    const name = document.createElement('span');
    name.textContent = '老师';
    name.style.cssText = 'font-weight:700;color:var(--kui-gold-hi-2);';;
    const num = document.createElement('span');
    row.appendChild(name);
    row.appendChild(num);
    // Boss 血条用主题的危险色进度条；高度仍用内联保持原尺寸
    const track = document.createElement('div');
    track.className = 'kui-bar kui-bar--danger';
    track.style.cssText = 'height:10px;';
    const fill = document.createElement('div');
    fill.className = 'kui-bar__fill';
    fill.style.cssText = 'width:100%;transition:width .18s ease;';
    track.appendChild(fill);
    box.appendChild(row);
    box.appendChild(track);
    document.body.appendChild(box);
    return { box, name, num, fill };
  }

  // 每帧刷新 Boss 相关 UI：传送门按钮、攻击/护盾按钮、顶部血条。
  // 用一个状态串做去重，避免每帧重复写 DOM。
  _updateBossUI() {
    // 建造模式：攻击键常显且语义为「放置」，护盾 / 传送门 / Boss 条全部收起
    if (this._isBuildActive()) {
      if (this._attackBtn) { this._attackBtn.style.display = ''; this._attackShown = true; }
      if (this._attackBtnLabel) this._attackBtnLabel.textContent = '放置';
      if (this._shieldBtn) this._shieldBtn.style.display = 'none';
      if (this._portalHint) this._portalHint.style.display = 'none';
      return;
    }
    const mode = this.boss.mode;
    const phase = this.boss.phase;
    const P = Config.PORTAL_POS;
    const near = Math.hypot(this.localState.x - P.x, this.localState.z - P.z) <= Config.PORTAL_PROXIMITY;
    // 对战中：Boss/传送门 UI 全隐藏，攻击按钮常驻（用来丢能量球打人）；但阵亡后（观战）要收起
    const inCombat = !!this._combat;
    // 骑乘/赛车：与对战同理，Boss / 传送门 / 护盾 UI 全部收起，给驾驶让出画面。
    // （速度表与骑行视角键由 _updateVehicle 单独管，不受这里影响）
    const riding = !!this.localState.ride;
    const showPortal = !inCombat && !riding && mode === 'idle' && near;
    const showAtk = !riding && ((inCombat && !this._dead) || (mode === 'alive' && !this._dead) || this._gatlingOn || this._ctrlOn);
    const showShield = !inCombat && !riding && mode === 'alive' && phase >= 3 && !this._dead;
    const shieldReady = performance.now() >= this._shieldReadyAt;
    const seconds = mode === 'countdown' ? Math.ceil(this.boss.countdown) : 0;
    const hp = mode === 'alive' ? Math.max(0, Math.round(this.boss.hp)) : 0;
    const key = [showPortal, showAtk, showShield, shieldReady, mode, phase, seconds, hp].join('|');
    if (key === this._bossUiKey) return;
    this._bossUiKey = key;

    if (this._portalHint) this._portalHint.style.display = showPortal ? '' : 'none';
    if (this._attackBtn) {
      const shown = !!showAtk;
      // 只在显隐翻转时动手：_updateBossUI 会因为血条数字变化被频繁触发，
      // 每次都去量 rect / 重排技能键会造成没必要的布局抖动
      if (shown !== this._attackShown) {
        this._attackShown = shown;
        this._attackBtn.style.display = shown ? '' : 'none';
        if (shown) this._placeAttackBtn(); // 手机端：刚显示时按跳跃键位置摆一次（内部顺带重排技能键）
        else this._relayoutSkillBtn();     // 收起时技能键要落回跳跃键上方
      }
    }
    if (this._shieldBtn) {
      this._shieldBtn.style.display = showShield ? '' : 'none';
      this._shieldBtn.style.opacity = shieldReady ? '1' : '0.4'; // 冷却中变淡
    }

    const bar = this._bossBar;
    if (!bar) return;
    if (riding) {
      bar.box.style.display = 'none'; // 骑乘/赛车：Boss 血条同样收起（纯战斗 UI）
      return;
    }
    if (mode === 'countdown') {
      bar.box.style.display = '';
      bar.name.textContent = '老师';
      bar.num.textContent = '来袭倒计时 ' + seconds + 's';
      bar.fill.style.width = '100%';
    } else if (mode === 'alive') {
      bar.box.style.display = '';
      bar.name.textContent = '老师 · ' + (BOSS_PHASE_NAMES[phase] || '');
      bar.num.textContent = hp + ' / ' + this.boss.maxHp;
      bar.fill.style.width = ((hp / this.boss.maxHp) * 100).toFixed(1) + '%';
    } else if (mode === 'shift') {
      bar.box.style.display = '';
      bar.name.textContent = '老师 · 狂暴';
      bar.num.textContent = '—';
      bar.fill.style.width = '100%';
    } else {
      bar.box.style.display = 'none';
    }
  }

  // 每帧推进 Boss：把「离老师最近的玩家」作为追击目标，其余交给 TeacherBoss 内部模拟
  _updateBoss(dt) {
    // Boss 完全未召唤（idle）时：无追逐/攻击/动画，仅保持技能槽与按钮状态同步，
    // 省下每帧构建玩家列表 + boss.update 的开销（玩家大部分时间处于该状态）
    if (this.boss.mode === 'idle') {
      this._updateSuperSlot();
      this._updateBossUI();
      return;
    }
    const me = this.localState;
    const bpos = this.boss.pos;
    // 找最近目标：**不建中间数组**。
    // 原实现每帧 new 一个 players 数组 + 每个玩家一个 {id,x,y,z} 字面量对象 ——
    // Boss 战期间这是稳定的每帧分配（人数越多越多），只在最后用到一个 target。
    // 现在直接边遍历边比距离，每帧最多分配 1 个对象（真正的 target）。
    let target = null;
    let best = Config.BOSS_CHASE_RANGE;
    {
      const d = Math.hypot(me.x - bpos.x, me.z - bpos.z);
      if (d < best) { best = d; target = { id: me.id || '__local', x: me.x, y: me.y, z: me.z }; }
    }
    for (const [id, rp] of this.playerManager.players) {
      if (id === me.id) continue;
      const st = rp.state;
      const d = Math.hypot(st.x - bpos.x, st.z - bpos.z);
      if (d < best) { best = d; target = { id, x: st.x, y: st.y, z: st.z }; }
    }

    // 护盾：本帧是否生效 + 罩子跟随玩家
    const now = performance.now();
    const shield = now < this._shieldUntil;
    if (this._shieldMesh) {
      const size = this.localPlayer.physics.sizeScale;
      this._shieldMesh.visible = shield;
      if (shield) {
        this._shieldMesh.position.set(me.x, me.y - Config.PLAYER_HEIGHT * size * 0.5, me.z);
        this._shieldMesh.scale.setScalar(size);
      }
    }

    this.boss.update(dt, {
      target,
      local: { x: me.x, y: me.y, z: me.z, shield },
      colliders: this.colliders,
    });
    this._updateSuperSlot();
    this._updateBossUI();
  }

  // Boss 战基础攻击：朝视线方向投出粉笔头（只对 Boss 结算伤害，不误伤玩家）
  // 主攻击入口：对战中丢能量球（打人），否则走 Boss 战的粉笔头。
  // 左键与手机「攻击」按钮都走这里，保证两端口径一致。
  _primaryAttack() {
    if (this._isBuildActive()) { this._buildTool.place(); return; } // 建造模式：左键=放置
    if (this._soul) return; // 灵魂出窍时肉身不可攻击
    if (this._combat) { this._combatAttack(); return; }
    this._attackBoss();
  }

  // 对战基础攻击：朝视线方向丢一颗能量球，命中玩家按 COMBAT_BALL_RADIUS 结算范围伤害。
  // 复用通用投掷物系统（_explode 已支持对半径内的其他玩家 sendHit），因此天然是 PvP。
  _combatAttack() {
    if (this._dead) return;
    // 疯狂抓钩：左键 / 攻击按钮直接就是抓钩（这个模式里技能栏是隐藏的，所以不能靠技能槽）
    if (this._combat && this._combat.mode === 'grapple') { this._fireGrapple(); return; }
    const now = performance.now();
    if (now - this._combatAt < Config.COMBAT_BALL_COOLDOWN * 1000) return;
    this._combatAt = now;
    this._throwProjectile({
      damage: Config.COMBAT_BALL_DAMAGE,
      radius: Config.COMBAT_BALL_RADIUS,
      speed: Config.COMBAT_BALL_SPEED,
      color: 0x59c2ff,
      gravity: 0.5,
      players: true, // 命中其他玩家结算伤害（混战）
    });
  }

  _attackBoss() {
    if (!this.boss || this.boss.mode !== 'alive' || this._dead) return;
    const now = performance.now();
    if (now - this._chalkAt < Config.CHALK_COOLDOWN * 1000) return;
    this._chalkAt = now;
    this._throwProjectile({
      damage: Config.CHALK_DAMAGE,
      radius: Config.CHALK_RADIUS,
      speed: Config.CHALK_SPEED,
      color: 0xeaf2ff,
      gravity: 0.12,   // 粉笔头近乎直线飞，方便瞄准
      players: false,  // 只打 Boss
    });
  }

  // 棍子模型：挂在相机下，只有挥动那一下才显示
  _createClubRig() {
    const rig = new THREE.Group();
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.045, 0.05, 1.25, 8),
      new THREE.MeshStandardMaterial({ color: 0x8b5a2b, roughness: 0.85 })
    );
    shaft.rotation.x = Math.PI / 2; // 圆柱默认沿 Y，转到沿 Z（指向正前方）
    shaft.position.z = -0.62;
    rig.add(shaft);
    const head = new THREE.Mesh(
      new THREE.BoxGeometry(0.17, 0.17, 0.4),
      new THREE.MeshStandardMaterial({ color: 0x4a4a52, roughness: 0.55 })
    );
    head.position.z = -1.3;
    rig.add(head);
    rig.position.set(0.24, -0.5, -0.25);
    rig.visible = false;
    this.camera.add(rig);
    return rig;
  }

  // 加特林模型：同样挂在相机下，开启加特林时一直握在手上，开火时枪管旋转
  _createGatlingRig() {
    const rig = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x3c424c, roughness: 0.6, metalness: 0.35 });
    const tubeMat = new THREE.MeshStandardMaterial({ color: 0x22262c, roughness: 0.45, metalness: 0.5 });

    // 枪身
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.17, 0.34), bodyMat);
    body.position.z = -0.2;
    rig.add(body);
    // 侧挂弹鼓
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.13, 14), bodyMat);
    drum.rotation.z = Math.PI / 2;
    drum.position.set(-0.03, -0.14, -0.12);
    rig.add(drum);
    // 枪管组：6 根管子绕一圈指向正前方（-Z），整组绕 Z 自转就是转管效果
    const barrels = new THREE.Group();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.019, 0.019, 0.5, 8), tubeMat);
      tube.rotation.x = Math.PI / 2; // 圆柱默认沿 Y，转到沿 Z
      tube.position.set(Math.cos(a) * 0.048, Math.sin(a) * 0.048, -0.56);
      barrels.add(tube);
    }
    rig.add(barrels);
    // 握把
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.15, 0.07), bodyMat);
    grip.position.set(0, -0.15, 0.01);
    rig.add(grip);

    rig.position.set(0.26, -0.34, -0.5);
    rig.visible = false;
    this.camera.add(rig);
    this._gatlingBarrels = barrels;
    return rig;
  }

  // 控制枪：第一人称握在手上（与棍子/加特林一样挂在相机下，第三人称交给人物模型）
  _createCtrlRig() {
    const rig = new THREE.Group();
    rig.add(createHeldWeapon('ctrlgun'));
    // 手持位置与加特林一致（右下、略前）；模型本体较小，整体放大一点更清楚
    rig.position.set(0.26, -0.34, -0.5);
    rig.scale.setScalar(1.5);
    rig.visible = false;
    this.camera.add(rig);
    return rig;
  }

  // 挥棍：播横扫动画，动画推进到 CLUB_HIT_AT 时结算命中
  _swingClub() {
    const now = performance.now();
    if (now - this._clubAt < Config.CLUB_COOLDOWN * 1000) return;
    this._clubAt = now;
    this._clubSwing = { t: 0, hit: false };
    this._clubRig.visible = true;
  }

  // 每帧：驱动挥棍动画，并决定棍子是否握在手上（不再只在挥的那一下显示）
  _updateClub(dt) {
    const sw = this._clubSwing;
    if (sw) {
      sw.t += dt;
      const k = Math.min(1, sw.t / Config.CLUB_SWING_TIME);
      const e = 1 - (1 - k) * (1 - k); // 缓出，收尾更利落
      this._clubRig.rotation.y = 0.95 - 1.9 * e; // 从右后方扫到左前方
      this._clubRig.rotation.z = -0.25 + 0.5 * e;
      if (!sw.hit && sw.t >= Config.CLUB_HIT_AT) {
        sw.hit = true;
        this._clubHitCheck();
      }
      if (k >= 1) this._clubSwing = null;
    } else {
      // 待机握持姿势：保持挥动动画的起手位（斜扛在右前方），别每帧飘
      this._clubRig.rotation.set(0, 0.95, -0.25);
    }
    // 技能槽里装备了棍子就一直握在手上；第三人称、死亡、或已换成加特林时收起
    this._clubRig.visible =
      this._hasSkillKind('club') && !this.thirdPerson && !this._dead && !this._gatlingOn;
  }

  // 技能槽里是否装备了某种效果的道具（决定手里握什么武器）。
  // 用技能槽的 JSON 作签名做一层缓存，避免每帧读 localStorage。
  _hasSkillKind(kind) {
    const map = this._skillMap || {};
    const sig = JSON.stringify(map);
    if (sig !== this._skillSig) {
      this._skillSig = sig;
      const kinds = new Set();
      for (const key of Object.keys(map)) {
        const raw = this._loadItemEffect(map[key]);
        const k = (raw && typeof raw === 'object') ? raw.k : String(raw || '');
        if (k) kinds.add(k);
      }
      this._skillKinds = kinds;
    }
    return !!(this._skillKinds && this._skillKinds.has(kind));
  }

  // 当前该上报给他人的手持武器种类：与第一人称手里武器的显示逻辑保持一致。
  // 注意：这里只按「装备状态」判断，不因切第三人称/死亡而回报空值，
  // 否则别人会看到武器忽隐忽现。
  _heldWeaponKind() {
    if (this._gatlingOn) return 'gatling';
    if (this._ctrlOn || this._ctrl) return 'ctrlgun';
    if (this._hasSkillKind('club')) return 'club';
    return '';
  }

  // 命中结算：正前方 CLUB_ARC_DEG 张角内、CLUB_RANGE 内的其他玩家全部被击飞
  _clubHitCheck() {
    const s = this.localState;
    const fx = -Math.sin(s.yaw);
    const fz = -Math.cos(s.yaw);
    const half = (Config.CLUB_ARC_DEG * Math.PI) / 180 / 2;
    const cosHalf = Math.cos(half);
    let n = 0;
    for (const [id, rp] of this.playerManager.players) {
      if (id === s.id) continue;
      const st = rp.state;
      const dx = st.x - s.x;
      const dz = st.z - s.z;
      const d = Math.hypot(dx, dz);
      if (d < 1e-4 || d > Config.CLUB_RANGE) continue;
      if (Math.abs(st.y - s.y) > 2.2) continue; // 高度差太大（楼顶/空中）扫不到
      if ((dx * fx + dz * fz) / d < cosHalf) continue;
      const kx = (dx / d) * Config.CLUB_KNOCK;
      const kz = (dz / d) * Config.CLUB_KNOCK;
      this.network.sendKnock(id, kx, Config.CLUB_KNOCK_UP, kz);
      // 在挥棍者本地给被扫玩家补一段相同的击飞弧线：不用等网络插值慢慢跟，
      // 让「被撞飞」当帧就能看到方向，观感跟手。
      rp.applyKnockPreview(kx, Config.CLUB_KNOCK_UP, kz);
      n++;
    }
    this._toast(n > 0 ? ('棍子扫飞了 ' + n + ' 个玩家') : '棍子挥空了');
  }

  // 被棍子扫到：把冲量交给物理。必须用 velocityHold 短时间强制这个速度，
  // 否则下一帧就会被输入直接覆盖（水平速度每帧由按键重算）。
  _applyKnock(msg) {
    const phys = this.localPlayer.physics;
    phys.velocityHold = {
      x: Number(msg.kx) || 0,
      y: Number(msg.ky) || 0,
      z: Number(msg.kz) || 0,
      t: Config.CLUB_KNOCK_HOLD,
    };
    this._toast('被棍子扫飞了');
  }

  // 商人：靠近显隐按钮
  _updateMerchant(dt) {
    this.merchant.update(dt, this.localState.x, this.localState.z);
    this._updateMerchantHint();
  }

  // ---------- 黑洞 ----------

  // 一个会不断变大的黑色球体 + 一圈紫色光环
  _createHoleMesh() {
    const group = new THREE.Group();
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(1, 20, 14),
      new THREE.MeshBasicMaterial({ color: 0x08000f })
    );
    group.add(core);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x9a4cff, transparent: true, opacity: 0.5,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    applyFragmentPrecision(ringMat);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.1, 1.45, 32),
      ringMat
    );
    ring.rotation.x = -Math.PI / 2;
    group.add(ring);
    return { group, ring };
  }

  _throwBlackHole() {
    const s = this.localState;
    const cosP = Math.cos(s.pitch);
    const sinP = Math.sin(s.pitch);
    const dir = new THREE.Vector3(-Math.sin(s.yaw) * cosP, sinP, -Math.cos(s.yaw) * cosP);
    const { group, ring } = this._createHoleMesh();
    group.position.set(s.x, s.y, s.z).addScaledVector(dir, 1.0);
    group.scale.setScalar(Config.BLACKHOLE_RADIUS_MIN);
    this.scene.add(group);
    this._holes.push({
      group,
      ring,
      vel: dir.clone().multiplyScalar(Config.BLACKHOLE_SPEED),
      settled: false,
      net: false,
      t: 0,
    });
    this._toast('黑洞出手，' + Config.BLACKHOLE_GROW + ' 秒后开始吸人');
  }

  // 别人扔的黑洞：投掷者已经把飞行算完了，这里直接在落点生成
  _spawnRemoteBlackHole(msg) {
    const x = Number(msg.x);
    const z = Number(msg.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    const { group, ring } = this._createHoleMesh();
    group.position.set(x, 0.9, z);
    group.scale.setScalar(Config.BLACKHOLE_RADIUS_MIN);
    this.scene.add(group);
    this._holes.push({ group, ring, vel: null, settled: true, net: true, t: 0 });
  }

  // 推进所有黑洞：飞行 -> 不断长大 -> 长满后吸附近的人 -> 消散
  _updateHoles(dt) {
    if (!this._holes.length) return;
    const s = this.localState;
    const phys = this.localPlayer.physics;
    for (let i = this._holes.length - 1; i >= 0; i--) {
      const h = this._holes[i];

      if (!h.settled) {
        h.vel.y += Config.GRAVITY * Config.BLACKHOLE_GRAVITY * dt;
        const pos = h.group.position;
        const sx = h.vel.x * dt;
        const sy = h.vel.y * dt;
        const sz = h.vel.z * dt;
        const len = Math.hypot(sx, sy, sz);
        let landed = false;
        // 飞行途中扫掠一次：撞到墙 / 楼板 / 掩体就贴面停下（原先只判 y≤0.9，会直接穿进建筑里）
        if (len > 1e-6) {
          const rad = Config.BLACKHOLE_RADIUS_MIN;
          const hit = raycastWorld(
            this.colliders,
            pos.x, pos.y, pos.z,
            sx / len, sy / len, sz / len,
            len + rad,
            { floor: false }, // 地面仍走下面的 y≤0.9，保持原来「贴地 0.9 停住」的手感
          );
          if (hit) {
            const back = rad * 0.9; // 沿射线回退一个半径，球体贴面而不是嵌进去
            pos.set(hit.x - (sx / len) * back, Math.max(hit.y - (sy / len) * back, 0.9), hit.z - (sz / len) * back);
            landed = true;
          }
        }
        if (!landed) {
          pos.addScaledVector(h.vel, dt);
          if (pos.y <= 0.9) { pos.y = 0.9; landed = true; }
        }
        if (landed) {
          h.vel = null;
          h.settled = true;
          // 飞行只有投掷者自己模拟；落地那一刻把落点广播出去，其他人照着摆
          if (!h.net) this.network.sendBlackHole(pos.x, pos.z);
        }
        continue;
      }

      h.t += dt;
      const k = Math.min(1, h.t / Config.BLACKHOLE_GROW);
      h.group.scale.setScalar(Config.BLACKHOLE_RADIUS_MIN
        + (Config.BLACKHOLE_RADIUS_MAX - Config.BLACKHOLE_RADIUS_MIN) * k);
      h.ring.rotation.z += dt * 1.6;
      h.ring.material.opacity = 0.35 + 0.3 * Math.sin(h.t * 4);

      // 长满后的一段时间里持续吸人：各自判自己，只把冲量喂给自己的物理
      if (h.t >= Config.BLACKHOLE_GROW && h.t <= Config.BLACKHOLE_GROW + Config.BLACKHOLE_PULL_TIME) {
        const dx = h.group.position.x - s.x;
        const dz = h.group.position.z - s.z;
        const d = Math.hypot(dx, dz);
        if (d < Config.BLACKHOLE_PULL_RADIUS && d > 0.7) {
          const speed = Math.min(Config.BLACKHOLE_PULL_SPEED, d * 3);
          // y 传 null：竖直方向仍交给重力，不然会被吸得悬停在空中
          phys.velocityHold = { x: (dx / d) * speed, y: null, z: (dz / d) * speed, t: 0.15 };
        }
      }

      if (h.t >= Config.BLACKHOLE_LIFE) {
        this.scene.remove(h.group);
        h.group.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
        this._holes.splice(i, 1);
      }
    }
  }

  // ---------- 捉迷藏玩具 ----------

  // 选人 / 选谁抓 / 选颜色的弹窗
  _createHidePanel() {
    const ov = document.createElement('div');
    ov.style.cssText =
      'position:fixed;inset:0;z-index:9750;display:none;background:rgba(15,20,30,.45);' +
      'align-items:center;justify-content:center;font:14px/1.5 system-ui,"Microsoft YaHei",sans-serif;';
    const card = document.createElement('div');
    card.className = 'kui-panel';
    card.style.cssText = 'width:min(380px,88vw);box-sizing:border-box;';
    card.innerHTML =
      '<div class="kui-panel__body">' +
      '<h3 class="kui-title" style="margin:0 0 14px;font-size:16px;">捉迷藏玩具</h3>' +
      '<label style="display:block;margin-bottom:10px;">一起玩的人' +
      '<select class="hd-partner kui-input" style="margin-left:8px;max-width:190px;width:auto;display:inline-block;"></select></label>' +
      '<label style="display:block;margin-bottom:12px;">谁抓' +
      '<select class="hd-role kui-input" style="margin-left:8px;max-width:230px;width:auto;display:inline-block;">' +
      '<option value="partner">对方抓（我变成方块躲起来）</option>' +
      '<option value="me">我抓（对方变成方块）</option></select></label>' +
      '<div style="margin-bottom:16px;">方块颜色<div class="hd-colors" style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;"></div></div>' +
      '<div style="display:flex;gap:10px;justify-content:flex-end;">' +
      '<button class="hd-cancel kui-btn kui-btn--ghost" type="button">取消</button>' +
      '<button class="hd-go kui-btn kui-btn--primary" type="button">开始</button></div>' +
      '</div>';
    ov.appendChild(card);
    document.body.appendChild(ov);

    const partnerSel = card.querySelector('.hd-partner');
    const roleSel = card.querySelector('.hd-role');
    const colorBox = card.querySelector('.hd-colors');

    // 这里**故意不用主题色**：角色外观/物品图标需要「一堆能互相区分的颜色」，
    // 语义变量（成功/危险/警告）只有三档，不够分。属于例外，勿与状态色混用。
    const COLORS = ['#e74c3c', '#e67e22', '#f1c40f', '#2ecc71', '#16a085', '#3498db', '#9b59b6', '#2c3e50'];
    let color = COLORS[3];
    const swatches = COLORS.map((c) => {
      const d = document.createElement('div');
      d.style.cssText = 'width:30px;height:30px;border-radius:var(--kui-radius);cursor:pointer;background:' + c + ';box-sizing:border-box;';
      d.addEventListener('click', () => { color = c; paint(); });
      colorBox.appendChild(d);
      return { c, d };
    });
    function paint() {
      for (const s of swatches) {
        s.d.style.border = s.c === color ? '3px solid var(--kui-ink)' : '3px solid transparent';
      }
    }
    paint();

    card.querySelector('.hd-cancel').addEventListener('click', () => { ov.style.display = 'none'; });
    card.querySelector('.hd-go').addEventListener('click', () => {
      this._startHide(partnerSel.value, roleSel.value === 'me', color);
    });

    return {
      ov,
      // 打开前刷新在线玩家列表；没有别人可玩就返回 false
      // 注意用箭头函数：这里需要的是 Game 实例的 this，不是这个返回对象的
      open: () => {
        const me = this.localState.id;
        const opts = [];
        for (const [id] of this.playerManager.players) {
          if (id === me) continue;
          opts.push(id);
        }
        if (!opts.length) return false;
        partnerSel.innerHTML = '';
        for (const id of opts) {
          const o = document.createElement('option');
          o.value = id;
          const rp = this.playerManager.players.get(id);
          o.textContent = (rp && rp.name) || ('玩家 ' + id.slice(-4)); // 用名牌上的名字，别暴露网络 id
          partnerSel.appendChild(o);
        }
        ov.style.display = 'flex';
        return true;
      },
      close: () => { ov.style.display = 'none'; },
      isOpen: () => ov.style.display !== 'none',
    };
  }

  // 抓的人屏幕顶部的方向指示：一个指向目标方位的箭头
  _createHideArrow() {
    const el = document.createElement('div');
    el.style.cssText =
      'position:fixed;left:50%;transform:translateX(-50%);z-index:59;display:none;pointer-events:none;' +
      'top:calc(env(safe-area-inset-top, 0px) + clamp(96px,17vmin,132px));text-align:center;' +
      'font:clamp(11px,2.8vmin,13px)/1.4 system-ui,"Microsoft YaHei",sans-serif;color:#fff;';
    el.innerHTML =
      '<div class="hd-arrow" style="font-size:26px;line-height:1;text-shadow:0 2px 6px rgba(0,0,0,.7);">' +
      '<span style="display:inline-block;">▲</span></div>' +
      '<div class="hd-text" style="margin-top:4px;text-shadow:0 1px 3px rgba(0,0,0,.7);"></div>';
    document.body.appendChild(el);
    return el;
  }

  // 使用捉迷藏玩具：已经在玩就结束，否则打开选人弹窗
  _useHideToy() {
    const me = this.localState.id;
    if (this._hide && (this._hide.hider === me || this._hide.seeker === me)) {
      this._endHide(true);
      return;
    }
    if (!this._hidePanel.open()) this._toast('没有其他玩家在线，捉迷藏要两个人');
  }

  _startHide(partnerId, iSeek, color) {
    const me = this.localState.id;
    if (!me || !partnerId) { this._toast('先选一个一起玩的人'); return; }
    const hider = iSeek ? partnerId : me;
    const seeker = iSeek ? me : partnerId;
    this._hidePanel.close();
    // 自己发的消息服务器不会再回给自己，所以本地先立即生效一次
    this.network.sendHide({ ev: 'start', hider, seeker, color });
    this._applyHideStart(hider, seeker, color);
  }

  _applyHideStart(hider, seeker, color) {
    const me = this.localState.id;
    this._hide = { hider, seeker, color };
    this._setMorph(hider, color || '#cccccc');
    this._hideHintDeg = null;
    this._hideHintAt = 0;
    // 开局先快速给一次方向，免得抓的人干等 30 秒以为坏了
    this._hideReportTimer = Config.HIDE_FIRST_REPORT;
    if (hider === me) this._toast('你变成了方块，躲好（每 ' + Config.HIDE_REPORT_INTERVAL + ' 秒会报一次方向）');
    else if (seeker === me) this._toast('开始抓人，走到对方附近就算抓到');
    this._updateHideArrow();
  }

  _endHide(broadcast) {
    const h = this._hide;
    this._hide = null;
    this._hideHintDeg = null;
    this._hideHintAt = 0;
    if (this._hideArrow) this._hideArrow.style.display = 'none';
    if (h) this._setMorph(h.hider, null);
    if (broadcast && h) this.network.sendHide({ ev: 'end', hider: h.hider, seeker: h.seeker, color: h.color });
  }

  // 把一个玩家变成方块（color 为 null 表示还原）
  _setMorph(id, color) {
    if (!id) return;
    const prev = this._morphs.get(id);
    if (prev) {
      this.scene.remove(prev.mesh);
      prev.mesh.geometry.dispose();
      prev.mesh.material.dispose();
      this._morphs.delete(id);
    }
    const rp = this.playerManager.players.get(id);
    if (!color) {
      if (rp && id !== this.localState.id) rp.model.visible = true;
      return;
    }
    const size = Config.HIDE_BLOCK_SIZE;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(size, size, size),
      new THREE.MeshStandardMaterial({ color, roughness: 0.75 })
    );
    mesh.castShadow = true;
    this.scene.add(mesh);
    this._morphs.set(id, { mesh });
    // 别人的方块要盖住原来的人形模型；自己的模型本来就看不见
    if (rp && id !== this.localState.id) rp.model.visible = false;
  }

  // 方块跟着人走。
  // 用「模型实际渲染到的位置」而不是网络状态来定位：远程玩家的模型位置由 RemotePlayer 每帧
  // 插值写入，本地玩家第三人称也写模型位置，这样方块一定贴着人，不会留在原地。
  // 第一人称看不到自己，所以本地方块只在第三人称显示。
  _updateMorphs() {
    if (!this._morphs.size) return;
    const s = this.localState;
    for (const [id, m] of this._morphs) {
      if (id === s.id) {
        m.mesh.position.set(s.x, s.y - Config.PLAYER_HEIGHT * 0.5, s.z);
        m.mesh.visible = this.thirdPerson;
        continue;
      }
      const rp = this.playerManager.players.get(id);
      if (!rp) { m.mesh.visible = false; continue; }
      const p = rp.model.position; // 模型原点在脚底
      m.mesh.position.set(p.x, p.y + Config.HIDE_BLOCK_SIZE * 0.5, p.z);
      m.mesh.visible = true;
      // 人形模型每帧确保是藏起来的，否则被别处重置可见性后会「留在原地」
      if (rp.model.visible) rp.model.visible = false;
    }
  }

  // 每帧：抓的人靠近就算抓到；躲的人每隔一段时间报一次模糊方向
  _updateHideReport(dt) {
    const h = this._hide;
    if (!h) return;
    const me = this.localState.id;

    if (me === h.seeker) {
      // 抓到判定用距离：抓的人走到躲的人附近就自动算抓到
      const target = this.playerManager.players.get(h.hider);
      if (target) {
        const d = Math.hypot(target.state.x - this.localState.x, target.state.z - this.localState.z);
        if (d <= Config.HIDE_CATCH_RANGE) {
          this._toast('抓到啦');
          this._endHide(true);
          return;
        }
      }
      this._updateHideArrow();
    }

    if (me !== h.hider) return;
    this._hideReportTimer -= dt;
    if (this._hideReportTimer > 0) return;
    this._hideReportTimer = Config.HIDE_REPORT_INTERVAL;
    const seeker = this.playerManager.players.get(h.seeker);
    if (!seeker) return;
    const dx = this.localState.x - seeker.state.x;
    const dz = this.localState.z - seeker.state.z;
    if (Math.hypot(dx, dz) < 1e-3) return;
    // 报的是「从抓的人看向我」的方位角，再叠加一个随机偏移做到「模糊」
    const fuzz = (Math.random() * 2 - 1) * (Config.HIDE_FUZZ_DEG * Math.PI) / 180;
    this.network.sendHide({ ev: 'hint', hider: me, deg: Math.atan2(dx, dz) + fuzz });
  }

  // 把世界方位角换算成「相对玩家朝向」的屏幕角度，转成顶部箭头
  _updateHideArrow() {
    const el = this._hideArrow;
    if (!el) return;
    const h = this._hide;
    if (!h || this.localState.id !== h.seeker || this._hideHintDeg == null) {
      el.style.display = 'none';
      return;
    }
    const yaw = this.localState.yaw;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const rx = -fz; // 玩家右手方向
    const rz = fx;
    const tx = Math.sin(this._hideHintDeg);
    const tz = Math.cos(this._hideHintDeg);
    const fwd = tx * fx + tz * fz;
    const right = tx * rx + tz * rz;
    const deg = (Math.atan2(right, fwd) * 180) / Math.PI;
    el.style.display = '';
    el.querySelector('.hd-arrow span').style.transform = 'rotate(' + deg.toFixed(1) + 'deg)';
    const rp = this.playerManager.players.get(h.hider);
    const who = (rp && rp.name) || '对方';
    // 报点年龄：让抓的人看得出提示是活的、多久后会再刷新一次
    const age = this._hideHintAt ? Math.max(0, Math.round((performance.now() - this._hideHintAt) / 1000)) : null;
    const ageText = age == null ? '还没有报点' : (age <= 1 ? '刚报点' : (age + ' 秒前报的点'));
    const text = '目标 ' + who + ' 在这个方向（' + ageText + '，模糊 ±' + Config.HIDE_FUZZ_DEG + '°）';
    if (text !== this._hideTxtCache) {
      this._hideTxtCache = text;
      el.querySelector('.hd-text').textContent = text;
    }
  }

  // ---------- 加特林 ----------

  // 按技能槽切换开火模式：开启后按住左键（手机按住「攻击」）持续扫射
  // ---------- 控制枪 ----------
  // 视线正前方 CTRL_DIST 处的「吊住点」：被控者会被拉到这个位置
  _ctrlAnchor() {
    const s = this.localState;
    const cp = Math.cos(s.pitch);
    const sp = Math.sin(s.pitch);
    return {
      x: s.x + (-Math.sin(s.yaw) * cp) * Config.CTRL_DIST,
      y: s.y + sp * Config.CTRL_DIST,
      z: s.z + (-Math.cos(s.yaw) * cp) * Config.CTRL_DIST,
    };
  }

  // 装备/收起控制枪：技能槽触发，和加特林一样是「切换」而不是直接开火；
  // 开启后左键才开火（抓人/松手）。收起时若正在控制则一并松手。
  _toggleCtrlGun() {
    this._ctrlOn = !this._ctrlOn;
    if (!this._ctrlOn && this._ctrl) this._releaseCtrl('已收起控制枪');
    this._updateBossUI(); // 同步手机端攻击按钮显隐（装备/收起控制枪都要即时反映）
    this._toast(this._ctrlOn ? '控制枪已就绪，左键开火抓人（再按一次收起）' : '已收起控制枪');
  }

  // 开火：射线抓最近的目标；已经在控制中则松手（同一个技能键切换）
  _fireCtrlGun() {
    this._ctrlFireAt = performance.now(); // 后坐动画计时
    if (this._ctrl) { this._releaseCtrl('已松开'); return; }
    const s = this.localState;
    const cp = Math.cos(s.pitch);
    const sp = Math.sin(s.pitch);
    const dx = -Math.sin(s.yaw) * cp;
    const dy = sp;
    const dz = -Math.cos(s.yaw) * cp;

    // 与其他玩家一样用「射线到躯干中心的最近距离」判定，取最近的一个
    let hitId = null;
    let hitT = Infinity;
    for (const [id, rp] of this.playerManager.players) {
      if (id === s.id) continue;
      const st = rp.state;
      const cy = st.y - Config.PLAYER_HEIGHT / 2;
      const t = (st.x - s.x) * dx + (cy - s.y) * dy + (st.z - s.z) * dz;
      if (t < 0 || t > Config.CTRL_RANGE || t >= hitT) continue;
      const px = s.x + dx * t;
      const py = s.y + dy * t;
      const pz = s.z + dz * t;
      if (Math.hypot(px - st.x, py - cy, pz - st.z) > Config.CTRL_HIT_RADIUS + Config.PLAYER_RADIUS) continue;
      hitId = id;
      hitT = t;
    }
    if (!hitId) { this._toast('控制枪没抓到人：对准别人再开火'); return; }

    const a = this._ctrlAnchor();
    this._ctrl = {
      id: hitId,
      // 控制不设时长上限（用户要求「时间无限」）：一直抓到你主动松手 / 对方按跳跃挣脱 / 对方离线
      until: Infinity,
      acc: 0,
      sent: false,
    };
    this.network.sendCtrl(hitId, true, a.x, a.y, a.z);
    this._toast('抓住了！移动视角就能拖动对方（对方按跳跃挣脱）');
  }

  // 松开：主动收枪 / 超时 / 目标离线。toastText 为空则不提示
  _releaseCtrl(toastText) {
    if (!this._ctrl) return;
    const id = this._ctrl.id;
    this._ctrl = null;
    this.network.sendCtrl(id, false, 0, 0, 0);
    this._setCtrlBeam(false);
    if (toastText) this._toast(toastText);
  }

  // 收到控制消息（被控侧）
  _applyCtrlMsg(msg) {
    if (!msg.on) {
      // 被控侧：对方松手
      if (this._ctrlBy) this._endControlled();
      // 控制侧：目标拒收（免疫期）或已自行挣脱 → 立刻收枪，
      // 否则会继续同步锚点直到超时
      if (this._ctrl && this._ctrl.id === msg.from) this._releaseCtrl('对方挣脱了');
      return;
    }
    const nowMs = performance.now();
    // 挣脱后的免疫期内拒绝，并回报对方让他收枪
    if (nowMs < this._ctrlImmuneUntil) {
      this.network.sendCtrl(msg.from, false, 0, 0, 0);
      return;
    }
    // 同一控制者的锚点同步会以 CTRL_RATE(20Hz) 反复进来：首次被抓才提示，之后静默刷新
    const firstGrab = !this._ctrlBy || this._ctrlBy.from !== msg.from;
    this._ctrlBy = {
      from: msg.from,
      // 不设时长上限，只做「掉线看门狗」：控制者还在同步锚点时 until 每次都被顺延；
      // 一旦 CTRL_WATCHDOG 秒收不到同步（对方掉线/崩溃），才自行松手。
      until: nowMs + Config.CTRL_WATCHDOG * 1000,
      ax: Number(msg.x) || 0,
      ay: Number(msg.y) || 0,
      az: Number(msg.z) || 0,
    };
    this._setCtrlOverlay(true); // 被控的人：屏幕变蓝
    if (firstGrab) this._toast('被控制枪抓住了！按跳跃挣脱');
  }

  // 挣脱：通知控制者并进入短时免疫
  _breakCtrl() {
    if (!this._ctrlBy) return;
    const from = this._ctrlBy.from;
    this._endControlled();
    this._ctrlImmuneUntil = performance.now() + Config.CTRL_BREAK_COOLDOWN * 1000;
    this.network.sendCtrl(from, false, 0, 0, 0);
    this._toast('挣脱成功！');
  }

  // 结束被控状态：清掉速度覆盖，否则会带着控制时的速度继续飞
  _endControlled() {
    this._setCtrlOverlay(false); // 无论走哪条路（主动挣脱 / 对方松手 / 看门狗超时）都先把蓝屏收掉
    if (!this._ctrlBy) return;
    this._ctrlBy = null;
    if (this.localPlayer && this.localPlayer.physics) this.localPlayer.physics.velocityHold = null;
  }

  // 每帧：控制者按 CTRL_RATE 同步锚点；被控者被拉向锚点，按空格可挣脱
  _updateCtrl(dt) {
    // 第一人称手持：装备了控制枪就一直握着（第三人称/死亡/加特林开启时收起）
    if (this._ctrlRig) {
      const held = !!(this._ctrlOn || this._ctrl)
        && !this.thirdPerson && !this._dead && !this._gatlingOn;
      this._ctrlRig.visible = held;
      if (held) {
        // 开火后坐：150ms 内往回收一点再回位
        const k = Math.max(0, 1 - (performance.now() - this._ctrlFireAt) / 150);
        this._ctrlRig.position.z = -0.5 + 0.07 * k;
      }
    }
    // ---- 被控侧：先抢在物理消费跳跃之前取走这次空格，用作挣脱 ----
    if (this._ctrlBy && this.input && typeof this.input.consumeJump === 'function') {
      if (this.input.consumeJump()) this._breakCtrl();
    }

    // ---- 控制者侧 ----
    if (this._ctrl) {
      const target = this.playerManager.players.get(this._ctrl.id);
      if (!target) {
        this._releaseCtrl(null); // 目标已离线：静默收枪
      } else {
        this._ctrl.acc += dt;
        if (!this._ctrl.sent || this._ctrl.acc >= 1 / Config.CTRL_RATE) {
          this._ctrl.acc = 0;
          this._ctrl.sent = true;
          const a = this._ctrlAnchor();
          this.network.sendCtrl(this._ctrl.id, true, a.x, a.y, a.z);
        }
        this._setCtrlBeam(true, target.state);
      }
    }

    // ---- 被控侧：朝锚点移动（用 velocityHold 覆盖输入与重力）----
    if (this._ctrlBy) {
      // 控制者一直在同步锚点 → until 每次都被顺延；走到这里 = CTRL_WATCHDOG 秒没消息（对方掉线）
      if (performance.now() >= this._ctrlBy.until) {
        this._endControlled();
        this._toast('与控制者失去联系，已松手');
      } else {
        const c = this._ctrlBy;
        const s = this.localState;
        const dx = c.ax - s.x;
        const dy = c.ay - s.y;
        const dz = c.az - s.z;
        const d = Math.hypot(dx, dy, dz);
        const phys = this.localPlayer.physics;
        const hold = Math.max(dt, 0.05); // 每帧续上，等于持续速度
        if (d > 0.08) {
          // 接近锚点时按比例减速，避免在锚点附近来回抖
          const k = Math.min(1, d / 0.6);
          const vx = (dx / d) * Config.CTRL_FOLLOW * k;
          const vz = (dz / d) * Config.CTRL_FOLLOW * k;
          const vy = THREE.MathUtils.clamp((dy / d) * Config.CTRL_FOLLOW, -Config.CTRL_LIFT, Config.CTRL_LIFT);
          phys.velocityHold = { x: vx, y: vy, z: vz, t: hold };
        } else {
          phys.velocityHold = { x: 0, y: 0, z: 0, t: hold }; // 到位后悬停（由 hold 抵消重力）
        }
      }
    }
  }

  // 控制激光线：从自己视角前方连到被控者躯干
  _setCtrlBeam(on, targetState) {
    if (!on || !targetState) {
      if (this._ctrlBeam) this._ctrlBeam.visible = false;
      return;
    }
    if (!this._ctrlBeam) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      const mat = new THREE.LineBasicMaterial({
        color: 0x36d6ff, transparent: true, opacity: 0.85, depthTest: false,
      });
      this._ctrlBeam = new THREE.Line(geo, mat);
      this._ctrlBeam.renderOrder = 900;
      this._ctrlBeam.frustumCulled = false;
      this.scene.add(this._ctrlBeam);
    }
    const s = this.localState;
    const p = this._ctrlBeam.geometry.attributes.position;
    p.setXYZ(0, s.x, s.y - 0.25, s.z);
    p.setXYZ(1, targetState.x, targetState.y - Config.PLAYER_HEIGHT / 2, targetState.z);
    p.needsUpdate = true;
    this._ctrlBeam.geometry.computeBoundingSphere();
    this._ctrlBeam.visible = true;
  }

  _toggleGatling() {
    this._gatlingOn = !this._gatlingOn;
    this._gatlingHeld = false;
    this._updateGatlingUI();
    this._toast(this._gatlingOn ? '加特林已就绪，按住左键扫射' : '已收起加特林');
  }

  // 开火：瞬时射线判定（扫射用抛体太吵），伤害只由自己这边的客户端结算
  _fireGatling() {
    const s = this.localState;
    const cosP = Math.cos(s.pitch);
    const sinP = Math.sin(s.pitch);
    const dx = -Math.sin(s.yaw) * cosP;
    const dy = sinP;
    const dz = -Math.cos(s.yaw) * cosP;

    // 其他玩家：取射线到躯干中心的最近距离
    let hitId = null;
    let hitT = Infinity;
    for (const [id, rp] of this.playerManager.players) {
      if (id === s.id) continue;
      const st = rp.state;
      const cy = st.y - Config.PLAYER_HEIGHT / 2;
      const t = (st.x - s.x) * dx + (cy - s.y) * dy + (st.z - s.z) * dz;
      if (t < 0 || t > Config.GATLING_RANGE || t >= hitT) continue;
      const px = s.x + dx * t;
      const py = s.y + dy * t;
      const pz = s.z + dz * t;
      if (Math.hypot(px - st.x, py - cy, pz - st.z) > Config.GATLING_HIT_RADIUS + Config.PLAYER_RADIUS) continue;
      hitId = id;
      hitT = t;
    }

    // 老师：比前面的玩家更近就改打她
    let hitBoss = false;
    if (this.boss && this.boss.mode === 'alive') {
      const bp = this.boss.pos;
      const cy = Config.BOSS_HEIGHT * 0.5;
      const t = (bp.x - s.x) * dx + (cy - s.y) * dy + (bp.z - s.z) * dz;
      if (t >= 0 && t <= Config.GATLING_RANGE && t < hitT) {
        const px = s.x + dx * t;
        const py = s.y + dy * t;
        const pz = s.z + dz * t;
        if (Math.hypot(px - bp.x, pz - bp.z) <= Config.BOSS_RADIUS + Config.GATLING_HIT_RADIUS
          && Math.abs(py - cy) < Config.BOSS_HEIGHT) {
          hitBoss = true;
          hitT = t;
        }
      }
    }

    // 墙体拦截：射线被墙挡住就打不到墙后的人（也决定了子弹视觉飞到哪）
    const probe = Number.isFinite(hitT) ? Math.min(Config.GATLING_RANGE, hitT + 1) : Config.GATLING_RANGE;
    const clear = this._gatlingClearDistance(s.x, s.y, s.z, dx, dy, dz, probe);

    if (Number.isFinite(hitT) && hitT <= clear) {
      if (hitBoss) {
        this.boss.hurtBy(Config.GATLING_DAMAGE);
        this._addSuperCharge(Config.GATLING_DAMAGE);
      } else if (hitId) {
        this.network.sendHit(hitId, Config.GATLING_DAMAGE);
      }
    }

    // 子弹视觉：从枪口沿射线飞出去，打到墙或目标就消失
    const travel = Math.min(Number.isFinite(hitT) ? hitT : Config.GATLING_RANGE, clear);
    this._spawnBullet(s.x, s.y, s.z, dx, dy, dz, travel);
    // 广播这一发：别人那里按同样的「起点 + 方向 + 距离」复刻一颗，才看得见我在开枪。
    // 注意起点传 s（眼睛）而不是枪口——_spawnBullet 自己会往前挪 0.6m，两端要完全一致。
    this.network.sendShot({ x: s.x, y: s.y, z: s.z, dx, dy, dz, d: travel });
    this._gatlingHeat = Math.min(100, this._gatlingHeat + Config.GATLING_HEAT_PER_SHOT);
  }

  // 射线能穿过多远：以固定步进向前采样，每一步都用「线段扫描」判定，
  // 所以薄墙、楼板都拦得住；返回被挡住的距离（一路通畅就是 maxDist）。
  _gatlingClearDistance(ox, oy, oz, dx, dy, dz, maxDist) {
    const step = Config.GATLING_BULLET_STEP;
    let px = ox;
    let py = oy;
    let pz = oz;
    for (let t = step; t <= maxDist; t += step) {
      const x = ox + dx * t;
      const y = oy + dy * t;
      const z = oz + dz * t;
      if (this._projectileHitsWorld(x, y, z, 0.1, px, py, pz)) return Math.max(0.5, t - step);
      px = x;
      py = y;
      pz = z;
    }
    return maxDist;
  }

  _spawnBullet(ox, oy, oz, dx, dy, dz, maxDist) {
    const mesh = new THREE.Mesh(this._bulletGeo, this._bulletMat);
    const sx = ox + dx * 0.6, sy = oy + dy * 0.6, sz = oz + dz * 0.6; // 枪口：从眼睛往前挪一点
    mesh.position.set(sx, sy, sz);
    // 圆柱默认沿 Y，转到飞行方向：曳光条是「顺着弹道飞」的一小段线，不是一根朝天的棍子
    _bDir.set(dx, dy, dz);
    if (_bDir.lengthSq() > 1e-8) mesh.quaternion.setFromUnitVectors(UP_Y, _bDir.normalize());
    // 长度取 0.9m 上限并夹在飞行距离内：近距离打墙时不至于穿出一截
    mesh.scale.set(1, Math.max(0.25, Math.min(0.9, maxDist)), 1);
    this.scene.add(mesh);
    this._bullets.push({
      mesh, dx, dy, dz,
      ox: sx, oy: sy, oz: sz,
      traveled: 0,
      maxDist: Math.max(0.6, maxDist),
    });
  }

  _updateGatling(dt) {
    // 顺序很关键：必须先判这一帧开不开火，再决定散不散热。
    // 原来散热写在开火之前、而且是无条件的，等于「边打边降温」——
    // 10 发/秒 × 3.5 = +35/秒 的升温被 28/秒 的散热抵消成净 +7/秒，要 14 秒才过热，过热机制等于没有。
    this._gatlingCd -= dt;
    const holding = this._gatlingOn && this._gatlingHeld && !this._gatlingOverheated;
    let fired = false;
    if (holding && this._gatlingCd <= 0) {
      this._gatlingCd = Config.GATLING_INTERVAL;
      this._fireGatling();
      fired = true;
      if (this._gatlingHeat >= 100) {
        this._gatlingOverheated = true;
        this._gatlingCoolDelay = 0; // 已经过热了就立刻开始散热，别再白等一个延迟
        this._toast('加特林过热了，等它冷却');
      }
    }

    // 散热：扣着扳机时一律不降（打点射靠 COOL_DELAY 留住余温），松手后才按速率降
    if (fired || holding) {
      this._gatlingCoolDelay = Config.GATLING_COOL_DELAY;
    } else if (this._gatlingCoolDelay > 0) {
      this._gatlingCoolDelay -= dt;
    } else if (this._gatlingHeat > 0) {
      this._gatlingHeat = Math.max(0, this._gatlingHeat - Config.GATLING_COOL_RATE * dt);
    }
    if (this._gatlingOverheated && this._gatlingHeat <= Config.GATLING_RECOVER_AT) {
      this._gatlingOverheated = false;
      this._toast('加特林冷却完成');
    }

    // 子弹一直往前飞，飞满距离或撞到墙后由 _fireGatling 算出的 travel 消失
    if (this._bullets.length) {
      const speed = Config.GATLING_BULLET_SPEED * dt;
      for (let i = this._bullets.length - 1; i >= 0; i--) {
        const b = this._bullets[i];
        b.traveled += speed;
        if (b.traveled >= b.maxDist) {
          this.scene.remove(b.mesh);
          this._bullets.splice(i, 1);
          continue;
        }
        b.mesh.position.set(
          b.ox + b.dx * b.traveled,
          b.oy + b.dy * b.traveled,
          b.oz + b.dz * b.traveled
        );
      }
    }

    this._updateGatlingUI();

    // 手里握着加特林：开启期间一直显示（第三人称/死亡时收起）；
    // 开火且没过热时枪管转起来，停火就停在当前角度
    if (this._gatlingRig) {
      const held = this._gatlingOn && !this.thirdPerson && !this._dead;
      this._gatlingRig.visible = held;
      if (held && this._gatlingHeld && !this._gatlingOverheated && this._gatlingBarrels) {
        this._gatlingBarrels.rotation.z += dt * 22;
      }
    }
  }

  _createGatlingBar() {
    const box = document.createElement('div');
    box.style.cssText =
      'position:fixed;left:50%;transform:translateX(-50%);z-index:61;display:none;pointer-events:none;' +
      'bottom:calc(env(safe-area-inset-bottom, 0px) + 34%);width:min(220px,52vw);text-align:center;' +
      'font:clamp(11px,2.8vmin,12px)/1.3 var(--kui-font);color:var(--kui-paper);';
    // 进度条外观交给主题类；高度仍用内联保持原尺寸，填充色由 _updateGatlingUI 按热度动态写入
    const track = document.createElement('div');
    track.className = 'kui-bar';
    track.style.cssText = 'height:8px;';
    const fill = document.createElement('div');
    fill.className = 'kui-bar__fill';
    fill.style.cssText = 'width:0%;background:var(--kui-ok);transition:width .06s linear;';
    track.appendChild(fill);
    const txt = document.createElement('div');
    txt.style.cssText = 'margin-top:4px;text-shadow:0 1px 3px rgba(0,0,0,.7);';
    txt.textContent = '加特林';
    box.appendChild(track);
    box.appendChild(txt);
    document.body.appendChild(box);
    return { box, fill, txt };
  }

  _updateGatlingUI() {
    const bar = this._gatlingBar;
    if (!bar) return;
    const show = this._gatlingOn;
    if (this._gatlingBarShown !== show) {
      this._gatlingBarShown = show;
      bar.box.style.display = show ? '' : 'none';
    }
    if (!show) return;
    const heat = Math.round(this._gatlingHeat);
    const key = heat + '|' + (this._gatlingOverheated ? 1 : 0);
    if (key === this._gatlingBarKey) return;
    this._gatlingBarKey = key;
    bar.fill.style.width = heat + '%';
    bar.fill.style.background = this._gatlingOverheated ? 'var(--kui-danger)' : (heat > 65 ? 'var(--kui-warn)' : 'var(--kui-ok)');
    bar.txt.textContent = this._gatlingOverheated ? '加特林过热中，等它冷却' : ('加特林 ' + heat + '%');
  }

  // 别人发起的捉迷藏事件
  _onHideNet(msg) {
    const me = this.localState.id;
    if (msg.ev === 'start') {
      if (!msg.hider || !msg.seeker) return;
      this._applyHideStart(msg.hider, msg.seeker, msg.color);
      if (msg.seeker === me) this._toast('有人邀请你抓人');
    } else if (msg.ev === 'hint') {
      if (this._hide && this._hide.hider === msg.hider) {
        this._hideHintDeg = Number(msg.deg) || 0;
        this._hideHintAt = performance.now();
        this._updateHideArrow();
      }
    } else if (msg.ev === 'end') {
      this._setMorph(msg.hider, null);
      if (this._hide && this._hide.hider === msg.hider) {
        this._hide = null;
        this._hideHintDeg = null;
        this._hideHintAt = 0;
        if (this._hideArrow) this._hideArrow.style.display = 'none';
      }
      if (msg.seeker === me || msg.hider === me) this._toast('捉迷藏结束');
    }
  }

  // 屏幕中心右侧的「按 F 与她对话」选项卡：仅靠近阿花显示，点击开/关底部对话栏；位置略往中间收
  _createChatTab() {
    const el = document.createElement('div');
    el.className = 'chat-tab kui-btn kui-btn--primary'; // 保留 chat-tab 供手机端「按键布局调整」定位与检查
    el.textContent = '按 F 与她对话';
    el.style.cssText =
      'position:fixed;right:26%;top:50%;transform:translateY(-50%);z-index:9500;cursor:pointer;display:none;' +
      'padding:9px 12px;user-select:none;text-align:center;';
    el.addEventListener('click', () => { this.aiChat.toggle(); });
    document.body.appendChild(el);
    this._chatTab = el;
  }

  // 顶部按钮：PC 上贴着校卡左右两侧；手机端校卡贴最左，这三个按钮在它右边排成一行
  //
  // 结构（2026-10-04 按用户要求改）：**按钮里只放图标，文字放在按钮外面**。
  //   <span class="kui-topbtn">
  //     <i class="kui-iconbtn"><svg/></i>   ← 只有方形图标键，可点区域大
  //     <b>背包</b>                        ← 外置文字标签，不在按钮里
  //   </span>
  // 为什么文字还要留：光看交叉的剑认不出「对战匹配」。但塞进按钮里会让键面变宽、挤掉顶部空间，
  // 所以文字移到按钮外侧 —— 图标负责点得准，文字负责看得懂。
  _createTopButtons() {
    const coarse = !!this._coarsePointer;

    // 建「图标键 + 外置标签」这一组，返回 { wrap, btn, label }
    // btn 上挂 _label 供 _setCombatBtnText 改文案（外置标签不是按钮的子节点，改它不会动按钮）
    // 外观全在 theme.js 的 .kui-topbtn 里，这里只补动态部分（定位、图标反色、事件）
    const mkIconLabel = (text, ic, onClick) => {
      const wrap = document.createElement('span');
      wrap.className = 'kui-topbtn';

      const btn = document.createElement('i');
      btn.className = 'kui-iconbtn';
      btn.title = text; // 悬停给全称，图标化之后这个更重要
      btn.insertAdjacentHTML('afterbegin', icon(ic, { size: '1.05em' }));
      // Kenney 素材原色是白，方形键是深底 → 图标要反成浅色才看得见
      btn.querySelector('svg').style.color = 'var(--kui-paper)';
      btn.addEventListener('click', onClick);

      const label = document.createElement('b');
      label.textContent = text;
      // 点文字等同于点按钮（小键不好点）
      label.addEventListener('click', onClick);

      wrap.appendChild(btn);
      wrap.appendChild(label);
      btn._label = label; // 供 _setCombatBtnText 用
      return { wrap, btn, label };
    };

    if (coarse) {
      // 校卡（见 PlayerHUD 的 pointer:coarse 媒体查询）占左侧 12+168px，这里从它右边 4px 开始，靠右对齐。
      // 三处基础值都要加上安全区：横屏时刘海在左右两侧，不减掉 inset 的话校卡会被切、
      // 最右边的「对战匹配」会被顶出屏幕。基础值 184 = 12 + 168 + 4，与校卡宽度是一对，ui-check 有对拍。
      // （168 是校卡**收起态**小牌的宽度，见 PlayerHUD 的 pointer:coarse 媒体查询；
      //   学币并进校卡后小牌从 156 放宽到 168，改那边必须同步改这里，否则按钮会压在校卡上。）
      // ⚠ 排布（flex / gap）交给 theme.js 的 .kui-toprow：极窄屏要把 gap 收紧，
      //   行内样式压不过媒体查询；这里只写定位。
      const row = document.createElement('div');
      row.className = 'kui-toprow';
      row.style.cssText =
        'position:fixed;z-index:9500;' +
        'left:calc(env(safe-area-inset-left, 0px) + 184px);' +
        'right:calc(env(safe-area-inset-right, 0px) + 8px);' +
        'top:calc(env(safe-area-inset-top, 0px) + 12px);';
      document.body.appendChild(row);
      const mk = (text, ic, onClick) => {
        const g = mkIconLabel(text, ic, onClick);
        row.appendChild(g.wrap);
        return g.btn;
      };
      this._topRow = row;
      this._btnBag = mk('背包', 'bag', () => this._toggleBag());
      this._btnSettings = mk('设置', 'settings', () => this.settingsPanel.toggle());
      this._btnCombat = mk('对战匹配', 'combat', () => this._toggleCombat());
      this._btnFullscreen = mk('全屏', 'fullscreen', () => this._toggleFullscreen());
      this._buildBag();
      this._initFullscreenBtn();
      return;
    }

    // PC：每个是「图标键 + 文字」一组，整组按 posCss 固定定位
    // ⚠ 别写 `wrap.style.cssText += posCss` —— cssText 一旦被赋值就会**整条替换**，
    //   把 .kui-topbtn 里的 display/flex/gap 全冲掉。这里只逐个设定位属性。
    const mkBtn = (text, ic, posCss, onClick) => {
      const g = mkIconLabel(text, ic, onClick);
      // posCss 形如 'right:calc(50% + 208px);top:14px;'
      for (const decl of posCss.split(';')) {
        const i = decl.indexOf(':');
        if (i < 0) continue;
        g.wrap.style.setProperty(decl.slice(0, i).trim(), decl.slice(i + 1).trim());
      }
      g.wrap.style.position = 'fixed';
      g.wrap.style.zIndex = '9500';
      document.body.appendChild(g.wrap);
      return g.btn;
    };
    // 校卡展开时最宽 268px（居中 → 右边缘在 50% + 134）。
    // 文字在图标**下方**（垂直排列）后，横向占位只由最宽的标签决定：
    // 最长是「对战匹配」4 字 ≈ 4×11 = 44px，比 36px 的图标键略宽 → 组宽取 48。
    // 锚点 = 134（卡半宽）+ 48（组宽）+ 10（间距）= 192。
    this._btnBag = mkBtn('背包', 'bag', 'right:calc(50% + 192px);top:10px;', () => this._toggleBag());
    this._btnSettings = mkBtn('设置', 'settings', 'left:calc(50% + 192px);top:10px;', () => this.settingsPanel.toggle());
    // 对战匹配：右上角独立按钮，点开匹配/退出对战（文案随状态变化 → 两字/四字宽度不同）
    this._btnCombat = mkBtn('对战匹配', 'combat', 'right:12px;top:10px;', () => this._toggleCombat());
    // 全屏：排在「设置」右边（192 + 组宽 48 + 间距 10 = 250）
    this._btnFullscreen = mkBtn('全屏', 'fullscreen', 'left:calc(50% + 250px);top:10px;', () => this._toggleFullscreen());
    this._buildBag();
    this._initFullscreenBtn();
  }

  // ---- 全屏按钮 ----
  // 始终显示：支持元素全屏的平台（桌面 / Android / iPadOS）走真正的 Fullscreen API；
  // 不支持的平台（iPhone Safari）不再把按钮藏掉，而是点一下退化成「沉浸模式」——
  // 隐藏顶栏/校卡等干扰 UI、画面铺满，等于 iOS 上能拿到的「全屏」体验。
  // 状态变化（用户按 F11 / Esc、或沉浸模式切换）后同步文案，所以监听 document 事件 + 自管 body 类。
  _initFullscreenBtn() {
    const b = this._btnFullscreen;
    if (!b) return;
    const wrap = b.parentElement; // 图标键外套着 .kui-topbtn（文字也在里面）
    if (wrap) wrap.classList.add('kui-topbtn--fs'); // 沉浸模式下靠这个类把「全屏」按钮留在屏幕上
    // 真正支持全屏的平台才需要监听全屏事件；沉浸模式靠点击就地切换，不走 document 事件。
    if (fullscreenSupported()) {
      this._offFullscreen = onFullscreenChange(() => this._syncFullscreenBtn());
    }
    this._syncFullscreenBtn();
  }

  _syncFullscreenBtn() {
    const b = this._btnFullscreen;
    if (!b) return;
    // 处于「真全屏」或「沉浸模式」都显示「退出全屏」
    const on = isFullscreen() || document.body.classList.contains('kui-immersive');
    const text = on ? '退出全屏' : '全屏';
    if (b._label) {
      b._label.textContent = text;
      b.title = text; // 图标化之后 title 是唯一说明，必须跟着变
    } else {
      b.textContent = text;
    }
  }

  _toggleFullscreen() {
    if (fullscreenSupported()) {
      const was = isFullscreen(); // 记住意图：退出全屏后 on=false 是正常结果，不能当成「失败」
      // 浏览器要求这一步发生在用户手势里（点击回调内），这里正好是。
      toggleFullscreen().then((on) => {
        this._syncFullscreenBtn();
        if (on === was) this._toast(was ? '没能退出全屏' : '没能进入全屏');
      });
      return;
    }
    // iOS 等不支持元素全屏：退化成「沉浸模式」——隐藏顶栏/校卡等干扰 UI，画面铺满。
    const on = document.body.classList.toggle('kui-immersive');
    this._syncFullscreenBtn();
    if (on) this._toast('已进入沉浸模式（隐藏界面），再点一次恢复');
  }

  // ---- 骑车「视角操控 / 锁视角」切换按钮 ----
  // 仅坐在驾驶位时出现：点一下在「自由视角（鼠标可左右掰头看）」与「锁视角（相机恒在车后）」间切换。
  // 状态同时写进设置（rideView），面板开着也会同步；默认跟随设置项。
  _ensureRideViewBtn() {
    if (this._rideViewBtn) return this._rideViewBtn;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'kui-btn kui-btn--primary';
    btn.style.cssText =
      'position:fixed;left:50%;transform:translateX(-50%);z-index:9600;display:none;' +
      'bottom:calc(env(safe-area-inset-bottom, 0px) + 12px);font:inherit;';
    btn.addEventListener('click', () => this._toggleRideView());
    document.body.appendChild(btn);
    this._rideViewBtn = btn;
    this._syncRideViewBtn();
    return btn;
  }

  _syncRideViewBtn() {
    const b = this._rideViewBtn;
    if (!b) return;
    const locked = !!(this.localPlayer && this.localPlayer._rideViewLocked);
    const text = locked ? '锁视角' : '自由视角';
    if (b._label) { b._label.textContent = text; b.title = text; }
    else { b.textContent = text; }
  }

  _toggleRideView() {
    const on = !(this.localPlayer && this.localPlayer._rideViewLocked);
    if (this.localPlayer) this.localPlayer.setRideViewLocked(on);
    // 同步到设置（面板开着也跟着变）
    if (this.settingsPanel && typeof this.settingsPanel.setField === 'function') {
      this.settingsPanel.setField('rideView', on ? '锁视角' : '视角操控');
    }
    this._syncRideViewBtn();
  }

  // 改「对战匹配」按钮的文案。
  // ⚠ 文字不在按钮里（按钮只有图标），而是外置的 <b> 标签 —— 建按钮时挂在 btn._label 上。
  //   早先那版文字在按钮内，用 textContent 改会把图标一起抹掉；现在改成 label 后同样不能用
  //   textContent 写按钮本身，得写到 _label 上。挂 _label 时有 updateTitle 兜底同步 title。
  _setCombatBtnText(text) {
    const b = this._btnCombat;
    if (!b) return;
    if (b._label) {
      b._label.textContent = text;
      b.title = text; // 悬停提示跟着变，否则图标化之后 title 还是旧的「对战匹配」
    } else {
      b.textContent = text; // 万一按钮是别处造的，退回旧行为
    }
  }

  _buildBag() {
    // 全屏浮层只保留定位/滚动/显隐；配色统一走主题变量
    const ov = document.createElement('div');
    ov.style.cssText =
      'position:fixed;z-index:9700;top:0;left:0;width:100vw;height:100vh;overflow:auto;' +
      'background:rgba(11,21,34,.62);' +
      'box-sizing:border-box;padding:84px 24px 40px;display:none;' +
      'font:14px/1.5 var(--kui-font);color:var(--kui-ink);';
    ov.innerHTML =
      '<div class="kui-panel" style="position:fixed;top:0;left:0;right:0;z-index:1;box-sizing:border-box;">' +
      '<div class="kui-panel__body" style="display:flex;justify-content:space-between;align-items:center;gap:10px;">' +
      '<h2 class="kui-title" style="margin:0;font-size:17px;">我的背包</h2>' +
      '<button type="button" class="kui-iconbtn">×</button></div></div>' +
      '<div class="kui-tabs">' +
      '<button type="button" class="kui-tab is-active" data-bag="items">道具</button>' +
      '<button type="button" class="kui-tab" data-bag="furniture">家具</button>' +
      '</div>' +
      '<div class="bag-grid"></div>';
    document.body.appendChild(ov);
    ov.querySelector('.kui-iconbtn').addEventListener('click', () => { ov.style.display = 'none'; });
    this._bagOv = ov;
    this._bagList = ov.querySelector('.bag-grid');
    this._bagTab = 'items';
    const tabs = Array.from(ov.querySelectorAll('.kui-tab'));
    tabs.forEach((b) => b.addEventListener('click', () => {
      this._bagTab = b.dataset.bag === 'furniture' ? 'furniture' : 'items';
      tabs.forEach((x) => x.classList.toggle('is-active', x === b));
      this._renderBag();
    }));
  }

  _toggleBag() {
    this._renderBag();
    this._bagOv.style.display = this._bagOv.style.display === 'none' ? 'block' : 'none';
  }

  _renderBag() {
    const bag = loadBag(getBagKey(this._profile));
    const furn = furnitureNames();
    const isFurn = this._bagTab === 'furniture';
    // 道具页签只列普通道具；家具页签只列家具（家具按名字存进背包，随背包云同步）
    const entries = Object.entries(bag).filter(([n, v]) => v > 0 && (isFurn ? furn.has(n) : !furn.has(n)));
    const grid = this._bagList;
    if (!grid) return;
    grid.innerHTML = '';
    if (!entries.length) {
      grid.style.cssText = 'text-align:center;color:var(--kui-paper);padding:40px 0;';
      grid.textContent = isFurn ? '还没有家具，去小满杂货铺的「家具」页买。' : '背包空空如也，去喷泉边找阿花要宝贝吧。';
      return;
    }
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:14px;padding-top:6px;';
    for (const [name, count] of entries) {
      const eff = this._effectForItem(name);
      const card = document.createElement('div');
      card.className = 'kui-panel';
      const cardBody = document.createElement('div');
      cardBody.className = 'kui-panel__body';
      cardBody.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:8px;';
      // 图标：带颜色的圆角方块 + 手绘 SVG 图标（与 Kenney 图标同款渲染：currentColor）
      const icon = document.createElement('div');
      icon.innerHTML = itemIconSvg(this._itemIconKey(name), { size: '32px' });
      icon.style.cssText =
        'width:52px;height:52px;border-radius:var(--kui-radius);display:flex;align-items:center;justify-content:center;' +
        'background:' + this._itemColor(name) + ';color:var(--kui-paper);';
      const meta = document.createElement('div');
      meta.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:2px;text-align:center;';
      const nameEl = document.createElement('div');
      nameEl.textContent = name;
      nameEl.style.cssText = 'font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:120px;';
      const countEl = document.createElement('div');
      countEl.textContent = isFurn ? ('剩余可摆 × ' + count) : ('× ' + count + '   ·' + eff.label);
      countEl.style.cssText = 'font-size:12px;color:var(--kui-ink-soft);';
      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;flex-direction:column;gap:6px;align-items:center;width:100%;';
      if (isFurn) {
        // 家具：没有「使用/技能槽」，改成「去摆放」（进建造模式）
        const placeBtn = document.createElement('button');
        placeBtn.type = 'button';
        placeBtn.textContent = '去摆放';
        placeBtn.className = 'kui-btn kui-btn--primary';
        placeBtn.addEventListener('click', () => {
          if (this._buildTool && this._buildTool.hasHammer()) {
            this._bagOv.style.display = 'none';
            this._buildTool.enter();
          } else {
            this._toast('先在小满杂货铺的「道具」页买「建造锤」，再用技能槽里的它进入建造模式');
          }
        });
        btnRow.appendChild(placeBtn);
      } else {
        // 槽位选择：选「直接使用」则只触发效果；选具体槽位则把该物品指定到该技能键后再触发
        const slotSel = document.createElement('select');
        slotSel.className = 'kui-input';
        slotSel.style.cssText = 'font-size:12px;padding:5px 8px;max-width:130px;';
        const optNone = document.createElement('option');
        optNone.value = '';
        optNone.textContent = '直接使用';
        slotSel.appendChild(optNone);
        for (let i = 0; i < SLOT_COUNT; i++) {
          const o = document.createElement('option');
          o.value = String(i);
          o.textContent = '装备到 ' + (i + 1) + ' 号槽';
          slotSel.appendChild(o);
        }
        // 已经指定到某槽时，默认选中该槽，方便看出当前归属
        const cur = Object.keys(this._skillMap).find((k) => this._skillMap[k] === name);
        if (cur != null) slotSel.value = String(cur);
        const useBtn = document.createElement('button');
        useBtn.type = 'button';
        useBtn.textContent = '使用';
        useBtn.className = 'kui-btn kui-btn--primary';
        useBtn.addEventListener('click', () => {
          const v = slotSel.value;
          this._useItem(name, v === '' ? null : Number(v));
          this._renderBag();
        });
        btnRow.appendChild(slotSel);
        btnRow.appendChild(useBtn);
      }
      // 从背包里丢掉一件（每次减 1，减到 0 整条移除）
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.textContent = isFurn ? '丢弃' : '销毁';
      delBtn.className = 'kui-btn kui-btn--danger';
      delBtn.addEventListener('click', () => {
        removeFromBag(getBagKey(this._profile), name, 1);
        this._renderBag();
      });
      btnRow.appendChild(delBtn);
      meta.appendChild(nameEl);
      meta.appendChild(countEl);
      cardBody.appendChild(icon);
      cardBody.appendChild(meta);
      cardBody.appendChild(btnRow);
      card.appendChild(cardBody);
      grid.appendChild(card);
    }
  }

  // 把玩家一句话发给后端 GLM 代理，拿到 {reply, action} 后：展示回复并执行工具动作。
  async _npcSend(text) {
    const aichat = this.aiChat;
    aichat.addMsg('busy', '阿花正在想…');
    const msgs = this._npcHistory || [];
    msgs.push({ role: 'user', content: text });
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 20000) : null;
    try {
      const res = await fetch(API_BASE + '/api/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: msgs }),
        signal: ctrl ? ctrl.signal : undefined,
      });
      if (timer) clearTimeout(timer);
      const data = await res.json();
      if (!data || !data.ok) throw new Error((data && data.error) || ('http ' + res.status));
      const reply = data.reply || '…';
      // 诊断：pv 是后端提示词版本号，raw 是 action 为空时模型的原始输出
      console.log('[阿花] pv=' + (data.pv || '未知(旧后端)'), 'action=' + JSON.stringify(data.action), 'raw=' + (data.raw || ''));
      msgs.push({ role: 'assistant', content: reply });
      // 只保留最近若干条，避免历史无限膨胀
      this._npcHistory = msgs.slice(-12);
      aichat.addMsg('npc', reply);
      if (data.action) this._executeNpcAction(data.action);
    } catch (e) {
      aichat.addMsg('npc', '阿花好像卡住了，请稍后再试。');
    }
  }

  // 执行 GLM 点名的工具动作。所有参数已经过后端清洗（越界值被钳制或整条丢弃），这里只做贴上玩家。
  _executeNpcAction(action) {
    if (!action || !action.name) return;
    const state = this.localState;
    const phys = this.localPlayer.physics;
    const a = action.args || {};
    // 带 seconds 的动作：到点自动恢复默认值（只在该值没被后续动作覆盖时还原）
    const after = (secs, fn) => { if (secs && secs > 0) setTimeout(fn, secs * 1000); };
    switch (action.name) {
      case 'set_player_speed': {
        const m = a.multiplier;
        phys.speedMult = m;
        if (a.mode) phys.speedMode = a.mode;
        this._toast('速度 ×' + m + (a.mode && a.mode !== 'walk' ? '（' + a.mode + '）' : ''));
        after(a.seconds, () => { if (phys.speedMult === m) { phys.speedMult = 1; phys.speedMode = 'walk'; } });
        break;
      }
      case 'set_player_size': {
        const s = a.scale;
        phys.sizeTarget = s;
        this._toast('体型已变为 ' + s + ' 倍');
        after(a.seconds, () => { if (phys.sizeTarget === s) phys.sizeTarget = 1; });
        break;
      }
      case 'teleport_player':
      case 'set_player_position': {
        const x = a.x;
        const z = a.z;
        if (Number.isFinite(x)) state.x = THREE.MathUtils.clamp(x, -Config.GROUND_WIDTH / 2, Config.GROUND_WIDTH / 2);
        if (Number.isFinite(z)) state.z = THREE.MathUtils.clamp(z, -Config.GROUND_DEPTH / 2, Config.GROUND_DEPTH / 2);
        if (Number.isFinite(a.y)) state.y = a.y;
        else state.y = Config.PLAYER_HEIGHT * phys.sizeScale;
        this._toast('已移动');
        break;
      }
      case 'set_player_jump': {
        const m = a.multiplier;
        phys.jumpMult = m;
        if (a.max_jumps) phys.maxJumps = a.max_jumps;
        this._toast('起跳力度 ×' + m + (a.max_jumps ? '，最多连跳 ' + a.max_jumps + ' 次' : ''));
        after(a.seconds, () => {
          if (phys.jumpMult === m) phys.jumpMult = 1;
          if (a.max_jumps) phys.maxJumps = 1;
        });
        break;
      }
      case 'set_player_gravity': {
        const m = a.multiplier;
        phys.gravityMult = m;
        if (a.terminal_velocity) phys.terminalVelocity = a.terminal_velocity;
        this._toast('重力 ×' + m + (a.terminal_velocity ? '，终端速度 ' + a.terminal_velocity : ''));
        after(a.seconds, () => {
          if (phys.gravityMult === m) phys.gravityMult = 1;
          if (a.terminal_velocity) phys.terminalVelocity = null;
        });
        break;
      }
      case 'set_player_velocity': {
        // 有 seconds：这段时间内每帧强制该速度；无 seconds：只给一次瞬时冲量
        if (a.seconds && a.seconds > 0) {
          phys.velocityHold = { x: a.x, y: a.y, z: a.z, t: a.seconds };
        } else {
          if (Number.isFinite(a.x)) phys.velocity.x = a.x;
          if (Number.isFinite(a.y)) phys.velocity.y = a.y;
          if (Number.isFinite(a.z)) phys.velocity.z = a.z;
        }
        this._toast('已施加速度' + (a.seconds ? '（持续 ' + a.seconds + ' 秒）' : ''));
        break;
      }
      case 'set_player_friction': {
        const m = a.multiplier;
        phys.frictionMult = m;
        this._toast('地面摩擦 ×' + m);
        after(a.seconds, () => { if (phys.frictionMult === m) phys.frictionMult = 1; });
        break;
      }
      case 'set_player_acceleration': {
        const m = a.multiplier;
        phys.accelMult = m;
        this._toast('加速度 ×' + m);
        after(a.seconds, () => { if (phys.accelMult === m) phys.accelMult = 1; });
        break;
      }
      case 'grant_jetpack': {
        phys.jetpack = !!a.on;
        this._toast(phys.jetpack ? '喷气背包已开启，空中按住空格上升' : '喷气背包已关闭');
        after(a.seconds, () => { phys.jetpack = false; });
        break;
      }
      case 'set_player_health': {
        if (Number.isFinite(a.value)) {
          const target = Math.max(0, Math.min(Config.HEALTH_MAX, a.value));
          this.localState.health = target;
          this._updateHealthBar();
          if (target <= 0 && !this._dead) this._die();
        } else if (Number.isFinite(a.delta)) {
          this._changeHealth(a.delta);
        }
        this._toast('血量：' + Math.round(this.localState.health) + ' / ' + Config.HEALTH_MAX);
        break;
      }
      case 'hold_item': {
        // 手持物：默认就是手上举着一段文字（第三人称与他人可见）
        const text = a.text || '';
        this.localState.hold = text;
        this._toast(text ? '手持：' + text : '已放下手持物');
        break;
      }
      case 'spawn_projectile': {
        // 直接投掷：伤害/范围/范围效果由阿花指定，后端已钳制
        const dmg = Number(a.damage) || 0;
        const onHit = (a.onHit && typeof a.onHit === 'object') ? a.onHit : null;
        this._throwProjectile({
          damage: dmg,
          radius: Number(a.radius) || 2,
          speed: Number(a.speed) || Config.PROJECTILE_SPEED,
          color: dmg > 0 ? 0xff6a3c : 0x4cd97b,
          onHit,
        });
        this._toast((dmg > 0 ? '投掷物已出手（伤害 ' + dmg + '）' : '投掷物已出手')
          + (onHit ? '，并给予 ' + this._describeEffect(onHit) : ''));
        break;
      }
      case 'spawn_item': {
        // 阿花把物品放进玩家背包，并记住她给的效果（{k,v,s} 或 null）
        const item = a.item || '神秘物品';
        const effKey = a.effect || null;
        const key = getBagKey(this._profile);
        const n = addToBag(key, item, 1);
        this._storeItemEffect(item, effKey);
        this._toast('阿花把「' + item + '」放进背包 · 效果：' + this._describeEffect(effKey));
        this._equipItemSkill(item);
        break;
      }
      default:
        break;
    }
  }

  // 投掷物：沿视线方向抛出一个小球，飞行中受重力，撞地或撞到玩家后爆开结算范围效果
  // 取一个投掷物 mesh：优先复用池里的，池空才新建（几何/材质都是共享的，不新建资源）
  _obtainProjMesh(color) {
    const m = this._projPool.pop();
    if (m) {
      m.material = projMaterial(color);
      m.visible = true;
      m.rotation.set(0, 0, 0);
      this.scene.add(m);
      enableDynamicLighting(m); // 投掷物是动态物体，开第 1 层受太阳实时照（池复用一次即可，层级持久）
      return m;
    }
    const nm = new THREE.Mesh(PROJ_GEO, projMaterial(color));
    enableDynamicLighting(nm);
    this.scene.add(nm);
    return nm;
  }

  // 回收投掷物 mesh。**只把它移出场景并放进池**，共享的几何与材质一个都不动。
  _releaseProjMesh(mesh) {
    if (!mesh) return;
    this.scene.remove(mesh);
    mesh.visible = false;
    mesh.material = null; // 断掉对共享材质的引用，避免持有到被回收的那一份
    if (this._projPool.length < PROJ_POOL_MAX) this._projPool.push(mesh);
    // 超出池上限的 mesh 自然被 GC 掉：几何/材质是共享的，所以没有资源泄漏
  }

  _throwProjectile(spec) {
    const s = this.localState;
    const cosP = Math.cos(s.pitch);
    const sinP = Math.sin(s.pitch);
    const dir = new THREE.Vector3(-Math.sin(s.yaw) * cosP, sinP, -Math.cos(s.yaw) * cosP);
    const start = new THREE.Vector3(s.x, s.y, s.z).addScaledVector(dir, 0.8);
    const color = spec.color || 0xff6a3c;
    const mesh = this._obtainProjMesh(color);
    mesh.position.copy(start);
    const vel = dir.clone().multiplyScalar(spec.speed || Config.PROJECTILE_SPEED);
    const id = spec.visualOnly ? (spec.id || '') : String(this.localState.id || 'me') + '-' + (++this._projSeq);
    this._projectiles.push({
      mesh,
      vel,
      life: 4,
      damage: spec.damage || 0,
      radius: spec.radius || 2,
      onHit: spec.onHit || null,
      id,
      visualOnly: !!spec.visualOnly, // 别人扔的：只播画面，命中不结算（爆炸由对方的 boom 消息驱动）
      gravity: Number.isFinite(spec.gravity) ? spec.gravity : 1, // 重力系数（粉笔头近乎直线，取很小值）
      players: spec.players !== false, // 是否结算对玩家的伤害（Boss 战的基础攻击不误伤玩家）
    });
    // 把自己扔出去的这颗广播给其他人，让他们也能看到飞行轨迹（带重力系数，保证弧线一致）
    if (!spec.visualOnly) {
      this.network.sendProj({
        id,
        x: start.x, y: start.y, z: start.z,
        vx: vel.x, vy: vel.y, vz: vel.z,
        g: Number.isFinite(spec.gravity) ? spec.gravity : 1,
      });
    }
  }

  // 别人扔的投掷物：本地只复刻一颗会飞的小球，命中后静默移除（真正的爆炸由 boom 消息触发）
  _spawnRemoteProjectile(msg) {
    const x = Number(msg.x);
    const y = Number(msg.y);
    const z = Number(msg.z);
    if (![x, y, z].every(Number.isFinite)) return;
    const vel = new THREE.Vector3(Number(msg.vx) || 0, Number(msg.vy) || 0, Number(msg.vz) || 0);
    const mesh = this._obtainProjMesh(0xff6a3c);
    mesh.position.set(x, y, z);
    this._projectiles.push({
      mesh, vel, life: 4, damage: 0, radius: 0, onHit: null,
      id: String(msg.id || ''), visualOnly: true,
      gravity: Number.isFinite(Number(msg.g)) ? Number(msg.g) : 1,
      players: true,
    });
  }

  // 投掷物（球）与场景碰撞体的相交检测，交给 projectileHit 模块：
  // 盒按精确 OBB、trimesh 走 BVH + 真实三角形、convex 有索引三角形时也精确判定；
  // 并带「线段扫描」，避免高速掠过薄墙。prev 为上一帧位置。
  _projectileHitsWorld(x, y, z, r, fx, fy, fz) {
    return projectileHitsWorld(this.colliders, x, y, z, r, fx, fy, fz);
  }

  // 每帧推进所有投掷物：受重力、撞地/撞建筑/命中玩家即爆开
  _updateProjectiles(dt) {
    if (!this._projectiles.length) return;
    for (let i = this._projectiles.length - 1; i >= 0; i--) {
      const p = this._projectiles[i];
      const px0 = p.mesh.position.x;
      const py0 = p.mesh.position.y;
      const pz0 = p.mesh.position.z;
      p.vel.y += Config.GRAVITY * (p.gravity === undefined ? 1 : p.gravity) * dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      p.life -= dt;
      const pos = p.mesh.position;
      let hit = p.life <= 0 || pos.y <= 0.12;
      // 撞到场景碰撞体（建筑/墙）也爆开：走真实几何判定，不再用包围盒近似
      if (!hit && this._projectileHitsWorld(pos.x, pos.y, pos.z, 0.16, px0, py0, pz0)) hit = true;
      // 打中「老师」Boss：直接在她身上爆开（伤害在 _explode 里按距离结算）
      if (!hit && this.boss && this.boss.hitsAt(pos.x, pos.y, pos.z, 0.16)) hit = true;
      if (!hit) {
        // 竖直圆柱近似：水平 0.8 米内、高度区间内视为命中其他玩家
        for (const [id, rp] of this.playerManager.players) {
          if (id === this.localState.id) continue;
          const st = rp.state;
          const d = Math.hypot(pos.x - st.x, pos.z - st.z);
          if (d < 0.8 && Math.abs(pos.y - (st.y - Config.PLAYER_HEIGHT / 2)) < 1.2) { hit = true; break; }
        }
      }
      if (!hit) continue;
      // 别人扔的只静默移除（爆炸由对方的 boom 消息负责播特效，避免重复播两遍）
      if (!p.visualOnly) this._explode(p);
      this._releaseProjMesh(p.mesh); // 归池；共享几何/材质一个都不动
      this._projectiles.splice(i, 1);
    }
  }

  // 播放爆炸特效（本机扔的，以及别人广播过来的 boom，都走这里）
  _playExplosion(c, radius, damage) {
    const color = damage > 0 ? 0xff7a3c : 0x4cd97b;

    const group = new THREE.Group();
    group.position.copy(c);
    this.scene.add(group);

    // 中心闪光球（叠加混合，看起来更亮）
    const ballMat = new THREE.MeshBasicMaterial({
      color: 0xffd27a, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    applyFragmentPrecision(ballMat);
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(Math.max(0.45, radius * 0.45), 16, 12),
      ballMat
    );
    group.add(ball);

    // 贴地扩散光环
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(Math.max(0.25, radius * 0.55), radius, 40),
      new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.85,
        side: THREE.DoubleSide, depthWrite: false,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.05 - c.y; // 组内偏移，使世界坐标落在地面附近
    group.add(ring);

    // 飞散的碎块
    const shards = [];
    for (let i = 0; i < 14; i++) {
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(0.12, 0.12, 0.12),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false })
      );
      const a = (i / 14) * Math.PI * 2;
      const sp = 4 + Math.random() * 5;
      shards.push({ m, v: new THREE.Vector3(Math.cos(a) * sp, 2.5 + Math.random() * 3, Math.sin(a) * sp) });
      group.add(m);
    }

    this._fx.push({ group, ball, ring, shards, t: 0, life: 0.6 });
  }

  // 本机投掷物爆开：播特效 + 结算伤害/范围效果 + 把爆炸位置广播给其他人
  _explode(p) {
    const c = p.mesh.position.clone();
    const radius = p.radius;
    this._playExplosion(c, radius, p.damage);
    this.network.sendBoom({ id: p.id, x: c.x, y: c.y, z: c.z, radius, damage: p.damage });

    const dSelf = Math.hypot(this.localState.x - c.x, this.localState.z - c.z);
    const inSelf = dSelf <= radius;
    const hurtPlayers = p.players !== false; // Boss 战的基础攻击只打 Boss，不误伤玩家

    // 1) 伤害：半径内的自己直接扣血，远端玩家交给服务器转发
    if (p.damage && hurtPlayers && inSelf) this._changeHealth(-p.damage);
    if (p.damage && hurtPlayers) {
      for (const [id, rp] of this.playerManager.players) {
        if (id === this.localState.id) continue;
        const st = rp.state;
        if (Math.hypot(st.x - c.x, st.z - c.z) <= radius) this.network.sendHit(id, p.damage);
      }
    }

    // 1.5) Boss：爆心落在她身上就扣血（伤害增量由所有人各自扣一份）
    if (p.damage && this.boss && this.boss.hitsAt(c.x, c.y, c.z, radius)) {
      this.boss.hurtBy(p.damage);
      this._addSuperCharge(p.damage); // 打在她身上的伤害同时给超级激光充能
    }

    // 2) 范围效果：半径内的玩家获得 onHit 指定的增益（治疗/加速/跳高/飞行/体型）
    const onHit = p.onHit;
    if (onHit) {
      if (inSelf) {
        this._applyEffect(onHit);
        this._toast('受到范围效果：' + this._describeEffect(onHit));
      }
      for (const [id, rp] of this.playerManager.players) {
        if (id === this.localState.id) continue;
        const st = rp.state;
        if (Math.hypot(st.x - c.x, st.z - c.z) <= radius) this.network.sendFx(id, onHit);
      }
    }
  }

  // 把一个效果对象（{k,v,s}）作用到本地玩家身上：范围内增益、技能槽触发都走这里，保证口径一致
  _applyEffect(e) {
    if (!e || typeof e !== 'object') return;
    const phys = this.localPlayer.physics;
    const v = Number(e.v);
    const secs = Number(e.s) > 0 ? Number(e.s) : 5;
    switch (e.k) {
      case 'speed': {
        const m = (v > 0) ? v : 1.8;
        phys.speedMult = m;
        setTimeout(() => { if (phys.speedMult === m) phys.speedMult = 1; }, secs * 1000);
        break;
      }
      case 'jump': {
        const m = (v > 0) ? v : 1.6;
        phys.jumpMult = m;
        setTimeout(() => { if (phys.jumpMult === m) phys.jumpMult = 1; }, secs * 1000);
        break;
      }
      case 'jetpack':
        phys.jetpack = true;
        setTimeout(() => { phys.jetpack = false; }, secs * 1000);
        break;
      case 'size': {
        const s = (v > 0) ? v : 1.6;
        phys.sizeTarget = s;
        setTimeout(() => { if (phys.sizeTarget === s) phys.sizeTarget = 1; }, secs * 1000);
        break;
      }
      case 'heal': {
        const amount = (v > 0) ? v : 100;
        this._changeHealth(amount);
        break;
      }
      default:
        break;
    }
  }

  // 推进爆炸特效：闪光球胀大淡出、地环扩散、碎块抛体下落，0.6 秒后自动清理
  _updateFX(dt) {
    for (let i = this._fx.length - 1; i >= 0; i--) {
      const f = this._fx[i];
      f.t += dt;
      const k = f.t / f.life;
      if (k >= 1) {
        this.scene.remove(f.group);
        f.group.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
        this._fx.splice(i, 1);
        continue;
      }
      f.ball.scale.setScalar(1 + k * 1.6);
      f.ball.material.opacity = 0.85 * (1 - k) * (1 - k);
      f.ring.scale.setScalar(0.6 + k * 1.4);
      f.ring.material.opacity = 0.85 * (1 - k);
      for (const s of f.shards) {
        s.v.y -= 14 * dt;
        s.m.position.addScaledVector(s.v, dt);
        s.m.material.opacity = 0.9 * (1 - k);
      }
    }
  }

  // 物品效果存储键：与背包一样按账号隔离
  _itemEffectStoreKey() {
    const id = this._profile ? (this._profile.username || this._profile.nickname || '') : '';
    return 'fp_item_effect__' + (id || 'guest');
  }

  // 记住阿花给某件物品的效果（speed/jump/jetpack/size；null 视为装饰品）
  _storeItemEffect(item, effect) {
    if (!effect) return;
    try {
      const m = JSON.parse(localStorage.getItem(this._itemEffectStoreKey()) || '{}');
      m[item] = effect;
      localStorage.setItem(this._itemEffectStoreKey(), JSON.stringify(m));
    } catch (e) { /* 存储不可用：本次会话内技能槽仍能用 */ }
  }

  _loadItemEffect(item) {
    try {
      const m = JSON.parse(localStorage.getItem(this._itemEffectStoreKey()) || '{}');
      return m[item] || null;
    } catch (e) { return null; }
  }

  // 根据阿花写的效果对象 {k,v,s}（或旧的字符串兼容）生成 { label, run }。力度 v、时长 s 都由阿花定。
  _effectForItem(item) {
    const phys = this.localPlayer.physics;
    const raw = this._loadItemEffect(item);
    const eff = raw && typeof raw === 'object' ? raw : { k: String(raw || '') };
    const k = eff.k || '';
    const v = Number.isFinite(Number(eff.v)) ? Number(eff.v) : null;
    const secs = Number.isFinite(Number(eff.s)) && Number(eff.s) > 0 ? Number(eff.s) : 5;
    switch (k) {
      case 'speed': {
        const m = (v && v > 0) ? v : 1.8;
        return {
          label: '疾风',
          run: () => {
            phys.speedMult = m;
            this._toast('疾风：速度提升至 ' + m + ' 倍，持续 ' + secs + ' 秒');
            setTimeout(() => { if (phys.speedMult === m) phys.speedMult = 1; }, secs * 1000);
          },
        };
      }
      case 'jump': {
        const m = (v && v > 0) ? v : 1.6;
        return {
          label: '跃升',
          run: () => {
            phys.jumpMult = m;
            this._toast('跃升：起跳力度提升至 ' + m + ' 倍，持续 ' + secs + ' 秒');
            setTimeout(() => { if (phys.jumpMult === m) phys.jumpMult = 1; }, secs * 1000);
          },
        };
      }
      case 'jetpack':
        return {
          label: '喷气',
          run: () => {
            phys.jetpack = true;
            this._toast('喷气背包：空中按住空格上升，持续 ' + secs + ' 秒');
            setTimeout(() => { phys.jetpack = false; }, secs * 1000);
          },
        };
      case 'size': {
        const s = (v && v > 0) ? v : 1.6;
        return {
          label: '体型',
          run: () => {
            phys.sizeTarget = s; // 平滑过渡到目标体型
            this._toast('体型变化：变为 ' + s + ' 倍，持续 ' + secs + ' 秒');
            setTimeout(() => { if (phys.sizeTarget === s) phys.sizeTarget = 1; }, secs * 1000);
          },
        };
      }
      case 'club':
        return {
          label: '棍子',
          run: () => this._swingClub(),
        };
      case 'blackhole':
        return {
          label: '黑洞',
          run: () => this._throwBlackHole(),
        };
      case 'hide':
        return {
          label: '捉迷藏',
          run: () => this._useHideToy(),
        };
      case 'control':
        return {
          label: '控制',
          run: () => this._toggleCtrlGun(),
        };
      case 'grapple':
        return {
          label: '抓钩',
          // ⚠ 抓钩**不要**技能槽那 800ms 的防连点间隔（SkillSlots 的 COOLDOWN）：
          //   那道间隔对它是凭空的 0.8 秒冷却，手感上等于"抓一次要等一下"。
          //   抓钩自己的节奏由 GRAPPLE_COOLDOWN(=0) 与"再按一次=松手"控制。
          noCd: true,
          run: () => this._fireGrapple(),
        };
      case 'gatling':
        return {
          label: '加特林',
          run: () => this._toggleGatling(),
        };
      case 'hammer':
        return {
          label: '建造锤',
          run: () => { if (this._buildTool) this._buildTool.toggle(); },
        };
      case 'flashlight':
        return {
          label: '手电筒',
          // 开关型工具：不要技能槽的防连点间隔，否则刚关掉要等一下才能再开
          noCd: true,
          run: () => this._toggleFlashlight(),
        };
      case 'throw': {
        // 投掷物：v = 伤害，r = 爆炸半径（都由阿花指定，后端已钳制）；可选 onHit = 范围效果
        const dmg = (v && v > 0) ? v : 40;
        const rad = Number.isFinite(Number(eff.r)) && Number(eff.r) > 0 ? Number(eff.r) : 3;
        const onHit = (eff.onHit && typeof eff.onHit === 'object') ? eff.onHit : null;
        return {
          label: '投掷',
          run: () => {
            this._throwProjectile({ damage: dmg, radius: rad, color: 0xff6a3c, onHit });
            this._toast('投掷：' + rad + ' 米内造成 ' + dmg + ' 点伤害'
              + (onHit ? '，并给予 ' + this._describeEffect(onHit) : ''));
          },
        };
      }
      default:
        // 兜底：没拿到有效效果（旧背包物品 / 后端未放行）时给个温和加速，
        // 但标签与提示都写明「未识别」，避免把兜底误当成物品本身的真实效果。
        return {
          label: '未识别',
          run: () => {
            const m = 1.8;
            phys.speedMult = m;
            this._toast('「' + item + '」没有有效效果（旧物品或后端未放行），暂按加速兜底');
            setTimeout(() => { if (phys.speedMult === m) phys.speedMult = 1; }, 4000);
          },
        };
    }
  }

  // 把阿花写的效果对象翻译成中文短语，用于提示/排查（后端会把非法效果整块删掉 → null）
  _describeEffect(e) {
    if (e == null) return '无（装饰品 / 或后端未放行该效果）';
    if (typeof e !== 'object') return '格式错误（' + String(e) + '，应为对象）';
    const k = e.k || '';
    if (k === 'throw') return '投掷 伤害' + (e.v == null ? '?' : e.v) + ' 半径' + (e.r == null ? '?' : e.r);
    if (k === 'jetpack') return '飞行 ' + (e.s == null ? '?' : e.s) + ' 秒';
    if (k === 'heal') return '治疗 ' + (e.v == null ? '?' : e.v);
    const names = { speed: '加速', jump: '跳高', size: '体型' };
    if (names[k]) return names[k] + ' ×' + (e.v == null ? '?' : e.v) + ' 持续 ' + (e.s == null ? '?' : e.s) + ' 秒';
    return '未知类型(' + k + ')';
  }

  // 把阿花给的物品挂到技能槽：用阿花选定的效果。触发方式：点击槽位（手机）或按对应数字键（PC）。
  _equipItemSkill(item) {
    // 已装备则刷新该槽；否则找第一个空槽
    let idx = Object.keys(this._skillMap).find((k) => this._skillMap[k] === item);
    if (idx == null) {
      for (let i = 0; i < SLOT_COUNT; i++) { if (!(i in this._skillMap)) { idx = String(i); break; } }
    }
    if (idx == null) {
      this._toast('技能槽已满，请在背包里把「' + item + '」指定到某个槽位');
      return;
    }
    this._setSlot(Number(idx), item);
    this._toast('「' + item + '」已装备到 ' + (Number(idx) + 1) + ' 号技能槽（按 ' + (Number(idx) + 1) + ' 触发）');
  }

  // 把物品装备到指定槽位（0 起），并持久化
  _setSlot(index, item) {
    const eff = this._effectForItem(item);
    this.skillSlots.assign(index, { label: eff.label, onActivate: eff.run, noCd: eff.noCd === true });
    this._skillMap[index] = item;
    this._saveSkillSlots(this._skillMap);
  }

  // 清空指定槽位
  _clearSlot(index) {
    this.skillSlots.clearSlot(index);
    delete this._skillMap[index];
    this._saveSkillSlots(this._skillMap);
  }

  // 启动时把上次保存的槽位指定恢复出来
  _restoreSkills() {
    for (const key of Object.keys(this._skillMap)) {
      const idx = Number(key);
      const item = this._skillMap[key];
      if (idx >= 0 && idx < SLOT_COUNT && item) {
        const eff = this._effectForItem(item);
        // ⚠ noCd 必须一起转发：少了它，读档恢复出来的抓钩会被技能槽那 800ms 防连点间隔卡住
        //（表现：刚进游戏抓一次要等一下，重新装备一次又好了）。
        this.skillSlots.assign(idx, { label: eff.label, onActivate: eff.run, noCd: eff.noCd === true });
      } else {
        delete this._skillMap[key];
      }
    }
  }

  // 技能槽存储键：与背包一样按账号隔离
  _skillStoreKey() {
    const id = this._profile ? (this._profile.username || this._profile.nickname || '') : '';
    return 'fp_skill_slots__' + (id || 'guest');
  }
  _loadSkillSlots() {
    try { return JSON.parse(localStorage.getItem(this._skillStoreKey()) || '{}') || {}; }
    catch (e) { return {}; }
  }
  _saveSkillSlots(map) {
    try { localStorage.setItem(this._skillStoreKey(), JSON.stringify(map)); } catch (e) { /* 忽略 */ }
    markSaveDirty(); // 技能槽是账号存档的一部分 → 触发云同步
  }

  // 背包「使用」：指定槽位则先装备到该槽，再触发效果（与技能槽同源）。
  _useItem(item, slotIndex) {
    if (slotIndex != null && slotIndex >= 0) this._setSlot(slotIndex, item);
    const eff = this._effectForItem(item);
    eff.run();
  }

  // 物品图标 key：背包只存名字 → 反查目录项，再套用 itemIcons 的映射（不用 emoji）
  _itemIconKey(name) {
    return itemIconKeyFor(itemByName(name) || { name });
  }

  // 给物品挑一个图标色：按名字散列到一个固定色板，保证同名拿到同色。
  // 同上：这是「多色相区分」用途，不是状态色，刻意不走 --kui-* 语义变量。
  _itemColor(name) {
    const palette = ['#e74c3c', '#e67e22', '#f1c40f', '#27ae60', '#16a085', '#3498db', '#9b59b6', '#e84393', '#2c3e50'];
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return palette[h % palette.length];
  }

  // spawn_item：在玩家正前方生成一个发光可拾取道具，走过去触碰即可拾取。
  _spawnPickup(name, ttl) {
    const state = this.localState;
    const rad = 1.6;
    const px = state.x + -Math.sin(state.yaw) * rad;
    const pz = state.z + -Math.cos(state.yaw) * rad;
    const geo = new THREE.OctahedronGeometry(0.28);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffd24a, emissive: 0xffa726, emissiveIntensity: 1.4,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(px, 1.0, pz);
    mesh.castShadow = true;
    this.scene.add(mesh);

    const life = Math.max(5, Math.min(ttl || 60, 300));
    const p = { mesh, x: px, z: pz, ttl: life, buff: (Math.random() * 0.5 + 0.75) };
    this._pickups.push(p);
    mesh.userData.pickup = p;

    this._toast('阿花送了你一个：' + name + '，走过去碰到它就有小惊喜');
  }

  // ============ 网络连接状态 UI ============
  // 需求：拒绝「静默脱机」。连接掉线 → 顶部角标提示正在重连；重连成功 → 提示已恢复；
  // 重连 5 次全失败 → 判定网络错误，弹全屏面板 + 手动重试按钮。
  _onNetworkStatus(status, info) {
    const attempt = info && info.attempt ? info.attempt : 0;
    const max = info && info.max ? info.max : 5;

    if (status === 'open') {
      this._netBadgeHide();
      this._netErrorHide();
      // 只有「掉线过一次又恢复」才提示，开局首次连上不打扰用户
      if (this._netWasDown) {
        this._netWasDown = false;
        this._toast('已重新连接服务器');
      }
      return;
    }

    if (status === 'failed') {
      this._netBadgeHide();
      this._netWasDown = true;
      this._netErrorShow();
      return;
    }

    if (status === 'reconnecting') {
      this._netWasDown = true;
      this._netErrorHide();
      this._netBadgeShow('正在重连服务器… (' + attempt + '/' + max + ')');
      return;
    }

    // connecting：首次连接中，不打扰（加载阶段本来就有 loading）
    this._netBadgeHide();
  }

  _netBadgeShow(text) {
    let el = this._netBadge;
    if (!el) {
      el = document.createElement('div');
      // 顶部居中、toast 下方（toast 在 top:64px），不遮挡顶部按钮行与校卡
      el.style.cssText =
        'position:fixed;top:calc(env(safe-area-inset-top, 0px) + 104px);left:50%;' +
        'transform:translateX(-50%);z-index:9600;pointer-events:none;' +
        'background:rgba(255,183,77,.95);color:#2b1a05;' +
        'padding:6px 14px;border-radius:999px;font:600 13px/1.3 var(--kui-font);' +
        'box-shadow:0 4px 14px rgba(0,0,0,.35);white-space:nowrap;';
      document.body.appendChild(el);
      this._netBadge = el;
    }
    if (el.textContent !== text) el.textContent = text;
    el.style.display = '';
  }

  _netBadgeHide() {
    if (this._netBadge) this._netBadge.style.display = 'none';
  }

  _netErrorShow() {
    let el = this._netErrorEl;
    if (!el) {
      el = document.createElement('div');
      el.style.cssText =
        'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;' +
        'background:rgba(8,14,24,.72);backdrop-filter:blur(3px);';
      const card = document.createElement('div');
      card.style.cssText =
        'min-width:min(320px,84vw);max-width:84vw;box-sizing:border-box;text-align:center;' +
        'background:var(--kui-blue-deep,#123);color:var(--kui-paper,#eef);' +
        'padding:22px 20px;border-radius:14px;border:1px solid rgba(255,255,255,.14);' +
        'box-shadow:0 12px 40px rgba(0,0,0,.5);font:14px/1.5 var(--kui-font);';
      const title = document.createElement('div');
      title.textContent = '网络错误';
      title.style.cssText = 'font-size:19px;font-weight:700;margin-bottom:8px;color:#ff8a8a;';
      const desc = document.createElement('div');
      desc.textContent = '无法连接到服务器，已重试 5 次均失败。\n请检查网络后重试。';
      desc.style.cssText = 'opacity:.85;margin-bottom:16px;white-space:pre-line;';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = '重试连接';
      btn.style.cssText =
        'cursor:pointer;border:0;border-radius:10px;padding:10px 22px;' +
        'background:var(--kui-blue,#2b6cb0);color:#fff;font:600 14px var(--kui-font);' +
        'touch-action:manipulation;';
      btn.addEventListener('click', () => {
        this._netErrorHide();
        this._netBadgeShow('正在重连服务器… (1/5)');
        if (this.network) this.network.retryNow();
      });
      card.appendChild(title);
      card.appendChild(desc);
      card.appendChild(btn);
      el.appendChild(card);
      document.body.appendChild(el);
      this._netErrorEl = el;
    }
    el.style.display = 'flex';
  }

  _netErrorHide() {
    if (this._netErrorEl) this._netErrorEl.style.display = 'none';
  }

  // 顶部消息气泡提醒（不带 emoji）
  _toast(text) {
    let el = this._toastEl;
    if (!el) {
      el = document.createElement('div');
      el.className = 'npc-toast';
      // 只换配色与圆角/字体，动画与显隐时机保持原样
      el.style.cssText =
        'position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:9800;' +
        'background:var(--kui-blue-deep);color:var(--kui-paper);padding:8px 16px;border-radius:var(--kui-radius);' +
        'font:14px/1.4 var(--kui-font);box-shadow:0 6px 20px rgba(0,0,0,.3);pointer-events:none;' +
        'opacity:0;transition:opacity .25s;';
      document.body.appendChild(el);
      this._toastEl = el;
    }
    el.textContent = text;
    el.style.opacity = '1';
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 3200);
  }

  // 每帧推进拾取道具：旋转跳动、倒计时消失、靠近自动拾取并给个随机小 buff
  _updatePickups(dt) {
    if (!this._pickups.length) return;
    const state = this.localState;
    const phys = this.localPlayer.physics;
    const myX = state.x, myZ = state.z;

    for (let i = this._pickups.length - 1; i >= 0; i--) {
      const p = this._pickups[i];
      p.ttl -= dt;
      p.mesh.rotation.y += dt * 2.5;
      p.mesh.position.y = 1.0 + Math.abs(Math.sin(performance.now() / 350)) * 0.25;

      const d = Math.hypot(myX - p.x, myZ - p.z);
      if (d < 1.0) {
        // 拾取：随机加速一点点，算作「小惊喜」
        phys.speedMult = Math.min(phys.speedMult * (1 + p.buff * 0.15), 5);
        this._toast('你捡到了宝贝，速度 +' + Math.round(p.buff * 15) + '%');
        this.scene.remove(p.mesh);
        p.mesh.geometry.dispose();
        p.mesh.material.dispose();
        this._pickups.splice(i, 1);
      } else if (p.ttl <= 0) {
        this.scene.remove(p.mesh);
        p.mesh.geometry.dispose();
        p.mesh.material.dispose();
        this._pickups.splice(i, 1);
      }
    }
  }

  // 屏幕中央弹字（不是弹窗）：用于对战阵亡/胜利等强反馈，淡入后自动淡出
  _showFailText(text, color) {
    if (this._failEl) { this._failEl.remove(); this._failEl = null; }
    const el = document.createElement('div');
    const c = color || 'var(--kui-danger)';
    // 光晕跟着文字同色，避免「金字配红光晕」这种对不上的组合。
    // 传进来的可能是 var(--kui-gold-hi-2) 这类**变量引用**（不是字面色），
    // 那就没法在 JS 里算 rgba —— 改用 currentColor 交给 CSS：
    // text-shadow 里写 currentColor 会解析成 color 的计算值，正好等于文字色。
    const isLiteral = /^#[0-9a-fA-F]{6}$/.test(c);
    const glow = isLiteral
      ? 'rgba(' + parseInt(c.slice(1, 3), 16) + ',' + parseInt(c.slice(3, 5), 16) + ',' + parseInt(c.slice(5, 7), 16) + ',.75)'
      : 'currentColor';
    el.style.cssText =
      'position:fixed;left:50%;top:44%;transform:translate(-50%,-50%) scale(.7);' +
      'z-index:9600;pointer-events:none;white-space:nowrap;' +
      'font:900 76px/1 var(--kui-font, system-ui, sans-serif);letter-spacing:10px;' +
      'color:' + c + ';text-shadow:0 0 26px ' + glow + ',0 6px 22px rgba(0,0,0,.65);' +
      'opacity:0;transition:opacity .3s ease,transform .3s cubic-bezier(.2,1.4,.4,1);';
    el.textContent = text;
    document.body.appendChild(el);
    this._failEl = el;
    requestAnimationFrame(() => {
      el.style.opacity = '1';
      el.style.transform = 'translate(-50%,-50%) scale(1)';
    });
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translate(-50%,-50%) scale(1.2)';
      setTimeout(() => { if (this._failEl === el) { el.remove(); this._failEl = null; } }, 400);
    }, 1500);
  }

  // ============ P 键灵魂出窍：肉身留在原地，视角脱离身体自由飞行 ============
  _toggleSoul() {
    if (this._soul) {
      this._soul = null;
      this.input.consumeJump(); // 清掉出窍期间累积的跳跃请求，归位后不要莫名跳一下
      this._updateSkillBarVisibility();
      this._toast('灵魂归位');
      return;
    }
    // 起飞点/朝向 = 当前相机（第一人称下即头部位置与视线）
    this._soul = {
      x: this.camera.position.x,
      y: this.camera.position.y,
      z: this.camera.position.z,
      yaw: this.localState.yaw,
      pitch: this.localState.pitch,
    };
    this._updateSkillBarVisibility(); // 出窍时收起技能栏
    this._toast('灵魂出窍：WASD 飞行 / 空格上升 / Ctrl 下降 / Shift 加速 / P 归位');
  }

  // 灵魂自由飞行：本模式下 localPlayer.update 被跳过，鼠标增量与键位全归灵魂相机使用
  _updateSoul(dt) {
    const s = this._soul;
    if (!s) return;
    const { x, y } = this.input.takeMouseDelta();
    s.yaw -= x * Config.MOUSE_SENSITIVITY;
    s.pitch -= y * Config.MOUSE_SENSITIVITY;
    const lim = THREE.MathUtils.degToRad(Config.MAX_PITCH_DEG);
    s.pitch = THREE.MathUtils.clamp(s.pitch, -lim, lim);

    const cosP = Math.cos(s.pitch);
    const sinP = Math.sin(s.pitch);
    const fwd = new THREE.Vector3(-Math.sin(s.yaw) * cosP, sinP, -Math.cos(s.yaw) * cosP);
    const right = new THREE.Vector3(Math.cos(s.yaw), 0, -Math.sin(s.yaw));
    const move = new THREE.Vector3();
    if (this.input.forwarded()) move.add(fwd);
    if (this.input.backwarded()) move.sub(fwd);
    if (this.input.strafeRight()) move.add(right);
    if (this.input.strafeLeft()) move.sub(right);
    if (this.input.isDown('Space')) move.y += 1;
    if (this.input.isDown('ControlLeft') || this.input.isDown('ControlRight')) move.y -= 1;
    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar(Config.SOUL_SPEED * (this.input.sprinting() ? 3 : 1) * dt);
      s.x += move.x; s.y += move.y; s.z += move.z;
    }
    if (s.y < 0.2) s.y = 0.2; // 别钻到地面以下

    this.camera.position.set(s.x, s.y, s.z);
    this.camera.rotation.set(s.pitch, s.yaw, 0);
  }

  // 灵魂出窍时把本地「肉身」显示在被冻结的位置（让玩家看到自己的身体留在原地）
  _updateSoulBody() {
    const local = this.playerManager.getLocalPlayer();
    if (!local) return;
    this.playerManager.setLocalVisible(!this._morphs.has(this.localState.id));
    const s = this.localState;
    const size = this.localPlayer.physics.sizeScale;
    local.model.position.set(s.x, s.y - Config.PLAYER_HEIGHT * size, s.z);
    local.model.rotation.set(0, s.yaw, 0);
    setModelScale(local.model, size);
    setHeldItem(local.model, s.wep || '', s.hold || '');
  }

  // 第三人称：本地模型跟随自身位置朝向并播放行走动画，相机位于玩家后上方看向角色
  _thirdPerson(dt) {
    const local = this.playerManager.getLocalPlayer();
    if (!local) return;

    // 本地玩家不走网络插值（物理直接写 this.localState），模型须从这里取位置/朝向，
    // 否则会一直停在出生点，切第三人称也看不到自己。
    const s = this.localState;
    const size = this.localPlayer.physics.sizeScale;
    local.model.position.set(s.x, s.y - Config.PLAYER_HEIGHT * size, s.z);
    setModelScale(local.model, size);
    setHeldItem(local.model, s.wep || '', s.hold || '');

    local.model.rotation.set(0, s.yaw, 0); // 模型朝向 = 车头（自由视角只转相机，不转车）
    // 行走动画由主循环里的 tickPlayerModels(dt) 统一驱动（按帧间位移算速度），这里不再单独 update

    // 相机：眼睛后上方、朝向玩家头部附近（经典第三人称跟随）
    // 俯仰（pitch）必须参与：否则鼠标上下拖动在第三人称下毫无反应。
    // 做法：把 pitch 合进「视线方向」，相机沿视线反方向后退，再按视线方向瞄准。
    const eye = new THREE.Vector3(this.localState.x, this.localState.y, this.localState.z);
    // 骑车时用 viewYaw（车头 + 自由视角偏移）：第三人称也要能左右看看
    const yaw = this.localPlayer.viewYaw;
    const cosP = Math.cos(this.localState.pitch);
    const sinP = Math.sin(this.localState.pitch);
    // 含俯仰的视线单位方向（与第一人称一致：yaw 水平转向 + pitch 俯仰）
    const viewDir = new THREE.Vector3(-Math.sin(yaw) * cosP, sinP, -Math.cos(yaw) * cosP);
    const DIST = this.localState.ride ? Config.RIDE_CAM_DIST : 4.0;
    const LIFT = this.localState.ride ? Config.RIDE_CAM_LIFT : 1.0; // 骑车时相机更近更低，能看见车把
    const camPos = eye.clone().addScaledVector(viewDir, -DIST).add(new THREE.Vector3(0, LIFT, 0));
    if (camPos.y < 0.4) camPos.y = 0.4; // 抬头时相机可能钻到地面以下，夹住下限
    this.camera.position.copy(camPos);
    // 直接用与第一人称相同的欧拉角（pitch, yaw）来定朝向，俯仰一定跟着鼠标走，
    // 不依赖 lookAt 的推算，避免「第三人称锁俯仰」。
    this.camera.rotation.set(this.localState.pitch, yaw, 0);
  }

  // 主循环：计算 dt -> 更新玩家 -> 渲染
  // ============ 对战模式：匹配 + 独立竞技场「躲避陨石混战」 ============

  // 顶部「对战」按钮：未对战时选入口；对战中则退出
  _toggleCombat() {
    const c = this._combat;
    if (!c) {
      this._showModePicker(); // 先选「训练场 / 玩家匹配」，再选玩法
      return;
    }
    // 训练场里主动退出：先把成绩面板拿出来（直接退掉的话这一局就白练了）
    if (c.solo && !this._roundOver) {
      this._endRound(this._scoreRows());
      return;
    }
    this._leaveCombatNow('已退出，返回主世界');
  }

  // 就地退出对战：发退房（本机兜底的训练场没有房间，不能发）+ 本地立即清理 + 解开移动锁
  _leaveCombatNow(toast) {
    const local = !!(this._combat && this._combat.local);
    if (!local && this.network) this.network.sendLeaveRoom();
    this._exitCombat(this._lobbySpawn); // 本地即时退出；服务端 match_left 到达后为幂等空操作
    this._setChatLock(false);
    if (toast) this._toast(toast);
  }

  // 玩法选择（全屏）：顶部主推「校园狂飙」大卡；下面「更多玩法」放两个老玩法的小卡，
  // 每张小卡各带「训练场 / 玩家匹配」（这两件事成本完全不同：一个秒进、一个要等人）。
  _showModePicker() {
    if (!this._modePicker) {
      const el = document.createElement('div');
      el.style.cssText =
        'position:fixed;inset:0;z-index:9600;display:none;flex-direction:column;overflow:auto;' +
        'background:rgba(8,14,24,.82);font-family:var(--kui-font);color:var(--kui-paper);';
      const wrap = document.createElement('div');
      wrap.style.cssText =
        'flex:1 1 auto;width:100%;max-width:940px;margin:0 auto;box-sizing:border-box;' +
        'padding:calc(env(safe-area-inset-top, 0px) + 20px) 18px 30px;';

      const head = document.createElement('div');
      head.style.cssText = 'display:flex;align-items:baseline;justify-content:space-between;margin-bottom:14px;';
      const title = document.createElement('div');
      title.className = 'kui-title';
      title.style.cssText = 'font-size:20px;';
      title.textContent = '选择玩法';
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'kui-btn kui-btn--grey';
      back.style.cssText = 'font:inherit;padding:5px 14px;';
      back.textContent = '返回';
      back.addEventListener('click', () => { el.style.display = 'none'; });
      head.appendChild(title);
      head.appendChild(back);
      wrap.appendChild(head);

      // ---- 主推大卡：校园狂飙（赛道来自编辑器「赛道」模式，见 world/Track.js）----
      const hero = document.createElement('div');
      hero.className = 'kui-panel';
      // ⚠ 别用 border 做「主推」高亮：.kui-panel 的底色来自 border-image 的 fill，
      //   写 border 会连 border-image 一起顶掉 → 整张卡片变透明（踩过）。
      //   要描边就加在 box-shadow 上（不占边框）。
      hero.style.cssText = 'padding:18px 20px;text-align:left;'
        + 'box-shadow:0 0 0 3px color-mix(in srgb, var(--kui-blue) 78%, transparent);';
      const heroTop = document.createElement('div');
      heroTop.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';
      const heroName = document.createElement('div');
      heroName.style.cssText = 'font-weight:700;font-size:19px;';
      heroName.textContent = COMBAT_MODES.circuit.name;
      const heroTag = document.createElement('div');
      heroTag.style.cssText = 'font-size:11px;padding:2px 9px;border-radius:999px;'
        + 'background:color-mix(in srgb, var(--kui-blue) 45%, transparent);';
      heroTag.textContent = '主推玩法';
      heroTop.appendChild(heroName);
      heroTop.appendChild(heroTag);
      hero.appendChild(heroTop);
      const heroDesc = document.createElement('div');
      heroDesc.style.cssText = 'font-size:12.5px;line-height:1.65;color:var(--kui-ink-soft);margin:7px 0 10px;';
      heroDesc.textContent = COMBAT_MODES.circuit.tip + '。赛道在「编辑器 → 赛道」里画，也可以用编辑器自制地图。';
      hero.appendChild(heroDesc);
      const heroState = document.createElement('div');
      heroState.style.cssText = 'font-size:12px;margin-bottom:12px;';
      hero.appendChild(heroState);
      const heroGo = document.createElement('button');
      heroGo.type = 'button';
      heroGo.className = 'kui-btn kui-btn--primary';
      heroGo.style.cssText = 'font:inherit;padding:9px 22px;';
      heroGo.textContent = '开始狂飙';
      heroGo.addEventListener('click', () => { el.style.display = 'none'; this._startRace(); });
      hero.appendChild(heroGo);
      wrap.appendChild(hero);

      // ---- 更多玩法（次要）----
      const moreTitle = document.createElement('div');
      moreTitle.style.cssText = 'font-size:13px;margin:18px 0 9px;';
      moreTitle.textContent = '更多玩法';
      wrap.appendChild(moreTitle);

      const grid = document.createElement('div');
      grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;';
      const mkCard = (mode) => {
        const c = document.createElement('div');
        c.className = 'kui-panel';
        c.style.cssText = 'padding:14px 16px;text-align:left;';
        const n = document.createElement('div');
        n.style.cssText = 'font-weight:700;font-size:15px;';
        n.textContent = COMBAT_MODES[mode].name;
        const d = document.createElement('div');
        d.style.cssText = 'font-size:12px;line-height:1.6;color:var(--kui-ink-soft);margin:5px 0 10px;';
        d.textContent = COMBAT_MODES[mode].tip;
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';
        const bTrain = document.createElement('button');
        bTrain.type = 'button';
        bTrain.className = 'kui-btn kui-btn--grey';
        bTrain.style.cssText = 'font:inherit;padding:6px 14px;';
        bTrain.textContent = '训练场';
        bTrain.addEventListener('click', () => { el.style.display = 'none'; this._startTraining(mode); });
        const bMatch = document.createElement('button');
        bMatch.type = 'button';
        bMatch.className = 'kui-btn kui-btn--primary';
        bMatch.style.cssText = 'font:inherit;padding:6px 14px;';
        bMatch.textContent = '玩家匹配';
        bMatch.addEventListener('click', () => { el.style.display = 'none'; this._startMatch(mode); });
        row.appendChild(bTrain);
        row.appendChild(bMatch);
        c.appendChild(n);
        c.appendChild(d);
        c.appendChild(row);
        return c;
      };
      grid.appendChild(mkCard('meteor'));
      grid.appendChild(mkCard('grapple'));
      wrap.appendChild(grid);

      el.appendChild(wrap);
      document.body.appendChild(el);
      this._modePicker = el;
      this._raceHeroState = heroState; // 每次打开时刷新「赛道状态」那行文案
    }
    // 赛道状态：门数 / 圈数 / 个人最好成绩；没赛道就明确让他去编辑器画
    if (this._raceHeroState) {
      const t = this.track;
      const n = (t && Array.isArray(t.checkpoints)) ? t.checkpoints.length : 0;
      const best = this._raceBest();
      this._raceHeroState.textContent = isTrackRunnable(t)
        ? ('当前赛道：' + n + ' 个门 · ' + t.laps + ' 圈' + (best ? ' · 你的最好成绩 ' + (best / 1000).toFixed(2) + ' 秒' : ''))
        : '还没有赛道 —— 先去「编辑器 → 赛道」画一条（至少 2 个门）';
    }
    this._modePicker.style.display = 'flex';
  }

  // ---------- 校园狂飙（赛道竞速）----------
  // 不开竞技场：直接在校园大世界里跑编辑器画的那条赛道（数据/判定都在 world/Track.js）。
  // 车只是视觉 —— 骑乘语义仍是「ride=1 + 速度倍率」，车体由 _updateVehicle 按司机各自渲染，
  // 所以「每人一辆」不需要改网络协议（ride / veh 本来就在广播里）。
  _raceBestKey() {
    const id = this._profile ? (this._profile.username || this._profile.nickname || '') : '';
    const t = this.track;
    const gates = (t && Array.isArray(t.checkpoints)) ? t.checkpoints.length : 0;
    return 'fp_race_best__' + (id || 'guest') + '__' + gates + 'x' + (t ? t.laps : 0);
  }
  _raceBest() {
    try {
      const v = Number(localStorage.getItem(this._raceBestKey()));
      return Number.isFinite(v) && v > 0 ? v : 0;
    } catch (e) { return 0; }
  }
  _raceSaveBest(ms) {
    try { localStorage.setItem(this._raceBestKey(), String(Math.round(ms))); } catch (e) { /* 忽略 */ }
  }

  _startRace() {
    if (this._combat) { this._toast('对战中开不了狂飙'); return; }
    const t = this.track;
    if (!isTrackRunnable(t)) { this._toast('还没有赛道：先去「编辑器 → 赛道」画一条（至少 2 个门）'); return; }
    const sp = startPose(t);
    if (!sp) return;
    const st = this.localState;
    st.x = sp.x;
    st.z = sp.z;
    st.y = this._feetToTop(sp.y); // 立体赛道：起点在 0 号门那么高，别把车手丢在门下方的半空
    st.yaw = sp.yaw;
    st.pitch = 0;
    this.localPlayer.physics.velocity.set(0, 0, 0);
    if (!st.ride) this._mountVehicle(1); // 比赛用车：直接给一辆，不用先去停车点找
    this._race = {
      active: true,
      startedAt: performance.now(),
      next: 0,   // 下一个该穿的门（0 起）
      lap: 0,    // 已完成的圈数
      laps: t.laps,
      count: t.checkpoints.length,
    };
    this._raceHudShow(true);
    this._raceHudTick(true);
    this._setTrackVisible(true); // 开赛才把赛道（路面 + 门框）露出来
    this._toast('出发！按顺序穿过 1 → ' + t.checkpoints.length + ' 号门，跑满 ' + t.laps + ' 圈');
  }

  _exitRace(toastText) {
    if (!this._race) return;
    this._race = null;
    this._raceHudShow(false);
    this._setTrackVisible(false); // 一结束就把赛道收回（含中途弃赛、被拉进对战）
    if (toastText) this._toast(toastText);
  }

  _finishRace() {
    const r = this._race;
    if (!r) return;
    const ms = performance.now() - r.startedAt;
    this._race = null;
    this._raceHudShow(false);
    this._setTrackVisible(false);
    const prev = this._raceBest();
    const isNew = !prev || ms < prev;
    if (isNew) this._raceSaveBest(ms);
    if (this.localState.ride) this._dismountVehicle();
    this._toast('完赛！用时 ' + (ms / 1000).toFixed(2) + ' 秒'
      + (isNew ? ' · 新纪录' : '（你的最好成绩 ' + (prev / 1000).toFixed(2) + ' 秒）'));
  }

  // 每帧推进：只判「是否穿过了下一个该穿的门」。判定在 Track.inGate 里（水平在门宽内 + 高度差 ≤ 门高）。
  _updateRace() {
    const r = this._race;
    if (!r) return;
    if (this._combat || this._dead || this._soul) { this._exitRace(null); return; }
    // 弃车即弃赛：比赛用车是发给你跑圈的，下车（或任何把 ride 清掉的路径）就结束计时。
    // 主路径已在 _dismountVehicle 里退出，这里是兜底 —— 防别处直接把 ride 置 0 而绕过它。
    if (!this.localState.ride) { this._exitRace('已下车，狂飙结束'); return; }
    const cps = this.track.checkpoints;
    if (!cps.length) { this._exitRace('赛道没了，狂飙结束'); return; }
    const st = this.localState;
    const i = r.next;
    if (inGate(cps[i], st.x, st.y, st.z, Config.PLAYER_RADIUS)) {
      r.next = nextGateIndex(i, cps.length);
      if (r.next === 0) { // 刚穿过最后一个门 → 完成一圈
        r.lap += 1;
        if (r.lap >= r.laps) { this._finishRace(); return; }
        this._toast('第 ' + r.lap + ' 圈完成');
      }
    }
    this._raceHudTick();
  }

  // 赛道 HUD：圈数 / 下一门 / 计时。只在文字真的变了才写 DOM（每帧读比每帧写便宜）
  _raceHudTick(force) {
    const r = this._race;
    const el = this._raceHud;
    if (!el || !r) return;
    const txt = '圈 ' + Math.min(r.lap + 1, r.laps) + '/' + r.laps
      + ' · 门 ' + (r.next + 1) + '/' + r.count
      + ' · ' + ((performance.now() - r.startedAt) / 1000).toFixed(1) + ' 秒';
    if (!force && txt === this._raceHudLast) return;
    this._raceHudLast = txt;
    el.textContent = txt;
  }

  _raceHudShow(on) {
    if (!this._raceHud) {
      const el = document.createElement('div');
      el.style.cssText =
        'position:fixed;left:50%;transform:translateX(-50%);top:calc(env(safe-area-inset-top, 0px) + 94px);' +
        'z-index:9400;display:none;background:color-mix(in srgb, var(--kui-ink) 80%, transparent);' +
        'color:var(--kui-paper);padding:6px 14px;border-radius:999px;font:13px/1.3 var(--kui-font);' +
        'box-shadow:var(--kui-shadow);pointer-events:none;white-space:nowrap;';
      document.body.appendChild(el);
      this._raceHud = el;
    }
    this._raceHud.style.display = on ? 'block' : 'none';
    if (!on) this._raceHudLast = '';
  }

  // ---------- 车速表（骑电动车时才显示）----------
  // 造型：270° 圆弧表盘 + 指针 + 数字读数 + 单位。纯内联 SVG（不额外发请求），配色走主题 CSS 变量。
  // ⚠ 只改「几何」用 setAttribute；颜色一律用 el.style（CSS 属性）——
  //   演示属性里写 var() 在各浏览器上不完全可靠，写进 style 才能吃到主题变量。
  _ensureSpeedHud() {
    if (this._spdHud) return this._spdHud;
    const NS = 'http://www.w3.org/2000/svg';
    const coarse = !!this._coarsePointer;
    const box = document.createElement('div');
    box.className = 'spd-box';
    // 位置：右下角；手机端抬高到驾驶键组（左转/右转）之上，否则会压住它们
    // （刹车已挪去顶替技能槽，不在这个角落）
    box.style.cssText =
      'position:fixed;z-index:9400;display:none;pointer-events:none;user-select:none;-webkit-user-select:none;' +
      (coarse
        ? 'right:calc(env(safe-area-inset-right, 0px) + 20px);bottom:calc(env(safe-area-inset-bottom, 0px) + 108px);'
        : 'right:22px;bottom:22px;') +
      'width:clamp(84px,20vmin,116px);color:var(--kui-paper);font-family:var(--kui-font);' +
      'text-shadow:0 1px 3px rgba(0,0,0,.55);' +
      'background:radial-gradient(circle at 50% 54%, rgba(11,21,34,.62) 0 50%, rgba(11,21,34,0) 72%);';

    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;';

    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 120 104');
    svg.style.cssText = 'display:block;width:100%;height:auto;';
    // 圆心 (60,56)、半径 46，从 135° 顺时针扫 270° 到 45°（SVG 里 y 向下，正角度 = 顺时针）
    const ARC = 'M27.473 88.527 A46 46 0 1 1 92.527 88.527';
    const ARC_LEN = 216.77; // 2π·46·(270/360)
    const mk = (name, attrs) => {
      const n = document.createElementNS(NS, name);
      for (const k in attrs) n.setAttribute(k, attrs[k]);
      return n;
    };
    const bg = mk('path', { d: ARC, fill: 'none', 'stroke-width': '9', 'stroke-linecap': 'round' });
    bg.style.stroke = 'rgba(255,255,255,.18)';
    const val = mk('path', { d: ARC, fill: 'none', 'stroke-width': '9', 'stroke-linecap': 'round' });
    val.style.stroke = 'var(--kui-blue)';
    val.setAttribute('stroke-dasharray', String(ARC_LEN));
    val.setAttribute('stroke-dashoffset', String(ARC_LEN)); // 起始为空
    const needle = mk('line', { x1: '60', y1: '56', x2: '60', y2: '24', 'stroke-width': '3', 'stroke-linecap': 'round' });
    needle.style.stroke = 'var(--kui-paper)';
    needle.setAttribute('transform', 'rotate(-135 60 56)');
    const hub = mk('circle', { cx: '60', cy: '56', r: '5' });
    hub.style.fill = 'var(--kui-paper)';
    svg.appendChild(bg); svg.appendChild(val); svg.appendChild(needle); svg.appendChild(hub);

    const num = document.createElement('div');
    num.style.cssText =
      'position:absolute;left:50%;top:57%;transform:translate(-50%,-50%);' +
      'font:700 clamp(16px,4.4vmin,22px)/1 var(--kui-font-num);font-variant-numeric:tabular-nums;';
    num.textContent = '0';
    const unit = document.createElement('div');
    unit.style.cssText =
      'position:absolute;left:50%;top:76%;transform:translateX(-50%);' +
      'font:600 clamp(8px,2.2vmin,10px)/1 var(--kui-font);opacity:.72;letter-spacing:.5px;white-space:nowrap;';
    unit.textContent = 'km/h';

    wrap.appendChild(svg);
    wrap.appendChild(num);
    wrap.appendChild(unit);
    box.appendChild(wrap);
    document.body.appendChild(box);

    this._spdHud = box;
    this._spdNum = num;
    this._spdUnit = unit;
    this._spdVal = val;
    this._spdNeedle = needle;
    this._spdArcLen = ARC_LEN;
    return box;
  }

  _speedHudShow(on) {
    if (!on && !this._spdHud) return; // 从没骑过车 → 连元素都不建
    const el = this._ensureSpeedHud();
    const disp = on ? 'block' : 'none';
    if (el.style.display !== disp) el.style.display = disp; // 只在翻转时写 DOM
    if (!on) { this._spdLast = -1; this._spdRev = false; }
  }

  // sp = LocalPlayer._vehSpeed（米/秒，倒车为负）。只在读数（整数 km/h）或倒车态变化时才写 DOM。
  _speedHudTick(sp) {
    if (!this._spdHud) return;
    const spd = sp || 0;
    const kmh = Math.abs(spd) * 3.6;
    const t = Math.max(0, Math.min(1, kmh / this._spdMax));
    const shown = Math.round(kmh);
    const rev = spd < -0.3;
    if (shown === this._spdLast && rev === this._spdRev) return;
    this._spdLast = shown;
    this._spdRev = rev;
    this._spdNum.textContent = String(shown);
    this._spdUnit.textContent = rev ? '倒车' : 'km/h';
    this._spdVal.setAttribute('stroke-dashoffset', String(this._spdArcLen * (1 - t)));
    this._spdNeedle.setAttribute('transform', 'rotate(' + (-135 + 270 * t).toFixed(1) + ' 60 56)');
    // 表盘分档配色：常态蓝 → 60% 起金 → 85% 起红（倒车统一金）
    this._spdVal.style.stroke =
      rev ? 'var(--kui-gold)' : (t >= 0.85 ? 'var(--kui-danger)' : (t >= 0.6 ? 'var(--kui-gold)' : 'var(--kui-blue)'));
  }

  // 真正发起匹配（玩家匹配组）
  _startMatch(mode) {
    this._matchMode = mode;
    if (this.network) this.network.sendMatch(mode);
    this._showMatchOverlay('匹配中…', '正在为你寻找「' + COMBAT_MODES[mode].name + '」对手', true);
    this._toast('正在匹配「' + COMBAT_MODES[mode].name + '」…');
  }

  // 训练场：请求服务端立刻开一个单人房（不排队、不等 12 秒）。
  // 走服务端开房而不是直接本机离线开，是因为只有进了房，快照才会按房间隔离——
  // 否则训练场里的坐标会广播进大厅（大厅的人看到你在竞技场里飘，反之亦然）。
  _startTraining(mode) {
    this._matchMode = mode;
    this._trainPending = mode;
    this._trainTimer = 2.5; // 服务端没响应（例如还是旧版）就本机兜底，别让人干等
    if (this.network) this.network.sendTrain(mode);
    this._showMatchOverlay('训练场', '正在进入「' + COMBAT_MODES[mode].name + '」训练场…', false);
  }

  // 服务端不支持训练场（旧版）时的本机兜底：本机离线开，同时隐藏大厅玩家、暂停自身上报
  _startTrainingLocal(mode) {
    this._trainPending = null;
    this._trainLocal = true;
    if (this.network) this.network.setStateMuted(true); // 别把自己的竞技场坐标报进大厅
    this.playerManager.pruneTo([]);                     // 清掉大厅玩家模型（保留自己）
    const sp = spawnForMode(mode, 0, 1);
    if (this._combatOverlay) this._combatOverlay.style.display = 'none';
    this._enterCombat(mode, sp, true, new Map(), { local: true });
    this._toast('服务端未支持训练场，已按本机单人模式开始');
  }

  // 「匹配中… / 正在进入训练场…」浮层。cancelable=false 时不放取消按钮（训练场是秒开的，没有必要）
  _showMatchOverlay(title, tip, cancelable) {
    if (!this._combatOverlay) {
      const el = document.createElement('div');
      el.style.cssText =
        'position:fixed;inset:0;z-index:9600;display:flex;align-items:center;justify-content:center;' +
        'background:rgba(8,14,24,.55);font-family:var(--kui-font);color:var(--kui-paper);';
      el.innerHTML =
        '<div class="kui-panel" style="min-width:280px;padding:26px 28px;text-align:center;">' +
        '<div class="kui-title" id="__matchTitle" style="font-size:18px;margin-bottom:10px;">匹配中…</div>' +
        '<div id="__matchTip" style="color:var(--kui-ink-soft);margin-bottom:18px;font-size:13px;">正在为你寻找对手</div>' +
        '<button type="button" id="__cancelMatch" class="kui-btn kui-btn--grey" style="width:100%;">取消匹配</button></div>';
      document.body.appendChild(el);
      const btn = el.querySelector('#__cancelMatch');
      if (btn) btn.addEventListener('click', () => {
        if (this.network) this.network.sendCancelMatch();
        this._trainPending = null;
        el.style.display = 'none';
      });
      this._combatOverlay = el;
    }
    const t = this._combatOverlay.querySelector('#__matchTitle');
    const p = this._combatOverlay.querySelector('#__matchTip');
    const c = this._combatOverlay.querySelector('#__cancelMatch');
    if (t) t.textContent = title || '匹配中…';
    if (p) p.textContent = tip || '';
    if (c) c.style.display = cancelable ? '' : 'none';
    this._combatOverlay.style.display = 'flex';
  }

  // 对战状态条：入口类型 + 存活人数 + 名次 + 金币 + 计时 + 退出按钮
  _showCombatHUD() {
    if (!this._combatHud) {
      const el = document.createElement('div');
      el.style.cssText =
        'position:fixed;top:56px;right:14px;z-index:9400;' +
        'display:flex;gap:12px;align-items:center;' +
        'font:13px/1.4 var(--kui-font);color:var(--kui-paper);' +
        'background:rgba(11,21,34,.72);border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:7px 12px;';
      el.innerHTML =
        '<span id="__cMode" style="font-weight:700;color:var(--kui-gold-hi-2);">对战</span>' +
        '<span id="__cAlive">存活 -</span>' +
        '<span id="__cRank" style="display:none;">名次 -</span>' +
        '<span id="__cCoin" style="display:none;color:var(--kui-gold-hi-2);">金币 0</span>' +
        '<span id="__cTime">时间 00:00</span>' +
        '<button type="button" id="__cLeave" class="kui-btn kui-btn--grey" style="padding:3px 10px;">退出</button>';
      document.body.appendChild(el);
      const leaveBtn = el.querySelector('#__cLeave');
      if (leaveBtn) leaveBtn.addEventListener('click', () => this._toggleCombat());
      this._combatHud = el;
    }
    this._combatHud.style.display = 'flex';
    this._hudKey = null; // 重新显示时强制刷一次文字（去重键作废）
  }

  _hideCombatHUD() {
    if (this._combatHud) this._combatHud.style.display = 'none';
  }

  // 技能栏显隐：对战（竞技场）、灵魂出窍、建造模式、骑乘/赛车下都不显示
  // —— 这些场景里技能栏无意义或已被别的操控顶替
  _updateSkillBarVisibility() {
    if (!this.skillSlots || typeof this.skillSlots.setVisible !== 'function') return;
    this.skillSlots.setVisible(!this._combat && !this._soul && !this._isBuildActive() && !this.localState.ride);
    // 显隐翻转后位置可能要变（攻击键显示/隐藏会改变技能键的挂靠对象）
    this._relayoutSkillBtn();
  }

  // 是否处于建造模式（锤子触发）
  _isBuildActive() {
    return !!(this._buildTool && typeof this._buildTool.isActive === 'function' && this._buildTool.isActive());
  }

  _updateCombatHUD(res) {
    if (!this._combat || !this._combatHud) return;
    const c = this._combat;
    const now = performance.now();
    const alive = this._aliveCount();
    const total = Math.max(this._matchTotal, alive);
    // 名次要用一遍 judge（纯函数、≤8 人，很便宜）；调用方已经算过就直接复用
    const score = res || this._lastJudge || this._scoreRows();
    let rankTxt = '';
    if (!c.solo) {
      const mine = score.rows.find((x) => x.id === String(this.localState.id));
      rankTxt = '名次 ' + (mine ? mine.rank : '-') + '/' + score.rows.length;
    }
    const timeTxt = modeRule(c.mode).timed
      ? '剩余 ' + formatClock(Math.max(0, c.roundSeconds * 1000 - (now - c.roundStart)))
      : '时间 ' + formatClock(now - c.roundStart);
    const coinTxt = c.mode === 'grapple' ? '金币 ' + this._coinCount : '';
    // 只在文字真的变了才写 DOM：这个方法每帧都会被调用，无条件写会一直触发布局
    const key = alive + '/' + total + '|' + rankTxt + '|' + timeTxt + '|' + coinTxt + '|' + c.solo;
    if (key === this._hudKey) return;
    this._hudKey = key;
    const q = (id) => this._combatHud.querySelector('#' + id);
    const a = q('__cAlive'), t = q('__cTime'), cn = q('__cCoin'), rk = q('__cRank');
    if (a) a.textContent = '存活 ' + alive + '/' + total;
    if (t) t.textContent = timeTxt;
    if (cn && c.mode === 'grapple') cn.textContent = coinTxt;
    if (rk) {
      rk.style.display = rankTxt ? '' : 'none';
      if (rankTxt) rk.textContent = rankTxt;
    }
  }

  // 进入对战/训练场：隐藏城市景物、换上竞技场碰撞体、把玩家放到出生点、初始化战绩、显示状态条
  // opts.local = true 表示「服务端不支持训练场」时的本机离线兜底（没有房间）
  _enterCombat(mode, spawn, isOwner, members, opts) {
    if (this._combat) this._exitCombat(this._lobbySpawn); // 防御：已在对战中先干净退出
    this._lobbySpawn = this._spawn || this._lobbySpawn || { x: 2, z: 144, yaw: 0 };
    const sp = spawn || { x: 0, z: 0, yaw: 0 };
    const roster = members || new Map();
    const local = !!(opts && opts.local);
    // 单人（训练场 / 匹配超时开的单人房）没有对手 → 不存在「赢」，只记自己的成绩
    const solo = local || roster.size < 2;
    // 房间 id 由调用方经 opts 传入：这里的防御性退场会把 this._room 清空
    this._room = (opts && opts.room) || null;
    this._combat = {
      room: this._room, mode, isOwner: !!isOwner, members: roster,
      spawn: sp, roundStart: performance.now(), alive: 0,
      solo, local, roundSeconds: Config.COMBAT_ROUND_SECONDS,
    };
    this._resetMatchStats(mode, roster);
    // 若正骑着电动车进对战，先下车（车不在竞技场里）
    if (this.localState.ride) this._dismountVehicle();
    // 一进竞技场就结束狂飙：_updateRace 在对战中不再跑，不在这里收掉的话，
    // 跑圈 HUD 与赛道可视化（路面 + 门框）会一路留到竞技场里。
    if (this._race) this._exitRace(null);

    // 隐藏主世界景物与城市 NPC；碰撞体先快照再原地替换为竞技场
    if (this._cityRoots) for (const r of this._cityRoots) r.visible = false;
    setEditorSceneVisible(false); // 编辑器建筑不在 roots 里，单独整组隐藏
    if (this.aiNpc) this.aiNpc.group.visible = false;
    if (this.merchant) this.merchant.group.visible = false;
    if (this.vehicle) this.vehicle.group.visible = false;
    // 狂飙的池子车也一起藏（竞技场里不该出现它们；退出对战后由 _updateVehicle 按需重新露出来）
    if (this._vehPool) for (const v of this._vehPool.values()) v.group.visible = false;
    this._speedHudShow(false); // 车速表同理：竞技场里不露（_updateVehicle 在对战中不跑）
    if (this.boss && this.boss.group) this.boss.group.visible = false;
    if (this.boss && this.boss.portalGroup) this.boss.portalGroup.visible = false;
    this._syncBoundary(); // 边界让位：竞技场自带一圈墙，大厅边界在这局里不生效
    if (this._portalHint) this._portalHint.style.display = 'none';
    if (this._merchantHint) this._merchantHint.style.display = 'none';
    if (this._vehHint) this._vehHint.style.display = 'none';
    if (this._chatTab) this._chatTab.style.display = 'none';

    this._mainColliders = this.colliders.slice(); // 快照主世界碰撞体内容（退出时还原）
    // 按模式换场景：陨石混战 = 平地竞技场；疯狂抓钩 = 柱子林 + 底部岩浆
    this._arena = (mode === 'grapple') ? buildGrappleArena(this.scene) : buildArena(this.scene);
    this._beacons = this._arena.beacons || null; // 抓钩模式的柱顶光点（瞄准靶）；其它模式为 null
    this.colliders.length = 0; // 原地改写：LocalPlayer 持有的数组引用保持不变
    for (const c of this._arena.colliders) this.colliders.push(c);
    // 原地改写后碰撞体**内容**全变了（长度还可能撞巧一样）→ 必须显式让宽相位网格重建
    if (this.localPlayer) this.localPlayer.markCollidersDirty();

    // 玩家落到出生点（抓钩模式出生在平台顶面，spawn.y 是脚底高度；换算见 _feetToTop）
    this.localState.x = sp.x;
    this.localState.z = sp.z;
    this.localState.yaw = sp.yaw || 0;
    this.localState.y = this._feetToTop(sp.y);
    this.localState.health = Config.HEALTH_MAX;
    this.localPlayer.physics.velocity.set(0, 0, 0);
    this._dead = false;
    this._spawn = sp;
    this._updateHealthBar();
    this._clearTransients(); // 清掉主世界留下的投掷物/黑洞/特效，避免带进竞技场

    for (const m of this._meteors) this._disposeMeteor(m); // 防御：清掉可能的上场残留
    this._meteors.length = 0;
    this._meteorTimer = 0; // 房主首波立刻开始
    this._coinCount = 0;   // 抓钩模式的吃币计数
    this._coinTimer = 0;   // 房主首波金币立刻开始
    this._endGrapple();
    this._showCombatHUD();
    // HUD 模式名 + 金币位（只有抓钩模式显示金币）
    const modeEl = this._combatHud.querySelector('#__cMode');
    const coinEl = this._combatHud.querySelector('#__cCoin');
    const meta = COMBAT_MODES[mode] || COMBAT_MODES.meteor;
    // 训练场用后缀区分，别让人以为自己在打匹配（输赢规则完全不同）
    if (modeEl) modeEl.textContent = meta.name + (solo ? '（训练场）' : '');
    if (coinEl) coinEl.style.display = mode === 'grapple' ? '' : 'none';
    this._setCombatBtnText('退出对战');
    this._updateBossUI(); // 刷新攻击按钮（对战中常驻）
    this._updateSkillBarVisibility(); // 竞技场里不显示技能栏
    this._updateCombatHUD();
    this._toast(solo
      ? '进入训练场「' + meta.name + '」（' + (modeRule(mode).timed ? '限时 ' + Config.COMBAT_ROUND_SECONDS + ' 秒' : '不计时') + '）'
      : '已匹配！进入「' + meta.name + '」— ' + (meta.win || ''));
  }

  // 退出对战/训练场：拆掉竞技场、还原城市景物与主世界碰撞体、玩家回大厅出生点
  _exitCombat(lobbySpawn) {
    if (!this._combat && !this._arena) return; // 幂等：已退出则直接返回
    const was = this._combat;
    for (const m of this._meteors) this._disposeMeteor(m);
    this._meteors.length = 0;
    this._disposeMeteorAssets();
    if (this._arena) { this._arena.dispose(); this._arena = null; }
    this._beacons = null; // 光点随竞技场一起销毁，别在下一场景里继续高亮

    // 还原城市景物与 NPC
    if (this._cityRoots) for (const r of this._cityRoots) r.visible = true;
    setEditorSceneVisible(true);
    if (this.aiNpc) this.aiNpc.group.visible = true;
    if (this.merchant) this.merchant.group.visible = true;
    if (this.vehicle) this.vehicle.group.visible = true;
    if (this.boss && this.boss.group) this.boss.group.visible = true;
    if (this.boss && this.boss.portalGroup) this.boss.portalGroup.visible = true;

    // 还原主世界碰撞体（原地改回，保持 LocalPlayer 的数组引用不变）
    this.colliders.length = 0;
    for (const c of this._mainColliders) this.colliders.push(c);
    if (this.localPlayer) this.localPlayer.markCollidersDirty();

    // 玩家回大厅出生点
    const sp = lobbySpawn || this._lobbySpawn || { x: 2, z: 144, yaw: 0 };
    this.localState.x = sp.x;
    this.localState.z = sp.z;
    this.localState.yaw = sp.yaw || 0;
    this.localState.y = Config.PLAYER_HEIGHT * this.localPlayer.physics.sizeScale;
    this.localState.health = Config.HEALTH_MAX;
    this.localPlayer.physics.velocity.set(0, 0, 0);
    this._dead = false;
    this._spawn = sp;
    this._updateHealthBar();

    // 本机兜底的训练场：恢复大厅玩家显示与状态上报
    if (was && was.local) {
      this._trainLocal = false;
      if (this.network) this.network.setStateMuted(false);
    }
    this._trainPending = null;
    this._trainTimer = 0;
    this._combat = null;
    this._room = null;
    this._endRoundCleanup();
    this._syncBoundary(); // 回到主世界：重新启用编辑器调出来的边界，并恢复可见墙
    this._clearDrops(); // 竞技场里丢的东西不跟着回大厅
    this._clearCoins();
    this._endGrapple();
    this._hideCombatHUD();
    this._setCombatBtnText('对战匹配');
    this._updateBossUI(); // 交回给主世界逻辑控制攻击按钮显隐
    this._updateSkillBarVisibility(); // 回到主世界，恢复技能栏
    this._toast('已退出，返回主世界');
  }

  // ============ 输赢：战绩表 / 判定 / 观战 / 结算 ============

  // 昵称与颜色：必须与服务端在别人那里补的规则一致，否则同一个人在自己屏幕上和别人屏幕上不一样
  _myNick() {
    return this._profile
      ? (this._profile.nickname || this._profile.username || ('玩家' + this.localState.num))
      : ('玩家' + this.localState.num);
  }

  // 开一局：清空战绩表，把自己与房间成员都登记为「活着」
  _resetMatchStats(mode, roster) {
    const stats = new Map();
    const add = (id, nick, color) => {
      if (id == null) return;
      stats.set(String(id), {
        id: String(id), nick: nick || '玩家', color: color || '#ffffff',
        alive: true, diedAt: null, coins: 0, kills: 0, gone: false,
      });
    };
    add(this.localState.id, this._myNick(), this._profile && this._profile.nicknameColor);
    for (const m of (roster ? roster.values() : [])) add(m.id, m.nick, m.color);
    this._matchStats = stats;
    // 「活到最后」的分母固定成开局人数：中途有人退房不能让分母变小，
    // 否则 5 人局退到剩 2 人时会提前判出胜负。
    this._matchTotal = stats.size;
    this._roundOver = false;
    this._scoreReady = false;
    this._lastJudge = null; // 上一局的名次缓存作废
    this._lastHitBy = null;
    this._lastHitAt = 0;
    this._exitSpectate();
    this._hideResultPanel();
  }

  // 存活人数（退房的算「出局」，不算存活）
  _aliveCount() {
    let n = 0;
    for (const s of this._matchStats.values()) if (s.alive && !s.gone) n++;
    return n;
  }

  // 战绩表 → 交给 MatchRules 算名次与胜负（纯函数，已单独自检）
  _scoreRows() {
    const c = this._combat;
    const now = performance.now();
    const entries = [];
    for (const s of this._matchStats.values()) {
      entries.push({
        id: s.id, nick: s.nick, color: s.color,
        alive: !!s.alive && !s.gone, diedAt: s.diedAt,
        coins: s.coins, kills: s.kills,
      });
    }
    return judge({
      mode: c ? c.mode : 'meteor',
      startedAt: c ? c.roundStart : now,
      now,
      entries,
      solo: !!(c && c.solo),
      roundSeconds: c ? c.roundSeconds : Config.COMBAT_ROUND_SECONDS,
    });
  }

  // 本机阵亡：记时刻 + 把击杀算给最近打到我的人 + 广播（本机兜底的训练场没有房间，不发）
  _noteLocalDeath() {
    const c = this._combat;
    if (!c) return;
    const now = performance.now();
    const meId = String(this.localState.id);
    const me = this._matchStats.get(meId);
    if (me && me.alive) { me.alive = false; me.diedAt = now; }
    // 只有「最后一击来自某个玩家」才算击杀；陨石/岩浆这类环境伤害没有击杀者。
    // 5 秒窗口是防止「先被 A 打一下、很久之后才被环境伤害打死」也算成 A 的击杀。
    const by = (this._lastHitBy && now - this._lastHitAt <= 5000) ? String(this._lastHitBy) : null;
    const killer = by ? this._matchStats.get(by) : null;
    if (killer && killer.id !== meId) killer.kills++;
    this._lastHitBy = null;
    if (!c.local && this.network) this.network.sendDie(by || '');
  }

  // 别人阵亡（由对方的客户端上报）：记战绩 + 播一行击杀播报
  _onRemoteDied(msg) {
    this._scoreReady = true; // 服务端已支持 die 中继 → 击杀统计可用
    const id = String(msg.id || '');
    if (!id) return;
    const st = this._matchStats.get(id);
    const by = msg.by ? this._matchStats.get(String(msg.by)) : null;
    if (st) {
      if (st.alive) { st.alive = false; st.diedAt = performance.now(); }
      if (by) by.kills++;
    }
    if (st && this.chat) {
      this.chat.add({ sys: true, text: by ? ('⚔ ' + by.nick + ' 击败了 ' + st.nick) : ('☠ ' + st.nick + ' 被击倒') });
    }
  }

  // 有人退房 = 出局（不是阵亡，结算里会分开显示）
  _markGone(id) {
    const st = this._matchStats.get(String(id));
    if (!st || st.gone) return;
    st.gone = true;
    st.alive = false;
    if (!st.diedAt) st.diedAt = performance.now();
  }

  // 从同房快照里读别人的血量：血量到 0 就是阵亡。
  // 这条是「人人可推导」的主路径（服务器本来就同步每个人的 health），
  // die 广播只是补上「被谁打死的」这一条谁都推不出来的信息。
  _syncAliveFromSnapshot(players) {
    if (!this._matchStats.size) return;
    const meId = String(this.localState.id);
    const now = performance.now();
    for (const p of players) {
      if (!p) continue;
      const id = String(p.id);
      if (id === meId) continue; // 自己的死亡由 _die 处理（那边还要做击杀归因）
      const st = this._matchStats.get(id);
      if (!st) continue;
      const hp = Number(p.health);
      if (Number.isFinite(hp) && hp <= 0 && st.alive) { st.alive = false; st.diedAt = now; }
    }
  }

  // 每帧检查本局是否该收场（判定逻辑全在 MatchRules.judge 里）
  _updateMatch() {
    const c = this._combat;
    if (!c) return;
    if (!this._roundOver) {
      const res = this._scoreRows();
      this._lastJudge = res;
      if (res.over) this._endRound(res);
    }
    this._updateCombatHUD();
  }

  _endRound(res) {
    const c = this._combat;
    if (!c || this._roundOver) return;
    this._roundOver = true;
    c.overAt = performance.now();
    // 收场清场：别让结算面板后面还在砸陨石/吃金币
    for (const m of this._meteors) this._disposeMeteor(m);
    this._meteors.length = 0;
    this._clearCoins();
    this._hideSpectateHud(); // 结算面板出来了，观战提示条让位（相机继续跟着，画面不至于僵住）
    const meId = String(this.localState.id);
    if (!c.solo && res.winnerId) {
      const won = res.winnerId === meId;
      this._showFailText(won ? '胜利' : '失败', won ? 'var(--kui-gold-hi-2)' : 'var(--kui-danger)');
    }
    this._showResultPanel(res);
  }

  // 离开这一局时的清理（结算面板、观战、战绩表）
  _endRoundCleanup() {
    this._roundOver = false;
    this._matchStats.clear();
    this._matchTotal = 0;
    this._scoreReady = false;
    this._lastHitBy = null;
    this._lastHitAt = 0;
    this._exitSpectate();
    this._hideResultPanel();
  }

  // 转义用户可控文本（昵称来自登录资料，直接拼进 innerHTML 就是注入）
  _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
  }

  // 结算面板：名次 / 昵称 / 存活 / 击杀 / 金币（训练场则是本次成绩 + 本机最高记录）
  _showResultPanel(res) {
    const c = this._combat;
    if (!c) return;
    const meId = String(this.localState.id);
    const solo = !!c.solo;
    const rows = res.rows;

    // —— 训练场：只关心自己的成绩 ——
    let head = '';
    if (solo) {
      const mine = rows.find((r) => r.id === meId) || rows[0];
      const isCoin = c.mode === 'grapple';
      const score = trainingScore(c.mode, mine);
      const fmt = (v) => (v == null ? '暂无' : (isCoin ? String(v) + ' 枚' : formatClock(v)));
      const prev = this._trainBestOf(c.mode);
      const isNew = isBetter(prev, score);
      if (isNew) this._saveTrainBest(c.mode, score);
      head = '<div class="kui-title" style="font-size:19px;margin-bottom:4px;">训练成绩</div>' +
        '<div style="font-size:13px;color:var(--kui-ink-soft);margin-bottom:10px;">' +
        (isCoin ? '限时内吃到的金币' : '本局坚持了多久') + '</div>' +
        '<div style="font-size:15px;line-height:1.9;">' +
        '本次：<b style="color:var(--kui-gold-hi-2);font-size:20px;">' + fmt(score) + '</b><br>' +
        '本机最高：<b>' + fmt(isNew ? score : prev) + '</b>' +
        (isNew ? ' <span style="color:var(--kui-ok);font-weight:700;">新纪录！</span>' : '') +
        '</div>';
    } else {
      const won = res.winnerId === meId;
      const mine = rows.find((r) => r.id === meId);
      const winner = rows.find((r) => r.id === res.winnerId);
      const why = res.reason === 'lastAlive' ? '活到最后' : '时间到';
      head = '<div class="kui-title" style="font-size:19px;margin-bottom:4px;">' +
        (res.winnerId ? (won ? '胜利' : '失败') : '本局结束') + '</div>' +
        '<div style="font-size:13px;color:var(--kui-ink-soft);margin-bottom:10px;">' +
        (res.winnerId
          ? (why + ' · ' + (winner ? this._esc(winner.nick) : '') + ' 获胜（' + (c.mode === 'grapple' ? '金币最多' : COMBAT_MODES[c.mode].win) + '）')
          : (why + ' · 无人获胜')) + '</div>' +
        '<div style="font-size:13px;">你的名次：<b style="color:var(--kui-gold-hi-2);font-size:17px;">第 ' + (mine ? mine.rank : '-') + ' 名</b>' +
        ' / 共 ' + rows.length + ' 人</div>';
    }

    // —— 名次表 ——
    let table = '<div style="margin:12px 0 4px;border-top:1px solid rgba(255,255,255,.14);padding-top:10px;">' +
      '<div style="display:grid;grid-template-columns:38px 1fr 62px 46px 52px;gap:2px 6px;font-size:12px;">' +
      '<span style="color:var(--kui-ink-soft);">名次</span><span style="color:var(--kui-ink-soft);">玩家</span>' +
      '<span style="color:var(--kui-ink-soft);text-align:right;">存活</span>' +
      '<span style="color:var(--kui-ink-soft);text-align:right;">击杀</span>' +
      '<span style="color:var(--kui-ink-soft);text-align:right;">金币</span>';
    for (const r of rows) {
      const st = this._matchStats.get(r.id);
      const tag = r.id === meId ? ' <span style="color:#4ea1ff;">(你)</span>' : '';
      const gone = st && st.gone ? ' <span style="color:var(--kui-ink-soft);">已退房</span>' : (r.alive ? '' : '');
      table += '<span style="font-weight:700;color:' + (r.id === res.winnerId ? 'var(--kui-gold-hi-2)' : '#fff') + ';">' + r.rank + '</span>' +
        '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:' + this._esc(r.color) + ';">' +
        this._esc(r.nick) + tag + gone + '</span>' +
        '<span style="text-align:right;">' + formatClock(r.survivalMs) + '</span>' +
        '<span style="text-align:right;">' + r.kills + '</span>' +
        '<span style="text-align:right;">' + r.coins + '</span>';
    }
    table += '</div>';
    if (!solo && !this._scoreReady) {
      table += '<div style="margin-top:8px;font-size:11px;color:var(--kui-ink-soft);">' +
        '注：服务端未广播战绩，别人的击杀/金币仅供参考</div>';
    }
    table += '</div>';

    const actions =
      '<button type="button" id="__resAgain" class="kui-btn kui-btn--primary" style="flex:1;">再来一局</button>' +
      '<button type="button" id="__resLobby" class="kui-btn kui-btn--grey" style="flex:1;">回大厅</button>';

    if (!this._resultPanel) {
      const el = document.createElement('div');
      el.style.cssText =
        'position:fixed;inset:0;z-index:9650;display:flex;align-items:center;justify-content:center;' +
        'background:rgba(8,14,24,.62);font-family:var(--kui-font);color:var(--kui-paper);';
      el.innerHTML = '<div class="kui-panel" style="min-width:340px;max-width:92vw;max-height:88vh;overflow:auto;padding:22px;text-align:center;">' +
        '<div id="__resHead"></div><div id="__resTable"></div>' +
        '<div style="display:flex;gap:10px;margin-top:14px;">' + actions + '</div></div>';
      document.body.appendChild(el);
      const again = el.querySelector('#__resAgain');
      const lobby = el.querySelector('#__resLobby');
      if (again) again.addEventListener('click', () => this._rematch());
      if (lobby) lobby.addEventListener('click', () => {
        this._hideResultPanel();
        this._leaveCombatNow('已返回大厅');
      });
      this._resultPanel = el;
    }
    const h = this._resultPanel.querySelector('#__resHead');
    const t = this._resultPanel.querySelector('#__resTable');
    if (h) h.innerHTML = head;
    if (t) t.innerHTML = table;
    this._resultPanel.style.display = 'flex';
    this._setChatLock(true); // 结算面板期间别让角色还在走
  }

  _hideResultPanel() {
    if (this._resultPanel) this._resultPanel.style.display = 'none';
  }

  // 再来一局：训练场就直接重开；匹配要先退房再排队（服务端在房里会忽略 match）
  _rematch() {
    const c = this._combat;
    if (!c) return;
    const mode = c.mode, solo = c.solo, local = c.local;
    this._hideResultPanel();
    if (solo) {
      if (local) {
        this._exitCombat(this._lobbySpawn);
        this._startTrainingLocal(mode);
      } else {
        this._startTraining(mode); // 服务端开新单人房；_enterCombat 会先干净退出旧局
      }
      return;
    }
    if (this.network) this.network.sendLeaveRoom();
    this._exitCombat(this._lobbySpawn);
    this._setChatLock(false);
    this._startMatch(mode);
  }

  // ---- 观战：阵亡后留在房里等这局分出胜负（能聊天、不能动、可切换视角、可提前退出）----
  _enterSpectate() {
    const c = this._combat;
    if (!c) return;
    const meId = String(this.localState.id);
    const others = [...this._matchStats.values()].filter((s) => s.id !== meId && !s.gone);
    const alive = others.filter((s) => s.alive);
    const list = (alive.length ? alive : others).map((s) => s.id);
    this._spectate = { order: list, idx: 0, shownId: null };
    this._showSpectateHud();
    this._updateSpectateHud();
    this._updateSkillBarVisibility();
  }

  _exitSpectate() {
    this._spectate = null;
    this._hideSpectateHud();
  }

  // 切到下一个「还在场」的目标；没有可看的人就返回 false
  _spectateNext() {
    const sp = this._spectate;
    if (!sp || !sp.order.length) return false;
    for (let k = 1; k <= sp.order.length; k++) {
      const i = (sp.idx + k) % sp.order.length;
      const id = sp.order[i];
      const st = this._matchStats.get(id);
      if (st && !st.gone && this.playerManager.getPlayer(id)) { sp.idx = i; return true; }
    }
    return false;
  }

  // 观战相机：站在目标身后看目标（与第三人称同一套公式，只是「自己」换成了目标）
  _updateSpectate() {
    const sp = this._spectate;
    if (!sp) return;
    let id = sp.order[sp.idx];
    let target = id ? this.playerManager.getPlayer(id) : null;
    const st = id ? this._matchStats.get(id) : null;
    if (!target || !st || st.gone) {
      if (this._spectateNext()) {
        id = sp.order[sp.idx];
        target = this.playerManager.getPlayer(id);
      }
    }
    if (!target) return;
    const p = target.model.position;
    const eye = new THREE.Vector3(p.x, p.y + Config.PLAYER_HEIGHT * 0.9, p.z);
    const yaw = this.localState.yaw;
    const pitch = this.localState.pitch;
    const cosP = Math.cos(pitch), sinP = Math.sin(pitch);
    const viewDir = new THREE.Vector3(-Math.sin(yaw) * cosP, sinP, -Math.cos(yaw) * cosP);
    const camPos = eye.clone().addScaledVector(viewDir, -Config.SPECTATE_DIST)
      .add(new THREE.Vector3(0, Config.SPECTATE_LIFT, 0));
    if (camPos.y < 0.4) camPos.y = 0.4; // 别钻到地面以下
    this.camera.position.copy(camPos);
    this.camera.rotation.set(pitch, yaw, 0); // 与第三人称同一约定：鼠标照样能转视角
    this._updateSpectateHud();
  }

  _showSpectateHud() {
    if (!this._spectateHud) {
      const el = document.createElement('div');
      el.style.cssText =
        'position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:9400;' +
        'display:flex;gap:10px;align-items:center;' +
        'font:13px/1.4 var(--kui-font);color:var(--kui-paper);' +
        'background:rgba(11,21,34,.72);border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:7px 12px;';
      el.innerHTML =
        '<span class="kui-tag kui-tag--warn">观战中</span>' +
        '<span id="__spTarget">-</span>' +
        '<button type="button" id="__spNext" class="kui-btn kui-btn--grey" style="padding:3px 10px;">切换视角</button>' +
        '<button type="button" id="__spQuit" class="kui-btn kui-btn--grey" style="padding:3px 10px;">提前退出</button>';
      document.body.appendChild(el);
      const n = el.querySelector('#__spNext');
      const q = el.querySelector('#__spQuit');
      if (n) n.addEventListener('click', () => { if (!this._spectateNext()) this._toast('没有别的视角了'); this._updateSpectateHud(); });
      if (q) q.addEventListener('click', () => {
        this._hideSpectateHud();
        this._leaveCombatNow('已中途退出对战');
      });
      this._spectateHud = el;
    }
    this._spectateHud.style.display = 'flex';
  }

  _hideSpectateHud() {
    if (this._spectateHud) this._spectateHud.style.display = 'none';
  }

  // 提示条只在「看着的人变了」时才写 DOM（每帧写会抖）
  _updateSpectateHud() {
    const sp = this._spectate;
    if (!sp || !this._spectateHud) return;
    const id = sp.order[sp.idx];
    if (id === sp.shownId) return;
    sp.shownId = id;
    const el = this._spectateHud.querySelector('#__spTarget');
    const st = id ? this._matchStats.get(id) : null;
    if (el) el.textContent = st ? ('正在看 ' + st.nick + (st.alive ? '' : '（已阵亡）')) : '暂无存活玩家';
  }

  // ---- 训练场最高记录（本机 localStorage；隐私模式下只留内存）----
  _trainBestOf(mode) {
    const v = this._trainBest[mode];
    if (v !== undefined && v !== null) return v;
    let raw = null;
    try { raw = localStorage.getItem(bestKey(mode)); } catch (e) { raw = null; }
    const parsed = parseBest(raw);
    this._trainBest[mode] = parsed;
    return parsed;
  }

  _saveTrainBest(mode, score) {
    this._trainBest[mode] = score;
    try { localStorage.setItem(bestKey(mode), String(score)); } catch (e) { /* 隐私模式：只留内存 */ }
  }

  // 清掉在飞的投掷物 / 黑洞 / 爆炸特效 / 追踪导弹（切换场景时调用，避免跨场景残留）
  _clearTransients() {
    for (const p of this._projectiles) { if (p && p.mesh) this._releaseProjMesh(p.mesh); }
    this._projectiles.length = 0;
    for (const h of this._holes) { const g = h && (h.group || h.mesh); if (g) this.scene.remove(g); }
    this._holes.length = 0;
    for (const f of this._fx) { if (f && f.group) this.scene.remove(f.group); }
    this._fx.length = 0;
    for (const m of this._missiles) { if (m && m.mesh) this.scene.remove(m.mesh); }
    this._missiles.length = 0;
    this._clearDrops(); // 掉落物属于当前场景，切换场景时清掉
    this._endGrapple(); // 抓钩状态/绳索不跨场景
    // 别人的绳索同样不跨场景：它们挂在 scene 上，不清会拖着一条线跟着进竞技场
    for (const id of Array.from(this._remoteGrapples.keys())) this._removeRemoteGrapple(id);
    this._clearCoins(); // 金币属于当前对战场景
  }

  // ============ 抓钩：朝准星甩出钩爪，勾住就拽自己过去 ============

  // 抓钩的「最长持续时间」按实际距离算：飞行段（钩爪以 GRAPPLE_SPEED×3 飞出去）+ 拽人段（GRAPPLE_SPEED 拉人）
  // + 余量。之前写死 GRAPPLE_MAX_TIME=2.4s，钩爪距离拉到 92m 后「飞行 + 拽人」早就超过 2.4s，
  // 表现就是「勾到一半绳子/钩爪没了」。现在时间跟着距离走。
  _grappleTimeFor(dist) {
    const d = Math.max(0, dist);
    const fly = d / (Config.GRAPPLE_SPEED * 3);
    const pull = d / Config.GRAPPLE_SPEED;
    return Math.max(Config.GRAPPLE_MAX_TIME, (fly + pull) * 1.3 + 0.5);
  }

  // 再按一次 = 松手；未抓住时按 = 甩钩
  _fireGrapple() {
    if (this._grapple) { this._endGrapple(true); return; } // 已经抓着 → 松开（半路松手：惯性继承）
    if (this._dead || this._soul) return;
    if (this.localState.ride) { this._toast('骑车时用不了抓钩'); return; }
    if (this._grappleCd > 0) return;
    const s = this.localState;
    const cosP = Math.cos(s.pitch);
    const sinP = Math.sin(s.pitch);
    const dir = new THREE.Vector3(-Math.sin(s.yaw) * cosP, sinP, -Math.cos(s.yaw) * cosP).normalize();
    const origin = new THREE.Vector3(s.x, s.y, s.z).addScaledVector(dir, 0.6);
    // 疯狂抓钩模式：最优先「瞄柱顶光点」。玩家只要把准星对上光点按攻击，钩爪就飞过去，
    // 不用再去精确勾柱子的面（移动端根本瞄不准复杂几何）。锚点比抓墙更近，才能正好落到柱顶。
    const beacon = this._pickBeacon(s, dir);
    if (beacon) {
      this._grappleCd = Config.GRAPPLE_COOLDOWN;
      this._grapple = {
        x: beacon.x, y: beacon.y, z: beacon.z,
        fx: origin.x, fy: origin.y, fz: origin.z,
        flying: true,
        // 时间跟着「手→光点」的距离走，别再写死 2.4s（远距离会中途断掉）
        t: this._grappleTimeFor(Math.hypot(beacon.x - origin.x, beacon.y - origin.y, beacon.z - origin.z)),
        stop: Config.GRAPPLE_BEACON_STOP, // 收得比抓墙紧，落点才压在柱顶
        // 光点在柱顶上方 1m、松手点还要再退 0.9m，靠碰撞解算会把人嵌进柱子再侧向弹出去
        // （柱顶是这里唯一的落脚点，弹出去就是掉岩浆），所以直接记下「柱顶站立点」，
        // 到达时把人放上去（见 _updateGrapple）。
        landX: beacon.x,
        landZ: beacon.z,
        landY: beacon.topY + Config.PLAYER_HEIGHT * this.localPlayer.physics.sizeScale,
      };
      this._ensureGrappleViz();
      this._grappleRope.visible = true;
      this._grappleHook.visible = true;
      this._sendGrappleOn();
      return;
    }
    // 其次判「钩到人」：勾中别人就不拽自己，而是把他朝视线方向甩出去
    // （疯狂抓钩模式的乐趣就在这——把人从柱子上甩进岩浆）
    const victim = this._grappleCatchTarget(s, dir);
    if (victim) {
      const kx = dir.x * Config.GRAPPLE_THROW;
      const kz = dir.z * Config.GRAPPLE_THROW;
      const ky = Config.GRAPPLE_THROW_UP;
      this.network.sendKnock(victim.id, kx, ky, kz);
      if (victim.rp && typeof victim.rp.applyKnockPreview === 'function') victim.rp.applyKnockPreview(kx, ky, kz);
      this._grappleCd = Config.GRAPPLE_COOLDOWN;
      this._toast('抓钩勾中了人，把他甩了出去');
      return;
    }
    const hit = this._rayHitWorld(origin, dir, Config.GRAPPLE_RANGE);
    this._grappleCd = Config.GRAPPLE_COOLDOWN;
    if (!hit) { this._toast('抓钩没勾到东西'); return; }
    // 锚点沿射线回退一点，避免把自己拽进墙里
    const p = hit.point.addScaledVector(dir, -(Config.PLAYER_RADIUS + 0.35));
    this._grapple = {
      x: p.x, y: p.y, z: p.z,
      fx: origin.x, fy: origin.y, fz: origin.z, // 钩爪从手边飞出去
      flying: true,
      // 时间跟着「手→锚点」的距离走（飞行 + 拽人两段都算进去），远距离不再中途断掉
      t: this._grappleTimeFor(Math.hypot(p.x - origin.x, p.y - origin.y, p.z - origin.z)),
    };
    this._ensureGrappleViz();
    this._grappleRope.visible = true;
    this._grappleHook.visible = true;
    this._sendGrappleOn();
  }

  // 把「我甩出了抓钩」广播出去：别人据此在自己的场景里画一条连着我飞出去的绳子。
  // 只发锚点/出手点/时长，不发逐帧坐标——我的位置本来就由 20Hz 快照同步过去了，
  // 绳子那端跟着我的模型走就行，省掉一路高频广播。
  _sendGrappleOn() {
    const g = this._grapple;
    if (!g || !this.network) return;
    this.network.sendGrapple({
      ev: 'on', x: g.x, y: g.y, z: g.z, ox: g.fx, oy: g.fy, oz: g.fz, dur: g.t,
    });
  }

  // 光点瞄准判定：疯狂抓钩模式下，准星中轴 GRAPPLE_BEACON_ARC 度内、GRAPPLE_RANGE 内最近的那颗柱顶光点。
  // 返回光点对象（含 x/y/z 锚点）或 null。非抓钩模式 this._beacons 为 null，直接返回 null。
  _pickBeacon(s, dir) {
    const list = this._beacons;
    if (!list || !list.length) return null;
    const cosHalf = Math.cos((Config.GRAPPLE_BEACON_ARC * Math.PI) / 180 / 2);
    let best = null;
    let bestD = Infinity;
    for (const b of list) {
      const dx = b.x - s.x;
      const dy = b.y - s.y;
      const dz = b.z - s.z;
      const d = Math.hypot(dx, dy, dz);
      if (d < 1.2 || d > Config.GRAPPLE_RANGE) continue; // 太近（已在柱上）/ 太远都判不中
      if ((dx * dir.x + dy * dir.y + dz * dir.z) / d < cosHalf) continue;
      if (d < bestD) { bestD = d; best = b; }
    }
    return best;
  }

  // 光点每帧表现：整体呼吸 + 「当前瞄中的那颗」放大发亮。
  // 高亮是给玩家的反馈——看到哪颗变亮，就知道按攻击会飞去哪根柱子。
  // 同时把结果记进 this._beaconAimed，供 _updateAimUI 驱动准星/攻击键（这里必须每帧都写，
  // 哪怕这次没有光点，否则退出抓钩模式后准星会一直停在「热」的状态）。
  _updateBeacons() {
    const list = this._beacons;
    const s = this.localState;
    let aimed = null;
    if (list && list.length) {
      const cosP = Math.cos(s.pitch);
      const sinP = Math.sin(s.pitch);
      _gDir.set(-Math.sin(s.yaw) * cosP, sinP, -Math.cos(s.yaw) * cosP).normalize();
      if (!this._dead && !this._soul) aimed = this._pickBeacon(s, _gDir);
      const pulse = 1 + Math.sin(this.clock.elapsedTime * 2.6) * 0.14;
      for (const b of list) {
        const hot = b === aimed;
        const k = (hot ? 1.5 : 1) * pulse;
        if (b.halo) {
          b.halo.scale.setScalar(k);
          // 光晕（与激光柱）材质是每个光点独享的，所以这里改透明度只影响自己
          b.halo.material.opacity = hot ? 0.66 : 0.3;
        }
        if (b.core) b.core.scale.setScalar(hot ? 1.5 : 1);
      }
    }
    this._beaconAimed = aimed;
  }

  // 钩人判定：准星中轴 GRAPPLE_CATCH_ARC 度内、GRAPPLE_RANGE 内最近的那个玩家
  _grappleCatchTarget(s, dir) {
    if (!this.playerManager || !this.playerManager.players) return null;
    const cosHalf = Math.cos((Config.GRAPPLE_CATCH_ARC * Math.PI) / 180 / 2);
    let best = null;
    let bestD = Infinity;
    for (const [id, rp] of this.playerManager.players) {
      if (id === s.id || !rp || !rp.state) continue;
      const st = rp.state;
      const dx = st.x - s.x;
      const dy = st.y - s.y;
      const dz = st.z - s.z;
      const d = Math.hypot(dx, dy, dz);
      if (d < 0.6 || d > Config.GRAPPLE_RANGE) continue;
      if (Math.abs(dy) > Config.GRAPPLE_CATCH_DY) continue;
      if ((dx * dir.x + dy * dir.y + dz * dir.z) / d < cosHalf) continue;
      if (d < bestD) { bestD = d; best = { id, rp }; }
    }
    return best;
  }

  // 结束抓钩。
  // inherit = true 表示「还在半路就把钩松了」（再按一次 / 超时）：把拽人的那股速度交给常规移动，
  //   松手后顺着原方向继续冲一段（惯性继承），跳起来再松手就能飞出去。
  // inherit = false（默认）用于到点落地、死亡、切场景等：这些场合要收住速度 / 不该再获得冲劲。
  _endGrapple(inherit = false) {
    const phys = this.localPlayer.physics;
    // 只清掉自己写进去的那份速度覆盖（控制枪可能也在用 velocityHold）
    const hold = this._grappleHold;
    // 只有「正在拽人」才有速度可继承；钩爪还在飞的时候人是没被拽动的
    const pulling = !!(hold && this._grapple && !this._grapple.flying);
    if (hold && phys.velocityHold === hold) {
      phys.velocityHold = null;
      if (inherit && pulling) {
        // ⚠ 取的是 phys.velocity（它此刻就等于拽人的速度），不是 hold：万一这一帧被别处改过速度，
        //   继承真实速度才不会凭空多出一段。水平交给 momentum（见 PlayerPhysics 第 2.5 步），
        //   竖直不在这里补——velocity.y 本来就是拽人的竖直速度，重力会接着作用。
        const keep = Config.GRAPPLE_INHERIT;
        phys.momentum = { x: phys.velocity.x * keep, z: phys.velocity.z * keep, t: Config.GRAPPLE_INHERIT_TIME };
      }
    }
    // 抓着一钩才广播「收回」：_endGrapple 也被切场景/超时等路径调用，没有活钩就别发。
    // 少发一条只是别人那边绳子多留一会儿（他们自己有时长兜底），多发会让绳子乱闪。
    const wasOn = !!this._grapple;
    this._grappleHold = null;
    // 抓钩一结束就恢复碰撞，别把「无视碰撞」漏到落地之后的正常移动里
    this.localPlayer.physics.noClip = false;
    this._grapple = null;
    if (this._grappleRope) this._grappleRope.visible = false;
    if (this._grappleHook) this._grappleHook.visible = false;
    this._grappleCd = Config.GRAPPLE_COOLDOWN;
    if (wasOn && this.network) this.network.sendGrapple({ ev: 'off' });
  }

  // 每帧推进：钩爪飞出 → 按锚点方向拽人 → 到位/超时/松手结束
  _updateGrapple(dt) {
    if (this._grappleCd > 0) this._grappleCd = Math.max(0, this._grappleCd - dt);
    const g = this._grapple;
    if (!g) return;
    if (this._dead || this._soul || this.localState.ride) { this._endGrapple(); return; }
    g.t -= dt;
    const s = this.localState;
    if (g.flying) {
      // 钩爪以固定速度飞向锚点（视觉上「甩出去」而不是瞬间贴住）
      const to = new THREE.Vector3(g.x - g.fx, g.y - g.fy, g.z - g.fz);
      const step = Config.GRAPPLE_SPEED * 3 * dt;
      if (to.length() <= step) {
        g.fx = g.x; g.fy = g.y; g.fz = g.z;
        g.flying = false;
      } else {
        to.normalize();
        g.fx += to.x * step; g.fy += to.y * step; g.fz += to.z * step;
      }
    } else {
      const dx = g.x - s.x;
      const dy = g.y - s.y;
      const dz = g.z - s.z;
      const dist = Math.hypot(dx, dy, dz);
      const stop = g.stop || Config.GRAPPLE_STOP_DIST;
      // 光点锚点收得比抓墙更紧（g.stop），否则会在柱子斜上方就松手 → 落在柱外掉进岩浆
      const arrived = dist <= stop;
      if (arrived || g.t <= 0) {
        if (arrived) {
          // 到点了把速度收住：拽人时每帧速度都被覆盖成 25m/s，直接松手会带着这股冲劲
          // 冲过柱子（锚点在半空中，没有墙挡）再掉下去。收住后靠重力自然落到柱顶。
          this.localPlayer.physics.velocity.multiplyScalar(Config.GRAPPLE_ARRIVE_DAMP);
          // 光点抓钩：直接站到柱顶。超时（t<=0）时人还在半空，不能凭空瞬移过去，所以只在正常到点时生效。
          if (g.landY != null) {
            this.localState.x = g.landX;
            this.localState.z = g.landZ;
            this.localState.y = g.landY;
            this.localPlayer.physics.velocity.set(0, 0, 0);
          }
        }
        // 半路被超时掐断 → 惯性继承（继续冲一段）；正常到点 → 收住，别冲过柱子掉岩浆
        this._endGrapple(!arrived);
        return;
      }
      // 用 velocityHold 每帧覆盖速度：重力与输入都被覆盖，拽得干脆且仍会被墙挡住
      const k = Config.GRAPPLE_SPEED / Math.max(0.001, dist);
      const hold = { x: dx * k, y: dy * k, z: dz * k, t: 0.3 };
      this.localPlayer.physics.velocityHold = hold;
      this._grappleHold = hold;
      // 疯狂抓钩模式：拽人期间无视碰撞（被柱身卡住或被侧向弹开都很难受，柱子密起来尤甚）。
      // 主世界勾墙保持原手感——那里穿墙就等于穿模，必须挡住。
      this.localPlayer.physics.noClip = !!(this._combat && this._combat.mode === 'grapple');
    }
    this._drawGrapple();
  }

  // 绳索两端：自己的手 → 钩爪当前坐标。钩爪同步朝向飞行方向（锥尖朝前）。
  _drawGrapple() {
    const g = this._grapple;
    if (!g || !this._grappleRope || !this._grappleHook) return;
    this._grappleHandPos(_gHand);
    _gpA.set(g.fx, g.fy, g.fz);
    _gDir.subVectors(_gpA, _gHand);
    const len = _gDir.length();
    if (len > 1e-4) {
      _gDir.divideScalar(len);
      this._grappleRope.position.copy(_gHand);
      this._grappleRope.quaternion.setFromUnitVectors(UP_Y, _gDir);
      this._grappleRope.scale.set(1, len, 1);
      this._grappleHook.quaternion.setFromUnitVectors(UP_Y, _gDir);
    }
    this._grappleHook.position.copy(_gpA);
  }

  // 供进游戏前的加载动画等待：远端场景拉取完成（它内部还会触发一批 GLB 加载，
  // 那些由 loadTracker 计数，调用方再等一次归零即可）。永不 reject——失败会回退打包数据。
  sceneReady() {
    return this._sceneReady || Promise.resolve();
  }

  // 供加载屏等待：**收到服务器 welcome**（或超时）。
  // 为什么必须等它：玩家自己与其他玩家的角色模型（boy-rig/girl-rig.glb，1~1.6MB）
  // 是 welcome/join 到达后才发起的加载 —— 不等这一步，加载屏会在角色模型**还没开始下载**
  // 时就被撤掉，手机慢网下就会看到「人没出来就放行了」。
  //
  // 语义：本地 id 已被赋值（welcome 处理过）即 resolve；超时则无论如何放行（离线/纯单机不卡人）。
  welcomeReady(timeoutMs = 6000) {
    if (this.localState && this.localState.id) return Promise.resolve();
    if (!this._welcomeWaiters) this._welcomeWaiters = [];
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // 超时：从等待列表里摘掉自己，别让列表无限增长
        const i = this._welcomeWaiters.indexOf(done);
        if (i >= 0) this._welcomeWaiters.splice(i, 1);
        resolve();
      }, timeoutMs);
      const done = () => { clearTimeout(timer); resolve(); };
      this._welcomeWaiters.push(done);
    });
  }

  // welcome 到达时唤醒所有等待者（在下面 case 'welcome' 里调用）
  _resolveWelcomeWaiters() {
    if (!this._welcomeWaiters || !this._welcomeWaiters.length) return;
    const ws = this._welcomeWaiters;
    this._welcomeWaiters = [];
    for (const fn of ws) { try { fn(); } catch { /* 忽略单个等待者的异常 */ } }
  }

  // 绳索与钩爪。绳索用圆柱 Mesh 而不是 Line：Line 的线宽在绝大多数平台上恒为 1px，
  // 在 3D 场景里几乎看不见；圆柱有真实粗细，才能看出「一条线连着自己和钩爪」。
  _ensureGrappleViz() {
    if (!this._grappleRope) {
      const geo = new THREE.CylinderGeometry(0.035, 0.035, 1, 6, 1, true); // 单位高，靠 scale.y 拉到实际长度
      geo.translate(0, 0.5, 0); // 原点挪到一端，这样 position 直接就是「绳子起点」
      this._grappleRope = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({ color: 0xffd76a, transparent: true, opacity: 0.95, depthWrite: false })
      );
      this._grappleRope.frustumCulled = false; // 两端每帧变，包围球不可靠
      this._grappleRope.visible = false;
      this.scene.add(this._grappleRope);
    }
    if (!this._grappleHook) {
      this._grappleHook = new THREE.Mesh(
        new THREE.ConeGeometry(0.2, 0.5, 8),
        new THREE.MeshStandardMaterial({ color: 0xc9d3e6, emissive: 0x2a3644, metalness: 0.7, roughness: 0.3 })
      );
      this._grappleHook.visible = false;
      this.scene.add(this._grappleHook);
    }
  }

  // 绳索起点：自己的手。原来用的是相机位置，第三视角下绳子从「身后」冒出来、不连人；
  // 改成按体型与朝向算出的手部世界坐标，第一/第三人称看起来都是从自己身上射出去的。
  _grappleHandPos(out) {
    const scale = (this.localPlayer && this.localPlayer.physics && this.localPlayer.physics.sizeScale) || 1;
    return this._handPosFrom(this.localState, scale, out);
  }

  // ============ 别人的抓钩：收到广播后在他身上画一条同样的绳子 ============
  //
  // 为什么不逐帧同步钩爪坐标：那是 20~60Hz 的高频广播，而绳子的一端（人）本来就靠快照同步了，
  // 另一端（钩爪）是按「出手点 → 锚点」匀速飞过去的固定路线。所以一次 'on' 带上锚点/出手点/时长就够了，
  // 各端自己推，位置还完全一致。

  // 收到别人的抓钩广播：'on' 起一条、'off' 收掉。
  _onRemoteGrapple(msg) {
    const id = String(msg.from || '');
    if (!id || id === this.localState.id) return; // 自己那条由本地逻辑画，别重复
    if (msg.ev === 'off') { this._removeRemoteGrapple(id); return; }
    const x = Number(msg.x), y = Number(msg.y), z = Number(msg.z);
    const ox = Number(msg.ox), oy = Number(msg.oy), oz = Number(msg.oz);
    const dur = Number(msg.dur);
    if (![x, y, z, ox, oy, oz, dur].every(Number.isFinite)) return;
    let g = this._remoteGrapples.get(id);
    if (!g) {
      g = this._createRemoteGrappleViz();
      if (!g) return;
      this._remoteGrapples.set(id, g);
    }
    g.ax = x; g.ay = y; g.az = z;
    g.fx = ox; g.fy = oy; g.fz = oz;
    g.flying = true;
    g.t = dur;
    g.rope.visible = true;
    g.hook.visible = true;
  }

  // 一份远端绳索视觉：与本地那条同样的圆柱 + 锥体，只是坐标来源换成网络消息
  _createRemoteGrappleViz() {
    if (!this.scene) return null;
    const geo = new THREE.CylinderGeometry(0.035, 0.035, 1, 6, 1, true);
    geo.translate(0, 0.5, 0); // 原点挪到一端，position 直接就是绳子起点
    const rope = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ color: 0xffd76a, transparent: true, opacity: 0.95, depthWrite: false })
    );
    rope.frustumCulled = false;
    rope.visible = false;
    const hook = new THREE.Mesh(
      new THREE.ConeGeometry(0.2, 0.5, 8),
      new THREE.MeshStandardMaterial({ color: 0xc9d3e6, emissive: 0x2a3644, metalness: 0.7, roughness: 0.3 })
    );
    hook.visible = false;
    this.scene.add(rope);
    this.scene.add(hook);
    return { rope, hook, ax: 0, ay: 0, az: 0, fx: 0, fy: 0, fz: 0, flying: true, t: 0 };
  }

  _removeRemoteGrapple(id) {
    const g = this._remoteGrapples.get(id);
    if (!g) return;
    this.scene.remove(g.rope);
    this.scene.remove(g.hook);
    g.rope.geometry.dispose();
    g.rope.material.dispose();
    g.hook.geometry.dispose();
    g.hook.material.dispose();
    this._remoteGrapples.delete(id);
  }

  // 每帧推进别人的钩爪与绳子。人不见了（掉线/退房）或时长到点就收掉，
  // 这样即使 'off' 丢包，绳子也不会永远挂在天上。
  _updateRemoteGrapples(dt) {
    if (!this._remoteGrapples.size) return;
    for (const [id, g] of this._remoteGrapples) {
      const rp = this.playerManager ? this.playerManager.players.get(id) : null;
      g.t -= dt;
      if (!rp || !rp.state || g.t <= 0) { this._removeRemoteGrapple(id); continue; }
      if (g.flying) {
        const step = Config.GRAPPLE_SPEED * 3 * dt; // 与本地钩爪同一个飞行速度
        const dx = g.ax - g.fx, dy = g.ay - g.fy, dz = g.az - g.fz;
        const len = Math.hypot(dx, dy, dz);
        if (len <= step) {
          g.fx = g.ax; g.fy = g.ay; g.fz = g.az;
          g.flying = false;
        } else {
          g.fx += (dx / len) * step; g.fy += (dy / len) * step; g.fz += (dz / len) * step;
        }
      }
      // 绳子起点 = 那个人的手（用他自己同步过来的位置/朝向/体型算）
      this._handPosFrom(rp.state, rp.state.size || 1, _gHand);
      _gpA.set(g.fx, g.fy, g.fz);
      _gDir.subVectors(_gpA, _gHand);
      const len = _gDir.length();
      if (len > 1e-4) {
        _gDir.divideScalar(len);
        g.rope.position.copy(_gHand);
        g.rope.quaternion.setFromUnitVectors(UP_Y, _gDir);
        g.rope.scale.set(1, len, 1);
        g.hook.quaternion.setFromUnitVectors(UP_Y, _gDir);
      }
      g.hook.position.copy(_gpA);
    }
  }

  // ============ 别人的加特林：收到开火广播后复刻一颗子弹 ============

  // 每发一条（射速 GATLING_INTERVAL = 0.1s）。除了复刻子弹，顺带让开火者手里的枪管转一小会儿——
  // 远端模型没有逐帧动画来源，只能靠这条消息推，否则别人看到的加特林是一把「不动的枪」。
  _onRemoteShot(msg) {
    const x = Number(msg.x), y = Number(msg.y), z = Number(msg.z);
    const dx = Number(msg.dx), dy = Number(msg.dy), dz = Number(msg.dz);
    const d = Number(msg.d);
    if (![x, y, z, dx, dy, dz, d].every(Number.isFinite)) return;
    this._spawnBullet(x, y, z, dx, dy, dz, d);
    const rp = this.playerManager ? this.playerManager.players.get(String(msg.from || '')) : null;
    if (rp && rp.model) rp._gunSpin = 0.2; // 秒：这段时间内枪管持续转，比单帧转一下更接近「在扫射」
  }

  // 远端枪管转动的倒计时驱动：收到开火消息时置 0.2s，期间持续转。
  // 停火后（不再收到消息）自然衰减到 0，不需要额外的「停火」消息。
  _spinRemoteGuns(dt) {
    if (!this.playerManager) return;
    for (const rp of this.playerManager.players.values()) {
      if (!rp || !rp._gunSpin || !rp.model) continue;
      rp._gunSpin = Math.max(0, rp._gunSpin - dt);
      spinHeldBarrels(rp.model, dt);
    }
  }

  // 手部世界坐标的通用算法：本地玩家与**远端玩家**共用一份（远端用他自己同步过来的 size），
  // 否则别人甩出的绳子会从脚底或头顶冒出来。
  _handPosFrom(s, scale, out) {
    const h = Config.PLAYER_HEIGHT * (scale || 1);
    const fx = -Math.sin(s.yaw);
    const fz = -Math.cos(s.yaw);
    const rx = Math.cos(s.yaw);
    const rz = -Math.sin(s.yaw);
    // 身前 0.35m、右侧 0.22m（右手）、头顶往下 0.62 个身高 ≈ 胸腹高度
    out.set(s.x + fx * 0.35 + rx * 0.22, s.y - h * 0.62, s.z + fz * 0.35 + rz * 0.22);
    return out;
  }

  // 射线打世界碰撞体，取最近命中：返回 { point, normal } 或 null。
  // 交给 worldQuery：盒按 OBB（含 rotY）、凸包按真实三角形、trimesh 走 BVH——复杂建筑不再被穿透，
  // 另外把「隐式地面」也算进去（世界里地面不是碰撞体，但抓钩应该能勾住地面）。
  _rayHitWorld(origin, dir, maxDist) {
    const hit = raycastWorld(
      this.colliders,
      origin.x, origin.y, origin.z,
      dir.x, dir.y, dir.z,
      maxDist,
      { floorY: 0 },
    );
    if (!hit) return null;
    return {
      point: new THREE.Vector3(hit.x, hit.y, hit.z),
      normal: new THREE.Vector3(hit.nx, hit.ny, hit.nz),
    };
  }

  // ============ 丢弃物品：带物理地抛在地上，且全员可见 ============

  // 丢弃第 index 个技能槽的物品：扣背包 1 件、必要时清空该槽、朝视线前方抛出并广播
  _dropSlot(index) {
    const item = this._skillMap ? this._skillMap[index] : null;
    if (!item) { this._toast('该技能槽没有可丢弃的物品'); return; }
    // 背包扣 1 件；扣到 0 则同时清空该技能槽（技能栏上也会消失）
    const left = removeFromBag(getBagKey(this._profile), item, 1);
    if (left <= 0) this._clearSlot(index);
    // 出手点：眼睛前方 0.7m；初速度：视线方向 + 一点向上 → 抛物线落地
    const s = this.localState;
    const cosP = Math.cos(s.pitch);
    const sinP = Math.sin(s.pitch);
    const dir = new THREE.Vector3(-Math.sin(s.yaw) * cosP, sinP, -Math.cos(s.yaw) * cosP);
    const start = new THREE.Vector3(s.x, s.y, s.z).addScaledVector(dir, 0.7);
    const vel = dir.clone().multiplyScalar(Config.DROP_THROW_SPEED);
    vel.y += Config.DROP_THROW_UP;
    // 全场唯一的掉落物 id：玩家 id + 本机自增序号（拾取时靠它让所有人同步移除）
    const id = (this.localState.id || 'local') + ':' + (++this._dropSeq);
    const payload = { id, item, x: start.x, y: start.y, z: start.z, vx: vel.x, vy: vel.y, vz: vel.z };
    this._spawnDrop(payload);
    this.network.sendDrop(payload); // 广播给同场其他人
    this._toast('已丢弃「' + item + '」');
  }

  // 生成一件掉落物（本地丢弃 / 远端广播共用）；各端用同一套物理复现同样的运动
  _spawnDrop(o) {
    if (!o) return;
    const item = String(o.item || '').slice(0, 24);
    const x = Number(o.x), y = Number(o.y), z = Number(o.z);
    if (!item || ![x, y, z].every(Number.isFinite)) return;
    if (this._drops.length >= Config.DROP_MAX) this._removeDrop(this._drops.shift()); // 超出上限先移除最旧的

    const R = Config.DROP_RADIUS;
    const yy = Math.max(y, R);
    if (!this._dropGeo) this._dropGeo = new THREE.BoxGeometry(R * 1.7, R * 1.7, R * 1.7);
    const color = new THREE.Color(this._itemColor(item));
    const mat = new THREE.MeshStandardMaterial({
      color, emissive: color, emissiveIntensity: 0.22, roughness: 0.55, metalness: 0.15,
    });
    const mesh = new THREE.Mesh(this._dropGeo, mat);
    mesh.position.set(x, yy, z);
    mesh.castShadow = true;
    this.scene.add(mesh);

    // 头顶名字牌（Sprite + Canvas 文字）：让所有人一眼看出丢的是什么
    const label = new THREE.Sprite(this._dropLabelMaterial(item));
    label.scale.set(1.7, 0.42, 1);
    label.position.set(x, yy + 0.78, z);
    this.scene.add(label);

    this._drops.push({
      id: String(o.id || ''),
      item, x, y: yy, z,
      vx: Number(o.vx) || 0, vy: Number(o.vy) || 0, vz: Number(o.vz) || 0,
      resting: false, life: Config.DROP_LIFETIME, mesh, label,
    });
  }

  // 物品名 → Sprite 材质（Canvas 文字贴图，按名字缓存共用；移除掉落物时不要释放它）
  _dropLabelMaterial(item) {
    let m = this._dropLabelMat.get(item);
    if (m) return m;
    let tex = this._dropLabelTex.get(item);
    if (!tex) {
      const c = document.createElement('canvas');
      c.width = 256; c.height = 64;
      const g = c.getContext('2d');
      g.fillStyle = 'rgba(11,21,34,0.72)';
      g.fillRect(0, 0, 256, 64);
      g.font = 'bold 34px sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = '#ffffff';
      g.fillText(item, 128, 34, 244);
      tex = new THREE.CanvasTexture(c);
      this._dropLabelTex.set(item, tex);
    }
    m = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
    this._dropLabelMat.set(item, m);
    return m;
  }

  // 移除一件掉落物（方块几何与名字牌材质是共用的，只释放每件自己的方块材质）
  _removeDrop(d) {
    if (!d) return;
    if (d.mesh) { this.scene.remove(d.mesh); if (d.mesh.material) d.mesh.material.dispose(); }
    if (d.label) this.scene.remove(d.label);
  }

  _clearDrops() {
    for (const d of this._drops) this._removeDrop(d);
    this._drops.length = 0;
    // 目标与按钮一并复位，避免残留一个已不在场景里的拾取目标
    this._pickupTarget = null;
    this._pickupLabel = null;
    if (this._pickupHint && this._pickupShown) { this._pickupHint.style.display = 'none'; }
    this._pickupShown = false;
  }

  // 掉落物物理：重力 → 落地弹跳 → 地面摩擦 → 静止；越界回弹；到寿命自动消失
  _updateDrops(dt) {
    if (!this._drops.length) return;
    const R = Config.DROP_RADIUS;
    const G = -24;
    // 边界：对战中用当前竞技场半边长（居中）；大厅用编辑器调出来的边界（四边可不对称）
    const H = this._arenaHalf();
    const b = this.boundary;
    const loX = this._combat ? -H + R : b.minX + R;
    const hiX = this._combat ? H - R : b.maxX - R;
    const loZ = this._combat ? -H + R : b.minZ + R;
    const hiZ = this._combat ? H - R : b.maxZ - R;
    const t = this.clock.elapsedTime;
    for (let i = this._drops.length - 1; i >= 0; i--) {
      const d = this._drops[i];
      d.life -= dt;
      if (d.life <= 0) { this._removeDrop(d); this._drops.splice(i, 1); continue; }

      if (!d.resting) {
        // 世界碰撞交给 worldQuery：地面（隐式平面 y=0）+ 盒/OBB/凸包/trimesh 全部生效，
        // 所以丢出去的物品会落在楼板、掩体、柱子顶上，也会被墙弹回来（不再穿墙掉进虚空）。
        const grounded = moveSphereWorld(this.colliders, d, dt, R, { gravity: G, floorY: 0 });
        // 世界边界回弹（对中用竞技场半边长，大厅用编辑器边界：四边各自判定）
        if (d.x > hiX) { d.x = hiX; d.vx = -Math.abs(d.vx) * 0.45; }
        else if (d.x < loX) { d.x = loX; d.vx = Math.abs(d.vx) * 0.45; }
        if (d.z > hiZ) { d.z = hiZ; d.vz = -Math.abs(d.vz) * 0.45; }
        else if (d.z < loZ) { d.z = loZ; d.vz = Math.abs(d.vz) * 0.45; }
        // 站稳了（踩到可站立面且几乎不动）→ 进入静止态，不再做碰撞解算
        if (grounded && d.vy === 0 && Math.abs(d.vx) < 0.18 && Math.abs(d.vz) < 0.18) {
          d.vx = 0; d.vz = 0; d.resting = true;
        }
        // 翻滚：水平速度越快转得越快
        const sp = Math.hypot(d.vx, d.vz);
        d.mesh.rotation.x += sp * dt * 0.9;
        d.mesh.rotation.z += sp * dt * 0.65;
      }

      d.mesh.position.set(d.x, d.y, d.z);
      d.label.position.set(d.x, d.y + 0.78 + Math.sin(t * 2 + i) * 0.04, d.z); // 名字牌轻轻浮动
    }
  }

  // 陨石模式每帧推进：房主按间隔生成，全场推进下落并结算落地伤害
  _updateMeteorMode(dt) {
    const c = this._combat;
    if (!c || c.mode !== 'meteor') return;
    if (this._roundOver) return; // 本局已判出结果：别再砸人了（结算面板后面还在死人很奇怪）

    if (c.isOwner) {
      this._meteorTimer -= dt;
      if (this._meteorTimer <= 0) {
        this._meteorTimer = Config.METEOR_INTERVAL;
        this._spawnMeteorWave();
      }
    }

    const pr = Config.PLAYER_RADIUS;
    for (let i = this._meteors.length - 1; i >= 0; i--) {
      const m = this._meteors[i];
      m.y += m.vy * dt; // vy 为负 → 下落
      m.mesh.position.set(m.x, m.y, m.z);
      m.mesh.rotation.x += dt * 2.4;
      m.mesh.rotation.y += dt * 1.7;
      if (m.y > 0) continue;
      // 落地：播爆炸 + 只对本地玩家结算伤害（环境伤害各自判定，避免重复扣血）
      this._playExplosion(new THREE.Vector3(m.x, 0.25, m.z), m.r + Config.METEOR_IMPACT_PAD, Config.METEOR_DAMAGE);
      const dx = this.localState.x - m.x;
      const dz = this.localState.z - m.z;
      if (!this._dead && Math.hypot(dx, dz) <= m.r + Config.METEOR_IMPACT_PAD + pr) {
        this._changeHealth(-Config.METEOR_DAMAGE);
        this._toast('被陨石砸中！-' + Config.METEOR_DAMAGE);
      }
      this._disposeMeteor(m);
      this._meteors.splice(i, 1);
    }
    // 状态条由 _updateMatch 每帧统一刷新，这里不再重复写
  }

  // 房主生成一波陨石：本地立即生成并广播，其他客户端收到 meteor 消息后复刻同一颗
  _spawnMeteorWave() {
    const half = Math.max(6, Config.COMBAT_ARENA_HALF - 4);
    for (let k = 0; k < Config.METEOR_PER_WAVE; k++) {
      const x = (Math.random() * 2 - 1) * half;
      const z = (Math.random() * 2 - 1) * half;
      const vy = -(Config.METEOR_SPEED_MIN + Math.random() * (Config.METEOR_SPEED_MAX - Config.METEOR_SPEED_MIN));
      const r = Config.METEOR_RADIUS_MIN + Math.random() * (Config.METEOR_RADIUS_MAX - Config.METEOR_RADIUS_MIN);
      this._spawnMeteor({ x, z, vy, r });
      this.network.sendMeteor({ x, z, vy, r });
    }
  }

  // 生成一颗陨石（本地/远端共用）：从高空落下，落地由 _updateMeteorMode 结算
  _spawnMeteor(o) {
    if (!o) return;
    const x = Number(o.x);
    const z = Number(o.z);
    const vy = Number(o.vy);
    const r = Number(o.r) || 1.5;
    if (![x, z, vy].every(Number.isFinite)) return;
    if (this._meteors.length >= Config.METEOR_MAX_ALIVE) return;

    // 共用单位几何/材质，按半径缩放：密集陨石下显著减少几何/材质分配
    if (!this._meteorGeo) this._meteorGeo = new THREE.IcosahedronGeometry(1, 0);
    if (!this._meteorMat) {
      this._meteorMat = new THREE.MeshStandardMaterial({
        color: 0x8a4a22, emissive: 0xff5a22, emissiveIntensity: 0.75, roughness: 0.7, flatShading: true,
      });
    }
    const mesh = new THREE.Mesh(this._meteorGeo, this._meteorMat);
    mesh.scale.setScalar(r);
    mesh.position.set(x, Config.METEOR_SPAWN_Y, z);
    mesh.castShadow = false; // 同屏数量多，关掉投影省一点开销
    this.scene.add(mesh);

    // 落点警戒圈：贴地发光环，半径=实际伤害范围，方便玩家预判躲避
    if (!this._warnGeo) this._warnGeo = new THREE.RingGeometry(0.8, 1, 28);
    if (!this._warnMat) {
      this._warnMat = new THREE.MeshBasicMaterial({
        color: 0xff6a2a, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false,
      });
    }
    const warnR = r + Config.METEOR_IMPACT_PAD + Config.PLAYER_RADIUS;
    const marker = new THREE.Mesh(this._warnGeo, this._warnMat);
    marker.rotation.x = -Math.PI / 2;
    marker.scale.setScalar(warnR);
    marker.position.set(x, 0.06, z);
    this.scene.add(marker);

    this._meteors.push({ x, y: Config.METEOR_SPAWN_Y, z, vy, r, mesh, marker });
  }

  // 把一颗陨石从场景摘除（几何/材质与其他陨石共用，不在这里释放）
  _disposeMeteor(m) {
    if (!m) return;
    if (m.mesh) this.scene.remove(m.mesh);
    if (m.marker) this.scene.remove(m.marker);
  }

  // 退出对战时释放共用的陨石资源（几何/材质/警戒圈）
  _disposeMeteorAssets() {
    for (const key of ['_meteorGeo', '_meteorMat', '_warnGeo', '_warnMat']) {
      const res = this[key];
      if (res && typeof res.dispose === 'function') res.dispose();
      this[key] = null;
    }
  }

  // ============ 场地边界（空气墙）============
  // 数据来自编辑器「边界」模式（随场景 JSON 保存为 boundary 字段）；没保存过就用地面范围，
  // 因此不调边界时行为和改动前完全一致。四边独立，边界不必对称于原点。

  // 收到一份边界数据就应用它；null/不认识一律保持现状（默认边界）
  _applyBoundary(raw) {
    const b = normalizeBoundary(raw);
    if (!b) return;
    this.boundary = b;
    this._syncBoundary();
    console.log('[Game] 已应用场景边界 ' + (b.maxX - b.minX).toFixed(1) + '×' + (b.maxZ - b.minZ).toFixed(1)
      + ' 米，可见墙=' + (b.showWalls ? '开' : '关'), b);
  }

  // ---------- 赛道（校园狂飙）----------
  // 应用来自编辑器「赛道」模式的赛道数据（随场景 JSON 保存为 track 字段）。
  // 没有该字段 / 解析失败 → 保持当前（默认演示赛道），行为与改动前一致。
  _applyTrack(raw) {
    const t = normalizeTrack(raw);
    if (t) this.track = t;
    this._buildTrackViz();
  }

  // 把门画进世界：两根细柱 + 横梁。几何来自 Track.gateSpecs，与编辑器预览同一份 ——
  // 编辑器里摆成什么样，游戏里就是什么样。门少于 2 个（或赛道被清空）就整组移除。
  _buildTrackViz() {
    this._applyTrackCollider(); // 路面碰撞体：先摘掉旧的，再按当前赛道重新烘一份
    if (this._trackGroup) {
      this.scene.remove(this._trackGroup);
      this._trackGroup.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      this._trackGroup = null;
    }
    const t = this.track;
    if (!isTrackRunnable(t)) return;
    const group = new THREE.Group();
    group.name = 'track-gates';
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const startMat = new THREE.MeshStandardMaterial({ color: 0x38a35c, roughness: 0.65, metalness: 0.1 });
    const gateMat = new THREE.MeshStandardMaterial({ color: 0xc9942f, roughness: 0.65, metalness: 0.1 });
    for (const sp of gateSpecs(t)) {
      const mat = sp.index === 0 ? startMat : gateMat; // 0 号门 = 起点，用绿色区分
      const g = new THREE.Group();
      g.position.set(sp.x, sp.y, sp.z);
      g.rotation.y = Math.atan2(sp.dx, sp.dz); // 本地 +X = 门的横向
      const add = (sx, sy, sz, px, py, pz) => {
        const m = new THREE.Mesh(geo, mat);
        m.scale.set(sx, sy, sz);
        m.position.set(px, py, pz);
        m.castShadow = true;
        g.add(m);
      };
      add(0.35, sp.h, 0.35, -sp.w / 2, sp.h / 2, 0); // 左柱
      add(0.35, sp.h, 0.35, sp.w / 2, sp.h / 2, 0);  // 右柱
      add(sp.w + 0.35, 0.35, 0.35, 0, sp.h, 0);      // 横梁
      group.add(g);
    }
    // 贝塞尔路面 + 中线 + 方向箭头（与编辑器预览共用同一份几何，见 world/TrackViz.js）
    group.add(buildTrackPath(t, { arrowCount: 16 }));
    // 平时收起：校园里不该杵着一条路面 + 一排门框，只有「校园狂飙」进行中才露面。
    // （编辑器那边同样是「只在赛道模式里显示」，两边口径一致。）
    group.visible = !!this._race;
    this.scene.add(group);
    this._trackGroup = group;
  }

  // 赛道可视化（路面 + 中线 + 方向箭头 + 门框）的显隐。
  // ⚠ **视觉和碰撞必须同进同出**：只藏了路面却把碰撞留着，校园里就会撞到一堵看不见的墙
  //   （用户 2026-10-03 报「没玩狂飙的时候赛道碰撞要取消掉」）。所以这里一并切碰撞体。
  _setTrackVisible(on) {
    const v = !!on;
    if (this._trackGroup) this._trackGroup.visible = v;
    this._syncTrackCollider(v);
  }

  // 把缓存好的那块赛道碰撞体加进 / 移出世界碰撞体。
  // 原地改写数组（splice/push）：LocalPlayer 持有的是同一条数组引用，换数组它读不到。
  _syncTrackCollider(on) {
    const c = this._trackCollider;
    if (!c) return;
    const i = this.colliders.indexOf(c);
    if (on) {
      if (i < 0) this.colliders.push(c);
    } else if (i >= 0) {
      this.colliders.splice(i, 1);
    }
    // 增删后通知宽相位重建（跑狂飙时路面碰撞体是 trimesh，但 simples 侧同样会因增删而错位）
    if (this.localPlayer) this.localPlayer.markCollidersDirty();
  }

  // 赛道路面的碰撞体：把「与视觉路面同一条曲线、同半宽」的实体板烘成 trimesh 缓存起来。
  // 于是门被抬高时（立体赛道），玩家/车能真的开上去、也能被路沿挡住，而不是穿过去。
  // 重建赛道（编辑器保存后拉到新场景）时先摘掉旧的；**平时不挂进世界**，只有跑狂飙时才挂上。
  _applyTrackCollider() {
    if (this._trackCollider) {
      const i = this.colliders.indexOf(this._trackCollider);
      if (i >= 0) this.colliders.splice(i, 1);
      this._trackCollider = null;
      // 立刻通知：下面「赛道不可跑」会提前 return，来不及走到 _syncTrackCollider 那一句
      if (this.localPlayer) this.localPlayer.markCollidersDirty();
    }
    const t = this.track;
    if (!isTrackRunnable(t)) return;
    const mesh = buildTrackCollision(t);
    if (!mesh) return;
    const col = bakeTriMesh(mesh); // 顶点已是世界坐标（mesh 自身无变换），可直接烘
    mesh.geometry.dispose();       // 碰撞体内部已复制三角形，渲染几何没用了
    if (!col) return;
    this._trackCollider = col;
    this._syncTrackCollider(!!this._race); // 烘好先缓存着；要不要生效看现在有没有在跑狂飙
  }

  // 边界要同步到两处：① 物理夹取（真正挡人的是它）② 可选的可视半透明墙。
  // 对战模式用的是独立竞技场，边界必须临时让位，否则场地变小后会把玩家夹在竞技场外。
  _syncBoundary() {
    const b = this.boundary;
    const active = this._combat ? null : b;
    if (this.localPlayer && this.localPlayer.physics) this.localPlayer.physics.bound = active;
    this._rebuildBoundaryWalls(active);
  }

  // 可见墙：只有 showWalls 打开才建；几何来自 Boundary.boundaryWallSpecs（与编辑器预览同一份）。
  // 材质全场共用一份，避免反复创建。
  _boundaryWallMaterial() {
    if (!this._boundaryWallMat) {
      this._boundaryWallMat = new THREE.MeshStandardMaterial({
        color: Config.WALL_COLOR,
        transparent: true,
        opacity: Config.WALL_OPACITY,
        side: THREE.DoubleSide,
        depthWrite: false, // 半透明墙不写深度，免得挡住后面的东西出现硬边
      });
    }
    return this._boundaryWallMat;
  }

  _rebuildBoundaryWalls(b) {
    if (!this._boundaryWalls) {
      this._boundaryWalls = new THREE.Group();
      this._boundaryWalls.name = 'boundary-walls';
      this.scene.add(this._boundaryWalls);
    }
    const g = this._boundaryWalls;
    while (g.children.length) {
      const ch = g.children.pop();
      if (ch.geometry) ch.geometry.dispose(); // 材质共用，等整组销毁时再释放
    }
    if (!b || !b.showWalls) { g.visible = false; return; }
    const mat = this._boundaryWallMaterial();
    const h = b.wallHeight;
    for (const sp of boundaryWallSpecs(b, BOUNDARY_THICKNESS)) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(sp.hx * 2, h, sp.hz * 2), mat);
      mesh.position.set(sp.cx, h / 2, sp.cz); // 底面贴地
      mesh.rotation.y = sp.rotY;
      g.add(mesh);
    }
    g.visible = true;
  }

  // ============ 疯狂抓钩：金币（房主生成、全员可见、被吃即同步消失）+ 底部岩浆 ============

  // 当前场景的边界半边长（掉落物回弹、越界判断用）
  _arenaHalf() {
    if (this._combat && this._combat.mode === 'grapple') return Config.GRAPPLE_ARENA_HALF;
    return Config.COMBAT_ARENA_HALF;
  }

  // 金币的几何/材质全场共用一套（生成频率高，不能每枚新建）
  _ensureCoinAssets() {
    if (!this._coinGeo) this._coinGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.08, 16);
    if (!this._coinMat) {
      this._coinMat = new THREE.MeshStandardMaterial({
        color: 0xffd24a, emissive: 0xffa726, emissiveIntensity: 0.95, metalness: 0.75, roughness: 0.26,
      });
    }
  }

  _disposeCoinAssets() {
    for (const k of ['_coinGeo', '_coinMat']) {
      const r = this[k];
      if (r && typeof r.dispose === 'function') r.dispose();
      this[k] = null;
    }
  }

  // 生成一枚金币（房主本地 / 收到广播的远端共用）
  _spawnCoin(o) {
    if (!o) return;
    const id = String(o.id || '');
    const x = Number(o.x);
    const y = Number(o.y);
    const z = Number(o.z);
    if (!id || ![x, y, z].every(Number.isFinite)) return;
    if (this._coins.some((c) => c.id === id)) return; // 幂等：重复广播不重复生成
    if (this._coins.length >= Config.GRAPPLE_COIN_MAX) this._removeCoin(this._coins.shift());
    this._ensureCoinAssets();
    const mesh = new THREE.Mesh(this._coinGeo, this._coinMat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    this.scene.add(mesh);
    this._coins.push({ id, x, y, z, mesh, life: Config.GRAPPLE_COIN_LIFETIME });
  }

  // 金币几何/材质是共用的，这里只把它从场景摘下来
  _removeCoin(c) {
    if (c && c.mesh) this.scene.remove(c.mesh);
  }

  _clearCoins() {
    for (const c of this._coins) this._removeCoin(c);
    this._coins.length = 0;
    this._disposeCoinAssets();
  }

  // 房主生成一波金币：落在随机柱子顶上方一点（位置广播给全场，各端用同一坐标复现）
  _spawnCoinWave() {
    const tops = this._arena && this._arena.tops;
    if (!tops || !tops.length) return;
    for (let i = 0; i < Config.GRAPPLE_COIN_PER_WAVE; i++) {
      const t = tops[Math.floor(Math.random() * tops.length)];
      const id = (this.localState.id || 'local') + 'c' + (++this._coinSeq);
      const o = { id, x: t.x, y: t.y + 1.9, z: t.z };
      this._spawnCoin(o);
      this.network.sendCoinSpawn(o);
    }
  }

  // 每帧：房主补币 / 岩浆判负 / 金币旋转与拾取
  _updateCoinMode(dt) {
    const c = this._combat;
    if (!c || c.mode !== 'grapple') return;
    if (this._roundOver) return; // 本局已判出结果：停手（金币已清空）

    if (c.isOwner) {
      this._coinTimer -= dt;
      if (this._coinTimer <= 0) {
        this._coinTimer = Config.GRAPPLE_COIN_INTERVAL;
        this._spawnCoinWave();
      }
    }

    // 岩浆：物理地面就在 y=0，脚一踩到地面（而不是柱顶）就说明落进岩浆了
    if (!this._dead) {
      const feet = this.localState.y - Config.PLAYER_HEIGHT * this.localPlayer.physics.sizeScale;
      if (feet <= 0.08) {
        this._endGrapple();
        this._toast('掉进岩浆了！');
        this._changeHealth(-Config.GRAPPLE_MAGMA_DAMAGE);
        return; // 本帧后续不用再判金币了
      }
    }

    if (!this._coins.length) return;
    const s = this.localState;
    const body = s.y - Config.PLAYER_HEIGHT * this.localPlayer.physics.sizeScale * 0.5; // 身体中点
    const t = this.clock.elapsedTime;
    for (let i = this._coins.length - 1; i >= 0; i--) {
      const cn = this._coins[i];
      cn.life -= dt;
      if (cn.mesh) {
        cn.mesh.rotation.y += dt * 2.4;
        cn.mesh.position.y = cn.y + Math.sin(t * 2 + i) * 0.12; // 轻轻上下浮动
      }
      if (cn.life <= 0) { this._removeCoin(cn); this._coins.splice(i, 1); continue; }
      if (this._dead) continue;
      const d = Math.hypot(s.x - cn.x, body - cn.y, s.z - cn.z);
      if (d <= Config.GRAPPLE_COIN_RADIUS + Config.PLAYER_RADIUS) {
        this._removeCoin(cn);
        this._coins.splice(i, 1);
        this._coinCount++;
        // 自己吃到的金币，别的客户端会通过 coin 广播里带的 from 记到我头上，自己这边得自己记
        const mine = this._matchStats.get(String(this.localState.id));
        if (mine) mine.coins++;
        this.network.sendCoinTaken(cn.id); // 让其他人也看到这枚被吃掉了
        this._toast('吃到金币！×' + this._coinCount);
      }
    }
  }

  // 别人吃掉了金币：本地移除同一枚
  _removeCoinById(id) {
    if (!id) return;
    const i = this._coins.findIndex((c) => c.id === id);
    if (i >= 0) {
      this._removeCoin(this._coins[i]);
      this._coins.splice(i, 1);
    }
  }

  _loop() {
    this._raf = requestAnimationFrame(() => this._loop());

    // 计算本帧时间间隔；clamp 到 MAX_DELTA_TIME，防止切后台恢复时瞬间跳帧导致角色瞬移
    const dt = Math.min(this.clock.getDelta(), Config.MAX_DELTA_TIME);
    const _pt0 = this._perf ? performance.now() : 0; // 性能 HUD 采样起点（关闭时零开销）

    // 昼夜循环：先更新太阳角度与光照，后面阴影定位要用到最新的 _sunOffset
    this._updateDayNight(dt);
    this._updateFlashlight(); // 手电筒每帧跟随相机视线（含俯仰）

    // 控制枪：抢在玩家更新之前处理，这样挣脱输入能先消费掉空格、
    // 且被控侧的 velocityHold 能在本次物理里生效
    this._updateCtrl(dt);

    // 更新玩家逻辑（本地玩家 + 远程玩家插值）
    // 灵魂出窍时冻结肉身：跳过本地玩家更新，鼠标/键位交给灵魂相机
    const _pt1 = this._perf ? performance.now() : 0;
    if (!this._soul) this.localPlayer.update(dt);
    const _pt2 = this._perf ? performance.now() : 0; // 物理（含 trimesh 解算）耗时
    this.playerManager.update(dt);
    // 建造模式：对准高亮 + 编辑中的家具跟随准星（在相机/玩家更新之后跑）
    if (this._buildTool) this._buildTool.update();
    // 骨骼动画：本机 + 远端所有玩家模型的待机/走/跑（内部按帧间位移算速度、不可见的跳过）
    tickPlayerModels(dt);

    // 主世界（城市）专属系统：对战中整组跳过，避免城市 NPC/Boss/载具与竞技场互串
    if (!this._combat) {
      // 电动车：摆放车体、钉住后座、刷新上下车提示（必须在玩家更新之后）
      this._updateVehicle(dt);
      this._updateRace(); // 校园狂飙：按顺序过门计圈（不在对战中才跑）
      // AI 商人 NPC：靠近提示 + 可拾取道具的推进
      this.aiNpc.update(dt, this.localState.x, this.localState.z);
      this._updatePickups(dt);
      // 商人小满：靠近显隐「找小满买东西」按钮
      this._updateMerchant(dt);
      // 传送门 / 老师 Boss：倒计时、追击、弹幕与 UI
      this._updateBoss(dt);
      // 超级激光的追踪导弹（只在 Boss 战里有意义）
      this._updateMissiles(dt);
    }

    // 对战模式：房主生成陨石 + 全场陨石下落/落地伤害（内部自带守卫，非对战时直接返回）
    this._updateMeteorMode(dt);

    // 棍子挥动动画与命中结算（对战中同样可用：混战武器）
    this._updateClub(dt);
    // 黑洞：长大与吸人
    this._updateHoles(dt);
    // 加特林：散热、持续开火、弹道线
    this._updateGatling(dt);
    // 捉迷藏：方块跟人走、方向提示、抓到判定
    this._updateMorphs();
    this._updateHideReport(dt);

    // 投掷物：推进飞行、命中/落地后结算范围伤害
    this._updateProjectiles(dt);
    // 掉落物（丢弃的物品）：重力/弹跳/摩擦推进
    this._updateDrops(dt);
    // 掉落物的「拾取」按钮：靠近才出现（必须放在位置推进之后，用最新坐标判断）
    this._updatePickupHint();
    // 柱顶光点：呼吸 + 瞄准高亮（给「按攻击能飞过去」的反馈）
    this._updateBeacons();
    // 准星与攻击键：瞄中光点时变亮（必须在 _updateBeacons 之后，读它算出的 _beaconAimed）
    this._updateAimUI();
    // 抓钩：钩爪飞行 + 拽人（必须放在玩家物理更新之后，用最新的自身坐标算方向）
    this._updateGrapple(dt);
    // 别人的抓钩：绳索两端每帧重画（终点跟着各自的模型走）
    this._updateRemoteGrapples(dt);
    // 别人的加特林：开火后的一小段时间内让他手里的枪管转起来
    this._spinRemoteGuns(dt);
    // 疯狂抓钩：房主生成金币、全场吃金币、掉进岩浆判负
    this._updateCoinMode(dt);
    // 爆炸特效：推进动画
    this._updateFX(dt);

    // 调试骨骼可视化：驱动待机姿态并绘制骨架/坐标轴
    if (this.debugRig) this.debugRig.update(); // 只挂骨骼辅助线，动画由 tickPlayerModels 驱动

    // 训练场：等服务端开房；超时就退回本机单人（老服务端也能用，别让人干等）
    if (this._trainPending) {
      this._trainTimer -= dt;
      if (this._trainTimer <= 0) {
        const mode = this._trainPending;
        this._toast('服务端没有响应，改为本机单人训练场');
        this._startTrainingLocal(mode);
      }
    }

    // 输赢判定：每帧看一次（人数/血量/时间任一变化都可能让这局结束）
    if (this._combat) this._updateMatch();

    // 观战相机：死亡后没退房，视角跟着还在场的玩家走（放在相机分支里统一处理）

    // 视角优先级：灵魂出窍（自由飞行） > 观战（跟目标） > 第三人称 > 第一人称
    if (this._soul) {
      this._updateSoul(dt);       // 自由飞行并驱动相机
      this._updateSoulBody();     // 肉身显示在被冻结的位置
      this.localPlayer.bobEnabled = false;
    } else if (this._spectate) {
      // 观战：自己的肉身留在原地（已经死了），相机跟着目标玩家走
      this._updateSpectate();
      this.localPlayer.bobEnabled = false;
    } else if (this.thirdPerson) {
      // 捉迷藏变成方块时，第三人称下显示方块而不是人形
      this.playerManager.setLocalVisible(!this._morphs.has(this.localState.id));
      this.localPlayer.bobEnabled = false; // 第三人称不做头部晃动
      this._thirdPerson(dt);
    } else {
      this.playerManager.setLocalVisible(false);
      this.localPlayer.bobEnabled = true; // 第一人称开启走路晃动
    }

    // ---- 5.2 阴影跟随玩家：把阴影焦点按「像素世界尺寸」取整到网格再贴，阳光随相对偏移平移，光向不变 ----
    // 直接每帧亚像素级移动焦点会让阴影贴图来回平移，投影出现「泳动/抖动」；
    // 取整到整 texel 让贴图每次只整体移一格，画面稳定不抖。
    const st = this._sunTarget;
    const sc = this._sun.shadow.camera;
    const R = (sc.right - sc.left) / 2;
    const texel = (R * 2) / this._sun.shadow.mapSize.x; // 单个阴影 texel 对应的世界尺寸
    st.position.set(
      Math.round(this.localState.x / texel) * texel,
      0,
      Math.round(this.localState.z / texel) * texel
    );
    this._sun.position.copy(st.position).add(this._sunOffset);
    st.updateMatrixWorld();

    // 上报本地状态（内部按 20Hz 节流）；带上当前体型倍率，供其他玩家看到放大/缩小
    this.localState.size = this.localPlayer.physics.sizeScale;
    // 上报当前手持武器（棍子/加特林），让其他玩家把武器挂到我们模型的手部锚点上
    this.localState.wep = this._heldWeaponKind();
    // 后座乘客的位置之后全由驾驶员统一代报（避免两份位置互相打架、相对车身乱抖）；
    // 只在刚上车的短窗口内自报几次，让服务器知道「有人坐上后座」，驾驶员才好接手代报。
    if (this.localState.ride !== 2) {
      this.network.sendState(this.localState.toJSON());
    } else if (this._vehPaxResend > 0) {
      this._vehPaxResend -= dt;
      this.network.sendState(this.localState.toJSON());
    }

    // 渲染当前帧
    // 阴影每 3 帧重渲：autoUpdate 已关，这里每 3 帧置一次 needsUpdate。
    // 改 2→3 的依据（见 fpm-perf-20261006-102317.json）：基线帧在 50/67ms 间交替，
    //   那批 67ms 巨帧正是阴影重渲帧（每 2 帧一次 → 半数帧吃 +17ms）。
    //   改每 3 帧后只有 1/3 帧付这笔开销，稳态平均帧耗时下降、且仍属填充率红利范畴；
    //   阴影在 20fps 下最多滞后 2 帧（~100ms）、60fps 下 ~20Hz，均不可感知。
    //   阴影总开关关着时压根不置位（shadowMap.enabled=false 时本就不渲染，但省掉一次状态写）。
    this._shadowTick = (this._shadowTick + 1) % 3;
    this.renderer.shadowMap.needsUpdate = this._shadowOn && this._shadowTick === 0;
    const _pt3 = this._perf ? performance.now() : 0;
    // 超分：分辨率被压低时，先渲进低分辨率 RT，再用锐化着色器放大到屏幕
    this._renderFrame();
    // 距离分级材质 LOD：每 6 帧评估一次（内部节流），远处换廉价副本砍片元成本
    this._updateLod(this.camera.position);

    // 自适应分辨率（始终生效，不依赖 ?perf）：每 0.5s 用真实帧率判一次，
    // 掉到 42 以下就降分辨率、回到 54 以上才升回（迟滞防横跳），让弱卡自动保住帧率。
    this._fpsAcc += dt; this._fpsN++;
    if (this._fpsAcc >= 0.5) {
      const fps = this._fpsN / this._fpsAcc;
      this._fpsAcc = 0; this._fpsN = 0;
      this._adaptResolution(fps);
      this._updateFpsBadge(fps); // 复用同一份帧率，零额外采样
    }

    // 性能 HUD（#perf）：把一帧拆成 物理 / 渲染 / 其他 三段，每 0.25s 刷一次
    if (this._perf) {
      const now = performance.now();
      this._updatePerfHud(dt, _pt2 - _pt1, now - _pt3, now - _pt0);
    }

    // 数据采集：正在采样时每帧喂一次（未采样时 sampleFrame 内部立刻 return，零开销）
    sampleFrame(dt, this);
  }

  // 自动上报开关是否生效（?tel=0 强制关、?tel=1 强制开、否则看持久化键，见 main.js）。
  _telemetryAutoEnabled() { return telemetryAutoGet(); }

  // 进游戏稳定几秒后自动跑一次采集（8 秒延迟，和原 ?tel=1 行为一致）。
  _scheduleTelemetry() {
    if (this._telRunning) return;
    setTimeout(() => { try { this._runTelemetry(); } catch (e) { /* 忽略 */ } }, 8000);
  }

  // ---- 数据采集（设置面板「数据采集」按钮 / ?tel=1）----
  // 采集约 TELEMETRY_SECONDS 秒的帧率与渲染量，连同加载各阶段耗时、设备信息上报服务端。
  // 设计要点：① 不阻塞游玩（采样在主循环里顺手做，不进 while 死等）；
  //   ② 失败不抛、只 toast（采集绝不能影响正常游戏）；
  //   ③ 同一时间只跑一次（重复点直接忽略并提示）。
  async _runTelemetry() {
    if (this._telRunning) { this._toast('正在采集中，请稍候…'); return; }
    this._telRunning = true;
    const secs = Config.TELEMETRY_SECONDS || 20;
    this._toast('开始采集：请像平时一样玩 ' + secs + ' 秒（测帧率中）…');
    try {
      startRenderSample(this, secs);
      const summary = await waitRenderSample();
      const res = await reportTelemetry({
        msaa: !!this._aaOn,
        renderScale: summary ? summary.avgScale : (this._dynScale || 1),
        shadow: !!this._shadowOn,
        quality: this._quality || null,
        gpu: (typeof this._gpuName === 'function') ? this._gpuName() : '',
        colliders: Array.isArray(this.colliders) ? this.colliders.length : null,
        players: (this.playerManager && this.playerManager.players)
          ? (this.playerManager.players.size || this.playerManager.players.length || 0) : 0,
      });
      if (res && res.ok) {
        const fps = summary ? summary.avgFps : '--';
        this._toast('采集完成，已上报（平均 ' + fps + ' FPS）。感谢反馈！');
      } else {
        this._toast('采集完成，但上报失败：' + ((res && res.error) || '未知错误'));
      }
    } catch (e) {
      this._toast('采集出错：' + String((e && e.message) || e));
    } finally {
      this._telRunning = false;
    }
  }
}