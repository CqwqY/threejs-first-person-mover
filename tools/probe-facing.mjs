// 只读探针：打印 GLB 的节点树（含 transform）与网格包围盒，
// 判断 boy/girl 原始模型（及 rig 版）的正面朝向，定位「逆时针偏 90 度」的根因。
import fs from 'fs';

function parseGLB(buf) {
  let off = 12;
  const jsonLen = buf.readUInt32LE(off);
  const json = JSON.parse(buf.toString('utf8', off + 8, off + 8 + jsonLen));
  off += 8 + jsonLen;
  const binLen = buf.readUInt32LE(off);
  const bin = Buffer.from(buf.subarray(off + 8, off + 8 + binLen));
  return { json, bin };
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

function dump(path) {
  console.log('\n=================== ' + path + ' ===================');
  const { json, bin } = parseGLB(fs.readFileSync(path));
  const nodes = json.nodes;
  const childMap = nodes.map(() => []);
  nodes.forEach((n, i) => (n.children || []).forEach((c) => childMap[c].push(i)));
  // 根节点 = 没有被任何节点当作 child 的
  const isChild = new Array(nodes.length).fill(false);
  nodes.forEach((n) => (n.children || []).forEach((c) => (isChild[c] = true)));
  const roots = nodes.map((_, i) => i).filter((i) => !isChild[i]);

  const quatToEuler = (q) => {
    if (!q) return '(none)';
    const [x, y, z, w] = q;
    const sinrCosp = 2 * (w * x + y * z);
    const cosrCosp = 1 - 2 * (x * x + y * y);
    const roll = Math.atan2(sinrCosp, cosrCosp);
    const sinp = 2 * (w * y - z * x);
    const pitch = Math.abs(sinp) >= 1 ? (Math.sign(sinp) * Math.PI) / 2 : Math.asin(sinp);
    const sinyCosp = 2 * (w * z + x * y);
    const cosyCosp = 1 - 2 * (y * y + z * z);
    const yaw = Math.atan2(sinyCosp, cosyCosp);
    const d = (r) => (r * 180 / Math.PI).toFixed(1);
    return `euler(yaw=${d(yaw)} pitch=${d(pitch)} roll=${d(roll)}) quat=[${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)},${w.toFixed(3)}]`;
  };

  const walk = (i, depth) => {
    const n = nodes[i];
    const t = n.translation ? `[${n.translation.map((v) => v.toFixed(3)).join(',')}]` : '';
    const r = n.rotation ? quatToEuler(n.rotation) : '';
    const s = n.scale ? `[${n.scale.map((v) => v.toFixed(3)).join(',')}]` : '';
    const tag = n.mesh !== undefined ? ' [MESH#' + n.mesh + ']' : '';
    const skin = n.skin !== undefined ? ' [SKIN#' + n.skin + ']' : '';
    console.log('  '.repeat(depth) + `- ${n.name || '(anon)'} t=${t} ${r} ${s}${tag}${skin}`);
    (n.children || []).forEach((c) => walk(c, depth + 1));
  };
  roots.forEach((r) => walk(r, 0));

  // 网格包围盒（mesh 局部空间，未应用节点 transform）
  if (json.meshes && json.meshes[0]) {
    const prim = json.meshes[0].primitives[0];
    if (prim.attributes && prim.attributes.POSITION !== undefined) {
      const pos = readF32(json, bin, prim.attributes.POSITION);
      let min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9];
      for (let i = 0; i < pos.length; i += 3) {
        for (let c = 0; c < 3; c++) {
          const v = pos[i + c];
          if (v < min[c]) min[c] = v;
          if (v > max[c]) max[c] = v;
        }
      }
      const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
      const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
      console.log('  [bbox mesh-local] min=' + min.map((v) => v.toFixed(3)) + ' max=' + max.map((v) => v.toFixed(3)));
      console.log('  [bbox size] X=' + size[0].toFixed(3) + ' Y=' + size[1].toFixed(3) + ' Z=' + size[2].toFixed(3) + '  (Y 应为身高方向)');
      console.log('  [bbox center] ' + center.map((v) => v.toFixed(3)));
    }
  }
  // 找到 mesh 节点，打印它到根的路径上的所有 transform（决定世界朝向）
  const meshNodeIdx = nodes.findIndex((n) => n.mesh !== undefined);
  if (meshNodeIdx >= 0) {
    // 反向追溯父链
    const parentOf = nodes.map((n) => (n.children || []).map((c) => c));
    const parent = new Array(nodes.length).fill(-1);
    nodes.forEach((n, i) => (n.children || []).forEach((c) => (parent[c] = i)));
    const chain = [];
    let cur = meshNodeIdx;
    while (cur >= 0) { chain.unshift(cur); cur = parent[cur]; }
    console.log('  [mesh node chain to root] ' + chain.map((i) => nodes[i].name || '(anon)').join(' -> '));
  }
}

dump(process.argv[2] || 'public/assets/boy.glb');
if (process.argv[3]) dump(process.argv[3]);
