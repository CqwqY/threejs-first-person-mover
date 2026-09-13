// 职责：创建建筑道具，加载 GLB 模型并按指定坐标放置，失败时降级为褐色方块占位。
import * as THREE from 'three';
import { loadAndAttach, randYaw } from './util.js';

// createBuilding({x, z}) -> THREE.Group，根节点已定位到 (x, 0, z)，内含朝向随机的建筑模型。
export function createBuilding({ x, z }, options = {}) {
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  group.rotation.y = options.rotationY ?? randYaw(x, z);

  const holder = new THREE.Group();
  loadAndAttach(holder, '/assets/building.glb', {
    scale: 2.0, // 建筑比玩家高，比例放大
    color: 0xb57c5a,
    size: { w: 4, h: 5, d: 4 },
  });
  group.add(holder);

  return group;
}