// 结构校验（只读 GLB JSON，不实例化 Three 场景）：确认 auto-rig.mjs 产物合法。
import fs from 'fs';
import * as THREE from '../node_modules/three/build/three.module.js';
globalThis.self = globalThis;

const FLOAT = 5126, USHORT = 5123;
const COMPS = { SCALAR: 1, VEC4: 4, MAT4: 16 };
function parseGLB(buf) {
  let off = 12;
  const jl = buf.readUInt32LE(off);
  const json = JSON.parse(buf.toString('utf8', off + 8, off + 8 + jl));
  off += 8 + jl;
  const bl = buf.readUInt32LE(off);
  const bin = Buffer.from(buf.subarray(off + 8, off + 8 + bl));
  return { json, bin };
}
function readRaw(json, bin, idx) {
  const acc = json.accessors[idx];
  const bv = json.bufferViews[acc.bufferView];
  const comps = COMPS[acc.type];
  const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const n = acc.count * comps;
  let out;
  if (acc.componentType === FLOAT) out = new Float32Array(n);
  else if (acc.componentType === USHORT) out = new Uint16Array(n);
  else throw new Error('unsupported ct ' + acc.componentType);
  const cs = acc.componentType === FLOAT ? 4 : 2;
  for (let i = 0; i < acc.count; i++)
    for (let c = 0; c < comps; c++) {
      const at = base + i * comps * cs + c * cs;
      out[i * comps + c] = acc.componentType === FLOAT ? bin.readFloatLE(at) : bin.readUInt16LE(at);
    }
  return out;
}

const genders = process.argv.slice(2).length ? process.argv.slice(2) : ['boy', 'girl'];
for (const g of genders) {
  const { json, bin } = parseGLB(fs.readFileSync(`public/assets/${g}-rig.glb`));
  const prim = json.meshes[0].primitives[0];
  const skin = json.skins[0];
  const nb = skin.joints.length;
  const J = readRaw(json, bin, prim.attributes.JOINTS_0);
  let jmin = 1e9, jmax = -1e9;
  for (const v of J) { if (v < jmin) jmin = v; if (v > jmax) jmax = v; }
  const W = readRaw(json, bin, prim.attributes.WEIGHTS_0);
  let badW = 0;
  for (let i = 0; i < W.length; i += 4) {
    const s = W[i] + W[i + 1] + W[i + 2] + W[i + 3];
    if (Math.abs(s - 1) > 0.02) badW++;
  }
  const IBM = readRaw(json, bin, skin.inverseBindMatrices);
  let badDet = 0;
  for (let i = 0; i < IBM.length; i += 16) {
    const m = new THREE.Matrix4(); m.fromArray(IBM.subarray(i, i + 16));
    const d = m.determinant();
    if (!isFinite(d) || Math.abs(d) < 1e-6) badDet++;
  }
  const animNames = json.animations.map((a) => a.name + ':' + a.channels.length + 'ch').join('  ');
  console.log(`[${g}] joints=${nb} JOINTS[${jmin},${jmax}] WEIGHTS_badSum=${badW} IBM_badDet=${badDet}`);
  console.log(`[${g}] jointNames= ${skin.joints.map((j) => json.nodes[j].name).join(',')}`);
  console.log(`[${g}] anims= ${animNames}`);
}
