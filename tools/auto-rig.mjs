// 程序化自绑骨脚本：直接对带贴图的原 GLB（boy.glb / girl.glb）做手术，
// 不加任何外部骨骼/动画源（不用 Mixamo、不用 Soldier 重定向），从根上避免"网格↔骨骼坐标系不匹配"。
//
// 做法：
//  - 原 GLB 的 BIN chunk（含贴图/UV/法线/索引）一字不动，只在尾部追加 JOINTS_0 / WEIGHTS_0 /
//    inverseBindMatrices / 骨架节点 / 动画 → 贴图 100% 保真（不依赖 Node 解码贴图，也不走 GLTFExporter 重排）。
//  - 骨架基于 AABB 程序化放置（模型已归一化到 y∈[-0.5,0.5]），bind pose 为直立、手臂贴体侧（非 T-pose）。
//  - 蒙皮权重：每顶点到各骨「线段」距离的倒数，取最近 4 根归一化。
//  - 动画：同坐标系程序化生成 Idle/Walk/Run，绕局部 X 摆腿（=前后走）、绕局部 X 摆臂（反相）、
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

// ---------------- 骨架定义（mesh 局部空间绝对 bind-pose 坐标；模型 y∈[-0.5,0.5]）----------------
// 命名不带前缀点号，纯小写+下划线，避免任何解析歧义。
const BONE_DEF = [
  ['hips', null, [0, -0.15, 0]],
  ['spine', 'hips', [0, -0.05, 0]],
  ['chest', 'spine', [0, 0.06, 0]],
  ['neck', 'chest', [0, 0.18, 0]],
  ['head', 'neck', [0, 0.34, 0]],
  ['l_shoulder', 'chest', [0.15, 0.16, 0]],
  ['l_elbow', 'l_shoulder', [0.23, 0.02, 0]],
  ['l_wrist', 'l_elbow', [0.25, -0.10, 0]],
  ['r_shoulder', 'chest', [-0.15, 0.16, 0]],
  ['r_elbow', 'r_shoulder', [-0.23, 0.02, 0]],
  ['r_wrist', 'r_elbow', [-0.25, -0.10, 0]],
  ['l_hip', 'hips', [0.09, -0.17, 0]],
  ['l_knee', 'l_hip', [0.10, -0.32, 0]],
  ['l_ankle', 'l_hip', [0.10, -0.49, 0]],
  ['r_hip', 'hips', [-0.09, -0.17, 0]],
  ['r_knee', 'r_hip', [-0.10, -0.32, 0]],
  ['r_ankle', 'r_hip', [-0.10, -0.49, 0]],
];
const N_BONES = BONE_DEF.length;

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
  const glbPath = `public/assets/${gender}.glb`;
  const outPath = `public/assets/${gender}-rig.glb`;
  console.log(`\n=== ${gender} ===`);
  const { json, bin } = parseGLB(fs.readFileSync(glbPath));
  const prim = json.meshes[0].primitives[0];
  const pos = readF32(json, bin, prim.attributes.POSITION);
  const vCount = pos.length / 3;
  console.log(`[src] verts=${vCount} uv=${!!prim.attributes.TEXCOORD_0}`);

  // 骨世界矩阵（bind pose，无旋转）：从 armature 根递归
  const absPos = BONE_DEF.map(([, , p]) => new THREE.Vector3(p[0], p[1], p[2]));
  const parentOf = BONE_DEF.map(([, par]) => (par ? BONE_DEF.findIndex((b) => b[0] === par) : -1));
  const localPos = BONE_DEF.map((_, i) =>
    parentOf[i] < 0 ? absPos[i].clone() : absPos[i].clone().sub(absPos[parentOf[i]]));
  const worldMat = [];
  const root = new THREE.Matrix4();
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
  const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0);
  const FR = 33; // 每 clip 帧数
  // 每运动骨：轴 + 幅度函数(相位 s∈[0,1))
  function legAng(s, amp) { return amp * Math.sin(2 * Math.PI * s); }
  function kneeAng(s, amp) { const h = amp * Math.sin(2 * Math.PI * s); return Math.max(0, -h) * 0.9; }
  // moveBones: name -> (axisChar, ampScale 乘数, periodSec)
  const anims = [
    { name: 'Idle', period: 4.0, A: 0.0, A2: 0.05, A3: 0.03, knee: false },
    { name: 'Walk', period: 1.1, A: 0.38, A2: 0.26, A3: 0.08, knee: true },
    { name: 'Run', period: 0.7, A: 0.72, A2: 0.46, A3: 0.12, knee: true },
  ];
  // 骨运动定义（按骨名）
  function boneMotion(name, s, clip) {
    const ph = s; // 相位
    switch (name) {
      case 'l_hip': return { axis: X, ang: legAng(ph, clip.A) };
      case 'r_hip': return { axis: X, ang: -legAng(ph, clip.A) };
      case 'l_knee': return clip.knee ? { axis: X, ang: kneeAng(ph, clip.A) } : null;
      case 'r_knee': return clip.knee ? { axis: X, ang: kneeAng(ph + 0.5, clip.A) } : null;
      case 'l_shoulder': return { axis: X, ang: -legAng(ph, clip.A2) };
      case 'r_shoulder': return { axis: X, ang: legAng(ph, clip.A2) };
      case 'l_elbow': return { axis: X, ang: 0.22 + 0.06 * Math.sin(2 * Math.PI * ph) };
      case 'r_elbow': return { axis: X, ang: 0.22 + 0.06 * Math.sin(2 * Math.PI * ph) };
      case 'chest': return { axis: Y, ang: clip.A3 * Math.sin(2 * Math.PI * ph) };
      case 'head': return { axis: Y, ang: -clip.A3 * 0.5 * Math.sin(2 * Math.PI * ph) };
      case 'hips': return { axis: Y, ang: clip.A3 * 0.3 * Math.sin(2 * Math.PI * ph) };
      case 'spine': return { axis: X, ang: 0.02 * Math.sin(2 * Math.PI * ph) };
      default: return null;
    }
  }
  const jsonAnims = [];
  for (const clip of anims) {
    const times = new Float32Array(FR);
    for (let f = 0; f < FR; f++) times[f] = (clip.period * f) / (FR - 1);
    const accTime = append('SCALAR', FLOAT, FR, times);
    const channels = [], samplers = [];
    for (let i = 0; i < N_BONES; i++) {
      const name = BONE_DEF[i][0];
      // 检测该骨在任意相位是否有非零运动
      let anyMove = false;
      for (let f = 0; f < FR; f++) { const m = boneMotion(name, f / (FR - 1), clip); if (m && Math.abs(m.ang) > 1e-4) { anyMove = true; break; } }
      if (!anyMove) continue;
      const out = new Float32Array(FR * 4);
      const q = new THREE.Quaternion();
      for (let f = 0; f < FR; f++) {
        const m = boneMotion(name, f / (FR - 1), clip);
        q.setFromAxisAngle(m.axis, m.ang);
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
