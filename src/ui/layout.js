// 职责：手机端 UI 的布局基座——视口监听 + 比例存储 + 重排调度。
// 与具体业务解耦：只认「一批 CSS 选择器」，谁都能复用（Game / 编辑器 / 手机控件）。
//
// 设计要点（对应实机问题）：
// - 位置以「中心点占视口宽高的比例」存储，而不是绝对 px；旋转/地址栏收起后再按新视口重算，
//   所以右下角的键仍然在右下角，也不会掉出屏幕。
// - 横竖屏各存一套（portrait / landscape），互不干扰。
// - 统一重排入口 relayout()：resize / orientationchange / visualViewport 变化都会走到这里，
//   并在 ~260ms 后二次校正（iOS 旋转动画期间 innerWidth/Height 会读到旧值）。
// - 旧版 fp_mobile_layout_v2（{left,top} px）自动换算成比例迁移到 v3，随后删除旧键。

const STORE_KEY = 'fp_mobile_layout_v3';
const LEGACY_KEY = 'fp_mobile_layout_v2';
const MARGIN = 4; // 贴边最小留白（px）

// 可摆放的控件：key 存储键、sel 选择器、label 提示、showAs 编辑期间临时显示用的 display
export const LAYOUT_ITEMS = [
  { key: 'jump', sel: '.mc-jump', label: '跳跃键', showAs: 'flex' },
  // 驾驶键组（左转/刹车/右转）：只在开电动车时显示，平时隐藏 → 编辑期靠 showAs 临时露出来才拖得到
  { key: 'drive', sel: '.mc-drive', label: '驾驶键', showAs: 'flex' },
  // 攻击键平时是隐藏的（只有对战/打 Boss/开了加特林·控制枪才出现），编辑期间用 showAs 临时显示出来才能拖。
  // 它默认贴着跳跃键正上方自动排；一旦用户拖过，就以保存的位置为准（见 Game._placeAttackBtn）。
  { key: 'attack', sel: '.mc-atk', label: '攻击键', showAs: 'block' },
  { key: 'view', sel: '.mc-view', label: '人称切换', showAs: 'flex' },
  { key: 'skill', sel: '.sk-box', label: '技能槽', showAs: 'flex' },
  { key: 'health', sel: '.hp-box', label: '血条', showAs: 'block' },
  { key: 'chat', sel: '.chat-tab', label: '对话选项卡', showAs: 'block' },
];

const subs = []; // 重排后的订阅回调
let paused = false; // 编辑拖动期间暂停自动重排
let migrated = false; // 是否已尝试过旧数据迁移

// ---- 视口 ----

// 优先用 visualViewport（不含浏览器工具栏），回退 innerWidth/Height
export function viewportSize() {
  const vv = window.visualViewport;
  if (vv && vv.width && vv.height) return { width: vv.width, height: vv.height };
  return { width: window.innerWidth, height: window.innerHeight };
}

export function currentMode() {
  // 优先用 matchMedia 的方向判定：iOS 旋转动画期间 innerWidth/Height 还是旧值，
  // 而 (orientation: portrait) 会在动画一开始就切换，能避免"先按旧方向排一次"的抖动。
  if (window.matchMedia) {
    if (window.matchMedia('(orientation: portrait)').matches) return 'portrait';
    if (window.matchMedia('(orientation: landscape)').matches) return 'landscape';
  }
  const { width, height } = viewportSize();
  return width > height ? 'landscape' : 'portrait';
}

// 把当前可视视口尺寸写进 CSS 变量。
// iOS 的 100vh 等于「大视口」（含地址栏）且旋转后不更新，用它排版必然错位；
// 统一走 --app-vh / --app-vw，由这里按 visualViewport 实时刷新。
function syncCssVars() {
  const root = document.documentElement;
  if (!root) return;
  const { width, height } = viewportSize();
  root.style.setProperty('--app-vw', width + 'px');
  root.style.setProperty('--app-vh', height + 'px');
}

// ---- 存储 ----

