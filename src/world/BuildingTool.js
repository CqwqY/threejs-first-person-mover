// 职责：建造模式（锤子触发）。买「建造锤」→ 装备到技能槽 → 用技能键进入建造模式：
//   · 隐藏顶栏 / 校卡 / 技能槽（body.kui-build，由 Game 切换）
//   · 攻击键语义变成「放置」
//   · 血条位置换成可横向滚动的「家具条」（选一件已买且有额度的家具）
//   · 新增「编辑」键：对准的已摆家具发白光，按编辑选中后可 移动(对准地面)/旋转/删除
// 摆放联机共享：build_add（放置）/ build_del（删除）/ build_move（移动旋转），服务端权威校验+限流后持久化并广播。
// 消耗式：买 1 件得 1 个摆放额度，放置成功后从钱包 owned 消耗 1 个；移动/旋转不消耗。
// 模型：商品 url 为 'placeholder'（或空）时用占位方块渲染；编辑器导入真模型后自动换成 GLB。
import * as THREE from 'three';
import { instantiate } from './AssetLoader.js';
import { loadWallet, unplacedCount, consumeOwned, findItem, getCatalog } from '../player/Shop.js';
import { isCoarsePointer } from '../util/isCoarse.js';
import { Config } from '../config.js';

const DEG = Math.PI / 180;
const CLAMP = 24; // 无配置范围时的兜底：钳制在 ±24（地面尺寸 50，半径 25）
// 允许建造的矩形区域（= 场景里「编号 92 / 104」两栋教学楼的占地范围）。取自 Config.BUILD_AREAS。
const AREAS = (Config && Array.isArray(Config.BUILD_AREAS)) ? Config.BUILD_AREAS.filter(
  (a) => a && Number.isFinite(a.minX) && Number.isFinite(a.maxX) && Number.isFinite(a.minZ) && Number.isFinite(a.maxZ)
) : [];
// 把点夹进「允许建造区域」：落在任一矩形内原样返回；否则吸附到最近矩形的边缘。
function clampToAreas(x, z) {
  if (!AREAS.length) return { x: THREE.MathUtils.clamp(x, -CLAMP, CLAMP), z: THREE.MathUtils.clamp(z, -CLAMP, CLAMP) };
  for (const a of AREAS) if (x >= a.minX && x <= a.maxX && z >= a.minZ && z <= a.maxZ) return { x, z };
  let best = null, bd = Infinity;
  for (const a of AREAS) {
    const cx = Math.min(Math.max(x, a.minX), a.maxX);
    const cz = Math.min(Math.max(z, a.minZ), a.maxZ);
    const d = (cx - x) * (cx - x) + (cz - z) * (cz - z);
    if (d < bd) { bd = d; best = { x: cx, z: cz }; }
  }
  return best || { x, z };
}
export const HAMMER_ID = 'hammer';    // 建造锤商品 id
const EDIT_KEY = 'KeyG';              // PC：编辑 / 完成（避开 F：NPC 对话 / 上下车）
const ROTATE_KEY = 'KeyR';            // PC：编辑中旋转 45°
const DELETE_KEY = 'KeyX';            // PC：编辑中删除

