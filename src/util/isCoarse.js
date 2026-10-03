// 统一触屏（粗指针）判定。
//
// 为什么需要这个：移动端 / Capacitor 壳 / 某些 WebView 里，(pointer:coarse) 与
// 'ontouchstart' in window 都可能返回 false（被当成桌面 UA，或引擎特殊配置），
// 结果是「手机分支整段被跳过」——表现就是设置里的「轮盘 / 2行竖列」切了没反应、
// 移动摇杆（轮盘）和左右触控区（两列）不创建、聊天飘按钮不显示。
//
// ⚠ 核心原则：**以「主指针」类型为准**。鼠标/触控板为主 = 桌面；触屏为主 = 手机。
//   绝不能用 (any-pointer: coarse) 或裸 navigator.maxTouchPoints ——
//   带触摸屏的**笔记本/一体机**这两者都为真（触摸屏是「次要」输入），
//   会把桌面误判成手机 → 用户报「电脑也是手机」。这正是之前踩过的坑。
//   同理 (hover: none) 也只在「主指针」不可判定时用作兜底，不单独当判据。
//
// 判定顺序：
//   1. ?touch=1 / ?touch=0 显式覆盖（URL 参数，不写盘、不串设备）
//   2. (pointer: coarse) → 手机； (pointer: fine) → 桌面（带触摸屏的笔记本走这条）
//   3. 主指针不可判定时再看 (hover: none)/(hover: hover)
//   4. 以上都不可判定（极个别 WebView）才回退到触点数 / UA / 壳
//
// 持久化手机模式请用 ?touch=1（钉地址栏即可），**绝不要写 localStorage**——
// 写盘会粘在所有同域浏览器（含电脑）上，让判定永久失效。
export function isCoarsePointer() {
  if (typeof window === 'undefined') return false;

  // 1. 显式覆盖优先
  try {
    const q = new URLSearchParams(window.location.search).get('touch');
    if (q === '1') return true;
    if (q === '0') return false;
  } catch (e) { /* 隐私模式等拿不到，忽略 */ }

  const mq = (name) => !!(window.matchMedia && window.matchMedia(name).matches);

  // 2. 主指针类型（最可靠）
  if (mq('(pointer: coarse)')) return true; // 主指针是触屏 → 手机
  if (mq('(pointer: fine)')) return false;  // 主指针是鼠标 → 桌面（触摸屏笔记本在此被正确归为桌面）

  // 3. 主指针不可判定 → 看 hover 能力
  if (mq('(hover: none)')) return true;   // 不能悬停 = 触屏
  if (mq('(hover: hover)')) return false; // 能悬停 = 有鼠标 → 桌面

  // 4. 兜底（极个别 WebView 连 pointer/hover 都不给）：触点数 / UA / 壳
  const nav = (typeof navigator !== 'undefined') ? navigator : null;
  const mtp = !!(nav && (nav.maxTouchPoints || 0) > 0);
  const ont = 'ontouchstart' in window;
  const uaData = nav && nav.userAgentData;
  const uaMobile = !!(uaData && uaData.mobile);
  const ua = !!(nav && /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|Capacitor/i.test(nav.userAgent || ''));
  const cap = !!(window.Capacitor || (typeof window.cordova !== 'undefined'));
  return mtp || ont || uaMobile || ua || cap;
}

// 一次性迁移：旧版本把 fpm-touch 写进 localStorage 当触屏覆盖位，会粘在电脑上让判定永久失效
// （表现就是「电脑也是手机」）。已不再读取它，这里顺手清掉，让残留位立即失效、刷新即恢复桌面。
try {
  if (typeof localStorage !== 'undefined' && localStorage.getItem('fpm-touch') !== null) {
    localStorage.removeItem('fpm-touch');
  }
} catch (e) { /* 隐私模式下拿不到，忽略 */ }
