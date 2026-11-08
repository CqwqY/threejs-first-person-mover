// 程序化自绑骨脚本：直接对带贴图的原 GLB（boy.glb / girl.glb）做手术，
// 不加任何外部骨骼/动画源（不用 Mixamo、不用 Soldier 重定向），从根上避免"网格↔骨骼坐标系不匹配"。
//
// 做法：
//  - 原 GLB 的 BIN chunk（含贴图/UV/法线/索引）一字不动，只在尾部追加 JOINTS_0 / WEIGHTS_0 /
//    inverseBindMatrices / 骨架节点 / 动画 → 贴图 100% 保真（不依赖 Node 解码贴图，也不走 GLTFExporter 重排）。
//  - 骨架基于 AABB 程序化放置（模型已归一化到 y∈[-0.5,0.5]）。⚠ 原始网格是 **T-pose**（手臂沿 ±Z 水平张开），
//    而游戏里要的是手臂自然下垂（A-pose）。关键：GLTF 蒙皮在 bind 时 jointMatrix·inverseBind 恒为 I，
//    给骨骼节点加的旋转会被 inverseBind 抵消、显示仍回到网格原样（T-pose）。所以"手臂下垂"不是改 bind pose，
//    而是**烘焙进动画**——上臂/肘的动画旋转以「下垂基旋转」为底座（局部 = swing·drop），人物始终在播
//    Idle/Walk/Run，因此游戏里自然显示 A-pose。网格、BONE_DEF、蒙皮权重仍全部按 T-pose 算，编辑器校准坐标不变。
//    ⚠ 网格朝向（用 tools/probe-axis.mjs 实测 boy-rig）：网格的「左右」是 **Z 轴**（两层腿/脚的 Z 跨度
//      0.256 > X 0.161），「前后」是 **X 轴**（正面朝 +X）。所以骨架的左右/手臂/腿必须摆在 ±Z 上，
//      摆腿也要绕 Z（脚才能沿 X 前后摆）。曾把左右放在 ±X → 骨架相对网格整体差 90°（身子正、走路侧甩）。
//  - 蒙皮权重：每顶点到各骨「线段」距离的倒数，取最近 4 根归一化。
//  - 动画：同坐标系程序化生成 Idle/Walk/Run，绕局部 Z 摆腿（脚沿 X 前后摆）、绕局部 Z 摆臂（反相）、
//    脊柱/头/髋绕 Y 小幅交替摆动。因为骨与动画同坐标系（无 alignM 之类的 90° 重定向），不会出现侧躺/猎奇。
//
// 用法：node tools/auto-rig.mjs [boy girl]
import fs from 'fs';
import * as THREE from '../node_modules/three/build/three.module.js';
globalThis.self = globalThis; // Node 下 THREE 某些路径需要 self

const FLOAT = 5126, USHORT = 5123, UINT = 5125;
const COMPS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

// ---------------- GLB 读写 ----------------
function parseGLB(buf) {
  let off = 12;
  const jsonLen = buf.readUInt32LE(off);
  const json = JSON.parse(buf.toString('utf8', off + 8, off + 8 + jsonLen));
  off += 8 + jsonLen;
  const binLen = buf.readUInt32LE(off);
  const bin = Buffer.from(buf.subarray(off + 8, off + 8 + binLen));
  return { json, bin };
}
function writeGLB(json, bin) {
  json.buffers[0].byteLength = bin.length;
  const jb = Buffer.from(JSON.stringify(json), 'utf8');
  const jPad = (4 - (jb.length % 4)) % 4;
  const bPad = (4 - (bin.length % 4)) % 4;
  const total = 12 + 8 + jb.length + jPad + 8 + bin.length + bPad;
  const out = Buffer.alloc(total);
  out.write('glTF', 0, 'ascii');
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  let o = 12;
  out.writeUInt32LE(jb.length + jPad, o);
  out.write('JSON', o + 4, 'ascii'); o += 8;
  jb.copy(out, o); o += jb.length;
  if (jPad) { out.fill(0x20, o, o + jPad); o += jPad; }
  out.writeUInt32LE(bin.length + bPad, o);
  out.write('BIN\0', o + 4, 'ascii'); o += 8;
  bin.copy(out, o); o += bin.length;
  if (bPad) out.fill(0, o, o + bPad);
  return out;
}
function readF32(json, bin, idx) {
  const acc = json.accessors[idx];
  const bv = json.bufferViews[acc.bufferView];
  const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const n = acc.count * 3;
  const out = new Float32Array(n);
  for (let i = 0; i < acc.count; i++)
    for (let c = 0; c < 3; c++) out[i * 3 + c] = bin.readFloatLE(base + i * 12 + c * 4);
  return out;
}

