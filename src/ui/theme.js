// 职责：全局 UI 主题（Kenney UI 素材 + Kenney Future 字体）的唯一来源。
// 每个界面都从这里取样式类，不要在各自的模块里再写一套 CSS，否则风格会漂移。
//
// 素材用法说明：
// - 面板/按钮用的是 384x128 的「双倍图」，border-image 的 slice 取 2 倍像素、border-width 取 1 倍像素，
//   等于把素材按 1 倍 Kenney 设计尺寸渲染，边框粗细和圆角都正确且可伸缩。
// - 进度条只需要中间那张可平铺的 m 图，两侧圆角由外层容器的 border-radius + overflow 裁出来。
const FONT_DISPLAY = 'Kenney Future';

let injected = false;

// 把主题样式注入 <head>（幂等：多个界面同时调用也只注入一次）
export function ensureTheme() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const style = document.createElement('style');
  style.id = 'kui-theme';
  style.textContent = `
    @font-face {
      font-family: '${FONT_DISPLAY}';
      src: url('/ui/fonts/KenneyFuture.ttf') format('truetype');
      font-display: swap;
    }

    :root {
      /* 主色阶：面板/按钮本体就是这个蓝，描边更深、文字用近黑 */
      --kui-blue: #4a8fe0;
      --kui-blue-dark: #2f6cba;
      --kui-blue-deep: #1f4e8c;
      --kui-blue-soft: #dceafb;
      --kui-ink: #0b1522;
      --kui-ink-soft: #33465c;
      --kui-paper: #ffffff;
      --kui-danger: #d9534f;
      --kui-ok: #46b36b;
      --kui-shadow: 0 10px 28px rgba(8, 26, 48, .3);
      --kui-radius: 12px;
      /* 显示数字/拉丁字母用的方体字；中文请继续用系统 CJK 字体 */
      --kui-font: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      --kui-font-num: '${FONT_DISPLAY}', system-ui, "Microsoft YaHei", sans-serif;
    }

    /* ---- 面板：Kenney 蓝色九宫格，可任意拉伸 ---- */
    .kui-panel {
      box-sizing: border-box;
      border: 13px solid transparent;
      border-image: url('/ui/panel_rectangle.png') 26 fill / 13px stretch;
      color: var(--kui-ink);
      font-family: var(--kui-font);
    }
    /* 面板内部内容容器：把 border 的 13px 当作内边距之外，再补一点呼吸感 */
    .kui-panel > .kui-panel__body {
      position: relative;
      z-index: 1;
      padding: 2px 4px;
    }

    /* ---- 按钮 ---- */
    .kui-btn {
      box-sizing: border-box;
      border: 10px solid transparent;
      border-image: url('/ui/button_rectangle.png') 22 fill / 10px stretch;
      background: transparent;
      color: var(--kui-ink);
      font-family: var(--kui-font);
      font-size: 13px;
      font-weight: 700;
      line-height: 1.15;
      padding: 0 6px;
      min-height: 38px;
      min-width: 92px;
      cursor: pointer;
      user-select: none;
      -webkit-user-select: none;
      -webkit-tap-highlight-color: transparent;
      transition: filter .12s ease, transform .08s ease;
    }
    .kui-btn:hover { filter: brightness(1.08); }
    .kui-btn:active { transform: translateY(1px); filter: brightness(.94); }
    .kui-btn[disabled], .kui-btn.is-disabled {
      filter: grayscale(.7) brightness(.92);
      opacity: .65;
      cursor: not-allowed;
    }
    /* 主按钮：用在「确认/购买/进入」这类正向动作上 */
    .kui-btn--primary {
      border-image: url('/ui/button_rectangle_depth.png') 22 fill / 10px stretch;
      color: #fff;
      text-shadow: 0 1px 0 rgba(9, 30, 60, .35);
    }
    /* 次级按钮：只留描边，不抢主按钮的注意力 */
    .kui-btn--ghost {
      border-image: none;
      border: 2px solid var(--kui-blue-dark);
      border-radius: var(--kui-radius);
      background: rgba(255, 255, 255, .1);
      color: var(--kui-ink);
    }
    .kui-btn--ghost:hover { background: rgba(255, 255, 255, .22); }
    /* 危险按钮：退出登录、删除这类 */
    .kui-btn--danger { border-image: none; border: 2px solid var(--kui-danger); border-radius: var(--kui-radius); background: rgba(217, 83, 79, .12); color: #7d1f1c; }

    /* 方形图标按钮：关闭、返回、加减号 */
    .kui-iconbtn {
      box-sizing: border-box;
      border: 8px solid transparent;
      border-image: url('/ui/button_square.png') 20 fill / 8px stretch;
      background: transparent;
      color: var(--kui-ink);
      width: 44px; height: 44px;
      display: inline-flex; align-items: center; justify-content: center;
      font: 700 15px/1 var(--kui-font);
      cursor: pointer; padding: 0;
      -webkit-tap-highlight-color: transparent;
      transition: filter .12s ease, transform .08s ease;
    }
    .kui-iconbtn:hover { filter: brightness(1.08); }
    .kui-iconbtn:active { transform: translateY(1px); filter: brightness(.94); }

    /* ---- 文本输入 ---- */
    .kui-input {
      box-sizing: border-box;
      width: 100%;
      padding: 9px 12px;
      font-family: var(--kui-font);
      font-size: 14px;
      color: var(--kui-ink);
      background: var(--kui-paper);
      border: 2px solid var(--kui-blue-dark);
      border-radius: 10px;
      outline: none;
    }
    .kui-input::placeholder { color: #7a8a9c; }
    .kui-input:focus { border-color: var(--kui-blue); box-shadow: 0 0 0 3px rgba(74, 143, 224, .3); }

    /* ---- 进度条：只用 m 平铺，圆角由容器裁出来 ---- */
    .kui-bar {
      position: relative;
      height: 14px;
      background: rgba(6, 20, 38, .5);
      border-radius: 7px;
      overflow: hidden;
    }
    .kui-bar__fill {
      position: absolute; left: 0; top: 0; bottom: 0;
      background-image: url('/ui/bar_round_large_m.png');
      background-repeat: repeat-x;
      background-size: auto 100%;
      border-radius: 7px;
      transition: width .15s linear;
    }
    .kui-bar--sm { height: 8px; border-radius: 4px; }
    .kui-bar--sm .kui-bar__fill { background-image: url('/ui/bar_round_small_m.png'); border-radius: 4px; }
    .kui-bar--danger .kui-bar__fill { filter: hue-rotate(-95deg) saturate(1.5); }
    .kui-bar--ok .kui-bar__fill { filter: hue-rotate(85deg) saturate(1.2); }

    /* ---- 排版与行 ---- */
    .kui-title {
      font-family: var(--kui-font);
      font-size: 15px;
      font-weight: 800;
      letter-spacing: 2px;
      color: var(--kui-ink);
    }
    /* 数字/时间/编号：用方体字，读起来更像游戏 UI */
    .kui-num {
      font-family: var(--kui-font-num);
      font-variant-numeric: tabular-nums;
      letter-spacing: 1px;
    }
    .kui-row {
      display: flex; align-items: center; justify-content: space-between;
      gap: 10px; font-size: 12px; padding: 3px 0;
      color: var(--kui-ink-soft);
    }
    .kui-row > b { color: var(--kui-ink); font-weight: 700; }

    /* ---- 准星 ---- */
    .kui-crosshair {
      position: fixed; left: 50%; top: 50%;
      width: 26px; height: 26px; margin: -13px 0 0 -13px;
      background: url('/ui/crosshair_a.png') center / contain no-repeat;
      pointer-events: none; z-index: 60; opacity: .9;
    }
  `;
  document.head.appendChild(style);
}