function readStore() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (e) { s = null; }
  if (!s || typeof s !== 'object') s = { v: 3 };
  if (!migrated) { migrated = true; migrateLegacy(s); }
  return s;
}

function persist(s) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch (e) { /* 存储不可用：仅本次会话有效 */ }
}

// 旧版 px 布局 → 比例：按当前视口把 left/top 换算成中心点比例，两个方向都写一份（旋转后仍在同一角落）
function migrateLegacy(s) {
  let legacy = null;
  try { legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || 'null'); } catch (e) { legacy = null; }
  if (!legacy || typeof legacy !== 'object') return;
  const { width: vw, height: vh } = viewportSize();
  if (!vw || !vh) return;
  const portrait = {};
  const landscape = {};
  for (const it of LAYOUT_ITEMS) {
    const old = legacy[it.key];
    if (!old || !Number.isFinite(old.left) || !Number.isFinite(old.top)) continue;
    const el = document.querySelector(it.sel);
    const w = el ? el.offsetWidth : 0;
    const h = el ? el.offsetHeight : 0;
    const cx = +(((old.left + w / 2) / vw).toFixed(4));
    const cy = +(((old.top + h / 2) / vh).toFixed(4));
    portrait[it.key] = { cx, cy };
    landscape[it.key] = { cx, cy };
  }
  if (Object.keys(portrait).length) {
    s.v = 3;
    s.portrait = { ...(s.portrait || {}), ...portrait };
    s.landscape = { ...(s.landscape || {}), ...landscape };
    persist(s);
  }
  try { localStorage.removeItem(LEGACY_KEY); } catch (e) { /* 忽略 */ }
}

export function readLayout(mode) {
  const s = readStore();
  return s[mode] || {};
}

// 供拖动前调用：先把元素原始定位存档，之后「重置」才能回到默认位置
export function snapshotEl(el) {
  snapshot(el);
}

// 以元素当前矩形算出中心点比例并写入
export function writeLayout(mode, key, el) {
  const { width: vw, height: vh } = viewportSize();
  const r = el.getBoundingClientRect();
  if (!vw || !vh || r.width === 0) return;
  const s = readStore();
  s.v = 3;
  if (!s[mode]) s[mode] = {};
  s[mode][key] = {
    cx: +((r.left + r.width / 2) / vw).toFixed(4),
    cy: +((r.top + r.height / 2) / vh).toFixed(4),
  };
  persist(s);
}

// ---- 应用 ----

// 记录元素「原始的上线定位」，供恢复默认时还原。
// 注意：血条 / 对话选项卡的默认定位就写在 inline 样式里，直接清空会把它们弄丢。
function snapshot(el) {
  if (el.__layoutOrig) return;
  el.__layoutOrig = {
    left: el.style.left,
    top: el.style.top,
    right: el.style.right,
    bottom: el.style.bottom,
    transform: el.style.transform,
  };
}

// 按比例摆位并夹进屏幕（含安全区）
function placeWithRatio(el, pos) {
  snapshot(el);
  const { width: vw, height: vh } = viewportSize();
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  let left = pos.cx * vw - w / 2;
  let top = pos.cy * vh - h / 2;
  left = Math.max(MARGIN, Math.min(vw - w - MARGIN, left));
  top = Math.max(MARGIN, Math.min(vh - h - MARGIN, top));
  el.style.left = left + 'px';
  el.style.top = top + 'px';
  el.style.right = 'auto';
  el.style.bottom = 'auto';
  el.style.transform = 'none';
}

// 恢复元素自身的原始锚点（inline 里写的 right/bottom 等自适应定位）
function restoreDefault(el) {
  const o = el.__layoutOrig;
  if (!o) return;
  el.style.left = o.left;
  el.style.top = o.top;
  el.style.right = o.right;
  el.style.bottom = o.bottom;
  el.style.transform = o.transform;
}

