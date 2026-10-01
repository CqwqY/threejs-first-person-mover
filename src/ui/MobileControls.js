// 职责：手机触屏适配。在触屏设备上追加两套覆盖控件，把触摸输入翻译成 Input 的摇杆轴与视角增量：
//   左侧虚拟摇杆 -> 移动（前后/左右，推满触发冲刺）
//   右侧拖动区   -> 转视角（yaw/pitch，复用鼠标视角的累计入口）
// 非触屏设备（粗指针）不创建任何 DOM，保持桌面体验不变。
import { Config } from '../config.js';
import { onRelayout, viewportSize } from './layout.js';

// 模块级持有者：把「清触摸残留」暴露给重排逻辑，旋转/地址栏变化时调用
let _resetTouchState = null;
export function resetTouchState() {
  if (_resetTouchState) _resetTouchState();
}

export function initMobileControls(input) {
  const coarse =
    (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
    'ontouchstart' in window;
  if (!coarse) return;

  // 控件样式（一次性注入）
  const style = document.createElement('style');
  style.textContent = `
    .mc-zone{position:fixed;bottom:0;touch-action:none;user-select:none;-webkit-user-select:none;z-index:50}
    /* dvh 跟随「可视视口」；不支持时回退到 vh。横屏下 42vh 可能比摇杆还矮，用 min-height 兜底 */
    .mc-left{left:0;width:44vw;height:42vh;height:42dvh;min-height:200px}
    .mc-right{right:0;top:0;width:50vw;height:100vh;height:100dvh}
    .mc-joy{position:absolute;left:20px;bottom:26px;width:118px;height:118px;border-radius:50%;
      border:2px solid rgba(255,255,255,.32);background:rgba(255,255,255,.08);
      box-sizing:content-box}
    .mc-joy::after{content:'';position:absolute;inset:50%;width:64px;height:64px;transform:translate(-50%,-50%);
      border-radius:50%;border:1px solid rgba(255,255,255,.18)}
    .mc-knob{position:absolute;left:50%;top:50%;width:54px;height:54px;transform:translate(-50%,-50%);
      border-radius:50%;background:rgba(255,255,255,.5);box-shadow:0 4px 12px rgba(0,0,0,.3)}
    .mc-jump{position:fixed;right:20px;bottom:calc(env(safe-area-inset-bottom, 0px) + 24px);
      width:72px;height:72px;border-radius:50%;z-index:51;
      display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,.9);
      font-size:15px;font-weight:600;letter-spacing:1px;
      background:rgba(255,255,255,.12);border:2px solid rgba(255,255,255,.35);
      touch-action:none;user-select:none;-webkit-user-select:none}
    .mc-jump:active{background:rgba(255,255,255,.3)}
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