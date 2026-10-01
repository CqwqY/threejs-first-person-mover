// 职责：手机端按键布局的「自适应 + 自定义 + 位置检查」。
// - 自适应：用 clamp()/安全区统一收口触屏控件尺寸，小屏不挤、大屏不空，并避开刘海与手势条。
// - 自定义：点「调整」进入编辑模式，每个可动控件上浮出一个黄色拖拽把手，拖到任意位置；
//   位置按本机保存在 localStorage（不随账号走），下次进入自动恢复。
// - 位置检查：编辑模式下逐个判定控件是否完整落在可见区，越界把手标红，并给出汇总提示。
const STORE_KEY = 'fp_mobile_layout_v2';
const MARGIN = 4; // 允许贴边的最小留白（px）

// 可自由摆放的控件：key 为存储键，sel 为 CSS 选择器，label 用于提示；
// showAs 是编辑期间「被隐藏的控件」临时显示用的 display 值（退出编辑时还原）
export const LAYOUT_ITEMS = [
  { key: 'jump', sel: '.mc-jump', label: '跳跃键', showAs: 'flex' },
  { key: 'skill', sel: '.sk-box', label: '技能槽', showAs: 'flex' },
  { key: 'health', sel: '.hp-box', label: '血条', showAs: 'block' },
  { key: 'chat', sel: '.chat-tab', label: '对话选项卡', showAs: 'block' },
];

function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch (e) { return {}; }
}
function save(m) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(m)); } catch (e) { /* 存储不可用：仅本次会话有效 */ }
}

// 把元素从 right/bottom 锚点改写成 left/top，便于自由摆放
function anchorToTopLeft(el) {
  const r = el.getBoundingClientRect();
  el.style.left = r.left + 'px';
  el.style.top = r.top + 'px';
  el.style.right = 'auto';
  el.style.bottom = 'auto';
  el.style.transform = 'none';
}

// 应用上次保存的位置
function applySaved(map) {
  for (const it of LAYOUT_ITEMS) {
    const pos = map[it.key];
    if (!pos) continue;
    const el = document.querySelector(it.sel);
    if (!el) continue;
    el.style.left = pos.left + 'px';
    el.style.top = pos.top + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    el.style.transform = 'none';
  }
}

// 把位置夹在屏幕内，保证不会拖出可视区
function clampPos(left, top, w, h) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return {
    left: Math.max(MARGIN, Math.min(vw - w - MARGIN, left)),
    top: Math.max(MARGIN, Math.min(vh - h - MARGIN, top)),
  };
}

// 控件是否完整落在可见区内
function visibleOf(el) {
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return r.width > 0 && r.height > 0
    && r.left >= MARGIN - 1 && r.top >= MARGIN - 1
    && r.right <= vw - MARGIN + 1 && r.bottom <= vh - MARGIN + 1;
}

