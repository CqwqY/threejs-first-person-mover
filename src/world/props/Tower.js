// 职责：创建水塔地标道具，加载 GLB 模型并按指定坐标放置，失败时降级为灰色高柱占位。
import * as THREE from 'three';
import { loadAndAttach, randYaw } from './util.js';

// createTower({x, z}) -> THREE.Group，根节点已定位到 (x, 0, z)，作为街区高耸地标。
export function createTower({ x, z }, options = {}) {
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  group.rotation.y = options.rotationY ?? randYaw(x, z);

  const holder = new THREE.Group();
  loadAndAttach(holder, '/assets/watertower.glb', {
    scale: 1.5, // 水塔放大到约 5m 高，形成高点地标
    color: 0x6a6a6a,
    size: { w: 3, h: 5.5, d: 3 },
  });
  group.add(holder);

  return group;
}