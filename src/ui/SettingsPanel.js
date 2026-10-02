// 职责：统一的「画面设置」浮层，编辑器与游戏共用。
// 可调项：环境光强度、阳光强度、阳光角度、视距、阴影覆盖范围、阴影贴图分辨率、阴影总开关。
// 所有值持久化到 localStorage，改动即时生效；「恢复默认」一键还原。
// 绑定方式：调用方传入 binds，形如 { ambient, sun, sunElev, sunAz, viewFar, shadowR, shadowSize, castShadow }，
// 每项是一个 (value) => void 的 setter，面板在初始化、改动、恢复默认时都会调用对应 setter 立即应用。
// 编辑器写入的「光照设计」（环境光/阳光强度、阳光角度）会保存到设计键，客户端读取并应用同一份。
import { ensureTheme } from './theme.js';

export const DEFAULT_SETTINGS = {
  ambient: 0.32, // 环境光强度（压暗底色，拉开明暗对比）—— 编辑器中可调，会保存给客户端
  hemi: 0.5, // 半球光强度（模拟弹射光，给室内补明暗层次）—— 编辑器中可调，会保存给客户端
  sun: 1.4, // 阳光强度（提亮受光面）—— 编辑器中可调，会保存给客户端
  sunElev: 48, // 阳光高度角（°）—— 编辑器中可调，会保存给客户端
  sunAz: 56, // 阳光方位角（°）—— 编辑器中可调，会保存给客户端
  viewFar: 500, // 视距（相机远裁剪面 / 绘制距离）—— 客户端本地可调
  shadowR: 42, // 阴影覆盖半宽（以 sunTarget 为中心）
  shadowSize: 2048, // 阴影贴图边长（画质档会按档位覆盖此值）
  castShadow: true, // 阴影总开关
  quality: 'mid', // 画质档：high / mid / low（聚合控制阴影分辨率、dpr 封顶、阴影类型）
  nameTag: true, // 是否显示玩家头顶名牌（仅客户端本地生效）
  dayNight: true, // 是否开启昼夜循环
  dayCycle: 240, // 一昼夜时长（秒），越大变化越慢
  bgmVolume: 0.25, // 背景音乐音量（0 = 静音），默认就很小声
  dayOffset: 0, // 本地时刻偏移（小时）：只在本地预览用，不影响服务器权威时间
};

const STORE_KEY = 'scene-settings-v1'; // 编辑器「光照设计」键：客户端也读取此键应用光照
const GAME_STORE_KEY = 'scene-settings-game-v1'; // 客户端图形设置键（视距/阴影本地可调）

export function loadSettings(storeKey = STORE_KEY) {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(storeKey) || '{}') || {};
  } catch {
    saved = {};
  }
  return { ...DEFAULT_SETTINGS, ...saved };
}

export function saveSettings(s, storeKey = STORE_KEY) {
  try {
    localStorage.setItem(storeKey, JSON.stringify(s));
  } catch {
    /* 忽略存储失败 */
  }
}

// 由高度角/方位角换算出阳光相对 sunTarget 的偏移向量，保持 y 向上的球面分布。
// 编辑器改角度时用它重算偏移，客户端加载时用它把方向还原成设计师调好的样子。
const SUN_DIST = 53.85;
export function computeSunOffset(elev, az, dist = SUN_DIST) {
  const e = (elev * Math.PI) / 180;
  const a = (az * Math.PI) / 180;
  return {
    x: dist * Math.cos(e) * Math.sin(a),
    y: dist * Math.sin(e),
    z: dist * Math.cos(e) * Math.cos(a),
  };
}

