// 职责：统一的「画面设置」浮层，编辑器与游戏共用。
// 可调项：环境光强度、阳光强度、阳光角度、视距、阴影覆盖范围、阴影贴图分辨率、阴影总开关。
// 所有值持久化到 localStorage。
// 绑定方式：调用方传入 binds，形如 { ambient, sun, sunElev, sunAz, viewFar, shadowR, shadowSize, castShadow }，
// 每项是一个 (value) => void 的 setter，面板在初始化、点「应用设置」、恢复默认时都会调用对应 setter。
// 编辑器写入的「光照设计」（环境光/阳光强度、阳光角度）会保存到设计键，客户端读取并应用同一份。
//
// ⚠ 改动模型（2026-10-04）：所有控件**先写入暂存草稿（_draft），不再即时生效**；
//   只有点「应用设置」才把草稿提交并保存 + 调用 binds；「恢复默认」立即提交默认。
//   这样改一堆设置可以一次生效，也避免「改到一半切出去」把半成品写进存储。
//   外部（如 HUD 按钮）想立即改某项，调 setField(id, value)（立即提交 + 同步控件）。
import { ensureTheme } from './theme.js';
import { createKeyHints } from './KeyHints.js';

export const DEFAULT_SETTINGS = {
  ambient: 0.22, // 环境光强度（压暗底色，拉开明暗对比）—— 编辑器中可调，会保存给客户端
  hemi: 0.34, // 半球光强度（模拟弹射光，给室内补明暗层次）—— 编辑器中可调，会保存给客户端
  sun: 2.5, // 阳光强度（提亮受光面）—— 编辑器中可调，会保存给客户端。之前场景整体亮靠环境光撑的 IBL，关掉后只剩太阳照亮受光面，故默认与上限都抬高（max=8）
  sunElev: 48, // 阳光高度角（°）—— 编辑器中可调，会保存给客户端
  sunAz: 56, // 阳光方位角（°）—— 编辑器中可调，会保存给客户端
  viewFar: 500, // 视距（相机远裁剪面 / 绘制距离）—— 客户端本地可调
  shadowR: 42, // 阴影覆盖半宽（以 sunTarget 为中心）
  shadowSize: 2048, // 阴影贴图边长（画质档会按档位覆盖此值）
  // 阴影总开关。⚠ 默认**关闭**：实测（fpm-perf）确认本项目的唯一瓶颈是填充率，
  //   关阴影能直接省掉一整趟全场景投影 + 主 pass 里每像素的阴影采样与 IBL 之外的额外开销。
  //   想要阴影的人在设置里打开即可（打开后即时生效，见 Game 的 castShadow 绑定）。
  castShadow: false, // 阴影总开关
  quality: 'mid', // 画质档：high / mid / low（聚合控制阴影分辨率、dpr 封顶、阴影类型）
  renderScale: 'auto', // 渲染分辨率：auto=自适应；'85'/'70' 等 = 钉死为该百分比（弱卡兜底）
  sharpen: 0.5, // 超分锐化强度：0=关；降分辨率后靠它找回清晰度（过大反而显锯齿）
  // 初值跟随已有的 MSAA 标记：之前因为选过低画质档而关掉 AA 的人，不会在这里被悄悄打开
  antiAlias:
    typeof localStorage !== 'undefined' && localStorage.getItem('fpm-noaa') === '1' ? 'off' : 'on',
  nameTag: true, // 是否显示玩家头顶名牌（仅客户端本地生效）
  showFps: true, // 右上角常驻帧数角标（默认开；关掉即隐藏，不影响玩法）
  skillLayout: '轮盘', // 手机技能槽排布：轮盘 / 2行竖列（PC 无影响）
  rideView: '视角操控', // 骑车视角：视角操控（自由视角，鼠标可左右掰头看）/ 锁视角（相机恒在车后）
  dayNight: true, // 是否开启昼夜循环
  dayCycle: 600, // 一昼夜时长（秒，默认 10 分钟），越大变化越慢
  bgmVolume: 0.25, // 背景音乐音量（0 = 静音），默认就很小声
  dayOffset: 0, // 本地时刻偏移（小时）：只在本地预览用，不影响服务器权威时间
  exposure: 0.85, // 整体曝光（ACES 色调映射）：太亮就往下调；高光不再硬 clip 成死白
  version: 2, // 光照默认值（ambient/hemi/sun）曾整体调暗，升版本号时清掉旧存档里的高值，落回新默认
};

