// 姿态探针：加载 rig.glb，用 AnimationMixer 采样 Bind / Idle / Walk 各相位下关键骨的世界坐标，
// 用以确认：① 直立对称（无侧躺）② 走路是腿绕 X 前后摆（z 反相变化）而非侧向甩（x 大幅变化）。
import fs from 'fs';
import * as THREE from '../node_modules/three/build/three.module.js';
import { GLTFLoader } from '../node_modules/three/examples/jsm/loaders/GLTFLoader.js';
globalThis.self = globalThis;

const file = process.argv[2];
if (!file) { console.log('usage: node tools/probe-rig.mjs <rig.glb>'); process.exit(1); }
const buf = fs.readFileSync(file);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
const mgr = new THREE.LoadingManager();
mgr.addHandler(/\.(png|jpg|jpeg|webp)$/i, { load: () => new THREE.Texture() });

new GLTFLoader(mgr).parse(ab, '', (g) => {
  const scene = g.scene;
  let sm = null;
  scene.traverse((o) => { if (o.isSkinnedMesh) sm = o; });
  if (!sm) { console.log('no skinnedmesh'); return; }
  const mixer = new THREE.AnimationMixer(scene);
  const find = (kw) => g.animations.find((c) => new RegExp(kw, 'i').test(c.name));
  const walk = find('walk'), idle = find('idle');
  const bones = {};
  sm.skeleton.bones.forEach((b) => { bones[b.name] = b; });
  const get = (n) => { const v = new THREE.Vector3(); (bones[n] || { getWorldPosition() {} }).getWorldPosition(v); return v; };
  const NAMES = ['hips', 'l_hip', 'r_hip', 'l_knee', 'r_knee', 'l_shoulder', 'r_shoulder', 'chest', 'head'];
  function dump(label) {
    scene.updateMatrixWorld(true);
    console.log(label, NAMES.map((n) => {
      const v = get(n); return `${n}(${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)})`;
    }).join(' '));
  }
  console.log('FILE', file, 'dur walk=', walk && walk.duration, 'idle=', idle && idle.duration);
  dump('BIND  ');
  if (walk) {
    mixer.clipAction(walk).play();
    for (const s of [0, 0.25, 0.5, 0.75]) { mixer.setTime(s * walk.duration); dump('WALK s=' + s); }
  }
  if (idle) {
    const ia = mixer.clipAction(idle); ia.play(); mixer.setTime(0);
    // idle 幅度很小，只看 bind 与 idle 差异即可
    dump('IDLE s=0');
  }
}, (e) => console.log('ERR', e && (e.message || e)));
