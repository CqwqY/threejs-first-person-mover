// 只读诊断：纯 fs 解析 glb json，检查 animations 通道结构是否会让 GLTFLoader/AnimationMixer 崩溃。
import fs from 'fs';
function parseGLB(buf) {
  let off = 12;
  const jsonLen = buf.readUInt32LE(off);
  const json = JSON.parse(buf.toString('utf8', off + 8, off + 8 + jsonLen));
  off += 8 + jsonLen;
  const binLen = buf.readUInt32LE(off);
  const bin = Buffer.from(buf.subarray(off + 8, off + 8 + binLen));
  return { json, bin, binLen };
}
const f = process.argv[2];
const { json, bin, binLen } = parseGLB(fs.readFileSync(f));
console.log('nodes', json.nodes.length, 'meshes', json.meshes.length, 'skins', (json.skins || []).length, 'anims', (json.animations || []).length, 'bin', binLen);
(json.animations || []).forEach((a) => {
  console.log('\nANIM', a.name, 'channels', a.channels.length, 'samplers', a.samplers.length);
  const paths = {};
  a.channels.forEach((ch) => {
    paths[ch.target.path] = (paths[ch.target.path] || 0) + 1;
    const n = json.nodes[ch.target.node];
    if (n === undefined) console.log('  !! target.node', ch.target.node, 'OUT OF RANGE');
    else if (!n.name) console.log('  !! node', ch.target.node, 'NAME EMPTY -> trackName 会变 undefined -> split 崩溃');
  });
  console.log('  paths:', JSON.stringify(paths));
  a.samplers.forEach((s, i) => {
    for (const [k, ai] of [['input', s.input], ['output', s.output]]) {
      const acc = json.accessors[ai];
      if (!acc) { console.log('  !! sampler', i, k, 'accessor', ai, 'MISSING'); continue; }
      const bv = json.bufferViews[acc.bufferView];
      if (!bv) { console.log('  !! accessor', ai, 'NO bufferView'); continue; }
      const end = (bv.byteOffset || 0) + (bv.byteLength || 0);
      if (end > binLen) console.log('  !! accessor', ai, 'bufferView OOB', end, '>', binLen);
    }
  });
});
