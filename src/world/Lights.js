// 职责：创建场景光照（环境光 + 方向光）。仅负责灯光节点。
import * as THREE from 'three';

export function createLights() {
  const group = new THREE.Group();

  // 环境光：提供全局均匀的底色照明，避免全黑
  const ambient = new THREE.AmbientLight(0xffffff, 0.6);
  group.add(ambient);

  // 方向光：模拟太阳，带明显明暗对比
  const directional = new THREE.DirectionalLight(0xffffff, 1.0);
  directional.position.set(20, 30, 10);
  group.add(directional);

  // 可选：开启方向光阴影（本次先不渲染阴影以保持简洁）
  // directional.castShadow = true;

  return group;
}