const FIELDS = [
  { id: 'ambient', label: '环境光强度', kind: 'range', min: 0, max: 1, step: 0.01, editorOnly: true },
  { id: 'hemi', label: '半球光(弹射)强度', kind: 'range', min: 0, max: 1, step: 0.01, editorOnly: true },
  { id: 'sun', label: '阳光强度', kind: 'range', min: 0, max: 3, step: 0.05, editorOnly: true },
  { id: 'sunElev', label: '阳光高度角', kind: 'range', min: 0, max: 90, step: 1, editorOnly: true },
  { id: 'sunAz', label: '阳光方位角', kind: 'range', min: 0, max: 360, step: 1, editorOnly: true },
  { id: 'quality', label: '画质（聚合）', kind: 'select', options: ['low', 'mid', 'high'], gameOnly: true },
  { id: 'viewFar', label: '视距', kind: 'range', min: 200, max: 1000, step: 10 },
  { id: 'shadowR', label: '阴影范围', kind: 'range', min: 15, max: 120, step: 1 },
  {
    id: 'shadowSize',
    label: '阴影贴图分辨率',
    kind: 'select',
    options: ['512', '1024', '2048', '4096'],
  },
  { id: 'castShadow', label: '阴影开关', kind: 'toggle', defaultValue: true },
  { id: 'nameTag', label: '显示名牌与血条', kind: 'toggle', defaultValue: true },
  { id: 'dayNight', label: '昼夜循环', kind: 'toggle', defaultValue: true },
  { id: 'dayCycle', label: '一昼夜时长(秒)', kind: 'range', min: 60, max: 1200, step: 20 },
  { id: 'bgmVolume', label: '背景音乐音量(0=静音)', kind: 'range', min: 0, max: 1, step: 0.05 },
  { id: 'dayOffset', label: '本地时刻偏移(时)', kind: 'range', min: -12, max: 12, step: 1 },
];

function fmt(v) {
  if (Number.isInteger(v)) return String(v);
  return Number(v).toFixed(2);
}

