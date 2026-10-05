// 城市建筑编辑器（独立开发工具，与游戏运行时无任何联动）。
// 自由视角（WASD 平移 + 右键拖拽转视角 + 滚轮缩放）+ 3D 变换轴（TransformControls）。
// 交互：点击模型即选中；移动/旋转/缩放模式会出现可拖动的彩色 3D 轴；
// WASD 平移视角、右键拖拽转视角、滚轮缩放。游戏景物在编辑器中亦可选中编辑。
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { RectAreaLightHelper } from 'three/addons/helpers/RectAreaLightHelper.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { ConvexMeshDecomposition } from 'vhacd-js';
import { instantiate } from '../world/AssetLoader.js';
import { generateSimple } from '../world/collision/simpleGen.js';
import { API_BASE, Config } from '../config.js';
// 场地边界（空气墙）：与游戏运行时共用同一份数据/几何，见 world/Boundary.js
import {
  defaultBoundary, normalizeBoundary, boundaryWallSpecs, boundarySpan,
  BOUNDARY_THICKNESS, BOUNDARY_MIN_SPAN,
} from '../world/Boundary.js';
// 赛道（校园狂飙）：与游戏运行时共用同一份数据/几何/判定，见 world/Track.js
import {
  defaultTrack, normalizeTrack, gateSpecs, trackSummary, trackHeightRange, TRACK_GATE_W_DEF,
} from '../world/Track.js';
import { buildTrackPath, disposeTrackViz } from '../world/TrackViz.js';
// 复用游戏世界作为编辑器底景与可编辑景物（读取游戏地形/道路/道具）
import { buildScenery } from '../world/buildScenery.js';
import { attachSky } from '../world/SkyBox.js';
import { createSettingsPanel, DEFAULT_SETTINGS, computeSunOffset } from '../ui/SettingsPanel.js';

const DEG = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);
// 视角飞行速度（米/秒，WASD 移动）。滚轮缩放会按远近再动态加倍，见 speedScale()
const CAM_SPEED = 55;
// scale 规范化：统一为 {x,y,z}，兼容旧的单数值
function normScale(s) {
  if (s && typeof s === 'object' && typeof s.x === 'number') {
    return { x: s.x, y: (typeof s.y === 'number' ? s.y : s.x), z: (typeof s.z === 'number' ? s.z : s.x) };
  }
  const v = (typeof s === 'number' && Number.isFinite(s)) ? s : 1;
  return { x: v, y: v, z: v };
}
// 默认方形碰撞体：以模型原点为中心的立方体，底部贴合地面（oy 为中心高）
function defaultCollider() {
  return { enabled: true, hx: 0.5, hy: 0.5, hz: 0.5, oy: 0.5 };
}
// 编辑器读写自己的场景文件与模型上传；统一走远程后端（API_BASE），实现线上同步。
// 保存/读取场景、素材清单、模型上传都指向同一台后端，编辑器改完线上游戏即可读到。
// API_BASE 正常是 https://game666.lshserver.dpdns.org；万一没配到，就退回同源（见 UPLOAD_URL 兜底）。
const API_ROOT = String(API_BASE || '').replace(/\/+$/, '');
const MAP_URL = API_ROOT + '/api/scene';
const SAVE_URL = API_ROOT + '/api/scene';
const UPLOAD_URL = API_ROOT + '/api/upload';
// 同源兜底：编辑器也可能被本地 server（server/index.js）或 Vite dev 的代理托管，那时 /api/upload 直接可用
const SAME_ORIGIN_UPLOAD = '/api/upload';
// 后端与 vite 代理的单次上传上限都是 64MB。这里先拦一道，给一句人话，而不是让连接被服务端 reset。
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

// 上传用的 ASCII 文件名。为什么必须转：
// HTTP 头的值只能是 ISO-8859-1 字节，文件名里只要有一个中文（任何码位 >255 的字符），
// fetch 会在**请求发出之前同步抛 TypeError**（Network 面板里一条记录都不会有），
// 再被外层的 catch 吞掉，就报成「接口未返回可用地址」这种误导性提示。
// 另外服务端静态路由只认 [a-zA-Z0-9._-]，中文名存进去也取不出来，所以文件一律用 ASCII 名，
// 原始文件名只用于素材库显示。规则与服务端 sanitizeName 保持一致。
function asciiFileName(name) {
  const raw = String(name || '');
  const m = raw.match(/\.(glb|gltf)$/i);
  const ext = m ? '.' + m[1].toLowerCase() : '.glb';
  const stem = raw.replace(/\.(glb|gltf)$/i, '').replace(/[^a-zA-Z0-9._-]/g, '_');
  return (stem || 'model') + ext;
}

// 素材库：内建素材（文件名来自 /assets），统一为 {label, url} 绝对路径
const LIBRARY = [
  'building-small-a.glb', 'building-small-b.glb', 'building-small-c.glb', 'building-small-d.glb',
  'building-garage.glb', 'watertower.glb', 'fountain.glb', 'bench.glb', 'lamp.glb', 'tree.glb', 'bush.glb',
].map((f) => ({ label: f.replace('.glb', ''), url: '/assets/' + f }));

// 已导入模型（存进游戏 assets 目录），持久化在 localStorage
const IMPORT_KEY = 'city.builder.imports.v1';
function loadImportUrls() {
  try {
    const a = JSON.parse(localStorage.getItem(IMPORT_KEY) || '[]');
    return Array.isArray(a) ? a : [];
  } catch (e) { return []; }
}

