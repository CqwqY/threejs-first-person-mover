// 职责：NPC 对话面板（学生用），原神式「单条对话 + 打字机」。
// 消息由调用方通过 onSend 回调发到服务端（服务端带人设/记忆调 GLM）；回复逐字显示（打字机，非流式）。
// setTitle 换掉顶栏的名字；addThink 显示对方的「心理活动」（灰色斜体，和嘴上说的话区分开）。
import { ensureTheme } from './theme.js';

// 创建对话面板。返回 { root, open, close, toggle, isOpen, addMsg, setOnSend, focusInput }
export function createNpcChat() {
  ensureTheme();

  const root = document.createElement('div');
  root.className = 'npc-chat hidden';
  Object.assign(root.style, {
    position: 'fixed', left: '0', right: '0', bottom: '0',
    width: '100%', zIndex: '9500',
    display: 'none', flexDirection: 'column', overflow: 'hidden',
    fontFamily: 'var(--kui-font)', fontSize: '13px', lineHeight: '1.5',
  });
  root.innerHTML = `
    <div class="kui-panel npc-chat-panel">
      <div class="kui-panel__body">
        <div class="npc-chat-head" style="display:flex;align-items:center;gap:8px;padding:4px 2px 8px;border-bottom:2px solid var(--kui-blue-dark);">
          <span class="dot" style="flex:none;width:8px;height:8px;border-radius:50%;background:var(--kui-ok);"></span>
          <span class="kui-title npc-chat-title">同学</span>
          <span class="close kui-iconbtn" style="margin-left:auto;">×</span>
        </div>
        <div class="npc-chat-body" style="height:150px;max-height:150px;overflow-y:auto;padding:8px;margin:8px 0;background:var(--kui-blue-soft);border-radius:var(--kui-radius);"></div>
        <div class="npc-chat-foot" style="display:flex;gap:6px;padding:2px;">
          <input class="kui-input" style="flex:1;" placeholder="想聊点什么？直接说…" />
          <button type="button" class="kui-btn kui-btn--primary">发送</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(root);

  const body = root.querySelector('.npc-chat-body');
  const input = root.querySelector('.npc-chat-foot input');
  const sendBtn = root.querySelector('.npc-chat-foot button');
  const closeBtn = root.querySelector('.npc-chat-head .close');
  const titleEl = root.querySelector('.npc-chat-title');

  let onSend = null; // (text) => Promise | void
  let _stopType = null; // 正在进行的打字机停止句柄
  let _busyEl = null;   // 当前显示的「正在想…」元素

  // 换对话对象：顶栏名字 + 清掉上一个人的聊天记录（聊天记录不跨人保留）
  function setTitle(text) {
    if (titleEl) titleEl.textContent = String(text || '同学');
    body.innerHTML = '';
    _stopType = null;
    _busyEl = null;
  }
  // 心理活动：灰色斜体小字，紧跟在对方那句话下面
  function addThink(text) {
    if (!text) return null;
    const el = document.createElement('div');
    el.className = 'npc-msg think';
    el.style.cssText = 'margin:-2px 0 8px;max-width:88%;padding:4px 10px;border-radius:10px;' +
      'background:transparent;color:var(--kui-ink-soft);font-style:italic;font-size:12px;' +
      'white-space:pre-wrap;word-break:break-word;opacity:.85;';
    el.textContent = '（' + String(text) + '）';
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
    return el;
  }

  // 消息气泡外观（只做视觉）：换成 Kenney 主题变量，排版尺寸沿用原值
  function styleMsg(el, role) {
    el.style.cssText = 'margin-bottom:8px;max-width:88%;padding:6px 10px;border-radius:10px;white-space:pre-wrap;word-break:break-word;';
    if (role === 'me') {
      el.style.marginLeft = 'auto';
      el.style.background = 'var(--kui-blue)';
      el.style.color = 'var(--kui-paper)';
      el.style.borderTopRightRadius = '3px';
    } else if (role === 'busy') {
      el.style.color = 'var(--kui-ink-soft)';
      el.style.fontStyle = 'italic';
    } else {
      el.style.background = 'var(--kui-paper)';
      el.style.color = 'var(--kui-ink)';
      el.style.borderTopLeftRadius = '3px';
    }
  }

  // 追加普通消息（玩家自己的话 / 忙时提示）：立即显示，不逐字。
  function addPlain(role, text) {
    const el = document.createElement('div');
    el.className = 'npc-msg ' + role;
    styleMsg(el, role);
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
    styleMsg(el, 'npc');
    body.appendChild(el);

    let i = 1;
    const caret = document.createElement('span');
    caret.className = 'caret';
    caret.style.display = 'inline-block';
    caret.style.width = '0';
    caret.style.borderRight = '2px solid currentColor';
    caret.style.marginLeft = '1px';
    // 光标闪烁：原先由被移除的 <style> 里的 @keyframes 提供，这里改用 Web Animations API
    // 复刻同样的 0.8s 硬闪烁（0~400ms 显示 / 400~800ms 隐藏），不改打字节奏。
    if (typeof caret.animate === 'function') {
      caret.animate(
        [{ opacity: 1 }, { opacity: 1, offset: 0.5 }, { opacity: 0, offset: 0.5 }, { opacity: 0 }],
        { duration: 800, iterations: Infinity }
      );
    }
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
    root.style.display = 'flex';
    input.focus();
    if (!body.querySelector('.npc-msg')) {
      addMsg('npc', '嗯？找我有什么事吗。');
    }
    if (onOpen) onOpen();
  }
  function close() {
    if (_stopType) { _stopType(); _stopType = null; }
    root.classList.add('hidden');
    root.style.display = 'none';
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
    addThink,
    setTitle,
    focusInput,
    setOnSend(fn) { onSend = fn; },
    setOnOpen(fn) { onOpen = fn; },
    setOnClose(fn) { onClose = fn; },
  };
}