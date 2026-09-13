// 职责：创建指定 GLB 的建筑变体（不同造型/车库），用于批量铺设街区，失败时降级为对应色方块占位。
import * as THREE from 'three';
import { loadAndAttach } from './util.js';

// createBuildingVar({x, z}, {url, scale, size, color, rotationY}) -> THREE.Group，读配置加载对应建筑素材。
// url 为 /assets/ 下的文件名，scale/size/color 决定模型比例与失败占位外观，避免重复为每种建筑写工厂。
export function createBuildingVar({ x, z }, options = {}) {
  const {
    url = 'building-small-a.glb',
    scale = 1.8,
    size = { w: 3, h: 6, d: 3 },
    color = 0xb57c5a,
    rotationY = undefined,
  } = options;

  const group = new THREE.Group();
  group.position.set(x, 0, z);
  group.rotation.y = rotationY ?? Math.PI / 4; // 建筑朝向统一转 45°，让立面正对街口

  const holder = new THREE.Group();
  loadAndAttach(holder, `/assets/${url}`, {
    scale,
    color,
    size,
  });
  group.add(holder);

  return group;
}