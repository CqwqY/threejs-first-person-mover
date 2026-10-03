// 只读探针：加载烘焙产物，打印「静止姿态」（不播放任何动画）下关键骨骼世界坐标，
// 用来判断骨骼静止姿态是不是 T-pose（手臂外张）。只解析、不写盘、不连网。
import fs from 'fs';
globalThis.self = globalThis;
import * as THREE from '../node_modules/three/build/three.module.js';
import { GLTFLoader } from '../node_modules/three/examples/jsm/loaders/GLTFLoader.js';

const files = process.argv.slice(2);
const fake = { load: () => new THREE.Texture() };
for (const file of files) {
  const buf = fs.readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
  const manager = new THREE.LoadingManager();
  manager.addHandler(/\.(png|jpg|jpeg|webp)$/i, fake);
  const loader = new GLTFLoader(manager);
  loader.parse(ab, '', (gltf) => {
    const scene = gltf.scene;
    let skinned = null;
    scene.traverse((o) => { if (o.isSkinnedMesh) skinned = o; });
    scene.updateMatrixWorld(true);
    const W = (n) => { const b = skinned.skeleton.getBoneByName(n); const v = new THREE.Vector3(); b.getWorldPosition(v); return v; };
    const f = (v) => `(${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)})`;
    const hips = W('mixamorigHips');
    console.log(`\n=== ${file} ===`);
    console.log(`  hips=${f(hips)} 头=${f(W('mixamorigHead'))}`);
    console.log(`  左手=${f(W('mixamorigLeftHand'))} 右手=${f(W('mixamorigRightHand'))}  (髋x=${hips.x.toFixed(2)})`);
    console.log(`  左臂展(手x-髋x)=${(W('mixamorigLeftHand').x - hips.x).toFixed(2)}  右臂展=${(W('mixamorigRightHand').x - hips.x).toFixed(2)}`);
    console.log(`  左脚=${f(W('mixamorigLeftFoot'))} 右脚=${f(W('mixamorigRightFoot'))}`);
  }, (e) => console.log('!!', file, e && (e.message || e)));
}
