// 职责：把 CityGen 生成的道路网铺设成可视路面（沥青带 + 中央广场）。纯几何铺设，无外部模型。
import * as THREE from 'three';
import { getCity } from './CityGen.js';

const PLAZA_HALF = 5.5; // 中央广场半宽（以喷泉为中心的行人区）

// createRoads() -> THREE.Group：按噪声道路中心线渲染沥青路面，并在原点叠加中央广场
export function createRoads() {
  const { roads, ROAD_WIDTH } = getCity();

  const group = new THREE.Group();

  const asphalt = new THREE.MeshStandardMaterial({ color: 0x3b3b3b, roughness: 0.95, metalness: 0.0 });
  const plazaMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.85, metalness: 0.0 });

  // 每条大道：沿中心线折线放置一段段薄长方体（高 0.02，贴地防 z-fighting）
  for (const poly of roads) {
    for (let i = 0; i < poly.length - 1; i++) {
      const a = poly[i];
      const b = poly[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      if (len < 0.001) continue;

      const seg = new THREE.Mesh(new THREE.BoxGeometry(ROAD_WIDTH, 0.02, len), asphalt);
      seg.position.set((a.x + b.x) / 2, 0.01, (a.z + b.z) / 2);
      seg.rotation.y = Math.atan2(dx, dz); // 让长方体 z 轴对齐道路走向
      seg.receiveShadow = true;
      group.add(seg);
    }
  }

  // 中央广场：覆盖道路交汇中心，作为喷泉与长椅的行人区
  const plaza = new THREE.Mesh(
    new THREE.BoxGeometry(PLAZA_HALF * 2, 0.03, PLAZA_HALF * 2),
    plazaMat
  );
  plaza.position.y = 0.02;
  plaza.receiveShadow = true;
  group.add(plaza);

  return group;
}