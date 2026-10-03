// 只读几何探针：加载带贴图的原 GLB（不加载贴图纹理），打印 AABB、Y 高度分层直方图，
// 用于确定程序化骨架放置参考（髋/膝/肩/肘高度、左右对称切分、臂展/腿间距）。
import fs from 'fs';
import * as THREE from '../node_modules/three/build/three.module.js';
import { GLTFLoader } from '../node_modules/three/examples/jsm/loaders/GLTFLoader.js';
globalThis.self = globalThis; // Node 下 GLTFLoader 需要 self 全局

const file = process.argv[2];
if (!file) { console.log('usage: node tools/probe-geom.mjs <model.glb>'); process.exit(1); }

const buf = fs.readFileSync(file);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
const mgr = new THREE.LoadingManager();
// 跳过贴图加载，避免依赖网络/解码
mgr.addHandler(/\.(png|jpg|jpeg|webp|ktx2|webp)$/i, { load: () => new THREE.Texture() });

new GLTFLoader(mgr).parse(ab, '', (g) => {
  const scene = g.scene || g;
  let mesh = null, meshes = [];
  scene.traverse((o) => { if (o.isMesh) { mesh = o; meshes.push(o); } });
  if (!mesh) { console.log('无 mesh'); return; }
  const geo = mesh.geometry;
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  console.log('FILE', file);
  console.log('meshes', meshes.length, 'verts', geo.attributes.position.count,
    'hasUV', !!geo.attributes.uv, 'hasNormal', !!geo.attributes.normal,
    'skinning', !!geo.attributes.skinIndex);
  console.log('material', mesh.material && (mesh.material.name || mesh.material.type),
    'hasMap', !!(mesh.material && mesh.material.map));
  console.log('AABB min', bb.min.x.toFixed(3), bb.min.y.toFixed(3), bb.min.z.toFixed(3));
  console.log('AABB max', bb.max.x.toFixed(3), bb.max.y.toFixed(3), bb.max.z.toFixed(3));
  const pos = geo.attributes.position;
  const H = 24;
  const ymin = bb.min.y, ymax = bb.max.y, span = (ymax - ymin) || 1;
  const layers = [];
  for (let i = 0; i < H; i++) layers.push({ minx: 1e9, maxx: -1e9, minz: 1e9, maxz: -1e9, n: 0, mid: 0 });
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let h = Math.floor((y - ymin) / span * H);
    h = Math.max(0, Math.min(H - 1, h));
    const L = layers[h];
    L.minx = Math.min(L.minx, x); L.maxx = Math.max(L.maxx, x);
    L.minz = Math.min(L.minz, z); L.maxz = Math.max(L.maxz, z);
    L.n++;
  }
  console.log('Y layers (bottom->top), n=顶点数, x[z] 为该层水平范围:');
  for (let i = 0; i < H; i++) {
    const y0 = ymin + (i / H) * span, y1 = ymin + ((i + 1) / H) * span;
    const L = layers[i];
    const tag = L.n > 0 ? `[${L.minx.toFixed(2)},${L.maxx.toFixed(2)}] z[${L.minz.toFixed(2)},${L.maxz.toFixed(2)}]` : 'empty';
    console.log(`  y[${y0.toFixed(2)},${y1.toFixed(2)}] n=${String(L.n).padStart(5)} ${tag}`);
  }
}, (e) => { console.log('ERR', e && (e.message || e)); });