// createSettingsPanel(binds)：
//   binds = { [FieldId]: (value) => void }
// 返回 { open, close, toggle, isOpen, root, get(), setLayoutActions() }。
// open/close/toggle 控制显隐；get() 返回当前设置对象；setLayoutActions 注入手机端布局动作。
// opts：
//   · storeKey —— 指定独立的持久化键
//   · fields   —— 限制只渲染哪些设置项
//   · modal    —— true 时是居中弹窗（游戏端）；默认 false 仍是右上浮层（编辑器要边调边看场景）
//   · title    —— 面板标题，默认「画面设置」
export function createSettingsPanel(binds, opts = {}) {
  ensureTheme();
  const storeKey = opts.storeKey || STORE_KEY;
  const include = Array.isArray(opts.fields) ? opts.fields : null;
  const isGame = storeKey === GAME_STORE_KEY;
  const modal = !!opts.modal;
  const title = opts.title || '画面设置';
  // 游戏端只渲染 include 指定的项；编辑器（默认）则排除 editorOnly 与 gameOnly 项，
  // 避免「画质」这种仅客户端生效的聚合项出现在编辑器里（编辑器没传对应 bind）
  const fields = include
    ? FIELDS.filter((f) => include.includes(f.id))
    : FIELDS.filter((f) => !f.editorOnly && (!f.gameOnly || isGame));

  const loaded = loadSettings(storeKey);
  const settings = {};
  for (const f of fields) {
    settings[f.id] = typeof loaded[f.id] !== 'undefined' ? loaded[f.id] : DEFAULT_SETTINGS[f.id];
  }

  const root = document.createElement('div');
  root.className = 'gx-win' + (modal ? ' gx-win--modal' : '') + ' hidden';
  // 两种形态共用一个 root：
  //   · modal（游戏端）：root 是全屏遮罩，卡片居中；点遮罩空白处或按 Esc 关闭
  //   · 浮层（编辑器，默认）：root 自己定位在右上角并滚动，方便边调参数边看场景
  root.style.cssText = modal
    ? 'position:fixed;inset:0;z-index:9999;display:none;box-sizing:border-box;' +
      'background:rgba(11,21,34,.5);align-items:center;justify-content:center;padding:16px;'
    : 'position:fixed;z-index:9999;display:none;' +
      'right:calc(env(safe-area-inset-right, 0px) + 12px);' +
      'top:calc(env(safe-area-inset-top, 0px) + 56px);' +
      'width:min(280px, calc(100vw - 24px));' +
      'max-height:calc(var(--app-vh, 100vh) - 76px);' +
      'overflow-y:auto;-webkit-overflow-scrolling:touch;';

  // 卡片：modal 时自己滚动（遮罩只负责居中，内容再长也不会顶出屏幕）
  const card = document.createElement('div');
  card.className = 'kui-panel gx-card';
  if (modal) {
    card.style.cssText =
      'width:min(340px, 100%);max-height:calc(var(--app-vh, 100vh) - 32px);' +
      'overflow-y:auto;-webkit-overflow-scrolling:touch;';
  }
  root.appendChild(card);

  const head = document.createElement('div');
  head.className = 'kui-panel__body gx-win-head';
  head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;';
  head.innerHTML =
    '<b class="kui-title"></b>' +
    '<button class="gx-win-close kui-iconbtn" type="button">&times;</button>';
  head.querySelector('.kui-title').textContent = title;
  card.appendChild(head);

  const body = document.createElement('div');
  body.className = 'kui-panel__body';
  card.appendChild(body);

  const inputs = {};
  const valueEls = {};

  const applyOne = (id, value) => {
    const fn = binds[id];
    if (fn) fn(value);
  };

  const renderValue = (id) => {
    const el = valueEls[id];
    if (el) el.textContent = fmt(settings[id]);
  };

  for (const f of fields) {
    const row = document.createElement('div');
    row.className = 'gx-field';
    row.style.cssText = 'margin:8px 0;';
    if (f.kind === 'range') {
      row.innerHTML = `<div class="gx-lbl kui-row"><span>${f.label}</span><b class="gx-val kui-num"></b></div>`;
      valueEls[f.id] = row.querySelector('.gx-val');
      const input = document.createElement('input');
      input.type = 'range';
      input.min = f.min;
      input.max = f.max;
      input.step = f.step;
      input.value = settings[f.id];
      input.style.cssText = 'width:100%;accent-color:var(--kui-blue);';
      input.addEventListener('input', () => {
        settings[f.id] = parseFloat(input.value);
        renderValue(f.id);
        applyOne(f.id, settings[f.id]);
        saveSettings(settings, storeKey);
      });
      row.appendChild(input);
      inputs[f.id] = input;
    } else if (f.kind === 'select') {
      row.innerHTML = `<div class="gx-lbl kui-row"><span>${f.label}</span></div>`;
      const select = document.createElement('select');
      for (const o of f.options) {
        const opt = document.createElement('option');
        opt.value = o;
        opt.textContent = o;
        select.appendChild(opt);
      }
      select.value = String(settings[f.id]);
      select.style.cssText =
        'width:100%;background:var(--kui-paper);color:var(--kui-ink);' +
        'border:2px solid var(--kui-blue-dark);border-radius:10px;padding:3px 6px;font-family:var(--kui-font);';
      select.addEventListener('change', () => {
        settings[f.id] = parseFloat(select.value);
        applyOne(f.id, settings[f.id]);
        saveSettings(settings, storeKey);
      });
      row.appendChild(select);
      inputs[f.id] = select;
    } else if (f.kind === 'toggle') {
      row.className += ' gx-toggle';
      row.style.cssText += 'display:flex;align-items:center;justify-content:space-between;color:var(--kui-ink-soft);';
      const lab = document.createElement('span');
      lab.textContent = f.label;
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!settings[f.id];
      cb.style.cssText = 'accent-color:var(--kui-blue);';
      cb.addEventListener('change', () => {
        settings[f.id] = cb.checked;
        applyOne(f.id, settings[f.id]);
        saveSettings(settings, storeKey);
      });
      row.appendChild(lab);
      row.appendChild(cb);
      inputs[f.id] = cb;
    }
    body.appendChild(row);
  }

  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'gx-reset kui-btn kui-btn--primary';
  reset.style.cssText = 'width:100%;margin-top:12px;';
  reset.textContent = '恢复默认';
  reset.addEventListener('click', () => {
    for (const f of fields) settings[f.id] = DEFAULT_SETTINGS[f.id];
    // 同步控件显示
    for (const f of fields) {
      if (f.kind === 'range') {
        inputs[f.id].value = settings[f.id];
        renderValue(f.id);
      } else if (f.kind === 'select') {
        inputs[f.id].value = String(settings[f.id]);
      } else if (f.kind === 'toggle') {
        inputs[f.id].checked = !!settings[f.id];
      }
      applyOne(f.id, settings[f.id]);
    }
    saveSettings(settings, storeKey);
  });
  body.appendChild(reset);

  // ---- 「画面元素」区块（手机端）：拖拽摆放跳跃键 / 技能槽 / 血条 / 对话选项卡 ----
  // 面板本身不认识布局模块，动作由 main.js 在 initMobileLayout() 之后注入；
  // 没注入（桌面端 / 编辑器）就整块不显示，不会留下点了没反应的按钮。
  const layoutBox = document.createElement('div');
  layoutBox.className = 'kui-panel__body gx-layout';
  layoutBox.style.cssText =
    'display:none;border-top:1px solid var(--kui-blue-soft);margin-top:12px;padding-top:10px;';
  layoutBox.innerHTML =
    '<div class="gx-lbl" style="font-weight:600;margin-bottom:8px;">画面元素（手机）</div>' +
    '<div class="gx-layout-actions" style="display:flex;gap:6px;flex-wrap:wrap;"></div>' +
    '<div style="margin-top:8px;font-size:11px;line-height:1.6;color:var(--kui-ink-soft);">' +
    '可拖拽摆放跳跃键、技能槽、血条、对话选项卡；横竖屏各存一套位置。' +
    '</div>';
  card.appendChild(layoutBox);

  const actionsEl = layoutBox.querySelector('.gx-layout-actions');
  const mkLayoutBtn = (text, cls) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'kui-btn ' + cls;
    b.style.cssText = 'flex:1 1 auto;min-width:84px;font:inherit;';
    b.textContent = text;
    actionsEl.appendChild(b);
    return b;
  };
  const btnAdjust = mkLayoutBtn('调整位置', 'kui-btn--primary');
  const btnCheck = mkLayoutBtn('检查', 'kui-btn--grey');
  const btnReset = mkLayoutBtn('重置位置', 'kui-btn--grey');

  let layoutActions = null; // { onAdjust, onCheck, onReset }，由 main.js 注入

  // 「调整位置」先收起面板再进拖拽模式：不然这个弹窗正好盖住要摆的那几个控件
  btnAdjust.addEventListener('click', () => {
    if (!layoutActions) return;
    close();
    layoutActions.onAdjust();
  });
  btnCheck.addEventListener('click', () => { if (layoutActions) layoutActions.onCheck(); });
  btnReset.addEventListener('click', () => { if (layoutActions) layoutActions.onReset(); });

  function setLayoutActions(api) {
    layoutActions = api || null;
    layoutBox.style.display = layoutActions ? '' : 'none';
  }

  // ---- 显隐 ----
  // modal 要用 flex 才能居中；非 modal 回到默认块级（root 自己定位 + 滚动）
  function open() {
    root.classList.remove('hidden');
    root.style.display = modal ? 'flex' : 'block';
  }
  function close() {
    root.classList.add('hidden');
    root.style.display = 'none';
  }
  const isOpen = () => !root.classList.contains('hidden');

  root.querySelector('.gx-win-close').addEventListener('click', close);

  if (modal) {
    // 点遮罩空白处关闭；同时掐断冒泡，别让这一下穿透到游戏（会触发指针锁定）
    root.addEventListener('pointerdown', (e) => e.stopPropagation());
    root.addEventListener('click', (e) => { if (e.target === root) close(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen()) close();
    });
  }

  document.body.appendChild(root);

  // 初始化时应用已保存的设置
  for (const id of Object.keys(settings)) applyOne(id, settings[id]);

  return {
    root,
    get: () => ({ ...settings }),
    open,
    close,
    isOpen,
    setLayoutActions,
    toggle: () => { if (isOpen()) close(); else open(); },
  };
}