// 按当前方向把有记录位置的控件摆好，其余保持 CSS 默认锚点
export function applyLayout(mode) {
  const conf = readLayout(mode);
  for (const it of LAYOUT_ITEMS) {
    const el = document.querySelector(it.sel);
    if (!el) continue;
    const pos = conf[it.key];
    if (pos && Number.isFinite(pos.cx) && Number.isFinite(pos.cy)) placeWithRatio(el, pos);
    else restoreDefault(el);
  }
}

export function onRelayout(cb) {
  if (typeof cb === 'function') subs.push(cb);
}

export function setLayoutPaused(v) {
  paused = !!v;
}

// 统一重排：算视口 → 应用布局 → 通知订阅者（订阅者负责清输入残留、刷新编辑把手）。
// 带滞回：地址栏收缩会连发多次 resize，尺寸只差几像素时不再重排，避免来回跳。
// force=true 强制重排（如用户手动点重置）。
let lastApplied = { w: 0, h: 0, mode: '' };
const SIZE_EPSILON = 8; // 小于该像素差视为"浏览器工具栏小幅变化"，忽略

export function relayout(force) {
  const { width, height } = viewportSize();
  const mode = currentMode();
  const changed = !!force
    || Math.abs(width - lastApplied.w) > SIZE_EPSILON
    || Math.abs(height - lastApplied.h) > SIZE_EPSILON
    || mode !== lastApplied.mode;
  if (!changed) return;
  lastApplied = { w: width, h: height, mode };
  syncCssVars();
  if (!paused) applyLayout(mode);
  for (const cb of subs) {
    try { cb(mode); } catch (e) { /* 单个订阅者出错不影响其它 */ }
  }
}

// 不改变视口、但布局数据变了时的强制重排。
// 拖拽保存的落点只写进了 localStorage，视口尺寸没变 → relayout() 的尺寸门槛不会放行 →
// applyLayout 不跑、订阅回调（技能槽按保存位置重新贴位）也不跑，表现为「位置改了要刷新才生效」。
// 凡是「刚改了记录、但屏幕尺寸没动」的场景（退出编辑模式、重置布局）都必须走这里。
export function forceRelayout() {
  lastApplied = { w: 0, h: 0, mode: '' }; // 让下一次 relayout 也必然放行，保持两边一致
  relayout(true);
}

// 重置布局：清掉本地记录，回到默认锚点
export function resetLayout() {
  try { localStorage.removeItem(STORE_KEY); } catch (e) { /* 忽略 */ }
  migrated = true;
  applyLayout(currentMode());
  forceRelayout();
}

// 拦截浏览器手势：iOS 10+ 会忽略 meta 里的 user-scalable=no，
// 所以必须自己拦 gesture*（双指捏合）与 dblclick（双击缩放）。
function installGestureGuards() {
  const prevent = (e) => { if (e.cancelable) e.preventDefault(); };
  for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(ev, prevent, { passive: false });
  }
  document.addEventListener('dblclick', prevent, { passive: false });
  document.addEventListener('touchstart', (e) => { if (e.touches.length > 1) prevent(e); }, { passive: false });
  document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) prevent(e); }, { passive: false });
}

// 启动监听：resize / orientationchange / visualViewport / screen.orientation；rAF 节流 + 延迟二次校正
let installed = false;
export function installViewportWatcher(onChange) {
  if (typeof onChange === 'function') subs.push(onChange);
  if (installed) return;
  installed = true;
  installGestureGuards();
  syncCssVars();
  let raf = 0;
  const kick = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; relayout(); });
  };
  // 旋转动画期间尺寸会读到旧值，稍后再校正一次（迟到的第二次才是终值）
  const kickLate = () => setTimeout(kick, 260);
  window.addEventListener('resize', kick);
  window.addEventListener('orientationchange', () => { kick(); kickLate(); });
  if (window.screen && window.screen.orientation && window.screen.orientation.addEventListener) {
    window.screen.orientation.addEventListener('change', () => { kick(); kickLate(); });
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', kick);
    window.visualViewport.addEventListener('scroll', kick);
  }
  kick();
}
