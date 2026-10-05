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
import { keyBadge } from '../ui/KeyHints.js';
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

  // ---------- 对准描边 ----------
  // 需求：对准的家具要「有描边」，不是把材质打成白光。
  // 做法：克隆一份模型，材质换成只画背面的纯色壳，整体略放大 → 包在原模型外面形成一圈轮廓。
  // 原 mesh 的材质一个字节都不动，退出描边时直接丢掉壳即可，不存在还原不干净的问题。
  let aimId = null;              // 当前对准的已摆家具 id
  let outlineObj = null;         // 描边壳（加在 scene 上，不能进 placedGroup）
  const OUTLINE_COLOR = 0x6fd3ff; // 亮蓝轮廓（比白光在木色家具上更清楚）
  const OUTLINE_SCALE = 1.06;

  function outlineRemove() {
    if (!outlineObj) return;
    if (outlineObj.parent) outlineObj.parent.remove(outlineObj);
    outlineObj = null;
  }
  function outlineShow(entry) {
    outlineRemove();
    const src = entry && entry.mesh;
    if (!src) return;
    const o = src.clone(true); // geometry 共享，只克隆节点
    o.traverse((n) => {
      if (n.isLight) { n.visible = false; return; } // 组合家具里的点光源不参与描边
      if (!n.isMesh) return;
      n.material = new THREE.MeshBasicMaterial({ color: OUTLINE_COLOR, side: THREE.BackSide });
      n.castShadow = false; n.receiveShadow = false;
      n.scale.multiplyScalar(OUTLINE_SCALE);
      n.renderOrder = 997;
    });
    o.position.copy(src.position);
    o.rotation.copy(src.rotation);
    o.scale.copy(src.scale);
    // ⚠ 必须挂在 scene 上：放进 placedGroup 的话 aimedEntry() 会把描边壳也当成一件家具
    scene.add(o);
    outlineObj = o;
  }
  function clearAim() { outlineRemove(); aimId = null; }

  // ---------- 射线：准星中心 ----------
  // 取准星指到的「可站立表面」点：地面 / 台阶 / 楼板 / 已有家具顶面。
  // ⚠ 只认**朝上的面**（法线 y > 0.6）：否则对着教学楼墙面/天花板时，家具会被贴到墙上去（表现为"放不进楼里"）。
  //   墙面全部被跳过时回退到地面高度；射线朝上/水平拿不到地面交点时，退化为「前方 12 米的地面点」，
  //   保证**永远能给出一个落点**，不会出现"怎么点都放不下"。
  const surfaceHits = [];
  const _nrm = new THREE.Vector3();
  const _nmat = new THREE.Matrix3();
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
      if (p.y < -2 || p.y > 10) continue; // 与服务端 build_move 的 y 钳制保持一致
      if (h.face && h.face.normal && h.object) {
        _nrm.copy(h.face.normal).applyMatrix3(_nmat.getNormalMatrix(h.object.matrixWorld)).normalize();
        if (_nrm.y < 0.6) continue; // 墙面 / 天花板 → 不算可摆放面，继续看下一个交点
      }
      return { x: p.x, y: p.y, z: p.z };
    }
    // 回退：把视线延长到 y=0 平面上；视线朝上/水平时退化为「前方 12 米」
    const dir = raycaster.ray.direction;
    const t = dir.y < -1e-4 ? (-raycaster.ray.origin.y / dir.y) : 12;
    const tt = (Number.isFinite(t) && t > 0) ? Math.min(t, 60) : 12;
    raycaster.ray.at(tt, hit);
    return { x: hit.x, y: 0, z: hit.z };
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
    if (newId !== aimId) {
      clearAim();
      if (a) { aimId = a.id; outlineShow(a.entry); }
    }
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
  if (!coarse) editBtn.appendChild(keyBadge('g')); // PC：按钮上标出快捷键
  bindPress(editBtn, startEdit, false);
  actions.appendChild(editBtn);

  const exitBtn = document.createElement('button');
  exitBtn.type = 'button';
  exitBtn.className = 'kui-btn kui-btn--red';
  exitBtn.textContent = '退出建造';
  if (!coarse) exitBtn.appendChild(keyBadge('b')); // PC：按钮上标出快捷键
  bindPress(exitBtn, exit, false);
  actions.appendChild(exitBtn);

  // 统一的「点按」绑定：**必须点一下才触发**；手指/鼠标拖动过（想转视角）一律不算点击。
  // 手机上底部工具条压在右侧视角区上，若沿用 pointerdown 立即触发，一拖动就会误点到按钮。
  const TAP_MOVE_PX = 8;
  function bindPress(el, fn, repeat) {
    let x0 = 0, y0 = 0, moved = false, t1 = null, t2 = null;
    const stopRepeat = () => { if (t1) clearTimeout(t1); if (t2) clearInterval(t2); t1 = t2 = null; };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      x0 = e.clientX; y0 = e.clientY; moved = false;
      if (repeat) t1 = setTimeout(() => { if (!moved) { fn(); t2 = setInterval(fn, 70); } }, 300);
    });
    el.addEventListener('pointermove', (e) => {
      if (moved) return;
      if (Math.abs(e.clientX - x0) > TAP_MOVE_PX || Math.abs(e.clientY - y0) > TAP_MOVE_PX) { moved = true; stopRepeat(); }
    });
    el.addEventListener('pointerup', () => {
      const repeating = !!t2;
      stopRepeat();
      if (moved) return;      // 拖动过 → 不当作点击
      if (!repeating) fn();   // 短按（或未进入连发）触发一次
    });
    el.addEventListener('pointercancel', () => { moved = true; stopRepeat(); });
    el.addEventListener('pointerleave', () => { if (repeat) { moved = true; stopRepeat(); } });
    return el;
  }
  function mkChip(text, onClick, variant, active, repeat) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'kui-btn ' + (active ? 'kui-btn--primary' : ('kui-btn--' + (variant || 'grey')));
    b.textContent = text;
    b.style.cssText = 'flex:0 0 auto;white-space:nowrap;touch-action:manipulation;';
    return bindPress(b, onClick, repeat);
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
      strip.appendChild(mkChip(coarse ? '旋转 45°' : '旋转 45° · R', rotateEdit, 'grey'));
      strip.appendChild(mkChip(coarse ? '删除' : '删除 · X', deleteEdit, 'red'));
      strip.appendChild(mkChip(coarse ? '完成' : '完成 · G', commitEdit, 'green'));
      return;
    }
    const list = available();
    if (!list.length) { strip.appendChild(mkLabel('没有可摆的家具 · 去商店「家具」页买')); return; }
    if (!coarse) strip.appendChild(mkLabel('数字键选：')); // PC：1..N 切换
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
