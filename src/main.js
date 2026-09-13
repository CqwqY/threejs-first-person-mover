// 职责：程序入口。创建 Game 实例并启动主循环。
import { Game } from './core/Game.js';

const game = new Game();
game.start();

// 暴露到全局，方便调试（联机验证 / 控制台检查玩家状态）
window.__game = game;