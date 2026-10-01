// 职责：AI 商人 NPC 的对话面板，原神式「单条对话 + 打字机」。
// 消息由调用方通过 onSend 回调走后端 /api/ai；NPC 的回复逐字显示(打字机，非流式)。
let styleInjected = false;
function injectStyle() {
  if (styleInjected || typeof document === 'undefined') return;
  styleInjected = true;
  const st = document.createElement('style');
  st.textContent = `
    .npc-chat {
      position: fixed; left: 0; right: 0; bottom: 0; z-index: 9500; width: 100%;
      background: #ffffff; border-top: 1px solid #dde3ec;
      box-shadow: 0 -8px 40px rgba(0,0,0,.2); display: flex; flex-direction: column;
      font: 13px/1.5 system-ui, "Microsoft YaHei", sans-serif; overflow: hidden;
    }
    .npc-chat.hidden { display: none; }
    .npc-chat-head {
      display: flex; align-items: center; gap: 8px; padding: 8px 16px;
      background: linear-gradient(150deg,#3b7ddd,#1e55a8); color: #fff; font-weight: 700;
    }
    .npc-chat-head .dot { width: 8px; height: 8px; border-radius: 50%; background: #9be15d; }
    .npc-chat-head .close { margin-left: auto; cursor: pointer; font-weight: 400; font-size: 15px; opacity:.9; padding: 0 6px; }
    .npc-chat-head .close:hover { opacity: 1; }
    .npc-chat-body { max-height: 150px; height: 150px; overflow-y: auto; padding: 10px 16px; background: #f5f7fa; }
    .npc-msg { margin-bottom: 8px; max-width: 88%; padding: 6px 10px; border-radius: 10px; white-space: pre-wrap; word-break: break-word; }
    .npc-msg.npc { background: #e7eefb; color: #1f2430; border-top-left-radius: 3px; }
    .npc-msg.me { margin-left: auto; background: #3b7ddd; color: #fff; border-top-right-radius: 3px; }
    .npc-msg.busy { color: #8a94a6; font-style: italic; }
    .npc-msg .caret { display:inline-block; width:0; border-right:2px solid currentColor; margin-left:1px;
      -webkit-animation: npc-blink .8s steps(1) infinite; animation: npc-blink .8s steps(1) infinite; }
    @keyframes npc-blink { 50% { border-color: transparent; } }
    .npc-chat-foot { display: flex; gap: 6px; padding: 8px; border-top: 1px solid #e6eaf0; }
    .npc-chat-foot input {
      flex: 1; padding: 7px 10px; border: 1px solid #d5dae3; border-radius: 8px; outline: none; font-size: 13px; background: #fff;
    }
    .npc-chat-foot input:focus { border-color: #3b7ddd; }
    .npc-chat-foot button {
      padding: 7px 12px; border: 0; border-radius: 8px; background: #3b7ddd; color: #fff; cursor: pointer; font-weight: 600;
    }
    .npc-chat-foot button:hover { background: #2f6cc9; }
  `;
  document.head.appendChild(st);
}

// 创建对话面板。返回 { root, open, close, toggle, isOpen, addMsg, setOnSend, focusInput }
export function createNpcChat() {
  injectStyle();

  const root = document.createElement('div');
  root.className = 'npc-chat hidden';
  root.innerHTML = `
    <div class="npc-chat-head">
      <span class="dot"></span>
      <span>阿花 · 物品商人</span>
      <span class="close">×</span>
    </div>
    <div class="npc-chat-body"></div>
    <div class="npc-chat-foot">
      <input placeholder="想要什么宝贝？直接跟阿花开口…" />
      <button type="button">发送</button>
    </div>`;
  document.body.appendChild(root);

  const body = root.querySelector('.npc-chat-body');
  const input = root.querySelector('.npc-chat-foot input');
  const sendBtn = root.querySelector('.npc-chat-foot button');
  const closeBtn = root.querySelector('.npc-chat-head .close');

  let onSend = null; // (text) => Promise | void
  let _stopType = null; // 正在进行的打字机停止句柄
  let _busyEl = null;   // 当前显示的「正在想…」元素

  // 追加普通消息（玩家自己的话 / 忙时提示）：立即显示，不逐字。
  function addPlain(role, text) {
    const el = document.createElement('div');
    el.className = 'npc-msg ' + role;
    el.textContent = text;
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
    return el;
  }

  // NPC 回复：打字机逐字显示（非流式，仅前端动画）。
  // 若有上一条正在打的字，先停下；并清掉上一条「正在想…」的忙提示。
  function addMsg(role, text) {
    if (role === 'npc') return addTypewriter(text);
    if (role === 'me') { addPlain('me', text); return null; }
    if (role === 'busy') {
      if (_stopType) { _stopType(); _stopType = null; }
      _busyEl = addPlain('busy', text);
      return _busyEl;
    }
    return addPlain(role, text);
  }

  function addTypewriter(full) {
    if (_stopType) { _stopType(); _stopType = null; }
    if (_busyEl) { _busyEl.remove(); _busyEl = null; }

    const el = document.createElement('div');
    el.className = 'npc-msg npc';
    body.appendChild(el);

    let i = 1;
    const caret = document.createElement('span');
    caret.className = 'caret';
    el.textContent = full.slice(0, i);
    el.appendChild(caret);

    const interval = setInterval(() => {
      i++;
      el.textContent = full.slice(0, i);
      el.appendChild(caret);
      body.scrollTop = body.scrollHeight;
      if (i >= full.length) { clearInterval(interval); renderCaretOff(caret); }
    }, 34);

    _stopType = () => { clearInterval(interval); renderCaretOff(caret); _stopType = null; };
    return el;
  }
  function renderCaretOff(caret) {
    if (caret && caret.parentNode) caret.remove();
  }

  async function send() {
    const text = input.value.trim();
    if (!text || !onSend) return;
    input.value = '';
    addMsg('me', text);
    onSend(text);
  }

  let onOpen = null;
  let onClose = null;
  function open() {
    root.classList.remove('hidden');
    input.focus();
    if (!body.querySelector('.npc-msg')) {
      addMsg('npc', '来啦来啦～我是物品商人阿花。想要什么宝贝，直接跟我说，东西放进你背包里。');
    }
    if (onOpen) onOpen();
  }
  function close() {
    if (_stopType) { _stopType(); _stopType = null; }
    root.classList.add('hidden');
    if (onClose) onClose();
  }
  function toggle() { root.classList.contains('hidden') ? open() : close(); }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); send(); }
  });
  sendBtn.addEventListener('click', send);
  closeBtn.addEventListener('click', close);

  function focusInput() { input.focus(); }

  return {
    root,
    open,
    close,
    toggle,
    isOpen: () => !root.classList.contains('hidden'),
    addMsg,
    focusInput,
    setOnSend(fn) { onSend = fn; },
    setOnOpen(fn) { onOpen = fn; },
    setOnClose(fn) { onClose = fn; },
  };
}