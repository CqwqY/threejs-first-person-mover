// 职责：给玩家模型「上骨骼 + 上走路动画」的**一次性离线烘焙**脚本（产物入仓，运行时不再需要本脚本）。
//
// 为什么这么做（背景）：
//  - public/assets/{boy,girl}.glb   ：Tripo 生成的角色，**带贴图与 UV，但完全没有骨骼**；
//  - public/assets/{boy,girl}.fbx   ：同一个网格经 Mixamo 自动绑骨后的版本，**有 mixamorig 骨骼与专业蒙皮权重，
//                                     但没有可用贴图**，且 fbx 在浏览器里加载慢、材质也不对，所以不能直接用；
//  - 两者是同一份网格（glb 索引 60882 == fbx 展开顶点 60882，逐点误差 ~5e-7），
//    因此可以把 fbx 的骨骼/权重**原样搬到 glb 上**，得到「有贴图 + 有骨骼」的模型。
//
// 做法上是「glTF 二进制手术」而不是「three 导出一遍」：原 GLB 的 BIN chunk 原封不动保留，
// 只在尾部**追加** JOINTS_0 / WEIGHTS_0 / inverseBindMatrices / 动画数据，原有 bufferView 偏移一律不变
// → 贴图、UV、法线、材质百分之百保真（three 的 GLTFExporter 会重排属性，有可能动到 UV，故不用）。
//
// 动画来源：three.js 官方示例 Soldier.glb（mixamorig 骨架，Idle/Walk/Run，CC0）。
// 骨骼名做 `mixamorig:XXX` → `mixamorigXXX` 映射后即可复用；因两套骨架的绑定姿态（rest pose）
// 与体型都不同，动画在写入前做了两步重定向修正：
//   1) 姿态修正：q_new = q_ourRest * q_srcRest⁻¹ * q_anim（消除两套骨架静止姿态的差）；
//   2) 位移缩放：p_new = p_ourRest + (p_anim - p_srcRest) * scale（scale = 我方髋高 / 源髋高），
//      并且**丢弃水平位移**（原地循环动画才不会让角色自己走开）。
//
// 用法：node tools/bake-player-rig.mjs [boy girl]
import fs from 'fs';
import path from 'path';
import os from 'os';
import * as THREE from '../node_modules/three/build/three.module.js';
import { FBXLoader } from '../node_modules/three/examples/jsm/loaders/FBXLoader.js';

const ANIM_SRC_URL = 'https://threejs.org/examples/models/gltf/Soldier.glb';
const ANIM_CACHE = path.join(os.tmpdir(), 'Soldier.glb');
const WANT_CLIPS = ['Idle', 'Walk', 'Run'];

// glTF 常量
const FLOAT = 5126, USHORT = 5123, UINT = 5125;
const COMPS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const CTYPE_SIZE = { 5126: 4, 5123: 2, 5125: 4, 5121: 1, 5122: 2 };

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
  out.write('JSON', o + 4, 'ascii');
  o += 8;
  jb.copy(out, o); o += jb.length;
  if (jPad) { out.fill(0x20, o, o + jPad); o += jPad; }
  out.writeUInt32LE(bin.length + bPad, o);
  out.write('BIN\0', o + 4, 'ascii');
  o += 8;
  bin.copy(out, o); o += bin.length;
  if (bPad) out.fill(0, o, o + bPad);
  return out;
}

// 读一个 accessor 成 TypedArray
function readAccessor(json, bin, idx) {
  const acc = json.accessors[idx];
  const bv = json.bufferViews[acc.bufferView];
  const comps = COMPS[acc.type];
  const csize = CTYPE_SIZE[acc.componentType];
  const stride = bv.byteStride || comps * csize;
  const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const n = acc.count * comps;
  let out;
  if (acc.componentType === FLOAT) out = new Float32Array(n);
  else if (acc.componentType === USHORT) out = new Uint16Array(n);
  else if (acc.componentType === UINT) out = new Uint32Array(n);
  else throw new Error('unsupported componentType ' + acc.componentType);
  for (let i = 0; i < acc.count; i++) {
    for (let c = 0; c < comps; c++) {
      const at = base + i * stride + c * csize;
      out[i * comps + c] =
        acc.componentType === FLOAT ? bin.readFloatLE(at)
          : acc.componentType === USHORT ? bin.readUInt16LE(at)
            : bin.readUInt32LE(at);
    }
  }
  return out;
}

