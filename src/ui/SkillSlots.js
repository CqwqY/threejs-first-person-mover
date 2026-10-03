// 职责：技能槽 UI。阿花放进背包的物品在这里变成可触发技能：
//   手机：屏幕上只留「当前技能」一个按钮（默认排在跳跃键上方，可用「按键布局」拖动）。
//         · 轻点           = 用当前技能
//         · 向外拖动       = 展开轮盘选技能（扇区高亮，松手即切换并释放）
//         · 长按后上滑     = 丢弃当前技能（保留原来的丢弃手势）
//         按钮上那行小字「2/5」表示当前是第几个 / 共几个技能。
//   PC  ：横向一排，靠屏右下角，数字键 1..N 直接触发。
// 固定 SLOT_COUNT 个槽位，每个槽绑定一个触发键（PC 数字键 1..N）。
// 物品可被「指定」到某个具体槽位（背包里选槽位后点使用即可）。
import { ensureTheme } from './theme.js';
import { onRelayout, viewportSize, readLayout, currentMode } from './layout.js';
import { isCoarsePointer } from '../util/isCoarse.js';

export const SKILL_KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8'];
export const SLOT_COUNT = SKILL_KEYS.length;
const COOLDOWN = 800; // 相邻两次触发的最小间隔（毫秒）

const CUR_KEY = 'fpm_skill_cur';   // 手机端记住上次选中的槽位
const SWIPE_OUT = 24;              // 拖出多远才展开轮盘（px）
const FAN_HI = 160;                // 轮盘扇区角度范围（度）：160° = 左上方
const FAN_LO = 20;                 //                      20° = 右上方
const DEAD_RATIO = 0.42;           // 半径内侧死区：落在里面 = 取消选择

