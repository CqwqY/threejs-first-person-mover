// 职责：进游戏前的加载过场。等场景里的模型都到位，再把遮罩**渐隐**露出后台已在实时
// 渲染的校园世界（高画质背景），并显示「点击进入游戏」——由玩家点击才真正进入，
// 不再有「跳过」按钮（弱网靠 40s 兜底放行）。
//
// 设计要点（对照旧版「干巴巴」面板）：
//   - 背景使用真实游戏截图（校门夜景），加载完成后遮罩渐隐露出实时游戏画面。
//   - 底部一长条「流光 + 加载条」：流光带持续扫动（底部动画），进度条压在底部。
//   - 校门 Logo 居中偏下，标题带描边；整体走蓝/金主题色。
//   - 加载期间吞掉所有指针事件（防止点击漏进游戏）；就绪态显示中央占满宽度的横条，
//     玩家点击横条（或屏幕任意处）进入。
//
// 用法：
//   const ls = createLoadingScreen({ title: '花草中学' });
//   ls.setProgress(done, total);     // total=0 表示总量未知
//   await waitAssets(ls, game);
//   await ls.markReady();            // 露游戏 + 显示「点击进入」，点击后 resolve
//
// 遮罩是全屏且吃触摸的：加载期间点击/拖动不会漏进游戏里（视角乱转、误开背包）。
import { ensureTheme } from './theme.js';

const KEYFRAMES_ID = 'fpm-loading-kf2';

function ensureKeyframes() {
  if (document.getElementById(KEYFRAMES_ID)) return;
  const st = document.createElement('style');
  st.id = KEYFRAMES_ID;
  st.textContent = [
    '@keyframes fpm-ls-logoIn { 0%{opacity:0;transform:translateY(14px) scale(.92)} 100%{opacity:1;transform:none} }',
    '@keyframes fpm-ls-float { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-9px)} }',
    '@keyframes fpm-ls-shimmer { 0%{background-position:-200% 0} 100%{background-position:200% 0} }',
    '@keyframes fpm-ls-pulse { 0%,100%{opacity:.6;transform:translateX(-50%) scale(1)} 50%{opacity:1;transform:translateX(-50%) scale(1.06)} }',
  ].join('\n');
  document.head.appendChild(st);
}

