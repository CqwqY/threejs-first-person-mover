// 职责：手机端的「独立输入界面」——打字时给一块跟游戏完全隔开的输入区。
// 和原本那条「左下角小输入条」的区别（也就是"各大游戏"那种做法）：
//   1. 全屏半透明遮罩：屏幕上的触摸一律被它吃掉，游戏收不到任何点击/拖动
//      —— 不会边打字边走路，也不会误触摇杆/技能槽；
//   2. 输入条是**屏幕底部整条**，位置按软键盘的实时高度上抬，永远不会被键盘盖住；
//   3. 打开/关闭通过 onOpen / onClose 通知外部（外面据此把虚拟摇杆整组藏起来、锁住移动）。
//
// ⚠ 只在触屏（coarse）下创建：桌面端有物理键盘，聊天仍走原来的小输入条。
import { ensureTheme } from './theme.js';
import { viewportSize } from './layout.js';

// 软键盘占了多高：视觉视口比布局视口矮出去的那截就是键盘（无键盘时接近 0）。
// 和 ChatBox.keyboardOverlap 同一套算法，别改成两套。
function keyboardHeight() {
  const vv = window.visualViewport;
  if (!vv) return 0;
  const { height } = viewportSize();
  return Math.max(0, Math.min(height * 0.7, window.innerHeight - (vv.height + vv.offsetTop)));
}

export function createMobileInputSheet(opts = {}) {
  ensureTheme();
  const placeholder = opts.placeholder || '说点什么…';
  const maxLength = Number.isFinite(opts.maxLength) && opts.maxLength > 0 ? Math.floor(opts.maxLength) : 60;
  const onSubmit = typeof opts.onSubmit === 'function' ? opts.onSubmit : null;
  const onOpen = typeof opts.onOpen === 'function' ? opts.onOpen : null;
  const onClose = typeof opts.onClose === 'function' ? opts.onClose : null;

  // ---- 遮罩：铺满整屏，压暗画面（视觉上也告诉玩家"现在在打字"）----
  const root = document.createElement('div');
  root.className = 'mis-root';
  root.style.cssText =
    'position:fixed;inset:0;z-index:9800;display:none;flex-direction:column;justify-content:flex-end;' +
    'background:rgba(11,21,34,.55);touch-action:none;' +
    'user-select:none;-webkit-user-select:none;';

  // ---- 底部输入条：贴着键盘上沿 ----
  const sheet = document.createElement('div');
  sheet.className = 'kui-panel mis-sheet';
  sheet.style.cssText =
    'position:absolute;left:0;right:0;bottom:0;box-sizing:border-box;' +
    'padding:calc(env(safe-area-inset-bottom, 0px) + 10px) 12px 10px;' +
    'display:flex;align-items:center;gap:8px;border-radius:14px 14px 0 0;';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'kui-input';
  input.placeholder = placeholder;
  input.maxLength = maxLength;
  input.autocomplete = 'off';
  input.style.cssText = 'flex:1;min-width:0;box-sizing:border-box;padding:10px 12px;font-size:15px;';

  const sendBtn = document.createElement('div');
  sendBtn.className = 'kui-btn kui-btn--primary';
  sendBtn.textContent = '发送';
  sendBtn.style.cssText =
    'flex:none;min-width:60px;padding:10px 8px;font-size:15px;cursor:pointer;text-align:center;' +
    'touch-action:none;user-select:none;-webkit-user-select:none;';

  const closeBtn = document.createElement('div');
  closeBtn.className = 'kui-iconbtn';
  closeBtn.textContent = '×';
  closeBtn.style.cssText =
    'flex:none;cursor:pointer;touch-action:none;user-select:none;-webkit-user-select:none;';

  sheet.appendChild(input);
  sheet.appendChild(sendBtn);
  sheet.appendChild(closeBtn);
  root.appendChild(sheet);
  document.body.appendChild(root);

  let shown = false;

  // 把输入条抬到键盘之上。键盘弹起/收起都要重算（软键盘不是瞬间就位的，focus 后要再算一次）。
  function place() {
    sheet.style.bottom = 'calc(env(safe-area-inset-bottom, 0px) + ' + Math.round(keyboardHeight()) + 'px)';
  }

  function submit() {
    const text = String(input.value || '').replace(/\s+/g, ' ').trim();
    input.value = '';
    if (text && onSubmit) onSubmit(text);
    close(); // 手机上发完就收起，把屏幕和键盘都还给游戏
  }

  function open(prefill) {
    if (shown) return;
    shown = true;
    root.style.display = 'flex';
    input.value = typeof prefill === 'string' ? prefill : '';
    place();
    // 必须先显示再 focus（隐藏元素上 focus 不弹键盘）；键盘不是同步出现的，过一帧再对一次位置
    setTimeout(() => {
      try { input.focus(); } catch (e) { /* 忽略 */ }
      place();
      setTimeout(place, 120);
    }, 30);
    if (onOpen) onOpen();
  }

  function close() {
    if (!shown) return;
    shown = false;
    input.value = '';
    try { input.blur(); } catch (e) { /* 忽略 */ }
    root.style.display = 'none';
    if (onClose) onClose();
  }

  // 键盘 / 旋转 / 地址栏变化都要重算位置
  const onViewport = () => { if (shown) place(); };
  window.addEventListener('resize', onViewport);
  window.addEventListener('orientationchange', onViewport);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', onViewport);
    window.visualViewport.addEventListener('scroll', onViewport);
  }

  // 回车发送、Esc 关闭；stopPropagation 保证不会顺带触发游戏热键
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); submit(); return; }
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  input.addEventListener('keyup', (e) => e.stopPropagation());

  // pointerdown + preventDefault：多点触控下可靠，也不会先被 input 的 blur 抢走点击
  const tap = (el, fn) => {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    });
  };
  tap(sendBtn, submit);
  tap(closeBtn, close);
  // 点遮罩空白处 = 放弃输入，关闭（和「各大游戏」一致；内容不清空也不发送）
  tap(root, close);
  // 点输入条自己不要冒泡到遮罩（否则点一下输入条就把自己关了）
  sheet.addEventListener('pointerdown', (e) => e.stopPropagation());

  // input 暴露出来：自检脚本要直接敲键盘（它不弹真键盘），外部也能预填内容
  return { root, input, open, close, isOpen: () => shown, place };
}