// ---------------- 骨架定义 ----------------
// 默认骨架（mesh 局部空间绝对 bind-pose 坐标；模型 y∈[-0.5,0.5]）。
// 实际烘焙优先读 src/player/rigPresets.json —— 编辑器「骨骼」页签按 boy/girl 分别编辑的就是它。
// 文件缺失或字段不全时回退到这里，保证命令行单独跑脚本也能出结果。
// 命名不带前缀点号，纯小写+下划线，避免任何解析歧义。
const DEFAULT_BONES = [
  ['hips', null, [0, -0.15, 0]],
  ['spine', 'hips', [0, -0.05, 0]],
  ['chest', 'spine', [0, 0.06, 0]],
  ['neck', 'chest', [0, 0.18, 0]],
  ['head', 'neck', [0, 0.34, 0]],
  ['l_shoulder', 'chest', [0, 0.16, -0.15]],
  ['l_elbow', 'l_shoulder', [0, 0.02, -0.23]],
  ['l_wrist', 'l_elbow', [0, -0.10, -0.25]],
  ['r_shoulder', 'chest', [0, 0.16, 0.15]],
  ['r_elbow', 'r_shoulder', [0, 0.02, 0.23]],
  ['r_wrist', 'r_elbow', [0, -0.10, 0.25]],
  ['l_hip', 'hips', [0, -0.17, -0.09]],
  ['l_knee', 'l_hip', [0, -0.32, -0.10]],
  ['l_ankle', 'l_hip', [0, -0.49, -0.10]],
  ['r_hip', 'hips', [0, -0.17, 0.09]],
  ['r_knee', 'r_hip', [0, -0.32, 0.10]],
  ['r_ankle', 'r_hip', [0, -0.49, 0.10]],
];
const DEFAULT_ANIMS = [
  { name: 'Idle', period: 4.0, A: 0.0, A2: 0.05, A3: 0.03, knee: false },
  { name: 'Walk', period: 1.1, A: 0.38, A2: 0.26, A3: 0.08, knee: true },
  { name: 'Run', period: 0.7, A: 0.72, A2: 0.46, A3: 0.12, knee: true },
];

// 常驻 rest 旋转（绕局部 X 轴的弧度）：把 T-pose 水平手臂转到自然下垂（A-pose）。
// 左臂在 -Z、右臂在 +Z，要落向 -Y，符号相反。80°（非 90°）让手臂略向外张，更像真人 A-pose 而非并拢。
const DEG = Math.PI / 180;
const REST_ROT = {
  l_shoulder: -80 * DEG,
  r_shoulder: 80 * DEG,
  // 肘部轻微常驻前屈，避免直臂贴身体显得僵硬（绕局部 X，前臂略向前）
  l_elbow: 12 * DEG,
  r_elbow: -12 * DEG,
};
function restQuat(name) {
  const a = REST_ROT[name];
  return a ? new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), a) : null;
}

