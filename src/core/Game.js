// 职责：游戏主类，负责装配三大件（渲染器/场景/相机）、输入、玩家，并驱动主循环。
import * as THREE from 'three';
import { Config, API_BASE } from '../config.js';
import { buildScenery } from '../world/buildScenery.js';
import { createTimeSky } from '../world/SkyBox.js';
import { createLights } from '../world/Lights.js';
import { createSettingsPanel, loadSettings, computeSunOffset } from '../ui/SettingsPanel.js';
import { createPlayerHUD } from '../ui/PlayerHUD.js';
import { createNpcChat } from '../ui/NpcChat.js';
import { createAiNpc } from '../world/AiNpc.js';
import { createVehicle } from '../world/Vehicle.js';
import { createTeacherBoss } from '../world/TeacherBoss.js';
import { createMerchant } from '../world/Merchant.js';
import { createShopPanel } from '../ui/ShopPanel.js';
import { loadWallet, buyItem, rewardBossKill, redeemCode } from '../player/Shop.js';
import { buildEditorBuildings, buildEditorLights, fetchRemoteScene, setEditorSceneVisible } from '../world/EditorBuildings.js';
import { buildArena } from '../world/CombatArena.js';
import { projectileHitsWorld } from '../world/collision/projectileHit.js';
import { Input } from '../core/Input.js';
import { PlayerManager } from '../player/PlayerManager.js';
import { PlayerState } from '../player/PlayerState.js';
import { LocalPlayer } from '../player/LocalPlayer.js';
import { setModelScale, setHeldItem, setNameTagsVisible, setHealthBarsVisible, createHeldWeapon } from '../player/PlayerModel.js';
import { getBagKey, addToBag, loadBag, removeFromBag } from '../player/Inventory.js';
import { createSkillSlots, SLOT_COUNT } from '../ui/SkillSlots.js';
import { Network } from '../net/Network.js';
import { addDebugRig } from '../debug/SkeletonDebug.js';
import { setBgmVolume } from '../audio/Bgm.js';
import { ensureTheme } from '../ui/theme.js';

// 在线同步辅助：拉取后端最新场景，成功则用其重建场景建筑并写入同一份碰撞体数组。
// target 必须是 LocalPlayer 持有的那条共享数组：buildEditorBuildings 会把同步碰撞体与
// 异步烘焙出的 trimesh 都 push 进这个引用，否则异步结果会落进一个没人读的临时数组。
async function _fetchRemoteScene(scene, roots, target) {
  const data = await fetchRemoteScene();
  if (!data) return; // 拉取失败：保持打包的 editorMapData 兜底
  try {
    target.length = 0;
    buildEditorBuildings(scene, roots, data, target);
    buildEditorLights(scene, data); // 远端光源覆盖打包数据；函数内部会先清掉上一次的光源，不会重复叠加
  } catch (e) {
    console.warn('[Game] 应用远程场景失败，回退打包数据:', e);
  }
}

// 老师 Boss 的阶段名（1 起，索引 0 占位）
const BOSS_PHASE_NAMES = ['', '一阶段', '二阶段', '三阶段'];

// 圆锥几何默认朝 +Y，制导导弹用它转到飞行方向
const UP_Y = new THREE.Vector3(0, 1, 0);

export class Game {
  // 与服务器一致的昼夜周期（秒）：联机时以服务器权威时间为准，这里用于两次快照之间的外推
  static SYNC_DAY_SECONDS = 240;

