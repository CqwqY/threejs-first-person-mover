// 职责：程序入口。创建 Game 实例并启动主循环。
import { Game } from './core/Game.js';
import { ensureAuth } from './ui/AuthUI.js';
import { initDebugYawPanel } from './debug/DebugYawPanel.js';
import { debugCalibFrame } from './player/PlayerModel.js';
import { installPlayerDebugOverlay } from './debug/PlayerDebugOverlay.js';
import { initMobileControls } from './ui/MobileControls.js';
import { initMobileLayout } from './ui/MobileLayout.js';
import { initBgm } from './audio/Bgm.js';
import { createLoadingScreen } from './ui/LoadingScreen.js';
import { initSaveSync } from './player/CloudSave.js';
import { stats, whenIdle, quietFor } from './world/loadTracker.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms) => Promise.race([p, sleep(ms)]);

// 「加载安静期」：加载是**分批发起**的（先场景模型；玩家角色模型要等 WebSocket 的
// welcome 到了才发起，手机慢网可能晚好几秒）。所以某瞬间 pending===0 完全不能证明
// 「都到位了」—— 必须要求连续安静这么久才算完。
// 这是「手机有些模型没下下来/没加载就放行了」的根因修复。
const QUIET_MS = 900;
// 全场兜底：再慢也得放人进来（含弱网、离线）
const ASSET_TIMEOUT_MS = 40000;

// 等「模型都到位」：场景就绪 → 收到 welcome（玩家模型才开始加载）→ 加载计数归零 + 安静期。
// 每一段都有超时兜底，且全程可被「不等了」打断（由外层的 race 结束）。
async function waitAssets(loading, game) {
  const t0 = performance.now();
  // 第一段：远端场景拉取（它会触发场景那批 GLB 加载）
  await withTimeout(game.sceneReady(), 12000).catch(() => {});
  // 第二段：等 welcome —— 玩家角色模型到这一刻才发起加载。
  // 不等它就会在角色还没开始下载时放行（手机上表现为「人没出来就进游戏了」）。
  await game.welcomeReady(6000).catch(() => {});
  // 第三段：等计数归零，且**连续安静 QUIET_MS** 没有新任务进来才算真的完。
  // 每轮看一眼进度条，并给「不等了」留出打断机会。
  for (;;) {
    if (loading.done) return;
    const { pending, total } = stats();
    loading.setProgress(total - pending, total);
    // 关键判据：空闲且安静够久 → 认定加载完
    if (quietFor(QUIET_MS)) return;
    if (performance.now() - t0 > ASSET_TIMEOUT_MS) return; // 兜底放行
    await Promise.race([whenIdle(), sleep(200)]);
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
  // 账号存档云同步（学币 / 已购 / 兑换码 / 技能槽 / 性别）：必须在 new Game 之前拉一次，
  // 因为 Game 构造时会直接从 localStorage 读这些值。登录界面当场选的性别优先于云端旧值。
  if (auth.token && auth.profile) {
    try { await initSaveSync(auth.token, auth.profile, { forceGender: !!auth.genderChosen }); }
    catch (e) { console.warn('[main] 账号存档同步失败（按本地继续）:', e); }
  }
  // 加载动画：登录完之后才挂遮罩 —— 它是全屏且吃触摸的，挂在登录前会把登录界面整个盖住。
  // 从这一刻起，模型没到位就不放人进来（点「不等了」可立刻进）。
  const loading = createLoadingScreen({ title: '花草中学' });
  // 性别以本地为准（刚可能已被云端存档覆盖；当场选过则保留本次选择）
  const gender = localStorage.getItem('fpm-gender') === 'girl' ? 'girl' : 'boy';
  const game = new Game(auth.token, auth.profile, gender);
  game.start();
  // 场景/模型加载完成后（或用户点了「不等了」）再撤掉遮罩
  const assetsReady = (async () => {
    await waitAssets(loading, game);
  })();
  await Promise.race([assetsReady, loading.skipped]);
  loading.finish();
  // 手机触屏：追加虚拟摇杆（移动）与右侧拖动（视角）。非触屏设备内部会直接跳过。
  // 人称切换器只认注入进来的这一对回调，不认识 Game 本身（模块之间靠注入解耦）
  const mobileCtl = initMobileControls(game.input, {
    onToggleView: () => game.toggleThirdPerson(),
    isThirdPerson: () => !!game.thirdPerson,
  });
  // 驾驶键组与「跳」的互换由 Game 在上下车时触发（拿到了才能调，拿不到就只是没有驾驶键组）
  game.mobileControls = mobileCtl || null;
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

  // URL 带 ?pdbg 时把「玩家模型体检」贴在屏幕左上角（排查"看得见道具看不见人"；手机没控制台时用）
  if (/\bpdbg\b/.test(location.search)) {
    installPlayerDebugOverlay(game);
  }

  // URL 带 ?calib 时打开朝向校准面板（模型朝向 + 骨架走向两个滑块，实时生效）
  if (/\bcalib\b/.test(location.search)) {
    initDebugYawPanel();
    // 开启校准日志：每 400ms 打印一次性骨骼/蒙皮数值，便于定位「改骨架模型是否跟着动」
    window.__YAW_DEBUG__ = true;
    setInterval(debugCalibFrame, 400);
  }
}
main();