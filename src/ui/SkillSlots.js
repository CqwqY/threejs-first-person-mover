// 职责：技能槽 UI。阿花放进背包的物品在这里变成可触发技能：
//   手机：竖直一列，排在跳跃键上方，从下到上排列；
//   PC  ：横向一排，靠屏右下角。
// 每个槽绑定一个触发键（PC 数字键 1..N），点击槽位或按下对应键都会触发 onActivate。
export const SKILL_KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8'];
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

  // 注册一个技能槽。返回绑定的触发键名（如 'Digit1'）。
  function registerSkill(opts) {
    const n = slots.length + 1;
    const keyName = SKILL_KEYS[n - 1] || '';

    const el = document.createElement('div');
    el.style.cssText =
      'min-width:56px;height:56px;border-radius:12px;box-sizing:border-box;' +
      'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;' +
      'background:rgba(10,16,26,.78);color:#fff;border:1px solid rgba(255,255,255,.28);' +
      'box-shadow:0 4px 12px rgba(0,0,0,.35);user-select:none;cursor:pointer;' +
      'font:12px/1.2 system-ui,"Microsoft YaHei",sans-serif;text-align:center;';
    const label = document.createElement('div');
    label.textContent = opts.label || '技能' + n;
    label.style.cssText =
      'font-weight:600;max-width:50px;padding:0 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    el.appendChild(label);
    if (!coarse && keyName) {
      const keyEl = document.createElement('div');
      keyEl.textContent = keyName.slice(-1);
      keyEl.style.cssText = 'font-size:10px;color:rgba(255,255,255,.5);';
      el.appendChild(keyEl);
    }

    const slot = { el, act: opts.onActivate || null, cdUntil: 0, keyName };
    el.addEventListener('click', () => fire(slot));
    box.appendChild(el);
    slots.push(slot);
    return keyName;
  }

  const keyHandler = (e) => {
    if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) return;
    const slot = slots.find((s) => s.keyName && s.keyName === e.code);
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

  return { registerSkill, dispose };
}