// 职责：进游戏前的「主页」。结构只有三块：
//   ① 全屏背景：public/video/ 下三支校园短片交叉淡入轮播（静态 loading-bg.jpg 兜底）
//   ② 屏幕中间：登录状态 / 玩家昵称（旧的校门 Logo 与大字标题已弃用）
//   ③ 下方一条加载进度条；加载完成后**这条进度条本身**变成「点击进入游戏」按钮
//
// 状态机：login（检测登录/弹窗）→ loading（真实资产进度）→ ready（进度条变按钮）
//        → entered（点击后淡出，露出后台已在实时渲染的校园世界）。
// 期间遮罩吞掉指针事件，避免点击漏进游戏里（视角乱转 / 误开背包）。
//
// 用法（main.js）：
//   const home = createHomeScreen();
//   home.setStatus('正在检测登录…');          // 弹窗期间主页上显示的文字
//   home.setProfile(auth.profile);            // 登录后中间换成玩家昵称
//   const game = new Game(...); game.start(); home.beginLoading();
//   await waitAssets(home, game);             // 内部反复调 home.setProgress(done,total)
//   await home.markReady();                  // 进度条变按钮，点击后 resolve
//
// ⚠ 与旧 LoadingScreen 的区别：不再有独立居中的「点击进入游戏」大横条，
//   也不再显示校门 Logo / 标题；入口就是底部那条进度条变形后的按钮。
import { ensureTheme } from './theme.js';

const KEYFRAMES_ID = 'fpm-home-kf';

// 三支短片（源文件原名 2.mp4 / 3.mp4 / campus_tour (6).mp4）。
// ⚠ 文件名必须是纯 ASCII 且无空格括号：原素材名带空格和括号，URL 编码后在
//   Pages / 部分 CDN 路径下会 404，故入库时统一重命名为 home-1/2/3.mp4。
// 想换片直接替换 public/video/ 下同名文件，或给 createHomeScreen({ videos }) 传新数组。
export const HOME_VIDEOS = [
  '/video/home-1.mp4',
  '/video/home-2.mp4',
  '/video/home-3.mp4',
];

function ensureKeyframes() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(KEYFRAMES_ID)) return;
  const st = document.createElement('style');
  st.id = KEYFRAMES_ID;
  st.textContent = [
    '@keyframes fpm-home-fadeIn { 0%{opacity:0;transform:translate(-50%,-50%) translateY(12px)} 100%{opacity:1;transform:translate(-50%,-50%) translateY(0)} }',
    '@keyframes fpm-home-shimmer { 0%{background-position:-200% 0} 100%{background-position:200% 0} }',
    '@keyframes fpm-home-breathe { 0%,100%{opacity:.62} 50%{opacity:1} }',
    '@keyframes fpm-home-readyPulse { 0%,100%{box-shadow:0 10px 34px rgba(37,99,235,.42),inset 0 1px 0 rgba(255,255,255,.26)} 50%{box-shadow:0 14px 44px rgba(59,130,246,.66),inset 0 1px 0 rgba(255,255,255,.32)} }',
  ].join('\n');
  document.head.appendChild(st);
}

// ---- 纯函数：抽出来是为了能在 Node 里直接断言，不依赖 DOM ----
export function displayName(profile) {
  if (!profile) return '';
  return String(profile.nickname || profile.username || '').trim();
}

export function displayColor(profile) {
  const c = profile && profile.nicknameColor;
  return (typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c)) ? c : '#ffffff';
}

export function progressLabel(done, total) {
  if (total > 0) {
    const pct = Math.min(100, Math.max(0, Math.round((done / total) * 100)));
    return '正在加载 ' + done + ' / ' + total + '  (' + pct + '%)';
  }
  return '正在加载…（已就绪 ' + done + ' 件）';
}

export function progressWidth(done, total) {
  if (total > 0) return Math.min(100, Math.max(0, Math.round((done / total) * 100)));
  return Math.min(85, 10 + done * 6);
}

// 轮播下一支的下标；空列表返回 -1（调用方据此不播）。
export function nextVideoIndex(i, n) {
  if (n <= 0) return -1;
  return ((i + 1) % n + n) % n;
}

// 低端机 / 调试用的临时开关：?homevideo=0 立即退回静态底图。
function videoDisabledByUrl() {
  if (typeof location === 'undefined' || typeof URLSearchParams === 'undefined') return false;
  try {
    return new URLSearchParams(location.search).get('homevideo') === '0';
  } catch (e) {
    return false;
  }
}

