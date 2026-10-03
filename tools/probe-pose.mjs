// 只读探针：加载烘焙产物，打印 Idle（待机）动画在第 0 帧与中点的关键骨骼世界坐标，
// 用来判断「默认站姿」是否正常（手臂应在身体两侧 x≈±0.2、z≈0，而不是平举成 T-pose x≈±0.3）。
// 只解析、不写盘，不连网。用法：node tools/probe-pose.mjs public/assets/boy-rig.glb
import fs from 'fs';
globalThis.self = globalThis;
import * as THREE from '../node_modules/three/build/three.module.js';
import { GLTFLoader } from '../node_modules/three/examples/jsm/loaders/GLTFLoader.js';

process.on('uncaughtException', (e) => { console.error('UNCAUGHT:', (e && e.stack) || e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('UNHANDLED:', (e && (e.stack || e))); process.exit(1); });

const file = process.argv[2];
const buf = fs.readFileSync(file);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const fake = { load: (url, onLoad) => onLoad(new THREE.Texture()) };
const manager = new THREE.LoadingManager();
manager.addHandler(/\.(png|jpg|jpeg|webp)$/i, fake);
const loader = new GLTFLoader(manager);

loader.parse(ab, '', (gltf) => {
  const scene = gltf.scene;
  let skinned = null;
  scene.traverse((o) => { if (o.isSkinnedMesh) skinned = o; });
  const sk = skinned.skeleton;
  const W = (n) => { const b = sk.getBoneByName(n); const v = new THREE.Vector3(); b.getWorldPosition(v); return v; };
  // 看「可见网格」的真实手臂范围：取受 Arm/Hand 骨主导的顶点，算世界包围盒（骨骼位置会骗人，网格才是肉眼看到的）
  function limbExtent(keyword) {
    const geo = skinned.geometry;
    const pos = geo.attributes.position;
    const jt = geo.attributes.skinIndex || geo.attributes.JOINTS_0;
    const wt = geo.attributes.skinWeight || geo.attributes.WEIGHTS_0;
    const box = new THREE.Box3();
    let n = 0;
    for (let i = 0; i < pos.count; i++) {
      let dom = -1, domw = 0;
      for (let k = 0; k < 4; k++) { if (wt.getComponent(i, k) > domw) { domw = wt.getComponent(i, k); dom = jt.getComponent(i, k); } }
      const bname = sk.bones[dom] && sk.bones[dom].name;
      if (bname && bname.toLowerCase().includes(keyword.toLowerCase())) {
        const v = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(skinned.matrixWorld);
        box.expandByPoint(v); n++;
      }
    }
    return { n, box };
  }
  scene.updateMatrixWorld(true);
  const la = limbExtent('leftarm'), ra = limbExtent('rightarm'), ll = limbExtent('leftupleg'), rl = limbExtent('rightupleg');
  console.log(`  可见手臂顶点: 左${la.n} 右${ra.n}  左臂x[${la.box.min.x.toFixed(2)},${la.box.max.x.toFixed(2)}] 右臂x[${ra.box.min.x.toFixed(2)},${ra.box.max.x.toFixed(2)}]`);
  console.log('===', file, 'idle=', !!gltf.animations.find(a => /idle/i.test(a.name)),
    'names=', gltf.animations.map(a => a.name).join(','));
  for (const clipName of ['Idle', 'Walk']) {
    const clip = gltf.animations.find((a) => a.name === clipName);
    if (!clip) { console.log(`-- 无 ${clipName}`); continue; }
    const mixer = new THREE.AnimationMixer(scene);
    const act = mixer.clipAction(clip);
    act.play();
    const target = (clipName === 'Idle') ? [0, 0.25, 0.5] : [0, 0.5];
    for (const frac of target) {
      mixer.setTime(clip.duration * frac);
      scene.updateMatrixWorld(true);
      const hips = W('mixamorigHips'), lh = W('mixamorigLeftHand'), rh = W('mixamorigRightHand'),
        lf = W('mixamorigLeftFoot'), rf = W('mixamorigRightFoot'), head = W('mixamorigHead');
      const f = (v) => `(${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)})`;
      console.log(`  ${clipName} t=${frac.toFixed(2)}  hips=${f(hips)} 头=${f(head)}`);
      console.log(`    左手=${f(lh)} 右手=${f(rh)}  左脚=${f(lf)} 右脚=${f(rf)}`);
      // 手臂是否平举：左手 x 与髋 x 的差（正值且接近肩宽=平举 T-pose；小值=垂在两侧）
      console.log(`    臂展(左手x-髋x)=${(lh.x - hips.x).toFixed(2)}  (右手x-髋x)=${(rh.x - hips.x).toFixed(2)}  手前后(左手z-髋z)=${(lh.z - hips.z).toFixed(2)}`);
    }
  }
}, (e) => console.log('!! parse 失败:', (e && (e.stack || e.message)) || e));
