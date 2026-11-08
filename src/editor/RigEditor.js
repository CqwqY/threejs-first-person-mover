// 职责：编辑器「骨骼」页签的核心 —— 按 boy/girl 分别校准程序化绑骨的 bind-pose 坐标。
// 背景：tools/auto-rig.mjs 原来把同一套 BONE_DEF 套在两个性别上，而 girl 的左右(Z)跨度比 boy 窄约 7%，
//       骨骼自然对不准手脚。这里把坐标做成可视化、可按性别独立编辑的配置，导出后由 auto-rig.mjs 重烘焙。
//
// 预览方式：加载**未绑骨**的原始 ${gender}.glb，把 17 个骨骼点(球)与父子连线直接叠在模型上。
//           可视化是独立网格，不碰 SkinnedMesh / 骨骼权重，所以拖动数值不会让模型变形。
//           骨骼点与模型同父节点（原始 GLB 的 mesh node 无变换），坐标系与 auto-rig.mjs 读的顶点坐标一致。
//
// 坐标约定（与 auto-rig.mjs 一致）：mesh 局部空间，模型 y∈[-0.5,0.5]，
//   X = 前后（正面 +X），Z = 左右（±Z），Y = 高度。改坐标前先看清这个，别按常识当成 X 是左右。
import * as THREE from 'three';
import { instantiate } from '../world/AssetLoader.js';
import defaultPresets from '../player/rigPresets.json';

const STORE_KEY = 'fpm-rig-presets-v1';
const PREVIEW_SCALE = 2.5;   // 原始模型只有 1 单位高，放大到 2.5m 便于对齐观察
const BOY_SPAN_Z = 0.8618;   // boy.glb 实测左右跨度，自动适配的基准
const GENDERS = ['boy', 'girl'];

function cloneBones(bones) {
  return bones.map((b) => [b[0], b[1], [Number(b[2][0]), Number(b[2][1]), Number(b[2][2])]]);
}

function clonePresets(p) {
  const out = {};
  for (const g of GENDERS) {
    out[g] = {
      bones: cloneBones(p[g].bones),
      anims: p[g].anims.map((a) => ({ ...a })),
    };
  }
  return out;
}

// 导入 / localStorage 来的数据必须完整校验，缺一根骨就会让 auto-rig 的 JOINTS 索引错位。
function validPresets(p) {
  if (!p || typeof p !== 'object') return false;
  for (const g of GENDERS) {
    const cfg = p[g];
    if (!cfg || !Array.isArray(cfg.bones) || cfg.bones.length !== defaultPresets[g].bones.length) return false;
    if (!Array.isArray(cfg.anims) || cfg.anims.length !== defaultPresets[g].anims.length) return false;
    for (const b of cfg.bones) {
      if (!Array.isArray(b) || typeof b[0] !== 'string' || !(b[1] === null || typeof b[1] === 'string')) return false;
      if (!Array.isArray(b[2]) || b[2].length !== 3 || b[2].some((v) => !Number.isFinite(Number(v)))) return false;
    }
    for (const a of cfg.anims) {
      if (!a || typeof a.name !== 'string' || ['period', 'A', 'A2', 'A3'].some((k) => !Number.isFinite(a[k]))) return false;
    }
  }
  return true;
}

function loadPresets() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (validPresets(p)) return p;
      console.warn('[rig] 本地缓存的骨骼配置不完整，改用仓库默认配置');
    }
  } catch (e) {
    console.warn('[rig] 读本地骨骼配置失败，改用仓库默认配置：', e);
  }
  return clonePresets(defaultPresets);
}

