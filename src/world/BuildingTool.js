// 职责：地图建筑放置工具。可导入 GLB 模型、从内置素材中选择，缩放/旋转/调整高度、拾取位置，
// 应用到地图；被放置的物件持久化到 localStorage，刷新后仍在。用 B 键或角落按钮开关。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { instantiate } from './AssetLoader.js';

const DEG = Math.PI / 180;
const STORE_KEY = 'city.buildings.v1';
const CLAMP = 24; // 放置区域钳制在 ±24（地面尺寸 50，半径 25）
const MAX_PERSIST = 1_800_000; // 导入模型 base64 超过该字节数不持久化

// 内置可选素材（文件名来自 /assets）
const BUILTINS = [
  'building-small-a.glb',
  'building-small-b.glb',
  'building-small-c.glb',
  'building-small-d.glb',
  'building-garage.glb',
  'watertower.glb',
  'fountain.glb',
  'bench.glb',
  'lamp.glb',
  'tree.glb',
  'bush.glb',
];

let _gltfLoader = null;
function gltfLoader() {
  if (!_gltfLoader) _gltfLoader = new GLTFLoader();
  return _gltfLoader;
}

// initBuildingTool(scene, camera, domElement)：挂载工具，返回开关句柄。
export function initBuildingTool(scene, camera, domElement) {
  const placedGroup = new THREE.Group();
  placedGroup.name = 'placed-buildings';
  scene.add(placedGroup);

  const raycaster = new THREE.Raycaster();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const ndc = new THREE.Vector2();
  const hit = new THREE.Vector3();

  const state = {
    active: false,
    pick: false,
    sourceUrl: BUILTINS[0],
    customBin: null, // {name, arrayBuffer} 导入模型
    customScene: null, // 导入模型解析后的 scene（预览用）
    scale: 1,
    rotY: 0,
    yOff: 0,
    x: 3,
    z: 3,
    ghost: null,
  };

  // ================= 幽灵模型 =================
  function resetGhost() {
    if (state.ghost) {
      scene.remove(state.ghost);
      state.ghost = null;
    }
    if (!state.active) return;
    state.ghost = new THREE.Group();
    state.ghost.add(makeRing());
    scene.add(state.ghost);

    if (state.customScene) {
      const m = state.customScene.clone(true);
      state.ghost.add(m);
      touchShadowAndProps(m);
    } else if (state.sourceUrl) {
      state.ghost.add(makeFallback());
      instantiate(`/assets/${state.sourceUrl}`)
        .then((m) => {
          if (!state.ghost) return;
          state.ghost.clear();
          state.ghost.add(makeRing());
          state.ghost.add(m);
          touchShadowAndProps(m);
        })
        .catch(() => {});
    }
    syncGhostProps();
    positionGhost();
  }

  function makeRing() {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.55, 0.95, 32),
      new THREE.MeshBasicMaterial({ color: 0x4aa3ff, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    return ring;
  }

  function makeFallback() {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0x4aa3ff, transparent: true, opacity: 0.5 })
    );
    m.position.y = 0.5;
    return m;
  }

  // 仅对新加入的模型内容套用缩放/旋转/离地
  function syncGhostProps() {
    if (!state.ghost) return;
    state.ghost.scale.setScalar(state.scale);
    state.ghost.rotation.y = state.rotY * DEG;
    // 内容整体离地：通过一个子容器
    let inner = state.ghost.userData.inner;
    if (!inner) {
      // ghost 第一个子节点是 ring，将其余都包进 inner
      inner = new THREE.Group();
      state.ghost.userData.inner = inner;
      const kids = state.ghost.children.slice(1);
      for (const k of kids) inner.add(k);
      state.ghost.clear();
      state.ghost.add(makeRing());
      state.ghost.add(inner);
    }
    inner.position.y = state.yOff;
    // 重新把缩放/旋转套给 inner（scale/rotation 应用在 ghost 上）
    for (const c of state.ghost.children) {
      if (c === state.ghost.userData.inner) continue;
      c.scale.set(1, 1, 1);
      c.rotation.set(0, 0, 0);
    }
    state.ghost.scale.setScalar(state.scale);
    state.ghost.rotation.y = state.rotY * DEG;
  }

  function positionGhost() {
    if (state.ghost) state.ghost.position.set(state.x, 0, state.z);
  }

  function touchShadowAndProps(m) {
    m.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
  }

  // ================= 应用到地图 =================
  function place() {
    if (state.customScene) {
      const m = state.customScene.clone(true);
      m.scale.setScalar(state.scale);
      m.rotation.y = state.rotY * DEG;
      m.position.set(state.x, state.yOff, state.z);
      touchShadowAndProps(m);
      placedGroup.add(m);
      persistBuiltinOrImport({ kind: 'import', name: state.customBin.name, data: arrayBufferToDataUrl(state.customBin.arrayBuffer) });
    } else if (state.sourceUrl) {
      instantiate(`/assets/${state.sourceUrl}`)
        .then((m) => {
          m.scale.setScalar(state.scale);
          m.rotation.y = state.rotY * DEG;
          m.position.set(state.x, state.yOff, state.z);
          touchShadowAndProps(m);
          placedGroup.add(m);
          persistBuiltinOrImport({ kind: 'builtin', url: state.sourceUrl });
        })
        .catch(() => {});
    }
    renderList();
  }

  // ---------- 持久化 ----------
  function loadList() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function persistBuiltinOrImport(desc) {
    if (desc.data && desc.data.length > MAX_PERSIST) {
      console.warn('[BuildingTool] 模型过大，未持久化（刷新后会消失）:', desc.name);
      return;
    }
    const list = loadList();
    list.push({
      kind: desc.kind,
      ...(desc.kind === 'builtin' ? { url: desc.url } : { name: desc.name, data: desc.data }),
      x: Math.round(state.x * 100) / 100,
      y: Math.round(state.yOff * 100) / 100,
      z: Math.round(state.z * 100) / 100,
      scale: state.scale,
      rotY: state.rotY,
    });
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
  }

  function arrayBufferToDataUrl(ab) {
    const bytes = new Uint8Array(ab);
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return 'data:model/gltf-binary;base64,' + btoa(bin);
  }

  function dataUrlToArrayBuffer(dataUrl) {
    const b64 = dataUrl.split(',')[1];
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  // 从持久化列表恢复
  function restore() {
    const list = loadList();
    for (const it of list) {
      const apply = (m) => {
        m.scale.setScalar(it.scale ?? 1);
        m.position.set(it.x ?? 0, it.y ?? 0, it.z ?? 0);
        if (it.rotY) m.rotation.y = it.rotY * DEG;
        touchShadowAndProps(m);
        placedGroup.add(m);
      };
      if (it.kind === 'builtin') {
        instantiate(`/assets/${it.url}`).then(apply).catch(() => {});
      } else if (it.kind === 'import' && it.data) {
        gltfLoader().parse(dataUrlToArrayBuffer(it.data), '', (m) => apply(m.scene ?? m)).catch(() => {});
      }
    }
    renderList();
  }

  // ================= 位置拾取 =================
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
    if (p) {
      state.x = THREE.MathUtils.clamp(p.x, -CLAMP, CLAMP);
      state.z = THREE.MathUtils.clamp(p.z, -CLAMP, CLAMP);
      positionGhost();
      syncFields();
    }
  }

  function onMouseDown(e) {
    if (!state.active || !state.pick || !state.ghost) return;
    e.preventDefault();
    e.stopPropagation();
    const p = pointerOnGround(e.clientX, e.clientY);
    if (p) {
      state.x = THREE.MathUtils.clamp(p.x, -CLAMP, CLAMP);
      state.z = THREE.MathUtils.clamp(p.z, -CLAMP, CLAMP);
      positionGhost();
      syncFields();
      place();
    }
  }

  // ================= UI 控件 =================
  // 返回 {label, value, slider, box} 的行
  function row(box) {
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:8px;';
    const lab = document.createElement('span');
    lab.style.cssText = 'color:#c7d0da;flex:1;';
    const val = document.createElement('span');
    val.style.cssText = 'color:#ffd479;';
    head.appendChild(lab);
    head.appendChild(val);
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.style.cssText = 'width:100%;accent-color:#4aa3ff;margin:2px 0;';
    const el = document.createElement('div');
    el.style.cssText = 'margin-top:6px;';
    el.appendChild(head);
    el.appendChild(slider);
    if (box) box.appendChild(el);
    return { lab, val, slider, el };
  }

  // 面板
  const toggleBtn = document.createElement('button');
  toggleBtn.textContent = '建筑工具 (B)';
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
    title.textContent = '地图建筑放置工具';
    title.style.cssText = 'font-weight:bold;margin-bottom:6px;';
    box.appendChild(title);

    // 素材下拉
    const sel = document.createElement('select');
    sel.style.cssText = 'width:100%;background:#222;color:#fff;border:1px solid #444;border-radius:4px;';
    BUILTINS.forEach((u) => {
      const o = document.createElement('option');
      o.value = u;
      o.textContent = u.replace('.glb', '');
      sel.appendChild(o);
    });
    box.appendChild(sel);
    sel.addEventListener('change', () => {
      state.sourceUrl = sel.value;
      state.customScene = null;
      resetGhost();
    });

    // 导入
    const importLab = document.createElement('label');
    importLab.textContent = '导入 GLB 模型（本地文件）';
    importLab.style.cssText = 'display:block;text-align:center;margin:6px 0;background:#2b6f5f;color:#fff;' +
      'padding:6px 0;border-radius:4px;cursor:pointer;';
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.glb,.gltf';
    fileInput.style.cssText = 'display:none;';
    importLab.appendChild(fileInput);
    box.appendChild(importLab);
    fileInput.addEventListener('change', () => {
      const f = fileInput.files[0];
      if (!f) return;
      const url = URL.createObjectURL(f);
      f.arrayBuffer().then((ab) => {
        state.customBin = { name: f.name.replace(/\.(glb|gltf)$/i, ''), arrayBuffer: ab };
      });
      gltfLoader().load(url, (gltf) => {
        state.customScene = gltf.scene;
        sel.selectedIndex = -1;
        resetGhost();
      });
    });

    // 缩放 / 旋转 / 高度
    const sc = row(box);
    sc.lab.textContent = '缩放';
    sc.slider.min = '0.1'; sc.slider.max = '6'; sc.slider.step = '0.05'; sc.slider.value = '1';
    sc.slider.addEventListener('input', () => { state.scale = parseFloat(sc.slider.value); sc.val.textContent = state.scale.toFixed(2); resetGhost(); });

    const rot = row(box);
    rot.lab.textContent = '旋转 (°)';
    rot.slider.min = '0'; rot.slider.max = '360'; rot.slider.step = '1'; rot.slider.value = '0';
    rot.slider.addEventListener('input', () => { state.rotY = parseFloat(rot.slider.value); rot.val.textContent = state.rotY.toFixed(0); resetGhost(); });

    const yo = row(box);
    yo.lab.textContent = '离地高度';
    yo.slider.min = '-1'; yo.slider.max = '4'; yo.slider.step = '0.05'; yo.slider.value = '0';
    yo.slider.addEventListener('input', () => { state.yOff = parseFloat(yo.slider.value); yo.val.textContent = state.yOff.toFixed(2); resetGhost(); });

    // 坐标
    const xr = numField(box, 'X', () => positionGhost());
    const zr = numField(box, 'Z', () => positionGhost());

    // 按钮行
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;margin-top:10px;';
    const pickBtn = mkBtn('鼠标拾取位置', '#4aa3ff');
    const placeBtn = mkBtn('应用到地图', '#2b6f5f');
    const clearBtn = mkBtn('清空全部', '#a33');
    btnRow.appendChild(pickBtn);
    btnRow.appendChild(placeBtn);
    btnRow.appendChild(clearBtn);
    box.appendChild(btnRow);

    pickBtn.addEventListener('click', () => {
      state.pick = !state.pick;
      pickBtn.textContent = state.pick ? '停止拾取' : '鼠标拾取位置';
      if (state.pick && document.exitPointerLock) document.exitPointerLock();
    });
    placeBtn.addEventListener('click', () => place());
    clearBtn.addEventListener('click', () => {
      placedGroup.clear();
      localStorage.removeItem(STORE_KEY);
      renderList();
    });

    box.appendChild(sectionLabel('已放置物件（点击移除）'));
    const listBox = document.createElement('div');
    listBox.style.cssText = 'max-height:150px;overflow:auto;margin-top:4px;';
    box.appendChild(listBox);

    function renderList() {
      listBox.innerHTML = '';
      const list = loadList();
      if (list.length === 0) {
        const e = document.createElement('div');
        e.textContent = '（暂无）';
        e.style.cssText = 'color:#667;';
        listBox.appendChild(e);
        return;
      }
      list.forEach((it, i) => {
        const r = document.createElement('div');
        r.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:2px 0;';
        const labelEl = document.createElement('span');
        labelEl.textContent = `${i + 1}. ${it.kind === 'builtin' ? it.url.replace('.glb', '') : (it.name || '导入')} (${it.x},${it.z})`;
        labelEl.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        const del = document.createElement('button');
        del.textContent = '移除';
        del.style.cssText = 'background:#a33;color:#fff;border:0;border-radius:4px;padding:2px 8px;cursor:pointer;';
        del.addEventListener('click', () => {
          const nl = list.slice(0, i).concat(list.slice(i + 1));
          localStorage.setItem(STORE_KEY, JSON.stringify(nl));
          placedGroup.clear();
          restore();
        });
        r.appendChild(labelEl);
        r.appendChild(del);
        listBox.appendChild(r);
      });
      sc.val.textContent = state.scale.toFixed(2);
      rot.val.textContent = state.rotY.toFixed(0);
      yo.val.textContent = state.yOff.toFixed(2);
    }

    function syncFields() {
      xr.input.value = state.x.toFixed(2);
      zr.input.value = state.z.toFixed(2);
    }
    // 暴露给 state
    state.renderList = renderList;
    state.syncFields = syncFields;
    state.setPanelDisplay = (v) => { panel.style.display = v ? 'block' : 'none'; };
  }

  // 辅助：数值输入
  function numField(parent, txt, onCommit) {
    const d = document.createElement('div');
    d.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:6px;';
    const lab = document.createElement('span');
    lab.textContent = txt;
    lab.style.cssText = 'color:#c7d0da;width:18px;';
    const input = document.createElement('input');
    input.style.cssText = 'flex:1;background:#222;color:#fff;border:1px solid #444;border-radius:4px;padding:2px 6px;';
    input.type = 'number';
    input.min = '-24';
    input.max = '24';
    input.step = '0.1';
    d.appendChild(lab);
    d.appendChild(input);
    parent.appendChild(d);
    input.addEventListener('change', () => {
      const v = parseFloat(input.value);
      if (!Number.isNaN(v) && txt === 'X') state.x = THREE.MathUtils.clamp(v, -CLAMP, CLAMP);
      if (!Number.isNaN(v) && txt === 'Z') state.z = THREE.MathUtils.clamp(v, -CLAMP, CLAMP);
      positionGhost();
      onCommit();
    });
    return { input };
  }

  function sectionLabel(txt) {
    const d = document.createElement('div');
    d.textContent = txt;
    d.style.cssText = 'color:#c7d0da;margin-top:8px;';
    return d;
  }

  function mkBtn(txt, color) {
    const b = document.createElement('button');
    b.textContent = txt;
    b.style.cssText = `flex:1;padding:6px 0;border:0;border-radius:4px;cursor:pointer;background:${color};color:#fff;`;
    return b;
  }

  // ================= 开关 =================
  function setActive(v) {
    state.active = v;
    window.__BUILD_TOOL_ACTIVE__ = v;
    state.pick = false;
    panel.style.display = v ? 'block' : 'none';
    toggleBtn.style.background = v ? 'rgba(42,111,95,.95)' : 'rgba(15,15,15,.85)';
    if (v) {
      state.renderList();
      resetGhost();
    } else {
      if (document.exitPointerLock) document.exitPointerLock();
      if (state.ghost) {
        scene.remove(state.ghost);
        state.ghost = null;
      }
    }
  }

  toggleBtn.addEventListener('click', () => setActive(!state.active));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'b' || e.key === 'B') setActive(!state.active);
  });

  domElement.addEventListener('mousemove', onMouseMove);
  domElement.addEventListener('mousedown', onMouseDown);

  restore();

  return { state, setActive, toggle: () => setActive(!state.active) };
}