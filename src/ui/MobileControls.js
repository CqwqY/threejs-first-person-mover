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
    /* 独立输入界面（打字）打开时整组藏起来：只让玩家"看不见"是不够的 ——
       看不见却还摸得到，照样会误触摇杆把人走飞。
       ⚠ 用 visibility 而不是 display：display:none 会让技能槽/刹车的
       getBoundingClientRect 归零，驾驶时「刹车对齐技能槽」的位置计算就崩了（踩过这个坑）。 */
    body.mc-hidden .mc-zone, body.mc-hidden .mc-joy, body.mc-hidden .mc-jump,
    body.mc-hidden .mc-drive, body.mc-hidden .mc-gear, body.mc-hidden .mc-brake,
    body.mc-hidden .mc-view, body.mc-hidden .sk-box {
      visibility: hidden !important;
      pointer-events: none !important;
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
    /* 开车时摇杆变「前进油门键」：不再是模拟摇杆，按下去就是全油门（见 setDriving / 指针处理）。
       中央那个「油门」字样只在驾驶时露出来（此时滑块被顶到上方，中央是空的）。 */
    .mc-joy .mc-joy-lbl{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
      font:600 clamp(12px,3.4vmin,15px)/1 var(--kui-font);color:var(--kui-paper);
      letter-spacing:2px;opacity:0;pointer-events:none}
    .mc-joy.is-throttle{border-color:color-mix(in srgb, var(--kui-gold) 80%, transparent);
      background:color-mix(in srgb, var(--kui-gold) 16%, transparent)}
    .mc-joy.is-throttle .mc-knob{background:color-mix(in srgb, var(--kui-gold) 82%, transparent)}
    .mc-joy.is-throttle .mc-joy-lbl{opacity:.95}
    /* 档位切换（前/倒）：油门键自己管方向，这颗小圆钮就贴在油门右侧。
       竖着放（前进在上、倒车在下），和「上推前进/下拉倒车」的直觉一致。 */
    .mc-gear{position:fixed;z-index:53;display:none;flex-direction:column;align-items:center;justify-content:center;
      gap:0;width:clamp(46px,12vmin,56px);height:clamp(46px,12vmin,56px);border-radius:50%;
      left:calc(env(safe-area-inset-left, 0px) + 150px);
      bottom:calc(env(safe-area-inset-bottom, 0px) + 58px);
      color:var(--kui-paper);font:600 clamp(11px,3vmin,13px)/1 var(--kui-font);
      background:color-mix(in srgb, var(--kui-blue) 30%, transparent);
      border:2px solid color-mix(in srgb, var(--kui-blue-soft) 75%, transparent);
      box-sizing:border-box;touch-action:none;user-select:none;-webkit-user-select:none}
    .mc-gear > b{display:flex;align-items:center;justify-content:center;width:100%;height:50%;
      font-weight:600;opacity:.45}
    .mc-gear > b.on{opacity:1;background:color-mix(in srgb, var(--kui-gold) 55%, transparent);
      border-radius:50% 50% 0 0}
    .mc-gear > b:last-child.on{border-radius:0 0 50% 50%}
    /* 刹车键：驾驶时**顶替技能槽**（技能槽那会儿对开车没意义），所以跟着技能槽一起被摆位。
       尺寸在 setDriving 里按技能槽实际宽度对齐，看起来就是"技能槽变成了刹车"。 */
    .mc-brake{position:fixed;z-index:61;display:none;align-items:center;justify-content:center;
      border-radius:50%;color:var(--kui-paper);
      font:600 clamp(12px,3.2vmin,14px)/1 var(--kui-font);letter-spacing:1px;
      background:color-mix(in srgb, var(--kui-red, #d64545) 34%, transparent);
      border:2px solid color-mix(in srgb, var(--kui-red, #d64545) 70%, transparent);
      box-sizing:border-box;touch-action:none;user-select:none;-webkit-user-select:none}
    .mc-brake:active{background:color-mix(in srgb, var(--kui-red, #d64545) 68%, transparent)}
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

  // ---- 驾驶键（只在开电动车时显示）：左转 / 右转 ----
  // 驾驶时跳跃本来就无效，所以直接把右下那颗「跳」临时换成转向键组：位置不动、不额外抢屏幕。
  // 刹车不在这里 —— 它顶替了技能槽（见 setDriving）；倒车也不在这里 —— 由油门键的「前/倒」档管。
  // 按钮不另设输入通道，直接往 Input 里塞 A / D —— 与键盘完全同一套判定（见 Input.setVirtualKey）。
  const drivePad = document.createElement('div');
  drivePad.className = 'mc-drive';
  drivePad.style.cssText =
    'position:fixed;right:calc(env(safe-area-inset-right, 0px) + 20px);' +
    'bottom:calc(env(safe-area-inset-bottom, 0px) + 24px);z-index:51;display:none;' +
    'gap:14px;align-items:center;touch-action:none;user-select:none;-webkit-user-select:none;';
  const mkDriveBtn = (text, code) => {
    const b = document.createElement('div');
    b.className = 'mc-drive-btn';
    b.textContent = text;
    b.style.cssText =
      'width:clamp(56px,15vmin,72px);height:clamp(56px,15vmin,72px);border-radius:50%;' +
      'display:flex;align-items:center;justify-content:center;box-sizing:border-box;' +
      'color:var(--kui-paper);font-size:clamp(13px,3.6vmin,16px);font-weight:600;font-family:var(--kui-font);' +
      'background:color-mix(in srgb, var(--kui-blue) 30%, transparent);' +
      'border:2px solid color-mix(in srgb, var(--kui-blue-soft) 75%, transparent);touch-action:none;';
    const press = (e) => {
      e.preventDefault();
      e.stopPropagation();
      input.setVirtualKey(code, true);
      try { b.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    };
    const release = (e) => { e.preventDefault(); input.setVirtualKey(code, false); };
    b.addEventListener('pointerdown', press);
    b.addEventListener('pointerup', release);
    b.addEventListener('pointercancel', release);
    drivePad.appendChild(b);
    return b;
  };
  mkDriveBtn('◀', 'KeyA');   // 左转
  mkDriveBtn('▶', 'KeyD');   // 右转
  document.body.appendChild(drivePad);

  // ---- 档位切换（前进 / 倒车）：只给油门键用，所以也只在驾驶时出现 ----
  // 上下两格，上面=前进、下面=倒车（竖排符合"上推前进/下拉倒车"的直觉）。
  const gearBox = document.createElement('div');
  gearBox.className = 'mc-gear';
  const gearFwd = document.createElement('b');
  gearFwd.textContent = '前';
  const gearRev = document.createElement('b');
  gearRev.textContent = '倒';
  gearBox.appendChild(gearFwd);
  gearBox.appendChild(gearRev);
  document.body.appendChild(gearBox);

  // ---- 刹车键：驾驶时顶替技能槽 ----
  // 单独建一个元素，靠 setDriving 定位到技能槽当前位置并把技能槽藏起来；下车再原样还回去。
  const brakeBtn = document.createElement('div');
  brakeBtn.className = 'mc-brake';
  brakeBtn.textContent = '刹';
  document.body.appendChild(brakeBtn);
  const brakePress = (e) => {
    e.preventDefault();
    e.stopPropagation();
    input.setVirtualKey('Space', true); // 与键盘空格同一套刹车判定
    try { brakeBtn.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
  };
  const brakeRelease = (e) => {
    e.preventDefault();
    input.setVirtualKey('Space', false);
  };
  brakeBtn.addEventListener('pointerdown', brakePress);
  brakeBtn.addEventListener('pointerup', brakeRelease);
  brakeBtn.addEventListener('pointercancel', brakeRelease);

  // 挡位：+1 前进 / -1 倒车。油门键按当前挡位给满油门，倒车不用另设按钮。
  let gear = 1;
  // ⚠ 摇杆中央那行字（joyLbl）在下面才创建，所以这里用 _joyLbl 中转：
  //   applyGear 会被立刻调用一次，若直接引用后声明的 const joyLbl 就是 TDZ 报错。
  let _joyLbl = null;
  const applyGear = () => {
    gearFwd.classList.toggle('on', gear > 0);
    gearRev.classList.toggle('on', gear < 0);
    if (_joyLbl) _joyLbl.textContent = gear > 0 ? '油门' : '倒车';
  };
  applyGear();
  gearBox.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    gear = -gear;
    applyGear();
    // 正在踩油门时换挡：立刻按新挡位重新给油（否则要等松手再按一下）
    if (driving && joyId !== null) input.setJoystick(0, gear);
  });

  // 把刹车键摆到技能槽当前位置（技能槽被顶替，所以直接量它的 rect 对齐大小与圆心）
  // 量不到（技能槽正被对战/灵魂出窍隐藏着，rect 为 0）时退回「跳跃键正上方」——
  // 也就是技能槽的默认锚点，保证任何时候刹车键都在右手够得到的地方。
  const placeBrakeAtSkillSlot = () => {
    const sk = document.querySelector('.sk-box');
    let r = sk ? sk.getBoundingClientRect() : null;
    if (!r || !r.width || !r.height) {
      const j = jumpBtn.getBoundingClientRect();
      if (!j.width) return;
      const size = Math.max(j.width, 56);
      r = { left: j.left + j.width / 2 - size / 2, top: j.top - 14 - size, width: size, height: size };
    }
    brakeBtn.style.left = r.left + 'px';
    brakeBtn.style.top = r.top + 'px';
    brakeBtn.style.width = r.width + 'px';
    brakeBtn.style.height = r.height + 'px';
  };
  // 驾驶时藏技能槽、亮刹车。技能槽自己那套显隐（对战/灵魂出窍）由 Game 管，
  // 所以这里只切 inline style，下车时原样恢复。
  // ⚠ 用 visibility:hidden 而不是 display:none —— display:none 会让 getBoundingClientRect()
  //   全变 0，旋转屏幕后就再也找不到技能槽该在哪儿了。visibility 保留布局盒，rect 照常有效。
  const swapSkillSlotForBrake = (on) => {
    const sk = document.querySelector('.sk-box');
    if (on) {
      // ⚠ 别因为「技能槽还没建好」就 return —— 那会让刹车键永远不出现。
      //   placeBrakeAtSkillSlot 内部已有「量不到就退回跳跃键上方」的兜底。
      placeBrakeAtSkillSlot();
      if (sk) {
        sk.dataset.mcPrevVis = sk.style.visibility || '';
        sk.dataset.mcPrevPE = sk.style.pointerEvents || '';
        sk.style.visibility = 'hidden';
        sk.style.pointerEvents = 'none';
      }
      brakeBtn.style.display = 'flex';
    } else {
      if (sk) {
        sk.style.visibility = sk.dataset.mcPrevVis || '';
        sk.style.pointerEvents = sk.dataset.mcPrevPE || '';
        delete sk.dataset.mcPrevVis;
        delete sk.dataset.mcPrevPE;
      }
      brakeBtn.style.display = 'none';
    }
  };

  // 进出驾驶：藏「跳」露转向键；摇杆切成「油门键」+ 亮出前/倒档；技能槽被刹车顶替
  let driving = false; // 是否在开车（决定左下摇杆是「模拟摇杆」还是「油门键」）
  const setDriving = (on) => {
    driving = !!on;
    drivePad.style.display = driving ? 'flex' : 'none';
    jumpBtn.style.display = driving ? 'none' : '';
    base.classList.toggle('is-throttle', driving);
    gearBox.style.display = driving ? 'flex' : 'none';
    swapSkillSlotForBrake(driving);
    if (driving) {
      // 进驾驶先复位：不要让上一轮残留的摇杆轴向继续当油门；档位也回正到「前」
      knob.style.transform = '';
      input.setJoystick(0, 0);
      gear = 1;
      applyGear();
    } else {
      input.setVirtualKey('KeyA', false);
      input.setVirtualKey('KeyD', false);
      input.setVirtualKey('KeyS', false);
      input.setVirtualKey('Space', false);
      joyId = null;
      knob.style.transform = '';
      input.setJoystick(0, 0);
    }
  };

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
  // 「油门」字样：只在开车时露出来（此时滑块被顶到上方，中央正好空着）
  const joyLbl = document.createElement('div');
  joyLbl.className = 'mc-joy-lbl';
  joyLbl.textContent = '油门';
  base.appendChild(joyLbl);
  _joyLbl = joyLbl; // 交给 applyGear（挡位切换时改文案：油门 ↔ 倒车）
  applyGear();
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
    // ⚠ 必须带上 CSS 里的 -50%,-50% 居中分量：inline transform 会整条覆盖类里的 transform，
    // 少写这一截滑块会整体偏右下半格（约 27px），按下时「跳」一下。
    knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
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

  // 开车时摇杆 = 「油门键」：按下即**当前档位**的满油门、松手回零。走的是**同一条摇杆输入通道**
  // （setJoystick(0,±1) 与「把摇杆前推/后拉到底」等价），所以驾驶逻辑一行都不用改。
  // 前进/倒车由那颗「前/倒」档位钮决定，倒车因此不用再单独占一个按钮。
  // 不做模拟拖动：另一只手在管左右转向，拖摇杆很难拖稳，按一下更跟手。
  const pressThrottle = () => {
    input.setJoystick(0, gear);
    // 视觉上把滑块顶到最前（倒挡则压到最底）；同样要保留 -50% 居中分量
    knob.style.transform = gear > 0
      ? `translate(-50%, calc(-50% - ${RADIUS}px))`
      : `translate(-50%, calc(-50% + ${RADIUS}px))`;
  };
  const releaseThrottle = (e) => {
    if (e.pointerId !== joyId) return;
    joyId = null;
    input.setJoystick(0, 0);
    knob.style.transform = '';
  };

  zone.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    joyId = e.pointerId;
    zone.setPointerCapture(e.pointerId);
    if (driving) { pressThrottle(); return; } // 开车：按下就是油门，不做摇杆拖动
    refreshCenter();
    joyDrag(e);
  });
  zone.addEventListener('pointermove', (e) => {
    if (driving) return; // 开车时忽略拖动，避免手指滑动被当成倒车
    joyDrag(e);
  });
  zone.addEventListener('pointerup', (e) => {
    if (driving) { releaseThrottle(e); return; }
    joyEnd(e);
  });
  zone.addEventListener('pointercancel', (e) => {
    if (driving) { releaseThrottle(e); return; }
    joyEnd(e);
  });

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
    // 驾驶虚拟键也一起清（旋转/重排时最容易被落下，表现为「车一直自己转」/「一直倒车」）
    input.setVirtualKey('KeyA', false);
    input.setVirtualKey('KeyD', false);
    input.setVirtualKey('KeyS', false);
    input.setVirtualKey('Space', false);
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
    if (driving) placeBrakeAtSkillSlot(); // 刹车键贴着技能槽，技能槽挪了它也得挪
  });

  // 打字（手机端独立输入界面）时整组隐藏；同时清掉触摸残留 ——
  // 否则「按住摇杆 → 点开聊天」会因为收不到配对的 up 而一直往前走。
  const setHidden = (on) => {
    document.body.classList.toggle('mc-hidden', !!on);
    if (on && _resetTouchState) _resetTouchState();
  };

  // 供 Game 在上下车时调用：驾驶键组与「跳」互换、技能槽被刹车顶替
  return { setDriving, setHidden };
}