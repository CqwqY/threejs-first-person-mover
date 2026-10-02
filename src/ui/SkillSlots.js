// 职责：技能槽 UI。阿花放进背包的物品在这里变成可触发技能：
//   手机：沿「跳跃键上方」的圆弧排布（圆心跟随跳跃键，槽位数量决定半径）；空槽不显示；
//         触摸优先级高于右侧转视角区（z-index 更高、slot 自行捕获指针）。
//   PC  ：横向一排，靠屏右下角。
// 固定 SLOT_COUNT 个槽位，每个槽绑定一个触发键（PC 数字键 1..N），点击槽位或按下对应键触发。
// 物品可被「指定」到某个具体槽位（背包里选槽位后点使用即可）。
import { ensureTheme } from './theme.js';
import { onRelayout, viewportSize, readLayout, currentMode } from './layout.js';

export const SKILL_KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8'];
export const SLOT_COUNT = SKILL_KEYS.length;
const COOLDOWN = 800; // 相邻两次触发的最小间隔（毫秒）

export function createSkillSlots(opts = {}) {
  ensureTheme();
  // 丢弃手势相关：PC 按住修饰键 + 数字键；手机长按技能槽后上滑
  const dropModifier = opts.dropModifier || 'KeyY';
  const gestureMs = Number.isFinite(opts.gestureMs) ? opts.gestureMs : 320;
  const gestureDy = Number.isFinite(opts.gestureDy) ? opts.gestureDy : 42;
  const coarse =
    (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
    'ontouchstart' in window;

  const box = document.createElement('div');
  box.className = 'sk-box ' + (coarse ? 'sk-box--mobile' : 'sk-box--desk');
  // 容器不拦截触摸：只有具体槽位可点，缝隙仍可用来转视角
  box.style.position = 'fixed';
  box.style.zIndex = '60';
  box.style.display = 'flex';
  box.style.pointerEvents = 'none';
  if (coarse) {
    // 手机：容器是「零尺寸锚点」，圆心即它的左上角；各槽位按圆弧绝对定位在孩子上。
    // 这样圆心能跟着跳跃键走（跳跃键被「按键布局」拖走时技能弧也会跟着挪）。
    box.style.width = '0px';
    box.style.height = '0px';
    box.style.right = 'calc(env(safe-area-inset-right, 0px) + 56px)';
    box.style.bottom = 'calc(env(safe-area-inset-bottom, 0px) + 60px)';
    box.style.flexDirection = 'column';
    box.style.alignItems = 'center';
    box.style.gap = '0px';
  } else {
    // PC：横向一排，靠屏右下角
    box.style.right = '18px';
    box.style.bottom = '22px';
    box.style.flexDirection = 'row';
    box.style.alignItems = 'center';
    box.style.gap = '8px';
  }
  document.body.appendChild(box);

  const slots = [];

  let dropHandler = null; // 由 Game 注入：丢弃第 index 个槽位的物品
  let yHeld = false;      // PC：丢弃修饰键是否按住（按住 + 数字键 = 丢弃）

  // 丢弃某个槽位（仅在技能栏未被整体隐藏、且已注入处理器时生效）
  function dropSlot(slot) {
    if (boxHidden || !dropHandler) return;
    const idx = slots.indexOf(slot);
    if (idx < 0) return;
    dropHandler(idx);
  }

  function setDropHandler(fn) {
    dropHandler = typeof fn === 'function' ? fn : null;
  }

  function fire(slot) {
    if (boxHidden) return; // 整体隐藏时（对战 / 灵魂出窍）技能不可触发，而不只是看不见
    const now = performance.now();
    if (now < slot.cdUntil || !slot.act) return;
    slot.cdUntil = now + COOLDOWN;
    slot.el.style.opacity = '0.55';
    setTimeout(() => { slot.el.style.opacity = '1'; }, COOLDOWN);
    slot.act();
  }

  // 空槽显示「空」，有技能显示技能名；手机上空槽直接隐藏，容器内没有可用技能时整个容器隐藏
  function paint(slot) {
    slot.labelEl.textContent = slot.act ? (slot.name || '技能') : '空';
    slot.labelEl.style.color = slot.act ? 'var(--kui-ink)' : 'var(--kui-ink-soft)';
    slot.el.style.display = (coarse && !slot.act) ? 'none' : '';
    if (coarse) layoutArc();
  }
  // boxHidden：由外部（Game）控制整体隐藏——某些模式（对战 / 灵魂出窍）不显示技能栏
  let boxHidden = false;
  function applyBoxDisplay() {
    if (boxHidden) { box.style.display = 'none'; return; }
    const any = slots.some((s) => s.act);
    box.style.display = (!coarse || any) ? 'flex' : 'none';
  }
  function refreshBox() { applyBoxDisplay(); if (coarse) layoutArc(); }

  // ---- 手机端圆弧布局 ----
  // 圆心：用过「按键布局」拖动技能槽 → 用保存的比例位置；没拖过 → 跟着跳跃键
  // （跳跃键被拖走时整条弧一起走）。这里自己算圆心再写 box 的 left/top，
  // 而不是读 box 当前位置，否则「第一次写完 left/top」会把自己误判成「已被拖动过」。
  let savedPos = null;
  function readSavedPos() {
    try {
      const conf = readLayout(currentMode()) || {};
      const p = conf.skill;
      savedPos = (p && Number.isFinite(p.cx) && Number.isFinite(p.cy)) ? p : null;
    } catch (e) { savedPos = null; }
  }
  function arcCenter() {
    if (savedPos) {
      const { width, height } = viewportSize();
      return { cx: savedPos.cx * width, cy: savedPos.cy * height };
    }
    const jump = document.querySelector('.mc-jump');
    if (jump) {
      const r = jump.getBoundingClientRect();
      if (r.width) return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    }
    const { width, height } = viewportSize();
    return { cx: width - 56, cy: height - 60 }; // 与 .mc-jump 的默认定位一致
  }

  // 变换里带上 translate(-50%,-50%)，否则长方形槽位会以左上角对齐圆弧点
  function placeSlot(s) {
    s.el.style.left = s.arcX + 'px';
    s.el.style.top = s.arcY + 'px';
    s.el.style.transform = 'translate(-50%,-50%)' + (s.pressed ? ' scale(0.92)' : '');
  }

  // 只给「有技能」的槽位排位置：从左下方绕到右上方的一段圆弧（都落在跳跃键上方）
  function layoutArc() {
    if (!coarse) return;
    const anchor = arcCenter();
    box.style.left = anchor.cx + 'px';
    box.style.top = anchor.cy + 'px';
    box.style.right = 'auto';
    box.style.bottom = 'auto';
    const visible = slots.filter((s) => s.act);
    const n = visible.length;
    if (!n) return;
    // 半径随数量增长，保证相邻槽位不叠在一起；上限避免跑到屏幕外
    // （槽位最大 58px，弧长约 108°，所以 n 个槽位需要 R ≈ (n-1)*30 才不会明显重叠）
    const R = Math.min(200, Math.max(104, (n - 1) * 30));
    const a0 = 178 * Math.PI / 180; // 起点：正左（略高于水平线，别掉到跳跃键中线以下）
    const a1 = 70 * Math.PI / 180;  // 终点：右上
    for (let i = 0; i < n; i++) {
      const a = n === 1 ? Math.PI / 2 : (a0 + (a1 - a0) * (i / (n - 1)));
      const s = visible[i];
      s.arcX = Math.cos(a) * R;
      s.arcY = -Math.sin(a) * R; // 屏幕 y 向下 → 取负才是「上方」
      placeSlot(s);
    }
  }
  onRelayout(() => { if (coarse) { readSavedPos(); layoutArc(); } });

  // 预建全部槽位
  if (coarse) readSavedPos(); // 先读出「按键布局」里是否存过技能槽位置，再排圆弧
  for (let i = 0; i < SLOT_COUNT; i++) {
    const keyName = SKILL_KEYS[i];
    const el = document.createElement('div');
    el.className = 'sk-slot kui-iconbtn';
    // 触摸优先：槽位自身捕获指针，容器缝隙仍可转视角
    el.style.pointerEvents = 'auto';
    el.style.touchAction = 'none';
    el.style.userSelect = 'none';
    el.style.setProperty('-webkit-user-select', 'none');
    el.style.cursor = 'pointer';
    el.style.flexDirection = 'column';
    el.style.alignItems = 'center';
    el.style.justifyContent = 'center';
    el.style.gap = '2px';
    el.style.textAlign = 'center';
    el.style.fontFamily = 'var(--kui-font)';
    if (coarse) {
      // 尺寸用 vmin（短边）而不是 vw——vw 在旋转后宽度翻倍会让控件突然变大
      el.style.width = 'clamp(42px, 12vmin, 58px)';
      el.style.height = 'clamp(42px, 12vmin, 58px)';
      el.style.fontSize = 'clamp(10px, 2.8vmin, 12px)';
      el.style.position = 'absolute'; // 圆弧定位：坐标相对零尺寸容器（＝圆心）
      el.style.left = '0px';
      el.style.top = '0px';
      el.style.transform = 'translate(-50%,-50%)';
    } else {
      el.style.minWidth = '56px';
      el.style.height = '56px';
      el.style.fontSize = '12px';
    }
    const label = document.createElement('div');
    label.className = 'sk-label';
    label.style.fontWeight = '600';
    label.style.maxWidth = '100%';
    label.style.padding = '0 4px';
    label.style.overflow = 'hidden';
    label.style.textOverflow = 'ellipsis';
    label.style.whiteSpace = 'nowrap';
    el.appendChild(label);
    const keyEl = document.createElement('div');
    keyEl.className = 'sk-key kui-num';
    keyEl.style.fontSize = 'clamp(9px, 2.4vmin, 10px)';
    keyEl.style.color = 'var(--kui-ink-soft)';
    keyEl.textContent = keyName.slice(-1);
    el.appendChild(keyEl);

    const slot = { el, labelEl: label, act: null, name: '', cdUntil: 0, keyName };
    // 触摸优先：自行捕获指针并阻止冒泡，确保点击技能槽不会同时被转视角区吃掉。
    // 直接按下即触发（不等 click）：多点触控时另一只手正按住摇杆，合成的 click 常常不派发，
    // 会导致「边走边点技能」没反应。
    // 手势：轻点 = 触发技能；长按（≥gestureMs）后上滑（≥gestureDy）= 丢弃该槽物品。
    // 因此这里改为「按下记录、抬起才触发」：只有这样才能把轻点与长按上滑区分开。
    // 指针已被该元素捕获，多点触控下 pointerup 仍会派发到本元素（不同于合成 click），
    // 所以「另一只手按着摇杆时边走边点技能」依然可用。
    let pressT = 0;      // 本次按下的时间戳
    let pressY = 0;      // 本次按下的纵坐标
    let armed = false;   // 是否已进入「长按」状态
    let consumed = false;// 本次手势是否已作为丢弃消费掉
    let timer = 0;
    const clearTimer = () => { if (timer) { clearTimeout(timer); timer = 0; } };
    // 长按反馈：手机端的槽位是靠 transform 定位到圆弧上的，所以缩放必须叠加在
    // translate(-50%,-50%) 之上（直接写 scale 会把槽位弹回容器左上角）。
    const setPressed = (v) => {
      slot.pressed = !!v;
      if (coarse) placeSlot(slot);
      else el.style.transform = v ? 'scale(0.92)' : '';
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      pressT = performance.now();
      pressY = e.clientY;
      armed = false;
      consumed = false;
      clearTimer();
      timer = setTimeout(() => {
        timer = 0;
        armed = true;
        setPressed(true); // 长按反馈：轻微收缩，提示「可上滑丢弃」
      }, gestureMs);
    });
    el.addEventListener('pointermove', (e) => {
      if (!armed || consumed) return;
      if (pressY - e.clientY >= gestureDy) { // 上滑超过阈值 → 丢弃
        consumed = true;
        armed = false;
        clearTimer();
        setPressed(false);
        dropSlot(slot);
      }
    });
    const endPress = (canceled) => {
      clearTimer();
      setPressed(false);
      const wasArmed = armed;
      armed = false;
      if (canceled || consumed || wasArmed) return; // 取消 / 已丢弃 / 长按过但没上滑 → 都不触发技能
      if (performance.now() - pressT < gestureMs) fire(slot); // 轻点 → 触发技能
    };
    el.addEventListener('pointerup', () => endPress(false));
    el.addEventListener('pointercancel', () => endPress(true));
    box.appendChild(el);
    slots.push(slot);
    paint(slot);
  }
  refreshBox();

  // 指定装备到第 index 槽（0 起）。返回 true 表示成功。
  function assign(index, opts) {
    const slot = slots[index];
    if (!slot) return false;
    slot.name = opts.label || '技能';
    slot.act = opts.onActivate || null;
    paint(slot);
    refreshBox();
    return true;
  }

  // 清空某个槽位
  function clearSlot(index) {
    const slot = slots[index];
    if (!slot) return;
    slot.name = '';
    slot.act = null;
    paint(slot);
    refreshBox();
  }

  // 自动找一个空槽装备（用于阿花给物品时自动入槽）。满了返回 null。
  function registerSkill(opts) {
    const idx = slots.findIndex((s) => !s.act);
    if (idx < 0) return null;
    assign(idx, opts);
    return slots[idx].keyName;
  }

  const keyHandler = (e) => {
    if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) return;
    if (e.code === dropModifier) { yHeld = true; return; } // 先按住丢弃修饰键，等数字键
    const slot = slots.find((s) => s.keyName === e.code);
    if (!slot) return;
    e.preventDefault();
    if (yHeld) dropSlot(slot); // 按住 Y + 数字键 = 丢弃该槽物品
    else fire(slot);
  };
  const keyUpHandler = (e) => { if (e.code === dropModifier) yHeld = false; };
  const blurHandler = () => { yHeld = false; }; // 切窗口时可能收不到 keyup，复位避免修饰键「粘住」
  window.addEventListener('keydown', keyHandler);
  window.addEventListener('keyup', keyUpHandler);
  window.addEventListener('blur', blurHandler);

  // 整体显隐（对战 / 灵魂出窍等模式下隐藏技能栏）；与 refreshBox 的空槽逻辑互不覆盖
  function setVisible(v) {
    boxHidden = !v;
    applyBoxDisplay();
  }

  function dispose() {
    window.removeEventListener('keydown', keyHandler);
    window.removeEventListener('keyup', keyUpHandler);
    window.removeEventListener('blur', blurHandler);
    box.remove();
  }

  return { assign, clearSlot, registerSkill, setVisible, setDropHandler, dispose };
}