// 按性别取配置：bones 必须是 [name, parent|null, [x,y,z]]，anims 字段齐全才采用。
// ⚠ 这里只校验长度与主字段，坐标数值交给编辑器里的人肉校准（脚本不做猜测式修正）。
function presetsFor(gender) {
  let file = null;
  try {
    file = JSON.parse(fs.readFileSync(new URL('../src/player/rigPresets.json', import.meta.url), 'utf8'));
  } catch (e) {
    console.warn(`[cfg] 读不到 rigPresets.json，${gender} 用内置默认：`, e && e.message);
  }
  const cfg = file && file[gender] ? file[gender] : null;
  const bones = cfg && Array.isArray(cfg.bones) && cfg.bones.length === DEFAULT_BONES.length &&
    cfg.bones.every((b) => Array.isArray(b) && typeof b[0] === 'string' && Array.isArray(b[2]) && b[2].length === 3)
    ? cfg.bones : DEFAULT_BONES;
  const anims = cfg && Array.isArray(cfg.anims) && cfg.anims.length &&
    cfg.anims.every((a) => a && typeof a.name === 'string' &&
      ['period', 'A', 'A2', 'A3'].every((k) => Number.isFinite(a[k])))
    ? cfg.anims : DEFAULT_ANIMS;
  return { bones: bones.map((b) => [b[0], b[1], [Number(b[2][0]), Number(b[2][1]), Number(b[2][2])]]), anims };
}

