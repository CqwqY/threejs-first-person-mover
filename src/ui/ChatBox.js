// 职责：玩家聊天（屏幕左下角一栏滚动消息 + 一条输入框）。
//   PC  ：按 T 打开输入（自动聚焦并退出指针锁定），回车发送、Esc / 失焦关闭；不显示浮动按钮。
//   手机：左下角一颗圆形「聊」按钮，点开输入条；发完自动收起，腾出屏幕。
// 与游戏逻辑解耦：只通过 onSend 吐出待发送文本，通过 add() 接收要显示的消息；
// 消息一律用 textContent 渲染（纯文本，不解析任何标记），因此天然免疫注入。
import { ensureTheme } from './theme.js';
import { viewportSize } from './layout.js';
import { isCoarsePointer } from '../util/isCoarse.js';

const SEND_MAX = 60;      // 自己发出去的字数上限（服务端另有 80 字硬上限）
const DISPLAY_MAX = 120;  // 别人发来的字数上限（只是兜底，服务端已经截到 80）
const LOG_MAX = 40;       // 屏幕上最多同时保留的条数（超出丢最旧的）
const LINE_LIFE = 14;     // 一条消息停留多少秒后淡出（秒）
const LINE_FADE = 0.6;    // 淡出动画时长（秒）

// 文本清洗：剥 HTML 标签、清控制字符、把换行/连续空白压成单空格、限长。
// 规则与 server-remote/index.js 的 cleanChat 一致（那边只是长度更宽的一档），
// 这里再洗一遍是为了「本地回显」和「收到的消息」走同一条路，两边表现完全一样。
export function cleanChatText(v, max) {
  const n = Number.isFinite(max) && max > 0 ? Math.floor(max) : SEND_MAX;
  return String(v == null ? '' : v)
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n);
}

