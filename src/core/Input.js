// 职责：封装键盘 + 鼠标指针锁定，向玩家逻辑提供输入状态。
// 采用自定义指针锁定（点击画面 requestPointerLock，按 ESC 由浏览器自动解锁），
// 这样旋转量由 LocalPlayer 自己消费，避免依赖 OrbitControls / PointerLockControls 抢占相机。

import { Config } from '../config.js';

export class Input {
  constructor() {
    // 由 LocalPlayer 通过 setCanvas 注入渲染画布，用于请求指针锁定
    this.canvas = null;

    // 当前按住的键（小写字母）
    this._keys = new Set();
    // 鼠标移动量缓存：LocalPlayer 每帧读取后清零
    this._mouseDelta = { x: 0, y: 0 };
    // 虚拟摇杆轴向（手机）：x 右正，y 前正，范围 [-1,1]；无摇杆时保持 0
    this._joy = { x: 0, y: 0 };
    // 跳跃请求：按下空格时置 true，LocalPlayer 消费后调用 consumeJump() 复位
    this._jumpQueued = false;
    // 指针是否锁定（表示正在用第一人称视角控制）
    this.locked = false;

    this._bindEvents();
  }

  // 绑定鼠标锁定与键盘监听
  _bindEvents() {
    document.addEventListener('mousemove', (e) => this._onMouseMove(e));
    document.addEventListener('keydown', (e) => this._onKeyDown(e));
    document.addEventListener('keyup', (e) => this._onKeyUp(e));
    document.addEventListener('pointerlockchange', () => this._onLockChange());
  }

  // 绑定要锁定的画布：点击画布请求指针锁定
  setCanvas(canvas) {
    this.canvas = canvas;
    canvas.addEventListener('click', () => {
      // 建筑工具开启时交由放置逻辑处理，不锁定视角
      if (window.__BUILD_TOOL_ACTIVE__) return;
      if (document.pointerLockElement !== canvas) {
        canvas.requestPointerLock();
      }
    });
  }

  // 鼠标移动时，若处于锁定状态则累加移动量
  _onMouseMove(e) {
    if (document.pointerLockElement === this.canvas) {
      this._mouseDelta.x += e.movementX;
      this._mouseDelta.y += e.movementY;
    }
  }

  // 记录按住 / 按下的键；空格额外标记为一次跳跃请求
  _onKeyDown(e) {
    // 正在文本输入（聊天 / 对话栏）时不接管按键，否则打字会顺带走路
    if (isEditableTarget(e.target)) return;
    const key = e.code;
    this._keys.add(key);
    if (key === 'Space') {
      this._jumpQueued = true;
      // 避免按住空格时页面滚动
      e.preventDefault();
    }
  }

  _onKeyUp(e) {
    this._keys.delete(e.code);
  }

  // 清空「当前按住的键」：打开文本输入框时调用。
  // 否则「按住 W → 按 T 开聊天」会让 W 一直留在集合里，角色边打字边往前走。
  clearKeys() {
    this._keys.clear();
  }

  // 指针锁定状态变化：同步 locked 标志
  _onLockChange() {
    this.locked = document.pointerLockElement === this.canvas;
  }

  // 指定键当前是否按下（用 e.code 的键名，如 'KeyW'、'ShiftLeft'）
  isDown(code) {
    return this._keys.has(code);
  }

  // 是否有待消费的跳跃请求
  consumeJump() {
    const jump = this._jumpQueued;
    this._jumpQueued = false;
    return jump;
  }

  // 手机跳跃按钮：与空格键同一个入队队列，LocalPlayer 消费后经 consumeJump() 复位
  queueJump() {
    this._jumpQueued = true;
  }

  // 手机跳跃按钮的「按住」状态：置位后等同于按住空格，
  // 供喷气背包等需要持续按住的逻辑（isDown('Space')）使用。
  setJumpHeld(v) {
    if (v) this._keys.add('Space');
    else this._keys.delete('Space');
  }

  // 读取并清零本帧的鼠标移动量（像素）
  // 返回 { x, y }，LocalPlayer 据此更新 yaw / pitch
  takeMouseDelta() {
    const d = { x: this._mouseDelta.x, y: this._mouseDelta.y };
    this._mouseDelta.x = 0;
    this._mouseDelta.y = 0;
    return d;
  }

  // 手机触屏视角拖动：增量累加到本帧的视角移动量（与鼠标共用同一累积，LocalPlayer 无感知）
  addLookDelta(dx, dy) {
    this._mouseDelta.x += dx;
    this._mouseDelta.y += dy;
  }

  // 设置虚拟摇杆轴向：x 右为正、y 前为正，范围 [-1,1]
  setJoystick(x, y) {
    this._joy.x = x;
    this._joy.y = y;
  }

  // 摇杆当前轴向 / 幅度（幅度用于判断是否冲刺）
  get joyX() { return this._joy.x; }
  get joyY() { return this._joy.y; }
  joyMagnitude() {
    return Math.hypot(this._joy.x, this._joy.y);
  }

  // 常用键的便捷别名
  forwarded = () => this.isDown('KeyW');
  backwarded = () => this.isDown('KeyS');
  strafeLeft = () => this.isDown('KeyA');
  strafeRight = () => this.isDown('KeyD');
  sprinting = () => this.isDown('ShiftLeft') || this.isDown('ShiftRight');
}

// 事件目标是否是可编辑的文本框（聊天 / 对话栏正在输入）。
// 这种时候游戏热键一律让路，否则打字会顺带走路、跳跃、开盾。
// 只认「输入类」元素：HTML 里按钮/div 聚焦时 tagName 是 BUTTON/DIV，那些仍然要能响应热键。
export function isEditableTarget(t) {
  if (!t || !t.tagName) return false;
  const tag = String(t.tagName).toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable === true;
}