const STORE_KEY = 'scene-settings-v1'; // 编辑器「光照设计」键：客户端也读取此键应用光照
const GAME_STORE_KEY = 'scene-settings-game-v1'; // 客户端图形设置键（视距/阴影本地可调）

// 「同一套默认值、两种场景」的例外表（按存储键覆盖 DEFAULT_SETTINGS）：
//   编辑器是**光照设计工具** —— 没阴影就没得调，烘焙也烘不出东西 ⇒ 编辑器侧必须默认开。
//   游戏端默认关（填充率是实测出来的唯一瓶颈）。两边各写各的键，互不干扰。
const STORE_KEY_DEFAULTS = {
  [STORE_KEY]: { castShadow: true },
};

export function defaultsFor(storeKey) {
  const ov = STORE_KEY_DEFAULTS[storeKey];
  return ov ? { ...DEFAULT_SETTINGS, ...ov } : DEFAULT_SETTINGS;
}

export function loadSettings(storeKey = STORE_KEY) {
  const BASE = defaultsFor(storeKey);
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(storeKey) || '{}') || {};
  } catch {
    saved = {};
  }
  // 版本迁移：光照默认值（ambient/hemi/sun）曾整体调暗。老存档里存着旧的更亮默认值，
  // 会因 `{ ...DEFAULT, ...saved }` 把新默认值盖掉 —— 表现为"明明改了默认却还是老亮"。
  // 升到新 version 时清掉这三项，让用户落回更暗的新默认；用户之后自己调的值不受版本号影响（不再触发）。
  if (Number(saved.version) !== DEFAULT_SETTINGS.version) {
    delete saved.ambient;
    delete saved.hemi;
    delete saved.sun;
    if (typeof localStorage !== 'undefined') {
      try {
        saved.version = DEFAULT_SETTINGS.version;
        localStorage.setItem(storeKey, JSON.stringify({ ...BASE, ...saved }));
      } catch {
        /* 忽略存储失败 */
      }
    }
  }
  // 一次性迁移：一昼夜默认时长由 240 秒（4 分钟）放慢到 600 秒（10 分钟）。
  // ⚠ 光改默认值是**没用的** —— 老用户 localStorage 里已经存着 240，会一直盖住默认值。
  //   所以这里显式抬一次，并用标记保证只做一次（此后用户自己调成多少都尊重）。
  if (storeKey === GAME_STORE_KEY && typeof localStorage !== 'undefined') {
    try {
      if (localStorage.getItem('fpm-daycycle-600') !== '1') {
        localStorage.setItem('fpm-daycycle-600', '1');
        if (Number(saved.dayCycle) === 240) {
          saved.dayCycle = DEFAULT_SETTINGS.dayCycle;
          saveSettings({ ...BASE, ...saved }, GAME_STORE_KEY);
        }
      }
    } catch {
      /* 忽略存储失败 */
    }
  }
  // 一次性迁移：阴影总开关默认值由「开」改为「关」（实测填充率是唯一瓶颈，阴影是最贵的一趟）。
  // ⚠ 和 dayCycle 同一个坑：老用户 localStorage 里已经存着 true，`{...DEFAULT, ...saved}` 会一直
  //   盖住新默认值 ⇒ 光改 DEFAULT_SETTINGS 是没用的，必须显式抬一次。
  //   用标记保证只做一次 —— 之后用户自己在设置里打开，不会再被我们悄悄关回去。
  if (storeKey === GAME_STORE_KEY && typeof localStorage !== 'undefined') {
    try {
      if (localStorage.getItem('fpm-shadow-off-1') !== '1') {
        localStorage.setItem('fpm-shadow-off-1', '1');
        if (saved.castShadow === true) {
          saved.castShadow = false;
          saveSettings({ ...BASE, ...saved }, GAME_STORE_KEY);
        }
      }
    } catch {
      /* 忽略存储失败 */
    }
  }
  return { ...BASE, ...saved };
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

