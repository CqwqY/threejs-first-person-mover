// 城市建筑编辑器（独立开发工具，与游戏运行时无任何联动）。
// 自由视角（WASD 平移 + 右键拖拽转视角 + 滚轮缩放）+ 3D 变换轴（TransformControls）。
// 交互：点击模型即选中；移动/旋转/缩放模式会出现可拖动的彩色 3D 轴；
// WASD 平移视角、右键拖拽转视角、滚轮缩放。游戏景物在编辑器中亦可选中编辑。
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { instantiate } from '../world/AssetLoader.js';
import { API_BASE } from '../config.js';
// 复用游戏世界作为编辑器底景与可编辑景物（读取游戏地形/道路/道具）
import { buildScenery } from '../world/buildScenery.js';
import { createSky } from '../world/SkyBox.js';

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
const MAP_URL = API_BASE + '/api/scene';
const SAVE_URL = API_BASE + '/api/scene';
const UPLOAD_URL = API_BASE + '/api/upload';

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
  createSky(scene); // 程序化天空盒

  const camera = new THREE.PerspectiveCamera(55, w0 / h0, 0.1, 500);
  camera.position.set(32, 24, 32);
  camera.lookAt(0, 0, 0);

  // 灯光
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(30, 40, 20);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -40;
  sun.shadow.camera.right = 40;
  sun.shadow.camera.top = 40;
  sun.shadow.camera.bottom = -40;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 120;
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
  });
  tCtl.addEventListener('objectChange', () => {
    if (state.selected) { readTransformFromObject(state.selected); }
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
    scenery: [],      // 游戏景物（可编辑，不随保存持久化）
    placingEmpty: false, // 空碰撞体放置中：幽灵仅圆环，点击在落点生成空碰撞体
    copyMode: false,  // 复制模式：拖动 3D 轴时先复制一份，本次拖动作用于副本
    raf: 0,
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
    btnEmptyCollider: document.getElementById('btnEmptyCollider'),
    cStep: document.getElementById('cStep'),
    cMax: document.getElementById('cMax'),
    cMultiBtn: document.getElementById('cMultiBtn'),
    cMultiInfo: document.getElementById('cMultiInfo'),
    cHullBtn: document.getElementById('cHullBtn'),
    cHullInfo: document.getElementById('cHullInfo'),
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
      scale: { x: 1, y: 1, z: 1 }, collider: defaultCollider(), obj,
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

  // 重建选中对象的碰撞体线框（挂到对象本地空间，随模型变换/缩放）。
  // 支持两种形态：单盒 rec.collider（细线框）与多盒 rec.colliders（半透明体积+描边，共用一个父节点），可并存。
  function buildColliderVis(rec) {
    const holder = rec.obj;
    if (!holder) return;
    // 统一的容器：collider-vis 内的子项会在重建时整体移除，作为父组件承载所有碰撞盒
    let vis = holder.getObjectByName('collider-vis');
    if (vis) { holder.remove(vis); vis = null; }
    const makeWire = (hx, hy, hz, oy) => {
      const box = new THREE.EdgesGeometry(new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2));
      const wire = new THREE.LineSegments(box, new THREE.LineBasicMaterial({ color: 0xff8c3d }));
      wire.position.y = oy ?? 0;
      return wire;
    };
    // 半透明填充盒 + 描边：让多盒整体呈现为贴合模型的通透体积，结构清晰
    const makeVolume = (hx, hy, hz, oy) => {
      const g = new THREE.Group();
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2),
        new THREE.MeshBasicMaterial({ color: 0xff8c3d, transparent: true, opacity: 0.18, depthWrite: false })
      );
      const wire = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2)),
        new THREE.LineBasicMaterial({ color: 0xff8c3d })
      );
      g.add(mesh); g.add(wire);
      g.position.y = oy ?? 0;
      return g;
    };
    const boxen = [];
    const multi = Array.isArray(rec.colliders) && rec.colliders.length;
    // 凸包优先；次多盒；再单盒
    if (rec.convex && Array.isArray(rec.convex.vertices) && rec.convex.faces.length >= 3) {
      const bg = new THREE.BufferGeometry();
      bg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(rec.convex.vertices), 3));
      bg.setIndex(rec.convex.faces);
      bg.computeVertexNormals();
      const hull = new THREE.Group();
      hull.add(new THREE.Mesh(
        bg,
        new THREE.MeshBasicMaterial({ color: 0xff8c3d, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide })
      ));
      hull.add(new THREE.LineSegments(new THREE.EdgesGeometry(bg.clone()), new THREE.LineBasicMaterial({ color: 0xff8c3d })));
      boxen.push(hull);
    } else if (multi) {
      for (const c of rec.colliders) boxen.push(makeVolume(c.hx, c.hy, c.hz, c.oy));
    } else {
      const c = rec.collider;
      if (!c || !c.enabled) return;
      boxen.push(makeWire(c.hx, c.hy, c.hz, c.oy));
    }
    vis = new THREE.Group();
    vis.name = 'collider-vis';
    if (rec.convex && rec.convex.vertices && rec.convex.faces.length >= 3) vis.name = 'collider-vis（凸包 ' + (rec.convex.faces.length / 3) + ' 面）';
    else if (multi) vis.name = 'collider-vis（多盒 ' + boxen.length + '）';
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
      scale: { x: 1, y: 1, z: 1 }, collider, obj,
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
      if (ch.name === 'collider-vis') return; // 线框稍后按 collider 重建
      obj.add(ch.clone(true));
    });
    const copy = {
      id: nextId(), kind: rec.kind, name: rec.name, url: rec.url,
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
    downPt = { x: e.clientX, y: e.clientY };
    dragged = false;
    if (tCtl.axis) return; // 正在拖 3D 轴，交给 TransformControls
    if (state.mode === 'ruler') return;
    if (state.mode === 'place') return;
    const hitObj = pickObject(e.clientX, e.clientY);
    select(hitObj ? hitObj.rec : null);
    if (hitObj && (state.mode === 'move' || state.mode === 'rot' || state.mode === 'scale')) {
      controls.enabled = false; // 选中时短暂停用视角，避免点击同时旋转相机
      orbitLocked = true;
    }
  });

  renderer.domElement.addEventListener('pointermove', (e) => {
    if (downPt && Math.hypot(e.clientX - downPt.x, e.clientY - downPt.y) > 4) dragged = true;
    // 测距模式：鼠标移动实时预览第二点到第一点的距离
    if (state.mode === 'ruler') { onRulerMove(e.clientX, e.clientY); return; }
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
  function syncColliderUI(rec) {
    const canEdit = rec && rec.kind !== 'scenery';
    StepUI.colliderPanel.style.display = canEdit ? 'block' : 'none';
    if (!canEdit) return;
    if (!rec.collider) rec.collider = defaultCollider();
    const c = rec.collider;
    StepUI.cEn.checked = !!c.enabled;
    StepUI.cHx.value = c.hx;
    StepUI.cHy.value = c.hy;
    StepUI.cHz.value = c.hz;
    StepUI.cOy.value = c.oy;
  }
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
      StepUI.cMultiInfo.textContent = '请先选中一个模型再点「自动多盒」';
      StepUI.cMultiInfo.style.display = 'inline';
      return;
    }
    const step = parseFloat(StepUI.cStep.value);
    const cap = parseInt(StepUI.cMax.value, 10);
    try {
      buildMultiColliders(state.selected, step, cap);
    } catch (err) {
      StepUI.cMultiInfo.textContent = '生成失败：' + (err && err.message ? err.message : err);
      StepUI.cMultiInfo.style.display = 'inline';
      console.error(err);
    }
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

  // 大纲：摆放对象（可删除）+ 游戏景物（内建，仅可选中编辑）
  function outlinerUpdate() {
    StepUI.outliner.innerHTML = '';
    state.placed.forEach((rec) => {
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
      const del = document.createElement('span');
      del.className = 'del';
      del.textContent = '✕';
      del.onclick = (e) => { e.stopPropagation(); removePlaced(rec); };
      li.appendChild(del);
      li.onclick = () => select(rec);
      StepUI.outliner.appendChild(li);
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
          collider: rec.collider ? { ...rec.collider } : null,
          colliders: Array.isArray(rec.colliders) && rec.colliders.length ? rec.colliders.map((c) => ({ ...c })) : null,
          convex: (rec.convex && Array.isArray(rec.convex.vertices) && rec.convex.faces.length >= 3)
            ? { vertices: rec.convex.vertices.slice(), faces: rec.convex.faces.slice() } : null,
        };
        // 兼容旧的内嵌 data URL 记录
        if (!out.url && rec.data) out.data = rec.data;
        return out;
      }),
    };
  }

  function markDirty() {
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
        collider: it.collider ? { enabled: it.collider.enabled !== false, hx: it.collider.hx, hy: it.collider.hy, hz: it.collider.hz, oy: it.collider.oy } : defaultCollider(),
        colliders: Array.isArray(it.colliders) && it.colliders.length ? it.colliders.map((c) => ({ ...c })) : null,
        convex: (it.convex && Array.isArray(it.convex.vertices) && it.convex.faces.length >= 3)
          ? { vertices: it.convex.vertices.slice(), faces: it.convex.faces.slice() } : null,
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
    outlinerUpdate();
  }

  // 「保存场景」：把当前用户摆放清单 POST 到服务器写入编辑器场景文件
  async function saveToFile() {
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
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files[0];
    if (!f) return;
    const base = f.name.replace(/\.(glb|gltf)$/i, '');
    let ab;
    try { ab = await f.arrayBuffer(); } catch (e) { alert('读取文件失败：' + e); return; }

    // 先把模型原样上传到 public/models 目录，得到统一绝对路径 /models/xxx.glb。
    // 上传/入库不再依赖编辑器预加载能否成功，避免 preload 失败时静默跳过。
    let assetUrl = '';
    try {
      const r = await fetch(UPLOAD_URL, {
        method: 'POST',
        headers: { 'x-filename': f.name },
        body: ab,
      });
      const res = await r.json().catch(() => null);
      if (r.ok && res && res.ok) assetUrl = res.url;
    } catch (e) { assetUrl = ''; }

    if (!assetUrl) {
      const st = (typeof rDef !== 'undefined') ? rDef : 'n/a';
      alert('导入失败：同源 /api/upload 未返回可用地址。hint：设备实测该接口正常，请确认地址栏为 http://localhost:5173/editor.html 且模型文件 < 64MB；若仍失败请按 F12 看 Network 里 api/upload 请求的状态码和响应，反馈给我');
      return;
    }

    // 加入素材库并选中（先入库，预览可异步加载）
    if (!state.imported.some((it) => it.url === assetUrl)) {
      state.imported.push({ label: base, url: assetUrl });
      localStorage.setItem(IMPORT_KEY, JSON.stringify(state.imported));
    }
    selectAsset(assetUrl, base);
    refreshLibrary(); // 新模型已写入 models 目录，刷新素材库让其出现在清单里

    // 尝试加载预览；失败只提示，不影响已入库
    instantiate(assetUrl).then(() => {}).catch(() => {
      alert('模型已保存到 /models：' + assetUrl.split('/').pop() + '，但无法在此预览（可能不是有效 GLB）。刷新后可从素材库再选。');
    });
    fileIn.value = '';
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
    state.mode = m;
    ['select', 'place', 'move', 'rot', 'scale', 'ruler', 'del'].forEach((id) => {
      const btn = document.getElementById('t' + id.charAt(0).toUpperCase() + id.slice(1)) || document.getElementById('tDel');
      if (btn) btn.classList.remove('active');
    });
    const map = { select: StepUI.btnSelect, place: StepUI.btnPlace, move: StepUI.btnMove, rot: StepUI.btnRot, scale: StepUI.btnScale, del: StepUI.btnDel, ruler: StepUI.btnRuler };
    (map[m] || StepUI.btnSelect).classList.add('active');
    if (m === 'ruler') {
      clearRuler();
      StepUI.hint.textContent = 'Shift+左键：第一点 · Shift+右键：第二点 · 未按 Shift 拖拽转视角';
    } else if (StepUI.hint.textContent.includes('Shift')) {
      StepUI.hint.textContent = '';
    }

    if (m === 'place') {
      tCtl.detach(); tCtl.enabled = false;
      resetGhost();
      if (!state.placingEmpty) StepUI.hint.textContent = '';
    } else {
      state.placingEmpty = false; // 离开放置：退出空碰撞体放置
      if (state.ghost) { scene.remove(state.ghost); state.ghost = null; }
      // 已有选中对象时，按新模式挂上对应的 3D 轴
      if (state.selected && GIZMO_MODE[m]) {
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
    renderer.render(scene, camera);
    state.raf = requestAnimationFrame(loop);
  }

  adoptGameScenery();
  restore();
  loop();
  resize();

  return { state, setMode };
}