export function createEditor() {
  // 保护：必须以 http 方式从 Vite 打开，否则 fetch('/api/...') 在 file:// 下会被浏览器拒发
  if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') {
    alert('请通过 http://localhost:5173/editor.html 打开本编辑器（不要直接双击 html 文件）。当前是 file:// 方式，无法使用导入/保存功能。');
    return;
  }
  // ---------- 渲染 / 场景 / 相机 ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const vp = document.getElementById('viewport');
  vp.insertBefore(renderer.domElement, vp.firstChild);
  const size = () => [vp.clientWidth, vp.clientHeight];
  const [w0, h0] = size();
  renderer.setSize(w0, h0);

  const scene = new THREE.Scene();
  attachSky(scene); // 城市天空贴图（优先）→ 程序化天空兜底

  const camera = new THREE.PerspectiveCamera(55, w0 / h0, 0.1, 500);
  camera.position.set(32, 24, 32);
  camera.lookAt(0, 0, 0);

  // 灯光：默认值跟随画面设置（SettingsPanel），可在「画面」面板里即时调整并持久化
  const ambient = new THREE.AmbientLight(0xffffff, DEFAULT_SETTINGS.ambient);
  scene.add(ambient);
  // 半球光：按法线给天空/地面色，模拟弹射光，给室内/暗处补明暗层次（关键：让被主阴影盖住的面不再同色）
  const hemi = new THREE.HemisphereLight(0xffffff, 0x222230, DEFAULT_SETTINGS.hemi);
  scene.add(hemi);
  // 阴影跟随相机：阳光的阴影相机始终以 sunTarget 为中心，每帧把 sunTarget 挪到相机附近，
  // 这样近处模型和地面都能收到清晰投射，远处自然淡出，性能也更可控。
  const sunTarget = new THREE.Object3D();
  scene.add(sunTarget);
  const sunOffset = new THREE.Vector3(30, 40, 20); // 阳光相对 target 的固定偏移（保持整体光向不变）
  const sun = new THREE.DirectionalLight(0xffffff, DEFAULT_SETTINGS.sun);
  sun.castShadow = true;
  sun.shadow.mapSize.set(DEFAULT_SETTINGS.shadowSize, DEFAULT_SETTINGS.shadowSize);
  // 阴影痤疮修复：bias 轻微下压深度，normalBias 沿法线推开采样点，消除平面上的「一条一条」条纹
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 1.0;
  const SHADOW_R = DEFAULT_SETTINGS.shadowR; // 阴影覆盖半宽（以 sunTarget 为中心，范围跟视距）
  sun.shadow.camera.left = -SHADOW_R;
  sun.shadow.camera.right = SHADOW_R;
  sun.shadow.camera.top = SHADOW_R;
  sun.shadow.camera.bottom = -SHADOW_R;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 120;
  sun.target = sunTarget; // 方向光朝向跟随目标，阴影随其框
  sun.position.copy(sunTarget.position).add(sunOffset);
  scene.add(sun);

  // 底景与游戏景物：由 adoptGameScenery() 里 buildScenery 统一构建（地形/道路/墙体 + 道具）

  const grid = new THREE.GridHelper(360, 90, 0x5a6a5f, 0x3a443e);
  grid.position.y = 0.01;
  scene.add(grid);
  scene.add(new THREE.AxesHelper(5));

  // 自由视角：WASD 平移 + 右键拖拽转视角 + 滚轮缩放（左键留给选中/放置/3D 轴）
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.target.set(0, 1, 0);
  controls.maxPolarAngle = Math.PI / 2 - 0.02;
  controls.minDistance = 4;
  controls.maxDistance = 400;
  controls.staticMoving = true;
  controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
  controls.update();

  // 3D 变换轴（移动/旋转/缩放），可拖动箭头/环
  const tCtl = new TransformControls(camera, renderer.domElement);
  scene.add(tCtl.getHelper());
  // 复制模式：拖动开始时先复制一份，本次拖动作用于副本，原件原地保留
  tCtl.addEventListener('dragging-changed', (e) => {
    if (e.value && state.copyMode && state.selected) {
      duplicateRec(state.selected, true);
    }
    controls.enabled = !e.value;
    // 拖动结束：光源的位置/朝向已回写；缩放必须在这里结算（逐帧结算会被放大成指数级）
    if (!e.value) {
      const light = selectedLight();
      if (light) { readLightScale(light); syncLightPanel(); }
    }
  });
  tCtl.addEventListener('objectChange', () => {
    if (state.selected) { readTransformFromObject(state.selected); return; }
    // gizmo 附着在光源上时：把灯光的 position / rotation 回写到光源记录
    const light = selectedLight();
    if (light) readLightFromObject(light);
  });
  tCtl.enabled = false;

  // 射线
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hit = new THREE.Vector3();

  // ---------- 状态 ----------
  const state = {
    mode: 'place',
    currentUrl: LIBRARY[0].url,
    currentLabel: LIBRARY[0].label,
    imported: loadImportUrls(),
    ghost: null,
    selected: null,   // 当前选中对象（置于置中的 objects / scenery / placed）
    placed: [],       // 用户摆放的对象 {id,kind,name,url|data,x,y,z,rotY,scale,obj}
    lights: [],       // 光源 {id,type,x,y,z,color,intensity,distance,decay,width,height,rotY,rotX,obj,helper}
    selectedLightId: null, // 右侧「光源」面板当前选中的光源 id
    scenery: [],      // 游戏景物（可编辑，不随保存持久化）
    placingEmpty: false, // 空碰撞体放置中：幽灵仅圆环，点击在落点生成空碰撞体
    copyMode: false,  // 复制模式：拖动 3D 轴时先复制一份，本次拖动作用于副本
    raf: 0,
    // 场地边界（空气墙）：在「边界」模式里编辑，随场景一起保存为 boundary 字段
    boundary: defaultBoundary(),
    boundaryFocus: true, // 边界模式：只显示边界（把模型/景物/光源藏起来，看得更清）
    boundaryDrag: null,  // 正在拖的边界手柄 { kind:'edge'|'corner', side?/keys? }
    // 赛道（校园狂飙）：在「赛道」模式里编辑，随场景一起保存为 track 字段
    track: defaultTrack(),
    trackFocus: true,   // 赛道模式：只显示赛道（把模型/景物/光源藏起来，看得清）
    trackDrag: null,    // 正在拖的门索引（null = 没在拖）
    trackSel: -1,       // 当前选中的门（右侧列表与 3D 高亮共用；-1 = 没选）
    trackDragPx: 0,     // 拖门起始的屏幕 y 像素（按 Shift 调高度时的基准）
    trackDragY0: 0,     // 拖门起始时这个门的高度（同上）
    // 组合家具：进入「空白场景」拼装（主场景临时隐藏、placed/lights/scenery 换成空草稿），存成商店商品
    comboMode: false,
    comboBackup: null,  // { placed, lights, scenery } 主场景的备份
  };
  // 物体 id：全局唯一的纯数字 id，随场景一起保存/还原。
  // 编号顺序：景物先按 buildScenery 顺序占 1..N（key 固定 → id 固定），摆放物体接续往后排。
  let _idSeq = 1;
  function nextId() { return _idSeq++; }
  // 还原时把已存在的 id 序号推高，避免后续新建对象与旧 id 撞号
  function bumpIdSeq(id) {
    const n = Number(id);
    if (Number.isInteger(n) && n >= _idSeq) _idSeq = n + 1;
  }
  // 把 id 挂到运行时对象上，游戏端/工具可按 userData.id 精确引用
  function tagId(rec) {
    if (rec && rec.obj) rec.obj.userData.id = rec.id;
  }
  // 从模型 url 推显示名：/assets/import-xxx-zhaji.glb → zhaji（去目录、去扩展名、解码中文）
  function nameFromUrl(url) {
    if (!url) return '';
    const file = String(url).split('/').pop().split('?')[0];
    const bare = file.replace(/\.glb$/i, '');
    try { return decodeURIComponent(bare); } catch (e) { return bare; }
  }

  // ---------- 测距器 ----------
  let rulerPts = [];        // 已固定的测量点（最多两个）
  let rulerLine = null;     // 两点连线
  let rulerLabel = null;    // 距离文字标签
  const rulerTmpPts = [];

  const StepUI = {
    snap: document.getElementById('snap'),
    snapStep: document.getElementById('snapStep'),
    stX: document.getElementById('stX'),
    stZ: document.getElementById('stZ'),
    hint: document.getElementById('viewhint'),
    btnSelect: document.getElementById('tSelect'),
    btnPlace: document.getElementById('tPlace'),
    btnMove: document.getElementById('tMove'),
    btnRot: document.getElementById('tRot'),
    btnScale: document.getElementById('tScale'),
    btnRuler: document.getElementById('tRuler'),
    btnDel: document.getElementById('tDel'),
    library: document.getElementById('library'),
    pX: document.getElementById('pX'),
    pZ: document.getElementById('pZ'),
    pY: document.getElementById('pY'),
    pRot: document.getElementById('pRot'),
    pScale: document.getElementById('pScale'),
    outliner: document.getElementById('outliner'),
    colliderList: document.getElementById('colliderList'),
    sceneryList: document.getElementById('sceneryList'),
    btnSave: document.getElementById('btnSave'),
    status: document.getElementById('status'),
    btnLibrary: document.getElementById('btnLibrary'),
    libModal: document.getElementById('libModal'),
    libClose: document.getElementById('libClose'),
    cEn: document.getElementById('cEn'),
    cHx: document.getElementById('cHx'),
    cHy: document.getElementById('cHy'),
    cHz: document.getElementById('cHz'),
    cOy: document.getElementById('cOy'),
    colliderPanel: document.getElementById('colliderPanel'),
    btnBound: document.getElementById('tBound'),
    boundaryPanel: document.getElementById('boundaryPanel'),
    bInfo: document.getElementById('bInfo'),
    bHint: document.getElementById('bHint'),
    bMinX: document.getElementById('bMinX'),
    bMaxX: document.getElementById('bMaxX'),
    bMinZ: document.getElementById('bMinZ'),
    bMaxZ: document.getElementById('bMaxZ'),
    bHeight: document.getElementById('bHeight'),
    bShow: document.getElementById('bShow'),
    bFocus: document.getElementById('bFocus'),
    bFrame: document.getElementById('bFrame'),
    bFit: document.getElementById('bFit'),
    bShrink: document.getElementById('bShrink'),
    btnTrack: document.getElementById('tTrack'),
    trackPanel: document.getElementById('trackPanel'),
    tkInfo: document.getElementById('tkInfo'),
    tkHint: document.getElementById('tkHint'),
    tkName: document.getElementById('tkName'),
    tkLaps: document.getElementById('tkLaps'),
    tkY: document.getElementById('tkY'),
    tkFocus: document.getElementById('tkFocus'),
    tkList: document.getElementById('tkList'),
    tkFrame: document.getElementById('tkFrame'),
    tkDel: document.getElementById('tkDel'),
    tkClear: document.getElementById('tkClear'),
    btnEmptyCollider: document.getElementById('btnEmptyCollider'),
    btnShop: document.getElementById('tShop'),
    shopPanel: document.getElementById('shopPanel'),
    btnFurn: document.getElementById('tFurn'),
    furnPanel: document.getElementById('furnPanel'),
    furnToken: document.getElementById('furnToken'),
    furnRefresh: document.getElementById('furnRefresh'),
    furnList: document.getElementById('furnList'),
    furnAll: document.getElementById('furnAll'),
    furnNone: document.getElementById('furnNone'),
    furnDelSel: document.getElementById('furnDelSel'),
    furnClearAll: document.getElementById('furnClearAll'),
    furnMsg: document.getElementById('furnMsg'),
    areaList: document.getElementById('areaList'),
    areaAdd: document.getElementById('areaAdd'),
    areaFromSel: document.getElementById('areaFromSel'),
    areaReset: document.getElementById('areaReset'),
    areaSave: document.getElementById('areaSave'),
    areaFit: document.getElementById('areaFit'),
    areaMsg: document.getElementById('areaMsg'),
    btnCombo: document.getElementById('tCombo'),
    comboPanel: document.getElementById('comboPanel'),
    comboName: document.getElementById('comboName'),
    comboPrice: document.getElementById('comboPrice'),
    comboId: document.getElementById('comboId'),
    comboToken: document.getElementById('comboToken'),
    comboInfo: document.getElementById('comboInfo'),
    comboHint: document.getElementById('comboHint'),
    comboClear: document.getElementById('comboClear'),
    comboSave: document.getElementById('comboSave'),
    comboExit: document.getElementById('comboExit'),
    shopToken: document.getElementById('shopToken'),
    shopRefresh: document.getElementById('shopRefresh'),
    shopList: document.getElementById('shopList'),
    shopId: document.getElementById('shopId'),
    shopName: document.getElementById('shopName'),
    shopKind: document.getElementById('shopKind'),
    shopPrice: document.getElementById('shopPrice'),
    shopDesc: document.getElementById('shopDesc'),
    shopFile: document.getElementById('shopFile'),
    shopUrl: document.getElementById('shopUrl'),
    shopFormHint: document.getElementById('shopFormHint'),
    shopSave: document.getElementById('shopSave'),
    shopCancel: document.getElementById('shopCancel'),
    cStep: document.getElementById('cStep'),
    cMax: document.getElementById('cMax'),
    cMultiBtn: document.getElementById('cMultiBtn'),
    cMultiInfo: document.getElementById('cMultiInfo'),
    cHullBtn: document.getElementById('cHullBtn'),
    cHullInfo: document.getElementById('cHullInfo'),
    cMode: document.getElementById('cMode'),
    cSimpleArea: document.getElementById('cSimpleArea'),
    cGridBtn: document.getElementById('cGridBtn'),
    cGridInfo: document.getElementById('cGridInfo'),
    cList: document.getElementById('cList'),
    cClearAll: document.getElementById('cClearAll'),
    btnAddPointLight: document.getElementById('btnAddPointLight'),
    btnAddAreaLight: document.getElementById('btnAddAreaLight'),
    lightList: document.getElementById('lightList'),
    lightEditor: document.getElementById('lightEditor'),
    lightPointFields: document.getElementById('lightPointFields'),
    lightAreaFields: document.getElementById('lightAreaFields'),
    lX: document.getElementById('lX'),
    lY: document.getElementById('lY'),
    lZ: document.getElementById('lZ'),
    lColor: document.getElementById('lColor'),
    lIntensity: document.getElementById('lIntensity'),
    lDistance: document.getElementById('lDistance'),
    lDecay: document.getElementById('lDecay'),
    lWidth: document.getElementById('lWidth'),
    lHeight: document.getElementById('lHeight'),
    lRotY: document.getElementById('lRotY'),
    lRotX: document.getElementById('lRotX'),
    lDel: document.getElementById('lDel'),
  };

  // ---------- 可编辑对象：游戏景物 + 地形/道路/墙体 ----------
  function adoptGameScenery() {
    // buildScenery 与游戏共用同一份构建逻辑，返回统一的可编辑根列表，
    // 数组下标即稳定 key（两侧顺序一致），用于保存/还原景物变换。
    const groups = buildScenery(scene);
    groups.forEach((child, key) => {
      const rec = {
        id: nextId(), key, kind: 'scenery', name: child.name || '景物',
        x: child.position.x, y: child.position.y, z: child.position.z,
        rotY: child.rotation.y,
        scale: { x: child.scale.x, y: child.scale.y, z: child.scale.z },
        obj: child,
      };
      tagId(rec);
      state.scenery.push(rec);
    });
  }

  // 从对象的当前矩阵读回 rec 的字段（供 gizmo 拖动的 objectChange 使用）
  function readTransformFromObject(rec) {
    rec.x = rec.obj.position.x;
    rec.y = rec.obj.position.y;
    rec.z = rec.obj.position.z;
    rec.rotY = rec.obj.rotation.y;
    rec.scale = { x: rec.obj.scale.x, y: rec.obj.scale.y, z: rec.obj.scale.z };
    StepUI.stX.textContent = rec.x.toFixed(1);
    StepUI.stZ.textContent = rec.z.toFixed(1);
    if (state.selected === rec) syncPropsUI();
    markDirty();
  }

  // ---------- 幽灵 ----------
  function resetGhost() {
    if (state.ghost) { scene.remove(state.ghost); state.ghost = null; }
    if (state.mode !== 'place') return;
    state.ghost = new THREE.Group();
    state.ghost.add(makeRing());
    scene.add(state.ghost);
    // 空碰撞体放置：幽灵只显示圆环，不加载模型
    if (state.currentUrl && !state.placingEmpty) {
      instantiate(state.currentUrl)
        .then((m) => { if (state.ghost) { state.ghost.clear(); state.ghost.add(makeRing()); state.ghost.add(m); enableShadows(m); } })
        .catch(() => {});
    }
  }

  function makeRing() {
    const r = new THREE.Mesh(
      new THREE.RingGeometry(0.7, 1.0, 40),
      new THREE.MeshBasicMaterial({ color: 0x4aa3ff, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthTest: false })
    );
    r.rotation.x = -Math.PI / 2;
    r.position.y = 0.02;
    r.renderOrder = 999; // 图层置顶：放置圆环始终画在最上层
    return r;
  }

  // ---------- 位置拾取 ----------
  function controlOffset(clientX, clientY) {
    const r = vp.getBoundingClientRect();
    ndc.x = ((clientX - r.left) / r.width) * 2 - 1;
    ndc.y = -(((clientY - r.top) / r.height) * 2 - 1);
  }
  function groundPos(clientX, clientY, out) {
    controlOffset(clientX, clientY);
    raycaster.setFromCamera(ndc, camera);
    return raycaster.ray.intersectPlane(groundPlane, out);
  }
  function snapVal(v) {
    if (!StepUI.snap.checked) return v;
    const s = parseFloat(StepUI.snapStep.value) || 1;
    return Math.round(v / s) * s;
  }

  // ---------- 场地边界（空气墙）----------
  // 边界 = 一圈看不见但挡人的墙，本质是「一个矩形」（四边独立，可以不对称于原点）。
  // 游戏运行时读的是同一份数据（world/Boundary.js）：
  //   · 真正挡人的是 PlayerPhysics 的四边夹取；「画出实墙」只是把它画出来，方便定位
  //   · 保存场景时写进 boundary 字段，游戏刷新即生效；没保存过就沿用地面范围 = 行为不变
  // 编辑入口：工具栏「边界」→ 俯视全览 → 拖青绿板（移动该边）/ 拖橙色角球（同时改两边）/ 右侧面板填数值
  const boundaryGroup = new THREE.Group();
  boundaryGroup.name = 'editor-boundary';
  boundaryGroup.visible = false;
  scene.add(boundaryGroup);

  // 地面参考轮廓（只读）：提示「地面到底多大」，方便把墙贴上去
  {
    const d = defaultBoundary();
    const pts = [
      new THREE.Vector3(d.minX, 0.02, d.minZ), new THREE.Vector3(d.maxX, 0.02, d.minZ),
      new THREE.Vector3(d.maxX, 0.02, d.maxZ), new THREE.Vector3(d.minX, 0.02, d.maxZ),
      new THREE.Vector3(d.minX, 0.02, d.minZ),
    ];
    const ref = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineDashedMaterial({ color: 0x7d8894, dashSize: 5, gapSize: 4, depthTest: false })
    );
    ref.computeLineDistances();
    ref.renderOrder = 998;
    boundaryGroup.add(ref);
  }

  const B_EDGE_COLOR = 0x35d0a5;   // 边界板（青绿）
  const B_CORNER_COLOR = 0xffa23d; // 角点手柄（橙）
  const B_HL_COLOR = 0x4ea1ff;     // 命中/拖拽高亮（蓝）

  // 四块板：单位盒 + scale，改尺寸只改 scale，不重建几何（拖拽时每帧都会走这条路）
  const bPlates = boundaryWallSpecs(defaultBoundary(), BOUNDARY_THICKNESS).map((sp) => {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: B_EDGE_COLOR, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthTest: false, depthWrite: false })
    );
    m.userData.boundaryEdge = sp.side;
    m.renderOrder = 996;
    boundaryGroup.add(m);
    return m;
  });

  // 拾取条：俯视全览时场地有 300 多米宽、而墙只有半米厚 —— 屏幕上不到 1 像素，根本点不中。
  // 所以每面墙再叠一根「看不见但加厚」的条，专门用来接鼠标；高亮仍然做在 bPlates 上。
  // 不透明度 0 的 mesh 不参与显示，但射线照样能打到（材质不参与 raycast 判定）。
  const bPickerMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthTest: false, depthWrite: false });
  const bPickers = boundaryWallSpecs(defaultBoundary(), BOUNDARY_THICKNESS).map((sp) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), bPickerMat);
    m.userData.boundaryEdge = sp.side;
    boundaryGroup.add(m);
    return m;
  });

  // 四个角球：拖它同时改相邻两边
  const bCorners = [
    { keys: ['minX', 'minZ'], mesh: null },
    { keys: ['maxX', 'minZ'], mesh: null },
    { keys: ['maxX', 'maxZ'], mesh: null },
    { keys: ['minX', 'maxZ'], mesh: null },
  ];
  for (const c of bCorners) {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 12),
      new THREE.MeshBasicMaterial({ color: B_CORNER_COLOR, depthTest: false })
    );
    m.userData.boundaryCorner = c.keys;
    m.renderOrder = 999;
    boundaryGroup.add(m);
    c.mesh = m;
  }

  // 边界轮廓线（贴地画一圈；y 抬一点避免和地面打架）
  const _bPts = new Float32Array(15);
  const bOutline = new THREE.Line(
    new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(_bPts, 3)),
    new THREE.LineBasicMaterial({ color: B_EDGE_COLOR, depthTest: false })
  );
  bOutline.renderOrder = 997;
  boundaryGroup.add(bOutline);

  // 面板数值回填：正在输入的框不要覆盖（否则打字打到一半会被改写）
  function setFieldValue(el, v) {
    if (!el || document.activeElement === el) return;
    el.value = Number(v.toFixed(2));
  }

  function syncBoundaryPanel() {
    const b = state.boundary;
    if (!StepUI.bInfo) return;
    const sp = boundarySpan(b);
    const d = defaultBoundary();
    const sameAsGround = Math.abs(b.minX - d.minX) < 0.01 && Math.abs(b.maxX - d.maxX) < 0.01
      && Math.abs(b.minZ - d.minZ) < 0.01 && Math.abs(b.maxZ - d.maxZ) < 0.01;
    StepUI.bInfo.textContent =
      '范围 ' + sp.w.toFixed(1) + ' × ' + sp.d.toFixed(1) + ' 米'
      + (sameAsGround ? '（正好是地面边缘）' : '（地面是 ' + (d.maxX - d.minX) + ' × ' + (d.maxZ - d.minZ) + '）')
      + ' · 边界外走不出去，也丢不出去（掉落物会回弹）';
    setFieldValue(StepUI.bMinX, b.minX);
    setFieldValue(StepUI.bMaxX, b.maxX);
    setFieldValue(StepUI.bMinZ, b.minZ);
    setFieldValue(StepUI.bMaxZ, b.maxZ);
    setFieldValue(StepUI.bHeight, b.wallHeight);
    if (StepUI.bShow) StepUI.bShow.checked = !!b.showWalls;
    if (StepUI.bFocus) StepUI.bFocus.checked = !!state.boundaryFocus;
    if (StepUI.bHint) {
      StepUI.bHint.textContent = b.showWalls
        ? '「画出实墙」已开：游戏里会沿边界画一圈半透明墙，看得见边界在哪。'
        : '当前是纯空气墙：游戏里看不见，但走到边界就会被挡住。想看墙在哪就勾「画出实墙」。';
    }
  }

  // 边界变化后刷新可视化 + 面板（拖拽 / 手填 / 按钮都汇聚到这里）
  function refreshBoundaryViz() {
    const b = state.boundary;
    const h = b.wallHeight;
    const specs = boundaryWallSpecs(b, BOUNDARY_THICKNESS);
    // 场地尺度：拾取条粗细与角球大小都跟着它走，大场地才点得中、小场地才不糊住
    const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ, 10);
    const pickT = Math.max(2, span / 120);
    const cr = Math.min(Math.max(span / 45, 0.9), 10);
    bPlates.forEach((m, i) => {
      const sp = specs[i];
      m.position.set(sp.cx, h / 2, sp.cz);
      m.scale.set(sp.hx * 2, h, sp.hz * 2);
    });
    bPickers.forEach((m, i) => {
      const sp = specs[i];
      const alongX = sp.side === '+x' || sp.side === '-x'; // 这两面墙的厚度沿 x，长度沿 z
      m.position.set(sp.cx, h / 2, sp.cz);
      m.scale.set(alongX ? pickT : sp.hx * 2, h, alongX ? sp.hz * 2 : pickT);
    });
    for (const c of bCorners) {
      c.mesh.position.set(b[c.keys[0]], Math.max(cr * 0.9, 1.2), b[c.keys[1]]);
      c.mesh.scale.setScalar(cr);
    }
    const y = 0.05;
    _bPts.set([
      b.minX, y, b.minZ, b.maxX, y, b.minZ, b.maxX, y, b.maxZ, b.minX, y, b.maxZ, b.minX, y, b.minZ,
    ]);
    bOutline.geometry.attributes.position.needsUpdate = true;
    bOutline.geometry.computeBoundingSphere();
    syncBoundaryPanel();
  }

  // 改边界：先过 normalizeBoundary（非法值夹回、跨度太小往外撑），再刷新可视化
  function setBoundary(next, opts) {
    const norm = normalizeBoundary({ ...state.boundary, ...next });
    if (norm) state.boundary = norm;
    refreshBoundaryViz();
    if (!(opts && opts.silent)) markDirty();
  }

  // 「只看边界」：把模型/景物/光源藏起来，拖板子时不会被建筑挡视线
  function applyBoundaryFocus(on) {
    state.boundaryFocus = !!on;
    const vis = !state.boundaryFocus;
    for (const rec of state.placed) if (rec.obj) rec.obj.visible = vis;
    for (const rec of state.scenery) if (rec.obj) rec.obj.visible = vis;
    for (const rec of state.lights) {
      if (rec.obj) rec.obj.visible = vis;
      if (rec.helper) rec.helper.visible = vis;
    }
    if (StepUI.bFocus) StepUI.bFocus.checked = state.boundaryFocus;
  }

  // 退出边界模式：所有东西无条件恢复可见（它们原本都是可见的）
  function restoreAllVisible() {
    state.boundaryFocus = false;
    state.trackFocus = false;
    for (const rec of state.placed) if (rec.obj) rec.obj.visible = true;
    for (const rec of state.scenery) if (rec.obj) rec.obj.visible = true;
    for (const rec of state.lights) {
      if (rec.obj) rec.obj.visible = true;
      if (rec.helper) rec.helper.visible = true;
    }
  }

  // 俯视全览：正上方往下看，整块场地刚好进画面（fov 55° → 距离取 1.15 倍跨度）
  let boundaryCamBackup = null;
  function frameBoundaryTop() {
    const b = state.boundary;
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;
    const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ, 20);
    camera.position.set(cx, span * 1.15, cz + 0.001); // +0.001 避免正上方时 OrbitControls 的 up 退化
    controls.target.set(cx, 0, cz);
    controls.update();
  }

  function pickBoundaryHandle(clientX, clientY) {
    controlOffset(clientX, clientY);
    raycaster.setFromCamera(ndc, camera);
    const corners = raycaster.intersectObjects(bCorners.map((c) => c.mesh), false);
    if (corners.length) return { kind: 'corner', keys: corners[0].object.userData.boundaryCorner };
    const plates = raycaster.intersectObjects(bPickers, false); // 命中加厚的隐形拾取条
    if (plates.length) return { kind: 'edge', side: plates[0].object.userData.boundaryEdge };
    return null;
  }

  function setBoundaryHover(hitData) {
    const side = hitData && hitData.kind === 'edge' ? hitData.side : null;
    const keys = hitData && hitData.kind === 'corner' ? hitData.keys : null;
    for (const m of bPlates) {
      const hot = m.userData.boundaryEdge === side;
      m.material.color.setHex(hot ? B_HL_COLOR : B_EDGE_COLOR);
      m.material.opacity = hot ? 0.34 : 0.18;
    }
    for (const c of bCorners) {
      const hot = !!keys && c.keys[0] === keys[0] && c.keys[1] === keys[1];
      c.mesh.material.color.setHex(hot ? B_HL_COLOR : B_CORNER_COLOR);
    }
  }

  function onBoundaryDown(e) {
    if (e.button !== 0) return;
    const h = pickBoundaryHandle(e.clientX, e.clientY);
    if (!h) return;
    state.boundaryDrag = h;
    controls.enabled = false; // 拖边界时别同时把视角也转了
    setBoundaryHover(h);
  }

  function onBoundaryMove(e) {
    if (!state.boundaryDrag) {
      const h = pickBoundaryHandle(e.clientX, e.clientY);
      setBoundaryHover(h);
      renderer.domElement.style.cursor = h ? 'grab' : 'default'; // 告诉用户「这里能拖」
      return;
    }
    renderer.domElement.style.cursor = 'grabbing';
    const p = groundPos(e.clientX, e.clientY, hit);
    if (!p) return;
    const b = state.boundary;
    const d = state.boundaryDrag;
    const next = {};
    if (d.kind === 'edge') {
      const v = snapVal(d.side === '+x' || d.side === '-x' ? p.x : p.z);
      if (d.side === '+x') next.maxX = Math.max(v, b.minX + BOUNDARY_MIN_SPAN);
      else if (d.side === '-x') next.minX = Math.min(v, b.maxX - BOUNDARY_MIN_SPAN);
      else if (d.side === '+z') next.maxZ = Math.max(v, b.minZ + BOUNDARY_MIN_SPAN);
      else next.minZ = Math.min(v, b.maxZ - BOUNDARY_MIN_SPAN);
    } else {
      const x = snapVal(p.x);
      const z = snapVal(p.z);
      if (d.keys[0] === 'minX') next.minX = Math.min(x, b.maxX - BOUNDARY_MIN_SPAN);
      else next.maxX = Math.max(x, b.minX + BOUNDARY_MIN_SPAN);
      if (d.keys[1] === 'minZ') next.minZ = Math.min(z, b.maxZ - BOUNDARY_MIN_SPAN);
      else next.maxZ = Math.max(z, b.minZ + BOUNDARY_MIN_SPAN);
    }
    setBoundary(next);
    setBoundaryHover(d);
  }

  function onBoundaryUp() {
    if (!state.boundaryDrag) return;
    state.boundaryDrag = null;
    controls.enabled = true;
    renderer.domElement.style.cursor = 'default';
    markDirty();
  }

  // 面板事件：四个边数值 / 墙高 / 两个勾选 / 三个按钮
  [['bMinX', 'minX'], ['bMaxX', 'maxX'], ['bMinZ', 'minZ'], ['bMaxZ', 'maxZ']].forEach(([id, key]) => {
    const el = StepUI[id];
    if (!el) return;
    el.addEventListener('input', () => {
      const v = parseFloat(el.value);
      if (Number.isFinite(v)) setBoundary({ [key]: v });
    });
  });
  if (StepUI.bHeight) StepUI.bHeight.addEventListener('input', () => {
    const v = parseFloat(StepUI.bHeight.value);
    if (Number.isFinite(v)) setBoundary({ wallHeight: v });
  });
  if (StepUI.bShow) StepUI.bShow.onchange = () => setBoundary({ showWalls: StepUI.bShow.checked });
  if (StepUI.bFocus) StepUI.bFocus.onchange = () => applyBoundaryFocus(StepUI.bFocus.checked);
  if (StepUI.bFrame) StepUI.bFrame.onclick = () => frameBoundaryTop();
  if (StepUI.bFit) StepUI.bFit.onclick = () => setBoundary(defaultBoundary()); // 贴合地面边缘
  if (StepUI.bShrink) StepUI.bShrink.onclick = () => {
    const b = state.boundary;
    setBoundary({ minX: b.minX + 5, maxX: b.maxX - 5, minZ: b.minZ + 5, maxZ: b.maxZ - 5 });
  };
  refreshBoundaryViz();

  // ---------- 放置 ----------
  function place() {
    const gp = state.ghost ? state.ghost.position : null;
    // 空碰撞体放置：复用放置模式的圆环落点
    if (state.placingEmpty) {
      addEmptyCollider(gp ? gp.x : 0, gp ? gp.z : 0);
      return;
    }
    if (!state.currentUrl) return;
    const obj = new THREE.Group();
    const item = {
      id: nextId(), kind: state.imported.some((it) => it.url === state.currentUrl) ? 'import' : 'builtin',
      name: state.currentLabel, url: state.currentUrl,
      x: gp ? gp.x : 0, y: 0, z: gp ? gp.z : 0, rotY: 0,
      scale: { x: 1, y: 1, z: 1 }, collisionMode: 'simple', collider: defaultCollider(), obj,
    };
    obj.name = item.name;
    scene.add(obj);
    obj.position.copy(state.ghost.position);
    tagId(item);
    // 放置即显示默认矩形碰撞体线框，模型异步加载完成后自动贴合实际尺寸
    state.placed.push(item);
    buildColliderVis(item);
    select(item);
    markDirty();
    outlinerUpdate();
    instantiate(state.currentUrl).then((m) => { obj.add(m); enableShadows(m); autoFitCollider(item); }).catch(() => {});
  }

  function enableShadows(m) {
    m.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  }

  // 是否位于碰撞体可视化节点（collider-vis*）内部：这些橙色的体积盒/凸包是「可视化产物」，
  // 不能当成模型参与任何几何抽取（否则会越生成越大）。
  function underColliderVis(o) {
    let p = o;
    while (p) {
      if (typeof p.name === 'string' && p.name.startsWith('collider-vis')) return true;
      p = p.parent;
    }
    return false;
  }

  // 重建选中对象的碰撞体线框（挂到对象本地空间，随模型变换/缩放）。
  // 支持两种形态：单盒 rec.collider（细线框）与多盒 rec.colliders（半透明体积+描边，共用一个父节点），可并存。
  function buildColliderVis(rec) {
    const holder = rec.obj;
    if (!holder) return;
    // 统一的容器：collider-vis（含带后缀的改名节点）内的子项会在重建时整体移除
    const stale = [];
    holder.children.forEach((ch) => {
      if (typeof ch.name === 'string' && ch.name.startsWith('collider-vis')) stale.push(ch);
    });
    stale.forEach((ch) => holder.remove(ch));
    // 盒的可视化统一走这里：支持逐盒 ox/oy/oz 偏移与可选四元数（P1 新增字段），
    // 没有 ox/oz/q 时退化为旧的「只有 oy 的轴对齐盒」行为。
    const applyBoxXform = (obj, c) => {
      obj.position.set(c.ox ?? 0, c.oy ?? 0, c.oz ?? 0);
      if (typeof c.qw === 'number') obj.quaternion.set(c.qx ?? 0, c.qy ?? 0, c.qz ?? 0, c.qw).normalize();
      return obj;
    };
    // 选中高亮：state.selColl = { kind, i }（kind: box/hull/sbox/shull）。
    // 选中项用亮蓝色 + 关闭 depthTest 显示 —— 即使被模型包住也能「穿透」看到，并拉高 renderOrder 画在最上层。
    const sel = state.selColl;
    const BASE = 0xff8c3d; // 默认橙
    const HL = 0x4ea1ff; // 选中高亮色
    const isSel = (kind, i) => !!sel && sel.kind === kind && sel.i === i;
    const styleMat = (m, kind, i) => {
      if (!isSel(kind, i)) return m;
      m.color.setHex(HL);
      m.depthTest = false; // 穿透模型
      m.depthWrite = false;
      m.transparent = true;
      return m;
    };
    const finish = (obj, kind, i) => {
      if (isSel(kind, i)) obj.renderOrder = 999;
      return obj;
    };
    const makeWire = (c, kind, i) => {
      const box = new THREE.EdgesGeometry(new THREE.BoxGeometry(c.hx * 2, c.hy * 2, c.hz * 2));
      const wire = new THREE.LineSegments(box, styleMat(new THREE.LineBasicMaterial({ color: BASE }), kind, i));
      applyBoxXform(wire, c);
      return finish(wire, kind, i);
    };
    // 半透明填充盒 + 描边：让多盒整体呈现为贴合模型的通透体积，结构清晰
    const makeVolume = (c, kind, i) => {
      const hi = isSel(kind, i);
      const g = new THREE.Group();
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(c.hx * 2, c.hy * 2, c.hz * 2),
        styleMat(new THREE.MeshBasicMaterial({ color: BASE, transparent: true, opacity: hi ? 0.34 : 0.18, depthWrite: false }), kind, i)
      );
      const wire = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(c.hx * 2, c.hy * 2, c.hz * 2)),
        styleMat(new THREE.LineBasicMaterial({ color: BASE }), kind, i)
      );
      g.add(mesh); g.add(wire);
      applyBoxXform(g, c);
      return finish(g, kind, i);
    };
    const makeConvex = (hull, kind, i) => {
      const hi = isSel(kind, i);
      const bg = new THREE.BufferGeometry();
      bg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(hull.vertices), 3));
      bg.setIndex(hull.faces);
      bg.computeVertexNormals();
      const g = new THREE.Group();
      g.add(new THREE.Mesh(bg, styleMat(new THREE.MeshBasicMaterial({ color: BASE, transparent: true, opacity: hi ? 0.34 : 0.18, depthWrite: false, side: THREE.DoubleSide }), kind, i)));
      g.add(new THREE.LineSegments(new THREE.EdgesGeometry(bg.clone()), styleMat(new THREE.LineBasicMaterial({ color: BASE }), kind, i)));
      return finish(g, kind, i);
    };
    const boxen = [];
    const multi = Array.isArray(rec.colliders) && rec.colliders.length;
    const parts = Array.isArray(rec.convexParts) && rec.convexParts.length;
    const singleHull = !!(rec.convex && Array.isArray(rec.convex.vertices) && Array.isArray(rec.convex.faces) && rec.convex.faces.length >= 3);
    // 盒与凸包可以并存（simple 逐网格生成会同时产出两类），两类都画；
    // 旧数据（V-HACD 只有凸分解 / 只有单盒）行为不变。
    if (multi) {
      rec.colliders.forEach((c, i) => boxen.push(makeVolume(c, 'box', i)));
    }
    if (parts) {
      rec.convexParts.forEach((h, i) => boxen.push(makeConvex(h, 'hull', i)));
    } else if (singleHull) {
      boxen.push(makeConvex(rec.convex, 'shull', 0));
    }
    if (!multi && !parts && !singleHull) {
      const c = rec.collider;
      if (!c || !c.enabled) return;
      boxen.push(makeWire(c, 'sbox', 0));
    }
    let name = 'collider-vis';
    const tag = [];
    if (parts) tag.push('凸分解 ' + rec.convexParts.length + ' 段');
    else if (singleHull) tag.push('凸包 ' + (rec.convex.faces.length / 3) + ' 面');
    if (multi) tag.push('多盒 ' + rec.colliders.length);
    if (tag.length) name = 'collider-vis（' + tag.join(' / ') + '）';
    const vis = new THREE.Group();
    vis.name = name;
    boxen.forEach((w) => vis.add(w));
    holder.add(vis);
  }

  // 自适应碰撞体：遍历模型网格，按包围盒在对象本地(未缩放)空间求尺寸并写入 rec.collider。
  // 这样碰撞体会贴合模型，且在三轴缩放后仍随模型一致（本地尺寸 × scale = 世界尺寸）。
  function autoFitCollider(rec) {
    const holder = rec.obj;
    if (!holder) return;
    if (!rec.collider) rec.collider = defaultCollider();
    const box = new THREE.Box3();
    holder.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(holder.matrixWorld).invert();
    holder.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      if (underColliderVis(o)) return; // 跳过碰撞体可视化产物
      o.geometry.computeBoundingBox();
      const gb = o.geometry.boundingBox;
      if (!gb) return;
      // 把几何体包围盒变换到 holder 的本地坐标（抵消 holder 自身的位置/旋转/缩放）
      const t = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
      const b = new THREE.Box3().copy(gb).applyMatrix4(t);
      box.union(b);
    });
    if (box.isEmpty()) return;
    const c = rec.collider;
    c.enabled = true;
    c.hx = Math.max(0.01, (box.max.x - box.min.x) / 2);
    c.hy = Math.max(0.01, (box.max.y - box.min.y) / 2);
    c.hz = Math.max(0.01, (box.max.z - box.min.z) / 2);
    c.oy = box.min.y + (box.max.y - box.min.y) / 2;
    buildColliderVis(rec);
    if (state.selected === rec) syncColliderUI(rec);
    markDirty();
  }

  // 自动多盒：把模型实际占用部分体素化后贪心合盒，写入 rec.colliders 数组（本地未缩放空间）。
  // step = 体素步长（米）；cap = 盒数量上限。盒按 {hx,hy,hz,oy}（半尺寸+中心高）存储，语义同单盒。
  function buildMultiColliders(rec, step, cap) {
    const holder = rec.obj;
    if (!holder) return;
    // 1) 收集所有 mesh 的本地三角形（把几何顶点变换到 holder 本地空间）
    const tris = [];
    holder.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(holder.matrixWorld).invert();
    const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
    holder.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      if (underColliderVis(o)) return; // 跳过碰撞体可视化产物
      const geo = o.geometry;
      const pos = geo.attributes.position;
      if (!pos) return;
      const mtx = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
      const idx = geo.index;
      if (idx) {
        for (let i = 0; i < idx.count; i += 3) {
          vA.fromBufferAttribute(pos, idx.getX(i)).applyMatrix4(mtx);
          vB.fromBufferAttribute(pos, idx.getX(i + 1)).applyMatrix4(mtx);
          vC.fromBufferAttribute(pos, idx.getX(i + 2)).applyMatrix4(mtx);
          tris.push([vA.clone(), vB.clone(), vC.clone()]);
        }
      } else {
        for (let i = 0; i < pos.count; i += 3) {
          vA.fromBufferAttribute(pos, i).applyMatrix4(mtx);
          vB.fromBufferAttribute(pos, i + 1).applyMatrix4(mtx);
          vC.fromBufferAttribute(pos, i + 2).applyMatrix4(mtx);
          tris.push([vA.clone(), vB.clone(), vC.clone()]);
        }
      }
    });
    if (!tris.length) {
      StepUI.cMultiInfo.textContent = '该对象暂无可用网格（模型可能仍在加载，或这是一个空碰撞体）';
      StepUI.cMultiInfo.style.display = 'inline';
      return;
    }

    // 2) 总体包围盒（本地坐标），据此建体素网格
    const bmin = new THREE.Vector3(Infinity, Infinity, Infinity);
    const bmax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (const t of tris) for (const p of t) { bmin.min(p); bmax.max(p); }
    step = Math.max(0.05, Number(step) || 0.25);
    cap = Math.max(1, Math.min(64, Math.floor(Number(cap) || 12)));
    // 网格尺寸（含步长自适应，避免尺寸过小导致格数爆炸）
    const nx = Math.max(1, Math.ceil((bmax.x - bmin.x) / step));
    const ny = Math.max(1, Math.ceil((bmax.y - bmin.y) / step));
    const nz = Math.max(1, Math.ceil((bmax.z - bmin.z) / step));
    if (nx * ny * nz > 400000) step = Math.max(0.05, step * 1.5); // 极端大模型降采样保护
    // 记录真实步长（含自适应）+ 起点
    const sx = nx > 1 ? (bmax.x - bmin.x) / nx : step;
    const sy = ny > 1 ? (bmax.y - bmin.y) / ny : step;
    const sz = nz > 1 ? (bmax.z - bmin.z) / nz : step;

    // 3) 体素占用：三角形落入的格子标记为实心
    const occ = new Uint8Array(nx * ny * nz);
    const OCC = (i, j, k) => occ[(i * ny + j) * nz + k];
    for (const [a, b, c] of tris) {
      const tmin = new THREE.Vector3(Math.min(a.x, b.x, c.x), Math.min(a.y, b.y, c.y), Math.min(a.z, b.z, c.z));
      const tmax = new THREE.Vector3(Math.max(a.x, b.x, c.x), Math.max(a.y, b.y, c.y), Math.max(a.z, b.z, c.z));
      const i0 = Math.max(0, Math.floor((tmin.x - bmin.x) / sx)), i1 = Math.min(nx - 1, Math.floor((tmax.x - bmin.x) / sx));
      const j0 = Math.max(0, Math.floor((tmin.y - bmin.y) / sy)), j1 = Math.min(ny - 1, Math.floor((tmax.y - bmin.y) / sy));
      const k0 = Math.max(0, Math.floor((tmin.z - bmin.z) / sz)), k1 = Math.min(nz - 1, Math.floor((tmax.z - bmin.z) / sz));
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          for (let k = k0; k <= k1; k++) {
            if (OCC(i, j, k)) continue;
            // 格心
            const p = new THREE.Vector3(
              bmin.x + (i + 0.5) * sx,
              bmin.y + (j + 0.5) * sy,
              bmin.z + (k + 0.5) * sz
            );
            if (ptInTri(p, a, b, c, sx, sy, sz)) occ[(i * ny + j) * nz + k] = 1;
          }
        }
      }
    }

    // 4) 最大实心盒铺盖（UE 自动凸类比的缩水版）：反复找一块「全部实心、未被覆盖」的最大长方体，
    //    盖住尽可能多未覆盖格，镂空/凸台会被自然拆成多个大盒，而非细碎长条。
    const covered = new Uint8Array(nx * ny * nz);
    const CVR = (i, j, k) => covered[(i * ny + j) * nz + k];
    // 判断第 (i,j,k) 层（沿 di/dj/dk 方向薄片）是否全为实心，且在当前盒范围内
    function slabOccupied(i, j, k, di, dj, dk, i0, i1, j0, j1, k0, k1) {
      // 判断第 (i,j,k) 层（沿 di/dj/dk 方向薄片）是否全为实心，且在当前盒范围内
      const a0 = di !== 0 ? i : i0, a1 = di !== 0 ? i : i1;
      const b0 = dj !== 0 ? j : j0, b1 = dj !== 0 ? j : j1;
      const c0 = dk !== 0 ? k : k0, c1 = dk !== 0 ? k : k1;
      for (let u = a0; u <= a1; u++) {
        for (let v = b0; v <= b1; v++) {
          for (let w = c0; w <= c1; w++) {
            if (!OCC(u, v, w)) return false;
          }
        }
      }
      return true;
    }
    // 从种子格起贪心扩张成一个「尽最大」的实心盒（任一方向不可再扩即停）
    function growMaxBox(i0, j0, k0) {
      let i0b = i0, i1b = i0, j0b = j0, j1b = j0, k0b = k0, k1b = k0;
      let changed = true;
      while (changed) {
        changed = false;
        if (i1b + 1 < nx && slabOccupied(i1b + 1, j0b, k0b, 1, 0, 0, i0b, i1b, j0b, j1b, k0b, k1b)) { i1b++; changed = true; }
        if (i0b - 1 >= 0 && slabOccupied(i0b - 1, j0b, k0b, -1, 0, 0, i0b, i1b, j0b, j1b, k0b, k1b)) { i0b--; changed = true; }
        if (j1b + 1 < ny && slabOccupied(i0b, j1b + 1, k0b, 0, 1, 0, i0b, i1b, j0b, j1b, k0b, k1b)) { j1b++; changed = true; }
        if (j0b - 1 >= 0 && slabOccupied(i0b, j0b - 1, k0b, 0, -1, 0, i0b, i1b, j0b, j1b, k0b, k1b)) { j0b--; changed = true; }
        if (k1b + 1 < nz && slabOccupied(i0b, j0b, k1b + 1, 0, 0, 1, i0b, i1b, j0b, j1b, k0b, k1b)) { k1b++; changed = true; }
        if (k0b - 1 >= 0 && slabOccupied(i0b, j0b, k0b - 1, 0, 0, -1, i0b, i1b, j0b, j1b, k0b, k1b)) { k0b--; changed = true; }
      }
      // 标记覆盖并返回盒（格子坐标）
      for (let i = i0b; i <= i1b; i++) for (let j = j0b; j <= j1b; j++) for (let k = k0b; k <= k1b; k++) covered[(i * ny + j) * nz + k] = 1;
      return { i0: i0b, i1: i1b, j0: j0b, j1: j1b, k0: k0b, k1: k1b };
    }
    const boxes = [];
    for (let i = 0; i < nx && boxes.length < 96; i++) {
      for (let j = 0; j < ny; j++) {
        for (let k = 0; k < nz; k++) {
          if (OCC(i, j, k) && !CVR(i, j, k)) {
            const b = growMaxBox(i, j, k);
            // 转体积盒（中心 + 半尺寸，本地未缩放空间）
            const x = bmin.x + ((b.i0 + b.i1 + 1) / 2) * sx;
            const y = bmin.y + ((b.j0 + b.j1 + 1) / 2) * sy;
            const z = bmin.z + ((b.k0 + b.k1 + 1) / 2) * sz;
            boxes.push({
              x, y, z,
              hx: (((b.i1 - b.i0 + 1) * sx)) / 2,
              hy: (((b.j1 - b.j0 + 1) * sy)) / 2,
              hz: (((b.k1 - b.k0 + 1) * sz)) / 2,
            });
          }
        }
      }
    }

    // 5) 数量封顶：超 cap 时反复合并「合并后 AABB 增量空体积最小」的两盒，直到 ≤ cap
    while (boxes.length > cap) {
      let bi = 0, bj = 1, bestExtra = Infinity;
      for (let a = 0; a < boxes.length; a++) {
        for (let b = a + 1; b < boxes.length; b++) {
          const A = boxes[a], B = boxes[b];
          const ax0 = Math.min(A.x - A.hx, B.x - B.hx), ax1 = Math.max(A.x + A.hx, B.x + B.hx);
          const ay0 = Math.min(A.y - A.hy, B.y - B.hy), ay1 = Math.max(A.y + A.hy, B.y + B.hy);
          const az0 = Math.min(A.z - A.hz, B.z - B.hz), az1 = Math.max(A.z + A.hz, B.z + B.hz);
          const union = (ax1 - ax0) * (ay1 - ay0) * (az1 - az0);
          const extra = union - (2 * A.hx * A.hy * A.hz) - (0); // 用 union 减两盒体积的近似
          if (extra < bestExtra) { bestExtra = extra; bi = a; bj = b; }
        }
      }
      const A = boxes[bi], B = boxes[bj];
      const ax0 = Math.min(A.x - A.hx, B.x - B.hx), ax1 = Math.max(A.x + A.hx, B.x + B.hx);
      const ay0 = Math.min(A.y - A.hy, B.y - B.hy), ay1 = Math.max(A.y + A.hy, B.y + B.hy);
      const az0 = Math.min(A.z - A.hz, B.z - B.hz), az1 = Math.max(A.z + A.hz, B.z + B.hz);
      const merged = {
        x: (ax0 + ax1) / 2, y: (ay0 + ay1) / 2, z: (az0 + az1) / 2,
        hx: (ax1 - ax0) / 2, hy: (ay1 - ay0) / 2, hz: (az1 - az0) / 2,
      };
      boxes.splice(Math.max(bi, bj), 1);
      boxes.splice(Math.min(bi, bj), 1);
      boxes.push(merged);
    }

    // 6) 写回 colliders（本地未缩放空间半尺寸 + 中心高）
    rec.colliders = boxes.map((b) => ({
      hx: Math.max(0.01, b.hx), hy: Math.max(0.01, b.hy), hz: Math.max(0.01, b.hz),
      oy: b.y, // 中心高即盒中心 y
    }));
    if (rec.collider) rec.collider.enabled = false;
    StepUI.cMultiInfo.textContent = '多盒 ' + rec.colliders.length + ' 个';
    StepUI.cMultiInfo.style.display = 'inline';
    buildColliderVis(rec);
    if (state.selected === rec) syncColliderUI(rec);
    markDirty();
  }

  // 点在三角形内（三维）：把三角形转到最稳定的两个主轴平面投影成 2D 判断，并校验格心到三角形平面距离落在容差内
  function ptInTri(p, a, b, c, sx, sy, sz) {
    const e1 = new THREE.Vector3().subVectors(b, a);
    const e2 = new THREE.Vector3().subVectors(c, a);
    const n = new THREE.Vector3().crossVectors(e1, e2);
    const len = n.length();
    if (len < 1e-9) return false;
    n.multiplyScalar(1 / len); // 单位法向量
    // 点到平面(a,n)的垂直距离 = |n·(p-a)|，n 已归一化
    const d = Math.abs(n.x * (p.x - a.x) + n.y * (p.y - a.y) + n.z * (p.z - a.z));
    // 平面厚度容差取最大步长的 0.55，避免薄片模型漏格
    const tol = Math.max(sx, sy, sz) * 0.55;
    if (d > tol) return false;
    // 投影到绝对坐标最大的主轴平面上做 2D
    const plan = (ax, ay) => {
      const v0 = [a[ax], a[ay]], v1 = [b[ax], b[ay]], v2 = [c[ax], c[ay]], pp = [p[ax], p[ay]];
      return ptInTri2D(pp, v0, v1, v2);
    };
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    if (ax >= ay && ax >= az) return plan(1, 2);
    if (ay >= ax && ay >= az) return plan(0, 2);
    return plan(0, 1);
  }

  // 收集模型所有 mesh 的三角为本地空间（positions Float64Array + indices Uint32Array），供凸分解使用。
  function collectLocalTris(holder) {
    const positions = [];
    const indices = [];
    holder.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(holder.matrixWorld).invert();
    const t = new THREE.Matrix4();
    const v = new THREE.Vector3();
    holder.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      if (underColliderVis(o)) return; // 跳过碰撞体可视化产物
      const pos = o.geometry.attributes.position;
      if (!pos) return;
      t.multiplyMatrices(inv, o.matrixWorld);
      const base = positions.length / 3;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(t);
        positions.push(v.x, v.y, v.z);
      }
      const idx = o.geometry.index;
      if (idx) {
        for (let i = 0; i < idx.count; i++) indices.push(base + idx.getX(i));
      } else {
        for (let i = 0; i < pos.count; i++) indices.push(base + i);
      }
    });
    return { positions: new Float64Array(positions), indices: new Uint32Array(indices) };
  }

  let _decomposer = null; // V-HACD WASM 单例
  async function getDecomposer() {
    if (!_decomposer) _decomposer = await ConvexMeshDecomposition.create();
    return _decomposer;
  }

  // V-HACD 自动凸分解（UE Auto Convex 同款算法）：沿凹度把模型切成若干「凸包」，
  // 贴合凹形/镂空/曲面（区别于旧的轴对齐多盒）。结果存 rec.convexParts=[{vertices,faces}...]，本地空间。
  async function buildVhacdConvexParts(rec, maxHulls) {
    const holder = rec.obj;
    if (!holder) return;
    const { positions, indices } = collectLocalTris(holder);
    if (indices.length < 3) {
      StepUI.cMultiInfo.textContent = '该对象暂无可用网格（模型可能仍在加载）';
      StepUI.cMultiInfo.style.display = 'inline';
      return;
    }
    StepUI.cMultiInfo.textContent = '凸分解中（加载 WASM + 计算）…';
    StepUI.cMultiInfo.style.display = 'inline';
    try {
      const deco = await getDecomposer();
      const hulls = deco.computeConvexHulls(
        { positions, indices },
        {
          maxHulls: Math.max(1, Math.floor(Number(maxHulls) || 16)),
          maxVerticesPerHull: 64,
          voxelResolution: 400000,
          fillMode: 'flood', // 体素填充内部（UE 默认），对中空也不会散成碎壳
          messages: 'none',
        }
      );
      if (!hulls || !hulls.length) {
        StepUI.cMultiInfo.textContent = '未生成凸包';
        StepUI.cMultiInfo.style.display = 'inline';
        return;
      }
      // 写回多凸包（本地空间）
      rec.convexParts = hulls.map((h) => ({
        vertices: Array.from(h.positions),
        faces: Array.from(h.indices),
      }));
      // 凸包优先，禁用其余盒类/单凸包
      if (rec.collider) rec.collider.enabled = false;
      if (rec.colliders && rec.colliders.length) rec.colliders = [];
      if (rec.convex) rec.convex = null;
      buildColliderVis(rec);
      let tri = 0; for (const h of hulls) tri += h.indices.length / 3;
      StepUI.cMultiInfo.textContent = '凸分解 ' + hulls.length + ' 段 / ' + tri + ' 三角';
      StepUI.cMultiInfo.style.display = 'inline';
      if (state.selected === rec) syncColliderUI(rec);
      markDirty();
    } catch (err) {
      StepUI.cMultiInfo.textContent = '凸分解失败：' + (err && err.message ? err.message : err);
      StepUI.cMultiInfo.style.display = 'inline';
      console.error(err);
    }
  }

  // 生成凸包碰撞体：把模型网格顶点（本地未缩放空间）求三维凸包（Quickhull，走 Three 的 ConvexGeometry），
  // 存入 rec.convex = { vertices:[x,y,z,...], faces:[a,b,c,a,b,c,...] }（本地空间，随模型旋转/缩放）。
  // 凸包贴合任意朝向、带斜面的外形，但对 L 型/镂空凹模型会被凸包整体包裹而膨胀。
  function buildConvexCollider(rec) {
    const holder = rec.obj;
    if (!holder) return;
    // 1) 收集所有 mesh 顶点（本地空间），去重后喂给 ConvexHull
    holder.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(holder.matrixWorld).invert();
    const pts = [];
    const HASH = (x, y, z) => x.toFixed(3) + ',' + y.toFixed(3) + ',' + z.toFixed(3);
    const seen = new Set();
    const v = new THREE.Vector3();
    holder.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      if (underColliderVis(o)) return; // 跳过碰撞体可视化产物
      const pos = o.geometry.attributes.position;
      if (!pos) return;
      const mtx = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mtx);
        const k = HASH(v.x, v.y, v.z);
        if (seen.has(k)) continue;
        seen.add(k);
        pts.push(v.clone());
      }
    });
    if (pts.length < 4) {
      StepUI.cHullInfo.textContent = '顶点不足（<4），无法构成凸包';
      StepUI.cHullInfo.style.display = 'inline';
      return;
    }
    // 2) 三维凸包（Quickhull）：ConvexGeometry 直接接收 Vector3[]，
    //    输出为三角化且顶点按三角形展开的「三角形汤」（无索引，每 3 个定点一个三角形）。
    let geo;
    try {
      geo = new ConvexGeometry(pts);
    } catch (err) {
      StepUI.cHullInfo.textContent = '凸包失败：' + (err && err.message ? err.message : err);
      StepUI.cHullInfo.style.display = 'inline';
      console.error(err);
      return;
    }
    const posAttr = geo.getAttribute('position');
    if (!posAttr || posAttr.count < 3) {
      StepUI.cHullInfo.textContent = '凸包无有效三角面';
      StepUI.cHullInfo.style.display = 'inline';
      return;
    }
    const vCount = posAttr.count;
    // 3) 写回 rec.convex（本地空间）：vertices 三角形汤；faces 用顺序索引 [0,1,2,3,...] 表示三角
    rec.convex = {
      vertices: Array.from(posAttr.array),
      faces: Array.from({ length: vCount }, (_, i) => i),
    };
    // 凸包优先，禁用盒类碰撞体，避免重复阻挡
    if (rec.collider) rec.collider.enabled = false;
    if (rec.colliders && rec.colliders.length) { rec.colliders = []; }
    buildColliderVis(rec);
    if (StepUI.cHullInfo) {
      StepUI.cHullInfo.textContent = '凸包 ' + (vCount / 3) + ' 面 / ' + vCount + ' 点';
      StepUI.cHullInfo.style.display = 'inline';
    }
    if (state.selected === rec) syncColliderUI(rec);
    markDirty();
  }

  // 2D 点是否在三角形内（含边界，重心坐标法）
  function ptInTri2D(p, a, b, c) {
    const d1 = (b[1] - a[1]) * (p[0] - a[0]) - (b[0] - a[0]) * (p[1] - a[1]);
    const d2 = (c[1] - b[1]) * (p[0] - b[0]) - (c[0] - b[0]) * (p[1] - b[1]);
    const d3 = (a[1] - c[1]) * (p[0] - c[0]) - (a[0] - c[0]) * (p[1] - c[1]);
    const neg = (d1 < 0) || (d2 < 0) || (d3 < 0);
    const pos = (d1 > 0) || (d2 > 0) || (d3 > 0);
    return !(neg && pos);
  }

  // 添加一个「空碰撞体」：无可视模型，仅一个橙色线框方块（可拾取/编辑），
  // 数据记入 collider，游戏端据此生成不可见但可阻挡玩家的矩形碰撞体。
  function addEmptyCollider(x = 0, z = 0) {
    const collider = { enabled: true, hx: 1, hy: 1, hz: 1, oy: 0.5 };
    const obj = new THREE.Group();
    const rec = {
      id: nextId(), kind: 'empty', name: '空碰撞体',
      url: null, x, y: 0, z, rotY: 0,
      scale: { x: 1, y: 1, z: 1 }, collisionMode: 'simple', collider, obj,
    };
    obj.name = 'collider-root';
    obj.position.set(x, 0, z);
    scene.add(obj);
    tagId(rec);
    buildColliderVis(rec); // 橙色线框 = 碰撞盒可视提示（线框即拾取目标）
    state.placed.push(rec);
    select(rec);
    markDirty();
    outlinerUpdate();
  }

  // 复制一个对象：原样克隆网格/属性/碰撞体（线框按 collider 重建），返回新 rec
  function duplicateRec(rec, selectIt = false) {
    const obj = new THREE.Group();
    (rec.obj ? rec.obj.children : []).forEach((ch) => {
      if (typeof ch.name === 'string' && ch.name.startsWith('collider-vis')) return; // 线框稍后按 collider 重建
      obj.add(ch.clone(true));
    });
    const copy = {
      id: nextId(), kind: rec.kind, name: rec.name, url: rec.url,
      collisionMode: rec.collisionMode === 'complex' ? 'complex' : 'simple',
      x: rec.x ?? rec.obj.position.x,
      y: rec.y ?? rec.obj.position.y,
      z: rec.z ?? rec.obj.position.z,
      rotY: rec.rotY ?? 0,
      scale: { ...normScale(rec.scale ?? rec.obj.scale) },
      collider: rec.collider ? { enabled: rec.collider.enabled !== false, hx: rec.collider.hx, hy: rec.collider.hy, hz: rec.collider.hz, oy: rec.collider.oy } : defaultCollider(),
      obj,
    };
    obj.name = copy.name;
    applyPlTransform(copy);
    scene.add(obj);
    tagId(copy);
    state.placed.push(copy);
    buildColliderVis(copy);
    markDirty();
    outlinerUpdate();
    if (selectIt) select(copy);
    return copy;
  }

  // 阵列复制：以选中对象为起点，沿 X/Z 网格生成副本（不含原件位置），返回副本总数
  function arrayDuplicate(rec, nx, nz, sp) {
    let n = 0;
    const bx = rec.x ?? rec.obj.position.x;
    const bz = rec.z ?? rec.obj.position.z;
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < nz; j++) {
        if (i === 0 && j === 0) continue;
        const copy = duplicateRec(rec);
        copy.x = bx + i * sp;
        copy.z = bz + j * sp;
        applyPlTransform(copy);
        n++;
      }
    }
    return n;
  }

  // ---------- 选中 + 3D 轴绑定 ----------
  const GIZMO_MODE = { move: 'translate', rot: 'rotate', scale: 'scale' };

  function select(rec) {
    // 光源与普通物件选中互斥：选中普通物件（或清空选中）时一并取消光源选中。
    // 选中光源走 selectLight()，它会先调用本函数清空普通物件选中，再挂 gizmo。
    state.selectedLightId = null;
    state.selected = rec || null;
    const gm = GIZMO_MODE[state.mode];
    if (rec && gm) {
      tCtl.attach(rec.obj);
      tCtl.setMode(gm);
      tCtl.enabled = true;
    } else {
      tCtl.detach();
      tCtl.enabled = false;
    }
    syncPropsUI();
    outlinerUpdate();
    syncLightPanel(); // 光源列表高亮随之刷新（清空选中时同样生效）
  }

  // ---------- 交互（点击选中；gizmo 拖动由 TransformControls 接管） ----------
  let downPt = null;
  let dragged = false;
  let orbitLocked = false;

  renderer.domElement.addEventListener('pointerdown', (e) => {
    // 测距：Shift+左键 = 第一点，Shift+右键 = 第二点；未按 Shift 的点击交给视角拖拽
    if (state.mode === 'ruler' && e.shiftKey) {
      if (e.button === 0) onRulerClick(e.clientX, e.clientY, 0);
      else if (e.button === 2) onRulerClick(e.clientX, e.clientY, 1);
      return;
    }
    if (e.button !== 0) return;
    // 边界模式：点/拖边界板与角球由自己处理，不走「点选模型」那套
    if (state.mode === 'bound') { onBoundaryDown(e); return; }
    // 赛道模式：点地面加门 / 拖门由自己处理
    if (state.mode === 'track') { onTrackDown(e); return; }
    downPt = { x: e.clientX, y: e.clientY };
    dragged = false;
    if (tCtl.axis) return; // 正在拖 3D 轴，交给 TransformControls
    if (state.mode === 'ruler') return;
    if (state.mode === 'place') return;
    const hitObj = pickObject(e.clientX, e.clientY);
    if (hitObj && hitObj.isLight) selectLight(hitObj.rec);
    else select(hitObj ? hitObj.rec : null);
    if (hitObj && (state.mode === 'move' || state.mode === 'rot' || state.mode === 'scale')) {
      controls.enabled = false; // 选中时短暂停用视角，避免点击同时旋转相机
      orbitLocked = true;
    }
  });

  renderer.domElement.addEventListener('pointermove', (e) => {
    if (downPt && Math.hypot(e.clientX - downPt.x, e.clientY - downPt.y) > 4) dragged = true;
    // 测距模式：鼠标移动实时预览第二点到第一点的距离
    if (state.mode === 'ruler') { onRulerMove(e.clientX, e.clientY); return; }
    // 边界模式：拖动中改边界；没在拖则只做悬停高亮
    if (state.mode === 'bound') { onBoundaryMove(e); return; }
    // 赛道模式：拖动中挪门；没在拖则只做悬停高亮
    if (state.mode === 'track') { onTrackMove(e); return; }
    // 幽灵跟随（放置模式）
    if (state.mode === 'place' && state.ghost) {
      const p = groundPos(e.clientX, e.clientY, hit);
      if (p) {
        const x = snapVal(p.x), z = snapVal(p.z);
        state.ghost.position.set(x, 0, z);
        StepUI.stX.textContent = x.toFixed(1);
        StepUI.stZ.textContent = z.toFixed(1);
      }
      hoverCursor(e.clientX, e.clientY);
    }
  });

  renderer.domElement.addEventListener('pointerup', (e) => {
    // 边界拖动结束：无论如何都要收尾（否则视角控件会一直停在禁用状态）
    if (state.mode === 'bound') onBoundaryUp();
    if (state.mode === 'track') onTrackUp();
    if (e.button !== 0) return;
    if (orbitLocked) { controls.enabled = true; orbitLocked = false; }
    downPt = null;
    if (state.mode === 'place' && !dragged) place();
  });

  function pickObject(clientX, clientY) {
    controlOffset(clientX, clientY);
    raycaster.setFromCamera(ndc, camera);
    const meshes = [];
    [...state.placed, ...state.scenery].forEach((rec) => {
      if (!rec.obj) return;
      const arr = [];
      rec.obj.traverse((o) => { if (o.isMesh || o.isLineSegments) arr.push(o); });
      const its = raycaster.intersectObjects(arr, false);
      if (its.length) meshes.push({ d: its[0].distance, rec });
    });
    // 光源：把灯光辅助器（点光源 PointLightHelper / 面光源 RectAreaLightHelper）纳入拾取，
    // 命中即标记 isLight，供上层区分「选中光源」还是「选中普通物件」。
    state.lights.forEach((rec) => {
      if (!rec.helper) return;
      const its = raycaster.intersectObject(rec.helper, true);
      if (its.length) meshes.push({ d: its[0].distance, rec, isLight: true });
    });
    if (!meshes.length) return null;
    meshes.sort((a, b) => a.d - b.d);
    return meshes[0];
  }

  function hoverCursor(x, y) {
    renderer.domElement.style.cursor = pickObject(x, y) ? 'pointer' : 'default';
  }

  // ---------- 变换面板 ----------
  function syncPropsUI() {
    const rec = state.selected;
    if (!rec) {
      ['pX', 'pZ', 'pY'].forEach((id) => { document.getElementById(id).value = ''; });
      StepUI.pRot.value = 0; StepUI.pScale.value = 1;
      syncColliderUI(null); // 未选中时收起碰撞体面板并清空碰撞体列表
      return;
    }
    StepUI.pX.value = Math.round((rec.x ?? rec.obj.position.x) * 100) / 100;
    StepUI.pZ.value = Math.round((rec.z ?? rec.obj.position.z) * 100) / 100;
    StepUI.pY.value = Math.round((rec.y ?? rec.obj.position.y) * 100) / 100;
    StepUI.pRot.value = Math.round((rec.rotY ?? 0) * (180 / Math.PI));
    StepUI.pScale.value = normScale(rec.scale).x;
    syncColliderUI(rec);
  }

  function applyPlTransform(rec) {
    const s = normScale(rec.scale);
    rec.obj.scale.set(s.x, s.y, s.z);
    rec.obj.position.set(rec.x ?? 0, rec.y ?? 0, rec.z ?? 0);
    rec.obj.rotation.y = (rec.rotY ?? 0);
  }

  function bindProp(id, setter) {
    const el = document.getElementById(id);
    el.addEventListener('input', () => {
      if (!state.selected) return;
      const rec = state.selected;
      setter(rec, parseFloat(el.value));
      applyPlTransform(rec);
      StepUI.stX.textContent = (rec.x ?? rec.obj.position.x).toFixed(1);
      StepUI.stZ.textContent = (rec.z ?? rec.obj.position.z).toFixed(1);
      markDirty();
    });
  }
  bindProp('pX', (rec, v) => { rec.x = v; });
  bindProp('pZ', (rec, v) => { rec.z = v; });
  bindProp('pY', (rec, v) => { rec.y = v; });
  bindProp('pRot', (rec, v) => { rec.rotY = v * DEG; });
  bindProp('pScale', (rec, v) => { rec.scale = { x: v, y: v, z: v }; });

  // ---------- 碰撞体面板（仅对用户放置对象显示） ----------
  // simple / complex 两种碰撞复杂度（对齐 UE）：simple 用编辑器生成的盒/凸包；complex 由运行时从渲染网格烘焙。
  function isComplex(rec) { return !!rec && rec.collisionMode === 'complex'; }
  // 模式相关的 UI：complex 时收起所有 simple 专属的生成/手工盒控件
  function applyModeUI(rec) {
    const complex = isComplex(rec);
    if (StepUI.cMode) StepUI.cMode.value = complex ? 'complex' : 'simple';
    if (StepUI.cSimpleArea) StepUI.cSimpleArea.style.display = complex ? 'none' : 'block';
  }

  function syncColliderUI(rec) {
    const canEdit = rec && rec.kind !== 'scenery';
    StepUI.colliderPanel.style.display = canEdit ? 'block' : 'none';
    // 切换选中对象时清掉上一个对象残留的生成信息
    if (StepUI.cGridInfo) StepUI.cGridInfo.style.display = 'none';
    if (!canEdit) { renderColliderList(null); return; }
    if (!rec.collider) rec.collider = defaultCollider();
    const c = rec.collider;
    StepUI.cEn.checked = !!c.enabled;
    StepUI.cHx.value = c.hx;
    StepUI.cHy.value = c.hy;
    StepUI.cHz.value = c.hz;
    StepUI.cOy.value = c.oy;
    applyModeUI(rec);
    renderColliderList(rec);
  }

  // 碰撞体列表：分类显示当前选中对象的碰撞体（盒 / 凸包），每项可单独删除。
  // 删除后立即重建可视化并标记未保存，避免「生成了却删不掉」。
  let _lastListRec = null;
  function renderColliderList(rec) {
    const wrap = StepUI.cList;
    if (!wrap) return;
    // 切换到另一个对象时清空碰撞体选中高亮（同一对象内的重渲染保留选中）
    if (rec !== _lastListRec) { state.selColl = null; _lastListRec = rec; }
    wrap.innerHTML = '';
    if (!rec || rec.kind === 'scenery') return;

    const refresh = () => {
      state.selColl = null; // 结构变化（删除/重建）后清空选中，避免索引错位高亮到别的盒
      buildColliderVis(rec);
      renderColliderList(rec);
      markDirty();
    };
    const addGroup = (title) => {
      const h = document.createElement('div');
      h.className = 'cgroup';
      h.textContent = title;
      wrap.appendChild(h);
    };
    const addItem = (text, onDel, kind, i) => {
      const li = document.createElement('div');
      const isSelected = !!state.selColl && state.selColl.kind === kind && state.selColl.i === i;
      li.className = isSelected ? 'citem sel' : 'citem';
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = text;
      li.appendChild(nm);
      const del = document.createElement('span');
      del.className = 'del';
      del.textContent = '✕';
      del.title = '删除该碰撞体';
      del.onclick = (e) => { e.stopPropagation(); onDel(); };
      li.appendChild(del);
      // 点击列表项：选中对应碰撞体 → 视口里高亮并以穿透方式显示（再点一次取消）
      li.onclick = () => {
        state.selColl = isSelected ? null : { kind, i };
        buildColliderVis(rec);
        renderColliderList(rec);
      };
      wrap.appendChild(li);
    };

    const boxes = Array.isArray(rec.colliders) ? rec.colliders : [];
    const hulls = Array.isArray(rec.convexParts) ? rec.convexParts : [];
    const singleHull = (rec.convex && Array.isArray(rec.convex.vertices) && Array.isArray(rec.convex.faces) && rec.convex.faces.length >= 3) ? rec.convex : null;
    const single = rec.collider;
    const boxCount = boxes.length || ((single && single.enabled !== false) ? 1 : 0);
    const hullCount = hulls.length || (singleHull ? 1 : 0);
    if (!boxCount && !hullCount) return;

    if (boxCount) {
      addGroup('盒（' + boxCount + '）');
      if (boxes.length) {
        boxes.forEach((b, i) => {
          const size = (b.hx * 2).toFixed(2) + '×' + (b.hy * 2).toFixed(2) + '×' + (b.hz * 2).toFixed(2);
          const pos = '中心 ('
            + (b.ox ?? 0).toFixed(2) + ', ' + (b.oy ?? 0).toFixed(2) + ', ' + (b.oz ?? 0).toFixed(2) + ')';
          addItem('盒 ' + (i + 1) + ' · ' + size + ' m · ' + pos, () => {
            rec.colliders.splice(i, 1);
            if (!rec.colliders.length) rec.colliders = null;
            refresh();
          }, 'box', i);
        });
      } else {
        const size = (single.hx * 2).toFixed(2) + '×' + (single.hy * 2).toFixed(2) + '×' + (single.hz * 2).toFixed(2);
        addItem('单盒 · ' + size + ' m · 中心 (0.00, ' + (single.oy ?? 0).toFixed(2) + ', 0.00)', () => {
          single.enabled = false;
          StepUI.cEn.checked = false;
          refresh();
        }, 'sbox', 0);
      }
    }
    if (hullCount) {
      addGroup('凸包（' + hullCount + '）');
      if (hulls.length) {
        hulls.forEach((h, i) => {
          const tri = Math.floor(h.faces.length / 3);
          const vn = Math.floor(h.vertices.length / 3);
          addItem('凸包 ' + (i + 1) + ' · ' + tri + ' 面 / ' + vn + ' 点', () => {
            rec.convexParts.splice(i, 1);
            if (!rec.convexParts.length) rec.convexParts = null;
            refresh();
          }, 'hull', i);
        });
      } else {
        addItem('凸包 · ' + Math.floor(singleHull.faces.length / 3) + ' 面', () => {
          rec.convex = null;
          refresh();
        }, 'shull', 0);
      }
    }
  }

  // 「按网格生成（室内）」：逐 mesh/primitive 抽盒 + 凸包（不做体素填充，保留中庭/天井/房间）
  async function buildGridColliders(rec) {
    let res;
    try {
      res = await generateSimple(rec.obj);
    } catch (err) {
      console.error(err);
      StepUI.cGridInfo.textContent = '生成失败：' + (err && err.message ? err.message : err);
      StepUI.cGridInfo.style.display = 'inline';
      return;
    }
    if (!res.boxes.length && !res.hulls.length) {
      StepUI.cGridInfo.textContent = '该对象暂无可用网格（模型可能仍在加载，或这是一个空碰撞体）';
      StepUI.cGridInfo.style.display = 'inline';
      return;
    }
    // 写入生成结果，并关闭旧的碰撞字段，避免同一次摆放上出现两套重复阻挡
    rec.colliders = res.boxes.length ? res.boxes : null;
    rec.convexParts = res.hulls.length ? res.hulls : null;
    if (rec.collider) rec.collider.enabled = false;
    rec.convex = null;
    buildColliderVis(rec);
    if (state.selected === rec) { syncColliderUI(rec); }
    renderColliderList(rec);
    outlinerUpdate();
    markDirty();
    const none = (res.diag || []).filter((d) => !d.boxes && !d.hulls);
    StepUI.cGridInfo.textContent = '盒 ' + res.boxes.length + ' / 凸包 ' + res.hulls.length + ' / 跳过 ' + res.skipped
      + (none.length ? ' / 未产出 ' + none.length + ' 个 mesh（详见控制台）' : '');
    StepUI.cGridInfo.style.display = 'inline';
  }

  // 全部删除：一键清空该对象的所有碰撞体（单盒/多盒/单凸包/凸分解），并清掉选中高亮
  StepUI.cClearAll.onclick = () => {
    const rec = state.selected;
    if (!rec || rec.kind === 'scenery') {
      StepUI.cGridInfo.textContent = '请先选中一个模型再点';
      StepUI.cGridInfo.style.display = 'inline';
      return;
    }
    rec.colliders = null;
    rec.convexParts = null;
    rec.convex = null;
    if (rec.collider) rec.collider.enabled = false;
    if (StepUI.cEn) StepUI.cEn.checked = false;
    state.selColl = null;
    buildColliderVis(rec);
    renderColliderList(rec);
    markDirty();
    StepUI.cGridInfo.textContent = '已删除全部碰撞体';
    StepUI.cGridInfo.style.display = 'inline';
  };

  function readColliderFields() {
    if (!state.selected || !state.selected.collider) return;
    const c = state.selected.collider;
    c.enabled = StepUI.cEn.checked;
    c.hx = parseFloat(StepUI.cHx.value) || 0;
    c.hy = parseFloat(StepUI.cHy.value) || 0;
    c.hz = parseFloat(StepUI.cHz.value) || 0;
    c.oy = parseFloat(StepUI.cOy.value) || 0;
  }
  function applyColliderEdit() {
    if (!state.selected) return;
    readColliderFields();
    buildColliderVis(state.selected);
    markDirty();
  }
  StepUI.cEn.onchange = applyColliderEdit;
  ['cHx', 'cHy', 'cHz', 'cOy'].forEach((id) => {
    document.getElementById(id).addEventListener('input', applyColliderEdit);
  });
  document.getElementById('cAuto').onclick = () => {
    if (state.selected) autoFitCollider(state.selected);
  };
  StepUI.cMultiBtn.onclick = () => {
    if (!state.selected) {
      StepUI.cMultiInfo.textContent = '请先选中一个模型再点「自动凸分解」';
      StepUI.cMultiInfo.style.display = 'inline';
      return;
    }
    const cap = parseInt(StepUI.cMax.value, 10);
    buildVhacdConvexParts(state.selected, cap);
  };
  StepUI.cHullBtn.onclick = () => {
    if (!state.selected) {
      StepUI.cHullInfo.textContent = '请先选中一个模型再点「生成凸包」';
      StepUI.cHullInfo.style.display = 'inline';
      return;
    }
    try {
      buildConvexCollider(state.selected);
    } catch (err) {
      StepUI.cHullInfo.textContent = '生成失败：' + (err && err.message ? err.message : err);
      StepUI.cHullInfo.style.display = 'inline';
      console.error(err);
    }
  };

  // 碰撞模式下拉：simple（编辑器生成盒/凸包，默认）/ complex（运行时从渲染网格烘焙，编辑器零存储）
  StepUI.cMode.onchange = () => {
    if (!state.selected) {
      applyModeUI(null);
      return;
    }
    const rec = state.selected;
    rec.collisionMode = StepUI.cMode.value === 'complex' ? 'complex' : 'simple';
    applyModeUI(rec);
    markDirty();
  };

  // 「按网格生成（室内）」：对选中对象逐 mesh/primitive 抽碰撞体
  StepUI.cGridBtn.onclick = () => {
    if (!state.selected) {
      StepUI.cGridInfo.textContent = '请先选中一个模型再点「按网格生成（室内）」';
      StepUI.cGridInfo.style.display = 'inline';
      return;
    }
    buildGridColliders(state.selected);
  };

  // ---------- 光源（点光源 / 面光源） ----------
  // 面光源（RectAreaLight）需要先用 LTC 贴图初始化一次，否则不发光；全局只需调用一次。
  RectAreaLightUniformsLib.init();

  // 颜色统一成 #rrggbb 字符串（存档里就是这个格式）
  function lightColorHex(rec) {
    return (rec && typeof rec.color === 'string' && rec.color) ? rec.color : '#ffffff';
  }

  // 按 rotY/rotX（单位为度）设置面光源朝向，必须与游戏端 EditorBuildings.buildEditorLights 完全一致：
  // RectAreaLight 沿「本地 -Z」发光，所以直接用 YXZ 欧拉角赋值（rotX 俯仰、负值朝下，rotY 偏航），
  // 不能用 lookAt —— lookAt 会让本地 +Z 指向目标，等于把发光面转反 180°（编辑器里朝下、游戏里朝上）。
  function applyAreaOrientation(light, rec) {
    light.rotation.order = 'YXZ';
    light.rotation.set((rec.rotX ?? -90) * DEG, (rec.rotY ?? 0) * DEG, 0);
  }

  // 把数据记录实例化为真实灯光 + 辅助器，并挂进场景（rec.obj / rec.helper）
  function buildLightObject(rec) {
    if (rec.type === 'area') {
      const light = new THREE.RectAreaLight(
        new THREE.Color(lightColorHex(rec)),
        rec.intensity ?? 3,
        Math.max(0.01, rec.width ?? 4),
        Math.max(0.01, rec.height ?? 3)
      );
      light.position.set(rec.x ?? 0, rec.y ?? 3, rec.z ?? 0);
      applyAreaOrientation(light, rec);
      const helper = new RectAreaLightHelper(light);
      light.add(helper); // RectAreaLightHelper 必须作为灯光的子节点才能跟随朝向
      scene.add(light);
      rec.obj = light;
      rec.helper = helper;
    } else {
      rec.type = 'point';
      const light = new THREE.PointLight(
        new THREE.Color(lightColorHex(rec)),
        rec.intensity ?? 20,
        rec.distance ?? 12,
        rec.decay ?? 2
      );
      light.position.set(rec.x ?? 0, rec.y ?? 3, rec.z ?? 0);
      scene.add(light);
      const helper = new THREE.PointLightHelper(light, 0.4);
      scene.add(helper);
      rec.obj = light;
      rec.helper = helper;
    }
  }

  // 数据字段变化后同步到真实灯光（位置/颜色/强度/尺寸/朝向）
  function applyLightTransforms(rec) {
    const light = rec.obj;
    if (!light) return;
    light.position.set(rec.x ?? 0, rec.y ?? 3, rec.z ?? 0);
    light.color.set(lightColorHex(rec));
    light.intensity = rec.intensity ?? 0;
    if (rec.type === 'area') {
      light.width = Math.max(0.01, rec.width ?? 4);
      light.height = Math.max(0.01, rec.height ?? 3);
      applyAreaOrientation(light, rec);
    } else {
      light.distance = Math.max(0, rec.distance ?? 0);
      light.decay = Math.max(0, rec.decay ?? 2);
    }
    // 点光源 helper 需要手动刷新颜色（面光源 helper 每帧自动跟随灯光矩阵）
    if (rec.helper && typeof rec.helper.update === 'function') rec.helper.update();
  }

  // gizmo 拖动光源时从灯光对象回写数据记录：位置直接取 obj.position（x/y/z）；
  // 面光源处于旋转模式时，把 YXZ 欧拉角的 y（偏航）/ x（俯仰）由弧度换算回「度」写入 rotY/rotX。
  // 回写后再调用 applyLightTransforms，让灯光/辅助器与面板保持一致。
  function readLightFromObject(rec) {
    if (!rec || !rec.obj) return;
    const o = rec.obj;
    rec.x = o.position.x;
    rec.y = o.position.y;
    rec.z = o.position.z;
    // 注意：缩放不在逐帧的 objectChange 里结算 —— TransformControls 在缩放模式下
    // 给出的 scale 是「相对本次拖拽起点」的值，若每次事件都乘进尺寸会指数级放大。
    // 因此缩放只在拖拽结束（dragging-changed）时结算一次，见 readLightScale()。
    if (rec.type === 'area') {
      rec.rotY = o.rotation.y * (180 / Math.PI);
      rec.rotX = o.rotation.x * (180 / Math.PI);
    }
    applyLightTransforms(rec);
    syncLightUI();
    markDirty();
  }

  // 拖拽结束时结算缩放：把灯光对象上的 scale 转成真实尺寸字段后复位为 1
  // （灯光自身的 scale 不参与渲染，尺寸只由 width/height 或 distance 表达）
  function readLightScale(rec) {
    if (!rec || !rec.obj) return;
    const o = rec.obj;
    const sx = o.scale.x;
    const sy = o.scale.y;
    const sz = o.scale.z;
    if (Math.abs(sx - 1) < 1e-4 && Math.abs(sy - 1) < 1e-4 && Math.abs(sz - 1) < 1e-4) return;
    if (rec.type === 'area') {
      // 面光源：X 轴 → 宽，Y 轴 → 高（Z 无意义，忽略）
      rec.width = Math.max(0.05, (rec.width ?? 4) * sx);
      rec.height = Math.max(0.05, (rec.height ?? 3) * sy);
    } else {
      // 点光源：取变化最大的一轴，缩放 → 照射半径
      rec.distance = Math.max(0.5, (rec.distance ?? 12) * Math.max(sx, sy, sz));
    }
    o.scale.set(1, 1, 1);
    applyLightTransforms(rec);
    syncLightUI();
    markDirty();
  }

  // 新建光源：默认落在相机注视点上方 3 米处；面光源默认俯仰 -90°（朝下照）
  function addLight(type) {
    const rec = {
      id: nextId(),
      type: type === 'area' ? 'area' : 'point',
      x: controls.target.x, y: 3, z: controls.target.z,
      color: '#ffffff',
      intensity: type === 'area' ? 3 : 20,
      distance: 12, decay: 2,
      width: 4, height: 3, rotY: 0, rotX: -90,
    };
    buildLightObject(rec);
    state.lights.push(rec);
    selectLight(rec); // 新建即选中，并把 3D 变换轴挂到该光源上
    markDirty();
  }

  // 删除光源：从场景移除灯光与辅助器并释放资源
  function removeLight(rec) {
    if (!rec) return;
    // 该光源正被 gizmo 附着时先摘掉，避免变换轴挂在已移除的对象上
    if (rec.obj && tCtl.object === rec.obj) { tCtl.detach(); tCtl.enabled = false; }
    if (rec.helper) {
      if (rec.type === 'area' && rec.obj) rec.obj.remove(rec.helper);
      else scene.remove(rec.helper);
      if (typeof rec.helper.dispose === 'function') rec.helper.dispose();
    }
    if (rec.obj) {
      scene.remove(rec.obj);
      if (typeof rec.obj.dispose === 'function') rec.obj.dispose();
    }
    state.lights = state.lights.filter((l) => l !== rec);
    if (state.selectedLightId === rec.id) state.selectedLightId = null;
    markDirty();
    syncLightPanel();
  }

  function selectedLight() {
    return state.lights.find((l) => l.id === state.selectedLightId) || null;
  }

  // 光源的 gizmo 模式：默认为移动；面光源在「旋转」模式下用旋转轴调朝向，点光源旋转无意义仍用移动。
  function lightGizmoMode(rec) {
    return (state.mode === 'rot' && rec && rec.type === 'area') ? 'rotate' : 'translate';
  }

  // 选中光源：先清空普通物件选中（会 detach gizmo、收起变换/碰撞体面板），
  // 再把 3D 变换轴重新挂到光源对象上——保证光源与普通物件二者互斥，gizmo 不会同时挂两个对象。
  function selectLight(rec) {
    select(null);
    state.selectedLightId = rec ? rec.id : null;
    if (rec && rec.obj) {
      tCtl.attach(rec.obj);
      tCtl.setMode(lightGizmoMode(rec));
      tCtl.enabled = true;
    }
    syncLightPanel();
  }

  // 光源列表：每行显示类型 + 编号，点击选中，选中行高亮
  function syncLightList() {
    const wrap = StepUI.lightList;
    if (!wrap) return;
    wrap.innerHTML = '';
    if (!state.lights.length) {
      const e = document.createElement('div');
      e.className = 'lempty';
      e.textContent = '暂无光源（用顶栏「加点光源 / 加面光源」添加）';
      wrap.appendChild(e);
      return;
    }
    state.lights.forEach((rec) => {
      const li = document.createElement('div');
      li.className = (rec.id === state.selectedLightId) ? 'litem sel' : 'litem';
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = (rec.type === 'area' ? '面光源' : '点光源');
      li.appendChild(nm);
      const idEl = document.createElement('span');
      idEl.className = 'oid';
      idEl.textContent = rec.id;
      li.appendChild(idEl);
      li.onclick = () => selectLight(rec);
      wrap.appendChild(li);
    });
  }

  // 选中光源的属性编辑：位置/颜色/强度 + 按类型显示距离/衰减或宽/高/朝向
  function syncLightUI() {
    const rec = selectedLight();
    if (StepUI.lightEditor) StepUI.lightEditor.style.display = rec ? 'block' : 'none';
    const isArea = !!(rec && rec.type === 'area');
    if (StepUI.lightPointFields) StepUI.lightPointFields.style.display = isArea ? 'none' : 'block';
    if (StepUI.lightAreaFields) StepUI.lightAreaFields.style.display = isArea ? 'block' : 'none';
    if (!rec) return;
    if (StepUI.lX) StepUI.lX.value = Math.round((rec.x ?? 0) * 100) / 100;
    if (StepUI.lY) StepUI.lY.value = Math.round((rec.y ?? 0) * 100) / 100;
    if (StepUI.lZ) StepUI.lZ.value = Math.round((rec.z ?? 0) * 100) / 100;
    if (StepUI.lColor) StepUI.lColor.value = lightColorHex(rec);
    if (StepUI.lIntensity) StepUI.lIntensity.value = rec.intensity ?? 0;
    if (StepUI.lDistance) StepUI.lDistance.value = rec.distance ?? 0;
    if (StepUI.lDecay) StepUI.lDecay.value = rec.decay ?? 2;
    if (StepUI.lWidth) StepUI.lWidth.value = rec.width ?? 4;
    if (StepUI.lHeight) StepUI.lHeight.value = rec.height ?? 3;
    if (StepUI.lRotY) StepUI.lRotY.value = rec.rotY ?? 0;
    if (StepUI.lRotX) StepUI.lRotX.value = rec.rotX ?? 0;
  }

  function syncLightPanel() {
    syncLightList();
    syncLightUI();
  }

  // 属性输入框绑定（带空值保护，缺元素不报错）
  function bindLightProp(el, apply) {
    if (!el) return;
    el.addEventListener('input', () => {
      const rec = selectedLight();
      if (!rec) return;
      apply(rec, el.value);
      applyLightTransforms(rec);
      markDirty();
    });
  }
  bindLightProp(StepUI.lX, (r, v) => { r.x = parseFloat(v) || 0; });
  bindLightProp(StepUI.lY, (r, v) => { r.y = parseFloat(v) || 0; });
  bindLightProp(StepUI.lZ, (r, v) => { r.z = parseFloat(v) || 0; });
  bindLightProp(StepUI.lColor, (r, v) => { r.color = v; });
  bindLightProp(StepUI.lIntensity, (r, v) => { r.intensity = Math.max(0, parseFloat(v) || 0); });
  bindLightProp(StepUI.lDistance, (r, v) => { r.distance = Math.max(0, parseFloat(v) || 0); });
  bindLightProp(StepUI.lDecay, (r, v) => { r.decay = Math.max(0, parseFloat(v) || 0); });
  bindLightProp(StepUI.lWidth, (r, v) => { r.width = Math.max(0.01, parseFloat(v) || 0.01); });
  bindLightProp(StepUI.lHeight, (r, v) => { r.height = Math.max(0.01, parseFloat(v) || 0.01); });
  bindLightProp(StepUI.lRotY, (r, v) => { r.rotY = parseFloat(v) || 0; });
  bindLightProp(StepUI.lRotX, (r, v) => { r.rotX = parseFloat(v) || 0; });

  if (StepUI.btnAddPointLight) StepUI.btnAddPointLight.onclick = () => addLight('point');
  if (StepUI.btnAddAreaLight) StepUI.btnAddAreaLight.onclick = () => addLight('area');
  if (StepUI.lDel) StepUI.lDel.onclick = () => removeLight(selectedLight());

  // 大纲：摆放对象（可删除）+ 游戏景物（内建，仅可选中编辑）
  function outlinerUpdate() {
    StepUI.outliner.innerHTML = '';
    StepUI.colliderList.innerHTML = '';
    const addLi = (list, rec, withDelete) => {
      const li = document.createElement('li');
      if (state.selected === rec) li.className = 'sel';
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = rec.name;
      li.appendChild(nm);
      const idEl = document.createElement('span');
      idEl.className = 'oid';
      idEl.textContent = rec.id;
      li.appendChild(idEl);
      if (withDelete) {
        const del = document.createElement('span');
        del.className = 'del';
        del.textContent = '✕';
        del.onclick = (e) => { e.stopPropagation(); removePlaced(rec); };
        li.appendChild(del);
      }
      li.onclick = () => select(rec);
      list.appendChild(li);
    };
    state.placed.forEach((rec) => {
      // 空碰撞体单独一列，避免与摆放模型混在一起太多
      if (rec.kind === 'empty') addLi(StepUI.colliderList, rec, true);
      else addLi(StepUI.outliner, rec, true);
    });

    if (!StepUI.sceneryList) return;
    StepUI.sceneryList.innerHTML = '';
    state.scenery.forEach((rec) => {
      const li = document.createElement('li');
      if (state.selected === rec) li.className = 'sel';
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = rec.name;
      li.appendChild(nm);
      const idEl = document.createElement('span');
      idEl.className = 'oid';
      idEl.textContent = rec.id;
      li.appendChild(idEl);
      li.onclick = () => select(rec);
      StepUI.sceneryList.appendChild(li);
    });
  }

  function removePlaced(rec) {
    scene.remove(rec.obj);
    state.placed = state.placed.filter((p) => p !== rec);
    if (state.selected === rec) select(null);
    markDirty();
    outlinerUpdate();
  }

  // ---------- 持久化（编辑器自有场景文件，游戏读取） ----------
  function serialize() {
    return {
      // 场地边界（空气墙）：游戏运行时读这份数据决定玩家能走到哪；
      // 不写这个字段时游戏用地面范围兜底，所以旧存档一样能跑。
      boundary: { ...state.boundary },
      // 赛道（校园狂飙）：游戏「校园狂飙」玩法读这份数据决定门的位置与圈数。
      // 不写该字段时游戏用默认演示赛道兜底，所以旧存档一样能跑。
      track: { ...state.track, checkpoints: state.track.checkpoints.map((c) => ({ ...c })) },
      // 游戏景物：保存每个可编辑景物（地形/道路/墙体/树/建筑…）的变换，key 为统一下标
      scenery: state.scenery.map((rec) => {
        const s = normScale(rec.scale ?? rec.obj.scale);
        return {
          id: rec.id,
          key: rec.key,
          x: rec.x ?? rec.obj.position.x,
          y: rec.y ?? rec.obj.position.y,
          z: rec.z ?? rec.obj.position.z,
          rotY: rec.rotY ?? 0,
          scale: { x: s.x, y: s.y, z: s.z },
        };
      }),
      // 用户新建摆放的对象
      placed: state.placed.map((rec) => {
        const s = normScale(rec.scale ?? rec.obj.scale);
        const out = {
          id: rec.id,
          kind: rec.kind,
          name: rec.name,
          url: rec.url,
          x: rec.x ?? rec.obj.position.x,
          y: rec.y ?? rec.obj.position.y,
          z: rec.z ?? rec.obj.position.z,
          rotY: rec.rotY ?? 0,
          scale: { x: s.x, y: s.y, z: s.z },
          collisionMode: rec.collisionMode === 'complex' ? 'complex' : 'simple',
          collider: rec.collider ? { ...rec.collider } : null,
          colliders: Array.isArray(rec.colliders) && rec.colliders.length ? rec.colliders.map((c) => ({ ...c })) : null,
          convex: (rec.convex && Array.isArray(rec.convex.vertices) && rec.convex.faces.length >= 3)
            ? { vertices: rec.convex.vertices.slice(), faces: rec.convex.faces.slice() } : null,
          convexParts: (Array.isArray(rec.convexParts) && rec.convexParts.length)
            ? rec.convexParts.map((h) => ({ vertices: h.vertices.slice(), faces: h.faces.slice() })) : null,
        };
        // 兼容旧的内嵌 data URL 记录
        if (!out.url && rec.data) out.data = rec.data;
        return out;
      }),
      // 光源：与 placed 平级。按类型写全各自字段——点光源含 distance/decay；
      // 面光源含 width/height/rotY/rotX（rotX 为俯仰，负值朝下）。
      lights: state.lights.map((rec) => {
        const out = {
          id: rec.id,
          type: rec.type === 'area' ? 'area' : 'point',
          x: rec.x ?? 0, y: rec.y ?? 3, z: rec.z ?? 0,
          color: lightColorHex(rec),
          intensity: rec.intensity ?? 1,
        };
        if (out.type === 'area') {
          out.width = rec.width ?? 4;
          out.height = rec.height ?? 3;
          out.rotY = rec.rotY ?? 0;
          out.rotX = rec.rotX ?? 0;
        } else {
          out.distance = rec.distance ?? 12;
          out.decay = rec.decay ?? 2;
        }
        return out;
      }),
    };
  }

  function markDirty() {
    if (state.comboMode) refreshComboInfo(); // 组合草稿有变动 → 刷新部件/灯计数
    if (!StepUI.status) return;
    StepUI.status.textContent = '有未保存变更（点“保存场景”）';
    StepUI.status.className = 'save-status dirty';
  }

  // 打开时读取编辑器场景文件（还原景物变换 + 用户摆放的对象）
  async function restore() {
    let data = null;
    try {
      const r = await fetch(MAP_URL);
      if (r.ok) data = await r.json();
    } catch (e) { /* 无历史数据则跳过 */ }
    // 兼容旧格式：纯数组仅含 placed
    const placedList = Array.isArray(data) ? data : (data && Array.isArray(data.placed) ? data.placed : []);

    // 1) 按 key 把保存的景物变换套回到已注册的 state.scenery 上
    // 景物 id 由创建顺序固定推导（key 不变则 id 不变），故不需要从存档回读。
    if (data && Array.isArray(data.scenery)) {
      data.scenery.forEach((s) => {
        if (!s || typeof s.key !== 'number' || !state.scenery[s.key]) return;
        const rec = state.scenery[s.key];
        rec.x = s.x; rec.y = s.y; rec.z = s.z;
        rec.rotY = s.rotY; rec.scale = s.scale;
        applyPlTransform(rec);
        tagId(rec);
      });
    }

    // 2) 重建用户摆放的对象（沿用已保存的 id，缺失或与景物 id 冲突时补发新号）
    const usedIds = new Set(state.scenery.map((r) => r.id));
    const claimId = (saved) => {
      const n = Number(saved);
      if (Number.isInteger(n) && n > 0 && !usedIds.has(n)) { usedIds.add(n); bumpIdSeq(n); return n; }
      let fresh = nextId();
      while (usedIds.has(fresh)) fresh = nextId();
      usedIds.add(fresh);
      return fresh;
    };
    for (const it of placedList) {
      const obj = new THREE.Group();
      const id = claimId(it.id);
      // 老存档可能没有 name 字段（undefined 会被 JSON.stringify 丢掉），回退到模型文件名
      const nm = (typeof it.name === 'string' && it.name.trim()) ? it.name : (nameFromUrl(it.url) || '未命名');
      const rec = {
        id, kind: it.kind, name: nm, url: it.url,
        x: it.x, y: it.y, z: it.z, rotY: it.rotY,
        scale: it.scale ? { ...normScale(it.scale) } : { x: 1, y: 1, z: 1 },
        collisionMode: it.collisionMode === 'complex' ? 'complex' : 'simple',
        collider: it.collider ? { enabled: it.collider.enabled !== false, hx: it.collider.hx, hy: it.collider.hy, hz: it.collider.hz, oy: it.collider.oy } : defaultCollider(),
        colliders: Array.isArray(it.colliders) && it.colliders.length ? it.colliders.map((c) => ({ ...c })) : null,
        convex: (it.convex && Array.isArray(it.convex.vertices) && it.convex.faces.length >= 3)
          ? { vertices: it.convex.vertices.slice(), faces: it.convex.faces.slice() } : null,
        convexParts: (Array.isArray(it.convexParts) && it.convexParts.length)
          ? it.convexParts.map((h) => ({ vertices: h.vertices.slice(), faces: h.faces.slice() })) : null,
        obj,
      };
      obj.name = nm;
      if (it.url) {
        instantiate(it.url).then((m) => { obj.add(m); enableShadows(m); }).catch(() => {});
      } else if (it.data) {
        const g = new GLTFLoader();
        g.load(it.data, (gltf) => { obj.add(gltf.scene); enableShadows(gltf.scene); }, undefined, () => {});
      }
      applyPlTransform(rec);
      scene.add(obj);
      tagId(rec);
      state.placed.push(rec);
      buildColliderVis(rec);
    }

    // 3) 重建光源（点/面）。旧存档没有 lights 字段时按空数组处理。
    const lightList = (data && Array.isArray(data.lights)) ? data.lights : [];
    for (const it of lightList) {
      if (!it) continue;
      const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
      const rec = {
        id: claimId(it.id),
        type: it.type === 'area' ? 'area' : 'point',
        x: num(it.x, 0), y: num(it.y, 3), z: num(it.z, 0),
        color: (typeof it.color === 'string' && it.color) ? it.color : '#ffffff',
        intensity: num(it.intensity, it.type === 'area' ? 3 : 20),
        distance: num(it.distance, 12),
        decay: num(it.decay, 2),
        width: num(it.width, 4),
        height: num(it.height, 3),
        rotY: num(it.rotY, 0),
        rotX: num(it.rotX, 0),
      };
      buildLightObject(rec);
      state.lights.push(rec);
    }

    // 4) 读回场地边界（空气墙）。旧存档没这个字段 → 保持默认（地面范围），行为不变。
    const bnd = normalizeBoundary(data && data.boundary);
    if (bnd) state.boundary = bnd;
    // 赛道：存档里没有 track 字段就保持当前（默认演示赛道）
    const trk = normalizeTrack(data && data.track);
    if (trk) state.track = trk;
    state.trackSel = -1;

    outlinerUpdate();
    syncLightPanel();
    refreshBoundaryViz(); // 边界可视化与面板数值跟着存档刷新
    refreshTrackViz();     // 赛道可视化与面板数值同样跟着存档刷新
  }

  // 「保存场景」：把当前用户摆放清单 POST 到服务器写入编辑器场景文件
  async function saveToFile() {
    if (state.comboMode) { // 组合编辑时草稿会顶替主场景，别把它当场景存了
      if (StepUI.status) { StepUI.status.textContent = '组合编辑中：请先「退出组合」再保存场景'; StepUI.status.className = 'save-status err'; }
      return;
    }
    if (!StepUI.status) return;
    try {
      const r = await fetch(SAVE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(serialize()),
      });
      const res = await r.json().catch(() => null);
      if (r.ok && res && res.ok) {
        StepUI.status.textContent = '已保存编辑器场景';
        StepUI.status.className = 'save-status saved';
      } else {
        StepUI.status.textContent = '保存失败' + (res && res.error ? '：' + res.error : '');
        StepUI.status.className = 'save-status err';
      }
    } catch (e) {
      StepUI.status.textContent = '保存失败：' + e;
      StepUI.status.className = 'save-status err';
    }
  }
  StepUI.btnSave.onclick = saveToFile;

  // ---------- 素材库：集中读取 public/models 目录 + 旧导入（悬浮预览） ----------
  StepUI.library.innerHTML = '';
  let folderItems = [];           // /api/models 目录清单（含导入写入的模型）
  const preview = createPreviewWidget(); // 悬浮预览小窗

  async function refreshLibrary() {
    folderItems = [];
    try {
      const r = await fetch(API_BASE + '/api/models');
      if (r.ok) {
        const js = await r.json().catch(() => null);
        if (js && Array.isArray(js.items)) folderItems = js.items;
      }
    } catch (e) { /* 目录读取失败，沿用旧导入+内建回退 */ }
    buildLibrary();
  }

  function buildLibrary() {
    StepUI.library.innerHTML = '';
    const seen = new Set();
    // 内建素材始终展示；后端清单 / 导入模型按 url 去重后并入
    const items = [...LIBRARY, ...folderItems, ...state.imported];
    items.forEach((it) => {
      if (!it || !it.url || seen.has(it.url)) return;
      seen.add(it.url);
      // 后端 /api/models 只给 {name,url}，没有 label；依次回退到 name、文件名，避免按钮空白
      const label = it.label || it.name || it.url.split('/').pop().replace(/\.glb$/i, '');
      const b = document.createElement('button');
      b.title = label;
      b.textContent = label;
      if (state.currentUrl === it.url) b.classList.add('picked');
      b.onclick = () => selectAsset(it.url, label);
      b.onmouseenter = () => preview.show(it.url);
      b.onmouseleave = () => preview.hide();
      StepUI.library.appendChild(b);
    });
  }

  function selectAsset(url, label) {
    state.currentUrl = url;
    state.currentLabel = label;
    buildLibrary();
    resetGhost();
    closeLibrary(); // 选中即收起弹窗，回到视口落点放置
  }
  refreshLibrary();

  // 素材库弹窗开关
  function openLibrary() { StepUI.libModal.classList.add('open'); }
  function closeLibrary() { StepUI.libModal.classList.remove('open'); }
  StepUI.btnLibrary.onclick = openLibrary;
  StepUI.libClose.onclick = closeLibrary;
  // 点击遮罩空白处关闭；Esc 关闭
  StepUI.libModal.addEventListener('click', (e) => { if (e.target === StepUI.libModal) closeLibrary(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLibrary(); });

  // 悬浮预览：独立小渲染器，hover 某素材时加载模型旋转展示
  function createPreviewWidget() {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;top:76px;right:16px;width:180px;height:210px;background:#14161a;border:1px solid #2c3038;border-radius:10px;display:none;z-index:60;overflow:hidden;box-shadow:0 10px 30px rgba(0,0,0,.55);';
    el.style.setProperty('pointer-events', 'none');
    const cap = document.createElement('div');
    cap.style.cssText = 'position:absolute;left:9px;top:7px;color:#9aa0aa;font:12px/1.3 system-ui;pointer-events:none;text-shadow:0 1px 2px #000;';
    cap.textContent = '预览';
    el.appendChild(cap);
    document.body.appendChild(el);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(180, 210);
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    const key = new THREE.DirectionalLight(0xffffff, 1.3);
    key.position.set(5, 8, 6);
    scene.add(key);
    const cam = new THREE.PerspectiveCamera(38, 180 / 210, 0.05, 500);
    const host = new THREE.Group();
    scene.add(host);

    let raf = 0;
    const show = { _t: 0 };
    function tick() {
      raf = requestAnimationFrame(tick);
      host.rotation.y += 0.008;
      renderer.render(scene, cam);
    }
    function focus() {
      const b = new THREE.Box3().setFromObject(host);
      if (b.isEmpty()) return;
      const box = b.clone();
      // 把模型平移到坐标原点居中、底部贴 y=0
      const c = box.getCenter(new THREE.Vector3());
      const ch = host.children[0];
      if (ch) { ch.position.x -= c.x; ch.position.y -= box.min.y; ch.position.z -= c.z; box.translate(new THREE.Vector3(-c.x, -box.min.y, -c.z)); }
      const size = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z) || 1;
      const dist = size * 2.4 + 1.2;
      cam.position.set(dist * 0.9, dist * 0.8, dist * 1.15);
      cam.lookAt(0, size * 0.38, 0);
      host.rotation.set(0, 0, 0);
    }
    function clearHost() {
      while (host.children.length) {
        const ch = host.children.pop();
        ch.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) { const ms = Array.isArray(o.material) ? o.material : [o.material]; ms.forEach((m) => m.dispose()); } });
      }
    }
    return {
      show(url) {
        clearTimeout(show._t);
        show._t = setTimeout(() => {
          clearHost();
          el.style.display = 'block';
          cancelAnimationFrame(raf);
          raf = requestAnimationFrame(tick);
          instantiate(url).then((m) => {
            host.add(m);
            enableShadows(m);
            focus();
          }).catch(() => { /* 预览失败静默 */ });
        }, 140);
      },
      hide() {
        clearTimeout(show._t);
        el.style.display = 'none';
        cancelAnimationFrame(raf);
      },
    };
  }

  const fileIn = document.getElementById('fileIn');

  // 状态栏提示（保存状态用的是同一个元素，这里复用它报上传进度）
  function setUploadStatus(text, cls) {
    if (!StepUI.status) return;
    StepUI.status.textContent = text;
    StepUI.status.className = 'save-status ' + (cls || '');
  }

  // 单次上传尝试：只负责「发请求 → 解析 → 校验」，不弹窗、不吞错误。
  // 失败时把原因原样带回去（谁发不出去、服务端回了什么），这样才能报准，而不是笼统说「没返回地址」。
  async function uploadModel(url, file, buf) {
    let r;
    try {
      r = await fetch(url, {
        method: 'POST',
        headers: { 'x-filename': asciiFileName(file.name) },
        body: buf,
      });
    } catch (e) {
      // 走到这里说明请求根本没发出去：URL 非法、被 CSP 拦、跨源被浏览器拦……
      // （以前文件名带中文时就是这里抛 TypeError，却被外层一个空 catch 吞掉，所以 Network 里干干净净。）
      return { url: '', reason: '请求未发出（' + (e && e.message ? e.message : e) + '）' };
    }
    let text = '';
    let body = null;
    try {
      text = await r.text();
      body = JSON.parse(text);
    } catch (e) { /* 不是 JSON：可能是网关/代理的错误页，下面按原文回显 */ }
    if (r.ok && body && body.ok && body.url) return { url: body.url, reason: '' };
    if (!r.ok) {
      return { url: '', reason: 'HTTP ' + r.status + (r.statusText ? ' ' + r.statusText : '') + (text ? '：' + text.slice(0, 200) : '') };
    }
    return { url: '', reason: '返回体里没有 url 字段：' + (text ? text.slice(0, 200) : '(空响应)') };
  }

  fileIn.addEventListener('change', async () => {
    const f = fileIn.files[0];
    fileIn.value = ''; // 提前清空：同一个文件重选也能再次触发 change
    if (!f) return;
    const base = f.name.replace(/\.(glb|gltf)$/i, '');
    const safeName = asciiFileName(f.name);

    if (f.size > MAX_UPLOAD_BYTES) {
      alert('模型太大：' + (f.size / 1048576).toFixed(1) + 'MB，超过后端单次上传上限 '
        + (MAX_UPLOAD_BYTES / 1048576) + 'MB。请先精简模型（删掉用不到的高模 / 贴图）再导入。');
      return;
    }
    let ab;
    try { ab = await f.arrayBuffer(); } catch (e) { alert('读取文件失败：' + e); return; }

    // 先把模型原样上传到后端 assets 目录，得到统一绝对路径。
    // 线上后端优先；失败再退回同源（本地 server 或 Vite dev 代理），两条路都可能存在。
    const targets = [...new Set([UPLOAD_URL, SAME_ORIGIN_UPLOAD])].filter((u) => /^https?:\/\//.test(u) || u.startsWith('/'));
    setUploadStatus('上传中… ' + safeName, 'dirty');
    let assetUrl = '';
    const reasons = [];
    for (const u of targets) {
      const t0 = performance.now();
      const r = await uploadModel(u, f, ab);
      if (r.url) {
        assetUrl = r.url;
        console.info('[编辑器] 模型已上传', {
          目标: u, 用时ms: Math.round(performance.now() - t0), 大小MB: +(f.size / 1048576).toFixed(2), url: r.url,
        });
        break;
      }
      reasons.push(u + ' → ' + r.reason);
      console.warn('[编辑器] 上传失败', u, r.reason);
    }

    if (!assetUrl) {
      setUploadStatus('导入失败（见弹窗）', 'err');
      alert('导入失败：模型没能上传到后端。\n\n'
        + reasons.join('\n') + '\n\n'
        + '本次上传用的文件名是 ' + safeName + '（原始文件名「' + f.name + '」只用于素材库显示）。\n'
        + '若上面写的是 HTTP 4xx/5xx，把那行原文发我；若写「请求未发出」，说明后端地址不可达或被浏览器拦了。');
      return;
    }

    // 加入素材库并选中（先入库，预览可异步加载）
    if (!state.imported.some((it) => it.url === assetUrl)) {
      state.imported.push({ label: base, url: assetUrl });
      localStorage.setItem(IMPORT_KEY, JSON.stringify(state.imported));
    }
    selectAsset(assetUrl, base);
    refreshLibrary(); // 新模型已写进后端，刷新素材库让其出现在清单里
    setUploadStatus('已导入 ' + base, 'saved');

    // 尝试加载预览；失败只提示，不影响已入库
    instantiate(assetUrl).then(() => {}).catch(() => {
      alert('模型已上传（' + assetUrl.split('/').pop() + '），但无法在此预览（可能不是有效 GLB）。刷新后可从素材库再选。');
    });
  });

  // ---------- 赛道（校园狂飙）----------
  // 赛道 = 一串「有序的门」，车手按 1→2→…→N 的顺序穿过；数据/几何/判定都在 world/Track.js，
  // 与游戏运行时共用同一份（跟「边界」一个套路，见上）。
  // 编辑入口：工具栏「赛道」→ 左键点地面加门 / 拖门移动 / 右键拖拽转视角 / 右侧面板改圈数与删除。
  const trackGroup = new THREE.Group();
  trackGroup.name = 'editor-track';
  trackGroup.visible = false;
  scene.add(trackGroup);

  // 已摆家具 / 建造范围 的编辑器可视化（进入「家具」模式时显示）。
  // 声明放在 setMode 之前，避免 setMode 早期执行时命中 TDZ。
  const buildVizGroup = new THREE.Group();
  buildVizGroup.name = 'editor-buildings';
  buildVizGroup.visible = false;
  scene.add(buildVizGroup);
  const areaVizGroup = new THREE.Group();
  areaVizGroup.name = 'editor-build-areas';
  areaVizGroup.visible = false;
  scene.add(areaVizGroup);

  const TK_COLOR = 0xffc14d;        // 普通门（琥珀）
  const TK_START_COLOR = 0x5ddc7a;  // 起终点 = 0 号门（绿）
  const TK_SEL_COLOR = 0x4ea1ff;    // 选中（蓝）
  const tkPickerMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthTest: false, depthWrite: false });

  // 编号牌贴图：同样的「数字 + 是不是起点」只画一次，之后就复用（拖门时每帧都要用它）
  const tkTexCache = new Map();
  function tkNumberTexture(n, isStart) {
    const key = n + (isStart ? 's' : '');
    if (tkTexCache.has(key)) return tkTexCache.get(key);
    const cv = document.createElement('canvas');
    cv.width = 128; cv.height = 128;
    const c2 = cv.getContext('2d');
    c2.fillStyle = isStart ? 'rgba(24,86,44,.92)' : 'rgba(10,20,34,.88)';
    c2.beginPath();
    c2.arc(64, 64, 52, 0, Math.PI * 2);
    c2.fill();
    c2.lineWidth = 7;
    c2.strokeStyle = isStart ? '#5ddc7a' : '#ffc14d';
    c2.stroke();
    c2.fillStyle = '#fff';
    c2.font = 'bold 66px sans-serif';
    c2.textAlign = 'center';
    c2.textBaseline = 'middle';
    c2.fillText(String(n), 64, 68);
    const tex = new THREE.CanvasTexture(cv);
    tkTexCache.set(key, tex);
    return tex;
  }

  // 一个门的可视化：两根柱子 + 横梁 + 隐形拾取体 + 头顶编号牌（尺寸都靠 scale 改，拖拽时不重建几何）
  function mkTrackGate() {
    const g = new THREE.Group();
    const mkMat = () => new THREE.MeshBasicMaterial({ color: TK_COLOR, transparent: true, opacity: 0.85, depthTest: false });
    const box = new THREE.BoxGeometry(1, 1, 1);
    const postL = new THREE.Mesh(box, mkMat());
    const postR = new THREE.Mesh(box, mkMat());
    const bar = new THREE.Mesh(box, mkMat());
    const pick = new THREE.Mesh(box, tkPickerMat);
    for (const m of [postL, postR, bar]) { m.renderOrder = 996; g.add(m); }
    pick.renderOrder = 995;
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthTest: false }));
    label.renderOrder = 999;
    g.add(pick);
    g.add(label);
    g.userData = { postL, postR, bar, pick, label };
    trackGroup.add(g);
    return g;
  }
  const tkGates = []; // 池子：长度始终与门数一致
  let tkPath = null;      // 贝塞尔路面 + 方向箭头（与游戏共用 world/TrackViz.js）
  let tkPathSig = '';     // 门的坐标指纹：没变就不重建路面（拖拽时每帧都会走到这里）

  function syncTrackPanel() {
    const t = state.track;
    if (!StepUI.tkInfo) return;
    const s = trackSummary(t);
    if (StepUI.tkName && document.activeElement !== StepUI.tkName) StepUI.tkName.value = t.name;
    if (StepUI.tkLaps && document.activeElement !== StepUI.tkLaps) StepUI.tkLaps.value = String(t.laps);
    if (StepUI.tkFocus) StepUI.tkFocus.checked = !!state.trackFocus;
    // 选中门的高度：只在没聚焦时回填（别抢用户正在输入的框）
    const selCp = state.trackSel >= 0 ? t.checkpoints[state.trackSel] : null;
    if (StepUI.tkY && document.activeElement !== StepUI.tkY) {
      StepUI.tkY.value = selCp ? selCp.y.toFixed(1) : '';
      StepUI.tkY.disabled = !selCp;
    }
    const hr = trackHeightRange(t);
    StepUI.tkInfo.textContent = '共 ' + s.gates + ' 个门 · ' + s.laps + ' 圈 · 高度 '
      + hr.min.toFixed(1) + ' ~ ' + hr.max.toFixed(1) + ' 米 · '
      + (s.gates >= 2 ? '可以开赛' : '至少要有 2 个门才能开赛');
    const list = StepUI.tkList;
    if (list) {
      list.textContent = ''; // 不用 innerHTML，逐行建节点
      if (!t.checkpoints.length) {
        const empty = document.createElement('div');
        empty.style.color = '#7f8b99';
        empty.textContent = '还没有门：左键点地面添加。';
        list.appendChild(empty);
      }
      t.checkpoints.forEach((c, i) => {
        const row = document.createElement('div');
        row.style.cssText = 'cursor:pointer;padding:2px 5px;border-radius:4px;'
          + (state.trackSel === i ? 'background:rgba(78,161,255,.28);color:#fff;' : '');
        row.textContent = (i + 1) + '.   X ' + c.x.toFixed(1) + '   Z ' + c.z.toFixed(1) + '   Y ' + c.y.toFixed(1);
        row.onclick = () => { state.trackSel = i; refreshTrackViz(); };
        list.appendChild(row);
      });
    }
    if (StepUI.tkHint) {
      StepUI.tkHint.textContent = '左键点地面 = 在末尾加一个门 · 拖门 = 移动它 · 按住 Shift 拖门 = 调高度（往上拖抬高）· 右键拖拽转视角 · 第 1 个门同时也是起终点';
    }
  }

  // 赛道变化后统一刷新：3D 可视化 + 面板（拖拽 / 手填 / 按钮都汇聚到这里）
  function refreshTrackViz() {
    const specs = gateSpecs(state.track);
    while (tkGates.length < specs.length) tkGates.push(mkTrackGate());
    while (tkGates.length > specs.length) trackGroup.remove(tkGates.pop());
    specs.forEach((sp, i) => {
      const g = tkGates[i];
      const u = g.userData;
      g.position.set(sp.x, sp.y, sp.z);
      // 本地 +X 对齐门的横向：世界 (rx,rz) = (dz,-dx) → rotation.y = atan2(dx, dz)
      g.rotation.y = Math.atan2(sp.dx, sp.dz);
      u.postL.position.set(-sp.w / 2, sp.h / 2, 0);
      u.postL.scale.set(0.45, sp.h, 0.45);
      u.postR.position.set(sp.w / 2, sp.h / 2, 0);
      u.postR.scale.set(0.45, sp.h, 0.45);
      u.bar.position.set(0, sp.h, 0);
      u.bar.scale.set(sp.w + 0.45, 0.45, 0.45);
      u.pick.position.set(0, sp.h / 2, 0);
      u.pick.scale.set(Math.max(2, sp.w), sp.h, 1.6);
      u.pick.userData.trackGate = i;
      const sel = state.trackSel === i;
      const col = sel ? TK_SEL_COLOR : (i === 0 ? TK_START_COLOR : TK_COLOR);
      for (const m of [u.postL, u.postR, u.bar]) {
        m.material.color.setHex(col);
        m.material.opacity = sel ? 1 : 0.85;
      }
      u.label.position.set(0, sp.h + 1.5, 0);
      u.label.scale.set(2.6, 2.6, 1);
      u.label.material.map = tkNumberTexture(i + 1, i === 0);
      u.label.material.needsUpdate = true;
    });
    // 贝塞尔路面 + 方向箭头（与游戏共用同一份几何）。只在门的坐标真的变了时重建 ——
    // 拖门时每帧都会调到这里，无条件重建会白白造上千个顶点。
    const sig = state.track.checkpoints.map((c) => c.x.toFixed(2) + ',' + c.y.toFixed(2) + ',' + c.z.toFixed(2)).join(';');
    if (sig !== tkPathSig) {
      tkPathSig = sig;
      if (tkPath) { disposeTrackViz(tkPath); tkPath = null; }
      if (state.track.checkpoints.length >= 2) {
        tkPath = buildTrackPath(state.track, { arrowCount: 14 });
        trackGroup.add(tkPath);
      }
    }
    syncTrackPanel();
  }

  // 改赛道：一律先过 normalizeTrack（非法门丢弃、宽度/圈数夹回范围），再刷新可视化
  function setTrack(next, opts) {
    const norm = normalizeTrack({ ...state.track, ...next });
    if (norm) state.track = norm;
    if (state.trackSel >= state.track.checkpoints.length) state.trackSel = state.track.checkpoints.length - 1;
    refreshTrackViz();
    if (!(opts && opts.silent)) markDirty();
  }

  // 「只看赛道」：把模型/景物/光源藏起来，摆门时不会被建筑挡视线
  function applyTrackFocus(on) {
    state.trackFocus = !!on;
    const vis = !state.trackFocus;
    for (const rec of state.placed) if (rec.obj) rec.obj.visible = vis;
    for (const rec of state.scenery) if (rec.obj) rec.obj.visible = vis;
    for (const rec of state.lights) {
      if (rec.obj) rec.obj.visible = vis;
      if (rec.helper) rec.helper.visible = vis;
    }
    if (StepUI.tkFocus) StepUI.tkFocus.checked = state.trackFocus;
  }

  function pickTrackGate(clientX, clientY) {
    if (!tkGates.length) return -1;
    controlOffset(clientX, clientY);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(tkGates.map((g) => g.userData.pick), false);
    return hits.length ? hits[0].object.userData.trackGate : -1;
  }

  function onTrackDown(e) {
    if (e.button !== 0) return;
    const gi = pickTrackGate(e.clientX, e.clientY);
    if (gi >= 0) { // 抓住一个门 → 拖它
      state.trackDrag = gi;
      state.trackSel = gi;
      // 记下起始像素与起始高度：按 Shift 拖动时用它算「往上拖 = 抬高」
      state.trackDragPx = e.clientY;
      state.trackDragY0 = state.track.checkpoints[gi] ? state.track.checkpoints[gi].y : 0;
      controls.enabled = false;
      refreshTrackViz();
      return;
    }
    // 点空白地面 → 在末尾接一个新门（新门从地面起，高度 0）
    const p = groundPos(e.clientX, e.clientY, hit);
    if (!p) return;
    const cps = state.track.checkpoints.concat([{ x: snapVal(p.x), y: 0, z: snapVal(p.z), w: TRACK_GATE_W_DEF }]);
    state.trackSel = cps.length - 1;
    setTrack({ checkpoints: cps });
  }

  function onTrackMove(e) {
    if (state.trackDrag === null) {
      renderer.domElement.style.cursor = pickTrackGate(e.clientX, e.clientY) >= 0 ? 'grab' : 'crosshair';
      return;
    }
    renderer.domElement.style.cursor = e.shiftKey ? 'ns-resize' : 'grabbing';
    // 按住 Shift = 只调高度（往上拖抬高）。用「相对起始点」的绝对位移算，
    // 中途才按下 Shift 也不会跳一下；系数 0.1 米/像素，再走一次吸附取整。
    if (e.shiftKey) {
      const dy = (state.trackDragPx || e.clientY) - e.clientY;
      const ny = snapVal((state.trackDragY0 || 0) + dy * 0.1);
      if (Math.abs(ny - state.trackDragY0) < 1e-6) return;
      const cps = state.track.checkpoints.map((c, i) => (i === state.trackDrag ? { ...c, y: ny } : c));
      setTrack({ checkpoints: cps });
      return;
    }
    const p = groundPos(e.clientX, e.clientY, hit);
    if (!p) return;
    const cps = state.track.checkpoints.map((c, i) => (i === state.trackDrag
      ? { ...c, x: snapVal(p.x), z: snapVal(p.z) } : c));
    setTrack({ checkpoints: cps });
  }

  function onTrackUp() {
    if (state.trackDrag === null) return;
    state.trackDrag = null;
    controls.enabled = true;
    renderer.domElement.style.cursor = 'default';
    markDirty();
  }

  // 俯视全览：把整条赛道框进画面（没门时退回地面中心）
  function frameTrackTop() {
    const cps = state.track.checkpoints;
    let cx = 0, cy = 0, cz = 0, span = 60;
    if (cps.length) {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, sumY = 0;
      for (const c of cps) {
        minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x);
        minZ = Math.min(minZ, c.z); maxZ = Math.max(maxZ, c.z);
        sumY += c.y;
      }
      cx = (minX + maxX) / 2;
      cz = (minZ + maxZ) / 2;
      cy = sumY / cps.length; // 立体赛道：俯视也要抬到赛道平均高度，否则整条线跑出画面
      span = Math.max(maxX - minX, maxZ - minZ, 40) + 40;
    }
    camera.position.set(cx, cy + span * 1.15, cz + 0.001);
    controls.target.set(cx, cy, cz);
    controls.update();
  }

  let trackCamBackup = null;
  if (StepUI.tkFrame) StepUI.tkFrame.onclick = () => frameTrackTop();
  if (StepUI.tkDel) StepUI.tkDel.onclick = () => {
    if (state.trackSel < 0) { StepUI.hint.textContent = '先在列表里（或点 3D 里的门）选中一个门'; return; }
    const cps = state.track.checkpoints.filter((_, i) => i !== state.trackSel);
    state.trackSel = Math.min(state.trackSel, cps.length - 1);
    setTrack({ checkpoints: cps });
  };
  if (StepUI.tkClear) StepUI.tkClear.onclick = () => {
    if (!state.track.checkpoints.length) return;
    state.trackSel = -1;
    setTrack({ checkpoints: [] });
  };
  if (StepUI.tkName) StepUI.tkName.addEventListener('input', () => setTrack({ name: StepUI.tkName.value || '校园狂飙' }));
  if (StepUI.tkLaps) StepUI.tkLaps.addEventListener('input', () => {
    const v = parseInt(StepUI.tkLaps.value, 10);
    if (Number.isFinite(v)) setTrack({ laps: v });
  });
  if (StepUI.tkFocus) StepUI.tkFocus.addEventListener('change', () => applyTrackFocus(StepUI.tkFocus.checked));
  // 选中门的高度：直接填数字（立体赛道的精确做法；粗略升降用「按住 Shift 拖门」更快）
  if (StepUI.tkY) StepUI.tkY.addEventListener('input', () => {
    const v = parseFloat(StepUI.tkY.value);
    if (!Number.isFinite(v) || state.trackSel < 0) return;
    const cps = state.track.checkpoints.map((c, i) => (i === state.trackSel ? { ...c, y: v } : c));
    setTrack({ checkpoints: cps });
  });

  // ---------- 模式切换 ----------
  // ---------- 测距器实现 ----------
  function rulerRemoveObjects() {
    if (rulerLine) { scene.remove(rulerLine); rulerLine = null; }
    if (rulerLabel) { scene.remove(rulerLabel); rulerLabel = null; }
  }
  function clearRuler() {
    rulerPts = [];
    rulerTmpPts.length = 0;
    rulerRemoveObjects();
    if (rm.dist) rm.dist.textContent = '—';
  }
  // 创建/更新 光线 + 距离标签
  function drawRuler(p1, p2) {
    rulerRemoveObjects();
    if (!p1 || !p2) return;
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(p1.x, p1.y, p1.z), new THREE.Vector3(p2.x, p2.y, p2.z)]);
    const mat = new THREE.LineBasicMaterial({ color: 0xff5252, depthTest: false });
    rulerLine = new THREE.Line(geo, mat);
    rulerLine.position.y = 0;
    rulerLine.renderOrder = 999; // 图层置顶：测距线不被模型遮挡
    scene.add(rulerLine);
    // 水平距离
    const dHor = Math.hypot(p2.x - p1.x, p2.z - p1.z);
    const dY = Math.abs(p2.y - p1.y);
    const txt = dY > 0.01 ? `水平 ${dHor.toFixed(2)} m · 高差 ${dY.toFixed(2)} m` : `${dHor.toFixed(2)} m`;
    // 用 sprite 标签显示在地面上方
    const canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 128;
    const c2 = canvas.getContext('2d');
    c2.fillStyle = 'rgba(0,0,0,0.7)';
    c2.roundRect(4, 4, 504, 120, 16); c2.fill();
    c2.fillStyle = '#fff'; c2.font = 'bold 44px sans-serif'; c2.textAlign = 'center'; c2.textBaseline = 'middle';
    c2.fillText(txt, 256, 64);
    const tex = new THREE.CanvasTexture(canvas);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    sp.renderOrder = 999; // 图层置顶：距离标签同样不被遮挡
    const mid = new THREE.Vector3((p1.x + p2.x) / 2, 0.25, (p1.z + p2.z) / 2);
    const d3 = mid.distanceTo(new THREE.Vector3(p1.x, mid.y, p1.z));
    const scale = Math.min(Math.max(d3 / 4, 0.8), 6);
    sp.scale.set(scale * 2, scale * 0.5, 1);
    sp.position.copy(mid);
    scene.add(sp);
    rulerLabel = sp;
    if (rm.dist) rm.dist.textContent = txt;
  }
  function hitGroundPoint(clientX, clientY) {
    const p = groundPos(clientX, clientY, new THREE.Vector3());
    return p ? { x: p.x, y: 0, z: p.z } : null;
  }
  function onRulerClick(clientX, clientY, idx) {
    const gp = hitGroundPoint(clientX, clientY);
    if (!gp) return;
    // idx 0 = 第一点(Shift+左键)，1 = 第二点(Shift+右键)；可随时重设任一点
    rulerPts[idx] = gp;
    drawRuler(rulerPts[0], rulerPts[1]);
    outlinerUpdate();
  }
  function onRulerMove(clientX, clientY) {
    if (rulerPts.length !== 1) return;
    const gp = hitGroundPoint(clientX, clientY);
    if (gp) drawRuler(rulerPts[0], gp);
  }
  // 挂到 DOM 引用
  let rm = { dist: null };
  rm.dist = document.getElementById('status');

  function setMode(m) {
    // 切到「边界 / 赛道 / 道具」前先退出组合编辑（草稿会顶替主场景，不能同时进行）
    if (state.comboMode && (m === 'bound' || m === 'track' || m === 'shop' || m === 'furn')) exitComboMode();
    state.mode = m;
    ['select', 'place', 'move', 'rot', 'scale', 'ruler', 'del', 'bound', 'track', 'shop', 'furn'].forEach((id) => {
      const btn = document.getElementById('t' + id.charAt(0).toUpperCase() + id.slice(1)) || document.getElementById('tDel');
      if (btn) btn.classList.remove('active');
    });
    const map = { select: StepUI.btnSelect, place: StepUI.btnPlace, move: StepUI.btnMove, rot: StepUI.btnRot, scale: StepUI.btnScale, del: StepUI.btnDel, ruler: StepUI.btnRuler, bound: StepUI.btnBound, track: StepUI.btnTrack, shop: StepUI.btnShop, furn: StepUI.btnFurn };
    (map[m] || StepUI.btnSelect).classList.add('active');
    if (m === 'ruler') {
      clearRuler();
      StepUI.hint.textContent = 'Shift+左键：第一点 · Shift+右键：第二点 · 未按 Shift 拖拽转视角';
    } else if (m === 'bound') {
      StepUI.hint.textContent = '拖青绿板 = 移动这条边 · 拖橙色角球 = 同时改相邻两边 · 右侧面板可填精确数值 · 右键拖拽转视角';
    } else if (m === 'track') {
      StepUI.hint.textContent = '左键点地面 = 在末尾加一个门 · 拖门 = 移动它 · 右键拖拽转视角 · 右侧面板可改圈数 / 删除 / 清空';
    } else if (m === 'shop') {
      StepUI.hint.textContent = '道具管理面板：改价格/导入模型即时全服生效 · 家具可先不放模型（占位方块）';
    } else if (m === 'furn') {
      StepUI.hint.textContent = '已摆家具管理：列出全服摆放，勾选后「删除选中」，或「清空全部」';
    } else if (StepUI.hint.textContent.includes('Shift') || StepUI.hint.textContent.includes('青绿板') || StepUI.hint.textContent.includes('个门') || StepUI.hint.textContent.includes('商店管理') || StepUI.hint.textContent.includes('已摆家具')) {
      StepUI.hint.textContent = '';
    }

    // 边界 / 赛道 / 商店模式：显示各自面板；离开时全部还原
    const isBound = m === 'bound';
    const isTrack = m === 'track';
    const isShop = m === 'shop';
    const isFurn = m === 'furn';
    boundaryGroup.visible = isBound;
    trackGroup.visible = isTrack;
    if (StepUI.boundaryPanel) StepUI.boundaryPanel.style.display = isBound ? 'block' : 'none';
    if (StepUI.trackPanel) StepUI.trackPanel.style.display = isTrack ? 'block' : 'none';
    if (StepUI.shopPanel) StepUI.shopPanel.style.display = isShop ? 'block' : 'none';
    if (StepUI.furnPanel) StepUI.furnPanel.style.display = isFurn ? 'block' : 'none';
    buildVizGroup.visible = isFurn;
    areaVizGroup.visible = isFurn;
    if (isFurn) fetchBuilds(); // 进入即拉一次全服已摆家具 + 建造范围
    if (isBound) {
      state.boundaryDrag = null;
      applyBoundaryFocus(StepUI.bFocus ? StepUI.bFocus.checked : true);
      refreshBoundaryViz();
      // 重复点「边界」不要把已经俯视的机位当成原机位存下来（否则退出后回不到原来的视角）
      if (!boundaryCamBackup) boundaryCamBackup = { pos: camera.position.clone(), target: controls.target.clone() };
      frameBoundaryTop();
    } else if (isTrack) {
      state.trackDrag = null;
      if (state.trackSel >= state.track.checkpoints.length) state.trackSel = state.track.checkpoints.length - 1;
      applyTrackFocus(StepUI.tkFocus ? StepUI.tkFocus.checked : true);
      refreshTrackViz();
      if (!trackCamBackup) trackCamBackup = { pos: camera.position.clone(), target: controls.target.clone() };
      frameTrackTop();
    } else {
      if (boundaryCamBackup) {
        camera.position.copy(boundaryCamBackup.pos);
        controls.target.copy(boundaryCamBackup.target);
        controls.update();
        boundaryCamBackup = null;
      }
      if (trackCamBackup) {
        camera.position.copy(trackCamBackup.pos);
        controls.target.copy(trackCamBackup.target);
        controls.update();
        trackCamBackup = null;
      }
      restoreAllVisible();
    }

    if (m === 'place') {
      tCtl.detach(); tCtl.enabled = false;
      resetGhost();
      if (!state.placingEmpty) StepUI.hint.textContent = '';
    } else if (isBound || isTrack || isShop || isFurn) {
      // 边界 / 赛道 / 商店模式不挂 3D 轴、也不放幽灵（选中物件只影响右侧普通面板）
      state.placingEmpty = false;
      if (state.ghost) { scene.remove(state.ghost); state.ghost = null; }
      tCtl.detach(); tCtl.enabled = false;
    } else {
      state.placingEmpty = false; // 离开放置：退出空碰撞体放置
      if (state.ghost) { scene.remove(state.ghost); state.ghost = null; }
      // 光源与普通物件互斥：优先处理被选中的光源（用现有 3D 轴驱动）
      const light = selectedLight();
      if (light && light.obj) {
        tCtl.attach(light.obj);
        tCtl.setMode(lightGizmoMode(light));
        tCtl.enabled = true;
      } else if (state.selected && GIZMO_MODE[m]) {
        // 已有选中对象时，按新模式挂上对应的 3D 轴
        tCtl.attach(state.selected.obj);
        tCtl.setMode(GIZMO_MODE[m]);
        tCtl.enabled = true;
      } else if (!GIZMO_MODE[m]) {
        tCtl.detach(); tCtl.enabled = false;
      }
    }
  }
  StepUI.btnSelect.onclick = () => setMode('select');
  StepUI.btnPlace.onclick = () => { state.placingEmpty = false; setMode('place'); };
  StepUI.btnMove.onclick = () => setMode('move');
  StepUI.btnRot.onclick = () => setMode('rot');
  StepUI.btnScale.onclick = () => setMode('scale');
  StepUI.btnRuler.onclick = () => setMode('ruler');
  if (StepUI.btnBound) StepUI.btnBound.onclick = () => setMode('bound'); // 边界编辑模式（空气墙）
  if (StepUI.btnTrack) StepUI.btnTrack.onclick = () => setMode('track'); // 赛道编辑模式（校园狂飙）

  // ---------- 商店管理（在线改价格 / 导入模型） ----------
  // 与后端 /api/shop 对接：GET 公开读、POST 带管理员密钥改（add/update/del）。
  // 价格改动即时全服生效（玩家进游戏会重新拉 /api/shop 覆盖本地目录）。
  const SHOP_TOKEN_KEY = 'fpm-shop-token';
  let editingShopId = null;        // 正在编辑的商品 id；null 表示新增
  let lastShopItems = [];          // 最近一次拉取的商品列表（保存/删除后就地更新）
  if (StepUI.shopToken) {
    const savedTok = localStorage.getItem(SHOP_TOKEN_KEY) || '';
    StepUI.shopToken.value = savedTok;
    StepUI.shopToken.addEventListener('input', () => localStorage.setItem(SHOP_TOKEN_KEY, StepUI.shopToken.value || ''));
  }
  function shopApiUrl() { return API_ROOT + '/api/shop'; }
  function shopToken() { return (StepUI.shopToken && StepUI.shopToken.value) || ''; }
  function setShopFormHint(text, cls) {
    if (!StepUI.shopFormHint) return;
    StepUI.shopFormHint.textContent = text || '';
    StepUI.shopFormHint.style.color = cls === 'err' ? '#ff8888' : '#9fe0a8';
  }
  function renderShopList(items) {
    if (!StepUI.shopList) return;
    lastShopItems = items || [];
    if (!items || !items.length) {
      StepUI.shopList.innerHTML = '<div style="color:#7d8894">（空）</div>';
      return;
    }
    StepUI.shopList.innerHTML = '';
    for (const it of items) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:3px 4px;border-radius:3px;cursor:pointer;';
      row.style.borderBottom = '1px solid #333';
      const badge = it.kind === 'building'
        ? '<span style="color:#7ec8ff">家具</span>'
        : '<span style="color:#cfe0f5">道具</span>';
      const nm = document.createElement('span');
      nm.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      nm.innerHTML = '<b>' + escapeHtml(it.name) + '</b> <span style="color:#8a93a0;font-size:11px">' + escapeHtml(it.id) + '</span> · ' + badge + ' · <b style="color:#ffd479">' + (it.price || 0) + '</b> 学币';
      const edit = document.createElement('span');
      edit.textContent = '✎';
      edit.title = '编辑';
      edit.style.cssText = 'cursor:pointer;color:#9fe0a8;padding:0 4px;flex:0 0 auto';
      edit.onclick = (e) => { e.stopPropagation(); editShopItem(it); };
      const del = document.createElement('span');
      del.textContent = '✕';
      del.title = '删除';
      del.style.cssText = 'cursor:pointer;color:#f88;padding:0 4px;flex:0 0 auto';
      del.onclick = (e) => { e.stopPropagation(); deleteShopItem(it.id); };
      row.appendChild(nm); row.appendChild(edit); row.appendChild(del);
      row.onclick = () => editShopItem(it);
      StepUI.shopList.appendChild(row);
    }
  }
  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  async function fetchShop() {
    try {
      const r = await fetch(shopApiUrl());
      const body = await r.json().catch(() => null);
      if (!r.ok || !body || !body.ok) {
        setShopFormHint('拉取商店失败：HTTP ' + r.status, 'err');
        return;
      }
      renderShopList(body.items);
      setShopFormHint('已加载 ' + (body.items ? body.items.length : 0) + ' 个商品', '');
    } catch (e) {
      setShopFormHint('拉取商店失败：' + (e && e.message ? e.message : e), 'err');
    }
  }
  function resetShopForm() {
    editingShopId = null;
    if (StepUI.shopId) StepUI.shopId.value = '';
    if (StepUI.shopName) StepUI.shopName.value = '';
    if (StepUI.shopKind) StepUI.shopKind.value = 'item';
    if (StepUI.shopPrice) StepUI.shopPrice.value = '100';
    if (StepUI.shopDesc) StepUI.shopDesc.value = '';
    if (StepUI.shopFile) StepUI.shopFile.value = '';
    if (StepUI.shopUrl) StepUI.shopUrl.value = '';
    setShopFormHint('', '');
  }
  function editShopItem(it) {
    editingShopId = it.id;
    if (StepUI.shopId) StepUI.shopId.value = it.id;
    if (StepUI.shopName) StepUI.shopName.value = it.name || '';
    if (StepUI.shopKind) StepUI.shopKind.value = it.kind === 'building' ? 'building' : 'item';
    if (StepUI.shopPrice) StepUI.shopPrice.value = String(it.price != null ? it.price : 0);
    if (StepUI.shopDesc) StepUI.shopDesc.value = it.desc || '';
    if (StepUI.shopUrl) StepUI.shopUrl.value = it.url || '';
    if (StepUI.shopFile) StepUI.shopFile.value = '';
    setShopFormHint('正在编辑：' + it.id + '（保存即覆盖）', '');
  }
  // 上传选中的 GLB 模型，返回后端 url（复用现有上传通道：线上优先 + 同源兜底）
  async function uploadShopModel(file) {
    if (file.size > MAX_UPLOAD_BYTES) {
      setShopFormHint('模型太大：' + (file.size / 1048576).toFixed(1) + 'MB，超过后端上限 ' + (MAX_UPLOAD_BYTES / 1048576) + 'MB', 'err');
      return { url: '' };
    }
    let ab;
    try { ab = await file.arrayBuffer(); } catch (e) { setShopFormHint('读取文件失败：' + e, 'err'); return { url: '' }; }
    const targets = [...new Set([UPLOAD_URL, SAME_ORIGIN_UPLOAD])].filter((u) => /^https?:\/\//.test(u) || u.startsWith('/'));
    const reasons = [];
    for (const u of targets) {
      const r = await uploadModel(u, file, ab);
      if (r.url) return { url: r.url };
      reasons.push(u + ' → ' + r.reason);
    }
    setShopFormHint('模型上传失败：\n' + reasons.join('\n'), 'err');
    return { url: '' };
  }
  async function saveShopItem() {
    const token = shopToken();
    if (!token) { setShopFormHint('请先填管理员密钥', 'err'); return; }
    const name = (StepUI.shopName.value || '').trim();
    if (!name) { setShopFormHint('请填商品名称', 'err'); return; }
    const kind = StepUI.shopKind.value === 'building' ? 'building' : 'item';
    const price = Math.max(0, Math.min(100000, Math.floor(Number(StepUI.shopPrice.value) || 0)));

    let url = (StepUI.shopUrl.value || '').trim();
    if (StepUI.shopFile && StepUI.shopFile.files && StepUI.shopFile.files[0]) {
      setShopFormHint('模型上传中…', '');
      const up = await uploadShopModel(StepUI.shopFile.files[0]);
      if (!up.url) return; // 错误已提示
      url = up.url;
    }
    if (kind === 'building') {
      if (!url) url = 'placeholder'; // 家具可先无模型（占位方块），之后在编辑器导入真模型
    } else if (!/^\/(assets|models)\//.test(url)) {
      setShopFormHint('模型 URL 必须是 /assets/ 或 /models/ 下的 .glb（道具留空则无模型）', 'err');
      return;
    }

    // id：编辑时锁定为正在编辑的 id；新增时取表单编号，留空则自动生成
    const id = editingShopId || (StepUI.shopId.value || '').trim() || ('shop-' + Date.now());
    const op = editingShopId ? 'update' : 'add';
    const item = {
      id,
      name,
      kind,
      price,
      url,
      desc: (StepUI.shopDesc.value || '').slice(0, 200),
    };
    if (kind === 'item') {
      // 家具之外不强制 effect；保留现有道具的 effect（编辑时从列表取），新增默认无
      const exist = (lastShopItems || []).find((x) => x.id === id);
      item.effect = exist && exist.effect ? exist.effect : null;
    }
    setShopFormHint(op === 'add' ? '新增中…' : '保存中…', '');
    try {
      const r = await fetch(shopApiUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, op, item, id: editingShopId || undefined }),
      });
      const body = await r.json().catch(() => null);
      if (!r.ok || !body || !body.ok) {
        setShopFormHint('保存失败：HTTP ' + r.status + (body && body.error ? ' · ' + body.error : ''), 'err');
        return;
      }
      renderShopList(body.items);
      resetShopForm();
      setShopFormHint('已' + (op === 'add' ? '新增' : '更新') + '：' + name, '');
    } catch (e) {
      setShopFormHint('保存失败：' + (e && e.message ? e.message : e), 'err');
    }
  }
  async function deleteShopItem(id) {
    if (!confirm('确定删除商品「' + id + '」？该操作立即全服生效。')) return;
    const token = shopToken();
    if (!token) { setShopFormHint('请先填管理员密钥', 'err'); return; }
    setShopFormHint('删除中…', '');
    try {
      const r = await fetch(shopApiUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, op: 'del', id }),
      });
      const body = await r.json().catch(() => null);
      if (!r.ok || !body || !body.ok) {
        setShopFormHint('删除失败：HTTP ' + r.status + (body && body.error ? ' · ' + body.error : ''), 'err');
        return;
      }
      renderShopList(body.items);
      setShopFormHint('已删除：' + id, '');
    } catch (e) {
      setShopFormHint('删除失败：' + (e && e.message ? e.message : e), 'err');
    }
  }
  if (StepUI.btnShop) StepUI.btnShop.onclick = () => { setMode('shop'); fetchShop(); };
  if (StepUI.shopRefresh) StepUI.shopRefresh.onclick = () => fetchShop();
  if (StepUI.shopSave) StepUI.shopSave.onclick = () => saveShopItem();
  if (StepUI.shopCancel) StepUI.shopCancel.onclick = () => resetShopForm();

  // ---------- 已摆家具管理（全服）：列出 / 勾选删除 / 清空 ----------
  let lastBuilds = [];
  if (StepUI.furnToken) {
    const t0 = localStorage.getItem(SHOP_TOKEN_KEY) || '';
    if (t0) StepUI.furnToken.value = t0;
    StepUI.furnToken.addEventListener('input', () => localStorage.setItem(SHOP_TOKEN_KEY, StepUI.furnToken.value || ''));
  }
  function furnToken() { return (StepUI.furnToken && StepUI.furnToken.value) || ''; }
  function setFurnMsg(text, cls) {
    if (!StepUI.furnMsg) return;
    StepUI.furnMsg.textContent = text || '';
    StepUI.furnMsg.style.color = cls === 'err' ? '#ff8888' : '#9fe0a8';
  }
  function renderFurnList() {
    if (!StepUI.furnList) return;
    if (!lastBuilds.length) {
      StepUI.furnList.innerHTML = '<div style="color:#7d8894">（当前没有任何已摆家具）</div>';
      return;
    }
    StepUI.furnList.innerHTML = '';
    for (const b of lastBuilds) {
      const row = document.createElement('label');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.06);cursor:pointer';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.id = b.id;
      cb.style.cssText = 'flex:0 0 auto';
      const item = (lastShopItems || []).find((x) => x.id === b.itemId);
      // 归属标记：登录账号 → 「玩家」；游客 → 「游客 + IP 尾段」（全叫"游客"看不出谁是谁）
      let mineMark = '';
      if (b.owner) {
        mineMark = b.owner.startsWith('u:')
          ? '玩家'
          : '游客 ' + String(b.owner.slice(4)).split(':').pop().slice(-11);
      }
      const txt = document.createElement('span');
      txt.textContent = (item ? item.name : (b.itemId || '?')) +
        '  ·  ' + String(b.id).slice(-6) +
        '  (' + Math.round(b.x) + ', ' + Math.round(b.y || 0) + ', ' + Math.round(b.z) + ')' +
        (mineMark ? '  ' + mineMark : '');
      txt.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      row.appendChild(cb); row.appendChild(txt);
      StepUI.furnList.appendChild(row);
    }
  }
  async function postBuild(payload) {
    const r = await fetch(API_ROOT + '/api/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await r.json().catch(() => null);
    return { ok: !!(r.ok && body && body.ok), status: r.status, body };
  }
  // 拉一次商品目录（拿模型 url / 名称），供场景里渲染家具用
  async function ensureCatalog() {
    if ((lastShopItems || []).length) return;
    try {
      const r = await fetch(shopApiUrl());
      const b = await r.json();
      if (b && Array.isArray(b.items)) lastShopItems = b.items;
    } catch (e) { /* 拉不到就用占位方块 */ }
  }
  function addBuildBox(host, item) {
    const s = (item && Array.isArray(item.size) && item.size.length === 3) ? item.size : [1, 1, 1];
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(Number(s[0]) || 1, Number(s[1]) || 1, Number(s[2]) || 1),
      new THREE.MeshStandardMaterial({ color: 0xb98a4b, roughness: 0.85 })
    );
    m.castShadow = true; m.receiveShadow = true;
    host.add(m);
  }
  // 把全服已摆家具渲染进编辑器场景（独立 group，不参与编辑器的选中 / 碰撞逻辑）
  function renderBuildsInScene() {
    for (let i = buildVizGroup.children.length - 1; i >= 0; i--) buildVizGroup.remove(buildVizGroup.children[i]);
    for (const b of lastBuilds) {
      const item = (lastShopItems || []).find((x) => x.id === b.itemId);
      const host = new THREE.Group();
      host.position.set(Number(b.x) || 0, Number(b.y) || 0, Number(b.z) || 0);
      host.rotation.y = (Number(b.rotY) || 0) * DEG;
      host.scale.setScalar(Number(b.scale) || 1);
      buildVizGroup.add(host);
      const url = item && item.url;
      if (url && url !== 'placeholder') {
        instantiate(url).then((m) => { host.add(m); enableShadows(m); }).catch(() => addBuildBox(host, item));
      } else {
        addBuildBox(host, item);
      }
    }
  }
  async function fetchBuilds() {
    setFurnMsg('拉取中…', '');
    try {
      const r = await fetch(API_ROOT + '/api/build');
      const body = await r.json().catch(() => null);
      if (!r.ok || !body || !body.ok) { setFurnMsg('拉取失败：HTTP ' + r.status, 'err'); return; }
      lastBuilds = body.items || [];
      await ensureCatalog();
      renderFurnList();
      renderBuildsInScene();
      setFurnMsg('共 ' + lastBuilds.length + ' 件已摆家具', '');
    } catch (e) { setFurnMsg('拉取失败：' + (e && e.message ? e.message : e), 'err'); }
    fetchAreas(); // 顺带刷新建造范围
  }
  function checkedIds() {
    if (!StepUI.furnList) return [];
    return [...StepUI.furnList.querySelectorAll('input[type=checkbox]')].filter((c) => c.checked).map((c) => c.dataset.id);
  }
  async function deleteSelectedBuilds() {
    if (!furnToken()) { setFurnMsg('请先填管理员密钥', 'err'); return; }
    const ids = checkedIds();
    if (!ids.length) { setFurnMsg('先勾选要删除的家具', 'err'); return; }
    setFurnMsg('删除中…（共 ' + ids.length + ' 件）', '');
    let done = 0, fail = 0;
    for (const id of ids) {
      const res = await postBuild({ op: 'del', id, token: furnToken() });
      if (res.ok) done++; else fail++;
    }
    setFurnMsg('已删除 ' + done + ' 件' + (fail ? ('，失败 ' + fail + ' 件（密钥不对或服务端未更新）') : ''), fail ? 'err' : '');
    await fetchBuilds();
  }
  async function clearAllBuilds() {
    if (!furnToken()) { setFurnMsg('请先填管理员密钥', 'err'); return; }
    if (typeof window.confirm === 'function' && !window.confirm('确定清空全服所有已摆家具？此操作不可撤销。')) return;
    setFurnMsg('清空中…', '');
    const res = await postBuild({ op: 'clear', token: furnToken() });
    if (res.ok) setFurnMsg('已清空，剩余 ' + (res.body && res.body.count) + ' 件', '');
    else setFurnMsg('清空失败：HTTP ' + res.status + (res.body && res.body.error ? ' · ' + res.body.error : ''), 'err');
    await fetchBuilds();
  }
  if (StepUI.btnFurn) StepUI.btnFurn.onclick = () => setMode('furn');
  if (StepUI.furnRefresh) StepUI.furnRefresh.onclick = () => fetchBuilds();
  if (StepUI.furnAll) StepUI.furnAll.onclick = () => { if (StepUI.furnList) StepUI.furnList.querySelectorAll('input[type=checkbox]').forEach((c) => { c.checked = true; }); };
  if (StepUI.furnNone) StepUI.furnNone.onclick = () => { if (StepUI.furnList) StepUI.furnList.querySelectorAll('input[type=checkbox]').forEach((c) => { c.checked = false; }); };
  if (StepUI.furnDelSel) StepUI.furnDelSel.onclick = () => deleteSelectedBuilds();
  if (StepUI.furnClearAll) StepUI.furnClearAll.onclick = () => clearAllBuilds();

  // ---------- 建造范围（家具只能摆在这些矩形内）：编辑器可改，保存后全服即时生效 ----------
  let buildAreas = [];
  function setAreaMsg(text, cls) {
    if (!StepUI.areaMsg) return;
    StepUI.areaMsg.textContent = text || '';
    StepUI.areaMsg.style.color = cls === 'err' ? '#ff8888' : '#9fe0a8';
  }
  function drawAreaViz() {
    for (let i = areaVizGroup.children.length - 1; i >= 0; i--) areaVizGroup.remove(areaVizGroup.children[i]);
    for (const a of buildAreas) {
      const w = Math.max(0.1, a.maxX - a.minX), d = Math.max(0.1, a.maxZ - a.minZ);
      const cx = (a.minX + a.maxX) / 2, cz = (a.minZ + a.maxZ) / 2;
      const fill = new THREE.Mesh(
        new THREE.PlaneGeometry(w, d),
        new THREE.MeshBasicMaterial({ color: 0x3fd07a, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false })
      );
      fill.rotation.x = -Math.PI / 2;
      fill.position.set(cx, 0.06, cz);
      areaVizGroup.add(fill);
      const pts = [
        new THREE.Vector3(a.minX, 0.08, a.minZ), new THREE.Vector3(a.maxX, 0.08, a.minZ),
        new THREE.Vector3(a.maxX, 0.08, a.maxZ), new THREE.Vector3(a.minX, 0.08, a.maxZ),
        new THREE.Vector3(a.minX, 0.08, a.minZ),
      ];
      areaVizGroup.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0x3fd07a })
      ));
    }
  }
  function renderAreaList() {
    if (!StepUI.areaList) return;
    StepUI.areaList.innerHTML = '';
    buildAreas.forEach((a, i) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:3px;align-items:center;margin:3px 0';
      const name = document.createElement('input');
      name.type = 'text'; name.value = a.name || ''; name.placeholder = '名称';
      name.style.cssText = 'width:58px';
      name.oninput = () => { buildAreas[i].name = name.value; };
      row.appendChild(name);
      const mk = (key, title) => {
        const inp = document.createElement('input');
        inp.type = 'number'; inp.step = '1'; inp.title = title; inp.value = String(a[key]);
        inp.style.cssText = 'width:52px';
        inp.oninput = () => { const v = Number(inp.value); if (Number.isFinite(v)) { buildAreas[i][key] = v; drawAreaViz(); } };
        return inp;
      };
      row.appendChild(mk('minX', 'X 最小'));
      row.appendChild(mk('maxX', 'X 最大'));
      row.appendChild(mk('minZ', 'Z 最小'));
      row.appendChild(mk('maxZ', 'Z 最大'));
      const del = document.createElement('button');
      del.type = 'button'; del.className = 'import-btn'; del.textContent = '✕';
      del.style.cssText = 'flex:0 0 auto;padding:2px 6px';
      del.onclick = () => { buildAreas.splice(i, 1); renderAreaList(); drawAreaViz(); };
      row.appendChild(del);
      StepUI.areaList.appendChild(row);
    });
    if (!buildAreas.length) StepUI.areaList.innerHTML = '<div style="color:#7d8894">（没有范围 —— 点「加一个范围」）</div>';
  }
  async function fetchAreas() {
    try {
      const r = await fetch(API_ROOT + '/api/buildareas');
      const body = await r.json().catch(() => null);
      if (body && body.ok && Array.isArray(body.areas)) {
        buildAreas = body.areas.map((a) => ({ ...a }));
        renderAreaList(); drawAreaViz();
      }
    } catch (e) { /* 拿不到就保持现状 */ }
  }
  async function saveAreas() {
    if (!furnToken()) { setAreaMsg('请先填管理员密钥（上面那一栏）', 'err'); return; }
    if (!buildAreas.length) { setAreaMsg('至少要有一个范围', 'err'); return; }
    setAreaMsg('保存中…', '');
    try {
      const r = await fetch(API_ROOT + '/api/buildareas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: furnToken(), areas: buildAreas }),
      });
      const b = await r.json().catch(() => null);
      if (r.ok && b && b.ok) {
        buildAreas = b.areas.map((a) => ({ ...a }));
        renderAreaList(); drawAreaViz();
        setAreaMsg('已保存 ' + buildAreas.length + ' 个范围（在线玩家即时生效）', '');
      } else {
        setAreaMsg('保存失败：HTTP ' + r.status + (b && b.error ? ' · ' + b.error : ''), 'err');
      }
    } catch (e) { setAreaMsg('保存失败：' + (e && e.message ? e.message : e), 'err'); }
  }
  if (StepUI.areaAdd) StepUI.areaAdd.onclick = () => {
    buildAreas.push({ name: '新范围', minX: -10, maxX: 10, minZ: -10, maxZ: 10 });
    renderAreaList(); drawAreaViz();
  };
  if (StepUI.areaSave) StepUI.areaSave.onclick = () => saveAreas();
  // 恢复内置默认范围（= src/config.js 的 Config.BUILD_AREAS，与场景里两栋教学楼的实际占地一致）。
  // 线上曾出现「保存的范围和楼的实际位置不重合 → 楼里反而放不下」的事故，给个一键还原。
  // 用「当前选中物件」的世界包围盒生成一个建造范围 —— 选中教学楼点一下就出矩形，不用手输坐标。
  if (StepUI.areaFromSel) StepUI.areaFromSel.onclick = () => {
    const sel = state.selected;
    if (!sel || !sel.obj) { setAreaMsg('先在场景里左键选中一栋楼，再点这个', 'err'); return; }
    const box = new THREE.Box3().setFromObject(sel.obj);
    if (box.isEmpty()) { setAreaMsg('取不到包围盒（该对象没有网格）', 'err'); return; }
    const r1 = (v) => Math.round(v * 10) / 10;
    buildAreas.push({
      name: String(sel.name || '建筑').slice(0, 24),
      minX: r1(box.min.x), maxX: r1(box.max.x),
      minZ: r1(box.min.z), maxZ: r1(box.max.z),
    });
    renderAreaList(); drawAreaViz();
    setAreaMsg('已按「' + (sel.name || '选中物件') + '」生成范围 —— 核对后点「保存范围」写入服务器', '');
  };
  if (StepUI.areaReset) StepUI.areaReset.onclick = () => {
    const defs = (Config && Array.isArray(Config.BUILD_AREAS)) ? Config.BUILD_AREAS : [];
    if (!defs.length) { setAreaMsg('没有内置默认范围', 'err'); return; }
    buildAreas = defs.map((a) => ({ ...a }));
    renderAreaList(); drawAreaViz();
    setAreaMsg('已载入内置默认范围（还要点「保存范围」才会写进服务器）', '');
  };
  if (StepUI.areaFit) StepUI.areaFit.onclick = () => {
    const a = buildAreas[0];
    if (!a) return;
    const cx = (a.minX + a.maxX) / 2, cz = (a.minZ + a.maxZ) / 2;
    controls.target.set(cx, 0, cz);
    camera.position.set(cx, 130, cz + 100);
    controls.update();
  };

  // ---------- 组合家具：空白场景拼装 + 存成商店商品 ----------
  function setComboHint(text, cls) {
    if (!StepUI.comboHint) return;
    StepUI.comboHint.textContent = text || '';
    StepUI.comboHint.style.color = cls === 'err' ? '#ff8a8a' : '#9fe0a8';
  }
  function refreshComboInfo() {
    if (!StepUI.comboInfo) return;
    StepUI.comboInfo.textContent = '草稿：' + state.placed.length + ' 个模型 · ' + state.lights.length + ' 个灯';
  }
  // 进入「空白场景」：把主场景（摆放/景物/光源）临时藏起、数组换成空草稿，用现有放置/加灯工具拼装
  function enterComboMode() {
    if (state.comboMode) return;
    state.comboBackup = { placed: state.placed, lights: state.lights, scenery: state.scenery };
    for (const r of state.placed) if (r.obj) r.obj.visible = false;
    for (const r of state.lights) { if (r.obj) r.obj.visible = false; if (r.helper) r.helper.visible = false; }
    for (const r of state.scenery) if (r.obj) r.obj.visible = false;
    if (boundaryGroup) boundaryGroup.visible = false;
    if (trackGroup) trackGroup.visible = false;
    if (StepUI.boundaryPanel) StepUI.boundaryPanel.style.display = 'none';
    if (StepUI.trackPanel) StepUI.trackPanel.style.display = 'none';
    if (StepUI.shopPanel) StepUI.shopPanel.style.display = 'none';
    state.placed = [];   // 空草稿
    state.lights = [];
    state.scenery = [];
    state.comboMode = true;
    select(null);
    if (StepUI.comboPanel) StepUI.comboPanel.style.display = 'block';
    try { controls.target.set(0, 0, 0); camera.position.set(0, 45, 45); camera.lookAt(0, 0, 0); } catch (e) { /* ignore */ }
    outlinerUpdate();
    refreshComboInfo();
    setComboHint('已进入空白场景：左侧「放置」摆模型、「加点光源」加灯，摆好点「保存为商品」。', '');
    if (StepUI.hint) StepUI.hint.textContent = '组合编辑：空白场景 · 摆模型/加灯 · 保存为商品';
  }
  // 退出组合：删掉草稿，还原主场景
  function exitComboMode() {
    if (!state.comboMode) return;
    for (const r of state.placed) if (r.obj) scene.remove(r.obj);
    for (const r of state.lights) { if (r.obj) scene.remove(r.obj); if (r.helper) scene.remove(r.helper); }
    state.placed = state.comboBackup.placed;
    state.lights = state.comboBackup.lights;
    state.scenery = state.comboBackup.scenery;
    for (const r of state.placed) if (r.obj) r.obj.visible = true;
    for (const r of state.lights) { if (r.obj) r.obj.visible = true; if (r.helper) r.helper.visible = true; }
    for (const r of state.scenery) if (r.obj) r.obj.visible = true;
    state.comboMode = false;
    state.comboBackup = null;
    if (StepUI.comboPanel) StepUI.comboPanel.style.display = 'none';
    setMode(state.mode); // 恢复当前模式的边界/赛道可视化与右侧面板
    outlinerUpdate();
  }
  function clearComboDraft() {
    for (const r of state.placed) if (r.obj) scene.remove(r.obj);
    for (const r of state.lights) { if (r.obj) scene.remove(r.obj); if (r.helper) scene.remove(r.helper); }
    state.placed = [];
    state.lights = [];
    select(null);
    outlinerUpdate();
    refreshComboInfo();
    setComboHint('草稿已清空。', '');
  }
  async function saveComboItem() {
    const token = (StepUI.comboToken && StepUI.comboToken.value) || '';
    if (!token) { setComboHint('请先填管理员密钥（与「道具」页同一个）', 'err'); return; }
    const name = ((StepUI.comboName && StepUI.comboName.value) || '').trim();
    if (!name) { setComboHint('请填组合名称', 'err'); return; }
    if (!state.placed.length) { setComboHint('组合里至少放一个模型', 'err'); return; }
    const price = Math.max(0, Math.min(100000, Math.floor(Number(StepUI.comboPrice && StepUI.comboPrice.value) || 0)));
    const parts = state.placed.map((rec) => {
      const s = normScale(rec.scale ?? rec.obj.scale);
      return {
        url: rec.url,
        x: rec.x ?? rec.obj.position.x, y: rec.y ?? rec.obj.position.y, z: rec.z ?? rec.obj.position.z,
        rotY: rec.rotY ?? 0,
        scale: { x: s.x, y: s.y, z: s.z },
      };
    }).filter((p) => /^\/(assets|models)\//.test(p.url));
    if (!parts.length) { setComboHint('草稿里的模型没有有效路径（需要 /assets 或 /models 的 glb）', 'err'); return; }
    const lights = state.lights.map((rec) => {
      const out = { type: rec.type === 'area' ? 'area' : 'point', x: rec.x ?? 0, y: rec.y ?? 3, z: rec.z ?? 0, color: lightColorHex(rec), intensity: rec.intensity ?? 1 };
      if (out.type === 'area') { out.width = rec.width ?? 4; out.height = rec.height ?? 3; out.rotY = rec.rotY ?? 0; out.rotX = rec.rotX ?? 0; }
      else { out.distance = rec.distance ?? 12; out.decay = rec.decay ?? 2; }
      return out;
    });
    const id = ((StepUI.comboId && StepUI.comboId.value) || '').trim() || ('combo-' + Date.now());
    setComboHint('保存中…', '');
    try {
      const r = await fetch(shopApiUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token, op: 'add',
          item: {
            id, name, kind: 'building', price, url: 'combo',
            desc: '组合家具（' + parts.length + ' 个部件 · ' + lights.length + ' 个灯）',
            combo: { parts, lights },
          },
        }),
      });
      const body = await r.json().catch(() => null);
      if (!r.ok || !body || !body.ok) { setComboHint('保存失败：HTTP ' + r.status + (body && body.error ? ' · ' + body.error : ''), 'err'); return; }
      if (StepUI.comboId) StepUI.comboId.value = id;
      setComboHint('已保存为商品：' + name + '（id=' + id + '）。到游戏商店「家具」页即可购买。', '');
    } catch (e) {
      setComboHint('保存失败：' + (e && e.message ? e.message : e), 'err');
    }
  }
  if (StepUI.btnCombo) StepUI.btnCombo.onclick = () => { if (state.comboMode) exitComboMode(); else enterComboMode(); };
  if (StepUI.comboToken) {
    StepUI.comboToken.value = localStorage.getItem(SHOP_TOKEN_KEY) || '';
    StepUI.comboToken.addEventListener('input', () => localStorage.setItem(SHOP_TOKEN_KEY, StepUI.comboToken.value || ''));
  }
  if (StepUI.comboClear) StepUI.comboClear.onclick = () => clearComboDraft();
  if (StepUI.comboSave) StepUI.comboSave.onclick = () => saveComboItem();
  if (StepUI.comboExit) StepUI.comboExit.onclick = () => exitComboMode();

  StepUI.btnDel.onclick = () => { if (state.selected && state.selected.kind !== 'scenery') removePlaced(state.selected); };
  setMode('place');

  // 复制模式开关：开启后拖动 3D 轴即复制一份，拖一次复制一次（原件保留）
  document.getElementById('tCopy').onclick = () => {
    state.copyMode = !state.copyMode;
    document.getElementById('tCopy').classList.toggle('active', state.copyMode);
    StepUI.hint.textContent = state.copyMode
      ? '复制模式：拖动（移动/旋转/缩放）即复制一份，拖一次复制一次；再点「复制」关闭'
      : '';
  };

  // 阵列复制：弹出参数窗，以选中对象为起点沿 X/Z 网格生成副本
  const arrModal = document.getElementById('arrayModal');
  document.getElementById('tArray').onclick = () => {
    if (!state.selected) {
      StepUI.hint.textContent = '请先选中一个对象，再点「阵列」';
      return;
    }
    arrModal.classList.add('open');
  };
  document.getElementById('arrClose').onclick = () => arrModal.classList.remove('open');
  arrModal.addEventListener('click', (e) => { if (e.target === arrModal) arrModal.classList.remove('open'); });
  document.getElementById('arrGo').onclick = () => {
    if (!state.selected) { arrModal.classList.remove('open'); return; }
    const nx = Math.max(1, parseInt(document.getElementById('arrNX').value, 10) || 1);
    const nz = Math.max(1, parseInt(document.getElementById('arrNZ').value, 10) || 1);
    const sp = Math.max(0.1, parseFloat(document.getElementById('arrSp').value) || 1);
    const total = arrayDuplicate(state.selected, nx, nz, sp);
    arrModal.classList.remove('open');
    StepUI.hint.textContent = '已阵列生成 ' + total + ' 个副本（原件保留）';
  };

  document.getElementById('btnClear').onclick = () => {
    state.placed.forEach((p) => scene.remove(p.obj));
    state.placed = [];
    select(null);
    markDirty();
    outlinerUpdate();
  };

  // 添加空碰撞体：改用放置流程（圆环跟随鼠标，点击落点生成），可连放多个；
  // 点「放置」工具按钮可切回正常模型放置
  StepUI.btnEmptyCollider.onclick = () => {
    state.placingEmpty = true;
    setMode('place');
    resetGhost();
    StepUI.hint.textContent = '点击地面落点放置空碰撞体（可连放多个）· 点「放置」按钮返回模型放置';
    closeLibrary(); // 弹窗收起，回到视口落点放置
  };

  // 窗口自适应
  function resize() {
    const [w, h] = size();
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);

  // ---------- WASD 视角平移 ----------
  const moveKeys = new Set();
  window.addEventListener('keydown', (e) => {
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return; // 输入框内不触发移动
    moveKeys.add(e.key.toLowerCase());
  });
  window.addEventListener('keyup', (e) => moveKeys.delete(e.key.toLowerCase()));
  // 每帧把 camera + controls.target 一起平移，实现沿视角方向自由飞行：
  // W/S 沿视线（含俯仰）前/后，A/D 横向平移，Space 上升 / Shift 下降，视线方向不因平移改变
  function applyWASDMove(dt) {
    const f = (moveKeys.has('w') ? 1 : 0) - (moveKeys.has('s') ? 1 : 0);
    const r = (moveKeys.has('d') ? 1 : 0) - (moveKeys.has('a') ? 1 : 0);
    const u = (moveKeys.has(' ') ? 1 : 0) - (moveKeys.has('shift') ? 1 : 0); // Space 上 / Shift 下
    if (!f && !r && !u) return;
    // 速度随视距自适应：贴近地面时慢速微调，拉远视角后快速长距离飞行
    const dist = camera.position.distanceTo(controls.target);
    const spd = CAM_SPEED * Math.min(Math.max(dist / 25, 0.6), 5) * dt;
    const fwd = camera.getWorldDirection(new THREE.Vector3());           // 完整视线方向（含俯仰）
    const rgt = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion); // 相机本地右向，始终垂直于视线
    const delta = new THREE.Vector3().addScaledVector(fwd, f * spd)
      .addScaledVector(rgt, r * spd)
      .addScaledVector(UP, u * spd);
    camera.position.add(delta);
    controls.target.add(delta);
  }

  // 渲染循环
  let _t0 = performance.now();
  function loop() {
    const t = performance.now();
    applyWASDMove(Math.min((t - _t0) / 1000, 0.1));
    _t0 = t;
    controls.update();
    // 阴影跟随相机：把焦点按「像素世界尺寸」取整到网格再贴，阳光随其相对偏移平移，保持光向不变。
    // 取整避免亚像素级移动导致阴影贴图来回平移而出现的「泳动/抖动」。
    const R = (sun.shadow.camera.right - sun.shadow.camera.left) / 2;
    const texel = (R * 2) / sun.shadow.mapSize.x; // 单个阴影 texel 对应的世界尺寸
    sunTarget.position.set(
      Math.round(camera.position.x / texel) * texel,
      0,
      Math.round(camera.position.z / texel) * texel
    );
    sun.position.copy(sunTarget.position).add(sunOffset);
    sunTarget.updateMatrixWorld();
    renderer.render(scene, camera);
    state.raf = requestAnimationFrame(loop);
  }

  adoptGameScenery();
  restore();
  loop();
  resize();

  // ---- 画面设置面板：光照设计(环境光/阳光强度、阳光角度)+阴影，即时生效并持久化给客户端 ----
  // 阴影相机范围、贴图分辨率、开关都是可运行时调整项；范围跟视距（编辑器中与相机距离相关）
  const sunShadow = {
    shadowR: (v) => {
      sun.shadow.camera.left = -v;
      sun.shadow.camera.right = v;
      sun.shadow.camera.top = v;
      sun.shadow.camera.bottom = -v;
      sun.shadow.camera.updateProjectionMatrix();
    },
    shadowSize: (v) => {
      sun.shadow.mapSize.set(v, v);
      if (sun.shadow.map) {
        sun.shadow.map.dispose();
        sun.shadow.map = null;
      }
    },
    castShadow: (v) => {
      renderer.shadowMap.enabled = !!v;
      sun.castShadow = !!v;
    },
  };
  // 阳光方向由高度角/方位角换算，重算偏移并落到 sun 上（每帧 loop 会以 sunOffset 跟随相机）
  let sunElev = DEFAULT_SETTINGS.sunElev;
  let sunAz = DEFAULT_SETTINGS.sunAz;
  const applySunAngle = () => {
    const o = computeSunOffset(sunElev, sunAz);
    sunOffset.set(o.x, o.y, o.z);
    sun.position.copy(sunTarget.position).add(sunOffset);
  };
  const settingsPanel = createSettingsPanel(
    {
      ambient: (v) => (ambient.intensity = v),
      hemi: (v) => (hemi.intensity = v),
      sun: (v) => (sun.intensity = v),
      sunElev: (v) => {
        sunElev = v;
        applySunAngle();
      },
      sunAz: (v) => {
        sunAz = v;
        applySunAngle();
      },
      shadowR: sunShadow.shadowR,
      shadowSize: sunShadow.shadowSize,
      castShadow: sunShadow.castShadow,
    },
    // 编辑器面板：光照设计(环境光/半球光/阳光强度+角度) + 阴影，不透出视距（视距由游戏客户端可调）
    // liveApply：编辑器要边调边看场景，控件改动即时生效（游戏端则用「应用设置」暂存提交）。
    { fields: ['ambient', 'hemi', 'sun', 'sunElev', 'sunAz', 'shadowR', 'shadowSize', 'castShadow'], liveApply: true }
  );
  const btnSettings = document.getElementById('btnSettings');
  if (btnSettings) btnSettings.onclick = () => settingsPanel.toggle();
  state.settingsPanel = settingsPanel;

  return { state, setMode };
}