// 点到「线段 a-b」最近距离（a===b 时退化为点到点）
function distToSeg(p, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const len2 = abx * abx + aby * aby + abz * abz;
  let t = 0;
  if (len2 > 1e-9) {
    t = ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / len2;
    t = Math.max(0, Math.min(1, t));
  }
  const cx = a.x + abx * t, cy = a.y + aby * t, cz = a.z + abz * t;
  const dx = p.x - cx, dy = p.y - cy, dz = p.z - cz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function bake(gender) {
  // boy/girl 各读各的一套骨骼与动画参数（编辑器「骨骼」页签写入 rigPresets.json）
  const cfg = presetsFor(gender);
  const BONE_DEF = cfg.bones;
  const N_BONES = BONE_DEF.length;
  const anims = cfg.anims;
  console.log(`[cfg] ${gender}: bones=${N_BONES}, anims=${anims.length}`);
  const glbPath = `public/assets/${gender}.glb`;
  const outPath = `public/assets/${gender}-rig.glb`;
  console.log(`\n=== ${gender} ===`);
  const { json, bin } = parseGLB(fs.readFileSync(glbPath));
  const prim = json.meshes[0].primitives[0];
  const pos = readF32(json, bin, prim.attributes.POSITION);
  const vCount = pos.length / 3;
  console.log(`[src] verts=${vCount} uv=${!!prim.attributes.TEXCOORD_0}`);

  // 骨世界矩阵（bind pose，纯平移，保持 T-pose）：从 armature 根递归。
  // ⚠ 不在这里加 rest 旋转：GLTF 蒙皮里 jointMatrix·inverseBind 在 bind 时恒为 I，
  //   节点旋转会被 inverseBind 抵消，显示仍是网格原样（T-pose）。"手臂下垂"改由动画基旋转承载（见 boneRot）。
  const absPos = BONE_DEF.map(([, , p]) => new THREE.Vector3(p[0], p[1], p[2]));
  const parentOf = BONE_DEF.map(([, par]) => (par ? BONE_DEF.findIndex((b) => b[0] === par) : -1));
  const localPos = BONE_DEF.map((_, i) =>
    parentOf[i] < 0 ? absPos[i].clone() : absPos[i].clone().sub(absPos[parentOf[i]]));
  const worldMat = [];
  for (let i = 0; i < N_BONES; i++) {
    const m = new THREE.Matrix4().makeTranslation(localPos[i].x, localPos[i].y, localPos[i].z);
    if (parentOf[i] < 0) worldMat[i] = m.clone();
    else worldMat[i] = worldMat[parentOf[i]].clone().multiply(m);
  }
  const invBind = worldMat.map((m) => m.clone().invert());

  // 蒙皮权重：每顶点取最近 4 根骨，按 1/(d^2+eps) 归一化
  const joints = new Uint16Array(vCount * 4);
  const weights = new Float32Array(vCount * 4);
  const segA = absPos.map((_, i) => (parentOf[i] < 0 ? absPos[i] : absPos[parentOf[i]]));
  const p = new THREE.Vector3();
  const order = []; for (let i = 0; i < N_BONES; i++) order.push(i);
  for (let v = 0; v < vCount; v++) {
    p.set(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
    const ds = [];
    for (let i = 0; i < N_BONES; i++) ds.push(distToSeg(p, segA[i], absPos[i]));
    order.sort((a, b) => ds[a] - ds[b]);
    let sum = 0; const w4 = [];
    for (let k = 0; k < 4; k++) {
      const w = 1 / (ds[order[k]] * ds[order[k]] + 0.0015);
      w4.push(w); sum += w;
    }
    for (let k = 0; k < 4; k++) {
      joints[v * 4 + k] = order[k];
      weights[v * 4 + k] = w4[k] / sum;
    }
  }

  // ---------------- 追加到 GLB ----------------
  let curBin = bin;
  const newBV = [], newAcc = [];
  function append(type, componentType, count, array, target) {
    const pad = (4 - (curBin.length % 4)) % 4;
    if (pad) curBin = Buffer.concat([curBin, Buffer.alloc(pad)]);
    const off = curBin.length;
    curBin = Buffer.concat([curBin, Buffer.from(array.buffer, array.byteOffset, array.byteLength)]);
    const bvIdx = json.bufferViews.length + newBV.length;
    newBV.push({ buffer: 0, byteOffset: off, byteLength: array.byteLength, ...(target ? { target } : {}) });
    const accIdx = json.accessors.length + newAcc.length;
    const acc = { bufferView: bvIdx, componentType, count, type };
    if (type === 'SCALAR' && componentType === FLOAT) acc.min = [0], acc.max = [array[array.length - 1]];
    newAcc.push(acc);
    return accIdx;
  }
  const T_ARR = 34962, T_EL = 34963;

  const accJ = append('VEC4', USHORT, vCount, joints, T_ARR);
  const accW = append('VEC4', FLOAT, vCount, weights, T_ARR);
  prim.attributes.JOINTS_0 = accJ;
  prim.attributes.WEIGHTS_0 = accW;

  // inverseBindMatrices
  const ibm = new Float32Array(N_BONES * 16);
  for (let i = 0; i < N_BONES; i++) ibm.set(invBind[i].elements, i * 16);
  const accIBM = append('MAT4', FLOAT, N_BONES, ibm, T_ARR);

  // 骨架节点
  const baseNode = json.nodes.length;
  const finalBoneIdx = BONE_DEF.map((_, i) => baseNode + i);
  const armatureIdx = baseNode + N_BONES;
  const nodeDefs = BONE_DEF.map(([name], i) => ({
    name,
    translation: [localPos[i].x, localPos[i].y, localPos[i].z],
    children: [],
  }));
  // 父→子（局部索引），稍后映射为最终 node 索引
  for (let i = 0; i < N_BONES; i++) if (parentOf[i] >= 0) nodeDefs[parentOf[i]].children.push(i);
  for (const nd of nodeDefs) {
    nd.children = nd.children.map((c) => finalBoneIdx[c]);
    json.nodes.push(nd);
  }
  json.nodes.push({ name: 'armature', children: [finalBoneIdx[0]] });

  const skinIdx = json.skins ? json.skins.length : (json.skins = []).length;
  json.skins.push({ joints: finalBoneIdx.slice(), inverseBindMatrices: accIBM, skeleton: armatureIdx });

  // mesh node 挂骨架（作为 children，使骨空间与 mesh 顶点空间一致）+ skin
  const meshNode = json.nodes.find((n) => n.mesh === 0);
  if (!meshNode) throw new Error('找不到 mesh node');
  meshNode.skin = skinIdx;
  meshNode.children = meshNode.children || [];
  meshNode.children.push(armatureIdx);

  // ---------------- 程序化动画（同坐标系）----------------
  const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
  const FR = 33; // 每 clip 帧数
  // 每运动骨：轴 + 幅度函数(相位 s∈[0,1))
  function legAng(s, amp) { return amp * Math.sin(2 * Math.PI * s); }
  function kneeAng(s, amp) { const h = amp * Math.sin(2 * Math.PI * s); return Math.max(0, -h) * 0.9; }
  // 骨运动：返回局部旋转四元数（含 rest 基 + swing）。局部 = swing · rest（先下垂 rest，再叠加摆动 swing）。
  const IDENT = new THREE.Quaternion();
  function quat(axis, ang) { return new THREE.Quaternion().setFromAxisAngle(axis, ang); }
  function boneRot(name, s, clip) {
    const ph = s; // 相位
    let sw = null;
    switch (name) {
      case 'l_hip': sw = quat(Z, legAng(ph, clip.A)); break;
      case 'r_hip': sw = quat(Z, -legAng(ph, clip.A)); break;
      case 'l_knee': sw = clip.knee ? quat(Z, -kneeAng(ph, clip.A)) : null; break;
      case 'r_knee': sw = clip.knee ? quat(Z, -kneeAng(ph + 0.5, clip.A)) : null; break;
      case 'l_shoulder': sw = quat(Z, -legAng(ph, clip.A2)); break;
      case 'r_shoulder': sw = quat(Z, legAng(ph, clip.A2)); break;
      case 'l_elbow': sw = quat(Z, 0.22 + 0.06 * Math.sin(2 * Math.PI * ph)); break;
      case 'r_elbow': sw = quat(Z, 0.22 + 0.06 * Math.sin(2 * Math.PI * ph)); break;
      case 'chest': sw = quat(Y, clip.A3 * Math.sin(2 * Math.PI * ph)); break;
      case 'head': sw = quat(Y, -clip.A3 * 0.5 * Math.sin(2 * Math.PI * ph)); break;
      case 'hips': sw = quat(Y, clip.A3 * 0.3 * Math.sin(2 * Math.PI * ph)); break;
      case 'spine': sw = quat(Z, 0.02 * Math.sin(2 * Math.PI * ph)); break;
      default: sw = null;
    }
    const r = restQuat(name);
    if (!sw && !r) return null;
    const q = sw ? sw.clone() : new THREE.Quaternion();
    if (r) q.multiply(r); // 局部旋转 = swing · rest：先下垂，再在下垂姿势上摆
    return q;
  }
  const jsonAnims = [];
  for (const clip of anims) {
    const times = new Float32Array(FR);
    for (let f = 0; f < FR; f++) times[f] = (clip.period * f) / (FR - 1);
    const accTime = append('SCALAR', FLOAT, FR, times);
    const channels = [], samplers = [];
    for (let i = 0; i < N_BONES; i++) {
      const name = BONE_DEF[i][0];
      // 检测该骨在任意相位是否偏离 identity（rest 本身也算，保证下垂姿态一直被写入）
      let anyMove = false;
      for (let f = 0; f < FR; f++) {
        const q = boneRot(name, f / (FR - 1), clip);
        if (q && q.angleTo(IDENT) > 1e-4) { anyMove = true; break; }
      }
      if (!anyMove) continue;
      const out = new Float32Array(FR * 4);
      for (let f = 0; f < FR; f++) {
        const q = boneRot(name, f / (FR - 1), clip);
        out[f * 4] = q.x; out[f * 4 + 1] = q.y; out[f * 4 + 2] = q.z; out[f * 4 + 3] = q.w;
      }
      const accOut = append('VEC4', FLOAT, FR, out);
      const si = samplers.length;
      samplers.push({ input: accTime, output: accOut });
      channels.push({ sampler: si, target: { node: finalBoneIdx[i], path: 'rotation' } });
    }
    jsonAnims.push({ name: clip.name, channels, samplers });
  }
  json.animations = jsonAnims;

  // 提交新 bufferView / accessor
  for (const bv of newBV) json.bufferViews.push(bv);
  for (const a of newAcc) json.accessors.push(a);

  fs.writeFileSync(outPath, writeGLB(json, curBin));
  console.log(`[out] -> ${outPath} (${curBin.length} bytes, bones=${N_BONES}, anims=${jsonAnims.length})`);
}

const args = process.argv.slice(2);
const genders = args.length ? args : ['boy', 'girl'];
for (const g of genders) bake(g);
console.log('\nDONE');
