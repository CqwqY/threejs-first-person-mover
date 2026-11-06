// 职责：进游戏前的「主页」。结构只有三块：
//   ① 全屏底图（真实游戏截图，public/loading-bg.jpg）
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

const nextFrame = (fn) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fn);
  else setTimeout(fn, 0);
};

export function createHomeScreen(opts = {}) {
  ensureTheme(); // 幂等：主题变量注入一次，登录弹窗也复用
  ensureKeyframes();
  const bgUrl = opts.background || '/loading-bg.jpg';
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

  // ---- 底图：整张铺满，不再叠 Logo / 标题 ----
  const bg = document.createElement('div');
  bg.style.cssText =
    'position:absolute;inset:0;' +
    'background:url(' + bgUrl + ') center/cover no-repeat;';

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

  function beginEnter() {
    if (finished) return;
    finished = true;
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