// 创建聊天框。返回 { root, add, open, close, toggle, isOpen, relayout,
//                    setOnSend, setOnOpen, setOnClose, setSendBlocked }
export function createChatBox(opts = {}) {
  ensureTheme();

  // 触屏判定：允许外部显式覆盖（自检脚本要在 Node 里跑两种形态），
  // 注意不能用 Number.isFinite 判——那对 boolean 返回 false，会把 true 当成「没传」。
  const coarse = typeof opts.coarse === 'boolean'
    ? opts.coarse
    : isCoarsePointer();
  const logMax = Number.isFinite(opts.logMax) ? Math.max(1, opts.logMax) : LOG_MAX;
  const lineLife = (Number.isFinite(opts.lineLife) ? opts.lineLife : LINE_LIFE) * 1000;
  const fadeMs = (Number.isFinite(opts.fade) ? opts.fade : LINE_FADE) * 1000;

  // ---- 容器：左下角自下而上堆「消息 → 输入条 → 按钮」 ----
  // pointer-events:none 让消息与空白都不吃点击（点画面仍然能锁定视角），只有按钮/输入框单独打开。
  const root = document.createElement('div');
  root.className = 'chat-root';
  root.style.cssText =
    'position:fixed;z-index:64;display:flex;flex-direction:column;align-items:flex-start;gap:6px;' +
    'pointer-events:none;bottom:0;left:calc(env(safe-area-inset-left, 0px) + 14px);' +
    'width:min(340px, 66vw);';

  // ---- 消息栏：column-reverse ⇒ 第 0 个子节点贴底（最新的在下面），
  //      超长时溢出的部分被裁在顶部（剪掉的是最老的），最新的永远看得见 ----
  const log = document.createElement('div');
  log.className = 'chat-log';
  log.style.cssText =
    'display:flex;flex-direction:column-reverse;align-items:flex-start;gap:2px;' +
    'width:100%;max-height:32vh;overflow:hidden;pointer-events:none;';

  // ---- 输入条 ----
  const bar = document.createElement('div');
  bar.className = 'chat-bar';
  bar.style.cssText =
    'display:none;align-items:center;gap:5px;width:100%;pointer-events:auto;';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'kui-input chat-input';
  input.placeholder = '说点什么…';
  input.maxLength = SEND_MAX;
  input.autocomplete = 'off';
  input.style.cssText = 'flex:1;min-width:0;box-sizing:border-box;padding:7px 10px;font-size:13px;';

  const sendBtn = document.createElement('div');
  sendBtn.className = 'kui-btn kui-btn--primary chat-send';
  sendBtn.textContent = '发送';
  sendBtn.style.cssText =
    'flex:none;min-width:52px;padding:7px 8px;font-size:13px;cursor:pointer;text-align:center;' +
    'user-select:none;-webkit-user-select:none;touch-action:none;';

  const closeBtn = document.createElement('div');
  closeBtn.className = 'kui-iconbtn chat-close';
  closeBtn.textContent = '×';
  closeBtn.style.cssText = 'flex:none;cursor:pointer;user-select:none;-webkit-user-select:none;touch-action:none;';

  bar.appendChild(input);
  bar.appendChild(sendBtn);
  bar.appendChild(closeBtn);

  // ---- 手机入口按钮（桌面用 T 键，不显示）----
  const fab = document.createElement('div');
  fab.className = 'chat-fab';
  fab.textContent = '聊';
  fab.style.cssText =
    'flex:none;width:clamp(40px,11vmin,48px);height:clamp(40px,11vmin,48px);border-radius:50%;' +
    'display:flex;align-items:center;justify-content:center;pointer-events:auto;cursor:pointer;' +
    'font:600 clamp(12px,3.2vmin,14px)/1 var(--kui-font);letter-spacing:1px;color:var(--kui-paper);' +
    'background:color-mix(in srgb, var(--kui-blue) 30%, transparent);' +
    'border:2px solid color-mix(in srgb, var(--kui-blue-soft) 75%, transparent);' +
    'touch-action:none;user-select:none;-webkit-user-select:none;';
  if (!coarse) fab.style.display = 'none';

  root.appendChild(log);
  root.appendChild(bar);
  root.appendChild(fab);
  document.body.appendChild(root);

  // ---- 位置：手机排在摇杆正上方（两者用同一套公式算高度，永不重叠）；
  //      软键盘弹起时再整体上抬到键盘之上 ----
  function keyboardOverlap() {
    const vv = window.visualViewport;
    if (!vv) return 0;
    const { height: vh } = viewportSize();
    // 键盘高度 ≈ 布局视口 - 可视视口；无键盘时两项相等，结果接近 0
    return Math.max(0, Math.min(vh * 0.7, window.innerHeight - (vv.height + vv.offsetTop)));
  }

  function relayout() {
    const { width: vw, height: vh } = viewportSize();
    const vmin = Math.min(vw, vh);
    let base;
    if (coarse) {
      // .mc-joy 在 left:20 / bottom:26，尺寸 clamp(92px,26vmin,124px)
      const joy = Math.min(124, Math.max(92, vmin * 0.26));
      base = 26 + joy + 12;
    } else {
      base = 16;
    }
    root.style.bottom = 'calc(env(safe-area-inset-bottom, 0px) + ' + Math.round(base + keyboardOverlap()) + 'px)';
  }

  // ---- 消息行 ----
  const lines = [];  // 按插入顺序（[0] 最旧）；DOM 里最新的在最前
  let held = false;  // 打开输入框期间冻结淡出，方便边打字边看

  function startFade(rec) {
    clearTimeout(rec.timer);
    rec.timer = setTimeout(() => {
      rec.el.style.opacity = '0';
      rec.timer = setTimeout(() => {
        rec.el.remove();
        const i = lines.indexOf(rec);
        if (i >= 0) lines.splice(i, 1);
      }, fadeMs);
    }, lineLife);
  }

  function setHeld(v) {
    held = !!v;
    for (const rec of lines) {
      if (held) clearTimeout(rec.timer);
      else startFade(rec);
    }
  }

  function push(el) {
    log.insertBefore(el, log.firstChild); // column-reverse：插到最前 = 显示在最下面
    const rec = { el, timer: 0 };
    lines.push(rec);
    el.style.opacity = '1';
    if (!held) startFade(rec);
    while (lines.length > logMax) {
      const old = lines.shift();
      clearTimeout(old.timer);
      old.el.remove();
    }
  }

  // 追加一条消息。msg: { nick, color, text, me, sys }
  //   me  —— 自己发的（左侧描边区分）
  //   sys —— 系统提示（没有昵称，绿色底）
  function add(msg) {
    if (!msg || typeof msg !== 'object') return null;
    const text = cleanChatText(msg.text, DISPLAY_MAX);
    if (!text) return null;

    const el = document.createElement('div');
    el.className = 'chat-line' + (msg.sys ? ' chat-line--sys' : '') + (msg.me ? ' chat-line--me' : '');
    el.style.cssText =
      'max-width:100%;box-sizing:border-box;padding:2px 8px;border-radius:8px;' +
      'font:12px/1.45 var(--kui-font);word-break:break-word;white-space:pre-wrap;' +
      'color:var(--kui-paper);background:color-mix(in srgb, var(--kui-ink) 62%, transparent);' +
      'opacity:0;transition:opacity ' + (fadeMs / 1000) + 's;pointer-events:none;';

    if (!msg.sys) {
      const nick = document.createElement('span');
      nick.textContent = String(msg.nick || '玩家') + '：';
      nick.style.cssText = 'font-weight:700;color:' + (msg.color || '#ffffff') + ';';
      el.appendChild(nick);
    }
    const body = document.createElement('span');
    body.textContent = text; // 纯文本：不解析标记，防注入
    el.appendChild(body);

    if (msg.sys) {
      el.style.background = 'color-mix(in srgb, var(--kui-ok) 72%, transparent)';
      el.style.fontStyle = 'italic';
    } else if (msg.me) {
      el.style.borderLeft = '3px solid var(--kui-blue)';
    }

    push(el);
    return el;
  }

  // ---- 开 / 关 ----
  let onSend = null;
  let onOpen = null;
  let onClose = null;
  let sendBlocked = null; // () => bool：返回 true 时暂不允许发送（如正在匹配/已断线）
  let shown = false;

  function show() {
    if (shown) return;
    shown = true;
    bar.style.display = 'flex';
    if (coarse) fab.style.display = 'none';
    setHeld(true);
    relayout();          // 键盘马上要弹起，先把位置算好
    try { input.focus(); } catch (e) { /* 忽略 */ }
    if (onOpen) onOpen();
  }

  function hide() {
    if (!shown) return;
    shown = false;
    input.value = '';
    input.blur();
    bar.style.display = 'none';
    if (coarse) fab.style.display = 'flex';
    setHeld(false);
    relayout();
    if (onClose) onClose();
  }

  function send() {
    if (sendBlocked && sendBlocked()) return;
    const text = cleanChatText(input.value, SEND_MAX);
    if (!text) return;
    input.value = '';
    if (onSend) onSend(text);
    if (coarse) hide(); // 手机上发完就收起，把屏幕与键盘都还给游戏
  }

  // 输入框：回车发送、Esc 关闭。stopPropagation 保证不会顺带触发游戏热键。
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); send(); return; }
    if (e.key === 'Escape') { e.preventDefault(); hide(); }
  });
  // 阻止 keyup/按键冒泡到 document（Input 模块只听 document，双保险）
  input.addEventListener('keyup', (e) => e.stopPropagation());

  // 用 pointerdown + preventDefault（而不是 click）：既能在多点触控下可靠响应，
  // 又不会先把输入框的焦点夺走（否则 blur 会先把输入条关掉，点击就丢了）。
  const tap = (el, fn) => {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    });
  };
  tap(sendBtn, send);
  tap(closeBtn, hide);
  tap(fab, show);

  // 桌面端：点画面/别处让输入框失焦时，顺手把输入条收起来（手机端同理）
  input.addEventListener('blur', () => { setTimeout(() => { if (shown && document.activeElement !== input) hide(); }, 0); });

  // 视口变化（旋转 / 地址栏 / 软键盘）后重算位置
  const onViewport = () => relayout();
  window.addEventListener('resize', onViewport);
  window.addEventListener('orientationchange', onViewport);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', onViewport);
    window.visualViewport.addEventListener('scroll', onViewport);
  }
  relayout();

  return {
    root,
    add,
    open: show,
    close: hide,
    toggle: () => (shown ? hide() : show()),
    isOpen: () => shown,
    relayout,
    setOnSend(fn) { onSend = typeof fn === 'function' ? fn : null; },
    setOnOpen(fn) { onOpen = typeof fn === 'function' ? fn : null; },
    setOnClose(fn) { onClose = typeof fn === 'function' ? fn : null; },
    setSendBlocked(fn) { sendBlocked = typeof fn === 'function' ? fn : null; },
  };
}
