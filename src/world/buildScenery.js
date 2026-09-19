// 职责：统一构建「可编辑共享世界」。当前为极简绿色矩形地面（无道路/墙体/道具）。
// 编辑器与游戏都调用本函数，返回的可编辑根数组顺序完全一致，
// 因此数组下标可作为 stable key（两侧用同一 key 对应同一个景物对象）。
import { createGround } from './Ground.js';

// buildScenery(scene)：把景物加入场景，并返回可编辑根对象列表
// 当前仅 [ground]（灯光不在列表内，不可编辑）。
export function buildScenery(scene) {
  const ground = createGround();
  ground.name = '地面';
  const roots = [ground];
  scene.add(ground);
  return roots;
}