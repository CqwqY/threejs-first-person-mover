// 职责：NPC 对话面板（游戏式，不是聊天工具）。
// 布局（用户要求）：**中间**是 AI 说的话（大字 + 打字机），**对话框右上方**才是输入框；
// 不再显示"上一条消息"的历史列表（那太像 AI 聊天工具了）。
// 顶栏左边是「名字·班级 + 校卡按钮」，右边是输入框/发送/关闭。
// 消息由调用方通过 onSend 回调发到服务端；回复逐字显示（打字机，非流式）。
import { ensureTheme } from './theme.js';

// 创建对话面板。返回 { root, open, close, toggle, isOpen, addMsg, addThink, setTitle,
//   focusInput, setOnSend, setOnOpen, setOnClose, setOnCard }
export function createNpcChat() {
  ensureTheme();

  const root = document.createElement('div');
  root.className = 'npc-chat hidden';
  Object.assign(root.style, {
    position: 'fixed', inset: '0', zIndex: '9500',
    display: 'none', alignItems: 'flex-end', justifyContent: 'center',
    paddingBottom: '6vh', pointerEvents: 'none', // 面板之外仍能看见/操作游戏
    fontFamily: 'var(--kui-font)', fontSize: '13px', lineHeight: '1.5',
  });
  root.innerHTML = `
    <div class="npc-dlg" style="pointer-events:auto;width:min(760px,92vw);
        background:color-mix(in srgb, var(--kui-paper) 94%, transparent);
        border:2px solid var(--kui-blue-dark);border-radius:14px;
        box-shadow:0 12px 40px rgba(0,0,0,.45);overflow:hidden;">
      <div class="npc-dlg__top" style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:2px solid var(--kui-blue-soft);">
        <span class="dot" style="flex:none;width:8px;height:8px;border-radius:50%;background:var(--kui-ok);"></span>
        <span class="kui-title npc-chat-title" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">同学</span>
        <button type="button" class="npc-card-btn kui-btn" title="查看 TA 的性格/记忆" style="flex:none;">校卡</button>
        <div class="npc-dlg__compose" style="margin-left:auto;display:flex;gap:6px;align-items:center;">
          <input class="kui-input" style="width:min(260px,40vw);" placeholder="对 TA 说点什么…" />
          <button type="button" class="kui-btn kui-btn--primary">发送</button>
        </div>
        <span class="close kui-iconbtn" style="flex:none;">×</span>
      </div>
      <div class="npc-dlg__main" style="min-height:132px;display:flex;align-items:center;justify-content:center;padding:18px 22px;">
        <div class="npc-line" style="font-size:19px;line-height:1.6;color:var(--kui-ink);text-align:center;white-space:pre-wrap;word-break:break-word;"></div>
      </div>
      <div class="npc-dlg__me" style="padding:0 14px 10px;text-align:right;color:var(--kui-ink-soft);font-size:12px;min-height:16px;"></div>
    </div>`;
  document.body.appendChild(root);

  const titleEl = root.querySelector('.npc-chat-title');
  const input = root.querySelector('.npc-dlg__compose input');
  const sendBtn = root.querySelector('.npc-dlg__compose button');
  const closeBtn = root.querySelector('.close');
  const cardBtn = root.querySelector('.npc-card-btn');
  const lineEl = root.querySelector('.npc-line');
  const meEl = root.querySelector('.npc-dlg__me');

  let onSend = null;   // (text) => Promise | void
  let onCard = null;   // () => void
  let _stopType = null;

  // 换对话对象：顶栏名字 + 清空中间那句话（不保留上一个人的历史）
  function setTitle(text) {
    if (titleEl) titleEl.textContent = String(text || '同学');
    stopType();
    lineEl.textContent = '';
    lineEl.style.fontStyle = '';
    lineEl.style.color = 'var(--kui-ink)';
    meEl.textContent = '';
  }
  function stopType() { if (_stopType) { _stopType(); _stopType = null; } }

  // 「心理活动」是内部数据：服务端不下发，这里只在真有内容时用小字附在句子下面
  function addThink(text) {
    if (!text) return;
    lineEl.textContent += '\n（' + String(text) + '）';
  }

  // NPC 的话：打字机打在**中间大字区**（替换上一句，不留历史）
  function addTypewriter(full) {
    stopType();
    lineEl.style.fontStyle = '';
    lineEl.style.color = 'var(--kui-ink)';
    const caret = document.createElement('span');
    caret.style.cssText = 'display:inline-block;width:0;border-right:2px solid currentColor;margin-left:1px;';
    if (typeof caret.animate === 'function') {
      caret.animate([{ opacity: 1 }, { opacity: 1, offset: 0.5 }, { opacity: 0, offset: 0.5 }, { opacity: 0 }],
        { duration: 800, iterations: Infinity });
    }
    let i = 1;
    lineEl.textContent = full.slice(0, i);
    lineEl.appendChild(caret);
    const interval = setInterval(() => {
      i++;
      lineEl.textContent = full.slice(0, i);
      lineEl.appendChild(caret);
      if (i >= full.length) { clearInterval(interval); if (caret.parentNode) caret.remove(); }
    }, 34);
    _stopType = () => { clearInterval(interval); if (caret.parentNode) caret.remove(); _stopType = null; };
  }

  // role: 'npc' 逐字｜'me' 右下角小字｜'busy' 中间灰字提示
  function addMsg(role, text) {
    const t = String(text == null ? '' : text);
    if (role === 'npc') { addTypewriter(t); return; }
    if (role === 'me') { meEl.textContent = t ? ('我说：' + t) : ''; return; }
    if (role === 'busy') { stopType(); lineEl.style.fontStyle = 'italic'; lineEl.style.color = 'var(--kui-ink-soft)'; lineEl.textContent = t; return; }
    addTypewriter(t);
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
    if (!lineEl.textContent) addMsg('npc', '嗯？找我有什么事吗。');
    input.focus();
    if (onOpen) onOpen();
  }
  function close() {
    stopType();
    root.classList.add('hidden');
    root.style.display = 'none';
    if (onClose) onClose();
  }
  function toggle() { root.classList.contains('hidden') ? open() : close(); }

  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
  sendBtn.addEventListener('click', send);
  closeBtn.addEventListener('click', close);
  cardBtn.addEventListener('click', () => { if (onCard) onCard(); });

  return {
    root,
    open,
    close,
    toggle,
    isOpen: () => !root.classList.contains('hidden'),
    addMsg,
    addThink,
    setTitle,
    focusInput() { input.focus(); },
    setOnSend(fn) { onSend = fn; },
    setOnOpen(fn) { onOpen = fn; },
    setOnClose(fn) { onClose = fn; },
    setOnCard(fn) { onCard = fn; },
  };
}
