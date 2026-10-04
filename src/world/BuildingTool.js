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
// 允许建造的矩形区域（默认取 Config.BUILD_AREAS = 场景里「编号 92 / 104」两栋教学楼的占地）。
// 运行时可由服务端下发的范围覆盖（编辑器里改、全服即时生效），见 setBuildAreas()。
function normAreas(list) {
  return (Array.isArray(list) ? list : [])
    .filter((a) => a && Number.isFinite(Number(a.minX)) && Number.isFinite(Number(a.maxX))
      && Number.isFinite(Number(a.minZ)) && Number.isFinite(Number(a.maxZ)))
    .map((a) => ({
      name: String(a.name || ''),
      minX: Number(a.minX), maxX: Number(a.maxX), minZ: Number(a.minZ), maxZ: Number(a.maxZ),
    }));
}
let AREAS = normAreas(Config && Config.BUILD_AREAS);
// 用服务端下发的范围覆盖本地的 BUILD_AREAS（编辑器改完即时生效）
export function setBuildAreas(list) {
  if (!Array.isArray(list)) return;
  AREAS = normAreas(list);
}
export function getBuildAreas() { return AREAS.map((a) => ({ ...a })); }
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

  // 放置预览（幽灵）：跟随准星的半透明家具，让玩家看得见"会摆在哪、摆出什么形状"
  const ghostGroup = new THREE.Group();
  ghostGroup.name = 'build-ghost';
  scene.add(ghostGroup);
  let ghost = null, ghostItemId = null;

  const raycaster = new THREE.Raycaster();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hit = new THREE.Vector3();

  const state = {
    active: false,
    mode: 'place',   // 'place' | 'edit'
    itemId: null,    // 放置模式下当前选中的家具商品 id
    editId: null,    // 编辑模式下正在编辑的已摆家具 id
    rotY: 0,         // 放置 / 编辑时的朝向（度）
    pending: [],     // 待服务端确认的乐观摆放：[{ mesh, itemId }]（FIFO，被 rejected 时按序回滚）
    nudgeStep: 0.5,  // 编辑模式三轴微调的步长（米），可在工具条上循环切换
  };

  const rendered = new Map();  // id -> { mesh, rec, mine }
  const protoCache = new Map();// itemId -> 模型原型（占位方块或 GLB）
  // itemId -> 模型状态：'placeholder'（本来就没真模型）| 'loading' | 'ready' | 'failed'
  // 家具条上会据此标注，玩家一眼能看出「这件是占位块 / 正在下模型 / 模型失败了」
  const protoState = new Map();
  const myIds = loadMine();    // 我摆过的家具 id（本地记录，判断「我的」）
  // 服务端下发的「建造归属键」（u:<userId> 或 anon:<ip>）：比本地记录可靠——换设备 / 清缓存后也认得出自己的家具
  let myOwnerKey = loadOwnerKey();

  function accountTag() {
    const p = getProfile();
    const id = p ? (p.username || p.nickname || '') : '';
    return id || 'guest';
  }
  function mineKey() { return 'fp_build_mine__' + accountTag(); }
  function ownerKeyName() { return 'fp_build_owner__' + accountTag(); }
  function loadMine() { try { return new Set(JSON.parse(localStorage.getItem(mineKey()) || '[]')); } catch { return new Set(); } }
  function saveMine() { try { localStorage.setItem(mineKey(), JSON.stringify([...myIds])); } catch (e) { /* ignore */ } }
  function loadOwnerKey() { try { return localStorage.getItem(ownerKeyName()) || ''; } catch { return ''; } }
  function saveOwnerKey(k) { try { localStorage.setItem(ownerKeyName(), k); } catch (e) { /* ignore */ } }

  // 归属判定：优先服务端 owner 键（准），没拿到时回退本地 id 记录
  function isMineRec(rec) {
    if (!rec) return false;
    if (myOwnerKey && rec.owner) return rec.owner === myOwnerKey;
    return myIds.has(rec.id);
  }
  function setOwnerKey(key) {
    const k = String(key || '');
    if (!k || k === myOwnerKey) return;
    myOwnerKey = k; saveOwnerKey(k);
    // 已有记录重判归属（关键：清缓存/换设备后也能认出自己摆的家具 → 能编辑、能删除）
    for (const [id, e] of rendered) if (e && e.rec) e.mine = isMineRec(e.rec) || myIds.has(id);
    refreshStrip();
  }

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

  // 取原型：**先立刻塞一个占位方块**（保证「永远有原型可摆」），真模型/组合在后台加载完再替换。
  // 状态记在 protoState：'placeholder'（本来就没真模型）/ 'loading' / 'ready' / 'failed'（失败可重试）。
  function ensureProto(itemId, cb) {
    const st = protoState.get(itemId);
    if (protoCache.has(itemId) && st !== 'failed') { cb(protoCache.get(itemId)); return; } // 已有原型直接用（failed 允许重试）
    const it = findItem(itemId);
    if (!it) return;
    if (!protoCache.has(itemId)) protoCache.set(itemId, makePlaceholderBox(it)); // 占位方块兜底
    protoState.set(itemId, 'placeholder');
    cb(protoCache.get(itemId)); // 同步回调：调用方立刻拿到「可摆」的原型，不会再卡

    const isCombo = !!(it.combo && Array.isArray(it.combo.parts));
    const hasUrl = !!(it.url && it.url !== 'placeholder');
    if (!isCombo && !hasUrl) return; // 本来就是占位商品（无真模型），到此为止

    protoState.set(itemId, 'loading');
    const onLoaded = (g) => {
      if (!g) return;
      protoCache.set(itemId, g);
      protoState.set(itemId, 'ready');
      if (ghostItemId === itemId) { ghostItemId = null; refreshGhostProto(); } // 幽灵换成真模型
      swapRealModel(itemId, g); // 已摆出 / 待确认的同名家具一并换成真模型
      refreshStrip();           // 条上标注由「加载中」变「就绪」
    };
    const onFail = (e) => {
      protoState.set(itemId, 'failed');
      console.warn('[build] 模型加载失败:', itemId, it.url || '(combo)', e);
      onToast('模型加载失败（先用方块代替）：' + (it.url || itemId));
      refreshStrip();
    };
    if (isCombo) buildComboProto(it).then(onLoaded).catch(onFail);
    else instantiate(it.url).then(onLoaded).catch(onFail);
  }

  // 真模型到位后，把「已确认(rendered)」与「待确认(pending)」的同名家具都换成真模型。
  // pending 那批也要换：否则真模型若在服务端 added 回执到达之前就加载好，刚摆的那件会永远停在占位方块。
  function swapRealModel(itemId, g) {
    for (const e of rendered.values()) {
      if (!e.rec || e.rec.itemId !== itemId || !e.mesh) continue;
      const m = meshFrom(g, e.rec);
      placedGroup.remove(e.mesh);
      placedGroup.add(m);
      e.mesh = m;
    }
    for (const p of state.pending) {
      if (!p || !p.mesh || p.itemId !== itemId) continue;
      const m = meshFrom(g, {
        x: p.mesh.position.x, y: p.mesh.position.y, z: p.mesh.position.z,
        rotY: p.mesh.rotation.y / DEG, scale: p.mesh.scale.x || 1,
      });
      placedGroup.remove(p.mesh);
      placedGroup.add(m);
      p.mesh = m;
    }
  }

  // 组合家具：多个模型 + 灯拼成一个 Group。
  // 灯 = 点光源（照亮周围）+ 一个自发光小球（看起来就是个亮着的灯泡），两者都要。
  function buildComboProto(item) {
    const c = item.combo || {};
    const parts = Array.isArray(c.parts) ? c.parts : [];
    const lightDefs = Array.isArray(c.lights) ? c.lights : [];
    const loads = parts.map((p) => instantiate(p.url).then((m) => {
      const s = (p.scale && typeof p.scale === 'object') ? p.scale : { x: p.scale || 1, y: p.scale || 1, z: p.scale || 1 };
      m.scale.set(Number(s.x) || 1, Number(s.y) || 1, Number(s.z) || 1);
      m.rotation.y = (Number(p.rotY) || 0) * DEG;
      m.position.set(Number(p.x) || 0, Number(p.y) || 0, Number(p.z) || 0);
      return m;
    }).catch((e) => { console.warn('[build] 组合部件加载失败:', p.url, e); return null; }));
    return Promise.all(loads).then((models) => {
      const g = new THREE.Group();
      for (const m of models) { if (m) { touchShadow(m); g.add(m); } }
      for (const l of lightDefs) {
        const col = new THREE.Color(l.color || '#ffffff');
        const pos = new THREE.Vector3(Number(l.x) || 0, Number(l.y) || 3, Number(l.z) || 0);
        const pl = new THREE.PointLight(col, Number(l.intensity) || 1, Number(l.distance) || 12, Number(l.decay) || 2);
        pl.position.copy(pos);
        g.add(pl);
        const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), new THREE.MeshBasicMaterial({ color: col }));
        bulb.position.copy(pos);
        g.add(bulb);
      }
      return g;
    });
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
  // 取准星指到的「实际表面」点：优先命中场景里的地面/台阶/楼板/已摆家具（复杂碰撞体），
  // 拿它的高度 y；没命中再退回水平地面平面（y=0）。
  const surfaceHits = [];
  let surfTick = 0, surfCache = null;
  function surfacePoint() {
    raycaster.setFromCamera({ x: 0, y: 0 }, camera);
    const targets = [];
    for (const o of scene.children) if (o !== ghostGroup) targets.push(o); // 排除自己的幽灵（否则会叠在幽灵上）
    surfaceHits.length = 0;
    raycaster.intersectObjects(targets, true, surfaceHits);
    for (const h of surfaceHits) {
      const p = h.point;
      if (!Number.isFinite(p.y)) continue;
      if (p.y < -8 || p.y > 60) continue; // 排除天空穹顶 / 异常高的面
      return { x: p.x, y: p.y, z: p.z };
    }
    const p = raycaster.ray.intersectPlane(groundPlane, hit);
    return p ? { x: p.x, y: 0, z: p.z } : null;
  }
  // 建造点：表面高度 + 水平钳制到允许建造的两栋楼范围内。
  // fresh=true 时强制重算（放置瞬间用），否则最多每 4 帧算一次（省开销，幽灵仍然跟手）。
  function groundPoint(fresh) {
    if (fresh || (surfTick++ % 4) === 0) surfCache = surfacePoint();
    const sp = surfCache;
    if (!sp) return null;
    const c = clampToAreas(sp.x, sp.z);
    return { x: c.x, y: sp.y, z: c.z };
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

  // ---------- 放置预览（幽灵）：跟随准星的半透明家具 ----------
  function makeGhost(proto) {
    const g = proto.clone(true);
    g.traverse((o) => {
      if (o.isLight) { o.visible = false; return; } // 幽灵不照亮周围
      if (!o.isMesh) return;
      o.castShadow = false; o.receiveShadow = false;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const ghostMats = mats.map((m) => {
        if (!m) return m;
        const c = m.clone();
        c.transparent = true; c.opacity = 0.5; c.depthWrite = false;
        if ('emissive' in c) { c.emissive = new THREE.Color(0x5fb0ff); c.emissiveIntensity = 0.35; }
        return c;
      });
      o.material = Array.isArray(o.material) ? ghostMats : ghostMats[0];
    });
    return g;
  }
  // 按当前选中的家具重建幽灵；原型没就绪时先触发加载，加载完再回来重建
  function refreshGhostProto() {
    const id = (state.active && state.mode === 'place') ? state.itemId : null;
    if (id === ghostItemId && ghost) return;
    ghostItemId = id;
    if (ghost) { ghostGroup.remove(ghost); ghost = null; }
    if (!id) return;
    const proto = getProto(id);
    if (!proto) { ensureProto(id, () => { if (state.itemId === id) { ghostItemId = null; refreshGhostProto(); } }); return; }
    ghost = makeGhost(proto);
    ghost.visible = false;
    ghostGroup.add(ghost);
  }
  function updateGhost() {
    if (!state.active || state.mode !== 'place') { if (ghost) ghost.visible = false; return; }
    refreshGhostProto();
    if (!ghost) return;
    const pt = groundPoint();
    if (!pt) { ghost.visible = false; return; }
    ghost.visible = true;
    ghost.position.set(pt.x, pt.y || 0, pt.z);
    ghost.rotation.y = state.rotY * DEG;
  }

  // 进建造模式 / 拉到目录后：把所有「有额度」的家具原型预取一遍（进模式即可见方块、可摆）
  function prefetchAll() {
    const p = getProfile();
    if (!p) return;
    for (const it of getCatalog()) {
      if (it.kind !== 'building') continue;
      if (unplacedCount(p, it.id) > 0) ensureProto(it.id, () => {});
    }
  }

  // ---------- 放置 ----------
  // 关键：走 ensureProto（缓存没有时会**立刻**塞占位方块并同步回调），所以永远不会再卡在"模型还没加载好"。
  function spawn(pt, itemId, rotY) {
    ensureProto(itemId, (proto) => {
      if (!proto) return;
      const profile = getProfile();
      // 异步期间额度可能已被消耗（或这件家具已换掉）
      if (profile && unplacedCount(profile, itemId) <= 0) { refreshStrip(); return; }
      const mesh = meshFrom(proto, { x: pt.x, y: pt.y || 0, z: pt.z, rotY, scale: 1 });
      placedGroup.add(mesh);
      state.pending.push({ mesh, itemId }); // 记下 itemId：服务端回执若错标成「别人摆的」，也能据此认领
      network.sendBuildAdd({ itemId, x: pt.x, y: pt.y || 0, z: pt.z, rotY, scale: 1 });
    });
  }
  function place() {
    if (state.mode === 'edit') { commitEdit(); return; }
    if (!state.itemId) { onToast('先在下面家具条里选一件家具'); return; }
    const profile = getProfile();
    const avail = profile ? unplacedCount(profile, state.itemId) : 0;
    if (avail <= 0) { onToast('这件家具没有可摆数量了，去商店「家具」页再买一件'); return; }
    const pt = groundPoint(true); // 放置瞬间强制重算：落到准星实际指到的表面上
    if (!pt) { onToast('把准星对准地面再放置'); return; }
    spawn(pt, state.itemId, state.rotY);
  }

  // 认领「我刚摆出」的一条：登记归属(可编辑) + 消耗 1 个额度 + 刷新 UI。mesh 由调用方负责加进场景。
  function acceptMine(rec, mesh) {
    rendered.set(rec.id, { mesh, rec, mine: true });
    myIds.add(rec.id); saveMine();
    const profile = getProfile();
    if (profile) consumeOwned(profile, rec.itemId); // ← 摆放成功即扣 1 件（背包「家具」页签件数 -1）
    onCoins(); refreshStrip();
  }
  function onAdded(rec) {
    if (rendered.has(rec.id)) return;
    const p = state.pending.shift() || null;
    if (p && p.mesh) { acceptMine(rec, p.mesh); return; } // 正常路径：用乐观网格
    // 少见：本地没有乐观网格（例如中途重连）。这条仍是我摆的 → 补个网格并照常消耗。
    ensureProto(rec.itemId, (proto) => {
      if (rendered.has(rec.id)) return;
      const m = meshFrom(proto, rec);
      placedGroup.add(m);
      acceptMine(rec, m);
    });
  }
  function onRejected(reason) {
    const p = state.pending.shift();
    if (p && p.mesh) placedGroup.remove(p.mesh);
    refreshStrip(); // 回滚后余额可能变了，刷新家具条上的 ×N
    onToast(reason || '被服务器拒绝');
  }
  function onAdd(rec) {
    if (rendered.has(rec.id)) return;
    // 兜底：服务端的 «added» 回执若因为 ev 字段被覆盖而当成「add」发来，这里按 itemId 认领自己的那条，
    // 否则会被误判成「别人摆的」→ 不消耗、且不可编辑（这正是之前的 bug）。
    const i = state.pending.findIndex((p) => p && p.itemId === rec.itemId);
    if (i >= 0) {
      const p = state.pending.splice(i, 1)[0];
      acceptMine(rec, p.mesh);
      return;
    }
    ensureProto(rec.itemId, (proto) => {
      if (rendered.has(rec.id)) return;
      const m = meshFrom(proto, rec);
      placedGroup.add(m);
      rendered.set(rec.id, { mesh: m, rec, mine: isMineRec(rec) });
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

  // 服务端要求重载（如管理员在编辑器里清空/删除了家具）：清掉场上全部再拉一次
  function reloadAll() {
    for (const e of rendered.values()) if (e && e.mesh) placedGroup.remove(e.mesh);
    rendered.clear();
    clearAim();
    if (state.mode === 'edit') { state.mode = 'place'; state.editId = null; refreshStrip(); }
    fetchAll();
  }

  // Game 转发：msg = {t:'build', ev, ...}
  function handleBuild(msg) {
    if (!msg) return;
    if (msg.ev === 'added') onAdded(msg);
    else if (msg.ev === 'add') onAdd(msg);
    else if (msg.ev === 'del') onDel(msg);
    else if (msg.ev === 'move') onMove(msg);
    else if (msg.ev === 'owner') setOwnerKey(msg.key);
    else if (msg.ev === 'reload') reloadAll();
    else if (msg.ev === 'areas') setBuildAreas(msg.areas); // 管理员在编辑器改了建造范围
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
    onToast('编辑中：下方可微调 X/Y/Z（长按连发，可切步长）· 「移到准星」吸附 · 完成在下方');
  }
  function exitEdit() { state.mode = 'place'; state.editId = null; refreshStrip(); }
  // 三轴位置微调：axis 0=X 左右 / 1=Y 上下 / 2=Z 前后；dir ±1；步长 = state.nudgeStep
  function nudge(axis, dir) {
    if (state.mode !== 'edit') return;
    const e = rendered.get(state.editId);
    if (!e) return;
    const d = dir * (state.nudgeStep || 0.5);
    if (axis === 0) e.mesh.position.x += d;
    else if (axis === 1) e.mesh.position.y += d;
    else e.mesh.position.z += d;
    if (axis === 1) {
      e.mesh.position.y = THREE.MathUtils.clamp(e.mesh.position.y, -2, 10); // 与服务端 build_move 的 y 钳制一致
    } else {
      const c = clampToAreas(e.mesh.position.x, e.mesh.position.z); // 水平仍限建造范围内
      e.mesh.position.x = c.x; e.mesh.position.z = c.z;
    }
    syncRecPos(e);
  }
  // 把 mesh 当前位置写回它在 rendered 里的 rec：
  // 真模型加载完(swapRealModel) / 重载(reloadAll) 都会拿 rec 重建 mesh，不同步就会被拉回旧坐标。
  function syncRecPos(e) {
    if (!e || !e.rec || !e.mesh) return;
    e.rec.x = e.mesh.position.x;
    e.rec.y = e.mesh.position.y;
    e.rec.z = e.mesh.position.z;
  }
  const NUDGE_STEPS = [0.1, 0.25, 0.5, 1, 2, 5];
  function cycleNudgeStep() {
    const i = NUDGE_STEPS.indexOf(state.nudgeStep);
    state.nudgeStep = NUDGE_STEPS[(i < 0 ? 2 : i + 1) % NUDGE_STEPS.length];
    refreshStrip();
    onToast('微调步长：' + state.nudgeStep + ' 米');
  }
  // 把正在编辑的家具吸附到准星指到的表面（想要「对准哪就摆哪」时用）
  function snapToAim() {
    if (state.mode !== 'edit') return;
    const e = rendered.get(state.editId);
    if (!e) return;
    const pt = groundPoint(true);
    if (!pt) { onToast('准星没对准地面'); return; }
    e.mesh.position.set(pt.x, pt.y || 0, pt.z);
    syncRecPos(e);
  }
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
    syncRecPos(e); // 先写回 rec：服务端回执到达前若有重建（模型加载完/重载），用的就是新坐标
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
      // 编辑模式：家具停在原地，**不再每帧自动跟随准星** ——
      // 否则刚用三轴微调挪动的位置，下一帧就被 groundPoint() 覆盖（表现为「怎么调都没用 / 跳回原处」）。
      // 需要挪位置就用「移到准星」按钮或三轴微调。
      if (ghost) ghost.visible = false;
      return;
    }
    updateGhost();
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

  function mkChip(text, onClick, variant, active, repeat) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'kui-btn ' + (active ? 'kui-btn--primary' : ('kui-btn--' + (variant || 'grey')));
    b.textContent = text;
    b.style.cssText = 'flex:0 0 auto;white-space:nowrap;';
    if (repeat) {
      // 长按连续微调：按下立即触发一次；按住 300ms 后每 70ms 重复；松手 / 移出 / 取消即停
      let t1 = null, t2 = null;
      const stop = () => { if (t1) clearTimeout(t1); if (t2) clearInterval(t2); t1 = t2 = null; };
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation();
        onClick();
        t1 = setTimeout(() => { t2 = setInterval(onClick, 70); }, 300);
      });
      b.addEventListener('pointerup', stop);
      b.addEventListener('pointerleave', stop);
      b.addEventListener('pointercancel', stop);
    } else {
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); onClick(); });
    }
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
      strip.appendChild(mkChip('步长 ' + state.nudgeStep + 'm', cycleNudgeStep, 'grey'));
      // 三轴位置微调（长按连续）：X 左右 · Y 上下 · Z 前后
      strip.appendChild(mkChip('X−', () => nudge(0, -1), 'grey', false, true));
      strip.appendChild(mkChip('X+', () => nudge(0, 1), 'grey', false, true));
      strip.appendChild(mkChip('Y−', () => nudge(1, -1), 'grey', false, true));
      strip.appendChild(mkChip('Y+', () => nudge(1, 1), 'grey', false, true));
      strip.appendChild(mkChip('Z−', () => nudge(2, -1), 'grey', false, true));
      strip.appendChild(mkChip('Z+', () => nudge(2, 1), 'grey', false, true));
      strip.appendChild(mkChip('移到准星', snapToAim, 'primary'));
      strip.appendChild(mkChip('旋转 45°', rotateEdit, 'grey'));
      strip.appendChild(mkChip('删除', deleteEdit, 'red'));
      strip.appendChild(mkChip('完成', commitEdit, 'green'));
      return;
    }
    const list = available();
    if (!list.length) { strip.appendChild(mkLabel('没有可摆的家具 · 去商店「家具」页买')); return; }
    for (const entry of list) {
      // 模型状态标注：占位(无真模型) / 加载中 / 模型失败 / 就绪(无后缀)
      const st = protoState.get(entry.it.id);
      const tag = st === 'loading' ? ' ·加载中' : st === 'failed' ? ' ·模型失败' : (st === 'ready' ? '' : ' ·占位');
      strip.appendChild(mkChip(entry.it.name + ' ×' + entry.n + tag, () => { state.itemId = entry.it.id; refreshStrip(); }, 'grey', entry.it.id === state.itemId));
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
    prefetchAll();            // 预取可用家具原型：进模式即有方块可摆、可预览
    ghostItemId = null;
    refreshGhostProto();
    onActiveChange(true);
    refreshStrip();
    const noStock = !list.length;
    onToast(noStock
      ? '建造模式：还没有可摆的家具 —— 去商店「家具」页买一件'
      : (coarse
        ? '建造模式：攻击键=放置 · 右侧「编辑」/「退出建造」· 只能摆教学楼范围内'
        : '建造模式：左键=放置 · G=编辑 · R=旋转 X=删除 · B=退出 · 仅限教学楼范围内'));
    return true;
  }
  function exit() {
    if (!state.active) return;
    clearAim();
    while (state.pending.length) { const p = state.pending.pop(); if (p && p.mesh) placedGroup.remove(p.mesh); }
    if (ghost) { ghostGroup.remove(ghost); ghost = null; }
    ghostItemId = null;
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
    refresh: () => { refreshStrip(); fetchAll(); prefetchAll(); },
    update,
    place,
  };
}
