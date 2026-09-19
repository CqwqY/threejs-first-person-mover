// 职责：手机触屏适配。在触屏设备上追加两套覆盖控件，把触摸输入翻译成 Input 的摇杆轴与视角增量：
//   左侧虚拟摇杆 -> 移动（前后/左右，推满触发冲刺）
//   右侧拖动区   -> 转视角（yaw/pitch，复用鼠标视角的累计入口）
// 非触屏设备（粗指针）不创建任何 DOM，保持桌面体验不变。
import { Config } from '../config.js';

export function initMobileControls(input) {
  const coarse =
    (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
    'ontouchstart' in window;
  if (!coarse) return;

  // 控件样式（一次性注入）
  const style = document.createElement('style');
  style.textContent = `
    .mc-zone{position:fixed;bottom:0;touch-action:none;user-select:none;-webkit-user-select:none;z-index:50}
    .mc-left{left:0;width:44vw;height:42vh}
    .mc-right{right:0;width:56vw;height:48vh}
    .mc-joy{position:absolute;left:20px;bottom:26px;width:118px;height:118px;border-radius:50%;
      border:2px solid rgba(255,255,255,.32);background:rgba(255,255,255,.08);
      box-sizing:content-box}
    .mc-joy::after{content:'';position:absolute;inset:50%;width:64px;height:64px;transform:translate(-50%,-50%);
      border-radius:50%;border:1px solid rgba(255,255,255,.18)}
    .mc-knob{position:absolute;left:50%;top:50%;width:54px;height:54px;transform:translate(-50%,-50%);
      border-radius:50%;background:rgba(255,255,255,.5);box-shadow:0 4px 12px rgba(0,0,0,.3)}
  `;
  document.head.appendChild(style);

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
  zone.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    joyId = e.pointerId;
    zone.setPointerCapture(e.pointerId);
    const r = base.getBoundingClientRect();
    cx = r.left + r.width / 2;
    cy = r.top + r.height / 2;
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
}