export function createLoadingScreen(opts = {}) {
  ensureTheme(); // 素材库主题变量要先注入（其它界面会用到），这里顺便复用其调色
  ensureKeyframes();
  const title = opts.title || '花草中学';
  let finished = false;
  let readyResolve = null;
  const ready = new Promise((res) => { readyResolve = res; });

  // ---- 遮罩根：本身永远透明，盖在游戏 canvas 之上，靠 bgLayer 做不透明背景 ----
  const root = document.createElement('div');
  root.className = 'fpm-loading';
  root.dataset.phase = 'loading';
  root.style.cssText =
    'position:fixed;inset:0;z-index:10000;overflow:hidden;user-select:none;' +
    '-webkit-tap-highlight-color:transparent;' +
    'font-family:system-ui,"PingFang SC","Microsoft YaHei",sans-serif;' +
    'background:transparent;transition:opacity .55s ease;';

  // ---- 背景图：使用真实游戏截图（校门夜景）----
  const bgImg = document.createElement('div');
  bgImg.style.cssText =
    'position:absolute;inset:0;transition:opacity .9s ease;' +
    'background:url(/loading-bg.jpg) center/cover no-repeat;';

  // ---- 压暗遮罩：保证文字可读，reveal 时淡出露游戏 ----
  const bgLayer = document.createElement('div');
  bgLayer.style.cssText =
    'position:absolute;inset:0;transition:opacity .9s ease;' +
    'background:linear-gradient(180deg,rgba(6,10,22,.42) 0%,rgba(6,10,22,.55) 100%);';

  // ---- 暗角层：保证文字在游戏画面上仍可读，但不挡住世界太多 ----
  const vignette = document.createElement('div');
  vignette.style.cssText =
    'position:absolute;inset:0;pointer-events:none;transition:background .9s ease;' +
    'background:radial-gradient(120% 90% at 50% 36%,transparent 36%,rgba(5,8,16,.48) 100%);';

  // ---- 中央内容：校门 Logo + 标题 + 状态（整体垂直位置偏下，避免挡住校门主体）----
  const center = document.createElement('div');
  center.style.cssText =
    'position:absolute;left:50%;top:58%;transform:translate(-50%,-50%);z-index:2;' +
    'display:flex;flex-direction:column;align-items:center;gap:18px;' +
    'animation:fpm-ls-logoIn .6s ease both;';

  const logo = document.createElement('img');
  logo.src = '/favicon-512.png';
  logo.alt = title;
  logo.style.cssText =
    'width:min(210px,44vw);height:auto;filter:drop-shadow(0 10px 26px rgba(0,0,0,.45));' +
    'animation:fpm-ls-float 3.4s ease-in-out infinite;';

  const titleEl = document.createElement('div');
  titleEl.style.cssText =
    'font-size:min(30px,7vw);font-weight:800;letter-spacing:.12em;color:#fff;' +
    'text-shadow:0 3px 0 rgba(9,30,60,.55),0 8px 24px rgba(0,0,0,.4);';
  titleEl.textContent = title;

  const status = document.createElement('div');
  status.style.cssText = 'font-size:13px;color:#cdd6f0;min-height:18px;text-align:center;opacity:.9;';
  status.textContent = '正在准备校园场景…';

  center.appendChild(logo);
  center.appendChild(titleEl);
  center.appendChild(status);

  // ---- 底部：流光带动画 + 加载条（压在底部）----
  const bottom = document.createElement('div');
  bottom.style.cssText =
    'position:absolute;left:50%;bottom:6.5%;transform:translateX(-50%);z-index:2;' +
    'width:min(380px,74vw);display:flex;flex-direction:column;align-items:center;gap:10px;' +
    'transition:opacity .6s ease;';

  const sweep = document.createElement('div');
  sweep.style.cssText =
    'width:100%;height:3px;border-radius:3px;overflow:hidden;' +
    'background:linear-gradient(90deg,transparent,rgba(127,208,255,0) 18%,rgba(127,208,255,.6) 50%,rgba(127,208,255,0) 82%,transparent);' +
    'background-size:200% 100%;animation:fpm-ls-shimmer 2.2s linear infinite;';

  const bar = document.createElement('div');
  bar.style.cssText =
    'position:relative;width:100%;height:8px;border-radius:6px;overflow:hidden;' +
    'background:rgba(255,255,255,.12);box-shadow:inset 0 1px 2px rgba(0,0,0,.35);';
  const fill = document.createElement('div');
  fill.style.cssText =
    'position:absolute;left:0;top:0;bottom:0;width:0%;border-radius:6px;' +
    'background:linear-gradient(90deg,#7fd0ff,#ffcf66);transition:width .35s ease;' +
    'box-shadow:0 0 12px rgba(127,208,255,.6);';
  bar.appendChild(fill);

  bottom.appendChild(sweep);
  bottom.appendChild(bar);

  // ---- 就绪态：屏幕中央占满宽度的横条「点击进入游戏」----
  const enterBar = document.createElement('div');
  enterBar.textContent = '点击进入游戏';
  enterBar.style.cssText =
    'position:absolute;left:0;right:0;top:50%;transform:translateY(-50%) scale(.98);z-index:5;' +
    'display:none;align-items:center;justify-content:center;' +
    'height:min(78px,13vh);padding:0 20px;box-sizing:border-box;' +
    'background:linear-gradient(90deg,rgba(59,130,246,.82),rgba(37,99,235,.82));' +
    'backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);' +
    'color:#fff;font-size:min(28px,6vw);font-weight:800;letter-spacing:.22em;' +
    'text-shadow:0 2px 4px rgba(0,0,0,.35);' +
    'box-shadow:0 14px 44px rgba(0,0,0,.38),inset 0 1px 0 rgba(255,255,255,.22);' +
    'cursor:pointer;pointer-events:auto;opacity:0;' +
    'transition:opacity .55s ease,transform .55s ease,background .2s ease,box-shadow .2s ease;';
  enterBar.addEventListener('mouseenter', () => {
    enterBar.style.background = 'linear-gradient(90deg,rgba(96,165,250,.9),rgba(59,130,246,.9))';
    enterBar.style.boxShadow = '0 18px 52px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.28)';
  });
  enterBar.addEventListener('mouseleave', () => {
    enterBar.style.background = 'linear-gradient(90deg,rgba(59,130,246,.82),rgba(37,99,235,.82))';
    enterBar.style.boxShadow = '0 14px 44px rgba(0,0,0,.38),inset 0 1px 0 rgba(255,255,255,.22)';
  });
  enterBar.addEventListener('pointerdown', () => {
    enterBar.style.transform = 'translateY(-50%) scale(.96)';
  });
  enterBar.addEventListener('pointerup', () => {
    enterBar.style.transform = 'translateY(-50%) scale(1)';
  });
  enterBar.addEventListener('click', (e) => { e.stopPropagation(); beginEnter(); });

  root.appendChild(bgImg);
  root.appendChild(bgLayer);
  root.appendChild(vignette);
  root.appendChild(center);
  root.appendChild(bottom);
  root.appendChild(enterBar);

  // 加载期间吞掉所有指针事件：不只是挡住画面，也别让点击漏进游戏里。
  root.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
  }, true);
  // 就绪态：点击任意处进入（点击前遮罩仍捕获指针，不漏进游戏）
  root.addEventListener('click', () => {
    if (root.dataset.phase === 'ready' && !finished) beginEnter();
  });

  document.body.appendChild(root);

  function beginEnter() {
    if (finished) return;
    finished = true;
    root.style.opacity = '0'; // 整个遮罩淡出（bgLayer 已透明，故直接露出游戏）
    setTimeout(() => { if (root.parentElement) root.remove(); }, 600);
    if (readyResolve) readyResolve();
  }

  // 资产就绪 → 转入「点击进入」态：遮罩渐隐露出实时游戏世界
  function revealGame() {
    root.dataset.phase = 'ready';
    bgImg.style.opacity = '0';        // 露出后台实时渲染的校园（高画质背景）
    bgLayer.style.opacity = '0';
    vignette.style.background =
      'radial-gradient(120% 90% at 50% 36%,transparent 54%,rgba(5,8,16,.34) 100%)';
    logo.style.opacity = '0';
    titleEl.style.opacity = '0';
    status.style.display = 'none';
    bottom.style.opacity = '0';
    enterBar.style.display = 'flex';
    // 下一帧再 opacity:1，让 display 切换先生效，产生淡入
    requestAnimationFrame(() => { enterBar.style.opacity = '1'; enterBar.style.transform = 'translateY(-50%) scale(1)'; });
  }

  return {
    // 资产就绪后转入「点击进入」态，返回 Promise（玩家点击后 resolve）
    markReady() {
      revealGame();
      return ready;
    },
    // 兼容旧调用：直接结束（兜底）
    finish() { beginEnter(); },
    // done/total：total 为 0 表示总量未知，此时进度条慢慢爬避免像卡死
    setProgress(done, total) {
      if (finished || root.dataset.phase === 'ready') return;
      if (total > 0) {
        const pct = Math.min(100, Math.round((done / total) * 100));
        fill.style.width = pct + '%';
        status.textContent = '正在加载模型 ' + done + ' / ' + total;
      } else {
        fill.style.width = Math.min(85, 10 + done * 6) + '%';
        status.textContent = '正在加载模型…（已就绪 ' + done + ' 件）';
      }
    },
    get done() { return finished; },
  };
}
