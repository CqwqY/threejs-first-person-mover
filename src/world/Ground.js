// 职责：创建作为跑动地面的平面网格。仅处理外观，不做逻辑。
import * as THREE from 'three';
import { Config } from '../config.js';

export function createGround() {
  // 矩形地面，宽 = Config.GROUND_WIDTH（x 方向），深 = Config.GROUND_DEPTH（z 方向）
  const geometry = new THREE.PlaneGeometry(Config.GROUND_WIDTH, Config.GROUND_DEPTH);

  const material = new THREE.MeshStandardMaterial({
    color: Config.GROUND_COLOR,
    roughness: 0.9,
    metalness: 0.0,
  });

  const ground = new THREE.Mesh(geometry, material);

  // PlaneGeometry 默认垂直于 z 轴，这里绕 x 轴旋转 -90° 使其水平朝上（法线指向 +y）
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;

  return ground;
}