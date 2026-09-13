// 职责：创建四周挡墙，把玩家限制在地面范围内。仅处理的墙体坐标与材质。
import * as THREE from 'three';
import { Config } from '../config.js';

export function createWalls() {
  const group = new THREE.Group();

  const size = Config.GROUND_SIZE;
  const half = size / 2;
  const height = Config.WALL_HEIGHT;

  // 半透明材质：既挡人又能看清周围
  const material = new THREE.MeshStandardMaterial({
    color: Config.WALL_COLOR,
    transparent: true,
    opacity: Config.WALL_OPACITY,
    side: THREE.DoubleSide,
  });

  // 生成四面围墙的工具函数
  const addWall = (width, height, cx, cz, rotY) => {
    const geometry = new THREE.BoxGeometry(width, height, 0.5);
    const wall = new THREE.Mesh(geometry, material);
    wall.position.set(cx, height / 2, cz);
    wall.rotation.y = rotY;
    group.add(wall);
  };

  // 北墙 / 南墙（沿 x 方向延伸）
  addWall(size + 1, height, 0, -half, 0);
  addWall(size + 1, height, 0, half, 0);
  // 东墙 / 西墙（沿 z 方向延伸）
  addWall(size + 1, height, -half, 0, Math.PI / 2);
  addWall(size + 1, height, half, 0, Math.PI / 2);

  return group;
}