// 职责：按布局把 5 类道具（树/建筑/喷泉/路灯/长椅）放置到主城地面并加入场景。布局坐标集中在此，调整只需改这里。
import * as THREE from 'three';
import { createTree } from './props/Tree.js';
import { createBuilding } from './props/Building.js';
import { createFountain } from './props/Fountain.js';
import { createLamp } from './props/Lamp.js';
import { createBench } from './props/Bench.js';

// 道具布局：type 决定用哪个 create 函数并放置到 (x, z)。地面边长 50，坐标范围约为 [-22, 22]。
const LAYOUT = [
  // 树（散布场地边缘）
  { type: 'tree', x: -16, z: -16 },
  { type: 'tree', x: 18, z: -10 },
  { type: 'tree', x: 10, z: 18 },
  { type: 'tree', x: -20, z: 8 },
  { type: 'tree', x: 20, z: 14 },
  { type: 'tree', x: -8, z: -20 },
  { type: 'tree', x: -17, z: 19 },
  // 建筑
  { type: 'building', x: 10, z: 12 },
  { type: 'building', x: -12, z: 14 },
  { type: 'building', x: 16, z: -18 },
  { type: 'building', x: -14, z: -6 },
  // 喷泉（广场中央）
  { type: 'fountain', x: 0, z: 0 },
  // 路灯（十字路口四个方向）
  { type: 'lamp', x: 7, z: 0 },
  { type: 'lamp', x: -7, z: 0 },
  { type: 'lamp', x: 0, z: 7 },
  { type: 'lamp', x: 0, z: -7 },
  // 长椅（靠近喷泉两侧）
  { type: 'bench', x: 4, z: 5 },
  { type: 'bench', x: -4, z: -5 },
];

const FACTORY = {
  tree: createTree,
  building: createBuilding,
  fountain: createFountain,
  lamp: createLamp,
  bench: createBench,
};

// createProps(scene)：把所有道具挂到场景。
export function createProps(scene) {
  const group = new THREE.Group();
  for (const item of LAYOUT) {
    const make = FACTORY[item.type];
    if (!make) continue;
    group.add(make({ x: item.x, z: item.z }));
  }
  scene.add(group);
  return group;
}