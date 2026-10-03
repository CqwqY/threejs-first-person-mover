// 验证烘焙产物：GLTFLoader 能否解析、动画是否真在驱动骨骼
import fs from 'fs';
globalThis.self = globalThis; // three 里有些模块探测 self（WorkerPool 等），Node 下补一个
import * as THREE from '../node_modules/three/build/three.module.js';
import { GLTFLoader } from '../node_modules/three/examples/jsm/loaders/GLTFLoader.js';

const file = process.argv[2];
const buf = fs.readFileSync(file);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

// 假纹理加载器：Node 里没有 Image，只要是贴图就塞一张空 Texture（本脚本只验证骨架/动画）
const fake = { load: (url, onLoad) => onLoad(new THREE.Texture()) };
const manager = new THREE.LoadingManager();
manager.addHandler(/\.(png|jpg|jpeg|webp)$/i, fake);
const loader = new GLTFLoader(manager);

loader.parse(ab, '', (gltf) => {
  const scene = gltf.scene;
  let skinned = null;
  const bones = [];
  scene.traverse((o) => { if (o.isSkinnedMesh) skinned = o; if (o.isBone) bones.push(o); });
  console.log('===', file);
  console.log('animations:', gltf.animations.map((a) => `${a.name}(${a.duration.toFixed(2)}s/${a.tracks.length}tracks)`).join(' '));
  console.log('skinnedMesh:', !!skinned, 'bones:', bones.length, 'verts:', skinned && skinned.geometry.attributes.position.count);
  console.log('hasUV:', !!(skinned && skinned.geometry.attributes.uv), 'hasMap:', !!(skinned && skinned.material && skinned.material.map));
  const box = new THREE.Box3().setFromObject(scene);
  console.log('bind pose bbox y:', box.min.y.toFixed(3), '->', box.max.y.toFixed(3), ' x:', box.min.x.toFixed(3), box.max.x.toFixed(3), ' z:', box.min.z.toFixed(3), box.max.z.toFixed(3));

  const walk = gltf.animations.find((a) => a.name === 'Walk');
  if (!walk) { console.log('!! 没有 Walk 动画'); return; }
  const mixer = new THREE.AnimationMixer(scene);
  const act = mixer.clipAction(walk);
  act.play();
  const footL = skinned.skeleton.getBoneByName('mixamorigLeftFoot');
  const footR = skinned.skeleton.getBoneByName('mixamorigRightFoot');
  const handL = skinned.skeleton.getBoneByName('mixamorigLeftHand');
  const v = new THREE.Vector3();
  console.log('--- 播放 Walk，看四肢有没有真的在动（世界坐标）---');
  for (let f = 0; f <= 8; f++) {
    mixer.update(walk.duration / 8);
    scene.updateMatrixWorld(true);
    const l = footL.getWorldPosition(v).clone();
    const r = footR.getWorldPosition(v).clone();
    const h = handL.getWorldPosition(v).clone();
    console.log(`  t=${(f / 8).toFixed(2)}  左脚 y=${l.y.toFixed(3)} z=${l.z.toFixed(3)}   右脚 y=${r.y.toFixed(3)} z=${r.z.toFixed(3)}   左手 y=${h.y.toFixed(3)} z=${h.z.toFixed(3)}`);
  }
  const b2 = new THREE.Box3().setFromObject(skinned);
  console.log('动画中 bbox y:', b2.min.y.toFixed(3), '->', b2.max.y.toFixed(3));
}, (e) => {
  console.log('!! parse 失败:', e && (e.message || e));
});
