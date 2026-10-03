// 统一触屏（粗指针）判定。
//
// 为什么需要这个：移动端 / Capacitor 壳 / 某些 WebView 里，(pointer:coarse) 与
// 'ontouchstart' in window 都可能返回 false（被当成桌面 UA，或引擎特殊配置），
// 结果是「手机分支整段被跳过」——表现就是设置里的「轮盘 / 2行竖列」切了没反应、
// 移动摇杆（轮盘）和左右触控区（两列）不创建、聊天飘按钮不显示。
//
// 修法：多信号 OR，任一为真就按手机处理。navigator.maxTouchPoints 在真机上最稳，
// UA / Capacitor / cordova 作为兜底补充。Node 环境（自检脚本）里 window 未定义
// 直接返回 false，不影响渲染。
export function isCoarsePointer() {
  if (typeof window === 'undefined') return false;
  const mq = (name) => !!(window.matchMedia && window.matchMedia(name).matches);
  const ont = 'ontouchstart' in window;
  const nav = (typeof navigator !== 'undefined') ? navigator : null;
  const mtp = !!(nav && (nav.maxTouchPoints || 0) > 0);
  const ua = !!(nav && /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|Capacitor/i.test(nav.userAgent || ''));
  const cap = !!(window.Capacitor || (typeof window.cordova !== 'undefined'));
  return mq('(pointer: coarse)') || mq('(any-pointer: coarse)') || ont || mtp || ua || cap;
}