export function initMobileLayout() {
  const coarse =
    (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
    'ontouchstart' in window;
  if (!coarse) return;

  // ---- 自适应样式：尺寸随屏幕缩放 + 适配安全区 ----
  const style = document.createElement('style');
  style.textContent = `
    .mc-jump{width:clamp(56px,15vw,78px);height:clamp(56px,15vw,78px);
      font-size:clamp(13px,3.6vw,16px);bottom:calc(env(safe-area-inset-bottom,0px) + 20px)}
    .mc-joy{width:clamp(92px,27vw,124px);height:clamp(92px,27vw,124px)}
    .mc-knob{width:clamp(42px,11vw,56px);height:clamp(42px,11vw,56px)}
    .ml-bar{position:fixed;left:8px;top:50%;transform:translateY(-50%);z-index:80;display:flex;
      flex-direction:column;gap:6px;user-select:none;-webkit-user-select:none;
      font:12px/1.2 system-ui,"Microsoft YaHei",sans-serif}
    .ml-btn{background:rgba(10,16,26,.72);color:#fff;border:1px solid rgba(255,255,255,.3);
      border-radius:8px;padding:7px 10px;cursor:pointer;text-align:center;touch-action:none;
      user-select:none;-webkit-user-select:none}
    .ml-btn.on{background:#2e7ddd;border-color:#8fc3ff}
    .ml-handle{position:fixed;z-index:81;border:2px dashed #ffd479;border-radius:10px;
      box-sizing:border-box;background:rgba(255,212,121,.10);touch-action:none;cursor:move}
    .ml-tag{position:absolute;left:0;top:-20px;font:11px/1.4 system-ui,"Microsoft YaHei",sans-serif;
      padding:1px 6px;border-radius:6px;color:#fff;white-space:nowrap}
  `;
  document.head.appendChild(style);

  applySaved(load());

  // ---- 简易提示气泡（不依赖 Game 的 toast）----
  let toastEl = null;
  let toastTimer = 0;
  function toast(text) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText =
        'position:fixed;left:50%;top:12%;transform:translateX(-50%);z-index:82;max-width:82vw;' +
        'background:rgba(10,16,26,.88);color:#fff;padding:8px 14px;border-radius:10px;' +
        'font:12px/1.5 system-ui,"Microsoft YaHei",sans-serif;pointer-events:none;text-align:center;';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.style.display = 'none'; }, 2600);
  }

  // ---- 编辑条：调整 / 检查 ----
  const bar = document.createElement('div');
  bar.className = 'ml-bar';
  const toggle = document.createElement('div');
  toggle.className = 'ml-btn';
  toggle.textContent = '调整';
  const check = document.createElement('div');
  check.className = 'ml-btn';
  check.textContent = '检查';
  bar.appendChild(toggle);
  bar.appendChild(check);
  document.body.appendChild(bar);

  let editing = false;
  const handles = [];

  // 某控件当前的位置/可见性同步到把手上
  function syncOne(rec) {
    const r = rec.el.getBoundingClientRect();
    rec.h.style.left = r.left + 'px';
    rec.h.style.top = r.top + 'px';
    rec.h.style.width = r.width + 'px';
    rec.h.style.height = r.height + 'px';
    const ok = visibleOf(rec.el);
    rec.ok = ok;
    rec.tag.textContent = rec.it.label + (ok ? ' 可见' : ' 超出屏幕');
    rec.tag.style.background = ok ? '#2ecc71' : '#e74c3c';
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
      const map = load();
      const left = Math.round(parseFloat(rec.el.style.left));
      const top = Math.round(parseFloat(rec.el.style.top));
      if (Number.isFinite(left) && Number.isFinite(top)) map[rec.it.key] = { left, top };
      save(map);
      syncOne(rec);
    };
    rec.h.addEventListener('pointerup', end);
    rec.h.addEventListener('pointercancel', end);
  }

  function buildHandles() {
    for (const it of LAYOUT_ITEMS) {
      const el = document.querySelector(it.sel);
      if (!el) continue;
      // 编辑期间把「平时隐藏」的控件临时显示出来，否则没法摆放（退出时还原）
      const hidden = getComputedStyle(el).display === 'none';
      if (hidden) el.style.display = it.showAs || 'block';
      anchorToTopLeft(el);
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
    toggle.classList.add('on');
    toggle.textContent = '完成';
    buildHandles();
    toast('拖动黄色把手摆放按键；红色表示超出屏幕');
  }

  function exit() {
    editing = false;
    toggle.classList.remove('on');
    toggle.textContent = '调整';
    for (const rec of handles) {
      rec.h.remove();
      if (rec.hidden) rec.el.style.display = 'none'; // 还原原本隐藏的控件
    }
    handles.length = 0;
  }

  // 同样按下即响应：多点触控下（另一只手推着摇杆）click 可能不派发
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  toggle.addEventListener('pointerdown', (e) => {
    stop(e);
    if (editing) exit(); else enter();
  });
  check.addEventListener('pointerdown', (e) => {
    stop(e);
    if (!editing) enter();
    syncAll();
    const bad = handles.filter((r) => !r.ok).map((r) => r.it.label);
    toast(bad.length
      ? ('有 ' + bad.length + ' 个控件超出屏幕：' + bad.join('、'))
      : '全部控件都在屏幕可见范围内');
  });

  window.addEventListener('resize', () => { if (editing) syncAll(); });
}