const nextFrame = (fn) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fn);
  else setTimeout(fn, 0);
};

export function createHomeScreen(opts = {}) {
  ensureTheme(); // 幂等：主题变量注入一次，登录弹窗也复用
  ensureKeyframes();
  const bgUrl = opts.background || '/loading-bg.jpg';
  // 允许调用方传空数组彻底关掉视频；不传则用三支默认短片。
  const videos = (Array.isArray(opts.videos) ? opts.videos : HOME_VIDEOS)
    .filter((u) => typeof u === 'string' && u.length > 0);
  const useVideo = videos.length > 0 && !videoDisabledByUrl();
  let finished = false;
  let readyResolve = null;
  const ready = new Promise((res) => { readyResolve = res; });

  // ---- 遮罩根：盖在 canvas 之上，靠 bg 层做不透明背景 ----
  const root = document.createElement('div');
  root.className = 'fpm-home';
  root.dataset.phase = 'login';
  root.style.cssText =
    'position:fixed;inset:0;z-index:10000;overflow:hidden;user-select:none;' +
    '-webkit-tap-highlight-color:transparent;background:transparent;' +
    'font-family:system-ui,"PingFang SC","Microsoft YaHei",sans-serif;' +
    'transition:opacity .55s ease;';

  // ---- 背景层：静态底图永远在，视频只是叠在它上面 ----
  // 视频没加载好、加载失败、解码超时、自动播放被拦时，露出的都是这张底图，不会黑屏。
  const bg = document.createElement('div');
  bg.style.cssText =
    'position:absolute;inset:0;overflow:hidden;' +
    'background:url(' + bgUrl + ') center/cover no-repeat;';

  // ---- 视频轮播：两个 video 交替，一支播放时另一支预载下一支 ----
  // 用 playing 事件（而非 canplay）作为淡入时机：canplay 可能在预载阶段就触发过，
  // 等它会让切换永久卡住；playing 一定发生在 play() 之后，且代表真有画面在出。
  const videoEls = [];
  const slotUrl = ['', ''];
  const slotIndex = [-1, -1];
  let active = 0;        // 当前可见的那支
  let wantSlot = -1;     // 正在等待播放的那支（淡入前）
  let curIndex = -1;     // 当前播的是 videos 里的第几支
  let stopped = false;   // 进入游戏 / 永久降级后置 true
  let failStreak = 0;
  let playTimer = null;

  const warn = (msg, e) => { console.warn('[home] ' + msg, e === undefined ? '' : e); };

  function clearPlayTimer() {
    if (playTimer !== null && typeof clearTimeout === 'function') clearTimeout(playTimer);
    playTimer = null;
  }

  function tryPlay(v) {
    if (!v || typeof v.play !== 'function') return;
    try {
      // 老浏览器 play() 返回 undefined；现代浏览器返回 Promise，
      // 被自动播放策略拦时 reject —— 此时留在静态底图，等用户首次交互再重试。
      const p = v.play();
      if (p && typeof p.catch === 'function') {
        p.catch((e) => { warn('背景视频自动播放被拦，等待用户交互后重试', e); });
      }
    } catch (e) {
      warn('背景视频播放调用失败', e);
    }
  }

  function currentVideo() {
    if (!videoEls.length) return null;
    return videoEls[wantSlot >= 0 ? wantSlot : active] || null;
  }

  // 自动播放被浏览器拦下后，第一次点击/触摸主页时补一次 play()（不吞也不改事件）。
  function resumeVideos() {
    if (stopped || !useVideo) return;
    tryPlay(currentVideo());
  }

  function pauseVideo(v) {
    if (!v || typeof v.pause !== 'function') return;
    try { v.pause(); } catch (e) { warn('暂停背景视频失败', e); }
  }

  // 永久降级：视频全停、淡出，静态底图接管。不静默、出声 warn。
  function disableVideo(reason) {
    warn(reason);
    stopped = true;
    clearPlayTimer();
    for (const v of videoEls) {
      pauseVideo(v);
      v.style.opacity = '0';
    }
  }

  // 进入游戏：立刻停解码并释放 src，别让 720p60 的视频在后台继续吃 CPU/GPU。
  // ⚠ 不因 stopped 提前 return：disableVideo() 会先置 stopped，但那时 src 还没释放，
  //   进游戏仍需走一遍释放（下面每一步都幂等）。
  function stopVideos() {
    if (!videoEls.length) return;
    stopped = true;
    clearPlayTimer();
    for (const v of videoEls) {
      pauseVideo(v);
      v.style.opacity = '0';
      v.removeAttribute('src');
      if (typeof v.load === 'function') {
        try { v.load(); } catch (e) { warn('释放背景视频资源失败', e); }
      }
    }
  }

  function prepare(slot, i) {
    if (i < 0 || i >= videos.length) return;
    const v = videoEls[slot];
    const url = videos[i];
    slotIndex[slot] = i;
    if (slotUrl[slot] === url) return; // 已预载过，别重复 load（会重新下载）
    slotUrl[slot] = url;
    v.src = url;
    if (typeof v.load === 'function') v.load();
  }

  function reveal(slot) {
    if (stopped || slot !== wantSlot) return;
    clearPlayTimer();
    wantSlot = -1;
    const v = videoEls[slot];
    curIndex = slotIndex[slot];
    v.style.opacity = '1';
    const old = videoEls[active];
    if (old && old !== v) {
      old.style.opacity = '0';
      pauseVideo(old);
    }
    active = slot;
    failStreak = 0;
    // 空出来的那支立刻预载下一支，下次切换零等待；浏览器 HTTP 缓存会复用已下载的片段。
    prepare(1 - active, nextVideoIndex(curIndex, videos.length));
  }

  // 8 秒还没真正播起来就跳过这一支，别让主页永远停在静态底图还以为视频在跑。
  function armTimeout(slot, i) {
    if (typeof window === 'undefined') return; // Node 自检不挂定时器
    clearPlayTimer();
    playTimer = setTimeout(() => {
      playTimer = null;
      if (stopped || wantSlot !== slot) return;
      warn('背景视频缓冲超时，跳过：' + videos[i]);
      failStreak++;
      if (failStreak >= videos.length * 2) {
        disableVideo('背景视频连续失败，已永久退回静态底图');
        return;
      }
      playAt(nextVideoIndex(i, videos.length));
    }, 8000);
  }

  function playAt(i) {
    if (stopped || !videos.length || i < 0 || i >= videos.length) return;
    const next = 1 - active;
    wantSlot = next;
    prepare(next, i);
    tryPlay(videoEls[next]);
    armTimeout(next, i);
  }

  function makeVideo(slot) {
    const v = document.createElement('video');
    // 静音 + playsinline 是移动端自动播放的硬条件；没有音轨也强制静音，别和 BGM 抢。
    v.muted = true;
    v.playsInline = true;
    v.loop = false;
    v.preload = 'auto';
    v.setAttribute('muted', '');
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;' +
      'pointer-events:none;opacity:0;transition:opacity .8s ease;';
    v.addEventListener('playing', () => { reveal(slot); });
    v.addEventListener('canplay', () => { reveal(slot); }); // 备用：个别浏览器不发 playing
    v.addEventListener('ended', () => {
      if (stopped || slot !== active) return;
      playAt(nextVideoIndex(curIndex, videos.length));
    });
    v.addEventListener('error', () => {
      if (stopped) return;
      failStreak++;
      warn('背景视频加载失败：' + (slotUrl[slot] || '?'));
      v.style.opacity = '0';
      if (failStreak >= videos.length * 2) {
        disableVideo('背景视频连续失败，已永久退回静态底图');
        return;
      }
      if (slot === active || slot === wantSlot) {
        playAt(nextVideoIndex(slotIndex[slot], videos.length));
      }
    });
    return v;
  }

  if (useVideo) {
    videoEls[0] = makeVideo(0);
    videoEls[1] = makeVideo(1);
    bg.appendChild(videoEls[0]);
    bg.appendChild(videoEls[1]);
  }

  // ---- 压暗层：中间区域稍暗保证大字可读，底部更暗保证进度条可读 ----
  const shade = document.createElement('div');
  shade.style.cssText =
    'position:absolute;inset:0;pointer-events:none;' +
    'background:linear-gradient(180deg,rgba(6,10,22,.30) 0%,rgba(6,10,22,.18) 38%,rgba(6,10,22,.34) 62%,rgba(6,10,22,.72) 100%);';

  // ---- 中间：登录状态 / 玩家昵称 ----
  const center = document.createElement('div');
  center.style.cssText =
    'position:absolute;left:50%;top:46%;transform:translate(-50%,-50%);z-index:2;' +
    'width:min(90vw,720px);display:flex;flex-direction:column;align-items:center;gap:10px;' +
    'text-align:center;transition:opacity .45s ease;';

  const nameEl = document.createElement('div');
  nameEl.style.cssText =
    'font-size:min(40px,9vw);font-weight:800;letter-spacing:.06em;color:#fff;' +
    'text-shadow:0 2px 0 rgba(9,30,60,.5),0 8px 26px rgba(0,0,0,.55);' +
    'word-break:break-all;line-height:1.25;';
  nameEl.textContent = '正在检测登录…';

  const subEl = document.createElement('div');
  subEl.style.cssText =
    'font-size:13px;color:#d6e2f5;min-height:18px;opacity:.88;' +
    'text-shadow:0 2px 8px rgba(0,0,0,.5);';
  subEl.textContent = '';

  const switchEl = document.createElement('div');
  switchEl.textContent = '切换账号';
  switchEl.style.cssText =
    'display:none;margin-top:2px;font-size:12px;color:#c9dcff;cursor:pointer;' +
    'text-decoration:underline;text-underline-offset:3px;opacity:.85;pointer-events:auto;';
  switchEl.addEventListener('click', (e) => {
    e.stopPropagation();
    if (typeof opts.onSwitchAccount === 'function') opts.onSwitchAccount();
  });

  center.appendChild(nameEl);
  center.appendChild(subEl);
  center.appendChild(switchEl);

  // ---- 下方：一条进度条（加载完成后它自己变成「点击进入游戏」按钮）----
  const bottom = document.createElement('div');
  bottom.style.cssText =
    'position:absolute;left:50%;bottom:max(7%,calc(env(safe-area-inset-bottom) + 22px));' +
    'transform:translateX(-50%);z-index:3;' +
    'width:min(460px,82vw);display:flex;flex-direction:column;align-items:center;gap:10px;';

  const bar = document.createElement('div');
  bar.dataset.mode = 'loading';
  bar.setAttribute('role', 'progressbar');
  bar.style.cssText =
    'position:relative;width:100%;height:14px;border-radius:999px;overflow:hidden;' +
    'background:rgba(255,255,255,.14);box-shadow:inset 0 1px 3px rgba(0,0,0,.42);' +
    'transition:height .45s ease,background .45s ease,box-shadow .45s ease,transform .2s ease;' +
    'cursor:default;';

  const fill = document.createElement('div');
  fill.style.cssText =
    'position:absolute;left:0;top:0;bottom:0;width:0%;border-radius:999px;' +
    'background:linear-gradient(90deg,#7fd0ff,#ffcf66);transition:width .35s ease,opacity .35s ease;' +
    'box-shadow:0 0 14px rgba(127,208,255,.62);';
  const sweep = document.createElement('div');
  sweep.style.cssText =
    'position:absolute;inset:0;pointer-events:none;opacity:.5;' +
    'background:linear-gradient(90deg,transparent,rgba(255,255,255,0) 18%,rgba(255,255,255,.55) 50%,rgba(255,255,255,0) 82%,transparent);' +
    'background-size:200% 100%;animation:fpm-home-shimmer 2.2s linear infinite;';
  const label = document.createElement('div');
  label.style.cssText =
    'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
    'color:#fff;font-size:12px;font-weight:600;letter-spacing:.04em;opacity:0;' +
    'text-shadow:0 1px 3px rgba(0,0,0,.6);pointer-events:none;';
  label.textContent = '等待登录';

  bar.appendChild(fill);
  bar.appendChild(sweep);
  bar.appendChild(label);
  bottom.appendChild(bar);
  // 进度条下方一行状态（加载件数/百分比），就绪时隐藏
  const hint = document.createElement('div');
  hint.style.cssText =
    'font-size:12px;color:#cdd6f0;opacity:.8;text-align:center;min-height:16px;' +
    'text-shadow:0 1px 6px rgba(0,0,0,.6);transition:opacity .3s ease;';
  hint.textContent = '请登录以继续';
  bottom.appendChild(hint);

  root.appendChild(bg);
  root.appendChild(shade);
  root.appendChild(center);
  root.appendChild(bottom);

  // 加载/登录期间吞掉指针事件，别让点击漏进后面的游戏世界。
  // ⚠ ready 阶段必须放行：否则进度条变形后的「点击进入」按钮会被自己吞掉。
  root.addEventListener('pointerdown', (e) => {
    resumeVideos(); // 自动播放被拦时，借这次交互补一次 play()（不改变事件行为）
    if (root.dataset.phase === 'ready' || root.dataset.phase === 'entered') return;
    // 放行「切换账号」：capture 阶段 preventDefault 会连带抑制它后续的 click，
    // 否则这个链接在登录/加载阶段看着能点、实际毫无反应（静默失效）。
    if (e.target === switchEl) return;
    e.preventDefault();
    e.stopPropagation();
  }, true);
  root.addEventListener('click', () => {
    if (root.dataset.phase === 'ready' && !finished) beginEnter();
  });
  bar.addEventListener('click', (e) => {
    e.stopPropagation();
    if (root.dataset.phase === 'ready' && !finished) beginEnter();
  });

  document.body.appendChild(root);
  // 必须等元素进了 DOM 再 play()：iOS Safari 对游离节点上的自动播放更严格。
  if (useVideo) playAt(0);

  function beginEnter() {
    if (finished) return;
    finished = true;
    stopVideos();
    root.dataset.phase = 'entered';
    root.style.opacity = '0';
    setTimeout(() => { if (root.parentElement) root.remove(); }, 600);
    if (readyResolve) readyResolve();
  }

  function setStatus(text, sub) {
    nameEl.textContent = text;
    nameEl.style.color = '#ffffff';
    switchEl.style.display = 'none';
    subEl.textContent = sub || '';
  }

  function setProfile(profile, extra = {}) {
    const n = displayName(profile);
    if (!n) { setStatus('已登录', extra.sub || ''); return; }
    nameEl.textContent = n;
    nameEl.style.color = displayColor(profile);
    subEl.textContent = extra.sub || '欢迎回来';
    switchEl.style.display = 'block';
  }

  function beginLoading() {
    if (root.dataset.phase !== 'login') return;
    root.dataset.phase = 'loading';
    hint.textContent = '正在准备校园场景…';
  }

  // 加载完成：进度条**本体**变成可点的「点击进入游戏」按钮（不再另起一条大横条）。
  function revealReady() {
    if (root.dataset.phase === 'ready' || finished) return;
    root.dataset.phase = 'ready';
    fill.style.width = '100%';
    fill.style.opacity = '0';
    sweep.style.opacity = '0';
    hint.style.opacity = '0';
    bar.dataset.mode = 'ready';
    bar.setAttribute('role', 'button');
    bar.style.height = 'min(58px,11vh)';
    bar.style.background = 'linear-gradient(90deg,rgba(59,130,246,.92),rgba(37,99,235,.92))';
    bar.style.boxShadow = '0 10px 34px rgba(37,99,235,.42),inset 0 1px 0 rgba(255,255,255,.26)';
    bar.style.cursor = 'pointer';
    bar.style.animation = 'fpm-home-readyPulse 2.4s ease-in-out infinite';
    label.textContent = '点击进入游戏';
    label.style.opacity = '1';
    label.style.fontSize = 'min(22px,5vw)';
    label.style.fontWeight = '800';
    label.style.letterSpacing = '.18em';
    // 就绪后让中央内容稍微退场，视觉焦点落到底部入口按钮
    center.style.opacity = '.82';
    nextFrame(() => { root.dataset.readyPainted = '1'; });
  }

  return {
    root,
    setStatus,
    setProfile,
    beginLoading,
    // 资产就绪 → 返回 Promise（玩家点击进度条/任意处后 resolve）
    markReady() { revealReady(); return ready; },
    // 兼容旧调用：直接结束（兜底）
    finish() { beginEnter(); },
    // done/total：total 为 0 表示总量未知，此时进度条慢慢爬避免像卡死
    setProgress(done, total) {
      if (finished || root.dataset.phase === 'ready' || root.dataset.phase === 'entered') return;
      beginLoading();
      fill.style.width = progressWidth(done, total) + '%';
      hint.textContent = progressLabel(done, total);
    },
    // 让主页能显示「正在检测登录」「请登录」这类阶段性文案
    setHint(text) { hint.textContent = text; },
    get phase() { return root.dataset.phase; },
    get done() { return finished; },
  };
}