  // token：登录会话 token（游客为空串）；profile：登录成功返回的用户资料（点名牌用）
  constructor(token = '', profile = null) {
    this._token = token;
    this._profile = profile;
    this._placed = false; // 是否已用服务端出生点定位过（断线重连不再重定位，避免被拉回出生点）

    // UI 主题：注入 Kenney UI 样式表，必须在任何 UI 元素创建之前完成
    ensureTheme();

    // ---- 渲染器 ----
    this._qualityDpr = 2; // 画质档可调的 dpr 封顶：high=2 / mid=1.5 / low=1（默认 2，quality='mid' 时由 _applyQuality 降到 1.5）
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    // dpr 封顶：iPhone 的 dpr=3，按 3 渲染像素量翻倍；且缩放导致 dpr 变化时
    // 会反复触发 canvas 重算（掉帧/抖动的隐藏来源）
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this._qualityDpr));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    document.getElementById('app').appendChild(this.renderer.domElement);

    // ---- 场景与相机 ----
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x87ceeb); // 天空浅蓝（兜底，时段天空球壳覆盖其上）
    // 时段天空盒：清晨/白天/夜晚/深夜四张全景图，按世界时刻交叉淡入（内部含程序化天空兜底）
    this._timeSky = createTimeSky(this.scene);

    const aspect = window.innerWidth / window.innerHeight;
    this.camera = new THREE.PerspectiveCamera(70, aspect, 0.1, 500);
    this.camera.rotation.order = 'YXZ';

    // ---- 静态世界（地面/道路/墙体 + 道具），返回统一的可编辑根列表 ----
    const roots = buildScenery(this.scene);
    this._cityRoots = roots; // 进入对战时整组隐藏（换成竞技场），退出再整组恢复
    // 灯光单独挂载（不作为可编辑景物）；阴影聚焦目标随玩家移动
    const lights = createLights();
    this.scene.add(lights.group);
    this._sunTarget = lights.sunTarget;
    this._sunOffset = lights.offset;
    this._sun = lights.sun;
    this._ambient = lights.ambient; // 供画面面板绑定；游戏端不透出强度调整
    this._hemi = lights.hemi;

    // 应用编辑器保存的「光照设计」：环境光/半球光/阳光强度、阳光角度，使客户端与编辑器保持一致；
    // 若编辑器从未保存过，则自动落到 DEFAULT_SETTINGS 的默认值。
    const design = loadSettings('scene-settings-v1');
    this._ambient.intensity = design.ambient;
    this._hemi.intensity = design.hemi;
    this._sun.intensity = design.sun;
    const dOff = computeSunOffset(design.sunElev, design.sunAz);
    this._sunOffset.set(dOff.x, dOff.y, dOff.z);

    // ---- 昼夜循环：以编辑器保存的光照设计作为「正午」基准，随时刻连续变化 ----
    const gset = loadSettings('scene-settings-game-v1');
    this._dayEnabled = gset.dayNight !== undefined ? !!gset.dayNight : true;
    this._dayCycle = Math.max(30, Number(gset.dayCycle) || 240);
    this._dayTime = Config.DAY_START;
    this._dayBaseSun = design.sun;
    this._dayBaseAmbient = design.ambient;
    this._dayBaseHemi = design.hemi;
    this._dayAzDeg = design.sunAz;
    // 服务器时间同步：快照里带世界时刻，收到后以此为基准帧间外推，保证所有客户端时间一致
    this._netDayTime = null;
    this._netDayAt = 0;
    this._hudTimeText = '';
    // 本地时刻偏移（小时→一天比例）：只用于本地预览（想马上看夜晚就拖它），不参与联机同步
    this._dayOffset = (Number(gset.dayOffset) || 0) / 24;

    // ---- 编辑器开发的地图：import src/world/editorMapData.js 渲染保存的建筑 ----
    this.colliders = buildEditorBuildings(this.scene, roots);
    buildEditorLights(this.scene); // 编辑器保存的点光源 / 面光源（用打包数据）

    // 在线同步：运行时从后端拉取最新场景（编辑器保存的那份），拉到则替换打包数据重建。
    // 拉取失败会自动回退到上面打包的 editorMapData，保证离线时也有内容。
    // 注意：LocalPlayer 持有 this.colliders 的同一条数组引用，因此原地改写而不是整体替换。
    _fetchRemoteScene(this.scene, roots, this.colliders);

    // ---- 输入 ----
    this.input = new Input();
    this.input.setCanvas(this.renderer.domElement);

    // ---- 玩家管理器：维护所有玩家（本地 + 远程） ----
    // 本地玩家的真实 id 在收到服务器 welcome 时才确定，先前保持 null
    this.playerManager = new PlayerManager(this.scene);

    // 本地玩家的可序列化状态（id 稍后由 welcome 消息填充）
    this.localState = new PlayerState('', 0, Config.PLAYER_HEIGHT, 0);

    // 本地玩家逻辑
    this.localPlayer = new LocalPlayer(this.camera, this.input, this.localState, this.colliders);

    // ---- 网络连接 ----
    this.network = new Network(Config.RELAY_URL, this._token);
    this.network.onMessage((msg) => this._onNetworkMessage(msg));
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

    // ---- 窗口尺寸自适应 ----
    window.addEventListener('resize', () => this._onResize());

    // ---- 画面设置面板（游戏端）：只开放视距 + 阴影等图形项，不开放光照强度 ----
    this.settingsPanel = createSettingsPanel(
      {
        viewFar: (v) => {
          this.camera.far = v;
          this.camera.updateProjectionMatrix();
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
          this.renderer.shadowMap.enabled = !!v;
          this._sun.castShadow = !!v;
        },
        nameTag: (v) => {
          setNameTagsVisible(v);   // 玩家头顶名牌总开关
          setHealthBarsVisible(v); // 血条跟着一起开关
        },
        dayNight: (v) => { this._dayEnabled = !!v; }, // 昼夜循环开关
        dayCycle: (v) => { this._dayCycle = Math.max(30, Number(v) || 240); }, // 一昼夜秒数
        bgmVolume: (v) => setBgmVolume(v), // 背景音乐音量（0 = 静音）
        dayOffset: (v) => { this._dayOffset = (Number(v) || 0) / 24; }, // 本地时刻偏移（小时→一天比例）
        quality: (v) => this._applyQuality(v), // 画质档：聚合控制阴影分辨率 / dpr 封顶 / 阴影类型
      },
      {
        fields: ['quality', 'viewFar', 'shadowR', 'shadowSize', 'castShadow', 'nameTag', 'dayNight', 'dayCycle', 'bgmVolume', 'dayOffset'],
        storeKey: 'scene-settings-game-v1',
      }
    );
    // 设置入口统一在顶部校卡右侧的「设置」按钮，不再额外挂悬浮齿轮（旧按钮定位与顶部重复）

    // 顶部校卡：显示当前账号名字，点击展开查看详情，并可在卡内退出登录
    this.playerHUD = createPlayerHUD(this._profile, !!this._token);
    // 顶部校卡两侧：左侧「背包」、右侧「设置」
    this._createTopButtons();

    // ---- AI 商人 NPC：出生点旁喷泉处的阿花，靠近按 F 或点右侧选项卡打开对话栏 ----
    this.aiChat = createNpcChat();
    this.aiChat.setOnSend((text) => this._npcSend(text));
    this.aiChat.setOnOpen(() => { this._setChatLock(true); });
    this.aiChat.setOnClose(() => { this._setChatLock(false); });
    this.aiNpc = createAiNpc();
    this.aiNpc.setInteract(() => this._openChat());
    this.scene.add(this.aiNpc.group);
    // 屏幕中心右侧的「与阿花对话」选项卡：仅在靠近阿花时显示，点击开/关对话栏
    this._createChatTab();
    this.aiNpc.onRange((r) => { this._chatTab.style.display = r ? '' : 'none'; });

    // ---- 电动车：双人载具，停在出生点旁的 (-7, 144) ----
    this.vehicle = createVehicle(this.scene);
    this._vehDriver = null; // 后座时记住驾驶员的玩家 id
    this._vehPaxResend = 0; // 刚坐上后座时的上报重发窗口（秒）：让服务器尽快知道有乘客，好让驾驶员开始代报
    // 触屏不显示按键提示，桌面端补上 "(F)"
    const coarsePointer =
      (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
      'ontouchstart' in window;
    this._vehKeyHint = coarsePointer ? '' : (' (' + Config.VEHICLE_KEY.slice(-1) + ')');
    this._vehHint = this._createVehicleHint();
    window.addEventListener('keydown', (e) => {
      if (e.code !== Config.VEHICLE_KEY) return;
      if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) return;
      if (this.aiChat && this.aiChat.isOpen()) return; // 对话中不响应
      this._toggleVehicle();
    });

    // 技能槽：阿花给的物品在此变为可点/可按数字键触发的技能；恢复上次指定的槽位
    this.skillSlots = createSkillSlots();
    this._skillMap = this._loadSkillSlots();
    this._restoreSkills();

    // ---- 传送门与「老师」Boss：位于 (11,142)，靠近点「召唤老师」10 秒后出现 ----
    // 三阶段：一阶段弹幕 → 白光+世界变红 → 二阶段旋转激光（跳着躲）→ 三阶段高激光（手动开护盾挡）
    this.boss = createTeacherBoss(this.scene);
    this.boss.setOnEvent((msg) => this.network.sendBoss(msg));
    this.boss.setOnLocalDamage((dmg) => this._changeHealth(-dmg));
    this.boss.setOnLocalKill(() => { if (!this._dead) this._changeHealth(-Config.HEALTH_MAX * 2); });
    this.boss.setOnPhase((kind, ph) => this._onBossPhase(kind, ph));
    this.boss.setOnStatus(() => this._updateBossUI());
    this._portalHint = this._createPortalHint();
    this._attackBtn = this._createAttackButton();
    this._shieldBtn = this._createShieldButton();
    this._bossBar = this._createBossBar();
    this._redOverlay = this._createRedOverlay();
    this._flashEl = this._createFlashOverlay();
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
    this._shieldMesh = new THREE.Mesh(
      new THREE.SphereGeometry(1.15, 20, 14),
      new THREE.MeshBasicMaterial({
        color: 0x7fe3ff, transparent: true, opacity: 0.3,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      })
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
    this.merchant.onRange((r) => { this._merchantNear = !!r; });
    this.shop = createShopPanel({
      onBuy: (id) => this._buyShopItem(id),
      onRedeem: (code) => this._redeemCode(code),
    });
    this.shop.setState(() => loadWallet(this._profile));
    this._coinBadge = this._createCoinBadge();
    this._refreshCoins();

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
    this._bullets = [];             // 在飞的子弹（只做视觉，命中是瞬时判定）
    this._bulletGeo = new THREE.SphereGeometry(0.08, 8, 6);
    this._bulletMat = new THREE.MeshBasicMaterial({ color: 0xffd76a });

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
      if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) return;
      if (this.aiChat && this.aiChat.isOpen()) return;
      this._activateShield();
    });

    // 灵魂出窍：P 键切换（肉身留在原地，视角脱离身体自由飞行）
    window.addEventListener('keydown', (e) => {
      if (e.code !== Config.SOUL_KEY) return;
      if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) return;
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
    this._pendingCombatExit = false; // 对战中被击倒 → 下一帧统一退房（避免在伤害循环里改状态）
    this._failEl = null;        // 屏幕中央「失败」字样（非弹窗）
    this._soul = null;          // P 键灵魂出窍：{ x, y, z, yaw, pitch }，null 表示未出窍
  }

  // 左下角血量条：数值 + 横条，满血绿色、越低越红
  _createHealthBar() {
    const box = document.createElement('div');
    box.className = 'hp-box'; // 供手机端「按键布局调整」定位与检查
    box.style.cssText =
      'position:fixed;left:18px;bottom:22px;z-index:53;width:min(240px,42vw);' +
      'font:12px/1.3 var(--kui-font);color:var(--kui-paper);user-select:none;pointer-events:none;';
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;justify-content:space-between;margin-bottom:4px;text-shadow:0 1px 3px rgba(0,0,0,.6);';
    const label = document.createElement('span');
    label.textContent = '生命';
    const num = document.createElement('span');
    num.textContent = Config.HEALTH_MAX + ' / ' + Config.HEALTH_MAX;
    row.appendChild(label);
    row.appendChild(num);
    // 进度条外观交给主题类；高度仍用内联保持原尺寸，填充色由 _updateHealthBar 按血量动态写入
    const track = document.createElement('div');
    track.className = 'kui-bar';
    track.style.cssText = 'height:10px;';
    const fill = document.createElement('div');
    fill.className = 'kui-bar__fill';
    fill.style.cssText = 'width:100%;background:#2ecc71;transition:width .18s ease,background .18s ease;';
    track.appendChild(fill);
    box.appendChild(row);
    box.appendChild(track);
    document.body.appendChild(box);
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
    this._hpFill.style.background = ratio > 0.5 ? '#2ecc71' : (ratio > 0.2 ? '#f1c40f' : '#e74c3c');
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

  // 死亡：锁住操控，短暂延迟后满血重生到出生点；若在对战中则直接判负退房
  _die() {
    this._dead = true;
    this._setChatLock(true);
    if (this._soul) this._soul = null; // 死亡先收回灵魂，避免相机卡在自由飞行
    if (this._combat) {
      // 对战中被击倒：屏幕中央弹「失败」，并标记退房（真正的退房放到主循环统一执行，
      // 以免在陨石/投掷物的伤害循环里改动 this._combat / this._meteors 导致遍历错乱）
      this._showFailText('失败');
      this._pendingCombatExit = true;
      return;
    }
    this._toast('你被击倒了，即将在出生点重生');
    setTimeout(() => this._respawn(), Config.RESPAWN_DELAY * 1000);
  }

  // 重生：满血、清速度，回到服务器分配的出生点
  _respawn() {
    const sp = this._spawn || { x: 0, z: 0, yaw: 0 };
    if (this.localState.ride) this._dismountVehicle(); // 死亡时若在车上，先下车
    this.localState.health = Config.HEALTH_MAX;
    this.localState.x = sp.x;
    this.localState.z = sp.z;
    this.localState.yaw = sp.yaw || 0;
    this.localState.y = Config.PLAYER_HEIGHT * this.localPlayer.physics.sizeScale;
    this.localPlayer.physics.velocity.set(0, 0, 0);
    this._dead = false;
    this._setChatLock(false);
    this._updateHealthBar();
    this._toast('已在出生点重生');
  }

  // 昼夜循环推进：0 = 午夜、0.5 = 正午。太阳高度角与强度、环境光/半球光、
  // 天空亮度与夜空贴图都随时间连续变化；关闭时保持编辑器设计的光照。
  _updateDayNight(dt) {
    if (!this._dayEnabled) return;

    // 时间来源：联机时以服务器快照里的世界时刻为准（帧间用服务器同一周期外推，所有人一致）；
    // 未联机时本地按设置里的「一昼夜时长」推进。最后叠加本地预览偏移。
    let base;
    if (this._netDayTime !== null) {
      const elapsed = (performance.now() - this._netDayAt) / 1000;
      base = (this._netDayTime + elapsed / Game.SYNC_DAY_SECONDS) % 1;
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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this._qualityDpr)); // dpr 封顶跟随画质档，且缩放后重新夹一次
    this.renderer.setSize(w, h);
  }

  // 画质档：聚合控制阴影贴图分辨率 / dpr 封顶 / 阴影采样类型，一键降级提帧。
  // 在画面设置面板初始化与改动时都会被调用（bind 'quality'）；默认 'mid'。
  _applyQuality(q) {
    const presets = {
      high: { shadowSize: 2048, dpr: 2, type: THREE.PCFSoftShadowMap },
      mid:  { shadowSize: 1024, dpr: 1.5, type: THREE.PCFShadowMap },
      low:  { shadowSize: 512,  dpr: 1,   type: THREE.BasicShadowMap },
    };
    const p = presets[q] || presets.mid;
    if (this._sun && this._sun.shadow) {
      this._sun.shadow.mapSize.set(p.shadowSize, p.shadowSize);
      if (this._sun.shadow.map) {
        this._sun.shadow.map.dispose();
        this._sun.shadow.map = null; // 强制用新分辨率重建
      }
    }
    this._qualityDpr = p.dpr;
    this.renderer.shadowMap.type = p.type;
    this.renderer.shadowMap.needsUpdate = true; // 类型变了要重渲
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this._qualityDpr));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
  }

  // 处理服务器发来的消息（中继协议）
  _onNetworkMessage(msg) {
    switch (msg.t) {
      case 'auth': {
        // 服务端确认登录结果：刷新本地资料（昵称/颜色用于 HUD 与自己的名牌）
        if (msg.ok && msg.profile) {
          this._profile = msg.profile;
          this.playerHUD.setProfile(msg.profile);
          this._refreshLocalLabel();
        } else if (!msg.ok) {
          // 令牌失效：清掉本地会话，退回游客态（下次进入会重新弹登录）
          localStorage.removeItem('fp_token');
          this._profile = null;
          this.playerHUD.setProfile(null, false);
          this._refreshLocalLabel();
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
        this.playerManager.addPlayer(msg.id, this.localState, myNick, myColor);
        for (const p of msg.players) {
          this.playerManager.addPlayer(p.id, p, p.nick || `玩家${p.num}`, p.color || '#ffffff');
        }
        // 服务器为准：移除不在当前在线列表中的远程模型/名牌（清除未加入或已断开连接的残留）
        this.playerManager.pruneTo(msg.players.map((p) => p.id));
        break;
      }
      case 'join': {
        // 有新玩家加入：注册并显示模型（名牌用服务端下发的昵称/颜色）
        this.playerManager.addPlayer(msg.id, msg.state, msg.state.nick || `玩家${msg.state.num}`, msg.state.color || '#ffffff');
        // 如果本机是 Boss 的 owner，补发一次当前状态，让新玩家立刻看到老师
        if (this.boss) this.boss.broadcastNow();
        break;
      }
      case 'leave': {
        // 玩家断开：移除模型
        this.playerManager.removePlayer(msg.id);
        break;
      }
      case 'snapshot': {
        // 周期快照：同步远程玩家（本地由 applySnapshot 内部跳过）+ 世界时刻
        if (typeof msg.time === 'number') {
          this._netDayTime = msg.time;   // 服务器权威时间
          this._netDayAt = performance.now();
        }
        this.playerManager.applySnapshot(msg.players);
        // 对战中：快照已按房间过滤，人数即「本局存活人数」，供对战状态条显示
        if (this._combat) this._combat.alive = (msg.players || []).length;
        break;
      }
      case 'hit': {
        // 别人用投掷物打中了我：扣血（伤害已由服务端钳制）
        const dmg = Number(msg.damage) || 0;
        if (dmg > 0 && !this._dead) {
          this._changeHealth(-dmg);
          this._toast('受到 ' + dmg + ' 点伤害');
        }
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
            this.scene.remove(pr.mesh);
            pr.mesh.geometry.dispose();
            pr.mesh.material.dispose();
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
        this._showMatchOverlay();
        break;
      }
      case 'match_canceled': {
        // 服务端确认取消匹配
        if (this._combatOverlay) this._combatOverlay.style.display = 'none';
        this._toast('已取消匹配');
        break;
      }
      case 'match_found': {
        // 匹配成功：进入独立竞技场，开启「躲避陨石混战」
        this._room = msg.room;
        if (this._combatOverlay) this._combatOverlay.style.display = 'none';
        const members = new Map();
        for (const mm of (msg.members || [])) members.set(mm.id, mm);
        const isOwner = msg.owner === this.localState.id;
        this._enterCombat(msg.mode || 'meteor', msg.spawn || this._spawn, isOwner, members);
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
    if (seat === 1) {
      phys.speedMult = Config.VEHICLE_SPEED / Config.MOVE_SPEED; // 速度很快
      this._toast('已上车（驾驶位）：速度很快，但不能跳跃');
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
    st.ride = 0;
    st.veh = '';
    this._vehDriver = null;
    const phys = this.localPlayer.physics;
    phys.canJump = true;
    // 别把对话栏的操控锁一起解掉
    phys.controlLock = !!(this.aiChat && this.aiChat.isOpen());
    phys.speedMult = 1;
    phys.speedMode = 'walk';
    this._toast('已下车');
  }

  _updateVehicle(dt) {
    const st = this.localState;
    const seats = this._vehicleSeats();

    // 1) 车体：有人驾驶就跟驾驶员，否则回停放点
    if (seats.driver) {
      const d = this._playerStateById(seats.driver);
      if (d) this.vehicle.setPose(d.x, d.y - Config.PLAYER_HEIGHT * (d.size || 1), d.z, d.yaw);
    } else {
      this.vehicle.park();
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

  // Boss 战期间的「攻击」按钮（手机没有鼠标左键，必须给可点按钮）
  _createAttackButton() {
    const el = document.createElement('div');
    el.className = 'kui-btn kui-btn--red';
    el.style.cssText =
      'position:fixed;left:50%;transform:translateX(-50%);z-index:62;display:none;cursor:pointer;' +
      'bottom:calc(env(safe-area-inset-bottom, 0px) + 27%);' +
      'min-width:clamp(54px,15vmin,86px);box-sizing:border-box;text-align:center;' +
      'padding:clamp(4px,1.4vmin,6px) clamp(9px,2.6vmin,14px);' +
      'user-select:none;-webkit-user-select:none;touch-action:none;';
    el.textContent = '攻击';
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
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

  // 三阶段的「护盾」按钮（手机没有 Q 键）
  _createShieldButton() {
    const el = document.createElement('div');
    el.className = 'kui-btn kui-btn--green';
    el.style.cssText =
      'position:fixed;left:50%;transform:translateX(-50%);z-index:62;display:none;cursor:pointer;' +
      'bottom:calc(env(safe-area-inset-bottom, 0px) + 37%);' +
      'min-width:clamp(54px,15vmin,86px);box-sizing:border-box;text-align:center;' +
      'padding:clamp(4px,1.4vmin,6px) clamp(9px,2.6vmin,14px);' +
      'user-select:none;-webkit-user-select:none;touch-action:none;';
    el.textContent = '护盾';
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

  // 顶部的学币小牌，常驻显示
  _createCoinBadge() {
    const el = document.createElement('div');
    el.className = 'kui-panel';
    el.style.cssText = 'position:fixed;z-index:9500;left:14px;top:14px;pointer-events:none;user-select:none;';
    const body = document.createElement('div');
    body.className = 'kui-panel__body';
    body.style.cssText = 'font:13px var(--kui-font);';
    el.appendChild(body);
    document.body.appendChild(el);
    // 返回内容容器：_refreshCoins 直接写它的 textContent
    return body;
  }

  // 学币变化后刷新顶部牌子与商店里的余额
  _refreshCoins() {
    const w = loadWallet(this._profile);
    if (this._coinBadge) this._coinBadge.textContent = '学币 ' + w.coins;
    if (this.shop && this.shop.isOpen()) this.shop.render();
  }

  // 商人按钮显隐：靠近 + 商店没开着
  _updateMerchantHint() {
    if (!this._merchantHint) return;
    const show = !!this._merchantNear && !this.shop.isOpen();
    if (this._merchantHintShown === show) return;
    this._merchantHintShown = show;
    this._merchantHint.style.display = show ? '' : 'none';
  }

  // 购买：永久拥有，直接进背包并挂到技能槽（按数字键触发）
  _buyShopItem(id) {
    const r = buyItem(this._profile, id);
    if (!r.ok) { this._toast(r.reason); return; }
    const item = r.item;
    addToBag(getBagKey(this._profile), item.name, 1);
    this._storeItemEffect(item.name, item.effect);
    this._equipItemSkill(item.name);
    this._refreshCoins();
    this.shop.render();
    this._toast('买下「' + item.name + '」，还剩 ' + r.coins + ' 学币');
  }

  // 兑换码：成功后刷新顶部余额并让商店重绘
  _redeemCode(code) {
    const r = redeemCode(this._profile, code);
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
      this.skillSlots.assign(0, { label: eff.label, onActivate: eff.run });
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
    name.style.cssText = 'font-weight:600;color:#ffb4c6;';
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
    const mode = this.boss.mode;
    const phase = this.boss.phase;
    const P = Config.PORTAL_POS;
    const near = Math.hypot(this.localState.x - P.x, this.localState.z - P.z) <= Config.PORTAL_PROXIMITY;
    // 对战中：Boss/传送门 UI 全隐藏，攻击按钮常驻（用来丢能量球打人）
    const inCombat = !!this._combat;
    const showPortal = !inCombat && mode === 'idle' && near;
    const showAtk = inCombat || (mode === 'alive' && !this._dead) || this._gatlingOn || this._ctrlOn;
    const showShield = !inCombat && mode === 'alive' && phase >= 3 && !this._dead;
    const shieldReady = performance.now() >= this._shieldReadyAt;
    const seconds = mode === 'countdown' ? Math.ceil(this.boss.countdown) : 0;
    const hp = mode === 'alive' ? Math.max(0, Math.round(this.boss.hp)) : 0;
    const key = [showPortal, showAtk, showShield, shieldReady, mode, phase, seconds, hp].join('|');
    if (key === this._bossUiKey) return;
    this._bossUiKey = key;

    if (this._portalHint) this._portalHint.style.display = showPortal ? '' : 'none';
    if (this._attackBtn) this._attackBtn.style.display = showAtk ? '' : 'none';
    if (this._shieldBtn) {
      this._shieldBtn.style.display = showShield ? '' : 'none';
      this._shieldBtn.style.opacity = shieldReady ? '1' : '0.4'; // 冷却中变淡
    }

    const bar = this._bossBar;
    if (!bar) return;
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
    const players = [{ id: me.id || '__local', x: me.x, y: me.y, z: me.z }];
    for (const [id, rp] of this.playerManager.players) {
      if (id === me.id) continue;
      const st = rp.state;
      players.push({ id, x: st.x, y: st.y, z: st.z });
    }
    let target = null;
    let best = Config.BOSS_CHASE_RANGE;
    for (const p of players) {
      const d = Math.hypot(p.x - bpos.x, p.z - bpos.z);
      if (d < best) { best = d; target = p; }
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
    if (this._soul) return; // 灵魂出窍时肉身不可攻击
    if (this._combat) { this._combatAttack(); return; }
    this._attackBoss();
  }

  // 对战基础攻击：朝视线方向丢一颗能量球，命中玩家按 COMBAT_BALL_RADIUS 结算范围伤害。
  // 复用通用投掷物系统（_explode 已支持对半径内的其他玩家 sendHit），因此天然是 PvP。
  _combatAttack() {
    if (this._dead) return;
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
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.1, 1.45, 32),
      new THREE.MeshBasicMaterial({
        color: 0x9a4cff, transparent: true, opacity: 0.5,
        side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false,
      })
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
        h.group.position.addScaledVector(h.vel, dt);
        if (h.group.position.y <= 0.9) {
          h.group.position.y = 0.9;
          h.vel = null;
          h.settled = true;
          // 飞行只有投掷者自己模拟；落地那一刻把落点广播出去，其他人照着摆
          if (!h.net) this.network.sendBlackHole(h.group.position.x, h.group.position.z);
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
      until: performance.now() + Config.CTRL_MAX_TIME * 1000,
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
    this._ctrlBy = {
      from: msg.from,
      until: nowMs + Config.CTRL_MAX_TIME * 1000,
      ax: Number(msg.x) || 0,
      ay: Number(msg.y) || 0,
      az: Number(msg.z) || 0,
    };
    this._toast('被控制枪抓住了！按跳跃挣脱');
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
      const now = performance.now();
      const target = this.playerManager.players.get(this._ctrl.id);
      if (!target) {
        this._releaseCtrl(null); // 目标已离线：静默收枪
      } else if (now >= this._ctrl.until) {
        this._releaseCtrl('控制超时，已松开');
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
      if (performance.now() >= this._ctrlBy.until) {
        this._endControlled();
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
    mesh.position.set(ox + dx * 0.6, oy + dy * 0.6, oz + dz * 0.6);
    this.scene.add(mesh);
    this._bullets.push({
      mesh, dx, dy, dz,
      ox: ox + dx * 0.6, oy: oy + dy * 0.6, oz: oz + dz * 0.6,
      traveled: 0,
      maxDist: Math.max(0.6, maxDist),
    });
  }

  _updateGatling(dt) {
    // 散热：不开火时按固定速率降热
    if (this._gatlingHeat > 0) {
      this._gatlingHeat = Math.max(0, this._gatlingHeat - Config.GATLING_COOL_RATE * dt);
    }
    if (this._gatlingOverheated && this._gatlingHeat <= Config.GATLING_RECOVER_AT) {
      this._gatlingOverheated = false;
      this._toast('加特林冷却完成');
    }

    this._gatlingCd -= dt;
    if (this._gatlingOn && this._gatlingHeld && !this._gatlingOverheated && this._gatlingCd <= 0) {
      this._gatlingCd = Config.GATLING_INTERVAL;
      this._fireGatling();
      if (this._gatlingHeat >= 100) {
        this._gatlingOverheated = true;
        this._toast('加特林过热了，等它冷却');
      }
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
    fill.style.cssText = 'width:0%;background:#2ecc71;transition:width .06s linear;';
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
    bar.fill.style.background = this._gatlingOverheated ? '#e74c3c' : (heat > 65 ? '#f1c40f' : '#2ecc71');
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

  // 顶部校卡两侧按钮：左侧「背包」、右侧「设置」+ 一个展示物品的背包浮层
  _createTopButtons() {
    const mkBtn = (text, posCss, onClick) => {
      const b = document.createElement('div');
      b.className = 'kui-btn kui-btn--grey';
      b.textContent = text;
      b.style.cssText =
        'position:fixed;z-index:9500;cursor:pointer;user-select:none;padding:7px 10px;' + posCss;
      b.addEventListener('click', onClick);
      document.body.appendChild(b);
      return b;
    };
    // 校卡展开时最宽 268px，按钮让它贴着卡左右两侧（50% + 134 再留 10px 间距）
    this._btnBag = mkBtn('背包', 'right:calc(50% + 144px);top:14px;', () => this._toggleBag());
    this._btnSettings = mkBtn('设置', 'left:calc(50% + 144px);top:14px;', () => this.settingsPanel.toggle());
    // 对战匹配：右上角独立按钮，点开匹配/退出对战（文案随状态变化）
    this._btnCombat = mkBtn('对战匹配', 'right:14px;top:14px;', () => this._toggleCombat());
    this._buildBag();
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
      '<div class="bag-grid"></div>';
    document.body.appendChild(ov);
    ov.querySelector('button').addEventListener('click', () => { ov.style.display = 'none'; });
    this._bagOv = ov;
    this._bagList = ov.querySelector('.bag-grid');
  }

  _toggleBag() {
    this._renderBag();
    this._bagOv.style.display = this._bagOv.style.display === 'none' ? 'block' : 'none';
  }

  _renderBag() {
    const bag = loadBag(getBagKey(this._profile));
    const entries = Object.entries(bag).filter(([, v]) => v > 0);
    const grid = this._bagList;
    grid.innerHTML = '';
    if (!entries.length) {
      grid.style.cssText = 'text-align:center;color:var(--kui-paper);padding:40px 0;';
      grid.textContent = '背包空空如也，去喷泉边找阿花要宝贝吧。';
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
      // 图标：带颜色的圆角方块，里面放物品名的首字（阿花挑的图标以物品名首个字符为代表）
      const icon = document.createElement('div');
      icon.textContent = name.charAt(0) || '?';
      icon.style.cssText =
        'width:46px;height:46px;border-radius:var(--kui-radius);display:flex;align-items:center;justify-content:center;' +
        'background:' + this._itemColor(name) + ';color:var(--kui-paper);font-weight:700;font-size:20px;';
      const meta = document.createElement('div');
      meta.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:2px;text-align:center;';
      const nameEl = document.createElement('div');
      nameEl.textContent = name;
      nameEl.style.cssText = 'font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:120px;';
      const countEl = document.createElement('div');
      countEl.textContent = '× ' + count + '   ·' + eff.label;
      countEl.style.cssText = 'font-size:12px;color:var(--kui-ink-soft);';
      const useBtn = document.createElement('button');
      useBtn.type = 'button';
      useBtn.textContent = '使用';
      useBtn.className = 'kui-btn kui-btn--primary';
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
      useBtn.addEventListener('click', () => {
        const v = slotSel.value;
        this._useItem(name, v === '' ? null : Number(v));
        this._renderBag();
      });
      // 销毁：把该物品从背包里丢掉（每次减 1，减到 0 整条移除）
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.textContent = '销毁';
      delBtn.className = 'kui-btn kui-btn--danger';
      delBtn.addEventListener('click', () => {
        removeFromBag(getBagKey(this._profile), name, 1);
        this._renderBag();
      });
      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;flex-direction:column;gap:6px;align-items:center;width:100%;';
      btnRow.appendChild(slotSel);
      btnRow.appendChild(useBtn);
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
  _throwProjectile(spec) {
    const s = this.localState;
    const cosP = Math.cos(s.pitch);
    const sinP = Math.sin(s.pitch);
    const dir = new THREE.Vector3(-Math.sin(s.yaw) * cosP, sinP, -Math.cos(s.yaw) * cosP);
    const start = new THREE.Vector3(s.x, s.y, s.z).addScaledVector(dir, 0.8);
    const color = spec.color || 0xff6a3c;
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 12, 12),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.1 })
    );
    mesh.position.copy(start);
    this.scene.add(mesh);
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
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 12, 12),
      new THREE.MeshStandardMaterial({ color: 0xff6a3c, emissive: 0xff6a3c, emissiveIntensity: 1.1 })
    );
    mesh.position.set(x, y, z);
    this.scene.add(mesh);
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
      this.scene.remove(p.mesh);
      p.mesh.geometry.dispose();
      p.mesh.material.dispose();
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
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(Math.max(0.45, radius * 0.45), 16, 12),
      new THREE.MeshBasicMaterial({
        color: 0xffd27a, transparent: true, opacity: 0.85,
        blending: THREE.AdditiveBlending, depthWrite: false,
      })
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
      case 'gatling':
        return {
          label: '加特林',
          run: () => this._toggleGatling(),
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
    this.skillSlots.assign(index, { label: eff.label, onActivate: eff.run });
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
        this.skillSlots.assign(idx, { label: eff.label, onActivate: eff.run });
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
  }

  // 背包「使用」：指定槽位则先装备到该槽，再触发效果（与技能槽同源）。
  _useItem(item, slotIndex) {
    if (slotIndex != null && slotIndex >= 0) this._setSlot(slotIndex, item);
    const eff = this._effectForItem(item);
    eff.run();
  }

  // 给物品挑一个图标色：按名字散列到一个固定色板，保证同名拿到同色。
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

  // 屏幕中央弹字（不是弹窗）：用于对战失败等强反馈，淡入后自动淡出
  _showFailText(text) {
    if (this._failEl) { this._failEl.remove(); this._failEl = null; }
    const el = document.createElement('div');
    el.style.cssText =
      'position:fixed;left:50%;top:44%;transform:translate(-50%,-50%) scale(.7);' +
      'z-index:9600;pointer-events:none;white-space:nowrap;' +
      'font:900 76px/1 var(--kui-font, system-ui, sans-serif);letter-spacing:10px;' +
      'color:#ff4d4d;text-shadow:0 0 26px rgba(255,60,60,.75),0 6px 22px rgba(0,0,0,.65);' +
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

    // 本帧实际移动速度：让骨头动画知道走得多快（「移动时疯狂旋转」已临时注释）
    const dx = s.x - this._tpPrevX;
    const dz = s.z - this._tpPrevZ;
    const speed = dt > 0 ? Math.hypot(dx, dz) / dt : 0;
    this._tpPrevX = s.x;
    this._tpPrevZ = s.z;

    local.model.rotation.set(0, s.yaw, 0);

    const rig = local.model.userData.rig;
    if (rig) {
      this._tpTime += dt;
      rig.update(this._tpTime, speed);
    }

    // 相机：眼睛后上方、朝向玩家头部附近（经典第三人称跟随）
    // 俯仰（pitch）必须参与：否则鼠标上下拖动在第三人称下毫无反应。
    // 做法：把 pitch 合进「视线方向」，相机沿视线反方向后退，再按视线方向瞄准。
    const eye = new THREE.Vector3(this.localState.x, this.localState.y, this.localState.z);
    const yaw = this.localState.yaw;
    const cosP = Math.cos(this.localState.pitch);
    const sinP = Math.sin(this.localState.pitch);
    // 含俯仰的视线单位方向（与第一人称一致：yaw 水平转向 + pitch 俯仰）
    const viewDir = new THREE.Vector3(-Math.sin(yaw) * cosP, sinP, -Math.cos(yaw) * cosP);
    const DIST = 4.0;
    const LIFT = 1.0; // 相机相对眼睛再抬高一点，形成略微俯视的肩后视角
    const camPos = eye.clone().addScaledVector(viewDir, -DIST).add(new THREE.Vector3(0, LIFT, 0));
    if (camPos.y < 0.4) camPos.y = 0.4; // 抬头时相机可能钻到地面以下，夹住下限
    this.camera.position.copy(camPos);
    // 直接用与第一人称相同的欧拉角（pitch, yaw）来定朝向，俯仰一定跟着鼠标走，
    // 不依赖 lookAt 的推算，避免「第三人称锁俯仰」。
    this.camera.rotation.set(this.localState.pitch, this.localState.yaw, 0);
  }

  // 主循环：计算 dt -> 更新玩家 -> 渲染
  // ============ 对战模式：匹配 + 独立竞技场「躲避陨石混战」 ============

  // 顶部「对战匹配」按钮：未对战时发起匹配；对战中则退出房间
  _toggleCombat() {
    if (this._combat) {
      this.network.sendLeaveRoom();
      this._exitCombat(this._lobbySpawn); // 本地即时退出；服务端 match_left 到达后为幂等空操作
      return;
    }
    this.network.sendMatch(this._matchMode);
    this._showMatchOverlay();
    this._toast('正在匹配「躲避陨石混战」…');
  }

  // 「匹配中…」浮层（带取消按钮）
  _showMatchOverlay() {
    if (!this._combatOverlay) {
      const el = document.createElement('div');
      el.style.cssText =
        'position:fixed;inset:0;z-index:9600;display:flex;align-items:center;justify-content:center;' +
        'background:rgba(8,14,24,.55);font-family:var(--kui-font);color:var(--kui-paper);';
      el.innerHTML =
        '<div class="kui-panel" style="min-width:280px;padding:26px 28px;text-align:center;">' +
        '<div class="kui-title" style="font-size:18px;margin-bottom:10px;">匹配中…</div>' +
        '<div style="color:var(--kui-ink-soft);margin-bottom:18px;font-size:13px;">正在为你寻找「躲避陨石混战」对手</div>' +
        '<button type="button" id="__cancelMatch" class="kui-btn kui-btn--grey" style="width:100%;">取消匹配</button></div>';
      document.body.appendChild(el);
      const btn = el.querySelector('#__cancelMatch');
      if (btn) btn.addEventListener('click', () => { this.network.sendCancelMatch(); el.style.display = 'none'; });
      this._combatOverlay = el;
    }
    this._combatOverlay.style.display = 'flex';
  }

  // 对战状态条：模式名 + 存活人数 + 计时 + 退出按钮
  _showCombatHUD() {
    if (!this._combatHud) {
      const el = document.createElement('div');
      el.style.cssText =
        'position:fixed;top:56px;right:14px;z-index:9400;' +
        'display:flex;gap:12px;align-items:center;' +
        'font:13px/1.4 var(--kui-font);color:var(--kui-paper);' +
        'background:rgba(11,21,34,.72);border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:7px 12px;';
      el.innerHTML =
        '<span style="font-weight:700;color:#ffd76a;">躲避陨石混战</span>' +
        '<span id="__cAlive">同场 -</span>' +
        '<span id="__cTime">时间 00:00</span>' +
        '<button type="button" id="__cLeave" class="kui-btn kui-btn--grey" style="padding:3px 10px;">退出对战</button>';
      document.body.appendChild(el);
      const leaveBtn = el.querySelector('#__cLeave');
      if (leaveBtn) leaveBtn.addEventListener('click', () => this._toggleCombat());
      this._combatHud = el;
    }
    this._combatHud.style.display = 'flex';
  }

  _hideCombatHUD() {
    if (this._combatHud) this._combatHud.style.display = 'none';
  }

  // 技能栏显隐：对战（竞技场）与灵魂出窍下不显示——这两个场景里技能栏无意义
  _updateSkillBarVisibility() {
    if (!this.skillSlots || typeof this.skillSlots.setVisible !== 'function') return;
    this.skillSlots.setVisible(!this._combat && !this._soul);
  }

  _updateCombatHUD() {
    if (!this._combat || !this._combatHud) return;
    const a = this._combatHud.querySelector('#__cAlive');
    const t = this._combatHud.querySelector('#__cTime');
    if (a) a.textContent = '同场 ' + (this._combat.alive || 0);
    const s = Math.max(0, Math.floor((performance.now() - this._combat.roundStart) / 1000));
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    if (t) t.textContent = '时间 ' + mm + ':' + ss;
  }

  // 进入对战：隐藏城市景物、换上竞技场碰撞体、把玩家放到房间出生点、显示对战 HUD
  _enterCombat(mode, spawn, isOwner, members) {
    if (this._combat) this._exitCombat(this._lobbySpawn); // 防御：已在对战中先干净退出
    this._lobbySpawn = this._spawn || this._lobbySpawn || { x: 2, z: 144, yaw: 0 };
    const sp = spawn || { x: 0, z: 0, yaw: 0 };
    this._combat = {
      room: this._room, mode, isOwner: !!isOwner, members: members || new Map(),
      spawn: sp, roundStart: performance.now(), alive: 0,
    };
    // 若正骑着电动车进对战，先下车（车不在竞技场里）
    if (this.localState.ride) this._dismountVehicle();

    // 隐藏主世界景物与城市 NPC；碰撞体先快照再原地替换为竞技场
    if (this._cityRoots) for (const r of this._cityRoots) r.visible = false;
    setEditorSceneVisible(false); // 编辑器建筑不在 roots 里，单独整组隐藏
    if (this.aiNpc) this.aiNpc.group.visible = false;
    if (this.merchant) this.merchant.group.visible = false;
    if (this.vehicle) this.vehicle.group.visible = false;
    if (this.boss && this.boss.group) this.boss.group.visible = false;
    if (this.boss && this.boss.portalGroup) this.boss.portalGroup.visible = false;
    if (this._portalHint) this._portalHint.style.display = 'none';
    if (this._merchantHint) this._merchantHint.style.display = 'none';
    if (this._vehHint) this._vehHint.style.display = 'none';
    if (this._chatTab) this._chatTab.style.display = 'none';

    this._mainColliders = this.colliders.slice(); // 快照主世界碰撞体内容（退出时还原）
    this._arena = buildArena(this.scene);
    this.colliders.length = 0; // 原地改写：LocalPlayer 持有的数组引用保持不变
    for (const c of this._arena.colliders) this.colliders.push(c);

    // 玩家落到竞技场出生点
    this.localState.x = sp.x;
    this.localState.z = sp.z;
    this.localState.yaw = sp.yaw || 0;
    this.localState.y = Config.PLAYER_HEIGHT * this.localPlayer.physics.sizeScale;
    this.localState.health = Config.HEALTH_MAX;
    this.localPlayer.physics.velocity.set(0, 0, 0);
    this._dead = false;
    this._spawn = sp;
    this._updateHealthBar();
    this._clearTransients(); // 清掉主世界留下的投掷物/黑洞/特效，避免带进竞技场

    for (const m of this._meteors) this._disposeMeteor(m); // 防御：清掉可能的上场残留
    this._meteors.length = 0;
    this._meteorTimer = 0; // 房主首波立刻开始
    this._showCombatHUD();
    if (this._btnCombat) this._btnCombat.textContent = '退出对战';
    this._updateBossUI(); // 刷新攻击按钮（对战中常驻）
    this._updateSkillBarVisibility(); // 竞技场里不显示技能栏
    this._toast('已匹配！进入「躲避陨石混战」');
  }

  // 退出对战：拆掉竞技场、还原城市景物与主世界碰撞体、玩家回大厅出生点
  _exitCombat(lobbySpawn) {
    if (!this._combat && !this._arena) return; // 幂等：已退出则直接返回
    for (const m of this._meteors) this._disposeMeteor(m);
    this._meteors.length = 0;
    this._disposeMeteorAssets();
    if (this._arena) { this._arena.dispose(); this._arena = null; }

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

    this._combat = null;
    this._room = null;
    this._hideCombatHUD();
    if (this._btnCombat) this._btnCombat.textContent = '对战匹配';
    this._updateBossUI(); // 交回给主世界逻辑控制攻击按钮显隐
    this._updateSkillBarVisibility(); // 回到主世界，恢复技能栏
    this._toast('已退出对战，返回主世界');
  }

  // 清掉在飞的投掷物 / 黑洞 / 爆炸特效 / 追踪导弹（切换场景时调用，避免跨场景残留）
  _clearTransients() {
    for (const p of this._projectiles) { if (p && p.mesh) this.scene.remove(p.mesh); }
    this._projectiles.length = 0;
    for (const h of this._holes) { const g = h && (h.group || h.mesh); if (g) this.scene.remove(g); }
    this._holes.length = 0;
    for (const f of this._fx) { if (f && f.group) this.scene.remove(f.group); }
    this._fx.length = 0;
    for (const m of this._missiles) { if (m && m.mesh) this.scene.remove(m.mesh); }
    this._missiles.length = 0;
  }

  // 陨石模式每帧推进：房主按间隔生成，全场推进下落并结算落地伤害
  _updateMeteorMode(dt) {
    const c = this._combat;
    if (!c || c.mode !== 'meteor') return;

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

    this._updateCombatHUD();
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

  _loop() {
    this._raf = requestAnimationFrame(() => this._loop());

    // 计算本帧时间间隔；clamp 到 MAX_DELTA_TIME，防止切后台恢复时瞬间跳帧导致角色瞬移
    const dt = Math.min(this.clock.getDelta(), Config.MAX_DELTA_TIME);

    // 昼夜循环：先更新太阳角度与光照，后面阴影定位要用到最新的 _sunOffset
    this._updateDayNight(dt);

    // 控制枪：抢在玩家更新之前处理，这样挣脱输入能先消费掉空格、
    // 且被控侧的 velocityHold 能在本次物理里生效
    this._updateCtrl(dt);

    // 更新玩家逻辑（本地玩家 + 远程玩家插值）
    // 灵魂出窍时冻结肉身：跳过本地玩家更新，鼠标/键位交给灵魂相机
    if (!this._soul) this.localPlayer.update(dt);
    this.playerManager.update(dt);

    // 主世界（城市）专属系统：对战中整组跳过，避免城市 NPC/Boss/载具与竞技场互串
    if (!this._combat) {
      // 电动车：摆放车体、钉住后座、刷新上下车提示（必须在玩家更新之后）
      this._updateVehicle(dt);
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
    // 爆炸特效：推进动画
    this._updateFX(dt);

    // 调试骨骼可视化：驱动待机姿态并绘制骨架/坐标轴
    if (this.debugRig) this.debugRig.update(this.clock.elapsedTime);

    // 对战中被击倒：统一在这里退房（已离开伤害结算循环，改动 this._combat/碰撞体 安全）
    if (this._pendingCombatExit) {
      this._pendingCombatExit = false;
      this.network.sendLeaveRoom();
      this._exitCombat(this._lobbySpawn);
      this._setChatLock(false);
    }

    // 视角优先级：灵魂出窍（自由飞行） > 第三人称 > 第一人称
    if (this._soul) {
      this._updateSoul(dt);       // 自由飞行并驱动相机
      this._updateSoulBody();     // 肉身显示在被冻结的位置
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
    this.renderer.render(this.scene, this.camera);
  }
}