// 职责：程序入口。创建 Game 实例并启动主循环。
import { Game } from './core/Game.js';
import { ensureAuth } from './ui/AuthUI.js';
import { initDebugYawPanel } from './debug/DebugYawPanel.js';
import { debugCalibFrame } from './player/PlayerModel.js';
import { initMobileControls } from './ui/MobileControls.js';
import { initMobileLayout } from './ui/MobileLayout.js';
import { initBgm } from './audio/Bgm.js';
import { createLoadingScreen } from './ui/LoadingScreen.js';
import { stats, whenIdle } from './world/loadTracker.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms) => Promise.race([p, sleep(ms)]);

// 等「模型都到位」：远端场景拉取完（它会触发一批 GLB 加载）→ 加载计数归零。
// 每一段都有超时兜底，且全程可被「不等了」打断（由外层的 race 结束）。
async function waitAssets(loading) {
  await sleep(400); // 先给一小段窗口让第一批请求登记进来，否则会误判「都加载完了」
  const t0 = performance.now();
  for (;;) {
    if (loading.done) return;
    const { pending, total } = stats();
    loading.setProgress(total - pending, total);
    if (total > 0 && pending === 0) return;                  // 都到齐了
    if (total === 0 && performance.now() - t0 > 1600) return; // 一直没有任何模型要加载（离线/纯程序化场景）
    if (performance.now() - t0 > 25000) return;               // 兜底：再慢也得放人进来
    await Promise.race([whenIdle(), sleep(250)]);
  }
}

// 进游戏前登录/注册（游客可选）；拿到 token 与资料后创建游戏
async function main() {
  // 登录流程任何异常都不能让整个页面留在白屏：失败就按游客进入
  let auth = { token: '', profile: null };
  try {
    auth = await ensureAuth();
  } catch (e) {
    console.warn('[main] 登录流程失败，以游客身份进入:', e);
  }
  // 加载动画：登录完之后才挂遮罩 —— 它是全屏且吃触摸的，挂在登录前会把登录界面整个盖住。
  // 从这一刻起，模型没到位就不放人进来（点「不等了」可立刻进）。
  const loading = createLoadingScreen({ title: '花草中学' });
  const game = new Game(auth.token, auth.profile);
  game.start();
  // 场景/模型加载完成后（或用户点了「不等了」）再撤掉遮罩
  const assetsReady = (async () => {
    await withTimeout(game.sceneReady(), 12000); // 远端场景拉取（慢/离线都不该无限等）
    await waitAssets(loading);                   // 它触发的那批模型加载
  })();
  await Promise.race([assetsReady, loading.skipped]);
  loading.finish();
  // 手机触屏：追加虚拟摇杆（移动）与右侧拖动（视角）。非触屏设备内部会直接跳过。
  // 人称切换器只认注入进来的这一对回调，不认识 Game 本身（模块之间靠注入解耦）
  initMobileControls(game.input, {
    onToggleView: () => game.toggleThirdPerson(),
    isThirdPerson: () => !!game.thirdPerson,
  });
  // 手机触屏：按键布局自适应 + 拖拽摆放。动作注入给「设置」弹窗的「画面元素」区块
  // （非触屏时返回 null，桌面端因此不会出现那组按钮，弹窗里也不会留空区块）
  const layoutApi = initMobileLayout();
  if (layoutApi && game.settingsPanel && game.settingsPanel.setLayoutActions) {
    game.settingsPanel.setLayoutActions({
      onAdjust: () => layoutApi.toggleEdit(),
      onCheck: () => layoutApi.check(),
      onReset: () => layoutApi.reset(),
    });
  }
  // 背景音乐：低音量循环；浏览器拦截自动播放时，首次手势后再开始
  initBgm();

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