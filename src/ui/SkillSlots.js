// 职责：技能槽 UI。阿花放进背包的物品在这里变成可触发技能：
//   手机：竖直一列，排在跳跃键上方；
//   PC  ：横向一排，靠屏右下角。
// 固定 SLOT_COUNT 个槽位，每个槽绑定一个触发键（PC 数字键 1..N），点击槽位或按下对应键触发。
// 物品可被「指定」到某个具体槽位（背包里选槽位后点使用即可）。
export const SKILL_KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8'];
export const SLOT_COUNT = SKILL_KEYS.length;
const COOLDOWN = 800; // 相邻两次触发的最小间隔（毫秒）

export function createSkillSlots() {
  const coarse =
    (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
    'ontouchstart' in window;

  const box = document.createElement('div');
  box.style.cssText = coarse
    ? 'position:fixed;right:22px;bottom:116px;z-index:52;display:flex;flex-direction:column;align-items:center;gap:8px;'
    : 'position:fixed;right:18px;bottom:22px;z-index:52;display:flex;align-items:center;gap:8px;';
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

  // 预建全部槽位；空槽只显示快捷键，装备后显示技能名。
  for (let i = 0; i < SLOT_COUNT; i++) {
    const keyName = SKILL_KEYS[i];
    const el = document.createElement('div');
    el.style.cssText =
      'min-width:56px;height:56px;border-radius:12px;box-sizing:border-box;' +
      'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;' +
      'background:rgba(10,16,26,.78);color:#fff;border:1px solid rgba(255,255,255,.28);' +
      'box-shadow:0 4px 12px rgba(0,0,0,.35);user-select:none;cursor:pointer;' +
      'font:12px/1.2 system-ui,"Microsoft YaHei",sans-serif;text-align:center;';
    const label = document.createElement('div');
    label.style.cssText =
      'font-weight:600;max-width:50px;padding:0 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    el.appendChild(label);
    const keyEl = document.createElement('div');
    keyEl.textContent = keyName.slice(-1);
    keyEl.style.cssText = 'font-size:10px;color:rgba(255,255,255,.5);';
    el.appendChild(keyEl);

    const slot = { el, labelEl: label, act: null, name: '', cdUntil: 0, keyName };
    el.addEventListener('click', () => fire(slot));
    box.appendChild(el);
    slots.push(slot);
    paint(slot);
  }

  // 空槽显示「空」，有技能显示技能名
  function paint(slot) {
    slot.labelEl.textContent = slot.act ? (slot.name || '技能') : '空';
    slot.labelEl.style.color = slot.act ? '#fff' : 'rgba(255,255,255,.35)';
  }

  // 指定装备到第 index 槽（0 起）。返回 true 表示成功。
  function assign(index, opts) {
    const slot = slots[index];
    if (!slot) return false;
    slot.name = opts.label || '技能';
    slot.act = opts.onActivate || null;
    paint(slot);
    return true;
  }

  // 清空某个槽位
  function clearSlot(index) {
    const slot = slots[index];
    if (!slot) return;
    slot.name = '';
    slot.act = null;
    paint(slot);
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