// 设置项按「卡片」分组（仅展示分组，不影响取值/存储）。顺序即展示顺序。
const GROUPS = ['画质', '视野与阴影', '显示', '时间与声音', '缓存', '光照'];

const FIELDS = [
  { id: 'quality', label: '画质（聚合）', kind: 'select', options: ['low', 'mid', 'high'], group: '画质', gameOnly: true },
  // 渲染分辨率：auto=自适应（掉帧自动降、富余自动升）；其余为钉死的百分比。
  // 老卡/入门卡（如 GT 640）是真·填充率瓶颈，这一项比画质档更直接有效。
  { id: 'renderScale', label: '渲染分辨率(卡顿先降它)', kind: 'select', options: ['auto', '100', '85', '70', '60', '50'], group: '画质', gameOnly: true },
  // 降分辨率后画面会糊，靠这个锐化升采样找补回来（0=关，越大越锐利，过头有锯齿感）
  { id: 'sharpen', label: '超分锐化(配合降分辨率)', kind: 'range', min: 0, max: 1.5, step: 0.1, group: '画质', gameOnly: true },
  // 降分辨率时立即生效；满分辨率时是画布 MSAA，改完要刷新页面
  { id: 'antiAlias', label: '抗锯齿(刷新后生效)', kind: 'select', options: ['on', 'off'], group: '画质', gameOnly: true },
  { id: 'viewFar', label: '视距', kind: 'range', min: 200, max: 1000, step: 10, group: '视野与阴影' },
  { id: 'shadowR', label: '阴影范围', kind: 'range', min: 15, max: 120, step: 1, group: '视野与阴影' },
  {
    id: 'shadowSize',
    label: '阴影贴图分辨率',
    kind: 'select',
    options: ['512', '1024', '2048', '4096'],
    group: '视野与阴影',
  },
  { id: 'castShadow', label: '阴影开关(默认关·卡就别开)', kind: 'toggle', defaultValue: false, group: '视野与阴影' },
  { id: 'nameTag', label: '显示名牌与血条', kind: 'toggle', defaultValue: true, group: '显示' },
  { id: 'showFps', label: '显示帧数(FPS)', kind: 'toggle', defaultValue: true, group: '显示', gameOnly: true },
  // 手机端技能槽的两种排布：轮盘省地方但要点两下；网格一眼看见、点一下就用（仅触屏生效）
  { id: 'skillLayout', label: '手机技能槽', kind: 'select', options: ['轮盘', '2行竖列'], group: '显示', gameOnly: true },
  { id: 'rideView', label: '骑车视角', kind: 'select', options: ['视角操控', '锁视角'], group: '显示', gameOnly: true },
  { id: 'dayNight', label: '昼夜循环', kind: 'toggle', defaultValue: true, group: '时间与声音' },
  { id: 'dayCycle', label: '一昼夜时长(秒)', kind: 'range', min: 60, max: 1200, step: 20, group: '时间与声音' },
  { id: 'bgmVolume', label: '背景音乐音量(0=静音)', kind: 'range', min: 0, max: 1, step: 0.05, group: '时间与声音' },
  { id: 'dayOffset', label: '本地时刻偏移(时)', kind: 'range', min: -12, max: 12, step: 1, group: '时间与声音' },
  // 动作项：没有「值」可存，只在点的时候回调一次 binds[id]()（清缓存这类一次性动作）。
  // 它不进 settings，所以初始化与「恢复默认」都不会误触发。
  {
    id: 'assetCache',
    label: '清除模型缓存',
    kind: 'action',
    group: '缓存',
    gameOnly: true,
    hint: '模型/天空贴图下载一次就存在本机，之后不再重下；换了模型或想腾空间时清一下。',
  },
  // 数据采集：点一下会实时测帧率并把「加载耗时 + 渲染指标 + 设备信息」上报到服务器，
  // 供我们在桌面上复盘手机（尤其 iOS）的真实性能。采集约 20 秒，期间正常游玩即可。
  {
    id: 'telemetry',
    label: '数据采集（测帧率并上报）',
    kind: 'action',
    group: '缓存',
    gameOnly: true,
    hint: '点一下会持续约 20 秒测帧率、记录加载耗时与设备信息，然后上报给开发者（不含任何账号/隐私内容）。测完会有提示。',
  },
  // —— 以下 editorOnly：编辑器的「光照设计」，客户端不显示 ——
  { id: 'ambient', label: '环境光强度', kind: 'range', min: 0, max: 1, step: 0.01, group: '光照', editorOnly: true },
  { id: 'hemi', label: '半球光(弹射)强度', kind: 'range', min: 0, max: 1, step: 0.01, group: '光照', editorOnly: true },
  { id: 'sun', label: '阳光强度', kind: 'range', min: 0, max: 8, step: 0.1, group: '光照', editorOnly: true },
  { id: 'exposure', label: '整体曝光(太亮调低)', kind: 'range', min: 0.3, max: 1.5, step: 0.05, group: '光照', editorOnly: true },
  { id: 'sunElev', label: '阳光高度角', kind: 'range', min: 0, max: 90, step: 1, group: '光照', editorOnly: true },
  { id: 'sunAz', label: '阳光方位角', kind: 'range', min: 0, max: 360, step: 1, group: '光照', editorOnly: true },
];

