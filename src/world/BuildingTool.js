// 职责：建造模式（锤子触发）。买「建造锤」→ 装备到技能槽 → 用技能键进入建造模式：
//   · 隐藏顶栏 / 校卡 / 技能槽（body.kui-build，由 Game 切换）
//   · 攻击键语义变成「放置」
//   · 血条位置换成可横向滚动的「家具条」（选一件已买且有额度的家具）
//   · 新增「编辑」键：对准的已摆家具发白光，按编辑选中后可 移动(对准地面)/旋转/删除
// 摆放联机共享：build_add（放置）/ build_del（删除）/ build_move（移动旋转），服务端权威校验+限流后持久化并广播。
// 消耗式：买 1 件得 1 个摆放额度，放置成功后从钱包 owned 消耗 1 个；移动/旋转不消耗。
// 模型：商品 url 为 'placeholder'（或空）时用占位方块渲染；编辑器导入真模型后自动换成 GLB。
import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { instantiate } from './AssetLoader.js';
import { loadWallet, unplacedCount, consumeOwned, findItem, getCatalog, onCatalogUpdated } from '../player/Shop.js';
import { keyBadge } from '../ui/KeyHints.js';
import { isCoarsePointer } from '../util/isCoarse.js';
import { baseScaleOf } from '../util/furnScale.js';
import { Config } from '../config.js';
import { registerPointLight, enableAreaShadow, AREA_LIGHT_DEFAULTS, LIGHT_SCALE } from './Lights.js';

const DEG = Math.PI / 180;

