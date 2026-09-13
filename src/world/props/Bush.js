// 职责：创建灌木丛道具，加载 GLB 模型并按指定坐标放置，失败时降级为绿色小方块占位。
import * as THREE from 'three';
import { loadAndAttach, randYaw } from './util.js';

// createBush({x, z}) -> THREE.Group，根节点已定位到 (x, 0, z)，内含朝向随机的灌木模型。
export function createBush({ x, z }, options = {}) {
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  group.rotation.y = options.rotationY ?? randYaw(x, z);

  const holder = new THREE.Group();
  loadAndAttach(holder, '/assets/bush.glb', {
    scale: 1.4, // 灌木约 1m 宽 0.8m 高，贴近道路边缘妆点绿地
    color: 0x2f7d47,
    size: { w: 1.2, h: 0.8, d: 1.2 },
  });
  group.add(holder);

  return group;
}