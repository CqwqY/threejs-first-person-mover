// 职责：创建喷泉道具，加载 GLB 模型并按指定坐标放置，失败时降级为蓝色方块占位。
import * as THREE from 'three';
import { loadAndAttach } from './util.js';

// createFountain({x, z}) -> THREE.Group，根节点已定位到 (x, 0, z)，放置在广场中央。
export function createFountain({ x, z }, options = {}) {
  const group = new THREE.Group();
  group.position.set(x, 0, z);

  const holder = new THREE.Group();
  loadAndAttach(holder, '/assets/fountain.glb', {
    scale: 3.0, // 广场中央喷泉，放大到约 3m 宽 1.6m 高
    color: 0x7aa3c9,
    size: { w: 3, h: 1.6, d: 3 },
  });
  group.add(holder);

  return group;
}