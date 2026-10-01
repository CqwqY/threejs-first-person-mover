// 职责：AI 商人 NPC 的对话面板。打开后双方对话，消息发到由调用方提供的 onSend 回调，
// 回调里走后端 /api/ai，拿到回复后通过 addMsg 追加到面板并显示「打字中」。
let styleInjected = false;
function injectStyle() {
  if (styleInjected || typeof document === 'undefined') return;
  styleInjected = true;
  const st = document.createElement('style');
  st.textContent = `
    .npc-chat {
      position: fixed; right: 18px; bottom: 18px; z-index: 9500; width: 300px;
      background: #ffffff; border: 1px solid #dde3ec; border-radius: 14px;
      box-shadow: 0 12px 40px rgba(0,0,0,.25); display: flex; flex-direction: column;
      font: 13px/1.5 system-ui, "Microsoft YaHei", sans-serif; overflow: hidden;
    }
    .npc-chat.hidden { display: none; }
    .npc-chat-head {
      display: flex; align-items: center; gap: 8px; padding: 9px 12px;
      background: linear-gradient(150deg,#3b7ddd,#1e55a8); color: #fff; font-weight: 700;
    }
    .npc-chat-head .dot { width: 8px; height: 8px; border-radius: 50%; background: #9be15d; }
    .npc-chat-head .close { margin-left: auto; cursor: pointer; font-weight: 400; font-size: 15px; opacity:.9; }
    .npc-chat-head .close:hover { opacity: 1; }
    .npc-chat-body { height: 230px; overflow-y: auto; padding: 10px 12px; background: #f5f7fa; }
    .npc-msg { margin-bottom: 8px; max-width: 88%; padding: 6px 10px; border-radius: 10px; white-space: pre-wrap; word-break: break-word; }
    .npc-msg.npc { background: #e7eefb; color: #1f2430; border-top-left-radius: 3px; }
    .npc-msg.me { margin-left: auto; background: #3b7ddd; color: #fff; border-top-right-radius: 3px; }
    .npc-msg.busy { color: #8a94a6; font-style: italic; }
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
      <span>阿花 · AI 商人</span>
      <span class="close">×</span>
    </div>
    <div class="npc-chat-body"></div>
    <div class="npc-chat-foot">
      <input placeholder="问点啥？说句话让阿花变出能力…" />
      <button type="button">发送</button>
    </div>`;
  document.body.appendChild(root);

  const body = root.querySelector('.npc-chat-body');
  const input = root.querySelector('.npc-chat-foot input');
  const sendBtn = root.querySelector('.npc-chat-foot button');
  const closeBtn = root.querySelector('.npc-chat-head .close');

  let onSend = null; // (text) => Promise | void

  function addMsg(role, text) {
    const el = document.createElement('div');
    el.className = 'npc-msg ' + role;
    el.textContent = text;
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
    return el;
  }

  async function send() {
    const text = input.value.trim();
    if (!text || !onSend) return;
    input.value = '';
    addMsg('me', text);
    onSend(text);
  }

  function open() {
    root.classList.remove('hidden');
    input.focus();
    // 追加软回车让页面不再吃空格跳
    addMsg('npc', '来啦来啦～我是阿花，想要加速、变大变小、瞬移、飞，还是淘个宝贝？开口就行。');
  }
  function close() {
    root.classList.add('hidden');
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
  };
}