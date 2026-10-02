// 职责：手机端按键布局的「自适应 + 自定义 + 位置检查」。
// - 自适应：用 clamp()/dvh/安全区统一收口触屏控件尺寸与触摸区，小屏不挤、横屏不塌。
// - 自定义：由设置面板的「调整位置」进入编辑模式，每个可动控件上浮出一个黄色拖拽把手，拖到任意位置；
//   位置以「中心点比例」按横竖屏分别保存，旋转后仍在对应角落。
// - 位置检查：只读检查（不改动任何锚点），逐个判定控件是否完整落在可见区内。
//
// 入口变化：以前这里自带一个左上角「布局」侧栏（调整/检查/重置），它常年占着屏幕左上角；
// 现在整套动作收进「设置」弹窗的「画面元素」区块，本模块只导出动作，由 main.js 注入给设置面板
// （见 SettingsPanel 的 setLayoutActions）。编辑期间屏幕顶部会浮出一条「完成」提示条负责收口。
import {
  LAYOUT_ITEMS, installViewportWatcher, applyLayout, writeLayout, currentMode,
  relayout, resetLayout, setLayoutPaused, viewportSize, snapshotEl,
} from './layout.js';
import { ensureTheme } from './theme.js';

const MARGIN = 4;

// 返回 { isEditing, toggleEdit, enter, exit, check, reset }；
// 非触屏设备直接返回 null（调用方据此跳过接线）。
export function initMobileLayout() {
  ensureTheme(); // 配色/字体统一取自主题变量，本模块不再自带一套颜色
  const coarse =
    (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
    'ontouchstart' in window;
  if (!coarse) return null;

  // 纯布局样式（一次性注入）：自适应尺寸与编辑态顶栏是行为依赖，必须留在这里。
  // theme.js 不含这些类，且这些控件是叠在世界上的小尺寸元素，套 .kui-btn 会被 min-width/border 撑大，
  // 所以这里只保留布局，颜色/字体走主题变量。
  const style = document.createElement('style');
  style.textContent = `
    /* 用 vmin（短边）而非 vw：vw 在旋转后宽度翻倍，控件会突然变大 */
    .mc-jump{width:clamp(56px,15vmin,78px);height:clamp(56px,15vmin,78px);
      font-size:clamp(13px,3.6vmin,16px)}
    .mc-joy{width:clamp(92px,26vmin,124px);height:clamp(92px,26vmin,124px)}
    .mc-knob{width:clamp(42px,11vmin,56px);height:clamp(42px,11vmin,56px)}
    /* 编辑模式顶部条：提示文案 + 「完成」。z-index 高过顶部那排按钮与校卡，编辑期间由它统一收口。
       做成横贯全宽的一条，就不必去隐藏/挪动任何既有 UI。 */
    .ml-edit-bar{position:fixed;left:0;right:0;top:0;z-index:9700;display:flex;align-items:center;gap:8px;
      box-sizing:border-box;padding:calc(env(safe-area-inset-top, 0px) + 6px) 10px 6px;
      background:color-mix(in srgb, var(--kui-ink) 88%, transparent);color:var(--kui-paper);
      font:clamp(11px,2.8vmin,12px)/1.4 var(--kui-font);
      user-select:none;-webkit-user-select:none}
    .ml-edit-bar > span{flex:1 1 auto;min-width:0}
    /* 编辑模式的拖拽把手保留黄色：提示文案写的就是「拖动黄色把手」，主题里没有黄色变量 */
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
        'position:fixed;left:50%;top:12%;transform:translateX(-50%);z-index:9701;max-width:82vw;' +
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

  let editing = false;
  let editBar = null;
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
    // 零尺寸锚点（手机端技能弧的圆形容器没有面积）没有矩形可判，只要圆心在屏幕内就算可见
    if (r.width === 0 || r.height === 0) {
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      return cx >= MARGIN && cy >= MARGIN && cx <= vw - MARGIN && cy <= vh - MARGIN;
    }
    return r.width > 0 && r.height > 0
      && r.left >= MARGIN - 1 && r.top >= MARGIN - 1
      && r.right <= vw - MARGIN + 1 && r.bottom <= vh - MARGIN + 1;
  }

  const MIN_HANDLE = 46; // 把手最小边长：零尺寸控件（技能弧圆心）也要有能抓住的一块

  // 把手跟随元素矩形（始终以元素中心对齐）；同时刷新「可见/超界」徽标
  function syncOne(rec) {
    const r = rec.el.getBoundingClientRect();
    const w = Math.max(MIN_HANDLE, r.width);
    const h = Math.max(MIN_HANDLE, r.height);
    rec.h.style.left = (r.left + r.width / 2 - w / 2) + 'px';
    rec.h.style.top = (r.top + r.height / 2 - h / 2) + 'px';
    rec.h.style.width = w + 'px';
    rec.h.style.height = h + 'px';
    const ok = visibleOf(rec.el);
    rec.ok = ok;
    rec.tag.textContent = rec.it.label + (ok ? ' 可见' : ' 超出屏幕');
    // 绿/红直接取主题的成功色与危险色（提示文案说的「红色表示超出屏幕」依然成立）
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

  function buildEditBar() {
    const bar = document.createElement('div');
    bar.className = 'ml-edit-bar';
    const tip = document.createElement('span');
    tip.textContent = '拖动黄色把手摆放按键；红色表示超出屏幕';
    const done = document.createElement('button');
    done.type = 'button';
    done.className = 'kui-btn kui-btn--primary';
    done.style.cssText = 'flex:0 0 auto;font:inherit;padding:4px 12px;';
    done.textContent = '完成';
    done.addEventListener('click', () => exit());
    bar.appendChild(tip);
    bar.appendChild(done);
    // 顶栏本身别把手指动作漏给游戏（右侧视角拖动区覆盖整个右半屏）
    bar.addEventListener('pointerdown', (e) => e.stopPropagation());
    document.body.appendChild(bar);
    return bar;
  }

  function enter() {
    if (editing) return;
    editing = true;
    setLayoutPaused(true); // 编辑期间暂停自动重排，避免拖到一半被挪走
    editBar = buildEditBar();
    buildHandles();
    toast('拖动黄色把手摆放按键；红色表示超出屏幕');
  }

  function exit() {
    if (!editing) return;
    editing = false;
    setLayoutPaused(false);
    if (editBar) { editBar.remove(); editBar = null; }
    for (const rec of handles) {
      rec.h.remove();
      if (rec.hidden) rec.el.style.display = 'none'; // 只还原显示状态，不动位置
    }
    handles.length = 0;
    relayout(); // 退出时补跑一次重排
  }

  // 检查：只读，不改动任何锚点（旧实现会 enter() 从而把自适应锚点改写成 px）
  function check() {
    const rows = [];
    for (const it of LAYOUT_ITEMS) {
      const el = document.querySelector(it.sel);
      if (!el) continue;
      const shown = getComputedStyle(el).display !== 'none';
      if (shown && !visibleOf(el)) rows.push(it.label);
    }
    if (editing) syncAll();
    toast(rows.length ? ('超出屏幕：' + rows.join('、')) : '全部控件都在可见范围内');
  }

  function reset() {
    if (editing) exit();
    resetLayout();
    toast('布局已重置为默认位置');
  }

  // 视口变化（旋转 / 地址栏收起 / 键盘）→ 重排；编辑中只刷新把手
  installViewportWatcher(() => {
    if (editing) syncAll();
  });

  // 启动时先按当前方向摆一次
  applyLayout(currentMode());

  return {
    isEditing: () => editing,
    enter,
    exit,
    // 设置面板的「调整位置」用它进/出编辑模式，返回值告诉调用方当前是否在编辑
    toggleEdit: () => { if (editing) exit(); else enter(); return editing; },
    check,
    reset,
  };
}
