// 职责：创建路灯道具，加载 GLB 模型并按指定坐标放置，失败时降级为灰色细长方块占位。
import * as THREE from 'three';
import { loadAndAttach, randYaw } from './util.js';

// createLamp({x, z}) -> THREE.Group，根节点已定位到 (x, 0, z)，内含朝向随机的路灯模型。
export function createLamp({ x, z }, options = {}) {
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  group.rotation.y = options.rotationY ?? randYaw(x, z);

  const holder = new THREE.Group();
  loadAndAttach(holder, '/assets/lamp.glb', {
    scale: 3.5, // 路灯放大约 3.4m 高，符合街道路灯比例
    color: 0x666666,
    size: { w: 0.9, h: 3.4, d: 0.9 },
  });
  group.add(holder);

  return group;
}