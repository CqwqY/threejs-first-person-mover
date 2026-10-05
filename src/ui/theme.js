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
      /* 学币金币：主体 / 描边 / 内圈高光 */
      --kui-gold: #e8b53a;
      --kui-gold-deep: #a97c15;
      --kui-gold-hi: #f7dc7a;
      --kui-shadow: 0 10px 28px rgba(8, 26, 48, .3);
      --kui-radius: 12px;
      /* 显示数字/拉丁字母用的方体字；中文请继续用系统 CJK 字体 */
      --kui-font: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      --kui-font-num: '${FONT_DISPLAY}', system-ui, "Microsoft YaHei", sans-serif;

      /* ---- 语义色（2026-10-04）----
         以前血条/热度条/战斗结算各自硬编码了一套 Material 色（#2ecc71/#e74c3c/#ffd76a…），
         同一个"危险"有四种红、"成功"有两种绿。现在一律走这里的语义变量。
         要表达状态就用语义名，不要再写死具体色值 —— 否则换个主题要改几十处。 */
      --kui-ok-2: #46b36b;        /* 满血/就绪 */
      --kui-warn: #e0a83a;       /* 中等（半血/过热） */
      --kui-danger: #d9534f;     /* 危急/失败 */
      --kui-gold-hi-2: #ffd76a;  /* 胜利/金币高光 */
      --kui-ink-mute: #7b8ea4;   /* 次要说明文字（观战状态、提示尾注） */

      /* ---- 圆角阶梯（2026-10-04）----
         以前界面里散着 50% / 999px / 10px / 7px / 8px / 4px / 6px 七种值，
         面板和按钮圆角对不上，看着"不像一套"。现在只用这四档。 */
      --kui-r-sm: 6px;    /* 小徽标、标签、进度条内圈 */
      --kui-r-md: 10px;   /* 输入框、小浮层（最常用） */
      --kui-r-lg: 14px;   /* 卡片、面板 */
      --kui-r-pill: 999px;/* 胶囊：血条、药丸按钮 */
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
      border: 8px solid transparent;
      border-image: url('/ui/button_rectangle.png') 22 fill / 8px stretch;
      background: transparent;
      color: var(--kui-ink);
      font-family: var(--kui-font);
      font-size: 12px;
      font-weight: 700;
      line-height: 1.15;
      padding: 0 5px;
      min-height: 34px;
      min-width: 72px;
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
      border-image: url('/ui/button_rectangle_depth.png') 22 fill / 8px stretch;
      color: #fff;
      text-shadow: 0 1px 0 rgba(9, 30, 60, .35);
    }
    /* 彩色按钮：同一套 Kenney 按钮素材按颜色重新染色，用来区分不同动作 */
    .kui-btn--red,
    .kui-btn--danger {
      border-image: url('/ui/button_rectangle_red.png') 22 fill / 8px stretch;
      color: #fff;
      text-shadow: 0 1px 0 rgba(74, 14, 8, .4);
    }
    .kui-btn--green {
      border-image: url('/ui/button_rectangle_green.png') 22 fill / 8px stretch;
      color: #fff;
      text-shadow: 0 1px 0 rgba(12, 56, 30, .4);
    }
    .kui-btn--yellow {
      border-image: url('/ui/button_rectangle_yellow.png') 22 fill / 8px stretch;
      color: #4a3208;
      text-shadow: 0 1px 0 rgba(255, 255, 255, .3);
    }
    .kui-btn--grey {
      border-image: url('/ui/button_rectangle_grey.png') 22 fill / 8px stretch;
      color: var(--kui-ink);
      text-shadow: 0 1px 0 rgba(255, 255, 255, .3);
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

    /* 方形图标按钮：关闭、返回、加减号 */
    .kui-iconbtn {
      box-sizing: border-box;
      border: 7px solid transparent;
      border-image: url('/ui/button_square.png') 20 fill / 7px stretch;
      background: transparent;
      color: var(--kui-ink);
      width: 36px; height: 36px;
      display: inline-flex; align-items: center; justify-content: center;
      font: 700 14px/1 var(--kui-font);
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

    /* ---- 标签页（同一面板内切换，如商店的「道具 / 家具」）----
       用 Kenney 按钮素材做页签：选中态用「深度」底（同主按钮），未选中用灰底。 */
    .kui-tabs {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin: 0 0 12px;
    }
    .kui-tab {
      box-sizing: border-box;
      border: 8px solid transparent;
      border-image: url('/ui/button_rectangle_grey.png') 22 fill / 8px stretch;
      background: transparent;
      color: var(--kui-ink);
      font: 700 13px/1.15 var(--kui-font);
      padding: 0 16px;
      min-height: 34px;
      cursor: pointer;
      user-select: none;
      -webkit-user-select: none;
      -webkit-tap-highlight-color: transparent;
      transition: filter .12s ease, transform .08s ease;
    }
    .kui-tab:hover { filter: brightness(1.08); }
    .kui-tab:active { transform: translateY(1px); }
    .kui-tab.is-active {
      border-image: url('/ui/button_rectangle_depth.png') 22 fill / 8px stretch;
      color: #fff;
      text-shadow: 0 1px 0 rgba(9, 30, 60, .35);
    }

    /* ---- HUD 原子类（2026-10-04）----
       以前血条/加特林条/观战条/Boss 条/聊天面板各写一遍「半透明深底 + 圆角 + 白字 + 文字阴影」，
       同一个壳子有五份行内 cssText，改主题就得改五处。这里收敛成几个类。
       用法：给容器加 .kui-hud（深色玻璃底），文字部分加 .kui-hud__label / .kui-hud__note。 */
    .kui-hud {
      box-sizing: border-box;
      border-radius: var(--kui-r-md);
      background: rgba(11, 21, 34, .72);
      border: 1px solid rgba(255, 255, 255, .12);
      padding: 6px 10px;
      color: var(--kui-paper);
      font-family: var(--kui-font);
      pointer-events: none;
      user-select: none;
      -webkit-user-select: none;
    }
    .kui-hud__title {
      display: flex; justify-content: space-between; gap: 10px;
      font-size: 12px; font-weight: 700;
      text-shadow: 0 1px 3px rgba(0, 0, 0, .7);
    }
    .kui-hud__note {          /* 次要说明：数值、状态后缀 */
      color: var(--kui-ink-mute);
      font-size: 11px;
      font-family: var(--kui-font-num);
    }
    .kui-hud__caption {       /* 进度条下方的说明文字 */
      margin-top: 4px;
      font-size: 11px;
      text-shadow: 0 1px 3px rgba(0, 0, 0, .7);
    }
    /* 状态徽标：战斗结算/观战横幅那种小圆角标签 */
    .kui-tag {
      display: inline-block;
      padding: 1px 7px;
      border-radius: var(--kui-r-sm);
      font-size: 11px;
      font-weight: 700;
      background: color-mix(in srgb, var(--kui-blue) 34%, transparent);
      color: var(--kui-paper);
    }
    .kui-tag--ok { background: color-mix(in srgb, var(--kui-ok) 38%, transparent); }
    .kui-tag--warn { background: color-mix(in srgb, var(--kui-warn) 38%, transparent); color: #2b1f05; }
    .kui-tag--danger { background: color-mix(in srgb, var(--kui-danger) 40%, transparent); }

    /* ---- 顶部「图标键 + 下方文字」按钮组（2026-10-04）----
       用户要求：按钮里只放图标，**文字放在图标下面**（垂直排列，不在按钮内、也不在右侧）。
       垂直排列的好处是横向占位小 —— 顶部左右两侧都是紧挨着校卡的地方，宽度比并排省一半。 */
    .kui-topbtn {
      display: inline-flex;
      flex-direction: column;
      align-items: center;
      gap: 3px;
      user-select: none;
      -webkit-user-select: none;
    }
    .kui-topbtn > .kui-iconbtn { flex: 0 0 auto; font-style: normal; }
    /* 手机端顶部那一行（背包 / 设置 / 对战匹配 / 全屏）。
       ⚠ gap 必须放在 class 里、不能写进行内样式：行内样式压不过媒体查询，
       而极窄屏（≤380px）要把间距和图标键一起收紧，否则四个按钮会被挤出屏幕。 */
    .kui-toprow {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
      align-items: flex-start;
      flex-wrap: nowrap;
    }
    /* 360px 这类极窄屏：图标键 36→32、标签 11→10、间距 8→4，四个按钮才放得下
       （可用宽度 = 360 - 校卡 184 - 右边距 8 = 168，放 32+32+44+44 + 3×4 = 164）。
       数字被 ui-check.mjs 的窄屏算术对拍引用，改这里必须同步改那边。 */
    @media (pointer: coarse) and (max-width: 380px) {
      .kui-toprow { gap: 4px; }
      .kui-topbtn > .kui-iconbtn { width: 32px; height: 32px; }
      .kui-topbtn > b { font-size: 10px; }
    }
    .kui-topbtn > b {
      font: 600 11px/1.2 var(--kui-font);
      color: var(--kui-paper);
      white-space: nowrap;
      cursor: pointer;
      /* 顶部背景是 3D 画面（可能是亮天空也可能是暗楼），加阴影保证任何背景下都读得清 */
      text-shadow: 0 1px 3px rgba(0, 0, 0, .85), 0 0 2px rgba(0, 0, 0, .6);
    }
    /* 悬停/按下时整组一起变，视觉上是一个东西 */
    .kui-topbtn:hover > .kui-iconbtn { filter: brightness(1.12); }
    .kui-topbtn:active > .kui-iconbtn { transform: translateY(1px); filter: brightness(.94); }
    .kui-topbtn:hover > b { color: var(--kui-blue-soft); }

    /* ---- 沉浸模式（iOS 等不支持元素全屏时的「全屏」兜底）----
       body.kui-immersive 由 Game 在点击全屏按钮且 fullscreenSupported() 为 false 时切换。
       隐藏顶栏里除「全屏」按钮外的其它控件 + 校卡 + 车速表，画面铺满；
       全屏按钮本身（带 .kui-topbtn--fs）保留，作为唯一的退出入口。
       手机端操控（.mc-*）不受影响——开车/走路仍要它们。 */
    body.kui-immersive .kui-toprow > :not(.kui-topbtn--fs),
    body.kui-immersive #idc-layout,
    body.kui-immersive .spd-box { display: none !important; }

    /* ---- 建造模式（锤子触发）----
       body.kui-build 由 Game 在进入/退出建造模式时切换。只藏顶栏按钮行、校卡、技能槽；
       血条被家具条顶替（由 Game 单独隐藏 .hp-box），攻击键改语义为「放置」。 */
    body.kui-build .kui-toprow,
    body.kui-build #idc-layout,
    body.kui-build .sk-box { display: none !important; }

    /* ---- 骑乘 / 赛车状态（上车即切）----
       body.kui-ride 由 Game 在 _mountVehicle / _dismountVehicle 切换。
       对齐「对战/竞技场」的隐藏集：顶栏按钮行、校卡收起，给驾驶让出画面。
       ⚠ 技能槽**不在这里藏** —— 手机端 MobileControls 的刹车键要「定位到技能槽当前位置」
         （placeBrakeAtSkillSlot），而 kui-ride 类是在 setDriving(true) **之前**加上的：
         若此处把 .sk-box 设成 display:none，刹车键会量到 0 尺寸飞到屏幕角落。
         技能槽改由 Game._updateSkillBarVisibility() 统一管（该函数已并入 ride 条件，
         走 SkillSlots.setVisible，与对战/灵魂出窍共用一条路径，MobileControls 认它）。
       车速表（.spd-box）与骑行视角键是驾驶必需，必须保留；
       手机端驾驶键组（.mc-*，由 mobileControls.setDriving 单独切换）也不受影响。
       这里只用 CSS 整组隐藏，不逐个写 style.display —— 避免每帧 DOM 写入、
       也绝不触碰 Three 的 visible（不参与碰撞烘焙 / 射线拾取）。 */
    body.kui-ride .kui-toprow,
    body.kui-ride #idc-layout { display: none !important; }

    /* ---- 建造模式工具条 / 悬浮键（锤子触发）----
       里面的按钮一律用 .kui-btn 系（Kenney 按钮素材），这里只负责容器排布。
       容器 pointer-events:none，空隙仍可转视角；子元素各自 auto 才能点。 */
    .build-strip {
      display: flex;
      gap: 8px;
      align-items: center;
      padding: 6px 8px;
      border-radius: var(--kui-r-md);
      background: rgba(11, 21, 34, .72);
      border: 1px solid rgba(255, 255, 255, .12);
      overflow-x: auto;
      pointer-events: none;
    }
    .build-strip > * { pointer-events: auto; }
    .build-actions {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .build-actions > .kui-btn { min-width: 92px; }
    /* 工具条里的标签（“没有可摆的家具…”这类纯文字） */
    .build-strip__label {
      flex: 0 0 auto;
      white-space: nowrap;
      color: var(--kui-paper);
      font: 600 12px/1.2 var(--kui-font);
      opacity: .9;
      padding: 0 4px;
    }

    /* ---- 键位提示（Kenney Input Prompts Pixel）----
       图块是 16px 像素画，**不要平滑缩放**，否则糊成一团；用 image-rendering: pixelated。
       尺寸用 em，跟着所在文字一起缩放。 */
    .kui-key {
      display: inline-block;
      width: 2.1em; height: 2.1em;
      vertical-align: -0.42em;
      image-rendering: pixelated;
      image-rendering: crisp-edges;
      background-repeat: no-repeat;
      background-position: center;
      background-size: contain;
      filter: drop-shadow(0 1px 1px rgba(0, 0, 0, .45));
    }

    /* 带键位图块的提示按钮（[左键] 攻击、[Q] 护盾…）：图块与文字横排居中。
       ⚠ display 只能落在 class 上 —— 这些按钮靠 el.style.display = 'none' / '' 切显隐，
       '' 会把行内 display 一起清掉，写进行内样式的话一显示就丢掉 flex。 */
    .kui-btn--key {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
    }

    /* ---- 准星 ----
       用 CSS 画而不是贴图：素材是纯黑 PNG，在紫柱子/岩浆/夜景里基本看不见；
       这里每条线都带 1px 深色描边，任何背景上都读得出来。
       .is-hot = 准星压住了可攻击目标（疯狂抓钩的柱顶光点），整体转金色并放大一圈。 */
    .kui-crosshair {
      position: fixed; left: 50%; top: 50%;
      width: 24px; height: 24px; margin: -12px 0 0 -12px;
      pointer-events: none; z-index: 60; opacity: .92;
      transition: opacity .1s linear, transform .1s ease-out;
    }
    .kui-crosshair > i {
      position: absolute; background: #fff; border-radius: 1px;
      box-shadow: 0 0 0 1px rgba(0, 0, 0, .6);
    }
    .kui-crosshair > i.t { left: 11px; top: 0;     width: 2px; height: 7px; }
    .kui-crosshair > i.b { left: 11px; bottom: 0;  width: 2px; height: 7px; }
    .kui-crosshair > i.l { top: 11px; left: 0;     width: 7px; height: 2px; }
    .kui-crosshair > i.r { top: 11px; right: 0;    width: 7px; height: 2px; }
    .kui-crosshair > i.c { left: 11px; top: 11px;  width: 2px; height: 2px; }
    .kui-crosshair.is-hot { opacity: 1; transform: scale(1.22); }
    .kui-crosshair.is-hot > i {
      background: #ffd24a;
      box-shadow: 0 0 6px 1px rgba(255, 140, 40, .95), 0 0 0 1px rgba(0, 0, 0, .6);
    }

    /* ---- 手机端圆形攻击键的「可攻击」高亮 ----
       按钮本体颜色写在行内样式里，所以这里必须 !important 才盖得住；
       transform 只用于放大，手机分支的行内样式没有 transform（桌面长条才有 translateX）。 */
    .mc-atk--hot {
      background: color-mix(in srgb, var(--kui-danger) 82%, transparent) !important;
      border-color: #ffd24a !important;
      box-shadow: 0 0 0 3px rgba(255, 210, 74, .45), 0 0 20px 6px rgba(255, 110, 40, .55) !important;
      transform: scale(1.08);
      transition: transform .1s ease-out, box-shadow .1s linear;
    }
  `;
  document.head.appendChild(style);
}