// initBuildingTool(scene, camera, domElement, network, opts)：
//   opts.getProfile    () => profile|null
//   opts.serverBase    'https://host:9000'
//   opts.onToast       (msg) => void
//   opts.onCoins       () => void              （放置消耗额度后刷新钱包/商店）
//   opts.onActiveChange(active) => void        （进入/退出建造模式时通知 Game 切 UI）
// 返回 { state, isActive, enter, exit, toggle, setActive, hasHammer, handleBuild, refresh, update, place }
export function initBuildingTool(scene, camera, domElement, network, opts = {}) {
  const getProfile = opts.getProfile || (() => null);
  const serverBase = (opts.serverBase || '').replace(/\/+$/, '');
  const onToast = opts.onToast || (() => {});
  const onCoins = opts.onCoins || (() => {});
  const onActiveChange = opts.onActiveChange || (() => {});
  const coarse = isCoarsePointer();

  const placedGroup = new THREE.Group();
  placedGroup.name = 'shared-buildings';
  scene.add(placedGroup);

  const raycaster = new THREE.Raycaster();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hit = new THREE.Vector3();

  const state = {
    active: false,
    mode: 'place',   // 'place' | 'edit'
    itemId: null,    // 放置模式下当前选中的家具商品 id
    editId: null,    // 编辑模式下正在编辑的已摆家具 id
    rotY: 0,         // 放置 / 编辑时的朝向（度）
    pendingMesh: null,
  };

  const rendered = new Map();  // id -> { mesh, rec, mine }
  const protoCache = new Map();// itemId -> 模型原型（占位方块或 GLB）
  const myIds = loadMine();    // 我摆过的家具 id（本地记录，判断「我的」）

  function mineKey() {
    const p = getProfile();
    const id = p ? (p.username || p.nickname || '') : '';
    return 'fp_build_mine__' + (id || 'guest');
  }
  function loadMine() { try { return new Set(JSON.parse(localStorage.getItem(mineKey()) || '[]')); } catch { return new Set(); } }
  function saveMine() { try { localStorage.setItem(mineKey(), JSON.stringify([...myIds])); } catch (e) { /* ignore */ } }

  function hasHammer() { return loadWallet(getProfile()).owned.includes(HAMMER_ID); }

  function touchShadow(m) { m.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } }); }

  // 占位方块：url 为 'placeholder'/空 时绘制一个木色 Box（尺寸取商品 size）
  function makePlaceholderBox(item) {
    const size = Array.isArray(item.size) && item.size.length === 3
      ? [Number(item.size[0]) || 1, Number(item.size[1]) || 1, Number(item.size[2]) || 1]
      : [1, 1, 1];
    const geo = new THREE.BoxGeometry(size[0], size[1], size[2]);
    const mat = new THREE.MeshStandardMaterial({ color: 0xb98a4b, roughness: 0.85, metalness: 0.05 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true; mesh.receiveShadow = true;
    const g = new THREE.Group();
    g.add(mesh);
    return g;
  }

  function getProto(itemId) { return protoCache.get(itemId) || null; }
  function ensureProto(itemId, cb) {
    if (protoCache.has(itemId)) { cb(protoCache.get(itemId)); return; }
    const it = findItem(itemId);
    if (!it) return;
    if (!it.url || it.url === 'placeholder') {
      const box = makePlaceholderBox(it);
      protoCache.set(itemId, box);
      cb(box);
      return;
    }
    instantiate(it.url).then((m) => { protoCache.set(itemId, m); cb(m); })
      .catch(() => { onToast('模型加载失败：' + (it.url || itemId)); });
  }
  function meshFrom(proto, rec) {
    const m = proto.clone(true); touchShadow(m);
    m.scale.setScalar(rec && rec.scale ? rec.scale : 1);
    m.rotation.y = ((rec && rec.rotY) ? rec.rotY : 0) * DEG;
    m.position.set(rec ? rec.x : 0, (rec && rec.y) || 0, rec ? rec.z : 0);
    return m;
  }

  // ---------- 对准高亮（发白光） ----------
  let aimId = null;              // 当前对准的已摆家具 id
  const hlStore = new Map();     // mesh -> 原始 emissive 记录
  function setHighlight(id, on) {
    const e = id != null ? rendered.get(id) : null;
    const mesh = e && e.mesh;
    if (!mesh) return;
    if (on) {
      if (hlStore.has(mesh)) return;
      const saved = [];
      mesh.traverse((o) => {
        if (!o.isMesh || !o.material) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const mat of mats) {
          if (!mat || !('emissive' in mat)) continue;
          saved.push({ mat, emissive: mat.emissive ? mat.emissive.clone() : null, intensity: mat.emissiveIntensity });
          mat.emissive = new THREE.Color(0xffffff);
          mat.emissiveIntensity = 1.15;
        }
      });
      hlStore.set(mesh, saved);
    } else {
      const saved = hlStore.get(mesh);
      if (!saved) return;
      for (const s of saved) {
        if (s.emissive) s.mat.emissive.copy(s.emissive);
        s.mat.emissiveIntensity = s.intensity;
      }
      hlStore.delete(mesh);
    }
  }
  function clearAim() { if (aimId != null) setHighlight(aimId, false); aimId = null; }

  // ---------- 射线：准星中心 ----------
  function groundPoint() {
    raycaster.setFromCamera({ x: 0, y: 0 }, camera);
    const p = raycaster.ray.intersectPlane(groundPlane, hit);
    if (!p) return null;
    return clampToAreas(p.x, p.z); // 只允许落在教学楼区域内（落外面就吸到最近楼边）
  }
  function aimedEntry() {
    raycaster.setFromCamera({ x: 0, y: 0 }, camera);
    const hits = raycaster.intersectObjects(placedGroup.children, true);
    for (const h of hits) {
      let o = h.object;
      while (o && o.parent !== placedGroup) o = o.parent;
      if (!o) continue;
      for (const [id, e] of rendered) if (e.mesh === o) return { id, entry: e };
    }
    return null;
  }

  // ---------- 放置 ----------
  function place() {
    if (state.mode === 'edit') { commitEdit(); return; }
    if (!state.itemId) { onToast('先在下面家具条里选一件家具'); return; }
    const profile = getProfile();
    const avail = profile ? unplacedCount(profile, state.itemId) : 0;
    if (avail <= 0) { onToast('这件家具没有可摆数量了，去商店「家具」页再买一件'); return; }
    const proto = getProto(state.itemId);
    if (!proto) { onToast('模型还没加载好，稍等'); return; }
    const pt = groundPoint();
    if (!pt) return;
    const mesh = meshFrom(proto, { x: pt.x, y: 0, z: pt.z, rotY: state.rotY, scale: 1 });
    placedGroup.add(mesh);
    state.pendingMesh = mesh;
    network.sendBuildAdd({ itemId: state.itemId, x: pt.x, y: 0, z: pt.z, rotY: state.rotY, scale: 1 });
  }

  function onAdded(rec) {
    if (rendered.has(rec.id)) return;
    let mesh = state.pendingMesh; state.pendingMesh = null;
    if (!mesh) {
      ensureProto(rec.itemId, (p) => {
        if (rendered.has(rec.id)) return;
        const m = meshFrom(p, rec);
        placedGroup.add(m); rendered.set(rec.id, { mesh: m, rec, mine: true });
      });
      return;
    }
    rendered.set(rec.id, { mesh, rec, mine: true });
    myIds.add(rec.id); saveMine();
    const profile = getProfile(); if (profile) consumeOwned(profile, rec.itemId);
    onCoins(); refreshStrip();
  }
  function onRejected(reason) {
    if (state.pendingMesh) { placedGroup.remove(state.pendingMesh); state.pendingMesh = null; }
    onToast(reason || '被服务器拒绝');
  }
  function onAdd(rec) {
    if (rendered.has(rec.id)) return;
    ensureProto(rec.itemId, (p) => {
      if (rendered.has(rec.id)) return;
      const m = meshFrom(p, rec);
      placedGroup.add(m);
      rendered.set(rec.id, { mesh: m, rec, mine: myIds.has(rec.id) });
    });
  }
  function onDel(id) {
    if (aimId === id) clearAim();
    const e = rendered.get(id);
    if (e) { placedGroup.remove(e.mesh); rendered.delete(id); }
    myIds.delete(id); saveMine();
    if (state.editId === id) { state.mode = 'place'; state.editId = null; refreshStrip(); }
  }
  function onMove(rec) {
    const e = rendered.get(rec.id);
    if (!e) return;
    e.rec = Object.assign({}, e.rec, rec);
    e.mesh.position.set(rec.x, rec.y || 0, rec.z);
    e.mesh.rotation.y = rec.rotY * DEG;
    if (rec.scale) e.mesh.scale.setScalar(rec.scale);
  }

  // Game 转发：msg = {t:'build', ev, ...}
  function handleBuild(msg) {
    if (!msg) return;
    if (msg.ev === 'added') onAdded(msg);
    else if (msg.ev === 'add') onAdd(msg);
    else if (msg.ev === 'del') onDel(msg);
    else if (msg.ev === 'move') onMove(msg);
    else if (msg.ev === 'rejected') onRejected(msg.reason);
  }

  // 进游戏拉一次全服已摆的家具
  function fetchAll() {
    if (!serverBase) return;
    fetch(serverBase + '/api/build')
      .then((r) => r.json())
      .then((d) => { if (d && d.ok && Array.isArray(d.items)) d.items.forEach((rec) => onAdd(rec)); })
      .catch(() => {});
  }

  // ---------- 编辑 ----------
  function startEdit() {
    if (!state.active) return;
    const a = aimedEntry();
    if (!a) { onToast('先用准星对准一件家具，再按「编辑」'); return; }
    if (!a.entry.mine) { onToast('只能编辑自己摆的家具'); return; }
    state.mode = 'edit';
    state.editId = a.id;
    state.rotY = Math.round(((a.entry.rec.rotY || 0) / DEG) / 45) * 45; // 吸附到 45° 便于旋转
    clearAim();
    refreshStrip();
    onToast('编辑中：对准地面移动 · 旋转/删除/完成在下方');
  }
  function exitEdit() { state.mode = 'place'; state.editId = null; refreshStrip(); }
  function rotateEdit() {
    if (state.mode !== 'edit') return;
    state.rotY = (state.rotY + 45) % 360;
    const e = rendered.get(state.editId);
    if (e) e.mesh.rotation.y = state.rotY * DEG;
  }
  function deleteEdit() {
    if (state.mode !== 'edit') return;
    network.sendBuildDel(state.editId);
    exitEdit();
  }
  function commitEdit() {
    if (state.mode !== 'edit') return;
    const e = rendered.get(state.editId);
    if (!e) { exitEdit(); return; }
    network.sendBuildMove({
      id: state.editId,
      x: e.mesh.position.x, y: e.mesh.position.y, z: e.mesh.position.z,
      rotY: state.rotY, scale: 1,
    });
    onToast('已更新位置');
    exitEdit();
  }

  // ---------- 每帧 ----------
  function update() {
    if (!state.active) return;
    if (state.mode === 'edit') {
      const e = rendered.get(state.editId);
      if (!e) return;
      const pt = groundPoint();
      if (pt) e.mesh.position.set(pt.x, e.mesh.position.y, pt.z);
      return;
    }
    const a = aimedEntry();
    const newId = a ? a.id : null;
    if (newId !== aimId) { clearAim(); if (newId != null) { aimId = newId; setHighlight(aimId, true); } }
  }

  // ---------- 家具条 / 编辑键 UI ----------
  function available() {
    const p = getProfile();
    const out = [];
    for (const it of getCatalog()) {
      if (it.kind !== 'building') continue;
      const n = p ? unplacedCount(p, it.id) : 0;
      if (n > 0) out.push({ it, n });
    }
    return out;
  }

  // 底部工具条（顶替血条位置）：放置模式 = 家具列表；编辑模式 = 旋转/删除/完成。用 .kui-btn（Kenney）
  const strip = document.createElement('div');
  strip.className = 'build-strip';
  strip.style.cssText = coarse
    ? 'position:fixed;left:50%;transform:translateX(-50%);bottom:calc(env(safe-area-inset-bottom,0px) + 8px);z-index:64;display:none;width:min(360px,90vw);'
    : 'position:fixed;left:18px;bottom:22px;z-index:64;display:none;width:min(440px,50vw);';
  document.body.appendChild(strip);

  // 右侧悬浮键：编辑（放置模式） + 退出建造（常驻） —— 都走 Kenney 按钮
  const actions = document.createElement('div');
  actions.className = 'build-actions';
  actions.style.cssText = 'position:fixed;right:16px;bottom:44%;z-index:64;display:none;';
  document.body.appendChild(actions);

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'kui-btn kui-btn--primary';
  editBtn.textContent = '编辑';
  editBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); startEdit(); });
  actions.appendChild(editBtn);

  const exitBtn = document.createElement('button');
  exitBtn.type = 'button';
  exitBtn.className = 'kui-btn kui-btn--red';
  exitBtn.textContent = '退出建造';
  exitBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); exit(); });
  actions.appendChild(exitBtn);

  function mkChip(text, onClick, variant, active) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'kui-btn ' + (active ? 'kui-btn--primary' : ('kui-btn--' + (variant || 'grey')));
    b.textContent = text;
    b.style.cssText = 'flex:0 0 auto;white-space:nowrap;';
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); onClick(); });
    return b;
  }
  function mkLabel(text) {
    const d = document.createElement('div');
    d.className = 'build-strip__label';
    d.textContent = text;
    return d;
  }

  function refreshStrip() {
    if (!state.active) { strip.style.display = 'none'; actions.style.display = 'none'; return; }
    strip.style.display = '';
    actions.style.display = '';
    // 编辑模式下「编辑」键隐去（动作改到工具条上的 旋转/删除/完成）；「退出建造」常驻
    editBtn.style.display = (state.mode === 'place') ? '' : 'none';
    strip.innerHTML = '';
    if (state.mode === 'edit') {
      strip.appendChild(mkLabel('编辑：'));
      strip.appendChild(mkChip('旋转 45°', rotateEdit, 'grey'));
      strip.appendChild(mkChip('删除', deleteEdit, 'red'));
      strip.appendChild(mkChip('完成', commitEdit, 'green'));
      return;
    }
    const list = available();
    if (!list.length) { strip.appendChild(mkLabel('没有可摆的家具 · 去商店「家具」页买')); return; }
    for (const entry of list) {
      strip.appendChild(mkChip(entry.it.name + ' ×' + entry.n, () => { state.itemId = entry.it.id; refreshStrip(); }, 'grey', entry.it.id === state.itemId));
    }
  }

  // ---------- 进入 / 退出 ----------
  function enter() {
    if (state.active) return true;
    if (!hasHammer()) { onToast('先在小满杂货铺买「建造锤」，再用技能槽里的它进入建造模式'); return false; }
    state.active = true;
    state.mode = 'place';
    state.editId = null;
    state.rotY = 0;
    const list = available();
    state.itemId = list.length ? list[0].it.id : null;
    onActiveChange(true);
    refreshStrip();
    onToast(coarse
      ? '建造模式：攻击键=放置 · 右侧「编辑」/「退出建造」· 只能摆教学楼范围内'
      : '建造模式：左键=放置 · G=编辑 · R=旋转 X=删除 · B=退出 · 仅限教学楼范围内');
    return true;
  }
  function exit() {
    if (!state.active) return;
    clearAim();
    if (state.pendingMesh) { placedGroup.remove(state.pendingMesh); state.pendingMesh = null; }
    state.active = false;
    state.mode = 'place';
    state.editId = null;
    onActiveChange(false);
    refreshStrip();
  }
  function toggle() { if (state.active) exit(); else enter(); }

  // PC 键盘：G 编辑/完成 · R 旋转 · X 删除 · B 退出建造 · 数字键选家具
  window.addEventListener('keydown', (e) => {
    if (!state.active) return;
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    if (e.code === 'KeyB') { exit(); return; } // 退出建造（技能槽已隐藏，不能靠再按锤子）
    if (e.code === EDIT_KEY) { if (state.mode === 'edit') commitEdit(); else startEdit(); return; }
    if (e.code === ROTATE_KEY && state.mode === 'edit') { rotateEdit(); return; }
    if (e.code === DELETE_KEY && state.mode === 'edit') { deleteEdit(); return; }
    const m = /^Digit([1-9])$/.exec(e.code);
    if (m && state.mode === 'place') {
      const list = available();
      const pick = list[Number(m[1]) - 1];
      if (pick) { state.itemId = pick.it.id; refreshStrip(); }
    }
  });

  fetchAll();

  return {
    state,
    isActive: () => state.active,
    enter,
    exit,
    toggle,
    setActive: (v) => { if (v) enter(); else exit(); },
    hasHammer,
    handleBuild,
    refresh: () => { refreshStrip(); fetchAll(); },
    update,
    place,
  };
}