// 面光源（RectAreaLight）使用前必须初始化一次 LTC 查找表 —— 全局只需要一次
let _rectAreaReady = false;
function ensureRectAreaLib() {
  if (_rectAreaReady) return;
  _rectAreaReady = true;
  try { RectAreaLightUniformsLib.init(); } catch (e) { console.warn('[build] 面光源初始化失败:', e); }
}
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

  // 允许建造范围的可视化：进入建造模式时画一圈绿框。
  // 为什么必须画：范围判定完全靠坐标（服务端下发的矩形），玩家看不见就只能"猜"，一旦范围与楼的
  // 实际位置对不上，现象就是「幽灵不在准星处 / 怎么摆都不对」。画出来一目了然。
  const areaViz = new THREE.Group();
  areaViz.name = 'build-area-viz';
  areaViz.visible = false;
  scene.add(areaViz);
  function buildAreaViz() {
    for (let i = areaViz.children.length - 1; i >= 0; i--) areaViz.remove(areaViz.children[i]);
    const y = 0.08;
    for (const a of getBuildAreas()) {
      const pts = [
        new THREE.Vector3(a.minX, y, a.minZ), new THREE.Vector3(a.maxX, y, a.minZ),
        new THREE.Vector3(a.maxX, y, a.maxZ), new THREE.Vector3(a.minX, y, a.maxZ),
        new THREE.Vector3(a.minX, y, a.minZ),
      ];
      areaViz.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0x3fd07a, transparent: true, opacity: 0.9 })
      ));
      // 四角竖一小段，让边界更醒目
      for (const [cx, cz] of [[a.minX, a.minZ], [a.maxX, a.minZ], [a.maxX, a.maxZ], [a.minX, a.maxZ]]) {
        areaViz.add(new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(cx, y, cz), new THREE.Vector3(cx, y + 1.2, cz)]),
          new THREE.LineBasicMaterial({ color: 0x3fd07a, transparent: true, opacity: 0.9 })
        ));
      }
    }
  }

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
    editOp: 'move',  // 编辑模式的操作：'move' 移动 | 'scale' 缩放 | 'rotate' 旋转
    editAxis: 'x',   // 当前作用的轴：'x' | 'y' | 'z'（缩放只有 'all'、旋转只有 'y'）
    wasClamped: false, // 上一帧准星点是否越界（用于"越界提示"只弹一次）
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
    // ⚠ 商品 size 字段记的是「模型原尺寸 × 2」（生成目录时按当时的 ×2 建议写的），
    //   而真模型现在的显示尺寸是「原尺寸 × 基座」，所以占位要乘 baseScale/2 才跟真模型一样大，
    //   否则模型加载完成的瞬间会从方块尺寸跳一下。
    const k = baseScaleOf(item && item.id) / 2;
    const size = Array.isArray(item.size) && item.size.length === 3
      ? [(Number(item.size[0]) || 1) * k, (Number(item.size[1]) || 1) * k, (Number(item.size[2]) || 1) * k]
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

  // 已加载原型**当时**对应的模型来源（url 或组合定义）。商品目录更新后（placeholder → 真 url）
  // 拿它对一下，不一致就说明原型过期了，要重新加载 —— 否则家具会永久定格在占位方块。
  const protoUrl = new Map();
  function protoKeyOf(it) {
    if (!it) return '';
    if (it.combo && Array.isArray(it.combo.parts)) return 'combo:' + JSON.stringify(it.combo);
    return String(it.url || '');
  }

  // 取原型：**先立刻塞一个占位方块**（保证「永远有原型可摆」），真模型/组合在后台加载完再替换。
  // 状态记在 protoState：'placeholder'（本来就没真模型）/ 'loading' / 'ready' / 'failed'（失败可重试）。
  function ensureProto(itemId, cb) {
    const it = findItem(itemId);
    if (!it) return;
    const st = protoState.get(itemId);
    const key = protoKeyOf(it);
    // 过期判定：已有原型，但商品现在指向的模型来源和建原型时不一样（最常见：目录刚到，placeholder → 真 url）
    const stale = protoCache.has(itemId) && protoUrl.get(itemId) !== key;
    if (protoCache.has(itemId) && !stale && st !== 'failed') { cb(protoCache.get(itemId)); return; } // 已有原型直接用（failed 允许重试）
    if (!protoCache.has(itemId)) protoCache.set(itemId, makePlaceholderBox(it)); // 占位方块兜底
    protoState.set(itemId, 'placeholder');
    cb(protoCache.get(itemId)); // 同步回调：调用方立刻拿到「可摆」的原型，不会再卡

    const isCombo = !!(it.combo && Array.isArray(it.combo.parts));
    const hasUrl = !!(it.url && it.url !== 'placeholder');
    if (!isCombo && !hasUrl) { protoUrl.set(itemId, key); return; } // 本来就是占位商品（无真模型），到此为止

    protoState.set(itemId, 'loading');
    protoUrl.set(itemId, key); // 立刻记账：加载中若再被 ensureProto，判定为「未过期」→ 不会重复发请求
    const onLoaded = (g) => {
      if (!g) return;
      protoCache.set(itemId, g);
      protoUrl.set(itemId, key);
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

  // 商品目录到位后调用：把「目录还没到时按 placeholder 建出来的原型」升级成真模型。
  // 不这么做的话：进游戏时若 /api/build 比 /api/shop 先回来，家具会一次性定格成占位方块且永不重试
  // —— 玩家看到的就是「放下退出刷新之后，家具变成了方块」。
  function refreshProtos() {
    for (const id of Array.from(protoCache.keys())) ensureProto(id, () => {});
    for (const e of rendered.values()) if (e && e.rec && e.rec.itemId) ensureProto(e.rec.itemId, () => {});
  }
  onCatalogUpdated(refreshProtos);

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
        itemId,
        x: p.mesh.position.x, y: p.mesh.position.y, z: p.mesh.position.z,
        rotY: p.mesh.rotation.y / DEG, scale: 1,
      });
      placedGroup.remove(p.mesh);
      placedGroup.add(m);
      p.mesh = m;
    }
  }

  // 组合家具：多个模型 + 灯拼成一个 Group。
  // 灯只负责照亮（点光源登记阴影、面光源原样还原），**不再挂任何可见的"灯泡"标记** ——
  // 之前那个纯色小球/光晕在夜里就是个白点与眩光，用户明确要求去掉。
  //
  // ⚠ 类型必须保留：这里以前写死 new THREE.PointLight(...)，编辑器里存的面光源（area）
  //   一摆出来就"变成"点光源了（用户报的就是这个）。
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
        if (l.type === 'area') {
          ensureRectAreaLib(); // 面光源使用前必须初始化一次 LTC 查找表
          const area = new THREE.RectAreaLight(
            col,
            Number(l.intensity) || AREA_LIGHT_DEFAULTS.intensity,
            Math.max(0.01, Number(l.width) || AREA_LIGHT_DEFAULTS.width),
            Math.max(0.01, Number(l.height) || AREA_LIGHT_DEFAULTS.height)
          );
          area.position.copy(pos);
          // RectAreaLight 沿本地 -Z 发光：rotX 为俯仰（度，负值朝下），默认 -90 即垂直向下。
          // 用 YXZ 顺序（先偏航 rotY 再俯仰 rotX）。
          // ⚠ 缺省值统一取自 AREA_LIGHT_DEFAULTS —— 各处自己写死默认值迟早分叉
          //   （分叉过一次：编辑器读存档写成 0，家具里的灯就横过来了）。
          area.rotation.order = 'YXZ';
          area.rotation.set(
            DEG * (Number.isFinite(Number(l.rotX)) ? Number(l.rotX) : AREA_LIGHT_DEFAULTS.rotX),
            DEG * (Number.isFinite(Number(l.rotY)) ? Number(l.rotY) : AREA_LIGHT_DEFAULTS.rotY),
            0
          );
          // 面光源本身不能投影（RectAreaLight 无 shadow 字段）→ 接一盏阴影代理聚光灯，
          // 由它真正被墙挡住（亮度拆分与单位换算见 Lights.enableAreaShadow）。
          enableAreaShadow(area, { distance: Number(l.distance) > 0 ? Number(l.distance) : AREA_LIGHT_DEFAULTS.distance });
          g.add(area);
        } else {
          const pl = new THREE.PointLight(col, (Number(l.intensity) || 1) * LIGHT_SCALE, Number(l.distance) || 12, Number(l.decay) || 2);
          pl.position.copy(pos);
          registerPointLight(pl); // 交给 Lights 统一分配阴影名额（最近的几盏才投影）
          g.add(pl);
        }
      }
      return g;
    });
  }
  function meshFrom(proto, rec) {
    const m = proto.clone(true); touchShadow(m);
    // ⚠ clone(true) 会把面光源的阴影代理一起拷过来，但 three 的 SpotLight.copy 做的是
    //   `this.target = source.target.clone()` —— 拷出来的是**游离节点**，不在场景图里、
    //   matrixWorld 永远不更新 → 光向会算错（照向世界原点方向）。
    //   这里对每盏面光源重新 enableAreaShadow：复用拷来的代理，并把 target 重新挂回自己的子树。
    //   基准亮度存在 userData（数字，能安全穿过 clone 的 JSON 深拷贝），所以不会越调越暗。
    const areas = [];
    m.traverse((o) => { if (o.isRectAreaLight) areas.push(o); });
    for (const a of areas) enableAreaShadow(a);
    // ⚠ 缩放 = 基座 × 用户倍率：基座（家具 3）只用于渲染，绝不写进 rec.scale（否则每次编辑都会叠加一次）
    m.scale.setScalar((rec && rec.scale ? rec.scale : 1) * baseScaleOf(rec && rec.itemId));
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
      if (n.isLight) { n.visible = false; return; } // 组合家具里的灯不参与描边
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
  // 返回里带 clamped：准星指的点**不在范围内**、被吸附到楼边了（幽灵会变红提示）。
  function groundPoint(fresh) {
    if (fresh || (surfTick++ % 4) === 0) surfCache = surfacePoint();
    const sp = surfCache;
    if (!sp) return null;
    const c = clampToAreas(sp.x, sp.z);
    return { x: c.x, y: sp.y, z: c.z, clamped: (c.x !== sp.x || c.z !== sp.z) };
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
    // 幽灵要和摆下去之后一样大：走 meshFrom 的那条路会乘家具基座，这里得手动补上
    ghost.scale.setScalar(baseScaleOf(id));
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
    // 准星指的点**不在允许范围内**（被吸附到楼边）→ 幽灵变红，提示"这儿放不了"
    setGhostTint(pt.clamped ? 0xff5a5a : 0x5fb0ff);
    if (pt.clamped !== state.wasClamped) {           // 只在「越界/回到界内」的那一刻提示一次
      state.wasClamped = pt.clamped;
      if (pt.clamped) onToast('准星指的位置不在建造范围内 —— 看地上的绿色框');
    }
  }
  // 幽灵整体调色：材质是 makeGhost 里 clone 出来的，改它不会污染真模型
  function setGhostTint(hex) {
    if (!ghost) return;
    ghost.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) if (m && m.emissive) m.emissive.setHex(hex);
    });
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
      const mesh = meshFrom(proto, { itemId, x: pt.x, y: pt.y || 0, z: pt.z, rotY, scale: 1 });
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
    if (rec.scale) e.mesh.scale.setScalar(Number(rec.scale) * baseScaleOf(e.rec.itemId));
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
    else if (msg.ev === 'areas') { setBuildAreas(msg.areas); if (areaViz.visible) buildAreaViz(); } // 管理员在编辑器改了建造范围
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
    state.editOp = 'move';
    state.editAxis = 'x';
    state.rotY = (Number(a.entry.rec.rotY) || 0) / DEG; // rec 里存的是度，直接用原值（不吸附，滑动微调要连续）
    clearAim();
    refreshStrip();
    onToast('编辑中：下面选「移动/缩放/旋转」→ 选轴 → 在滑块上上下滑动（↑加 ↓减）');
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

  // ---------- 编辑操作：模式（移动/缩放/旋转） × 轴向 × 滑动调节 ----------
  const SCALE_STEP = 0.05;            // 缩放每档
  const ROT_STEP = 15;                // 旋转每档（度）
  // ⚠ 上下限必须对齐服务端：server-remote/index.js 的 BUILD_SCALE_MIN/MAX = 0.1/3，
  //   build_move 会把超范围的 scale 静默夹掉 → 客户端调到 8、重载后变回 3（典型的静默失效）。
  //   这里的 1 = 家具基座大小（见 util/furnScale.js），所以实际可调范围是基座的 0.1~3 倍。
  const SCALE_MIN = 0.1, SCALE_MAX = 3;
  // 每种模式可选的轴。⚠ 只提供「服务端存得下」的轴：
  //   服务端 build_move 只存 x/y/z + 单个 scale + rotY，所以缩放只能等比、旋转只能绕竖轴。
  //   给存不下的轴做分轴调节 = 重载后打回原形（静默失效），宁可不给。
  const AXES_BY_OP = {
    move: [['x', 'X 左右'], ['y', 'Y 上下'], ['z', 'Z 前后']],
    scale: [['all', '整体等比']],
    rotate: [['y', '绕竖轴 Y']],
  };
  function axesFor(op) { return AXES_BY_OP[op] || AXES_BY_OP.move; }

  // 滑动/滚轮的一档：dir = +1（向上滑）加、-1（向下滑）减
  function editStep(dir) {
    if (state.mode !== 'edit') return;
    const e = rendered.get(state.editId);
    if (!e) return;
    if (state.editOp === 'move') {
      nudge({ x: 0, y: 1, z: 2 }[state.editAxis] ?? 0, dir);
    } else if (state.editOp === 'scale') {
      const cur = Number(e.rec.scale) || 1;
      const s = THREE.MathUtils.clamp(cur + dir * SCALE_STEP, SCALE_MIN, SCALE_MAX);
      e.rec.scale = s;
      e.mesh.scale.setScalar(s * baseScaleOf(e.rec.itemId));
    } else {
      state.rotY = (state.rotY + dir * ROT_STEP) % 360;
      if (state.rotY < 0) state.rotY += 360;
      e.mesh.rotation.y = state.rotY * DEG;
    }
    refreshSlider();
  }

  // 滑块上的当前值（滑动时实时刷新，让"加/减了多少"看得见）
  let sliderLabel = null;
  function refreshSlider() {
    if (!sliderLabel) return;
    const e = state.editId ? rendered.get(state.editId) : null;
    if (!e) { sliderLabel.textContent = '上下滑动调节'; return; }
    if (state.editOp === 'move') {
      const p = e.mesh.position;
      const v = state.editAxis === 'y' ? p.y : state.editAxis === 'z' ? p.z : p.x;
      sliderLabel.textContent = '位置 ' + String(state.editAxis).toUpperCase() + ' = ' + v.toFixed(2) + ' m';
    } else if (state.editOp === 'scale') {
      // 显示「相对模型原始尺寸」的实际倍率（含家具基座），用户看到的数字和眼前家具的真实大小对得上
      const shown = (Number(e.rec.scale) || 1) * baseScaleOf(e.rec.itemId);
      sliderLabel.textContent = '缩放 = ' + shown.toFixed(2) + ' ×';
    } else {
      sliderLabel.textContent = '旋转 = ' + Math.round(state.rotY) + '°';
    }
  }

  // 上下滑动的调节条：向上滑 = 加、向下滑 = 减；每 STEP_PX 像素一档（滑得越多加得越多）。
  // PC 上鼠标拖拽同样有效，另加滚轮（滚轮向上 = 加）。
  function mkSlider() {
    const STEP_PX = 14;
    const box = document.createElement('div');
    box.className = 'build-slider';
    box.style.cssText =
      'flex:1 1 100%;height:56px;border-radius:var(--kui-radius);box-sizing:border-box;' +
      'border:2px dashed var(--kui-blue-dark);background:#eaf2fb;touch-action:none;user-select:none;' +
      'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;cursor:ns-resize;';
    const t = document.createElement('div');
    t.style.cssText = 'font-size:13px;font-weight:700;color:var(--kui-ink);pointer-events:none;';
    const hint = document.createElement('div');
    hint.textContent = '上下滑动：↑ 加 · ↓ 减（电脑可拖拽或滚轮）';
    hint.style.cssText = 'font-size:11px;color:var(--kui-ink-soft);pointer-events:none;';
    box.appendChild(t);
    box.appendChild(hint);
    sliderLabel = t;
    let startY = null, acc = 0;
    const stop = (e) => {
      startY = null; acc = 0;
      try { if (e && e.pointerId != null) box.releasePointerCapture(e.pointerId); } catch (_) { /* 不支持捕获就算了 */ }
    };
    box.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation(); // 别让这一下被当成转视角
      startY = e.clientY; acc = 0;
      try { box.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    });
    box.addEventListener('pointermove', (e) => {
      if (startY == null) return;
      const dy = startY - e.clientY; // 向上滑 → dy 为正 → 加
      while (dy - acc >= STEP_PX) { acc += STEP_PX; editStep(1); }
      while (acc - dy >= STEP_PX) { acc -= STEP_PX; editStep(-1); }
    });
    box.addEventListener('pointerup', stop);
    box.addEventListener('pointercancel', stop);
    box.addEventListener('wheel', (e) => { e.preventDefault(); editStep(e.deltaY < 0 ? 1 : -1); }, { passive: false });
    return box;
  }
  function mkRow() {
    const d = document.createElement('div');
    d.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;width:100%;';
    return d;
  }
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
    state.rotY = (state.rotY + ROT_STEP) % 360;
    const e = rendered.get(state.editId);
    if (e) e.mesh.rotation.y = state.rotY * DEG;
    refreshSlider();
  }
  function deleteEdit() {
    if (state.mode !== 'edit') return;
    const id = state.editId;
    if (!id) { exitEdit(); return; }
    // ⚠ 必须「先本地删、再发请求」（乐观删除）：原来只发请求、等服务端广播回来才移除，
    //   而服务端在查不到这条记录时（id 不一致 / 已被清过 / 断线时摆的）会直接 return 不广播 ——
    //   表现就是「点了删除、方块还杵在那儿」。服务端回执到了是幂等的（rendered 里已没有该 id）。
    onDel(id);
    network.sendBuildDel(id);
    onToast('已删除');
  }
  function commitEdit() {
    if (state.mode !== 'edit') return;
    const e = rendered.get(state.editId);
    if (!e) { exitEdit(); return; }
    syncRecPos(e); // 先写回 rec：服务端回执到达前若有重建（模型加载完/重载），用的就是新坐标
    network.sendBuildMove({
      id: state.editId,
      x: e.mesh.position.x, y: e.mesh.position.y, z: e.mesh.position.z,
      rotY: state.rotY, scale: Number(e.rec.scale) || 1,
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
    // 编辑模式的工具条是多行的（模式 / 轴向 / 滑块 / 动作），放置模式仍是单行横滚的家具列表
    strip.style.flexWrap = (state.mode === 'edit') ? 'wrap' : 'nowrap';
    strip.innerHTML = '';
    if (state.mode === 'edit') {
      // ① 操作模式
      const r1 = mkRow();
      r1.appendChild(mkLabel('操作：'));
      for (const [op, text] of [['move', '移动'], ['scale', '缩放'], ['rotate', '旋转']]) {
        r1.appendChild(mkChip(text, () => {
          state.editOp = op;
          state.editAxis = axesFor(op)[0][0]; // 换模式后轴可能不存在，落回该模式第一个可用轴
          refreshStrip();
        }, 'grey', state.editOp === op));
      }
      // ② 轴向（+ 移动模式的步长）
      const r2 = mkRow();
      r2.appendChild(mkLabel('轴向：'));
      for (const [ax, text] of axesFor(state.editOp)) {
        r2.appendChild(mkChip(text, () => { state.editAxis = ax; refreshStrip(); }, 'grey', state.editAxis === ax));
      }
      if (state.editOp === 'move') r2.appendChild(mkChip('步长 ' + state.nudgeStep + 'm', cycleNudgeStep, 'grey'));
      // ③ 滑动调节
      strip.appendChild(r1);
      strip.appendChild(r2);
      strip.appendChild(mkSlider());
      refreshSlider();
      // ④ 其余动作
      const r3 = mkRow();
      r3.appendChild(mkChip('移到准星', snapToAim, 'primary'));
      r3.appendChild(mkChip(coarse ? '删除' : '删除 · X', deleteEdit, 'red'));
      r3.appendChild(mkChip(coarse ? '完成' : '完成 · G', commitEdit, 'green'));
      strip.appendChild(r3);
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
    buildAreaViz();
    areaViz.visible = true;   // 把「能摆哪儿」画出来
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
    areaViz.visible = false;
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
