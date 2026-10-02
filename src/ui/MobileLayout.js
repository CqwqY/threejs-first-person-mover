// 职责：手机端按键布局的「自适应 + 自定义 + 位置检查」。
// - 自适应：用 clamp()/dvh/安全区统一收口触屏控件尺寸与触摸区，小屏不挤、横屏不塌。
// - 自定义：点「调整」进入编辑模式，每个可动控件上浮出一个黄色拖拽把手，拖到任意位置；
//   位置以「中心点比例」按横竖屏分别保存，旋转后仍在对应角落。
// - 位置检查：只读检查（不改动任何锚点），逐个判定控件是否完整落在可见区内。
import {
  LAYOUT_ITEMS, installViewportWatcher, applyLayout, writeLayout, currentMode,
  relayout, resetLayout, setLayoutPaused, viewportSize, snapshotEl,
} from './layout.js';
import { ensureTheme } from './theme.js';

const MARGIN = 4;

export function initMobileLayout() {
  ensureTheme(); // 配色/字体统一取自主题变量，本模块不再自带一套颜色
  const coarse =
    (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
    'ontouchstart' in window;
  if (!coarse) return;

  // 纯布局样式（一次性注入）：自适应尺寸、侧栏定位与 .open 显隐是行为依赖，必须留在这里。
  // theme.js 不含这些类，且侧栏按钮是叠在世界上的小尺寸控件，套 .kui-btn 会被 min-width/border 撑大，
  // 所以这里只保留布局，把硬编码颜色/字体换成主题变量。
  const style = document.createElement('style');
  style.textContent = `
    /* 用 vmin（短边）而非 vw：vw 在旋转后宽度翻倍，控件会突然变大 */
    .mc-jump{width:clamp(56px,15vmin,78px);height:clamp(56px,15vmin,78px);
      font-size:clamp(13px,3.6vmin,16px)}
    .mc-joy{width:clamp(92px,26vmin,124px);height:clamp(92px,26vmin,124px)}
    .mc-knob{width:clamp(42px,11vmin,56px);height:clamp(42px,11vmin,56px)}
    /* 侧栏：贴左上角（避开左下摇杆与左下血条），跟随安全区，默认收起只留一个小页签 */
    .ml-bar{position:fixed;z-index:80;display:flex;flex-direction:column;gap:6px;
      left:calc(env(safe-area-inset-left, 0px) + 8px);
      top:calc(env(safe-area-inset-top, 0px) + 52px);
      user-select:none;-webkit-user-select:none;
      font:clamp(11px,2.8vmin,12px)/1.2 var(--kui-font)}
    /* 半透明深色底 + 主题描边：保持原本的小尺寸与留白 */
    .ml-tab{background:color-mix(in srgb, var(--kui-ink) 72%, transparent);color:var(--kui-paper);
      border:1px solid color-mix(in srgb, var(--kui-blue-soft) 55%, transparent);
      border-radius:var(--kui-radius);padding:6px 9px;cursor:pointer;text-align:center;touch-action:none;
      user-select:none;-webkit-user-select:none;letter-spacing:1px}
    /* 收起/展开状态：由 setPanelOpen 切 .open 驱动，这两条规则必须保留 */
    .ml-panel{display:none;flex-direction:column;gap:6px}
    .ml-panel.open{display:flex}
    .ml-btn{background:color-mix(in srgb, var(--kui-ink) 72%, transparent);color:var(--kui-paper);
      border:1px solid color-mix(in srgb, var(--kui-blue-soft) 55%, transparent);
      border-radius:var(--kui-radius);padding:6px 9px;cursor:pointer;text-align:center;touch-action:none;
      user-select:none;-webkit-user-select:none}
    .ml-btn.on{background:var(--kui-blue);border-color:var(--kui-blue-soft)}
    /* 编辑模式的拖拽把手保留黄色：toast 文案写的就是「拖动黄色把手」，主题里没有黄色变量 */
    .ml-handle{position:fixed;z-index:81;border:2px dashed #ffd479;border-radius:var(--kui-radius);
      box-sizing:border-box;background:rgba(255,212,121,.10);touch-action:none;cursor:move}
    .ml-tag{position:absolute;left:0;top:-20px;font:11px/1.4 var(--kui-font);
      padding:1px 6px;border-radius:var(--kui-radius);color:var(--kui-paper);white-space:nowrap}
  `;
  document.head.appendChild(style);

  // ---- 简易提示气泡 ----
  let toastEl = null;
  let toastTimer = 0;
  function toast(text) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText =
        'position:fixed;left:50%;top:12%;transform:translateX(-50%);z-index:82;max-width:82vw;' +
        'background:color-mix(in srgb, var(--kui-ink) 88%, transparent);color:var(--kui-paper);' +
        'padding:8px 14px;border-radius:var(--kui-radius);' +
        'font:12px/1.5 var(--kui-font);pointer-events:none;text-align:center;';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.style.display = 'none'; }, 2600);
  }

  // ---- 侧栏：小页签 + 可收起的按钮组（避免长占屏幕） ----
  const bar = document.createElement('div');
  bar.className = 'ml-bar';
  const tab = document.createElement('div');
  tab.className = 'ml-tab';
  tab.textContent = '布局';
  const panel = document.createElement('div');
  panel.className = 'ml-panel';
  bar.appendChild(tab);
  bar.appendChild(panel);
  const mkBtn = (text) => {
    const b = document.createElement('div');
    b.className = 'ml-btn';
    b.textContent = text;
    panel.appendChild(b);
    return b;
  };
  const toggle = mkBtn('调整');
  const check = mkBtn('检查');
  const reset = mkBtn('重置');
  document.body.appendChild(bar);

  let panelOpen = false;
  const setPanelOpen = (v) => {
    panelOpen = !!v;
    panel.classList.toggle('open', panelOpen);
    tab.classList.toggle('on', panelOpen);
  };
  tab.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setPanelOpen(!panelOpen);
  });

  let editing = false;
  const handles = [];

  // 夹进屏幕，避免拖丢
  function clampPos(left, top, w, h) {
    const { width: vw, height: vh } = viewportSize();
    return {
      left: Math.max(MARGIN, Math.min(vw - w - MARGIN, left)),
      top: Math.max(MARGIN, Math.min(vh - h - MARGIN, top)),
    };
  }

  function visibleOf(el) {
    const r = el.getBoundingClientRect();
    const { width: vw, height: vh } = viewportSize();
    return r.width > 0 && r.height > 0
      && r.left >= MARGIN - 1 && r.top >= MARGIN - 1
      && r.right <= vw - MARGIN + 1 && r.bottom <= vh - MARGIN + 1;
  }

  // 把手跟随元素矩形；同时刷新「可见/超界」徽标
  function syncOne(rec) {
    const r = rec.el.getBoundingClientRect();
    rec.h.style.left = r.left + 'px';
    rec.h.style.top = r.top + 'px';
    rec.h.style.width = r.width + 'px';
    rec.h.style.height = r.height + 'px';
    const ok = visibleOf(rec.el);
    rec.ok = ok;
    rec.tag.textContent = rec.it.label + (ok ? ' 可见' : ' 超出屏幕');
    // 绿/红直接取主题的成功色与危险色（toast 文案说的「红色表示超出屏幕」依然成立）
    rec.tag.style.background = ok ? 'var(--kui-ok)' : 'var(--kui-danger)';
  }
  function syncAll() { for (const rec of handles) syncOne(rec); }

  function bindDrag(rec) {
    let id = null;
    let dx = 0;
    let dy = 0;
    rec.h.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      id = e.pointerId;
      try { rec.h.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      snapshotEl(rec.el); // 存档原始定位，供「重置」还原
      const r = rec.el.getBoundingClientRect();
      dx = e.clientX - r.left;
      dy = e.clientY - r.top;
    });
    rec.h.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      e.preventDefault();
      const p = clampPos(e.clientX - dx, e.clientY - dy, rec.el.offsetWidth, rec.el.offsetHeight);
      rec.el.style.left = p.left + 'px';
      rec.el.style.top = p.top + 'px';
      rec.el.style.right = 'auto';
      rec.el.style.bottom = 'auto';
      rec.el.style.transform = 'none';
      syncOne(rec);
    });
    const end = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      // 以中心点比例存到「当前方向」那一套里（横竖屏各存一份）
      writeLayout(currentMode(), rec.it.key, rec.el);
      syncOne(rec);
    };
    rec.h.addEventListener('pointerup', end);
    rec.h.addEventListener('pointercancel', end);
  }

  function buildHandles() {
    for (const it of LAYOUT_ITEMS) {
      const el = document.querySelector(it.sel);
      if (!el) continue;
      // 编辑期间把「平时隐藏」的控件临时显示出来，否则没法摆放（退出时只还原 display，不动锚点）
      const hidden = getComputedStyle(el).display === 'none';
      if (hidden) el.style.display = it.showAs || 'block';
      const h = document.createElement('div');
      h.className = 'ml-handle';
      const tag = document.createElement('div');
      tag.className = 'ml-tag';
      h.appendChild(tag);
      document.body.appendChild(h);
      const rec = { it, el, h, tag, ok: true, hidden };
      handles.push(rec);
      bindDrag(rec);
      syncOne(rec);
    }
  }

  function enter() {
    editing = true;
    setLayoutPaused(true); // 编辑期间暂停自动重排，避免拖到一半被挪走
    setPanelOpen(true);    // 展开侧栏，保证「完成」可见
    toggle.classList.add('on');
    toggle.textContent = '完成';
    buildHandles();
    toast('拖动黄色把手摆放按键；红色表示超出屏幕');
  }

  function exit() {
    editing = false;
    setLayoutPaused(false);
    toggle.classList.remove('on');
    toggle.textContent = '调整';
    for (const rec of handles) {
      rec.h.remove();
      if (rec.hidden) rec.el.style.display = 'none'; // 只还原显示状态，不动位置
    }
    handles.length = 0;
    relayout(); // 退出时补跑一次重排
  }

  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  // 按下即响应：多点触控下（另一只手推着摇杆）click 可能不派发
  toggle.addEventListener('pointerdown', (e) => {
    stop(e);
    if (editing) exit(); else enter();
  });

  // 检查：只读，不改动任何锚点（旧实现会 enter() 从而把自适应锚点改写成 px）
  check.addEventListener('pointerdown', (e) => {
    stop(e);
    const rows = [];
    for (const it of LAYOUT_ITEMS) {
      const el = document.querySelector(it.sel);
      if (!el) continue;
      const shown = getComputedStyle(el).display !== 'none';
      if (shown && !visibleOf(el)) rows.push(it.label);
    }
    if (editing) syncAll();
    toast(rows.length ? ('超出屏幕：' + rows.join('、')) : '全部控件都在可见范围内');
  });

  reset.addEventListener('pointerdown', (e) => {
    stop(e);
    if (editing) exit();
    resetLayout();
    toast('布局已重置为默认位置');
  });

  // 视口变化（旋转 / 地址栏收起 / 键盘）→ 重排；编辑中只刷新把手
  installViewportWatcher(() => {
    if (editing) syncAll();
  });

  // 启动时先按当前方向摆一次
  applyLayout(currentMode());
}
