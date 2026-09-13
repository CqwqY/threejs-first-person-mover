// 职责：把各类道具铺到主城。中央广场（喷泉 + 长椅）、道路两旁路灯、陆地区格上的建筑/树/灌木/水塔随机排布。
// 道路与“是否在道路上”的判定来自 CityGen（确定性噪声），保证所有道具都落在陆地（或广场）上、不压到道路。
import * as THREE from 'three';
import { getCity } from './CityGen.js';
import { createBuildingVar } from './props/BuildingVar.js';
import { createFountain } from './props/Fountain.js';
import { createLamp } from './props/Lamp.js';
import { createBench } from './props/Bench.js';
import { createTree } from './props/Tree.js';
import { createBush } from './props/Bush.js';
import { createTower } from './props/Tower.js';

const PLAZA_HALF = 5.5;  // 广场半宽，与 Roads.js 一致
const CELL = 3;           // 陆地区格采样步长
const LAND_HALF = 21;     // 陆地区格扫描范围（±21）

// 建筑变体素材库（循环使用，呈现多样街区）
const BUILDING_VARIANTS = [
  { url: 'building-small-a.glb', scale: 1.8, size: { w: 4, h: 7, d: 4 }, color: 0xd08a5a },
  { url: 'building-small-b.glb', scale: 1.8, size: { w: 4, h: 6, d: 4 }, color: 0xb57c5a },
  { url: 'building-small-c.glb', scale: 1.8, size: { w: 4, h: 9, d: 4 }, color: 0x9aa7b5 },
  { url: 'building-small-d.glb', scale: 1.8, size: { w: 4, h: 6, d: 4 }, color: 0x7a9a6b },
];

// createProps(scene)：铺装广场核心、路边路灯与陆地区格上的建筑/树/灌木/水塔
export function createProps(scene) {
  const { isOnRoad, lampSpots } = getCity();

  const group = new THREE.Group();

  // ---- 广场核心：喷泉 + 环绕长椅 ----
  group.add(createFountain({ x: 0, z: 0 }));
  group.add(createBench({ x: 4, z: 5 }));
  group.add(createBench({ x: -4, z: -5 }));
  group.add(createBench({ x: 5, z: -4 }));
  group.add(createBench({ x: -5, z: 4 }));

  // ---- 道路两旁路灯（位置由 CityGen 提供，必落陆地）----
  for (const spot of lampSpots) {
    group.add(createLamp({ x: spot.x, z: spot.z }));
  }

  // ---- 陆地区格采样：建筑/树/灌木/水塔 ----
  const landCells = [];
  for (let x = -LAND_HALF; x <= LAND_HALF; x += CELL) {
    for (let z = -LAND_HALF; z <= LAND_HALF; z += CELL) {
      const cx = x + CELL / 2;
      const cz = z + CELL / 2;
      if (Math.abs(cx) <= PLAZA_HALF && Math.abs(cz) <= PLAZA_HALF) continue; // 广场留空
      if (isOnRoad(cx, cz)) continue; // 道路留空
      landCells.push({ x: cx, z: cz });
    }
  }

  let n = 0;
  let buildings = 0;
  let trees = 0;
  let bushes = 0;

  for (const p of landCells) {
    // 水塔：放到西北 / 东南两个远离中心的陆地区格里做地标
    if ((p.x < -14 && p.z > 4) || (p.x > 14 && p.z < -4)) {
      continue; // 由专门的塔逻辑处理，避免重复占用
    }
    n++;
    if (buildings < 14 && n % 3 === 0) {
      const variant = BUILDING_VARIANTS[buildings % BUILDING_VARIANTS.length];
      group.add(createBuildingVar({ x: p.x, z: p.z }, variant));
      buildings++;
    } else if (trees < 16 && (n % 3 === 1 || buildings >= 14)) {
      group.add(createTree({ x: p.x, z: p.z }));
      trees++;
    } else if (bushes < 12) {
      group.add(createBush({ x: p.x, z: p.z }));
      bushes++;
    }
  }

  // ---- 水塔地标：西北与东南角各一座 ----
  const towerNW = landCells.find((p) => p.x < -14 && p.z > 4);
  const towerSE = landCells.find((p) => p.x > 14 && p.z < -4);
  if (towerNW) group.add(createTower({ x: towerNW.x, z: towerNW.z }));
  if (towerSE) group.add(createTower({ x: towerSE.x, z: towerSE.z }));

  scene.add(group);
  return group;
}