// 职责：背景音乐（低音量循环播放）。
// - 浏览器会拦截「未交互就自动播放」，所以先尝试播放，被拒则挂一次性手势监听，用户第一次
//   点击/按键/触摸时再开始。
// - 音量由设置面板控制（0 = 静音），设置可能在音频元素创建之前就被应用，所以音量先记在模块里。
// - 切到后台自动暂停，回到前台再续播，避免后台占资源。

const SRC = '/audio/bgm.ogg';
const DEFAULT_VOLUME = 0.25; // 默认就很小声

let audio = null;
let volume = DEFAULT_VOLUME;
let started = false;

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_VOLUME;
  return Math.min(1, Math.max(0, n));
}

// 设置面板可能在 initBgm 之前就调用这里，所以音量始终先存下来
export function setBgmVolume(v) {
  volume = clamp01(v);
  if (audio) audio.volume = volume;
}

export function getBgmVolume() {
  return volume;
}

function tryPlay() {
  if (!audio || started) return;
  const p = audio.play();
  if (p && typeof p.then === 'function') {
    p.then(() => { started = true; })
      .catch(() => { /* 仍被拦截：等下一次手势 */ });
  } else {
    started = true;
  }
}

// 等待用户第一次手势后再播放（自动播放被拦截时的兜底）
function armFirstGesture() {
  const kick = () => {
    tryPlay();
    if (started) {
      for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
        window.removeEventListener(ev, kick);
      }
    }
  };
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
    window.addEventListener(ev, kick, { passive: true });
  }
}

export function initBgm() {
  if (audio) return;
  audio = new Audio(SRC);
  audio.loop = true;
  audio.preload = 'auto';
  audio.volume = volume;
  audio.addEventListener('error', () => { /* 音频加载失败：静默降级，不影响游戏 */ });

  document.addEventListener('visibilitychange', () => {
    if (!audio) return;
    if (document.hidden) audio.pause();
    else if (started) tryPlay();
  });

  tryPlay();
  armFirstGesture();
}