// ---------------- 主流程 ----------------
async function bake(gender) {
  const glbPath = `public/assets/${gender}.glb`;
  const fbxPath = `public/assets/${gender}.fbx`;
  const outPath = `public/assets/${gender}-rig.glb`;
  console.log(`\n=== ${gender} ===`);

  // --- 1. 读 glb（贴图/UV 真源） ---
  const { json, bin } = parseGLB(fs.readFileSync(glbPath));
  const prim = json.meshes[0].primitives[0];
  const gPos = readAccessor(json, bin, prim.attributes.POSITION);
  const gIdx = prim.indices != null ? readAccessor(json, bin, prim.indices) : null;
  const vCount = gPos.length / 3;
  console.log(`[glb] verts=${vCount} indices=${gIdx ? gIdx.length : '-'} uv=${!!prim.attributes.TEXCOORD_0}`);

  // --- 2. 读 fbx（骨骼 + 蒙皮权重） ---
  const fb = fs.readFileSync(fbxPath);
  const ab = fb.buffer.slice(fb.byteOffset, fb.byteOffset + fb.byteLength);
  const fbx = new FBXLoader().parse(ab, '');
  fbx.updateMatrixWorld(true);
  let skinned = null;
  fbx.traverse((o) => { if (o.isSkinnedMesh) skinned = o; });
  if (!skinned) throw new Error('fbx 里没有 SkinnedMesh');
  const bones = skinned.skeleton.bones;
  const fSkinIdx = skinned.geometry.attributes.skinIndex.array;
  const fSkinW = skinned.geometry.attributes.skinWeight.array;
  const fVertCount = skinned.geometry.attributes.position.count;
  console.log(`[fbx] bones=${bones.length} verts=${fVertCount}`);
  if (!gIdx || gIdx.length !== fVertCount) {
    throw new Error(`glb 索引数(${gIdx && gIdx.length}) != fbx 顶点数(${fVertCount})，无法逐点搬运权重`);
  }

  // --- 3. 权重搬运：fbx 展开顶点 -> glb 唯一顶点 ---
  const joints = new Uint16Array(vCount * 4);
  const weights = new Float32Array(vCount * 4);
  const filled = new Uint8Array(vCount);
  const tmpI = [0, 0, 0, 0];
  const tmpW = [0, 0, 0, 0];
  for (let i = 0; i < fVertCount; i++) {
    const v = gIdx[i];
    if (filled[v]) continue;
    filled[v] = 1;
    // 收集非零权重（fbx 已限制最多 4 组），不足则补到根骨
    let n = 0, sum = 0;
    for (let k = 0; k < 4; k++) {
      const w = fSkinW[i * 4 + k];
      if (w > 1e-6 && n < 4) { tmpI[n] = fSkinIdx[i * 4 + k]; tmpW[n] = w; sum += w; n++; }
    }
    if (n === 0) { tmpI[0] = 0; tmpW[0] = 1; n = 1; sum = 1; }
    for (let k = 0; k < n; k++) tmpW[k] /= sum; // 归一化
    for (let k = 0; k < 4; k++) {
      joints[v * 4 + k] = k < n ? tmpI[k] : 0;
      weights[v * 4 + k] = k < n ? tmpW[k] : 0;
    }
  }
  let unfilled = 0;
  for (let v = 0; v < vCount; v++) if (!filled[v]) unfilled++;
  if (unfilled) console.warn(`[warn] ${unfilled} 个顶点没被任何三角形引用，权重留空`);
  // 每张骨头被多少顶点引用（自检：顺序错会出现「某根骨完全没人用」）
  const perBone = new Array(bones.length).fill(0);
  for (let v = 0; v < vCount; v++) {
    for (let k = 0; k < 4; k++) if (weights[v * 4 + k] > 1e-6) perBone[joints[v * 4 + k]]++;
  }
  console.log('[weights] 每骨影响顶点数:', bones.map((b, i) => `${b.name.replace('mixamorig', '')}=${perBone[i]}`).join(' '));
  const orphan = perBone.filter((c) => c === 0).length;
  if (orphan) console.warn(`[warn] ${orphan} 根骨骼没有任何顶点权重`);

  // --- 4. 骨架对齐：Mixamo 骨架的摆放朝向未必与 Tripo 网格一致 ---
  // 实测 boy.fbx：手骨世界 x=+0.33（已经跑到网格 bbox 0.288 之外），而手部顶点在 z≈-0.35
  // —— 整套骨架相对网格绕 Y 转了 90°。直接用的话胳膊会绕错误的轴甩，所以必须先对齐。
  // 做法：用蒙皮权重算出每根骨「实际控制的顶点簇中心」C_j，再求一个绕 Y 的旋转 + 平移
  // （2D Kabsch），把骨架摆到顶点簇上去。骨骼之间的相对旋转不变，因此动画语义不受影响。
  const boneWorld = bones.map((b) => b.getWorldPosition(new THREE.Vector3()));
  const cluster = bones.map(() => new THREE.Vector3());
  const clusterW = new Array(bones.length).fill(0);
  const tv = new THREE.Vector3();
  for (let vi = 0; vi < vCount; vi++) {
    tv.set(gPos[vi * 3], gPos[vi * 3 + 1], gPos[vi * 3 + 2]);
    for (let k = 0; k < 4; k++) {
      const w = weights[vi * 4 + k];
      if (w <= 1e-6) continue;
      const j = joints[vi * 4 + k];
      cluster[j].addScaledVector(tv, w);
      clusterW[j] += w;
    }
  }
  bones.forEach((b, i) => {
    if (clusterW[i] > 1e-6) cluster[i].multiplyScalar(1 / clusterW[i]);
    else cluster[i].copy(boneWorld[i]); // 没人用的骨（极罕见）保持原位
  });
  // ⚠ 用「全部骨骼」算全局对齐（绕 Y 旋转 + 水平平移）：
  // 实测只用核心躯干骨会让 θ 算歪（手臂/腿的簇中心不可靠，但躯干骨近似共线、角向杠杆不足），
  // 反而把整套骨架旋成不对称（静止态一只手甩出、一只收着）。全骨骼 Kabsch 给的 θ 才是对称的。
  const coreIdx = bones.map((b, i) => i);
  const bc = new THREE.Vector3(), cc = new THREE.Vector3();
  for (const i of coreIdx) { bc.add(boneWorld[i]); cc.add(cluster[i]); }
  bc.divideScalar(coreIdx.length); cc.divideScalar(coreIdx.length);
  let kA = 0, kB = 0, nB = 0, nC = 0;
  for (const i of coreIdx) {
    const bx = boneWorld[i].x - bc.x, bz = boneWorld[i].z - bc.z;
    const cx = cluster[i].x - cc.x, cz = cluster[i].z - cc.z;
    // 绕 Y 旋转：x' = c·x + s·z, z' = -s·x + c·z；最大化 Σ(R·B)·C ⇒ θ = atan2(Σ(Bz·Cx - Bx·Cz), Σ(Bx·Cx + Bz·Cz))
    kA += bx * cx + bz * cz;
    kB += bz * cx - bx * cz;
    nB += bx * bx + bz * bz;
    nC += cx * cx + cz * cz;
  }
  const theta = Math.atan2(kB, kA);
  const alignM = new THREE.Matrix4().makeRotationY(theta);
  const bRot = new THREE.Vector3().copy(bc).applyMatrix4(alignM);
  // ⚠ 只在水平面平移：竖直方向骨架的脚底本来就贴着网格脚底，若按「簇中心」对齐 y，
  // 会被「头占了半个身子」这类模型把整套骨架抬离地面。
  alignM.premultiply(new THREE.Matrix4().makeTranslation(cc.x - bRot.x, 0, cc.z - bRot.z));
  const before = boneWorld.reduce((s, p, i) => s + p.distanceTo(cluster[i]), 0) / bones.length;
  const after = boneWorld.reduce((s, p, i) => s + p.clone().applyMatrix4(alignM).distanceTo(cluster[i]), 0) / bones.length;
  // 修正符号后只看角度还不够：某些骨（尤其是头）可能仍对不上，逐骨列出残差最大的几根
  const resid = bones.map((b, i) => ({
    name: b.name.replace('mixamorig', ''),
    before: boneWorld[i].distanceTo(cluster[i]),
    after: boneWorld[i].clone().applyMatrix4(alignM).distanceTo(cluster[i]),
  }));
  resid.sort((a, b) => b.after - a.after);
  console.log(`[align] 平均 ${before.toFixed(3)} -> ${after.toFixed(3)}；残差最大:`,
    resid.slice(0, 5).map((r) => `${r.name} ${r.before.toFixed(2)}->${r.after.toFixed(2)}`).join('  '));

  // --- 5. 骨骼 -> glTF 节点 ---
  const boneIndex = new Map();
  bones.forEach((b, i) => boneIndex.set(b, i));
  const boneNodeIdx = [];
  const worldM = new THREE.Matrix4();
  const localM = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  const restPos = new Map();   // 骨骼名 -> rest 局部位移（用于动画重定向）
  const restQuat = new Map();  // 骨骼名 -> rest 局部四元数
  bones.forEach((b, i) => {
    const isRoot = !(b.parent && boneIndex.has(b.parent));
    // 根骨要带走父级（模型根 Group）的变换 + 对齐矩阵；子骨保持自己的局部变换
    if (isRoot) worldM.multiplyMatrices(alignM, b.matrixWorld);
    else localM.copy(b.matrix);
    (isRoot ? worldM : localM).decompose(pos, quat, scl);
    const node = { name: b.name };
    if (pos.lengthSq() > 1e-12) node.translation = [pos.x, pos.y, pos.z];
    if (Math.abs(quat.x) + Math.abs(quat.y) + Math.abs(quat.z) > 1e-9 || Math.abs(quat.w - 1) > 1e-9) {
      node.rotation = [quat.x, quat.y, quat.z, quat.w];
    }
    if (Math.abs(scl.x - 1) + Math.abs(scl.y - 1) + Math.abs(scl.z - 1) > 1e-9) node.scale = [scl.x, scl.y, scl.z];
    boneNodeIdx.push(json.nodes.length);
    json.nodes.push(node);
    restPos.set(b.name, node.translation ? node.translation.slice() : [0, 0, 0]);
    restQuat.set(b.name, node.rotation ? node.rotation.slice() : [0, 0, 0, 1]);
  });
  const rootBoneNode = boneNodeIdx.find((n, i) => !bones[i].parent || !boneIndex.has(bones[i].parent));
  // 挂 children：根骨进 scene.nodes，其余挂到父骨下
  const scene0 = json.scenes[json.scene];
  scene0.nodes = scene0.nodes || [];
  bones.forEach((b, i) => {
    if (b.parent && boneIndex.has(b.parent)) {
      const p = json.nodes[boneNodeIdx[boneIndex.get(b.parent)]];
      (p.children = p.children || []).push(boneNodeIdx[i]);
    } else {
      scene0.nodes.push(boneNodeIdx[i]);
    }
  });

  // --- 5. 追加二进制数据（原 BIN 一字不动，只往后追加） ---
  const chunks = [Buffer.from(bin)];
  let cursor = chunks[0].length;
  function append(buf) {
    const pad = (4 - (cursor % 4)) % 4;
    if (pad) { chunks.push(Buffer.alloc(pad)); cursor += pad; }
    const start = cursor;
    chunks.push(buf);
    cursor += buf.length;
    return start;
  }
  function addAccessor(typed, type, componentType, minmax) {
    const buf = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    const off = append(buf);
    json.bufferViews.push({ buffer: 0, byteOffset: off, byteLength: buf.length });
    const acc = {
      bufferView: json.bufferViews.length - 1,
      componentType,
      count: typed.length / COMPS[type],
      type,
    };
    if (minmax) { acc.min = minmax[0]; acc.max = minmax[1]; }
    json.accessors.push(acc);
    return json.accessors.length - 1;
  }

  const jAcc = addAccessor(joints, 'VEC4', USHORT);
  const wAcc = addAccessor(weights, 'VEC4', FLOAT);
  prim.attributes.JOINTS_0 = jAcc;
  prim.attributes.WEIGHTS_0 = wAcc;

  // inverseBindMatrices：骨骼绑定姿态世界矩阵的逆
  const ibm = new Float32Array(bones.length * 16);
  const inv = new THREE.Matrix4();
  bones.forEach((b, i) => {
    inv.copy(b.matrixWorld).premultiply(alignM).invert(); // 世界矩阵要带上对齐矩阵
    inv.toArray(ibm, i * 16);
  });
  const ibmAcc = addAccessor(ibm, 'MAT4', FLOAT);
  json.skins = [{
    joints: boneNodeIdx.slice(),
    inverseBindMatrices: ibmAcc,
    skeleton: rootBoneNode !== undefined ? rootBoneNode : boneNodeIdx[0],
  }];
  const meshNode = json.nodes.find((n) => n.mesh === 0);
  meshNode.skin = 0;
  if (meshNode.translation || meshNode.rotation || meshNode.scale) {
    console.warn('[warn] skinned mesh 节点带非单位变换，glTF 下会被忽略，已清空');
    delete meshNode.translation; delete meshNode.rotation; delete meshNode.scale;
  }

  // --- 6. 动画：从 Soldier.glb 提取并重定向 ---
  await ensureAnimSource();
  const src = parseGLB(fs.readFileSync(ANIM_CACHE));
  const srcJointName = new Map(); // 'mixamorig:LeftArm' -> node index
  src.json.nodes.forEach((n, i) => { if (n.name && n.name.startsWith('mixamorig:')) srcJointName.set(n.name, i); });
  // 源髋高（用于位移缩放）：用完整世界矩阵算，别只累加 translation（源骨架节点可能带旋转/缩放）
  const srcParent = new Map();
  src.json.nodes.forEach((n, i) => { (n.children || []).forEach((c) => srcParent.set(c, i)); });
  function srcNodeMatrix(n) {
    const q = new THREE.Quaternion().fromArray(n.rotation || [0, 0, 0, 1]);
    const p = new THREE.Vector3().fromArray(n.translation || [0, 0, 0]);
    const s = new THREE.Vector3().fromArray(n.scale || [1, 1, 1]);
    return new THREE.Matrix4().compose(p, q, s);
  }
  // ⚠ 两套骨架的「单位」不同
  const _sv = new THREE.Vector3();
  function srcWorldY(nodeIdx, ignoreScale) {
    let m = srcNodeMatrix(src.json.nodes[nodeIdx]);
    let cur = srcParent.get(nodeIdx);
    const seen = new Set();
    while (cur != null && !seen.has(cur)) {
      seen.add(cur);
      m.premultiply(srcNodeMatrix(ignoreScale ? stripScale(src.json.nodes[cur]) : src.json.nodes[cur]));
      cur = srcParent.get(cur);
    }
    return _sv.setFromMatrixPosition(m).y;
  }
  function stripScale(n) {
    const c = { translation: n.translation, rotation: n.rotation };
    return c;
  }
  const srcHips = srcJointName.get('mixamorig:Hips');
  const srcFoot = srcJointName.get('mixamorig:LeftToeBase') ?? srcJointName.get('mixamorig:LeftFoot');
  const srcHipH = srcWorldY(srcHips) - srcWorldY(srcFoot);                   // 世界（米）
  const srcHipHLocal = srcWorldY(srcHips, true) - srcWorldY(srcFoot, true);  // 与 translation 同单位（厘米）

  const hipsBone = bones.find((b) => b.name === 'mixamorigHips');
  const footBone = bones.find((b) => b.name === 'mixamorigLeftToeBase') || bones.find((b) => b.name === 'mixamorigLeftFoot');
  const wv = new THREE.Vector3();
  hipsBone.getWorldPosition(wv).applyMatrix4(alignM); const ourHipY = wv.y;
  footBone.getWorldPosition(wv).applyMatrix4(alignM); const ourFootY = wv.y;
  // 位移缩放 = 我方髋高(我方单位) / 源髋高(源 translation 单位)
  const scale = (ourHipY - ourFootY) / (srcHipHLocal || 1);
  console.log(`[retarget] 髋高 我方=${(ourHipY - ourFootY).toFixed(4)} 源(translation单位)=${srcHipHLocal.toFixed(3)} 源(米)=${srcHipH.toFixed(4)} scale=${scale.toFixed(5)}`);
  if (scale <= 0 || scale > 1) throw new Error('体型缩放系数异常，检查源骨架髋高计算');

  // 诊断：源动画里 Hips 的位移幅度（若水平方向幅度很大说明是带位移的 root motion，需处理）
  {
    const anim = src.json.animations.find((a) => a.name === 'Walk');
    const ch = anim.channels.find((c) => c.target.node === srcHips && c.target.path === 'translation');
    if (ch) {
      const v = readAccessor(src.json, src.bin, anim.samplers[ch.sampler].output);
      const mm = [[Infinity, Infinity, Infinity], [-Infinity, -Infinity, -Infinity]];
      for (let i = 0; i < v.length; i += 3) {
        for (let c = 0; c < 3; c++) { mm[0][c] = Math.min(mm[0][c], v[i + c]); mm[1][c] = Math.max(mm[1][c], v[i + c]); }
      }
      const amp = [0, 1, 2].map((c) => (mm[1][c] - mm[0][c]));
      console.log(`[diag] 源 Walk Hips 位移幅度 x=${amp[0].toFixed(3)} y=${amp[1].toFixed(3)} z=${amp[2].toFixed(3)}（x/z 大 = 带位移的 root motion）`);
    }
  }

  const outAnims = [];
  // ⚠ 关键修复：alignM 把整套骨架绕 Y 旋了 θ 才贴合 Tripo 网格，但动画的「动作方向」也会被同步转 θ。
  // 若不补偿，走路时「腿前后摆」会整体变成「侧向甩」（静止态 q_anim≈rest 看不出，一动就诡异 = 用户说的移动猎奇）。
  // 修法：对动画局部旋转做 alignM 的共轭预旋转 qAlign·q_anim·qAlign⁻¹ ——
  //   静止时恒等（q_anim=q_srcRest → 还原成 q_ourRest，不破坏对齐）；动作时把摆动轴旋回世界正确方向。
  const qAlign = new THREE.Quaternion().setFromRotationMatrix(alignM);
  const qAlignInv = qAlign.clone().invert();
  for (const want of WANT_CLIPS) {
    const anim = src.json.animations.find((a) => a.name === want);
    if (!anim) { console.warn(`[warn] 源里没有 ${want}`); continue; }
    const channels = [];
    const samplers = [];
    let frames = 0;
    for (const ch of anim.channels) {
      const srcNode = src.json.nodes[ch.target.node];
      const mapped = srcNode.name.replace(/^mixamorig:/, 'mixamorig');
      const bi = bones.findIndex((b) => b.name === mapped);
      if (bi < 0) continue;                       // 我方没有这根骨（如手指）→ 丢弃
      const path = ch.target.path;
      if (path === 'scale') continue;             // 缩放恒为 1，不写
      const samp = anim.samplers[ch.sampler];
      const times = readAccessor(src.json, src.bin, samp.input);
      const values = readAccessor(src.json, src.bin, samp.output);
      frames = Math.max(frames, times.length);

      let outVals;
      if (path === 'rotation') {
        const qRestS = new THREE.Quaternion().fromArray(src.json.nodes[ch.target.node].rotation || [0, 0, 0, 1]);
        const qRestO = new THREE.Quaternion().fromArray(restQuat.get(mapped));
        const delta = qRestO.clone().multiply(qRestS.clone().invert()); // q_ourRest * q_srcRest⁻¹
        outVals = new Float32Array(values.length);
        const qa = new THREE.Quaternion();
        // 手臂相关骨：把动画旋转往「静止态」拉回 ARM_KEEP 比例，消除 Idle/Walk 把胳膊甩成 T-pose 的外撇
        // （源 Soldier 手臂偏长，重定向后摆幅被放大；腿/脊柱不动，保证走路仍正常）。
        const isArm = /(shoulder|clavicle|upperarm|lowerarm|forearm|arm|hand|wrist)/i.test(mapped);
        const ARM_KEEP = 0.45;
        for (let k = 0; k < values.length; k += 4) {
          qa.set(values[k], values[k + 1], values[k + 2], values[k + 3]);
          qa.premultiply(qAlign).multiply(qAlignInv); // 共轭预旋转：抵消 alignM 把「动作方向」转 θ（修移动猎奇）
          qa.premultiply(delta);                       // q_ourRest · q_srcRest⁻¹ · (对齐后的动画)
          if (isArm) qa.slerp(qRestO, 1 - ARM_KEEP);   // 拉回静止态，保留 45% 摆幅
          outVals[k] = qa.x; outVals[k + 1] = qa.y; outVals[k + 2] = qa.z; outVals[k + 3] = qa.w;
        }
      } else { // translation
        const pRestS = src.json.nodes[ch.target.node].translation || [0, 0, 0];
        const pRestO = restPos.get(mapped);
        outVals = new Float32Array(values.length);
        for (let k = 0; k < values.length; k += 3) {
          // 只保留竖直起伏：水平方向一律用静止值。
          // 角色位移由物理驱动，动画再带一份水平 root motion 就会「脚在地上滑」。
          outVals[k] = pRestO[0];
          outVals[k + 1] = pRestO[1] + (values[k + 1] - pRestS[1]) * scale;
          outVals[k + 2] = pRestO[2];
        }
      }
      const tAcc = addAccessor(times, 'SCALAR', FLOAT, [[times[0]], [times[times.length - 1]]]);
      const vAcc = addAccessor(outVals, path === 'rotation' ? 'VEC4' : 'VEC3', FLOAT);
      samplers.push({ input: tAcc, output: vAcc, interpolation: samp.interpolation || 'LINEAR' });
      channels.push({ sampler: samplers.length - 1, target: { node: boneNodeIdx[bi], path } });
    }
    outAnims.push({ name: want, samplers, channels });
    console.log(`[anim] ${want}: ${channels.length} tracks（源 ${anim.channels.length}），${frames} 帧`);
  }
  json.animations = outAnims;

  // --- 7. 写文件 ---
  const newBin = Buffer.concat(chunks);
  json.buffers[0].byteLength = newBin.length;
  const out = writeGLB(json, newBin);
  fs.writeFileSync(outPath, out);
  console.log(`[out] ${outPath} ${(out.length / 1024).toFixed(0)} KB（原 glb ${(fs.statSync(glbPath).size / 1024).toFixed(0)} KB）`);
}

async function ensureAnimSource() {
  if (fs.existsSync(ANIM_CACHE)) return;
  console.log('下载动画源:', ANIM_SRC_URL);
  const res = await fetch(ANIM_SRC_URL);
  if (!res.ok) throw new Error('下载失败 ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(ANIM_CACHE, buf);
}

const list = process.argv.slice(2);
for (const g of (list.length ? list : ['boy', 'girl'])) await bake(g);
console.log('\n全部完成');