function fmt(v) {
  if (Number.isInteger(v)) return String(v);
  return Number(v).toFixed(2);
}

// createSettingsPanel(binds)：
//   binds = { [FieldId]: (value) => void }
// 返回 { open, close, toggle, isOpen, root, get(), setField(), setLayoutActions() }。
// open/close/toggle 控制显隐；get() 返回当前「已提交」设置对象；setField 立即改某一项并保存；
// setLayoutActions 注入手机端布局动作。
// opts：
//   · storeKey —— 指定独立的持久化键
//   · fields   —— 限制只渲染哪些设置项
//   · modal    —— true 时是居中弹窗（游戏端）；默认 false 仍是右上浮层（编辑器要边调边看场景）
//   · title    —— 面板标题，默认「画面设置」
//   · coarsePointer —— 是否触屏设备（决定「操作说明」区块是否显示）
export function createSettingsPanel(binds, opts = {}) {
  ensureTheme();
  const storeKey = opts.storeKey || STORE_KEY;
  const include = Array.isArray(opts.fields) ? opts.fields : null;
  const isGame = storeKey === GAME_STORE_KEY;
  const modal = !!opts.modal;
  const title = opts.title || '画面设置';
  // liveApply：控件改动即时生效 + 保存（编辑器边调边看场景用）；游戏端默认 false（改完点「应用设置」才生效）。
  const liveApply = !!opts.liveApply;

  // 过滤出当前场景要展示的字段（保留顺序与 FIELDS 一致，但分组用 GROUPS 顺序渲染）
  const fields = include
    ? FIELDS.filter((f) => include.includes(f.id))
    : FIELDS.filter((f) => !f.editorOnly && (!f.gameOnly || isGame));

  // 本场景的默认值（编辑器/游戏端可能不同，见 STORE_KEY_DEFAULTS）
  const BASE = defaultsFor(storeKey);
  const loaded = loadSettings(storeKey);
  // settings = 已提交；draft = 暂存草稿（控件改的是它，点「应用设置」才合并进 settings）。
  const settings = {};
  const draft = {};
  for (const f of fields) {
    if (f.kind === 'action') continue; // 动作项没有值，别让它进设置对象（否则初始化时会误触发一次回调）
    settings[f.id] = typeof loaded[f.id] !== 'undefined' ? loaded[f.id] : BASE[f.id];
    draft[f.id] = settings[f.id];
  }

  const root = document.createElement('div');
  root.className = 'gx-win' + (modal ? ' gx-win--modal' : '') + ' hidden';
  root.style.cssText = modal
    ? 'position:fixed;inset:0;z-index:9999;display:none;box-sizing:border-box;' +
      'background:rgba(11,21,34,.5);align-items:center;justify-content:center;padding:16px;'
    : 'position:fixed;z-index:9999;display:none;' +
      'right:calc(env(safe-area-inset-right, 0px) + 12px);' +
      'top:calc(env(safe-area-inset-top, 0px) + 56px);' +
      'width:min(360px, calc(100vw - 24px));' +
      'max-height:calc(var(--app-vh, 100vh) - 76px);' +
      'overflow-y:auto;-webkit-overflow-scrolling:touch;';

  // 卡片：modal 时自己滚动（遮罩只负责居中，内容再长也不会顶出屏幕）
  const card = document.createElement('div');
  card.className = 'kui-panel gx-card';
  if (modal) {
    card.style.cssText =
      'width:min(560px, 100%);max-height:calc(var(--app-vh, 100vh) - 32px);' +
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

  const inputs = {};
  const valueEls = {};

  // 把「当前草稿值」写到某控件（初始化与「恢复默认」「外部 setField」都用）
  const syncControl = (f) => {
    const el = inputs[f.id];
    if (!el) return;
    if (f.kind === 'range') { el.value = draft[f.id]; renderValue(f.id); }
    else if (f.kind === 'select') { el.value = String(draft[f.id]); }
    else if (f.kind === 'toggle') { el.checked = !!draft[f.id]; }
  };

  const applyOne = (id, value) => {
    const fn = binds[id];
    if (fn) fn(value);
  };

  const renderValue = (id) => {
    const el = valueEls[id];
    if (el) el.textContent = fmt(draft[id]);
  };

  // 单个字段渲染成一行（range/select/toggle/action），挂到 target 下
  const renderField = (f, target) => {
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
      input.value = draft[f.id];
      input.style.cssText = 'width:100%;accent-color:var(--kui-blue);';
      input.addEventListener('input', () => {
        draft[f.id] = parseFloat(input.value); // 只写草稿，不即时生效
        renderValue(f.id);
        if (liveApply) { settings[f.id] = draft[f.id]; applyOne(f.id, draft[f.id]); saveSettings(settings, storeKey); }
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
      select.value = String(draft[f.id]);
      select.style.cssText =
        'width:100%;background:var(--kui-paper);color:var(--kui-ink);' +
        'border:2px solid var(--kui-blue-dark);border-radius:10px;padding:3px 6px;font-family:var(--kui-font);';
      select.addEventListener('change', () => {
        // ⚠ 必须用 Number()，不能用 parseFloat()：
        //   parseFloat('2行竖列') = 2（吃掉前导数字）→ 存成数字 2，字符串比较全失效
        //   （「手机技能槽=2行竖列」因此永远落回 wheel，表现为"设置里切了没反应"）。
        //   Number() 要求整串都是数字才转：'2行竖列'/'low'/'auto'/'on'/'视角操控'/'锁视角' 保持字符串，
        //   只有 '2048'/'1024' 这种纯数字档位才转成数字。
        const raw = select.value;
        const num = Number(raw);
        draft[f.id] = (raw !== '' && Number.isFinite(num)) ? num : raw;
        if (liveApply) { settings[f.id] = draft[f.id]; applyOne(f.id, draft[f.id]); saveSettings(settings, storeKey); }
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
      cb.checked = !!draft[f.id];
      cb.style.cssText = 'accent-color:var(--kui-blue);';
      cb.addEventListener('change', () => {
        draft[f.id] = cb.checked; // 只写草稿，不即时生效
        if (liveApply) { settings[f.id] = draft[f.id]; applyOne(f.id, draft[f.id]); saveSettings(settings, storeKey); }
      });
      row.appendChild(lab);
      row.appendChild(cb);
      inputs[f.id] = cb;
    } else if (f.kind === 'action') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'kui-btn kui-btn--grey';
      btn.style.cssText = 'width:100%;margin-top:2px;font:inherit;';
      btn.textContent = f.label;
      btn.addEventListener('click', () => {
        const fn = binds[f.id];
        if (fn) fn();
      });
      inputs[f.id] = btn;
      row.appendChild(btn);
      if (f.hint) {
        const tip = document.createElement('div');
        tip.style.cssText = 'margin-top:6px;font-size:11px;line-height:1.6;color:var(--kui-ink-soft);';
        tip.textContent = f.hint;
        row.appendChild(tip);
      }
    }
    target.appendChild(row);
  };

  // 按分组顺序渲染各卡片（分组内字段保持 FIELDS 原始顺序）
  const sectionsHost = document.createElement('div');
  card.appendChild(sectionsHost);
  for (const g of GROUPS) {
    const gf = fields.filter((f) => f.group === g);
    if (!gf.length) continue;
    const sec = document.createElement('div');
    sec.className = 'gx-sec';
    sec.style.cssText =
      'background:rgba(255,255,255,.07);border:1px solid var(--kui-blue-soft);' +
      'border-radius:var(--kui-r-md);padding:10px 12px;margin-bottom:12px;';
    const h = document.createElement('div');
    h.className = 'gx-sec__title';
    h.style.cssText = 'font-weight:700;font-size:13px;color:var(--kui-ink);margin:0 0 8px;';
    h.textContent = g;
    sec.appendChild(h);
    const secBody = document.createElement('div');
    sec.appendChild(secBody);
    for (const f of gf) renderField(f, secBody);
    sectionsHost.appendChild(sec);
  }

  // 提交草稿：合并进 settings、应用所有 binds、保存
  const commit = () => {
    for (const f of fields) {
      if (f.kind === 'action') continue;
      settings[f.id] = draft[f.id];
      applyOne(f.id, settings[f.id]);
    }
    saveSettings(settings, storeKey);
  };

  // 底部按钮行：应用设置（提交草稿）+ 恢复默认（立即提交默认）
  const foot = document.createElement('div');
  foot.style.cssText = 'display:flex;gap:8px;margin-top:4px;';
  card.appendChild(foot);

  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'kui-btn kui-btn--primary';
  applyBtn.style.cssText = 'flex:1 1 auto;min-width:0;font:inherit;' + (liveApply ? 'display:none;' : '');
  applyBtn.textContent = '应用设置';
  applyBtn.addEventListener('click', () => {
    commit();
    // 提交后文案轻微反馈
    const old = applyBtn.textContent;
    applyBtn.textContent = '已应用 ✓';
    setTimeout(() => { applyBtn.textContent = old; }, 900);
  });
  foot.appendChild(applyBtn);

  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'kui-btn kui-btn--grey';
  reset.style.cssText = 'flex:1 1 auto;min-width:0;font:inherit;';
  reset.textContent = '恢复默认';
  reset.addEventListener('click', () => {
    // 恢复默认：草稿与已提交都回到默认，并立即应用 + 保存 + 同步控件
    for (const f of fields) {
      if (f.kind === 'action') continue;
      draft[f.id] = BASE[f.id];
      settings[f.id] = BASE[f.id];
      syncControl(f);
      applyOne(f.id, settings[f.id]);
    }
    saveSettings(settings, storeKey);
  });
  foot.appendChild(reset);

  // ---- 「操作说明」区块（仅电脑）：用键位图块列出实际按键 ----
  // 手机上不显示：那没有物理键盘，列一堆 WASD 只是占地方。
  // opts.coarsePointer 由调用方传入（Game 已经算过一次，别再判一遍）。
  if (!opts.coarsePointer) {
    const keyBox = createKeyHints();
    if (keyBox) card.appendChild(keyBox);
  }

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
    '可拖拽摆放跳跃键、攻击键、技能槽、血条、对话选项卡；横竖屏各存一套位置。' +
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
    // 重新打开时把草稿重置成已提交值（丢弃上一次未应用的修改）
    for (const f of fields) {
      if (f.kind === 'action') continue;
      draft[f.id] = settings[f.id];
      syncControl(f);
    }
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

  // 初始化时应用已保存的设置（首屏就该生效）
  for (const id of Object.keys(settings)) applyOne(id, settings[id]);

  return {
    root,
    get: () => ({ ...settings }),
    // 立即改某一项并提交 + 保存（HUD 按钮等外部入口用）；面板开着也同步控件显示
    setField: (id, value) => {
      const f = fields.find((x) => x.id === id);
      if (!f || f.kind === 'action') return;
      draft[id] = value;
      settings[id] = value;
      syncControl(f);
      applyOne(id, value);
      saveSettings(settings, storeKey);
    },
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
  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 1 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
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
