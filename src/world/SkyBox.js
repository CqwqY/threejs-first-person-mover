// 职责：创建程序化天空盒（Three.js 内置 Sky，无需外部贴图，离线可用）。
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

// createSky(scene, opts)：生成天空 + 模拟太阳，挂到场景。
// opts: { elevation, azimuth, turbidity, rayleigh, mieCoefficient, mieDirectionalG }
export function createSky(scene, opts = {}) {
  const sky = new Sky();
  sky.scale.setScalar(400); // 足够大，包裹整个场景，且小于相机 far 避免被裁剪

  const uniforms = sky.material.uniforms;
  uniforms.turbidity.value = opts.turbidity ?? 8;
  uniforms.rayleigh.value = opts.rayleigh ?? 2;
  uniforms.mieCoefficient.value = opts.mieCoefficient ?? 0.005;
  uniforms.mieDirectionalG.value = opts.mieDirectionalG ?? 0.8;

  // 太阳位置由仰角/方位角换算为方向向量
  const elevation = opts.elevation ?? 15;
  const azimuth = opts.azimuth ?? 200;
  const phi = THREE.MathUtils.degToRad(90 - elevation);
  const theta = THREE.MathUtils.degToRad(azimuth);
  const sunDir = new THREE.Vector3(
    Math.sin(phi) * Math.cos(theta),
    Math.cos(phi),
    Math.sin(phi) * Math.sin(theta)
  );

  // 让太阳朝向光照方向（天空盒材质的太阳矢量）
  uniforms.sunPosition.value.copy(sunDir);

  scene.add(sky);
  return sky;
}