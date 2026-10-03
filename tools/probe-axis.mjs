// 朝向轴探针（只读）：算出 rig.glb 里
//   ① 网格的「正面」方向（头部/脚部最突出点的水平方向）
//   ② 骨骼的左右轴（l_hip - r_hip）
//   ③ 走路动画的摆腿主轴（踝相对髋的水平位移哪个轴变化大）
// 三者都换算成「水平面角度(度, atan2(z,x))」，差 90° 就是网格与骨架不同向。
import fs from 'fs';
import * as THREE from '../node_modules/three/build/three.module.js';
import { GLTFLoader } from '../node_modules/three/examples/jsm/loaders/GLTFLoader.js';
globalThis.self = globalThis;

const file = process.argv[2] || 'public/assets/boy-rig.glb';
const buf = fs.readFileSync(file);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
const mgr = new THREE.LoadingManager();
mgr.addHandler(/\.(png|jpg|jpeg|webp)$/i, { load: () => new THREE.Texture() });
const deg = (x, z) => (Math.atan2(z, x) * 180 / Math.PI).toFixed(1);

new GLTFLoader(mgr).parse(ab, '', (g) => {
  const scene = g.scene;
  let sm = null;
  scene.traverse((o) => { if (o.isSkinnedMesh) sm = o; });
  if (!sm) { console.log('no skinnedmesh'); return; }
  const geo = sm.geometry;
  const pos = geo.attributes.position;
  const n = pos.count;
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const h = bb.max.y - bb.min.y;
  console.log('FILE', file, ' verts=', n);
  console.log(`AABB  x[${bb.min.x.toFixed(3)}, ${bb.max.x.toFixed(3)}]  y[${bb.min.y.toFixed(3)}, ${bb.max.y.toFixed(3)}]  z[${bb.min.z.toFixed(3)}, ${bb.max.z.toFixed(3)}]`);

  // 某个 Y 带里，「离质心最远」的顶点方向 = 该部位最突出的方向
  function extremeDir(yLo, yHi, label) {
    const v = new THREE.Vector3();
    let cx = 0, cz = 0, cnt = 0;
    for (let i = 0; i < n; i++) { v.fromBufferAttribute(pos, i); if (v.y >= yLo && v.y <= yHi) { cx += v.x; cz += v.z; cnt++; } }
    if (!cnt) { console.log(label, 'no verts'); return null; }
    cx /= cnt; cz /= cnt;
    let best = null, bestD = -1;
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(pos, i);
      if (v.y < yLo || v.y > yHi) continue;
      const d = Math.hypot(v.x - cx, v.z - cz);
      if (d > bestD) { bestD = d; best = { dx: v.x - cx, dz: v.z - cz }; }
    }
    const L = Math.hypot(best.dx, best.dz) || 1;
    const bx = best.dx / L, bz = best.dz / L;
    console.log(`${label}  方向(x,z)=(${bx.toFixed(3)}, ${bz.toFixed(3)})  ang=${deg(bx, bz)}°  r=${bestD.toFixed(3)}`);
    return { ang: Math.atan2(bz, bx) * 180 / Math.PI };
  }
  const headAng = extremeDir(bb.max.y - h * 0.13, bb.max.y, 'HEAD 最突点');
  const footAng = extremeDir(bb.min.y, bb.min.y + h * 0.09, 'FOOT 最突点');

  // 按高度分层，打印每层的 X/Z 跨度与质心：人形「左右」跨度应明显大于「前后」，
  // 由此判定左右轴到底是 X 还是 Z。
  {
    const v = new THREE.Vector3();
    console.log('--- 每层跨度（Y 从下往上） ---');
    for (let b = 0; b < 10; b++) {
      const yLo = bb.min.y + h * (b / 10), yHi = bb.min.y + h * ((b + 1) / 10);
      let xMin = 1e9, xMax = -1e9, zMin = 1e9, zMax = -1e9, cx = 0, cz = 0, c = 0;
      for (let i = 0; i < n; i++) {
        v.fromBufferAttribute(pos, i);
        if (v.y < yLo || v.y >= yHi) continue;
        if (v.x < xMin) xMin = v.x; if (v.x > xMax) xMax = v.x;
        if (v.z < zMin) zMin = v.z; if (v.z > zMax) zMax = v.z;
        cx += v.x; cz += v.z; c++;
      }
      if (!c) continue;
      cx /= c; cz /= c;
      const sx = xMax - xMin, sz = zMax - zMin;
      console.log(`Y[${yLo.toFixed(2)},${yHi.toFixed(2)}]  Xspan=${sx.toFixed(3)}  Zspan=${sz.toFixed(3)}   ${sx > sz ? 'X更宽→左右可能是X' : 'Z更宽→左右可能是Z'}   质心(x ${cx.toFixed(3)}, z ${cz.toFixed(3)})`);
    }
  }

  // 骨骼
  const bones = {};
  sm.skeleton.bones.forEach((b) => { bones[b.name] = b; });
  const wp = (nm) => { const v = new THREE.Vector3(); if (bones[nm]) bones[nm].getWorldPosition(v); return v; };
  scene.updateMatrixWorld(true);
  const lh = wp('l_hip'), rh = wp('r_hip');
  console.log(`HIPS 左右轴 (l-r)=(x ${(lh.x - rh.x).toFixed(3)}, z ${(lh.z - rh.z).toFixed(3)})  ang=${deg(lh.x - rh.x, lh.z - rh.z)}°  (垂直它的方向 = 骨架前后轴, ang ${deg(-(lh.z - rh.z), lh.x - rh.x)}°)`);

  // 走路摆腿主轴
  const walk = g.animations.find((c) => /walk/i.test(c.name));
  if (walk) {
    const mixer = new THREE.AnimationMixer(scene);
    mixer.clipAction(walk).play();
    const xs = [], zs = [];
    for (let k = 0; k <= 24; k++) {
      mixer.setTime((k / 24) * walk.duration);
      scene.updateMatrixWorld(true);
      const a = wp('l_ankle'), hip = wp('hips');
      xs.push(a.x - hip.x); zs.push(a.z - hip.z);
    }
    const rng = (arr) => Math.max(...arr) - Math.min(...arr);
    const rx = rng(xs), rz = rng(zs);
    console.log(`WALK 左踝相对髋的位移范围: X=${rx.toFixed(3)}  Z=${rz.toFixed(3)}  => 摆腿主轴 = ${rz > rx ? 'Z' : 'X'}`);
  } else {
    console.log('WALK 动画缺失');
  }
  console.log('--- 判读: 若 HEAD/FOOT 的方向与「HIPS 前后轴」相差 ~90°, 则网格与骨架不同向 ---');
}, (e) => console.log('ERR', e && (e.message || e)));
