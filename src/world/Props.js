// 职责：按布局把各类道具（树/建筑/喷泉/路灯/长椅/灌木/水塔）放置到主城地面并加入场景。布局坐标集中在此，调整只需改这里。
import * as THREE from 'three';
import { createTree } from './props/Tree.js';
import { createBuilding } from './props/Building.js';
import { createBuildingVar } from './props/BuildingVar.js';
import { createFountain } from './props/Fountain.js';
import { createLamp } from './props/Lamp.js';
import { createBench } from './props/Bench.js';
import { createBush } from './props/Bush.js';
import { createTower } from './props/Tower.js';

// 道具布局：type 决定 create 函数，buildingVar 通过 url/scale/size/color 指定建筑素材。
// 地面边长 50，坐标范围约为 [-24, 24]。道路网位于 |x|=10 与 |z|=10，建筑布置在四个街区内部，路缘布置行道。
const LAYOUT = [
  // ==== 广场核心 ====
  { type: 'fountain', x: 0, z: 0 },                       // 中央喷泉
  { type: 'bench', x: 4, z: 5 },                          // 长椅环绕喷泉
  { type: 'bench', x: -4, z: -5 },
  { type: 'bench', x: 5, z: -4 },
  { type: 'bench', x: -5, z: 4 },

  // ==== 行道树 / 灌木（道路边缘与绿地）====
  { type: 'tree', x: -8, z: -2 },
  { type: 'tree', x: 8, z: 2 },
  { type: 'tree', x: -2, z: 8 },
  { type: 'tree', x: 2, z: -8 },
  { type: 'tree', x: 13, z: 7 },
  { type: 'tree', x: -13, z: 7 },
  { type: 'tree', x: 13, z: -7 },
  { type: 'tree', x: -13, z: -7 },
  { type: 'bush', x: 9, z: 3 },
  { type: 'bush', x: -9, z: 3 },
  { type: 'bush', x: 9, z: -3 },
  { type: 'bush', x: -9, z: -3 },
  { type: 'bush', x: 3, z: 9 },
  { type: 'bush', x: 3, z: -9 },
  { type: 'bush', x: -3, z: 9 },
  { type: 'bush', x: -3, z: -9 },

  // ==== 路灯（沿道路排布）====
  { type: 'lamp', x: 7, z: 0 },
  { type: 'lamp', x: -7, z: 0 },
  { type: 'lamp', x: 0, z: 7 },
  { type: 'lamp', x: 0, z: -7 },
  { type: 'lamp', x: 12, z: 3 },
  { type: 'lamp', x: -12, z: 3 },
  { type: 'lamp', x: 12, z: -3 },
  { type: 'lamp', x: -12, z: -3 },
  { type: 'lamp', x: 3, z: 12 },
  { type: 'lamp', x: 3, z: -12 },
  { type: 'lamp', x: -3, z: 12 },
  { type: 'lamp', x: -3, z: -12 },

  // ==== 主街区（东北）====
  { type: 'buildingVar', url: 'building-small-a.glb', x: 18, z: 18, size: { w: 4, h: 7, d: 4 }, color: 0xd08a5a },
  { type: 'buildingVar', url: 'building-small-b.glb', x: 13, z: 21, size: { w: 4, h: 6, d: 4 }, color: 0xb57c5a },
  { type: 'buildingVar', url: 'building-garage.glb', x: 22, z: 13, size: { w: 4, h: 3.5, d: 4 }, color: 0x8a8a8a },

  // ==== 主街区（西北）====
  { type: 'buildingVar', url: 'building-small-b.glb', x: -18, z: 18, size: { w: 4, h: 6, d: 4 }, color: 0x9aa7b5 },
  { type: 'buildingVar', url: 'building-small-c.glb', x: -13, z: 21, size: { w: 4, h: 9, d: 4 }, color: 0xc98a6b },
  { type: 'tower', x: -22, z: 13 },                            // 水塔地标

  // ==== 主街区（东南）====
  { type: 'building', x: 16, z: -16 },                         // 基础大建筑
  { type: 'buildingVar', url: 'building-small-d.glb', x: 21, z: -14, size: { w: 4, h: 6, d: 4 }, color: 0x9c7a5a },
  { type: 'buildingVar', url: 'building-small-c.glb', x: 13, z: -22, size: { w: 4, h: 9, d: 4 }, color: 0x6b82c9 },

  // ==== 主街区（西南）====
  { type: 'buildingVar', url: 'building-small-a.glb', x: -18, z: -18, size: { w: 4, h: 7, d: 4 }, color: 0x9aa0a6 },
  { type: 'buildingVar', url: 'building-garage.glb', x: -22, z: -13, size: { w: 4, h: 3.5, d: 4 }, color: 0x777777 },
  { type: 'buildingVar', url: 'building-small-d.glb', x: -13, z: -21, size: { w: 4, h: 6, d: 4 }, color: 0x7a9a6b },
];

const FACTORY = {
  tree: createTree,
  building: createBuilding,
  buildingVar: createBuildingVar,
  fountain: createFountain,
  lamp: createLamp,
  bench: createBench,
  bush: createBush,
  tower: createTower,
};

// createProps(scene)：把所有道具挂到场景。
export function createProps(scene) {
  const group = new THREE.Group();
  for (const item of LAYOUT) {
    const make = FACTORY[item.type];
    if (!make) continue;
    const { x, z, ...rest } = item;
    group.add(make({ x, z }, rest));
  }
  scene.add(group);
  return group;
}