export function createSkillSlots(opts = {}) {
  ensureTheme();
  // 丢弃手势相关：PC 按住修饰键 + 数字键；手机长按技能按钮后上滑
  const dropModifier = opts.dropModifier || 'KeyY';
  const gestureMs = Number.isFinite(opts.gestureMs) ? opts.gestureMs : 320;
  const gestureDy = Number.isFinite(opts.gestureDy) ? opts.gestureDy : 42;
  // 触屏判定：统一走 isCoarsePointer()（多信号 OR，覆盖 WebView / Capacitor / 真机），
  // 否则手机专属的轮盘/两列排布整段被跳过（设置里切了没反应）。
  const coarse = isCoarsePointer();

  // 手机端两种排布：
  //   wheel = 只留「当前技能」一颗按钮，向外拖出扇形轮盘选技能（省地方，但要两步操作）
  //   grid  = 装备的技能直接铺成 2 行竖列网格，看一眼就在，点一下就用
  // PC 恒为 desk（横排 + 数字键）。
  let mobileMode = coarse ? (opts.mobileLayout === 'grid' ? 'grid' : 'wheel') : 'desk';

  // ---------------------------------------------------------------------------
  // 容器
  //   手机 wheel：box 本身就是那颗「当前技能」按钮（有尺寸 → 「按键布局」里能正常抓取/存位置）
  //   手机 grid ：box 是 2 行竖列的网格容器，槽位直接住在里面
  //   PC  ：box 是横排容器，8 个槽位是它的孩子
  // ---------------------------------------------------------------------------
  const box = document.createElement('div');
  box.className = 'sk-box ' + (coarse ? 'sk-box--mobile kui-iconbtn' : 'sk-box--desk');
  box.style.position = 'fixed';
  box.style.zIndex = '60';
  box.style.display = 'flex';
  if (coarse) {
    box.style.flexDirection = 'column';
    box.style.alignItems = 'center';
    box.style.justifyContent = 'center';
    box.style.gap = '1px';
    box.style.width = 'clamp(50px, 14vmin, 66px)';
    box.style.height = 'clamp(50px, 14vmin, 66px)';
    box.style.pointerEvents = 'auto'; // 只有这一颗按钮吃触摸，其余地方仍可转视角
    box.style.touchAction = 'none';
    box.style.userSelect = 'none';
    box.style.setProperty('-webkit-user-select', 'none');
    box.style.cursor = 'pointer';
    box.style.textAlign = 'center';
    box.style.fontFamily = 'var(--kui-font)';
    // 默认锚点：跳跃键上方（JS 会按跳跃键的实际位置重算并覆盖，这里只兜底第一帧）
    box.style.right = 'calc(env(safe-area-inset-right, 0px) + 56px)';
    box.style.bottom = 'calc(env(safe-area-inset-bottom, 0px) + 150px)';
  } else {
    // PC：横向一排，靠屏右下角
    box.style.right = '18px';
    box.style.bottom = '22px';
    box.style.pointerEvents = 'none';
    box.style.flexDirection = 'row';
    box.style.alignItems = 'center';
    box.style.gap = '8px';
  }
  document.body.appendChild(box);

  // 按钮上的两行字（手机专用）
  let btnLabel = null;
  let btnCount = null;
  if (coarse) {
    btnLabel = document.createElement('div');
    btnLabel.className = 'sk-label';
    btnLabel.style.cssText =
      'font-weight:600;font-size:clamp(9px,2.6vmin,11px);max-width:92%;' +
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    btnCount = document.createElement('div');
    btnCount.className = 'sk-key kui-num';
    btnCount.style.cssText = 'font-size:clamp(8px,2.2vmin,10px);color:var(--kui-ink-soft);';
    box.appendChild(btnLabel);
    box.appendChild(btnCount);
  }

  // 轮盘容器（手机专用）：挂在 body 上，圆心对齐按钮中心。
  // 挂在 body 而不是按钮里，是为了不被按钮的边框/尺寸裁切，也不参与按钮的点击。
  const wheel = coarse ? document.createElement('div') : null;
  if (wheel) {
    wheel.className = 'sk-wheel';
    wheel.style.cssText = 'position:fixed;z-index:61;display:none;pointer-events:none;';
    document.body.appendChild(wheel);
  }

  // 手机端：技能槽排布切换（轮盘 / 2行）——参考「人称切换器(.mc-view)」的两段式屏幕按钮做法，
  // 直接摆出来、用 pointerdown 触发，不走设置面板的 <select>（某些手机浏览器上 select 的 change 不可靠，
  // 用户反馈"设置里切了完全没反应"多半就是它）。放在左下角人称切换器正上方。
  const modeSwitch = coarse ? document.createElement('div') : null;
  let syncModeSwitch = () => {};
  if (modeSwitch) {
    modeSwitch.className = 'sk-mode';
    modeSwitch.style.cssText =
      'position:fixed;z-index:62;display:flex;align-items:center;gap:2px;padding:3px;' +
      'left:calc(env(safe-area-inset-left, 0px) + 20px);' +
      'bottom:calc(env(safe-area-inset-bottom, 0px) + 26px + clamp(92px,26vmin,124px) + 14px + 44px);' +
      'border-radius:999px;box-sizing:border-box;box-shadow:var(--kui-shadow);' +
      'background:color-mix(in srgb, var(--kui-ink) 46%, transparent);' +
      'border:2px solid color-mix(in srgb, var(--kui-blue-soft) 55%, transparent);' +
      'touch-action:none;user-select:none;-webkit-user-select:none;';
    const mkSeg = (txt) => {
      const b = document.createElement('b');
      b.textContent = txt;
      b.style.cssText =
        'flex:0 0 auto;padding:6px 10px;border-radius:999px;cursor:pointer;' +
        'font:600 clamp(11px,2.9vmin,13px)/1 var(--kui-font);color:var(--kui-paper);';
      return b;
    };
    const segWheel = mkSeg('轮盘');
    const segGrid = mkSeg('2行');
    modeSwitch.appendChild(segWheel);
    modeSwitch.appendChild(segGrid);
    document.body.appendChild(modeSwitch);
    // 高亮以真实 mobileMode 为准重画（设置面板改了也同步）
    syncModeSwitch = () => {
      const grid = mobileMode === 'grid';
      segWheel.style.opacity = grid ? '.6' : '1';
      segGrid.style.opacity = grid ? '1' : '.6';
      segWheel.style.background = grid ? 'transparent' : 'color-mix(in srgb, var(--kui-blue) 85%, transparent)';
      segGrid.style.background = grid ? 'color-mix(in srgb, var(--kui-blue) 85%, transparent)' : 'transparent';
    };
    const bindSeg = (el, mode) => {
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation(); // 别漏给下面的摇杆区
        ensureCur();
        setMobileLayout(mode);
      });
    };
    bindSeg(segWheel, 'wheel');
    bindSeg(segGrid, 'grid');
    syncModeSwitch();
  }

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
    if (!slot || !slot.act) return;
    const now = performance.now();
    if (now < slot.cdUntil) return;
    slot.cdUntil = now + COOLDOWN;
    // 手机端槽位藏在轮盘里时，反馈要打在看得见的按钮上；网格模式下槽位自己就看得见
    const visual = (coarse && mobileMode !== 'grid') ? box : slot.el;
    visual.style.transition = 'opacity .12s ease';
    visual.style.opacity = '0.55';
    setTimeout(() => { visual.style.opacity = '1'; }, COOLDOWN);
    slot.act();
  }

  // ---- 手机端：当前技能 / 轮盘状态 ----
  let cur = 0;        // 当前槽位索引
  let fanSign = 1;    // 轮盘展开方向：1 = 朝上，-1 = 朝下（按钮贴近屏幕顶部时翻转）
  let wheelR = 88;    // 轮盘半径
  let wheelScale = 1; // 轮盘项缩放（技能多时缩小，免得叠在一起）

  function readCur() {
    const n = parseInt(localStorage.getItem(CUR_KEY) || '', 10);
    return Number.isFinite(n) && n >= 0 && n < SLOT_COUNT ? n : 0;
  }
  function saveCur() {
    try { localStorage.setItem(CUR_KEY, String(cur)); } catch (e) { /* 存不了就只本次会话有效 */ }
  }
  function equipped() { return slots.filter((s) => s.act); }
  function ensureCur() {
    if (!slots[cur] || !slots[cur].act) {
      const i = slots.findIndex((s) => s.act);
      cur = i < 0 ? 0 : i;
    }
  }
  cur = coarse ? readCur() : 0;

  // 刷新按钮上的「技能名 + 第几个/共几个」（只有 wheel 模式有那颗按钮）
  function paintBtn() {
    if (!coarse || mobileMode !== 'wheel') return;
    const list = equipped();
    ensureCur();
    const s = slots[cur];
    btnLabel.textContent = (s && s.act) ? (s.name || '技能') : '技能';
    const pos = list.indexOf(s);
    const multi = list.length > 1 && pos >= 0;
    btnCount.textContent = multi ? (pos + 1) + '/' + list.length : '';
    btnCount.style.display = multi ? 'block' : 'none';
  }

  // 空槽显示「空」，有技能显示技能名；手机上空槽藏在轮盘里，容器内没有可用技能时整个按钮隐藏
  function paint(slot) {
    slot.labelEl.textContent = slot.act ? (slot.name || '技能') : '空';
    slot.labelEl.style.color = slot.act ? 'var(--kui-ink)' : 'var(--kui-ink-soft)';
    slot.el.style.display = (coarse && !slot.act) ? 'none' : '';
    if (coarse) { paintBtn(); layoutWheel(); }
  }

  // boxHidden：由外部（Game）控制整体隐藏——某些模式（对战 / 灵魂出窍）不显示技能栏
  let boxHidden = false;
  function applyBoxDisplay() {
    if (boxHidden) {
      box.style.display = 'none';
      if (wheel) wheel.style.display = 'none';
      return;
    }
    const any = slots.some((s) => s.act);
    // grid 模式下 box 是网格容器，不能再写死回 flex
    box.style.display = (!coarse || any) ? (mobileMode === 'grid' ? 'grid' : 'flex') : 'none';
  }
  function refreshBox() { applyBoxDisplay(); if (coarse) { readSavedPos(); layoutMobile(); } }

  // ---- 手机端定位 ----
  // 位置来源：① 「按键布局」里存过的比例位置（＝按钮中心）；② 没存过 → 跟着跳跃键：
  // 按钮排在跳跃键正上方，间距按跳跃键的实际直径算，所以大小屏都不会叠在一起。
  let savedPos = null;
  function readSavedPos() {
    try {
      const conf = readLayout(currentMode()) || {};
      const p = conf.skill;
      savedPos = (p && Number.isFinite(p.cx) && Number.isFinite(p.cy)) ? p : null;
    } catch (e) { savedPos = null; }
  }

  function jumpRect() {
    const j = document.querySelector('.mc-jump');
    if (!j) return null;
    const r = j.getBoundingClientRect();
    return r.width ? r : null;
  }

  // 按钮要「贴着下面那颗键」往上排。右下角从下往上是：跳跃键 → 攻击键（圆形，只在对战/Boss 等状态下显示）。
  // 所以有攻击键时挂它上方，否则直接挂跳跃键上方——两者都不可见时返回 null（走兜底位）。
  function anchorRect() {
    for (const sel of ['.mc-atk', '.mc-jump']) {
      const el = document.querySelector(sel);
      if (!el || getComputedStyle(el).display === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.width) return r;
    }
    return null;
  }

  function layoutMobile() {
    if (!coarse) return;
    const { width: vw, height: vh } = viewportSize();
    const W = box.offsetWidth || 56;
    const H = box.offsetHeight || 56;
    const jr = anchorRect();
    // 按钮中心与跳跃键中心的间距 = 跳跃键半径 + 按钮半径 + 一点缝
    const gap = Math.round(Math.min(14, Math.max(8, H * 0.16)));
    const R = Math.min(110, Math.max(64, (jr ? jr.height / 2 : 39) + H / 2 + gap));

    let cx = null;
    let cy = null;
    if (savedPos) { cx = savedPos.cx * vw; cy = savedPos.cy * vh; }
    // 旧数据可能存的是「圆弧圆心」（＝跳跃键中心），那会让按钮压在跳跃键上 → 视为失效，走默认位。
    // ⚠ 这个校验只能拿「跳跃键」当参照，**绝不能用上面的 anchorRect()**（它会优先取攻击键）：
    //   攻击键是按状态出现/消失的，参照点一变，就会把「用户合法保存的位置」误判成失效、强行弹回默认位——
    //   表现就是「调好技能槽位置后，一用加特林/控制枪让攻击键出来，技能槽位置就被挪走」。
    if (cx !== null) {
      const ju = jumpRect();
      if (ju) {
        const d = Math.hypot(cx - (ju.left + ju.width / 2), cy - (ju.top + ju.height / 2));
        if (d < ju.height / 2 + H / 2) { cx = null; cy = null; } // 压住跳跃键 → 旧数据，走默认位
      }
    }
    if (cx === null) {
      if (jr) { cx = jr.left + jr.width / 2; cy = jr.top + jr.height / 2 - R; }
      else { cx = vw - 56; cy = vh - 60 - R; }
    }
    // 夹进屏幕，避免按钮（及其外面的轮盘）被挤出可视区
    cx = Math.max(4 + W / 2, Math.min(vw - 4 - W / 2, cx));
    cy = Math.max(4 + H / 2, Math.min(vh - 4 - H / 2, cy));
    box.style.left = (cx - W / 2) + 'px';
    box.style.top = (cy - H / 2) + 'px';
    box.style.right = 'auto';
    box.style.bottom = 'auto';
    if (mobileMode === 'wheel') {
      wheel.style.left = cx + 'px';
      wheel.style.top = cy + 'px';
      layoutWheel();
    }
  }

  // ---- 两种手机排布的外壳差异 ----
  // wheel：box 是那颗圆按钮（定尺寸、column 居中、显示当前技能名），槽位挂在 wheel 里绕圈排。
  // grid ：box 是 2 行竖列网格（grid-auto-flow:column 表示「先竖着填」），尺寸由内容撑开；
  //        整块不吃触摸（pointer-events:none），只有槽位本身吃，免得挡住转视角。
  function applyBoxStyle() {
    if (!coarse) return;
    if (mobileMode === 'grid') {
      box.classList.add('sk-box--grid');
      box.style.display = 'grid';
      box.style.flexDirection = '';
      box.style.alignItems = '';
      box.style.justifyContent = '';
      box.style.gap = '6px';
      box.style.gridTemplateRows = 'repeat(2, auto)';
      box.style.gridAutoFlow = 'column';
      box.style.padding = '5px';
      box.style.width = 'auto';
      box.style.height = 'auto';
      box.style.pointerEvents = 'none'; // 空隙留给转视角
      // 网格是「一块技能栏」而不是一颗按钮：给层半透明底衬，跟后面的 3D 画面拉开
      box.style.background = 'rgba(0, 0, 0, .26)';
      box.style.borderRadius = '10px';
      if (btnLabel) btnLabel.style.display = 'none';
      if (btnCount) btnCount.style.display = 'none';
      return;
    }
    box.classList.remove('sk-box--grid');
    box.style.display = 'flex';
    box.style.flexDirection = 'column';
    box.style.alignItems = 'center';
    box.style.justifyContent = 'center';
    box.style.gap = '1px';
    box.style.gridTemplateRows = '';
    box.style.gridAutoFlow = '';
    box.style.padding = '';
    box.style.width = 'clamp(50px, 14vmin, 66px)';
    box.style.height = 'clamp(50px, 14vmin, 66px)';
    box.style.pointerEvents = 'auto';
    box.style.background = ''; // 交回给 .kui-iconbtn 的按钮样式
    box.style.borderRadius = '';
    if (btnLabel) btnLabel.style.display = '';
    if (btnCount) btnCount.style.display = '';
  }

  // 槽位住哪儿、怎么定位——两种模式完全不同，切换时整套重设
  function mountSlots() {
    if (!coarse) return;
    const host = mobileMode === 'grid' ? box : wheel;
    for (const s of slots) {
      if (mobileMode === 'grid') {
        s.el.style.position = 'static';
        s.el.style.left = '';
        s.el.style.top = '';
        s.el.style.transform = '';
        s.el.style.pointerEvents = 'auto';
      } else {
        s.el.style.position = 'absolute'; // 相对轮盘容器（其左上角＝按钮中心）定位
        s.el.style.left = '0px';
        s.el.style.top = '0px';
        s.el.style.transform = 'translate(-50%,-50%)';
        s.el.style.pointerEvents = 'none'; // 选择由按钮的手势统一处理，轮盘项本身不吃触摸
      }
      if (s.el.parentElement !== host) host.appendChild(s.el);
    }
  }

  // 切换手机排布（由设置面板调用）。grid 模式下轮盘整个退出舞台。
  // 用运行时 isCoarsePointer() 重新判定（而不是加载时捕获的 coarse），
  // 避免某些 WebView 在构造期误判为桌面、把切换永久锁死。
  function setMobileLayout(mode) {
    const m = mode === 'grid' ? 'grid' : 'wheel';
    if (m === mobileMode) { syncModeSwitch(); return; }
    // 只认「有没有按手机建」的 coarse：只要手机 UI 存在就允许切（不再用运行时 isCoarsePointer() 拦，
    // 避免某些设备在这条判定上和构造期不一致时把切换永久锁死）。
    if (!coarse) return;
    mobileMode = m;
    if (wheel) wheel.style.display = 'none';
    applyBoxStyle();
    mountSlots();
    applyBoxDisplay();
    refreshBox();
    if (m === 'wheel') layoutWheel();
    syncModeSwitch();
  }

  // 槽位自身的手势：轻点 = 触发；长按（≥gestureMs）后上滑 = 丢弃。
  // PC 与手机「网格」模式都是直接点槽位，共用这一套；
  // 手机「轮盘」模式下槽位藏在轮盘里不吃触摸，由按钮手势统一处理 —— 故这里直接放行不干活。
  function bindSlotGesture(slot) {
    let pressT = 0;      // 本次按下的时间戳
    let pressY = 0;      // 本次按下的纵坐标
    let armed = false;   // 是否已进入「长按」状态
    let consumed = false;// 本次手势是否已作为丢弃消费掉
    let timer = 0;
    const clearTimer = () => { if (timer) { clearTimeout(timer); timer = 0; } };
    slot.el.addEventListener('pointerdown', (e) => {
      if (mobileMode === 'wheel') return;
      e.preventDefault();
      e.stopPropagation();
      try { slot.el.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      pressT = performance.now();
      pressY = e.clientY;
      armed = false;
      consumed = false;
      clearTimer();
      timer = setTimeout(() => {
        timer = 0;
        armed = true;
        slot.el.style.transform = 'scale(0.92)'; // 长按反馈：轻微收缩，提示「可上滑丢弃」
      }, gestureMs);
    });
    slot.el.addEventListener('pointermove', (e) => {
      if (mobileMode === 'wheel' || !armed || consumed) return;
      if (pressY - e.clientY >= gestureDy) { // 上滑超过阈值 → 丢弃
        consumed = true;
        armed = false;
        clearTimer();
        slot.el.style.transform = '';
        dropSlot(slot);
      }
    });
    const endPress = (canceled) => {
      if (mobileMode === 'wheel') return;
      clearTimer();
      slot.el.style.transform = '';
      const wasArmed = armed;
      armed = false;
      if (canceled || consumed || wasArmed) return; // 取消 / 已丢弃 / 长按过但没上滑 → 都不触发技能
      if (performance.now() - pressT < gestureMs) fire(slot); // 轻点 → 触发技能
    };
    slot.el.addEventListener('pointerup', () => endPress(false));
    slot.el.addEventListener('pointercancel', () => endPress(true));
  }

  function boxCenter() {
    const r = box.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, W: r.width, H: r.height };
  }

  // 把「有技能」的槽位摆到按钮周围的扇形上。
  // 角度用屏幕坐标：sx = cos(a)*R，sy = -sin(a)*R（取负才是「屏幕上方」）。
  // 槽位多、弧上挤不下时按比例缩小（轮盘保持小巧，不靠放大半径去腾地方）。
  function layoutWheel() {
    if (!coarse || mobileMode !== 'wheel') return; // grid 模式没有轮盘
    const { width: vw, height: vh } = viewportSize();
    const c = boxCenter();
    const vmin = Math.min(vw, vh);
    wheelR = Math.round(Math.min(112, Math.max(74, vmin * 0.19)));
    // 按钮太靠上 → 上方排不下，整个扇形翻到下方（选择逻辑用 fanSign 镜像，不受影响）
    fanSign = (c.cy - 8 < wheelR + c.H * 0.9) ? -1 : 1;
    const list = equipped();
    const n = list.length;
    // 相邻槽位的弦长 vs 槽位尺寸 → 该缩多小。上限 1（不放大），下限 0.58（再小就看不清了）
    const slotPx = Math.min(56, Math.max(42, vmin * 0.12)); // 与 CSS clamp(42px,12vmin,56px) 对齐
    const span = (FAN_HI - FAN_LO) * Math.PI / 180;
    const chord = n > 1 ? 2 * wheelR * Math.sin(span / (2 * (n - 1))) : Infinity;
    wheelScale = n > 1 ? Math.max(0.58, Math.min(1, chord / (slotPx * 1.06))) : 1;
    for (let i = 0; i < n; i++) {
      const deg = n === 1 ? 90 : (FAN_HI - (FAN_HI - FAN_LO) * (i / (n - 1)));
      const a = deg * Math.PI / 180;
      const s = list[i];
      s.el.style.left = (Math.cos(a) * wheelR) + 'px';
      s.el.style.top = (-fanSign * Math.sin(a) * wheelR) + 'px';
      s.el.style.transform = 'translate(-50%,-50%) scale(' + wheelScale.toFixed(3) + ')';
    }
  }

  onRelayout(() => { if (coarse) { readSavedPos(); layoutMobile(); } });

  // ---------------------------------------------------------------------------
  // 预建全部槽位
  // ---------------------------------------------------------------------------
  if (coarse) readSavedPos();
  for (let i = 0; i < SLOT_COUNT; i++) {
    const keyName = SKILL_KEYS[i];
    const el = document.createElement('div');
    el.className = 'sk-slot kui-iconbtn';
    el.style.touchAction = 'none';
    el.style.userSelect = 'none';
    el.style.setProperty('-webkit-user-select', 'none');
    el.style.flexDirection = 'column';
    el.style.alignItems = 'center';
    el.style.justifyContent = 'center';
    el.style.gap = '2px';
    el.style.textAlign = 'center';
    el.style.fontFamily = 'var(--kui-font)';
    if (coarse) {
      // 尺寸用 vmin（短边）而不是 vw——vw 在旋转后宽度翻倍会让控件突然变大。
      // 定位方式（轮盘里绕圈 / 网格里排队）由 mountSlots 按当前模式统一写，这里不碰。
      el.style.width = 'clamp(42px, 12vmin, 56px)';
      el.style.height = 'clamp(42px, 12vmin, 56px)';
      el.style.fontSize = 'clamp(10px, 2.8vmin, 12px)';
    } else {
      el.style.pointerEvents = 'auto';
      el.style.cursor = 'pointer';
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

    // 槽位自身手势：PC 与手机「网格」模式共用同一套；轮盘模式下函数内部直接放行不干活
    bindSlotGesture(slot);
    if (!coarse) box.appendChild(el); // 手机端挂哪儿由 mountSlots 按模式决定
    slots.push(slot);
    paint(slot);
  }
  if (coarse) { applyBoxStyle(); mountSlots(); } // 槽位都建完再排布，否则 mountSlots 遍历不到
  refreshBox();

  // ---------------------------------------------------------------------------
  // 手机端手势：轻点 = 用当前技能 / 拖出 = 轮盘选 / 长按上滑 = 丢弃
  // ---------------------------------------------------------------------------
  if (coarse) {
    let pid = null;
    let mode = '';   // pending | wheel | drop | consumed | none
    let pressT = 0;
    let sx = 0;
    let sy = 0;
    let timer = 0;
    let hitIdx = -1;
    const clearTimer = () => { if (timer) { clearTimeout(timer); timer = 0; } };

    const setPressed = (v) => { box.style.transform = v ? 'scale(0.92)' : ''; };

    // 手指方向 → 扇区角度（度）。fanSign 把「朝下展开」的轮盘镜像回来，
    // 所以调用方只需像上半圆那样判断 ang ≥ 5 即可。
    const fingerAngle = (dx, dy) => Math.atan2(-dy * fanSign, dx) * 180 / Math.PI;

    const highlight = (idx) => {
      const list = equipped();
      for (let i = 0; i < list.length; i++) {
        const on = i === idx;
        const el = list[i].el;
        const base = 'translate(-50%,-50%) scale(' + wheelScale.toFixed(3) + ')';
        el.style.transform = on ? base + ' scale(1.14)' : base;
        el.style.boxShadow = on ? '0 0 0 2px var(--kui-blue-soft)' : '';
        el.style.filter = on ? 'brightness(1.2)' : '';
      }
    };

    const openWheel = () => {
      layoutWheel();
      highlight(-1);
      wheel.style.display = 'block';
      box.style.filter = 'brightness(1.15)';
      setPressed(true);
    };

    const closeWheel = () => {
      wheel.style.display = 'none';
      highlight(-1);
      box.style.filter = '';
      setPressed(false);
    };

    box.addEventListener('pointerdown', (e) => {
      if (mobileMode !== 'wheel') return; // 网格模式下每个槽位自己吃触摸，按钮不再接管手势
      e.preventDefault();
      e.stopPropagation();
      try { box.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      pid = e.pointerId;
      mode = 'pending';
      hitIdx = -1;
      pressT = performance.now();
      sx = e.clientX;
      sy = e.clientY;
      clearTimer();
      timer = setTimeout(() => {
        timer = 0;
        if (mode !== 'pending') return;
        mode = 'drop';   // 长按 → 进入丢弃态（再上滑才真丢）
        setPressed(true);
      }, gestureMs);
    });

    box.addEventListener('pointermove', (e) => {
      if (e.pointerId !== pid) return;
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      const d = Math.hypot(dx, dy);
      if (mode === 'pending') {
        if (d < SWIPE_OUT) return;
        clearTimer();
        if (fingerAngle(dx, dy) < 5) { mode = 'none'; return; } // 朝轮盘没有的方向拖 → 不展开
        mode = 'wheel';
        openWheel();
      }
      if (mode === 'wheel') {
        const n = equipped().length;
        const ang = fingerAngle(dx, dy);
        hitIdx = (n === 0 || d < wheelR * DEAD_RATIO || ang < 5) ? -1 : sectorIndex(ang, n);
        highlight(hitIdx);
      } else if (mode === 'drop') {
        if (sy - e.clientY >= gestureDy) { // 上滑超过阈值 → 丢弃当前技能
          mode = 'consumed';
          clearTimer();
          closeWheel();
          dropSlot(slots[cur]);
        }
      }
    });

    const finish = (canceled) => {
      if (pid === null) return;
      pid = null;
      clearTimer();
      const m = mode;
      mode = '';
      if (!canceled) {
        if (m === 'pending') {
          if (performance.now() - pressT < gestureMs) fire(slots[cur]); // 轻点
        } else if (m === 'wheel') {
          const list = equipped();
          const s = hitIdx >= 0 ? list[hitIdx] : null; // 死区外松手才切换
          if (s) {
            const idx = slots.indexOf(s);
            if (idx >= 0) { cur = idx; saveCur(); }
            paintBtn();
            fire(s);
          }
        }
      }
      hitIdx = -1;
      closeWheel();
    };

    box.addEventListener('pointerup', () => finish(false));
    box.addEventListener('pointercancel', () => finish(true));
  }

  // 扇区角度 → 第几个（0 = 最左）。两端会夹住，所以略微偏出也在可选范围内。
  function sectorIndex(ang, n) {
    if (n <= 1) return 0;
    const t = (FAN_HI - ang) / (FAN_HI - FAN_LO);
    const tc = Math.max(0, Math.min(1, t));
    return Math.round(tc * (n - 1));
  }

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

  // 供外部触发重排：攻击键（圆形，排在跳跃键上方）显示/移位后，本按钮要跟着往上让位
  function relayout() {
    if (!coarse) return;
    readSavedPos();
    layoutMobile();
  }

  function dispose() {
    window.removeEventListener('keydown', keyHandler);
    window.removeEventListener('keyup', keyUpHandler);
    window.removeEventListener('blur', blurHandler);
    if (wheel) wheel.remove();
    if (modeSwitch) modeSwitch.remove();
    box.remove();
  }

  return { assign, clearSlot, registerSkill, setVisible, setDropHandler, setMobileLayout, relayout, dispose };
}
