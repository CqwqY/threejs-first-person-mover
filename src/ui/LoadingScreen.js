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
  ensureKeyframes();
  const title = opts.title || '';
  let skippedResolve = null;
  const skipped = new Promise((res) => { skippedResolve = res; });
  let finished = false;

  // ---- 遮罩 ----
  const root = document.createElement('div');
  root.className = 'fpm-loading';
  root.style.cssText =
    'position:fixed;inset:0;z-index:10000;display:flex;flex-direction:column;' +
    'align-items:center;justify-content:center;gap:18px;user-select:none;' +
    'background:radial-gradient(120% 90% at 50% 30%, #2c3350 0%, #171b2b 55%, #0e1120 100%);' +
    'color:#eef1f8;font-family:var(--kui-font, system-ui, "Microsoft YaHei", sans-serif);' +
    'transition:opacity .45s ease;';
  // ---- 转圈（三瓣：外环旋转 + 内点呼吸）----
  const ring = document.createElement('div');
  ring.style.cssText =
    'position:relative;width:76px;height:76px;animation:fpm-ld-fade .4s ease both;';
  const arc = document.createElement('div');
  arc.style.cssText =
    'position:absolute;inset:0;border-radius:50%;' +
    'border:3px solid rgba(255,255,255,.14);border-top-color:#ffd76a;border-right-color:#7fd0ff;' +
    'animation:fpm-ld-spin 1s linear infinite;';
  const dot = document.createElement('div');
  dot.style.cssText =
    'position:absolute;left:50%;top:50%;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;' +
    'background:#ffd76a;animation:fpm-ld-pulse 1.4s ease-in-out infinite;';
  ring.appendChild(arc);
  ring.appendChild(dot);

  // ---- 文字 ----
  const h = document.createElement('div');
  h.style.cssText = 'font-size:22px;font-weight:700;letter-spacing:.14em;animation:fpm-ld-fade .5s ease both;';
  h.textContent = title;

  const status = document.createElement('div');
  status.style.cssText =
    'font-size:13px;color:#aab2c8;min-height:18px;text-align:center;' +
    'font-variant-numeric:tabular-nums;';
  status.textContent = '正在准备场景…';

  // ---- 进度条 ----
  const bar = document.createElement('div');
  bar.style.cssText =
    'width:min(260px,62vw);height:6px;border-radius:99px;background:rgba(255,255,255,.12);overflow:hidden;';
  const fill = document.createElement('div');
  fill.style.cssText =
    'width:0%;height:100%;border-radius:99px;background:linear-gradient(90deg,#7fd0ff,#ffd76a);' +
    'transition:width .3s ease;';
  bar.appendChild(fill);

  // ---- 「不等了」按钮 ----
  const skip = document.createElement('button');
  skip.type = 'button';
  skip.className = 'kui-btn';
  skip.textContent = '不等了，直接进';
  skip.style.cssText =
    'margin-top:6px;font:inherit;font-size:13px;padding:7px 18px;cursor:pointer;' +
    'border-radius:99px;border:1px solid rgba(255,255,255,.28);' +
    'background:rgba(255,255,255,.08);color:#dfe4f2;';
  skip.addEventListener('pointerenter', () => { skip.style.background = 'rgba(255,255,255,.16)'; });
  skip.addEventListener('pointerleave', () => { skip.style.background = 'rgba(255,255,255,.08)'; });
  let skippedFlag = false;
  const doSkip = () => {
    if (finished) return;
    skippedFlag = true;
    status.textContent = '直接进（没到的模型会随后补上）';
    skippedResolve();
  };
  skip.addEventListener('click', doSkip);

  root.appendChild(ring);
  root.appendChild(h);
  root.appendChild(status);
  root.appendChild(bar);
  root.appendChild(skip);
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