export function createRigEditor({ scene, camera, controls }) {
  const $ = (id) => document.getElementById(id);
  const el = {
    gender: $('rigGender'), bone: $('rigBone'),
    x: $('rigX'), y: $('rigY'), z: $('rigZ'),
    scaleZ: $('rigScaleZ'), scaleY: $('rigScaleY'), offsetY: $('rigOffsetY'),
    showMesh: $('rigShowMesh'), status: $('rigStatus'), boneInfo: $('rigBoneInfo'),
    btnFocus: $('rigBtnFocus'), btnAutoFit: $('rigBtnAutoFit'), btnCopy: $('rigBtnCopyOther'),
    btnReset: $('rigBtnReset'), btnSave: $('rigBtnSave'), btnExport: $('rigBtnExport'),
    file: $('rigFile'),
  };

  let presets = loadPresets();
  let gender = 'boy';
  let baseline = cloneBones(presets[gender].bones); // 已固化的骨骼（滑块以此为基准，避免连续拖动累积误差）
  let working = cloneBones(baseline);
  let sel = 0;
  let active = false;

  // ---------- 场景对象 ----------
  const holder = new THREE.Group();          // 整体缩放 + 定位
  holder.scale.setScalar(PREVIEW_SCALE);
  holder.visible = false;
  // 预览模型不能被动到材质：applyBackfaceCulling 会把 DoubleSide 收敛成单面，
  // 而 glTF 导出的人物网格绕向未必可靠，收敛后可能整只消失。整棵子树排除。
  holder.userData.noCull = true;
  scene.add(holder);
  const modelCache = new Map();              // gender -> root；切换只 add/remove，不 dispose（clone 共享 geometry/material）
  let modelRoot = null;
  const bonesGroup = new THREE.Group();
  // 先挂在 holder 上：模型是异步加载的，否则加载完成前骨骼点一个都看不到，像面板坏了。
  // 模型就绪后 attachBonesToModel() 会把它移进 mesh 的父节点，保证与顶点同一坐标系。
  holder.add(bonesGroup);
  bonesGroup.renderOrder = 999;
  const jointGeo = new THREE.SphereGeometry(0.014, 10, 8);
  const matLeft = new THREE.MeshBasicMaterial({ color: 0x4aa3ff, depthTest: false });
  const matRight = new THREE.MeshBasicMaterial({ color: 0xff7a7a, depthTest: false });
  const matMid = new THREE.MeshBasicMaterial({ color: 0xffd479, depthTest: false });
  const matSel = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false });
  const joints = [];
  const lineMat = new THREE.LineBasicMaterial({ color: 0x9fe0a8, depthTest: false, transparent: true, opacity: 0.9 });
  let lines = null;

  let camBackup = null;
  const focusPoint = new THREE.Vector3();

  function setStatus(text, ok = true) {
    if (!el.status) return;
    el.status.textContent = text;
    el.status.style.color = ok ? '#9fe0a8' : '#ff9a9a';
  }

  function saveLocal() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(presets));
    } catch (e) {
      console.warn('[rig] 写本地缓存失败：', e);
      setStatus('本地缓存写入失败（改动仍在本次会话有效）', false);
    }
  }

  function commit() {
    // 把滑块变换后的结果固化，并复位滑块。之后手工改单骨也是直接改 baseline。
    baseline = cloneBones(working);
    presets[gender].bones = cloneBones(working);
    if (el.scaleZ) el.scaleZ.value = '1';
    if (el.scaleY) el.scaleY.value = '1';
    if (el.offsetY) el.offsetY.value = '0';
    saveLocal();
    refreshViz();
  }

  function applyTransforms() {
    const kz = Number(el.scaleZ ? el.scaleZ.value : 1) || 1;
    const ky = Number(el.scaleY ? el.scaleY.value : 1) || 1;
    const oy = Number(el.offsetY ? el.offsetY.value : 0) || 0;
    working = baseline.map((b) => [b[0], b[1], [b[2][0], b[2][1] * ky + oy, b[2][2] * kz]]);
    refreshViz();
  }

  function buildBoneSelect() {
    if (!el.bone) return;
    el.bone.innerHTML = '';
    for (let i = 0; i < working.length; i++) {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = i + ' · ' + working[i][0];
      el.bone.appendChild(o);
    }
    el.bone.value = String(Math.min(sel, working.length - 1));
  }

  function refreshInputs() {
    const b = working[sel];
    if (!b) return;
    if (el.x) el.x.value = b[2][0].toFixed(4);
    if (el.y) el.y.value = b[2][1].toFixed(4);
    if (el.z) el.z.value = b[2][2].toFixed(4);
    if (el.boneInfo) el.boneInfo.textContent = '父骨：' + (b[1] || '（根）') + ' · X=前后 Z=左右 Y=高度';
  }

  // 重建 17 个球 + 父子连线；点很少，直接重建最省心也最不容易出错。
  function refreshViz() {
    while (joints.length < working.length) {
      const m = new THREE.Mesh(jointGeo, matMid);
      m.renderOrder = 1000;
      joints.push(m);
      bonesGroup.add(m);
    }
    for (let i = 0; i < joints.length; i++) {
      const j = joints[i];
      j.visible = i < working.length;
      if (!j.visible) continue;
      j.position.set(working[i][2][0], working[i][2][1], working[i][2][2]);
      j.scale.setScalar(i === sel ? 1.9 : 1);
      const name = working[i][0];
      j.material = i === sel ? matSel : (name.startsWith('l_') ? matLeft : (name.startsWith('r_') ? matRight : matMid));
    }
    if (lines) { bonesGroup.remove(lines); lines.geometry.dispose(); }
    const pts = [];
    for (let i = 0; i < working.length; i++) {
      const par = working[i][1];
      if (!par) continue;
      const pi = working.findIndex((b) => b[0] === par);
      if (pi < 0) continue;
      pts.push(new THREE.Vector3(...working[pi][2]), new THREE.Vector3(...working[i][2]));
    }
    lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), lineMat);
    lines.renderOrder = 999;
    bonesGroup.add(lines);
    refreshInputs();
    if (el.showMesh && modelRoot) modelRoot.visible = el.showMesh.checked;
  }

  function attachBonesToModel(root) {
    // 骨骼点必须与顶点同一坐标系：挂到第一个 Mesh 的父节点下（auto-rig 是把 armature 挂在 meshNode 下）
    let parent = root;
    root.traverse((o) => {
      if (parent === root && o.isMesh) parent = o.parent || root;
    });
    parent.add(bonesGroup);
  }

  function showModel(g) {
    for (const root of modelCache.values()) root.visible = false;
    let root = modelCache.get(g);
    if (root) {
      root.visible = el.showMesh ? el.showMesh.checked : true;
      modelRoot = root;
      attachBonesToModel(root);
      refreshViz();
      return;
    }
    instantiate('/assets/' + g + '.glb').then((obj) => {
      modelCache.set(g, obj);
      holder.add(obj);
      // 加载期间用户可能已经切到另一个性别：先隐藏，只有仍是当前性别才显示，避免两个模型叠在一起
      obj.visible = false;
      if (active && gender === g) {
        obj.visible = el.showMesh ? el.showMesh.checked : true;
        modelRoot = obj;
        attachBonesToModel(obj);
        refreshViz();
        setStatus('已加载 ' + g + '.glb，绿色连线=骨骼层级，白球=当前选中骨');
      }
    }).catch((e) => {
      // 模型加载失败必须出声：静默的话用户会对着一个没有模型的坐标系调半天
      console.warn('[rig] 加载 ' + g + '.glb 失败：', e);
      setStatus('加载 ' + g + '.glb 失败，骨骼点仍可编辑但看不到模型', false);
    });
  }

  function switchGender(g) {
    if (!GENDERS.includes(g)) return;
    gender = g;
    baseline = cloneBones(presets[g].bones);
    working = cloneBones(baseline);
    sel = Math.min(sel, working.length - 1);
    if (el.gender) el.gender.value = g;
    if (el.scaleZ) el.scaleZ.value = '1';
    if (el.scaleY) el.scaleY.value = '1';
    if (el.offsetY) el.offsetY.value = '0';
    buildBoneSelect();
    // 异步加载期间不要让 refreshViz 把上一个性别的模型重新显示出来
    modelRoot = null;
    showModel(g);
    refreshViz();
  }

  function focusCamera() {
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    dir.y = 0;
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
    dir.normalize();
    focusPoint.set(holder.position.x, holder.position.y + PREVIEW_SCALE * 0.5, holder.position.z);
    camera.position.set(focusPoint.x - dir.x * 4, focusPoint.y + 0.7, focusPoint.z - dir.z * 4);
    controls.target.copy(focusPoint);
    controls.update();
  }

  function activate() {
    if (active) return;
    active = true;
    camBackup = { pos: camera.position.clone(), target: controls.target.clone() };
    // 把预览放在当前视点前方，避免被城市建筑挡住；退出时恢复原机位
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    dir.y = 0;
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
    dir.normalize();
    holder.position.copy(controls.target).addScaledVector(dir, 3);
    holder.position.y = 0;
    holder.visible = true;
    buildBoneSelect();
    switchGender(gender);
    focusCamera();
    setStatus('调完点「保存到本机」；要让游戏生效需写入项目文件并重烘焙');
  }

  function deactivate() {
    if (!active) return;
    active = false;
    holder.visible = false;
    if (camBackup) {
      camera.position.copy(camBackup.pos);
      controls.target.copy(camBackup.target);
      controls.update();
      camBackup = null;
    }
  }

  // ---------- 面板事件 ----------
  if (el.gender) el.gender.onchange = () => switchGender(el.gender.value);
  if (el.bone) el.bone.onchange = () => {
    sel = Math.max(0, Math.min(working.length - 1, Number(el.bone.value) || 0));
    refreshViz();
  };
  for (const [input, axis] of [[el.x, 0], [el.y, 1], [el.z, 2]]) {
    if (!input) continue;
    input.onchange = () => {
      const v = Number(input.value);
      if (!Number.isFinite(v)) { refreshInputs(); return; }
      working[sel][2][axis] = v;
      commit();
      setStatus('已改 ' + working[sel][0] + ' 的 ' + ['X', 'Y', 'Z'][axis] + '，记得保存并重烘焙');
    };
  }
  for (const input of [el.scaleZ, el.scaleY, el.offsetY]) {
    if (!input) continue;
    input.oninput = applyTransforms;   // 实时预览
    input.onchange = commit;           // 松手固化，避免连续拖动累积
  }
  if (el.showMesh) el.showMesh.onchange = () => { if (modelRoot) modelRoot.visible = el.showMesh.checked; };
  if (el.btnFocus) el.btnFocus.onclick = focusCamera;

  if (el.btnAutoFit) el.btnAutoFit.onclick = () => {
    if (!modelRoot) { setStatus('模型还没加载完，稍等一下再点', false); return; }
    // 用顶点几何的局部 AABB，不用 setFromObject：后者会把叠加的骨骼球和外层缩放一起算进去，比例会偏。
    // 原始 boy/girl.glb 都只有一个 mesh 节点且无变换，局部 AABB 就是 auto-rig.mjs 读到的顶点范围。
    let bb = null;
    modelRoot.traverse((o) => {
      if (!bb && o.isMesh && o.geometry) {
        o.geometry.computeBoundingBox();
        bb = o.geometry.boundingBox;
      }
    });
    if (!bb) { setStatus('找不到模型几何，自动适配取消', false); return; }
    const sz = bb.max.z - bb.min.z;
    const sy = bb.max.y - bb.min.y;
    if (!Number.isFinite(sz) || !Number.isFinite(sy) || sz <= 0 || sy <= 0) {
      setStatus('量不到模型尺寸，自动适配取消', false);
      return;
    }
    const kz = sz / BOY_SPAN_Z;
    const ky = sy / 1.0;
    working = baseline.map((b) => [b[0], b[1], [b[2][0], b[2][1] * ky, b[2][2] * kz]]);
    commit();
    setStatus('按模型 AABB 适配完成：左右 ×' + kz.toFixed(3) + '，高度 ×' + ky.toFixed(3));
  };

  if (el.btnCopy) el.btnCopy.onclick = () => {
    const other = GENDERS.find((g) => g !== gender);
    working = cloneBones(presets[other].bones);
    commit();
    setStatus('已把 ' + other + ' 的骨骼复制到 ' + gender);
  };

  if (el.btnReset) el.btnReset.onclick = () => {
    working = cloneBones(defaultPresets[gender].bones);
    commit();
    setStatus('已恢复 ' + gender + ' 的仓库默认值（还要保存才写进配置）');
  };

  if (el.btnSave) el.btnSave.onclick = async () => {
    presets[gender].bones = cloneBones(working);
    saveLocal();
    // dev(vite) 有同源写盘接口；线上 Pages 没有，静默降级成「请导出 JSON」的提示，不假装成功
    try {
      const r = await fetch('/api/rig-presets', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(presets),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      await r.json();
      setStatus('已写入 src/player/rigPresets.json（接着跑 node tools/auto-rig.mjs 重烘焙）');
    } catch (e) {
      console.warn('[rig] 写项目文件不可用（线上编辑器常见）：', e);
      setStatus('已存到本机浏览器；线上编辑器无法写项目文件，请点「导出 JSON」覆盖 src/player/rigPresets.json', false);
    }
  };

  if (el.btnExport) el.btnExport.onclick = () => {
    presets[gender].bones = cloneBones(working);
    saveLocal();
    const blob = new Blob([JSON.stringify(presets, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'rigPresets.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    setStatus('已导出 rigPresets.json，覆盖 src/player/rigPresets.json 后重烘焙');
  };

  if (el.file) el.file.onchange = () => {
    const f = el.file.files && el.file.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const p = JSON.parse(String(reader.result));
        if (!validPresets(p)) throw new Error('结构不完整（需 boy/girl 各 17 骨 + 3 段动画）');
        presets = p;
        switchGender(gender);
        saveLocal();
        setStatus('导入成功，记得保存并重烘焙');
      } catch (e) {
        console.warn('[rig] 导入配置失败：', e);
        setStatus('导入失败：' + e.message, false);
      }
      el.file.value = '';
    };
    reader.onerror = () => {
      console.warn('[rig] 读取配置文件失败');
      setStatus('读取文件失败', false);
      el.file.value = '';
    };
    reader.readAsText(f);
  };

  return {
    activate,
    deactivate,
    get active() { return active; },
    get gender() { return gender; },
  };
}
