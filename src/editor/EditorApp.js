// 城市建筑编辑器（独立开发工具，与游戏运行时无任何联动）。
// 自由视角（OrbitControls）+ 3D 变换轴（TransformControls）。
// 交互：点击模型即选中；移动/旋转/缩放模式会出现可拖动的彩色 3D 轴；
// 空白处左键拖拽旋转视角、滚轮缩放。游戏景物（地形/道路/道具）在编辑器中亦可选中编辑。
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { instantiate } from '../world/AssetLoader.js';
import { API_BASE } from '../config.js';
// 复用游戏世界作为编辑器底景与可编辑景物（读取游戏地形/道路/道具）
import { buildScenery } from '../world/buildScenery.js';
import { createSky } from '../world/SkyBox.js';

const DEG = Math.PI / 180;
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

  // 自由视角
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.target.set(0, 1, 0);
  controls.maxPolarAngle = Math.PI / 2 - 0.02;
  controls.minDistance = 4;
  controls.maxDistance = 400;
  controls.update();

  // 3D 变换轴（移动/旋转/缩放），可拖动箭头/环
  const tCtl = new TransformControls(camera, renderer.domElement);
  scene.add(tCtl.getHelper());
  tCtl.addEventListener('dragging-changed', (e) => { controls.enabled = !e.value; });
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
    raf: 0,
  };
  let _idSeq = 1;

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
    btnSave: document.getElementById('btnSave'),
    status: document.getElementById('status'),
    cEn: document.getElementById('cEn'),
    cHx: document.getElementById('cHx'),
    cHy: document.getElementById('cHy'),
    cHz: document.getElementById('cHz'),
    cOy: document.getElementById('cOy'),
    colliderPanel: document.getElementById('colliderPanel'),
    btnEmptyCollider: document.getElementById('btnEmptyCollider'),
  };

  // ---------- 可编辑对象：游戏景物 + 地形/道路/墙体 ----------
  function adoptGameScenery() {
    // buildScenery 与游戏共用同一份构建逻辑，返回统一的可编辑根列表，
    // 数组下标即稳定 key（两侧顺序一致），用于保存/还原景物变换。
    const groups = buildScenery(scene);
    groups.forEach((child, key) => {
      const rec = {
        id: _idSeq++, key, kind: 'scenery', name: child.name || '景物',
        x: child.position.x, y: child.position.y, z: child.position.z,
        rotY: child.rotation.y,
        scale: { x: child.scale.x, y: child.scale.y, z: child.scale.z },
        obj: child,
      };
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
    if (state.currentUrl) {
      instantiate(state.currentUrl)
        .then((m) => { if (state.ghost) { state.ghost.clear(); state.ghost.add(makeRing()); state.ghost.add(m); enableShadows(m); } })
        .catch(() => {});
    }
  }

  function makeRing() {
    const r = new THREE.Mesh(
      new THREE.RingGeometry(0.7, 1.0, 40),
      new THREE.MeshBasicMaterial({ color: 0x4aa3ff, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
    );
    r.rotation.x = -Math.PI / 2;
    r.position.y = 0.02;
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
    if (!state.currentUrl) return;
    const gp = state.ghost ? state.ghost.position : null;
    const obj = new THREE.Group();
    const item = {
      id: _idSeq++, kind: state.imported.some((it) => it.url === state.currentUrl) ? 'import' : 'builtin',
      name: state.currentLabel, url: state.currentUrl,
      x: gp ? gp.x : 0, y: 0, z: gp ? gp.z : 0, rotY: 0,
      scale: { x: 1, y: 1, z: 1 }, collider: defaultCollider(), obj,
    };
    scene.add(obj);
    obj.position.copy(state.ghost.position);
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

  // 重建选中对象的碰撞体线框（挂到对象本地空间，随模型变换/缩放）
  function buildColliderVis(rec) {
    const holder = rec.obj;
    if (!holder) return;
    const old = holder.getObjectByName('collider-vis');
    if (old) holder.remove(old);
    const c = rec.collider;
    if (!c || !c.enabled) return;
    const box = new THREE.EdgesGeometry(new THREE.BoxGeometry(c.hx * 2, c.hy * 2, c.hz * 2));
    const wire = new THREE.LineSegments(box, new THREE.LineBasicMaterial({ color: 0xff8c3d }));
    wire.name = 'collider-vis';
    wire.position.y = (c.oy ?? 0);
    holder.add(wire);
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

  // 添加一个「空碰撞体」：无可视模型，仅一个橙色线框方块（可拾取/编辑），
  // 数据记入 collider，游戏端据此生成不可见但可阻挡玩家的矩形碰撞体。
  function addEmptyCollider() {
    const collider = { enabled: true, hx: 1, hy: 1, hz: 1, oy: 0.5 };
    const obj = new THREE.Group();
    const rec = {
      id: _idSeq++, kind: 'empty', name: '空碰撞体',
      url: null, x: 0, y: 0, z: 0, rotY: 0,
      scale: { x: 1, y: 1, z: 1 }, collider, obj,
    };
    obj.name = 'collider-root';
    scene.add(obj);
    buildColliderVis(rec); // 橙色线框 = 碰撞盒可视提示（线框即拾取目标）
    state.placed.push(rec);
    select(rec);
    markDirty();
    outlinerUpdate();
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
    if (e.button !== 0) return;
    downPt = { x: e.clientX, y: e.clientY };
    dragged = false;
    if (tCtl.axis) return; // 正在拖 3D 轴，交给 TransformControls
    if (state.mode === 'ruler') { onRulerClick(e.clientX, e.clientY); return; }
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

  // 大纲（只列用户摆放的对象）
  function outlinerUpdate() {
    StepUI.outliner.innerHTML = '';
    state.placed.forEach((rec) => {
      const li = document.createElement('li');
      if (state.selected === rec) li.className = 'sel';
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = rec.name;
      li.appendChild(nm);
      const del = document.createElement('span');
      del.className = 'del';
      del.textContent = '✕';
      del.onclick = (e) => { e.stopPropagation(); removePlaced(rec); };
      li.appendChild(del);
      li.onclick = () => select(rec);
      StepUI.outliner.appendChild(li);
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
          kind: rec.kind,
          name: rec.name,
          url: rec.url,
          x: rec.x ?? rec.obj.position.x,
          y: rec.y ?? rec.obj.position.y,
          z: rec.z ?? rec.obj.position.z,
          rotY: rec.rotY ?? 0,
          scale: { x: s.x, y: s.y, z: s.z },
          collider: rec.collider ? { ...rec.collider } : null,
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
    if (data && Array.isArray(data.scenery)) {
      data.scenery.forEach((s) => {
        if (!s || typeof s.key !== 'number' || !state.scenery[s.key]) return;
        const rec = state.scenery[s.key];
        rec.x = s.x; rec.y = s.y; rec.z = s.z;
        rec.rotY = s.rotY; rec.scale = s.scale;
        applyPlTransform(rec);
      });
    }

    // 2) 重建用户摆放的对象
    for (const it of placedList) {
      const obj = new THREE.Group();
      const rec = {
        id: _idSeq++, kind: it.kind, name: it.name, url: it.url,
        x: it.x, y: it.y, z: it.z, rotY: it.rotY,
        scale: it.scale ? { ...normScale(it.scale) } : { x: 1, y: 1, z: 1 },
        collider: it.collider ? { enabled: it.collider.enabled !== false, hx: it.collider.hx, hy: it.collider.hy, hz: it.collider.hz, oy: it.collider.oy } : defaultCollider(),
        obj,
      };
      if (it.url) {
        instantiate(it.url).then((m) => { obj.add(m); enableShadows(m); }).catch(() => {});
      } else if (it.data) {
        const g = new GLTFLoader();
        g.load(it.data, (gltf) => { obj.add(gltf.scene); enableShadows(gltf.scene); }, undefined, () => {});
      }
      applyPlTransform(rec);
      scene.add(obj);
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
    let items = [...folderItems, ...state.imported];
    if (folderItems.length === 0) items = items.concat(LIBRARY); // 兜底内建
    items.forEach((it) => {
      if (!it || !it.url || seen.has(it.url)) return;
      seen.add(it.url);
      const b = document.createElement('button');
      b.title = it.label;
      b.textContent = it.label;
      if (state.currentUrl === it.url) b.classList.add('picked');
      b.onclick = () => selectAsset(it.url, it.label);
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
  }
  refreshLibrary();

  // 悬浮预览：独立小渲染器，hover 某素材时加载模型旋转展示
  function createPreviewWidget() {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;top:76px;right:16px;width:180px;height:210px;background:#14161a;border:1px solid #2c3038;border-radius:10px;display:none;z-index:30;overflow:hidden;box-shadow:0 10px 30px rgba(0,0,0,.55);';
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
    rulerLine = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xff5252 }));
    rulerLine.position.y = 0;
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
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
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
  function onRulerClick(clientX, clientY) {
    const gp = hitGroundPoint(clientX, clientY);
    if (!gp) return;
    rulerPts.push(gp);
    if (rulerPts.length > 2) rulerPts.shift();
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
    if (m === 'ruler') { clearRuler(); }

    if (m === 'place') {
      tCtl.detach(); tCtl.enabled = false;
      resetGhost();
    } else {
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
  StepUI.btnPlace.onclick = () => setMode('place');
  StepUI.btnMove.onclick = () => setMode('move');
  StepUI.btnRot.onclick = () => setMode('rot');
  StepUI.btnScale.onclick = () => setMode('scale');
  StepUI.btnRuler.onclick = () => setMode('ruler');
  StepUI.btnDel.onclick = () => { if (state.selected && state.selected.kind !== 'scenery') removePlaced(state.selected); };
  setMode('place');

  document.getElementById('btnClear').onclick = () => {
    state.placed.forEach((p) => scene.remove(p.obj));
    state.placed = [];
    select(null);
    markDirty();
    outlinerUpdate();
  };

  // 添加空碰撞体：无模型、仅线框，游戏端据此生成不可见阻挡盒
  StepUI.btnEmptyCollider.onclick = () => addEmptyCollider();

  // 窗口自适应
  function resize() {
    const [w, h] = size();
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);

  // 渲染循环
  function loop() {
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