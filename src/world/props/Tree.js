// 职责：创建树道具，加载 GLB 模型并按指定坐标放置，失败时降级为绿色方块占位。
import * as THREE from 'three';
import { loadAndAttach, randYaw } from './util.js';

// createTree({x, z}) -> THREE.Group，根节点已定位到 (x, 0, z)，内含朝向随机的树模型。
export function createTree({ x, z }, options = {}) {
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  group.rotation.y = options.rotationY ?? randYaw(x, z);

  const holder = new THREE.Group();
  loadAndAttach(holder, '/assets/tree.glb', {
    scale: 1.6, // 让树在 50x50 场地里比例适中
    color: 0x4a9e4a,
    size: { w: 1.4, h: 3.2, d: 1.4 },
  });
  group.add(holder);

  return group;
}