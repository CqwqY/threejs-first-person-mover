// 职责：玩家建造工具（教学楼）。必须是**在商店买过的教学楼**（kind:'building'）才能摆；
// 摆放联机共享——发到服务端校验 + 限流后持久化（data/buildings.json）并广播给所有人，刷新/重进仍在。
// 限流由服务端权威执行（个人≤5 / 全局≤50 / 冷却3s / 缩放封顶 / 坐标钳制），本地只做体验与额度提示。
// 消耗式：买 1 栋得 1 个摆放额度，摆出成功后从钱包 owned 消耗 1 个；再买再摆。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { instantiate } from './AssetLoader.js';
import { loadWallet, unplacedCount, consumeOwned, findItem, getCatalog } from '../player/Shop.js';

const DEG = Math.PI / 180;
const CLAMP = 24; // 放置区域钳制在 ±24（地面尺寸 50，半径 25）

// initBuildingTool(scene, camera, domElement, network, opts)：
//   opts.getProfile   () => profile|null   （钱包按账号；建造额度以此计）
//   opts.serverBase   'https://host:9000'  （联机服务端基址，用于拉 /api/build）
//   opts.onToast      (msg) => void
//   opts.onCoins      () => void              （消耗额度后刷新商店/学币显示）
// 返回 { state, setActive, toggle, handleBuild }，handleBuild 供 Game 转发服务端 build 消息。
export function initBuildingTool(scene, camera, domElement, network, opts = {}) {
  const getProfile = opts.getProfile || (() => null);
  const serverBase = (opts.serverBase || '').replace(/\/+$/, '');
  const onToast = opts.onToast || (() => {});
  const onCoins = opts.onCoins || (() => {});

  const placedGroup = new THREE.Group();
  placedGroup.name = 'shared-buildings';
  scene.add(placedGroup);

  const raycaster = new THREE.Raycaster();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const ndc = new THREE.Vector2();
  const hit = new THREE.Vector3();

  const state = {
    active: false,
    pick: false,
    itemId: null,
    ghost: null,
    scale: 1, rotY: 0, yOff: 0,
    x: 3, z: 3,
    pendingMesh: null, // 乐观渲染、待服务端回执确认的楼
  };

  // id -> { mesh, rec, mine }
  const rendered = new Map();
  const myIds = loadMine(getProfile());   // 我摆过的楼 id（本地记录，用于显示「移除」按钮）
  const protoCache = new Map();            // itemId -> 已加载的模型原型（切换素材不重复下）

  function mineKey() {
    const p = getProfile();
    const id = p ? (p.username || p.nickname || '') : '';
    return 'fp_build_mine__' + (id || 'guest');
  }
  function loadMine() {
    try { return new Set(JSON.parse(localStorage.getItem(mineKey()) || '[]')); } catch { return new Set(); }
  }
  function saveMine() {
    try { localStorage.setItem(mineKey(), JSON.stringify([...myIds])); } catch { /* ignore */ }
  }

  function touchShadow(m) {
    m.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  }

  // ---------- 幽灵预览 ----------
  function getProto(itemId) {
    return protoCache.get(itemId) || null;
  }
  function ensureProto(itemId, cb) {
    if (protoCache.has(itemId)) { cb(protoCache.get(itemId)); return; }
    const it = findItem(itemId);
    if (!it || !it.url) return;
    instantiate(it.url).then((m) => {
      protoCache.set(itemId, m);
      cb(m);
    }).catch(() => { onToast('模型加载失败：' + (it.url || itemId)); });
  }

  function resetGhost() {
    if (state.ghost) { scene.remove(state.ghost); state.ghost = null; }
    if (!state.active || !state.itemId) return;
    const ghost = new THREE.Group();
    ghost.add(makeRing());
    scene.add(ghost);
    state.ghost = ghost;
    const proto = getProto(state.itemId);
    if (proto) attachProto(ghost, proto);
    else ensureProto(state.itemId, (p) => { if (state.ghost && state.itemId) attachProto(state.ghost, p); });
    syncGhost();
    positionGhost();
  }
  function attachProto(ghost, proto) {
    // 清掉旧模型（保留 ring）
    for (let i = ghost.children.length - 1; i >= 0; i--) {
      if (ghost.children[i].userData.isRing) continue;
      ghost.remove(ghost.children[i]);
    }
    const m = proto.clone(true);
    touchShadow(m);
    ghost.add(m);
  }
  function makeRing() {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.55, 0.95, 32),
      new THREE.MeshBasicMaterial({ color: 0x4aa3ff, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    ring.userData.isRing = true;
    return ring;
  }
  function syncGhost() {
    if (!state.ghost) return;
    for (const c of state.ghost.children) {
      if (c.userData.isRing) continue;
      c.scale.setScalar(state.scale);
      c.rotation.y = state.rotY * DEG;
      c.position.y = state.yOff;
    }
  }
  function positionGhost() {
    if (state.ghost) state.ghost.position.set(state.x, 0, state.z);
  }

  // ---------- 摆放 ----------
  function place() {
    const profile = getProfile();
    if (!state.itemId) { onToast('先在商店买教学楼，再到这里摆'); return; }
    const avail = profile ? unplacedCount(profile, state.itemId) : 0;
    if (avail <= 0) { onToast('该教学楼已无摆放额度，去商店再买一栋'); return; }

    const proto = getProto(state.itemId);
    if (!proto) { onToast('模型还没加载好，稍等'); return; }

    // 乐观渲染（待服务端回执给 id）
    const mesh = proto.clone(true);
    touchShadow(mesh);
    mesh.scale.setScalar(state.scale);
    mesh.rotation.y = state.rotY * DEG;
    mesh.position.set(state.x, state.yOff, state.z);
    placedGroup.add(mesh);
    state.pendingMesh = mesh;

    network.sendBuildAdd({
      itemId: state.itemId,
      x: state.x, y: state.yOff, z: state.z,
      rotY: state.rotY, scale: state.scale,
    });
  }

  // 服务端回执：摆成功（带 id）
  function onAdded(rec) {
    if (rendered.has(rec.id)) return;
    let mesh = state.pendingMesh;
    state.pendingMesh = null;
    if (!mesh) {
      // 兜底：没乐观网格（理论上不会），按 rec 重新加载
      ensureProto(rec.itemId, (p) => {
        const m = p.clone(true); touchShadow(m);
        m.scale.setScalar(rec.scale); m.rotation.y = rec.rotY * DEG; m.position.set(rec.x, rec.y, rec.z);
        placedGroup.add(m); rendered.set(rec.id, { mesh: m, rec, mine: true });
      });
      return;
    }
    rendered.set(rec.id, { mesh, rec, mine: true });
    myIds.add(rec.id); saveMine();
    const profile = getProfile();
    if (profile) consumeOwned(profile, rec.itemId);
    onCoins();
    refreshSel();
    renderList();
  }
  // 服务端拒绝（额度/上限/冷却）
  function onRejected(reason) {
    if (state.pendingMesh) { placedGroup.remove(state.pendingMesh); state.pendingMesh = null; }
    onToast(reason || '摆放被服务器拒绝');
  }
  // 别人摆的（自己收到 add）
  function onAdd(rec) {
    if (rendered.has(rec.id)) return;
    ensureProto(rec.itemId, (p) => {
      if (rendered.has(rec.id)) return;
      const m = p.clone(true); touchShadow(m);
      m.scale.setScalar(rec.scale); m.rotation.y = rec.rotY * DEG; m.position.set(rec.x, rec.y, rec.z);
      placedGroup.add(m);
      rendered.set(rec.id, { mesh: m, rec, mine: myIds.has(rec.id) });
    });
  }
  function onDel(id) {
    const e = rendered.get(id);
    if (e) { placedGroup.remove(e.mesh); rendered.delete(id); }
    myIds.delete(id); saveMine();
    renderList();
  }

  // Game 转发：msg = {t:'build', ev, ...}
  function handleBuild(msg) {
    if (!msg) return;
    if (msg.ev === 'added') onAdded(msg);
    else if (msg.ev === 'add') onAdd(msg);
    else if (msg.ev === 'del') onDel(msg);
    else if (msg.ev === 'rejected') onRejected(msg.reason);
  }

  // 进游戏拉一次全服已摆的楼
  function fetchAll() {
    if (!serverBase) return;
    fetch(serverBase + '/api/build')
      .then((r) => r.json())
      .then((d) => { if (d && d.ok && Array.isArray(d.items)) d.items.forEach((rec) => onAdd(rec)); })
      .catch(() => {});
  }

  // ---------- 位置拾取 ----------
  function pointerOnGround(clientX, clientY) {
    const rect = domElement.getBoundingClientRect();
    ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -(((clientY - rect.top) / rect.height) * 2 - 1);
    raycaster.setFromCamera(ndc, camera);
    return raycaster.ray.intersectPlane(groundPlane, hit);
  }
  function onMouseMove(e) {
    if (!state.active || !state.pick || !state.ghost) return;
    const p = pointerOnGround(e.clientX, e.clientY);
    if (p) { state.x = THREE.MathUtils.clamp(p.x, -CLAMP, CLAMP); state.z = THREE.MathUtils.clamp(p.z, -CLAMP, CLAMP); positionGhost(); }
  }
  function onMouseDown(e) {
    if (!state.active || !state.pick || !state.ghost) return;
    e.preventDefault(); e.stopPropagation();
    const p = pointerOnGround(e.clientX, e.clientY);
    if (p) { state.x = THREE.MathUtils.clamp(p.x, -CLAMP, CLAMP); state.z = THREE.MathUtils.clamp(p.z, -CLAMP, CLAMP); positionGhost(); place(); }
  }

  // ---------- UI ----------
  const toggleBtn = document.createElement('button');
  toggleBtn.textContent = '建造 (B)';
  toggleBtn.style.cssText =
    'position:fixed;left:12px;bottom:12px;z-index:99998;background:rgba(15,15,15,.85);color:#fff;' +
    'font:12px/1 sans-serif;padding:8px 12px;border:1px solid #333;border-radius:6px;cursor:pointer;';
  document.body.appendChild(toggleBtn);

  const panel = document.createElement('div');
  panel.style.cssText =
    'position:fixed;left:12px;bottom:48px;z-index:99999;background:rgba(15,15,15,.92);color:#fff;' +
    'font:12px/1.6 sans-serif;padding:14px 16px;border-radius:8px;width:300px;user-select:none;display:none;';
  document.body.appendChild(panel);

  const box = panel;
  {
    const title = document.createElement('div');
    title.textContent = '教学楼建造';
    title.style.cssText = 'font-weight:bold;margin-bottom:6px;';
    box.appendChild(title);

    const sel = document.createElement('select');
    sel.style.cssText = 'width:100%;background:#222;color:#fff;border:1px solid #444;border-radius:4px;';
    box.appendChild(sel);
    sel.addEventListener('change', () => { state.itemId = sel.value || null; resetGhost(); });

    const hint = document.createElement('div');
    hint.style.cssText = 'color:#ffd479;margin:6px 0;';
    box.appendChild(hint);

    const sc = slider(box, '缩放', 0.1, 3, 0.05, 1, (v) => { state.scale = v; syncGhost(); });
    const rot = slider(box, '旋转(°)', 0, 360, 1, 0, (v) => { state.rotY = v; syncGhost(); });
    const yo = slider(box, '离地高度', -1, 4, 0.05, 0, (v) => { state.yOff = v; syncGhost(); });

    const xr = numField(box, 'X');
    const zr = numField(box, 'Z');

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;margin-top:10px;';
    const pickBtn = mkBtn('鼠标拾取位置', '#4aa3ff');
    const placeBtn = mkBtn('摆出', '#2b6f5f');
    const clearBtn = mkBtn('移除我摆的', '#a33');
    btnRow.appendChild(pickBtn); btnRow.appendChild(placeBtn); btnRow.appendChild(clearBtn);
    box.appendChild(btnRow);

    pickBtn.addEventListener('click', () => {
      state.pick = !state.pick;
      pickBtn.textContent = state.pick ? '停止拾取' : '鼠标拾取位置';
      if (state.pick && document.exitPointerLock) document.exitPointerLock();
    });
    placeBtn.addEventListener('click', place);
    clearBtn.addEventListener('click', () => {
      for (const id of [...myIds]) network.sendBuildDel(id);
      onToast('已请求移除你摆的楼');
    });

    box.appendChild(sectionLabel('我摆的楼（点击移除）'));
    const listBox = document.createElement('div');
    listBox.style.cssText = 'max-height:150px;overflow:auto;margin-top:4px;';
    box.appendChild(listBox);

    function renderList() {
      listBox.innerHTML = '';
      const mine = [...rendered.values()].filter((e) => e.mine);
      if (!mine.length) {
        const e = document.createElement('div'); e.textContent = '（暂无）'; e.style.cssText = 'color:#667;';
        listBox.appendChild(e); return;
      }
      mine.forEach((e) => {
        const r = document.createElement('div');
        r.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:2px 0;';
        const labelEl = document.createElement('span');
        labelEl.textContent = (findItem(e.rec.itemId)?.name || e.rec.itemId) + ` (${e.rec.x | 0},${e.rec.z | 0})`;
        labelEl.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        const del = document.createElement('button');
        del.textContent = '移除';
        del.style.cssText = 'background:#a33;color:#fff;border:0;border-radius:4px;padding:2px 8px;cursor:pointer;';
        del.addEventListener('click', () => network.sendBuildDel(e.rec.id));
        r.appendChild(labelEl); r.appendChild(del);
        listBox.appendChild(r);
      });
    }

    // 刷新素材下拉：只列「已买且还有额度」的教学楼
    function refreshSel() {
      const profile = getProfile();
      const items = getCatalog().filter((it) => it.kind === 'building');
      sel.innerHTML = '';
      let any = false;
      for (const it of items) {
        const avail = profile ? unplacedCount(profile, it.id) : 0;
        if (avail <= 0) continue;
        any = true;
        const o = document.createElement('option');
        o.value = it.id;
        o.textContent = `${it.name}（剩 ${avail}）`;
        sel.appendChild(o);
      }
      if (!any) {
        const o = document.createElement('option'); o.value = ''; o.textContent = '（先在商店买教学楼）';
        sel.appendChild(o);
        state.itemId = null;
      } else if (!state.itemId || !getCatalog().some((it) => it.id === state.itemId && (profile ? unplacedCount(profile, it.id) : 0) > 0)) {
        state.itemId = sel.value || null;
      }
      hint.textContent = any ? '选好楼 → 拾取位置 → 摆出' : '去商店买教学楼后才能摆（消耗式：买1栋摆1栋）';
      resetGhost();
    }
    state._refreshSel = refreshSel;
    state._renderList = renderList;
    // 初次填充
    refreshSel();
  }

  function slider(parent, txt, min, max, step, val, onInput) {
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:8px;';
    const lab = document.createElement('span'); lab.style.cssText = 'color:#c7d0da;flex:1;'; lab.textContent = txt;
    const valEl = document.createElement('span'); valEl.style.cssText = 'color:#ffd479;';
    head.appendChild(lab); head.appendChild(valEl);
    const s = document.createElement('input');
    s.type = 'range'; s.style.cssText = 'width:100%;accent-color:#4aa3ff;margin:2px 0;';
    s.min = String(min); s.max = String(max); s.step = String(step); s.value = String(val);
    valEl.textContent = String(val);
    s.addEventListener('input', () => { const v = parseFloat(s.value); valEl.textContent = v.toFixed(2); onInput(v); });
    const el = document.createElement('div'); el.style.cssText = 'margin-top:6px;';
    el.appendChild(head); el.appendChild(s); parent.appendChild(el);
    return { s, valEl };
  }
  function numField(parent, txt) {
    const d = document.createElement('div');
    d.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:6px;';
    const lab = document.createElement('span'); lab.textContent = txt; lab.style.cssText = 'color:#c7d0da;width:18px;';
    const input = document.createElement('input');
    input.style.cssText = 'flex:1;background:#222;color:#fff;border:1px solid #444;border-radius:4px;padding:2px 6px;';
    input.type = 'number'; input.min = '-24'; input.max = '24'; input.step = '0.1';
    d.appendChild(lab); d.appendChild(input); parent.appendChild(d);
    input.addEventListener('change', () => {
      const v = parseFloat(input.value);
      if (!Number.isNaN(v)) { if (txt === 'X') state.x = THREE.MathUtils.clamp(v, -CLAMP, CLAMP); else state.z = THREE.MathUtils.clamp(v, -CLAMP, CLAMP); positionGhost(); }
    });
    return { input };
  }
  function sectionLabel(t) { const d = document.createElement('div'); d.textContent = t; d.style.cssText = 'color:#c7d0da;margin-top:8px;'; return d; }
  function mkBtn(t, color) {
    const b = document.createElement('button'); b.textContent = t;
    b.style.cssText = `flex:1;padding:6px 0;border:0;border-radius:4px;cursor:pointer;background:${color};color:#fff;`;
    return b;
  }

  // ---------- 开关 ----------
  function setActive(v) {
    state.active = v;
    window.__BUILD_TOOL_ACTIVE__ = v;
    state.pick = false;
    panel.style.display = v ? 'block' : 'none';
    toggleBtn.style.background = v ? 'rgba(42,111,95,.95)' : 'rgba(15,15,15,.85)';
    if (v) { state._refreshSel && state._refreshSel(); resetGhost(); }
    else { if (document.exitPointerLock) document.exitPointerLock(); if (state.ghost) { scene.remove(state.ghost); state.ghost = null; } }
  }
  toggleBtn.addEventListener('click', () => setActive(!state.active));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'b' || e.key === 'B') setActive(!state.active);
  });

  domElement.addEventListener('mousemove', onMouseMove);
  domElement.addEventListener('mousedown', onMouseDown);

  fetchAll();

  return {
    state,
    setActive,
    toggle: () => setActive(!state.active),
    handleBuild,
    // 登录/目录变化后刷新下拉与已摆列表
    refresh: () => { state._refreshSel && state._refreshSel(); state._renderList && state._renderList(); fetchAll(); },
  };
}
