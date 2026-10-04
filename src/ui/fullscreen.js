// 职责：全屏切换（Fullscreen API + WebKit 老前缀兜底）。
// 只做「切换 + 状态 + 变更通知」，不碰任何 UI；按钮怎么长、文案怎么变由调用方决定。
//
// 三条必须知道的浏览器规矩：
//   1. requestFullscreen 必须发生在**用户手势**里（点击 / 按键回调内），
//      在切场景、登录完成这类"自己触发"的时机调用会被拒绝（并抛一条控制台警告）。
//   2. 它是异步的且**可能被拒**（iframe 没 allow="fullscreen"、用户按了 Esc、权限策略不允许），
//      所以每个调用都要 catch，不能让 Promise rejection 冒出去。
//   3. iOS 上的 iPhone Safari 根本不支持元素全屏（只有 video 能全屏）→ supported() 返回 false，
//      调用方要把按钮藏掉，别给用户一个点了没反应的按钮。

const FS_ENTER = ['requestFullscreen', 'webkitRequestFullscreen'];
const FS_EXIT = ['exitFullscreen', 'webkitExitFullscreen'];
const FS_EL = ['fullscreenElement', 'webkitFullscreenElement'];
const FS_CHANGE = ['fullscreenchange', 'webkitfullscreenchange'];

// 找第一个存在的属性/方法名（标准名优先，老 WebKit 兜底）
function pick(obj, names) {
  for (const n of names) if (obj && obj[n]) return n;
  return '';
}

const el = () => document.documentElement;

// 这个浏览器能不能全屏（iPhone Safari / 被权限策略挡住时为 false）
export function fullscreenSupported() {
  return !!pick(el(), FS_ENTER);
}

// 当前是不是全屏
export function isFullscreen() {
  const k = pick(document, FS_EL);
  return k ? !!document[k] : false;
}

// 进入 / 退出全屏。返回 Promise<boolean>：true = 现在处于全屏。
// 失败（不支持 / 被拒）时 resolve(false)，**不 reject** —— 调用方不必写 catch。
export function toggleFullscreen() {
  const target = el();
  if (isFullscreen()) {
    const k = pick(document, FS_EXIT);
    if (!k) return Promise.resolve(true);
    return Promise.resolve(document[k]()).then(() => isFullscreen(), () => isFullscreen());
  }
  const k = pick(target, FS_ENTER);
  if (!k) return Promise.resolve(false);
  return Promise.resolve(target[k]()).then(() => isFullscreen(), () => isFullscreen());
}

// 订阅全屏状态变化（用户按 Esc、F11、点按钮都会触发）。返回取消订阅的函数。
export function onFullscreenChange(cb) {
  const names = FS_CHANGE.filter((n) => true);
  const handler = () => cb(isFullscreen());
  for (const n of names) document.addEventListener(n, handler);
  return () => {
    for (const n of names) document.removeEventListener(n, handler);
  };
}
