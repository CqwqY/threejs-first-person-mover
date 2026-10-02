// 职责：技能槽 UI。阿花放进背包的物品在这里变成可触发技能：
//   手机：竖直一列，排在跳跃键上方；尺寸随屏幕自适应；空槽不显示；
//         触摸优先级高于右侧转视角区（z-index 更高、slot 自行捕获指针）。
//   PC  ：横向一排，靠屏右下角。
// 固定 SLOT_COUNT 个槽位，每个槽绑定一个触发键（PC 数字键 1..N），点击槽位或按下对应键触发。
// 物品可被「指定」到某个具体槽位（背包里选槽位后点使用即可）。
import { ensureTheme } from './theme.js';

export const SKILL_KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8'];
export const SLOT_COUNT = SKILL_KEYS.length;
const COOLDOWN = 800; // 相邻两次触发的最小间隔（毫秒）

export function createSkillSlots() {
  ensureTheme();
  const coarse =
    (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
    'ontouchstart' in window;

  const box = document.createElement('div');
  box.className = 'sk-box ' + (coarse ? 'sk-box--mobile' : 'sk-box--desk');
  // 容器不拦截触摸：只有具体槽位可点，缝隙仍可用来转视角
  box.style.position = 'fixed';
  box.style.zIndex = '60';
  box.style.display = 'flex';
  box.style.pointerEvents = 'none';
  if (coarse) {
    // 手机：竖直一列，排在跳跃键上方；尺寸随屏幕自适应
    box.style.right = 'calc(env(safe-area-inset-right, 0px) + 14px)';
    box.style.bottom = '118px';
    box.style.flexDirection = 'column';
    box.style.alignItems = 'center';
    box.style.gap = 'clamp(5px, 2vmin, 9px)';
    box.style.maxHeight = 'calc(var(--app-vh, 100vh) - 140px)';
  } else {
    // PC：横向一排，靠屏右下角
    box.style.right = '18px';
    box.style.bottom = '22px';
    box.style.flexDirection = 'row';
    box.style.alignItems = 'center';
    box.style.gap = '8px';
  }
  document.body.appendChild(box);

  const slots = [];

  function fire(slot) {
    const now = performance.now();
    if (now < slot.cdUntil || !slot.act) return;
    slot.cdUntil = now + COOLDOWN;
    slot.el.style.opacity = '0.55';
    setTimeout(() => { slot.el.style.opacity = '1'; }, COOLDOWN);
    slot.act();
  }

  // 空槽显示「空」，有技能显示技能名；手机上空槽直接隐藏，容器内没有可用技能时整个容器隐藏
  function paint(slot) {
    slot.labelEl.textContent = slot.act ? (slot.name || '技能') : '空';
    slot.labelEl.style.color = slot.act ? 'var(--kui-ink)' : 'var(--kui-ink-soft)';
    slot.el.style.display = (coarse && !slot.act) ? 'none' : '';
  }
  function refreshBox() {
    const any = slots.some((s) => s.act);
    box.style.display = (!coarse || any) ? 'flex' : 'none';
  }

  // 预建全部槽位
  for (let i = 0; i < SLOT_COUNT; i++) {
    const keyName = SKILL_KEYS[i];
    const el = document.createElement('div');
    el.className = 'sk-slot kui-iconbtn';
    // 触摸优先：槽位自身捕获指针，容器缝隙仍可转视角
    el.style.pointerEvents = 'auto';
    el.style.touchAction = 'none';
    el.style.userSelect = 'none';
    el.style.setProperty('-webkit-user-select', 'none');
    el.style.cursor = 'pointer';
    el.style.flexDirection = 'column';
    el.style.alignItems = 'center';
    el.style.justifyContent = 'center';
    el.style.gap = '2px';
    el.style.textAlign = 'center';
    el.style.fontFamily = 'var(--kui-font)';
    if (coarse) {
      // 尺寸用 vmin（短边）而不是 vw——vw 在旋转后宽度翻倍会让控件突然变大
      el.style.width = 'clamp(42px, 12vmin, 58px)';
      el.style.height = 'clamp(42px, 12vmin, 58px)';
      el.style.fontSize = 'clamp(10px, 2.8vmin, 12px)';
    } else {
      el.style.minWidth = '56px';
      el.style.height = '56px';
      el.style.fontSize = '12px';
    }
    const label = document.createElement('div');
    label.className = 'sk-label';
    label.style.fontWeight = '600';
    label.style.maxWidth = '100%';
    label.style.padding = '0 4px';
    label.style.overflow = 'hidden';
    label.style.textOverflow = 'ellipsis';
    label.style.whiteSpace = 'nowrap';
    el.appendChild(label);
    const keyEl = document.createElement('div');
    keyEl.className = 'sk-key kui-num';
    keyEl.style.fontSize = 'clamp(9px, 2.4vmin, 10px)';
    keyEl.style.color = 'var(--kui-ink-soft)';
    keyEl.textContent = keyName.slice(-1);
    el.appendChild(keyEl);

    const slot = { el, labelEl: label, act: null, name: '', cdUntil: 0, keyName };
    // 触摸优先：自行捕获指针并阻止冒泡，确保点击技能槽不会同时被转视角区吃掉。
    // 直接按下即触发（不等 click）：多点触控时另一只手正按住摇杆，合成的 click 常常不派发，
    // 会导致「边走边点技能」没反应。
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      fire(slot);
    });
    box.appendChild(el);
    slots.push(slot);
    paint(slot);
  }
  refreshBox();

  // 指定装备到第 index 槽（0 起）。返回 true 表示成功。
  function assign(index, opts) {
    const slot = slots[index];
    if (!slot) return false;
    slot.name = opts.label || '技能';
    slot.act = opts.onActivate || null;
    paint(slot);
    refreshBox();
    return true;
  }

  // 清空某个槽位
  function clearSlot(index) {
    const slot = slots[index];
    if (!slot) return;
    slot.name = '';
    slot.act = null;
    paint(slot);
    refreshBox();
  }

  // 自动找一个空槽装备（用于阿花给物品时自动入槽）。满了返回 null。
  function registerSkill(opts) {
    const idx = slots.findIndex((s) => !s.act);
    if (idx < 0) return null;
    assign(idx, opts);
    return slots[idx].keyName;
  }

  const keyHandler = (e) => {
    if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) return;
    const slot = slots.find((s) => s.keyName === e.code);
    if (slot) {
      e.preventDefault();
      fire(slot);
    }
  };
  window.addEventListener('keydown', keyHandler);

  function dispose() {
    window.removeEventListener('keydown', keyHandler);
    box.remove();
  }

  return { assign, clearSlot, registerSkill, dispose };
}
