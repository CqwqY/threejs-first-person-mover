// 职责：程序入口。创建 Game 实例并启动主循环。
import { Game } from './core/Game.js';
import { ensureAuth, cachedProfile } from './ui/AuthUI.js';
import { initDebugYawPanel } from './debug/DebugYawPanel.js';
import { debugCalibFrame } from './player/PlayerModel.js';
import { installPlayerDebugOverlay } from './debug/PlayerDebugOverlay.js';
import { initMobileControls } from './ui/MobileControls.js';
import { initMobileLayout } from './ui/MobileLayout.js';
import { initBgm } from './audio/Bgm.js';
import { createHomeScreen } from './ui/HomeScreen.js';
import { initSaveSync } from './player/CloudSave.js';
import { stats, whenIdle, quietFor } from './world/loadTracker.js';
import { markLoadPhase } from './util/Telemetry.js';

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
// 每一段都有超时兜底，全场 40s 后无条件放行（含弱网、离线）。
// ⚠ 只在点「进入游戏」之后才会被调用：主页阶段不发起任何资源加载。
async function waitAssets(home, game) {
  const t0 = performance.now();
  markLoadPhase('waitStart');
  // 第一段：远端场景拉取（它会触发场景那批 GLB 加载）
  home.setStage('正在连接校园场景…');
  await withTimeout(game.sceneReady(), 12000).catch(() => {});
  markLoadPhase('sceneReady');
  // 第二段：等 welcome —— 玩家角色模型到这一刻才发起加载。
  // 不等它就会在角色还没开始下载时放行（手机上表现为「人没出来就进游戏了」）。
  home.setStage('正在载入玩家角色…');
  await game.welcomeReady(6000).catch(() => {});
  markLoadPhase('welcomeReady');
  // 第三段：等计数归零，且**连续安静 QUIET_MS** 没有新任务进来才算真的完。
  // 每轮看一眼进度条，并给 40s 兜底放行的机会。
  home.setStage('正在加载模型…');
  for (;;) {
    const { pending, total } = stats();
    home.setProgress(total - pending, total);
    // 关键判据：空闲且安静够久 → 认定加载完
    if (quietFor(QUIET_MS)) { markLoadPhase('assetsDone'); return; }
    if (performance.now() - t0 > ASSET_TIMEOUT_MS) { markLoadPhase('assetsDone'); markLoadPhase('assetsTimeout'); return; } // 兜底放行
    await Promise.race([whenIdle(), sleep(200)]);
  }
}


// 启动顺序（点击后才加载）：
//   ① 挂主页（视频背景 + 中间登录态/玩家名 + 底部「进入游戏」按钮，默认就能点）
//   ② 并发检测登录（没登录弹「请登录」），结果只更新主页文字，不阻塞按钮
//   ③ await home.waitForEnter() —— 这一刻之前**完全不创建 Game、不加载任何资源**
//   ④ 点「进入游戏」→ 主页切成加载页（静态图片 + 铺满全底的进度条）
//      → 等登录完成 → 云同步 → new Game() → game.start() → waitAssets() 走真实进度
//   ⑤ 加载完成 home.finish() 自动淡出，直接进入游戏（不需要再点一次）
// ⚠ 主页必须先于登录弹窗挂载：弹窗是盖在底图之上的，否则背后是一片空白 canvas。
async function main() {
  markLoadPhase('boot');
  const home = createHomeScreen({
    onSwitchAccount: () => {
      try { localStorage.removeItem('fp_token'); } catch (e) { console.warn('[main] 清除登录态失败:', e); }
      location.reload(); // 重新走一遍「每次进入都检测登录」
    },
  });
  home.setStatus('正在检测登录…');

  // 每次进入都重新校验 token，但**并发**进行：主页按钮此刻已经可点，不必等接口返回。
  // 登录流程任何异常都不能让页面卡死：失败按游客继续。
  const authPromise = ensureAuth({
    onNeedLogin: () => {
      home.setStatus('请登录', '登录后即可进入校园');
      home.setHint('请登录后进入游戏');
    },
  }).catch((e) => {
    console.warn('[main] 登录流程失败，以游客身份进入:', e);
    return { token: '', profile: null };
  });
  // 登录结果一到就把中间文字换成玩家名（或登录态）；纯展示，不阻塞进入流程。
  // token 有效但账号接口暂时不通时，用上次缓存的昵称把名字补上。
  authPromise.then((auth) => {
    const shownProfile = auth.profile || (auth.token ? cachedProfile() : null);
    if (shownProfile) home.setProfile(shownProfile);
    else home.setStatus(auth.token ? '已登录' : '游客模式', '未登录也能进入，云端功能不可用');
  }).catch((e) => {
    console.warn('[main] 更新主页登录态失败（不影响进入）:', e);
  });
  markLoadPhase('authStarted');

  // 默认可点：等用户点「进入游戏」。点之前不碰 Game，所以主页零加载、秒开。
  await home.waitForEnter();
  markLoadPhase('enter');

  const auth = await authPromise;
  markLoadPhase('authDone');

  // 账号存档云同步（学币 / 已购 / 兑换码 / 技能槽 / 性别）：必须在 new Game 之前拉一次，
  // 因为 Game 构造时会直接从 localStorage 读这些值。登录界面当场选的性别优先于云端旧值。
  if (auth.token && auth.profile) {
    try { await initSaveSync(auth.token, auth.profile, { forceGender: !!auth.genderChosen }); }
    catch (e) { console.warn('[main] 账号存档同步失败（按本地继续）:', e); }
  }
  // 性别以本地为准（刚可能已被云端存档覆盖；当场选过则保留本次选择）
  const gender = localStorage.getItem('fpm-gender') === 'girl' ? 'girl' : 'boy';
  const game = new Game(auth.token, auth.profile, gender);
  game.start();
  markLoadPhase('gameStart');
  // 等场景/模型都到位（quietFor 安静期 + 40s 兜底），加载页进度条走真实进度。
  // 加载页此时已由 beginEnter() 切成静态图片 + 铺满全底的进度条。
  await waitAssets(home, game);
  // 加载完直接淡出进入游戏，不再需要第二次点击。
  home.finish();
  markLoadPhase('entered');
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

  // 自动采集触发条件（优先级从高到低）：
  //   ?tel=0 → 强制关闭（即使开关开着也不采）；
  //   ?tel=1 → 强制开启；
  //   无 tel 参数 → 看设置里的「自动上报」总开关（默认开，见 Telemetry.telemetryAutoGet）。
  // 这样普通链接进游戏也会自动回传性能数据，不必每条都带 ?tel=1。
  const _telParam = (typeof URLSearchParams !== 'undefined')
    ? new URLSearchParams(location.search).get('tel') : null;
  const _autoTel = _telParam === '0' ? false
    : (_telParam === '1' ? true : game._telemetryAutoEnabled());
  if (_autoTel) {
    setTimeout(() => { try { game._runTelemetry(); } catch (e) { /* 忽略 */ } }, 8000);
  }
}
main();