// 职责：一键隐藏 / 显示**全部游戏 UI**（HUD、按钮、校卡、技能槽、血条、摇杆……），
// 供玩家截图、录屏或沉浸式看画面用。再按一次同键恢复。
//
// 为什么用「body 加类 + CSS」而不是逐个元素设 display：
//   · 本项目的 UI 是**几十个独立 div 各自 append 到 body** 的（见 Game._createXxx 各方法、
//     ui/MobileControls、world/BuildingTool……），逐个收集既冗长又必然漏（加新 UI 就忘）。
//   · 而 canvas 挂在 `#app` 里，所有 UI 都在 `#app` **之外**、body 的直属子节点。
//     所以一条 `body.kui-hide-ui > :not(#app){display:none!important}` 就能干净覆盖全部，
//     且**不需要**在别处维护元素清单 —— 新加的 UI 自动被覆盖。
//   · 用 !important 是为了压过各元素自带的 inline style（很多 UI 用 cssText 直接写 display）。
//
// ⚠ 不藏的目标：
//   · `#app`（canvas 本体）—— 藏了就没画面了。
//   · 加载屏 `.fpm-loading` —— 加载期按 H 藏掉会让玩家以为卡死；故显式豁免。
//   · 本模块自己的「UI 已隐藏」小提示条 —— 否则用户不知道再按什么键恢复。
//
// ⚠ 用 `visibility`/`display` 而非把元素从 DOM 摘除：摘除后各模块的持有引用会失效
//   （它们不少地方直接 element.textContent = …），恢复时会指向游离节点 ⇒ 静默失效。
//   只改 CSS，DOM 结构原样不动，恢复即天然完整。

const HIDE_CLASS = 'kui-hide-ui';
const STYLE_ID = 'fpm-ui-hide-style';

// 注入一次全局样式（幂等）。放在 body 上而不是各处 inline，是「一处生效、无需清单」的关键。
function ensureStyle() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement('style');
  st.id = STYLE_ID;
  st.textContent =
    // 隐藏 body 直属的、非 canvas 容器的一切子元素（= 所有游戏 UI）。
    // `>` 只取直属，避免误伤 #app 内部（虽然 #app 里只有 canvas）。
    '.' + HIDE_CLASS + ' > :not(#app):not(.fpm-loading):not(.fpm-uihide-tip){display:none!important;}' +
    // 恢复提示条：藏在右下角，几秒后自己淡出。它是唯一在隐藏态仍可见的 UI。
    '.fpm-uihide-tip{position:fixed;right:12px;bottom:12px;z-index:99999;' +
    'pointer-events:none;font:600 12px/1.3 ui-monospace,Menlo,Consolas,monospace;' +
    'padding:6px 10px;border-radius:6px;color:#eaf2ff;background:rgba(0,0,0,.6);' +
    'border:1px solid rgba(255,255,255,.22);opacity:1;transition:opacity .5s ease;}' +
    '.fpm-uihide-tip.fpm-uihide-tip--out{opacity:0;}';
  (document.head || document.documentElement).appendChild(st);
}

let _hidden = false;
let _tipEl = null;
let _tipTimer = 0;

// 右下角提示条：告知「按 X 恢复」。仅隐藏态存在；恢复时移除。
function showTip(keyLabel) {
  if (typeof document === 'undefined') return;
  if (!_tipEl) {
    _tipEl = document.createElement('div');
    _tipEl.className = 'fpm-uihide-tip';
    document.body.appendChild(_tipEl);
  }
  _tipEl.textContent = 'UI 已隐藏 · 按 ' + (keyLabel || 'H') + ' 显示';
  _tipEl.classList.remove('fpm-uihide-tip--out');
  if (_tipTimer) clearTimeout(_tipTimer);
  // 3 秒后淡出（元素留着，但透明、不可见；恢复时整体移除）
  _tipTimer = setTimeout(() => { if (_tipEl) _tipEl.classList.add('fpm-uihide-tip--out'); }, 3000);
}

function removeTip() {
  if (_tipTimer) { clearTimeout(_tipTimer); _tipTimer = 0; }
  if (_tipEl && _tipEl.parentElement) _tipEl.remove();
  _tipEl = null;
}

export function isUiHidden() { return _hidden; }

// 设置显隐。value 省略 = 翻转当前态。返回设置后的状态（true = 已隐藏）。
export function setUiHidden(value) {
  if (typeof document === 'undefined') return _hidden;
  const want = (value === undefined) ? !_hidden : !!value;
  if (want === _hidden) return _hidden;
  _hidden = want;
  ensureStyle();
  document.body.classList.toggle(HIDE_CLASS, _hidden);
  if (_hidden) showTip(_hotkeyLabel);
  else removeTip();
  return _hidden;
}

export function toggleUiHidden() { return setUiHidden(undefined); }

// 记住最近一次安装热键用的键标签，供提示条显示。
let _hotkeyLabel = 'H';

// 安装全局热键：按 keyCode（e.code，如 'KeyH'）翻转 UI 显隐。
// 返回卸载函数（便于自检 / 热重载）。
// ⚠ 必须排除「正在输入框里打字」的情况 —— 否则在聊天框里打 h 会误触发。
//   本模块不 import Input.js（避免循环依赖），就地判一次 activeElement。
export function installUiHotkey(keyCode, opts = {}) {
  if (typeof window === 'undefined') return () => {};
  ensureStyle();
  const code = keyCode || 'KeyH';
  _hotkeyLabel = code.startsWith('Key') ? code.slice(3) : code;
  const isEditable = (el) => {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
  };
  const onKey = (e) => {
    if (e.code !== code) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return; // 组合键不拦
    if (isEditable(document.activeElement)) return;  // 打字中不响应
    e.preventDefault();
    setUiHidden();
    if (typeof opts.onToggle === 'function') opts.onToggle(isUiHidden());
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
