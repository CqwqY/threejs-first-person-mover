// 统一触屏（粗指针）判定。
//
// 为什么需要这个：移动端 / Capacitor 壳 / 某些 WebView 里，(pointer:coarse) 与
// 'ontouchstart' in window 都可能返回 false（被当成桌面 UA，或引擎特殊配置），
// 结果是「手机分支整段被跳过」——表现就是设置里的「轮盘 / 2行竖列」切了没反应、
// 移动摇杆（轮盘）和左右触控区（两列）不创建、聊天飘按钮不显示。
//
// 修法：多信号 OR，任一为真就按手机处理。navigator.maxTouchPoints 在真机上最稳，
// 但某些 Android WebView / 壳里它会是 0；此时 `(hover: none)`（无悬停=触屏）几乎必定为真，
// 是覆盖面最广的兜底信号。UA / Capacitor / cordova / userAgentData.mobile 作为补充。
// Node 环境（自检脚本）里 window 未定义直接返回 false，不影响渲染。
//
// 手动覆盖（检测仍翻车时兜底）：URL 加 ?touch=1 / ?touch=0，或 localStorage 设 fpm-touch='1'/'0'。
export function isCoarsePointer() {
  if (typeof window === 'undefined') return false;
  try {
    const q = new URLSearchParams(window.location.search).get('touch');
    if (q === '1') return true;
    if (q === '0') return false;
    const ls = (typeof localStorage !== 'undefined') ? localStorage.getItem('fpm-touch') : null;
    if (ls === '1') return true;
    if (ls === '0') return false;
  } catch (e) { /* 隐私模式等拿不到，忽略，走下面的信号判定 */ }
  const mq = (name) => !!(window.matchMedia && window.matchMedia(name).matches);
  const ont = 'ontouchstart' in window;
  const nav = (typeof navigator !== 'undefined') ? navigator : null;
  const mtp = !!(nav && (nav.maxTouchPoints || 0) > 0);
  const uaData = nav && nav.userAgentData;
  const uaMobile = !!(uaData && uaData.mobile);
  const ua = !!(nav && /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|Capacitor/i.test(nav.userAgent || ''));
  const cap = !!(window.Capacitor || (typeof window.cordova !== 'undefined'));
  // (hover: none) 是触屏设备最稳的信号：鼠标设备 hover 永远可用，触屏设备没有 → 为 none
  return mq('(pointer: coarse)') || mq('(any-pointer: coarse)') || mq('(hover: none)') || ont || mtp || uaMobile || ua || cap;
}
