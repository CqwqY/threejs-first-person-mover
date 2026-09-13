// 职责：组装静态世界（地面 + 墙体 + 光照）并添加到场景。
import { createGround } from './Ground.js';
import { createWalls } from './Walls.js';
import { createLights } from './Lights.js';

// createWorld(scene)：把三大静态对象挂载到 scene 下
export function createWorld(scene) {
  scene.add(createGround());
  scene.add(createWalls());
  scene.add(createLights());
}