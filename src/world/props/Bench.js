// 职责：创建长椅道具，加载 GLB 模型并按指定坐标放置，失败时降级为棕色方块占位。
import * as THREE from 'three';
import { loadAndAttach, randYaw } from './util.js';

// createBench({x, z}) -> THREE.Group，根节点已定位到 (x, 0, z)，内含朝向随机的长椅模型。
export function createBench({ x, z }, options = {}) {
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  group.rotation.y = options.rotationY ?? randYaw(x, z);

  const holder = new THREE.Group();
  loadAndAttach(holder, '/assets/bench.glb', {
    scale: 4.5, // 长椅原始模型很小，放大到约 1.8m 宽 0.45m 高
    color: 0x8d6e63,
    size: { w: 1.8, h: 0.45, d: 0.7 },
  });
  group.add(holder);

  return group;
}