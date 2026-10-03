// 职责：手机触屏适配。在触屏设备上追加两套覆盖控件，把触摸输入翻译成 Input 的摇杆轴与视角增量：
//   左侧虚拟摇杆 -> 移动（前后/左右，推满触发冲刺）
//   右侧拖动区   -> 转视角（yaw/pitch，复用鼠标视角的累计入口）
//   左下人称切换 -> 第一/第三人称（手机上没有 F5，必须有实体入口）
// 非触屏设备（粗指针）不创建任何 DOM，保持桌面体验不变。
//
// opts 由 main.js 注入（本模块不认识 Game，别直接 import）：
//   onToggleView()          切一次人称
//   isThirdPerson()         现在是不是第三人称（切换后据此重画，旁路改动也能同步）
import { Config } from '../config.js';
import { onRelayout, viewportSize } from './layout.js';
import { ensureTheme } from './theme.js';
import { isCoarsePointer } from '../util/isCoarse.js';

// 模块级持有者：把「清触摸残留」暴露给重排逻辑，旋转/地址栏变化时调用
let _resetTouchState = null;
export function resetTouchState() {
  if (_resetTouchState) _resetTouchState();
}

export function initMobileControls(input, opts = {}) {
  ensureTheme(); // 配色/字体统一取自主题变量，本模块不再自带一套颜色
  // 触屏判定：统一走 isCoarsePointer()（多信号 OR，覆盖 WebView / Capacitor / 真机），
  // 否则移动摇杆（轮盘）+ 左右触控区（两列）整段不创建。
  const coarse = isCoarsePointer();
  if (!coarse) return;

  // 纯布局样式（一次性注入）：摇杆与视角区的定位/尺寸/触控区属于行为依赖，必须留在这里。
  // theme.js 只提供可换肤的类与变量（面板/按钮），而这几个控件是叠在世界之上的半透明层，
  // 套 .kui-panel/.kui-btn 会挡住视野、也会和这里的圆形几何冲突，所以只把硬编码颜色换成主题变量。
  const style = document.createElement('style');
  style.textContent = `
    .mc-zone{position:fixed;bottom:0;touch-action:none;user-select:none;-webkit-user-select:none;z-index:50}
    /* 高度用 --app-vh（visualViewport 实时写），不用 vh/dvh：
       iOS 的 100vh 等于"大视口"（含地址栏）且旋转后不更新，会导致错位与跳动 */
    /* 左右两个触控区必须首尾相接：原来是 44vw + 50vw，中间永远留着 6vw 的缝
       （竖屏 360px 时 21.6px，横屏 780px 时 46.8px）。那条缝两头都摸不到——
       手指落进去「既不走也不转视角」，是横屏最明显的手感问题。改成各 50vw 即无缝。 */
    .mc-left{left:0;width:50vw;height:calc(var(--app-vh, 100vh) * 0.42);min-height:200px}
    .mc-right{right:0;top:0;width:50vw;height:var(--app-vh, 100vh)}
    /* 横屏：高度只剩 ~360px，竖屏那份「上半屏留给看路」的 58% 余量已无必要，
       移动区补满全高，拇指从下往上都摸得到，也顺手消掉左上角那块死区。
       左右安全区：横屏时刘海/圆角在两侧，摇杆与跳跃键必须让开，否则会被切掉。 */
    @media (orientation: landscape) {
      .mc-left{height:var(--app-vh, 100vh);min-height:0}
      .mc-joy{left:calc(env(safe-area-inset-left, 0px) + 20px);
        bottom:calc(env(safe-area-inset-bottom, 0px) + 26px)}
      .mc-jump{right:calc(env(safe-area-inset-right, 0px) + 20px)}
    }
    /* 摇杆：半径/厚度/位置一律不动，只把白色前景换成主题蓝（透明度由主题变量混出） */
    .mc-joy{position:absolute;left:20px;bottom:26px;width:118px;height:118px;border-radius:50%;
      border:2px solid color-mix(in srgb, var(--kui-blue-soft) 70%, transparent);
      background:color-mix(in srgb, var(--kui-blue) 12%, transparent);
      box-sizing:content-box}
    .mc-joy::after{content:'';position:absolute;inset:50%;width:64px;height:64px;transform:translate(-50%,-50%);
      border-radius:50%;border:1px solid color-mix(in srgb, var(--kui-blue-soft) 45%, transparent)}
    .mc-knob{position:absolute;left:50%;top:50%;width:54px;height:54px;transform:translate(-50%,-50%);
      border-radius:50%;background:color-mix(in srgb, var(--kui-blue) 72%, transparent);box-shadow:var(--kui-shadow)}
    .mc-jump{position:fixed;right:20px;bottom:calc(env(safe-area-inset-bottom, 0px) + 24px);
      width:72px;height:72px;border-radius:50%;z-index:51;
      display:flex;align-items:center;justify-content:center;color:var(--kui-paper);
      font-size:15px;font-weight:600;letter-spacing:1px;font-family:var(--kui-font);
      background:color-mix(in srgb, var(--kui-blue) 30%, transparent);
      border:2px solid color-mix(in srgb, var(--kui-blue-soft) 75%, transparent);
      touch-action:none;user-select:none;-webkit-user-select:none}
    .mc-jump:active{background:color-mix(in srgb, var(--kui-blue) 62%, transparent)}
    /* 人称切换器：摇杆正上方（摇杆半径 26px + 直径 clamp(92,26vmin,124) + 14px 间距）。
       做成两段而不是单键：单键只能靠文字猜当前是第几人称，两段一眼能看出在哪一档。
       z-index 52 高过触控区（50）与跳跃键（51），否则点上去会先被摇杆吃掉。 */
    .mc-view{position:fixed;z-index:52;display:flex;align-items:center;gap:2px;padding:3px;
      left:calc(env(safe-area-inset-left, 0px) + 20px);
      bottom:calc(env(safe-area-inset-bottom, 0px) + 26px + clamp(92px,26vmin,124px) + 14px);
      border-radius:999px;box-sizing:border-box;box-shadow:var(--kui-shadow);
      background:color-mix(in srgb, var(--kui-ink) 46%, transparent);
      border:2px solid color-mix(in srgb, var(--kui-blue-soft) 55%, transparent);
      touch-action:none;user-select:none;-webkit-user-select:none}
    .mc-view > b{flex:0 0 auto;padding:6px 10px;border-radius:999px;cursor:pointer;
      font:600 clamp(11px,2.9vmin,13px)/1 var(--kui-font);color:var(--kui-paper);opacity:.6}
    .mc-view > b.on{background:color-mix(in srgb, var(--kui-blue) 85%, transparent);opacity:1}
  `;
  document.head.appendChild(style);

  // ---- 右下跳跃按钮 ----
  const jumpBtn = document.createElement('div');
  jumpBtn.className = 'mc-jump';
  jumpBtn.textContent = '跳';
  document.body.appendChild(jumpBtn);
  const jumpPress = (e) => {
    e.preventDefault();
    input.setJumpHeld(true); // 按住期间等同按住空格（喷气背包据此持续上升）
    input.queueJump();       // 同时入队一次起跳，落地瞬间即可跳
    // 捕获指针，保证手指滑出按钮也能收到 pointerup（放在最后，避免捕获失败影响上面的置位）
    try { jumpBtn.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
  };
  const jumpRelease = (e) => {
    e.preventDefault();
    input.setJumpHeld(false);
  };
  // 注意：不要监听 pointerleave——触摸下设置指针捕获后浏览器可能触发一次 leave，
  // 会被误判成「松开」，导致喷气无法持续上升。只用 up / cancel 收尾。
  jumpBtn.addEventListener('pointerdown', jumpPress);
  jumpBtn.addEventListener('pointerup', jumpRelease);
  jumpBtn.addEventListener('pointercancel', jumpRelease);

  // ---- 左下人称切换器（1人称 / 3人称）----
  const viewBox = document.createElement('div');
  viewBox.className = 'mc-view';
  const seg1 = document.createElement('b');
  seg1.textContent = '1人称';
  const seg3 = document.createElement('b');
  seg3.textContent = '3人称';
  viewBox.appendChild(seg1);
  viewBox.appendChild(seg3);
  document.body.appendChild(viewBox);

  const isThird = () => !!(typeof opts.isThirdPerson === 'function' && opts.isThirdPerson());
  // 高亮永远以「真实状态」为准重画，这样别处（键鼠、以后加的设置项）改了人称也不会显示反
  const syncView = () => {
    const t = isThird();
    seg1.classList.toggle('on', !t);
    seg3.classList.toggle('on', t);
  };
  const pickView = (wantThird) => {
    if (wantThird === isThird()) return; // 已经在这一档就别切，免得把别处的状态又翻回去
    if (typeof opts.onToggleView === 'function') opts.onToggleView();
    syncView();
  };
  // 用 pointerdown 而不是 click：触屏上 click 有 ~300ms 的合成延迟，点了要过一会才有反应
  const bindSeg = (el, wantThird) => {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation(); // 别让这一次按下漏给下面的摇杆区
      pickView(wantThird);
    });
  };
  bindSeg(seg1, false);
  bindSeg(seg3, true);
  syncView();

  // ---- 左侧摇杆 ----
  const zone = document.createElement('div');
  zone.className = 'mc-zone mc-left';
  const base = document.createElement('div');
  base.className = 'mc-joy';
  const knob = document.createElement('div');
  knob.className = 'mc-knob';
  base.appendChild(knob);
  zone.appendChild(base);
  document.body.appendChild(zone);

  const RADIUS = 46; // 摇杆最大半径（px）
  let joyId = null;
  let cx = 0;
  let cy = 0;

  const joyDrag = (e) => {
    if (e.pointerId !== joyId) return;
    e.preventDefault();
    let dx = e.clientX - cx;
    let dy = e.clientY - cy;
    const len = Math.hypot(dx, dy);
    if (len > RADIUS) { // 钳制在圆内
      dx = (dx / len) * RADIUS;
      dy = (dy / len) * RADIUS;
    }
    knob.style.transform = `translate(${dx}px,${dy}px)`;
    // x 右正、y 前正（屏幕上移为前进）
    input.setJoystick(dx / RADIUS, -dy / RADIUS);
  };
  const joyEnd = (e) => {
    if (e.pointerId !== joyId) return;
    joyId = null;
    knob.style.transform = '';
    input.setJoystick(0, 0);
  };
  // 摇杆基点中心：布局变化后可能需要重算，所以抽成函数（原来只在 pointerdown 里算一次）
  const refreshCenter = () => {
    const r = base.getBoundingClientRect();
    cx = r.left + r.width / 2;
    cy = r.top + r.height / 2;
  };

  zone.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    joyId = e.pointerId;
    zone.setPointerCapture(e.pointerId);
    refreshCenter();
    joyDrag(e);
  });
  zone.addEventListener('pointermove', joyDrag);
  zone.addEventListener('pointerup', joyEnd);
  zone.addEventListener('pointercancel', joyEnd);

  // ---- 右侧视角拖动 ----
  const look = document.createElement('div');
  look.className = 'mc-zone mc-right';
  document.body.appendChild(look);

  let lookId = null;
  let px = 0;
  let py = 0;

  const lookMove = (e) => {
    if (e.pointerId !== lookId) return;
    e.preventDefault();
    const dx = e.clientX - px;
    const dy = e.clientY - py;
    px = e.clientX;
    py = e.clientY;
    // 与鼠标视角同向：右拖看右、上拖看上；LocalPlayer 会用 MOUSE_SENSITIVITY 缩放，
    // 这里先换算成「等效鼠标增量」，保证实际灵敏度 = TOUCH_SENSITIVITY
    const k = Config.TOUCH_SENSITIVITY / Config.MOUSE_SENSITIVITY;
    input.addLookDelta(dx * k, dy * k);
  };
  const lookEnd = (e) => {
    if (e.pointerId !== lookId) return;
    lookId = null;
  };
  look.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    lookId = e.pointerId;
    look.setPointerCapture(e.pointerId);
    px = e.clientX;
    py = e.clientY;
  });
  look.addEventListener('pointermove', lookMove);
  look.addEventListener('pointerup', lookEnd);
  look.addEventListener('pointercancel', lookEnd);

  // 清触摸残留：旋转/地址栏收起后，摇杆基点变了、跳跃可能收不到配对的 up，
  // 会表现为「卡着不动」或「一直上升」。这里统一归零。
  _resetTouchState = () => {
    joyId = null;
    lookId = null;
    knob.style.transform = '';
    input.setJoystick(0, 0);
    input.setJumpHeld(false);
  };

  // 视口尺寸真的变了才清输入（visualViewport 的 scroll 也会触发重排，别把正在拖的摇杆打断）
  let lastW = 0;
  let lastH = 0;
  onRelayout(() => {
    const { width, height } = viewportSize();
    if (width !== lastW || height !== lastH) {
      lastW = width;
      lastH = height;
      if (_resetTouchState) _resetTouchState();
    }
    refreshCenter(); // 摇杆基点随布局重算
  });
}