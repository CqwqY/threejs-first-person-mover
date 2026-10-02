// 职责：创建四周可看见的挡墙（半透明板）。几何统一来自 world/Boundary.js —— 与编辑器「边界」模式
// 的预览、以及游戏运行时的边界夹取用的是同一份规格，不会出现「编辑器里看着对、游戏里差一截」。
// 注意：**不要再用 Config.GROUND_SIZE**。那是遗留的 50×50 方形，而地面实际是
// GROUND_WIDTH(160) × GROUND_DEPTH(310)，照它建墙会在场地中间凭空多出一圈小墙。
import * as THREE from 'three';
import { Config } from '../config.js';
import { defaultBoundary, normalizeBoundary, boundaryWallSpecs, BOUNDARY_THICKNESS } from './Boundary.js';

// boundary 可选：编辑器保存的边界（{minX,maxX,minZ,maxZ,wallHeight,showWalls}）。
// 缺省/非法则用地面范围（defaultBoundary），等同于「沿地面边缘围一圈」。
export function createWalls(boundary) {
  const b = normalizeBoundary(boundary) || defaultBoundary();
  const group = new THREE.Group();
  group.name = 'boundary-walls';

  // 半透明材质：既挡人又能看清周围
  const material = new THREE.MeshStandardMaterial({
    color: Config.WALL_COLOR,
    transparent: true,
    opacity: Config.WALL_OPACITY,
    side: THREE.DoubleSide,
    depthWrite: false,
  });

  const h = b.wallHeight;
  for (const sp of boundaryWallSpecs(b, BOUNDARY_THICKNESS)) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(sp.hx * 2, h, sp.hz * 2), material);
    wall.position.set(sp.cx, h / 2, sp.cz); // 底面贴地
    wall.rotation.y = sp.rotY;
    group.add(wall);
  }

  return group;
}
