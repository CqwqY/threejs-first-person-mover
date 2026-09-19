// 职责：程序入口。创建 Game 实例并启动主循环。
import { Game } from './core/Game.js';
import { initDebugYawPanel } from './debug/DebugYawPanel.js';
import { debugCalibFrame } from './player/PlayerModel.js';
import { initBuildingTool } from './world/BuildingTool.js';

const game = new Game();
game.start();

// 暴露到全局，方便调试（联机验证 / 控制台检查玩家状态）
window.__game = game;

// 地图建筑放置工具（B 键开关）：导入/选择模型、缩放旋转、拾取位置、持久化放置
window.__buildingTool = initBuildingTool(game.scene, game.camera, game.renderer.domElement);

// URL 带 ?calib 时打开朝向校准面板（模型朝向 + 骨架走向两个滑块，实时生效）
if (/\bcalib\b/.test(location.search)) {
  initDebugYawPanel();
  // 开启校准日志：每 400ms 打印一次性骨骼/蒙皮数值，便于定位「改骨架模型是否跟着动」
  window.__YAW_DEBUG__ = true;
  setInterval(debugCalibFrame, 400);
}