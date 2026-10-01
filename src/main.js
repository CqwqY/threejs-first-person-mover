// 职责：程序入口。创建 Game 实例并启动主循环。
import { Game } from './core/Game.js';
import { ensureAuth } from './ui/AuthUI.js';
import { initDebugYawPanel } from './debug/DebugYawPanel.js';
import { debugCalibFrame } from './player/PlayerModel.js';
import { initMobileControls } from './ui/MobileControls.js';
import { initMobileLayout } from './ui/MobileLayout.js';

// 进游戏前登录/注册（游客可选）；拿到 token 与资料后创建游戏
async function main() {
  // 登录流程任何异常都不能让整个页面留在白屏：失败就按游客进入
  let auth = { token: '', profile: null };
  try {
    auth = await ensureAuth();
  } catch (e) {
    console.warn('[main] 登录流程失败，以游客身份进入:', e);
  }
  const game = new Game(auth.token, auth.profile);
  game.start();
  // 手机触屏：追加虚拟摇杆（移动）与右侧拖动（视角）。非触屏设备内部会直接跳过
  initMobileControls(game.input);
  // 手机触屏：按键布局自适应 + 「调整/检查」入口（可拖动摆放跳跃键/技能槽/血条/对话选项卡）
  initMobileLayout();

  // 暴露到全局，方便调试（联机验证 / 控制台检查玩家状态）
  window.__game = game;

  // URL 带 ?calib 时打开朝向校准面板（模型朝向 + 骨架走向两个滑块，实时生效）
  if (/\bcalib\b/.test(location.search)) {
    initDebugYawPanel();
    // 开启校准日志：每 400ms 打印一次性骨骼/蒙皮数值，便于定位「改骨架模型是否跟着动」
    window.__YAW_DEBUG__ = true;
    setInterval(debugCalibFrame, 400);
  }
}
main();