// 齿轮图标（描边 SVG，不用 emoji）
const GEAR_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <circle cx="12" cy="12" r="3"/>
  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
</svg>`;

// createSettingsButton({ text, panel, position, icon })：生成悬浮按钮，点击切换面板显隐。
//   position：{ left?, right?, top?, bottom?, centerY? }，给 centerY 时以 top 为中线垂直居中。
//   icon：true 时渲染齿轮图标（圆形按钮），false 时渲染文字。
export function createSettingsButton({ text = '画面', panel, position = { left: 16, bottom: 16 }, icon = false }) {
  ensureTheme();
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = icon ? 'gx-fab gx-fab-icon kui-iconbtn' : 'gx-fab kui-btn kui-btn--primary';
  btn.style.position = 'fixed';
  btn.style.zIndex = '9000';
  if (icon) btn.innerHTML = GEAR_SVG;
  else btn.textContent = text;
  btn.title = '画面设置';
  for (const side of ['left', 'right', 'top', 'bottom']) {
    const v = position[side];
    if (typeof v === 'number') btn.style[side] = `${v}px`;
    else if (typeof v === 'string') btn.style[side] = v; // 允许 "50%" 这类百分比定位
  }
  if (position.centerY) btn.style.transform = 'translateY(-50%)';
  btn.addEventListener('click', () => panel.toggle());
  document.body.appendChild(btn);
  return btn;
}
