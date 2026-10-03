// 决定性探针：用 three.js 计算 boy.glb 网格法线，在头部区域找「最朝 ±Z」的顶点，
// 判断角色正面朝 -Z 还是 +Z（从而确定 modelDeg 应为 0 还是 180）。
import fs from 'fs';
import * as THREE from '../node_modules/three/build/three.module.js';
globalThis.self = globalThis;

function parseGLB(buf) {
  let off = 12;
  const jsonLen = buf.readUInt32LE(off);
  const json = JSON.parse(buf.toString('utf8', off + 8, off + 8 + jsonLen));
  off += 8 + jsonLen;
  const binLen = buf.readUInt32LE(off);
  const bin = Buffer.from(buf.subarray(off + 8, off + 8 + binLen));
  return { json, bin };
}
function readF32arr(json, bin, idx) {
  const acc = json.accessors[idx];
  const bv = json.bufferViews[acc.bufferView];
  const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const out = new Float32Array(acc.count * 3);
  for (let i = 0; i < acc.count * 3; i++) out[i] = bin.readFloatLE(base + i * 4);
  return out;
}
function readU16arr(json, bin, idx) {
  const acc = json.accessors[idx];
  const bv = json.bufferViews[acc.bufferView];
  const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const out = new Uint16Array(acc.count);
  for (let i = 0; i < acc.count; i++) out[i] = bin.readUInt16LE(base + i * 2);
  return out;
}

function analyze(path) {
  console.log('\n==== ' + path + ' ====');
  const { json, bin } = parseGLB(fs.readFileSync(path));
  const prim = json.meshes[0].primitives[0];
  const pos = readF32arr(json, bin, prim.attributes.POSITION);
  const vCount = pos.length / 3;
  const idx = prim.indices !== undefined ? readU16arr(json, bin, prim.indices) : null;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  if (idx) geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  const nrm = geo.attributes.normal.array;

  // 头部区域（y 大致 0.28~0.5），找法线最朝 -Z 与最朝 +Z 的顶点
  let mostNegZ = -1e9, mostPosZ = -1e9, nNeg = null, nPos = null;
  let headN = 0, sumNz = 0;
  for (let i = 0; i < vCount; i++) {
    const y = pos[i * 3 + 1];
    if (y < 0.26 || y > 0.52) continue;
    const nz = nrm[i * 3 + 2];
    headN++;
    sumNz += nz;
    if (nz < mostNegZ) { mostNegZ = nz; nNeg = i; }
    if (nz > mostPosZ) { mostPosZ = nz; nPos = i; }
  }
  console.log('  头部顶点数=' + headN + ' 平均法线.z=' + (headN ? (sumNz / headN).toFixed(3) : 'n/a'));
  console.log('  最朝 -Z 的顶点 nz=' + mostNegZ.toFixed(3) + ' pos=' + (nNeg ? [pos[nNeg*3],pos[nNeg*3+1],pos[nNeg*3+2]].map(v=>v.toFixed(3)) : '—'));
  console.log('  最朝 +Z 的顶点 nz=' + mostPosZ.toFixed(3) + ' pos=' + (nPos ? [pos[nPos*3],pos[nPos*3+1],pos[nPos*3+2]].map(v=>v.toFixed(3)) : '—'));
  // 胸腹区域（y 0.0~0.26）同样看
  let cN = 0, cSum = 0;
  for (let i = 0; i < vCount; i++) { const y = pos[i*3+1]; if (y < 0.0 || y > 0.26) continue; cN++; cSum += nrm[i*3+2]; }
  console.log('  胸腹顶点数=' + cN + ' 平均法线.z=' + (cN ? (cSum/cN).toFixed(3) : 'n/a'));
  const headAvg = headN ? sumNz / headN : 0;
  const chestAvg = cN ? cSum / cN : 0;
  console.log('  => 平均法线.z 总体(头 ' + headAvg.toFixed(3) + ' / 胸 ' + chestAvg.toFixed(3) + ')');
  console.log('     若正面朝 -Z：头/胸平均法线.z 应明显 < 0（脸朝 -Z）；若朝 +Z 应 > 0。');
}

analyze(process.argv[2] || 'public/assets/boy.glb');
