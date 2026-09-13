// 职责：铺设主城道路网络。十字路网（两条纵向 + 两条横向）+ 中央行人广场，纯几何铺设，无需外部模型，刷新后朝向/位置稳定。
import * as THREE from 'three';
import { Config } from '../config.js';

// 纵向（沿 z）道路的 x 坐标，与横向（沿 x）道路的 z 坐标，组成 4 街区网格
const ROAD_LINES = [-10, 10];
const ROAD_WIDTH = 6;   // 单条道路宽度（跨道路方向）
const PLAZA_HALF = 6;   // 中央广场半宽（以喷泉为中心的行人步行区）

// createRoads() -> THREE.Group，包含沥青路面、车道中线与中央广场，已贴合地面 y≈0
export function createRoads() {
  const group = new THREE.Group();
  const G = Config.GROUND_SIZE; // 50，路面铺满整块地面边界

  const asphalt = new THREE.MeshStandardMaterial({ color: 0x3b3b3b, roughness: 0.95, metalness: 0.0 });
  const lineMat = new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.9, metalness: 0.0 });
  const plazaMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.85, metalness: 0.0 });

  // 纵向道路（沿 z 延伸），中心在 x = ±10
  for (const x of ROAD_LINES) {
    group.add(_strip(asphalt, ROAD_WIDTH, G, x, 0, 0.02));      // 路面
    group.add(_strip(lineMat, 0.15, G, x, 0, 0.04));            // 车道中线
  }
  // 横向道路（沿 x 延伸），中心在 z = ±10
  for (const z of ROAD_LINES) {
    group.add(_strip(asphalt, G, ROAD_WIDTH, 0, z, 0.02));      // 路面
    group.add(_strip(lineMat, G, 0.15, 0, z, 0.04));            // 车道中线
  }

  // 中央广场：覆盖道路交汇中心，作为喷泉与长椅的行人区
  const plazaSize = PLAZA_HALF * 2 + ROAD_WIDTH;
  group.add(_strip(plazaMat, plazaSize, plazaSize, 0, 0, 0.01));

  return group;
}

// 生成一块水平路面条带：宽 w、深 d，中心位于 (x, z)，y 抬升至 y 层贴合地面并防 z-fighting
function _strip(material, w, d, x, z, y) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(x, y, z);
  mesh.receiveShadow = true;
  return mesh;
}