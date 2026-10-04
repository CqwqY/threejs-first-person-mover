// 职责：进游戏前的加载动画。等场景里的模型（GLB / 天空贴图 / 远端场景）都到位才放人进来，
// 同时给一个「不等了」按钮——网络差的时候不该被卡在门口。
//
// 用法：
//   const ls = createLoadingScreen({ title: '花草中学' });
//   ls.setProgress(done, total);   // 传 total=0 表示「还不知道有多少件」
//   await Promise.race([waitAssets(), ls.skipped]);
//   ls.finish();                   // 淡出并移除（可重复调用，幂等）
//
// 遮罩是全屏且吃触摸的：加载期间点击/拖动不会漏进游戏里（视角乱转、误开背包）。
//
// 外观统一走素材库（public/ui 的 Kenney UI 套装）：面板用 panel_rectangle、进度条用 bar_round_large_m、
// 「不等了」按钮用 button_rectangle，都由 theme.js 的 .kui-* 类提供，这里不再自己画一套 CSS，
// 否则加载屏会跟游戏内其它界面风格对不上。
import { ensureTheme } from './theme.js';

const KEYFRAMES_ID = 'fpm-loading-kf';

function ensureKeyframes() {
  if (document.getElementById(KEYFRAMES_ID)) return;
  const st = document.createElement('style');
  st.id = KEYFRAMES_ID;
  st.textContent =
    '@keyframes fpm-ld-spin { to { transform: rotate(360deg); } }' +
    '@keyframes fpm-ld-pulse { 0%,100% { opacity:.35; transform:scale(.85); } 50% { opacity:1; transform:scale(1.15); } }' +
    '@keyframes fpm-ld-fade { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:none; } }';
  document.head.appendChild(st);
}

export function createLoadingScreen(opts = {}) {
  ensureTheme(); // 素材库的 .kui-* 样式要先注入，否则面板/按钮都是裸的
  ensureKeyframes(); // 转圈/呼吸用到的关键帧（纯 CSS 动画，素材库里没有 spinner 这类素材）
  const title = opts.title || '';
  let skippedResolve = null;
  const skipped = new Promise((res) => { skippedResolve = res; });
  let finished = false;

  // ---- 遮罩 ----
  const root = document.createElement('div');
  root.className = 'fpm-loading';
  root.style.cssText =
    'position:fixed;inset:0;z-index:10000;display:flex;flex-direction:column;' +
    'align-items:center;justify-content:center;gap:14px;user-select:none;' +
    'background:radial-gradient(120% 90% at 50% 30%, #2c3350 0%, #171b2b 55%, #0e1120 100%);' +
    'transition:opacity .45s ease;';

  // ---- 内容面板：Kenney 蓝色九宫格（素材库 panel_rectangle）----
  // 面板内的文字是浅色（深色背景上），而 .kui-panel 默认文字色是近黑的墨色，这里整体覆盖成亮色。
  const panel = document.createElement('div');
  panel.className = 'kui-panel';
  panel.style.cssText =
    'display:flex;flex-direction:column;align-items:center;gap:12px;color:#eef1f8;' +
    'min-width:min(320px,80vw);padding:0;animation:fpm-ld-fade .4s ease both;';
  const body = document.createElement('div');
  body.className = 'kui-panel__body';
  body.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:12px;padding:14px 22px;';
  panel.appendChild(body);

  // ---- 转圈（三瓣：外环旋转 + 内点呼吸）----
  const ring = document.createElement('div');
  ring.style.cssText =
    'position:relative;width:64px;height:64px;';
  const arc = document.createElement('div');
  arc.style.cssText =
    'position:absolute;inset:0;border-radius:50%;' +
    'border:3px solid rgba(255,255,255,.14);border-top-color:var(--kui-gold-hi-2);border-right-color:#7fd0ff;' +
    'animation:fpm-ld-spin 1s linear infinite;';
  const dot = document.createElement('div');
  dot.style.cssText =
    'position:absolute;left:50%;top:50%;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;' +
    'background:var(--kui-gold-hi-2);animation:fpm-ld-pulse 1.4s ease-in-out infinite;';
  ring.appendChild(arc);
  ring.appendChild(dot);

  // ---- 文字 ----
  // 标题：Kenney 面板原本是深色字，这里在深蓝背景上改亮色 + 描边，保证可读
  const h = document.createElement('div');
  h.className = 'kui-title';
  h.style.cssText = 'font-size:20px;color:#fff;text-shadow:0 2px 0 rgba(9,30,60,.55);';
  h.textContent = title;

  const status = document.createElement('div');
  status.className = 'kui-num';
  status.style.cssText =
    'font-size:12px;color:#d7deef;min-height:16px;text-align:center;';
  status.textContent = '正在准备场景…';

  // ---- 进度条：素材库的 bar_round_large_m 平铺填充 ----
  const bar = document.createElement('div');
  bar.className = 'kui-bar';
  bar.style.cssText = 'width:min(260px,62vw);';
  const fill = document.createElement('div');
  fill.className = 'kui-bar__fill';
  fill.style.width = '0%';
  bar.appendChild(fill);

  // ---- 「不等了」按钮：素材库的 Kenney 按钮（grey 版，不抢主按钮的注意力）----
  const skip = document.createElement('button');
  skip.type = 'button';
  skip.className = 'kui-btn kui-btn--grey';
  skip.textContent = '不等了，直接进';
  skip.style.cssText = 'font-size:13px;min-height:32px;';
  let skippedFlag = false;
  const doSkip = () => {
    if (finished) return;
    skippedFlag = true;
    status.textContent = '直接进（没到的模型会随后补上）';
    skippedResolve();
  };
  skip.addEventListener('click', doSkip);

  body.appendChild(ring);
  body.appendChild(h);
  body.appendChild(status);
  body.appendChild(bar);
  body.appendChild(skip);
  root.appendChild(panel);
  // 加载期间吞掉所有指针事件：不只是挡住画面，也别让点击漏进游戏里（视角乱转、误开背包）。
  // 但必须给「不等了」按钮放行 —— 在捕获阶段 preventDefault 会连浏览器合成的 click 一起掐掉，
  // 按钮就永远点不动了。拦截放在 append 之后，这样能用 skip.contains 精确放行。
  root.addEventListener('pointerdown', (e) => {
    if (skip.contains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
  }, true);
  document.body.appendChild(root);

  return {
    skipped,
    // 是否已结束（点过「不等了」或已 finish）。用 getter 取实时值，外部轮询据此提前退出等待。
    get done() { return finished || skippedFlag; },
    // done/total：total 为 0 表示总量未知，此时显示「已就绪 n 件」并让进度条慢慢爬
    setProgress(done, total) {
      if (finished) return;
      if (total > 0) {
        const pct = Math.min(100, Math.round((done / total) * 100));
        fill.style.width = pct + '%';
        status.textContent = '正在加载模型 ' + done + ' / ' + total;
      } else {
        // 总量未知：给一个「爬但不满」的视觉，避免进度条像卡死
        fill.style.width = Math.min(85, 12 + done * 6) + '%';
        status.textContent = '正在加载模型…（已就绪 ' + done + ' 件）';
      }
    },
    finish() {
      if (finished) return;
      finished = true;
      skippedResolve(); // 与外部 race 的那一侧同步结束，避免它继续悬着
      status.textContent = '进入中…';
      fill.style.width = '100%';
      root.style.opacity = '0';
      setTimeout(() => { if (root.parentElement) root.remove(); }, 500);
    },
  };
}
