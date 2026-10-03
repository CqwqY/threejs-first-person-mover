// 统一触屏（粗指针）判定。
//
// 历史：项目原来在每个文件里各写一份 `(pointer: coarse) || 'ontouchstart' in window`。
// 那份判定本身没错，只是「触摸屏笔记本」会被 `ontouchstart` 误判成手机。本文件把它收拢成
// 唯一出口，并在原判定的基础上多一层保险：主指针是鼠标(pointer:fine) → 判桌面。
//
// ⚠ 别再往里加 `(any-pointer: coarse)` 或裸 `navigator.maxTouchPoints>0` 当判据 ——
//   带触摸屏的笔记本这两者都为真（触摸屏只是「次要」输入），会把桌面误判成手机
//   （用户报「电脑也是手机」就是这么来的）。判定一律以「主指针」类型为准。
//
// ⚠ 覆盖参数 ?touch=1 极易"粘住"地址栏（历史版本会自动 replaceState 写它），一旦残留就把
//   桌面永久锁成手机。所以现在规定：**?touch=1 只在「主指针不是鼠标」时才生效**；
//   鼠标为主（pointer:fine）的电脑即使地址栏带 ?touch=1 也照样判桌面。
//
// 覆盖：?touch=0 永远强制桌面；?touch=1 在主指针非鼠标时强制手机。
// 诊断：?diag 把各信号实际取值打在屏幕上。
export function isCoarsePointer() {
  if (typeof window === 'undefined') return false;

  const mq = (name) => !!(window.matchMedia && window.matchMedia(name).matches);

  // 1. 显式覆盖（按上面的规则，防残留参数锁死桌面）
  try {
    const q = new URLSearchParams(window.location.search).get('touch');
    if (q === '0') return false;                              // 永远强制桌面
    if (q === '1' && !mq('(pointer: fine)')) return true;     // 主指针非鼠标时才强制手机
  } catch (e) { /* 隐私模式等拿不到，忽略 */ }

  // 2. 以「主指针」类型为准（≈项目原来的朴素判定 + 一层鼠标优先保险）
  if (mq('(pointer: coarse)')) return true;  // 主指针是触屏 → 手机
  if (mq('(pointer: fine)')) return false;   // 主指针是鼠标 → 桌面（触摸屏笔记本在此正确归桌面）
  return 'ontouchstart' in window;           // 两者都拿不到时，退回原有兜底
}

// ?diag：把判定各信号的实际取值打在屏幕上（排查「电脑被当手机」用）。
export function showCoarseDiag() {
  try {
    const mq = (n) => (window.matchMedia ? window.matchMedia(n).matches : 'n/a');
    const nav = (typeof navigator !== 'undefined') ? navigator : {};
    let touchParam = null;
    try { touchParam = new URLSearchParams(window.location.search).get('touch'); } catch (e) { /* 忽略 */ }
    const fine = mq('(pointer: fine)');
    const honored = touchParam === '0' ? '强制桌面' : (touchParam === '1' ? (fine ? '忽略(主指针是鼠标)' : '强制手机') : '—');
    const rows = {
      'URL 里的 touch 参数': touchParam,
      'touch 参数是否生效': honored,
      '完整 URL': window.location.href,
      'pointer: coarse': mq('(pointer: coarse)'),
      'pointer: fine': mq('(pointer: fine)'),
      'hover: none': mq('(hover: none)'),
      'hover: hover': mq('(hover: hover)'),
      'any-pointer: coarse': mq('(any-pointer: coarse)'),
      ontouchstart: ('ontouchstart' in window),
      maxTouchPoints: nav.maxTouchPoints,
      'uaData.mobile': !!(nav.userAgentData && nav.userAgentData.mobile),
      'Capacitor/cordova': !!(window.Capacitor || typeof window.cordova !== 'undefined'),
      '=> isCoarsePointer()': isCoarsePointer(),
      UA: nav.userAgent || '',
    };
    const el = document.createElement('div');
    el.style.cssText =
      'position:fixed;left:8px;top:8px;z-index:100000;max-width:92vw;padding:10px 12px;' +
      'background:rgba(0,0,0,.85);color:#3f6;font:12px/1.55 ui-monospace,Menlo,Consolas,monospace;' +
      'border:1px solid #3f6;border-radius:8px;white-space:pre-wrap;word-break:break-all;pointer-events:none;';
    el.textContent = '触屏判定诊断 (?diag)\n' +
      Object.entries(rows).map(([k, v]) => k + ': ' + v).join('\n');
    const mount = () => document.body.appendChild(el);
    if (document.body) mount();
    else window.addEventListener('DOMContentLoaded', mount);
  } catch (e) { /* 忽略 */ }
}

// 模块加载时：清理旧版本残留的 localStorage 覆盖位；?diag 时显示诊断。
try {
  if (typeof localStorage !== 'undefined' && localStorage.getItem('fpm-touch') !== null) {
    localStorage.removeItem('fpm-touch');
  }
  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('diag')) {
    showCoarseDiag();
  }
} catch (e) { /* 隐私模式下拿不到，忽略 */ }
