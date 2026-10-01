// 职责：技能槽 UI。阿花放进背包的物品在这里变成可触发技能：
//   手机：竖直一列，排在跳跃键上方；尺寸随屏幕自适应；空槽不显示；
//         触摸优先级高于右侧转视角区（z-index 更高、slot 自行捕获指针）。
//   PC  ：横向一排，靠屏右下角。
// 固定 SLOT_COUNT 个槽位，每个槽绑定一个触发键（PC 数字键 1..N），点击槽位或按下对应键触发。
// 物品可被「指定」到某个具体槽位（背包里选槽位后点使用即可）。
export const SKILL_KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8'];
export const SLOT_COUNT = SKILL_KEYS.length;
const COOLDOWN = 800; // 相邻两次触发的最小间隔（毫秒）

let styleInjected = false;
function injectStyle() {
  if (styleInjected || typeof document === 'undefined') return;
  styleInjected = true;
  const st = document.createElement('style');
  st.textContent = `
    /* 容器不拦截触摸：只有具体槽位可点，缝隙仍可用来转视角 */
    .sk-box{position:fixed;z-index:60;display:flex;pointer-events:none;}
    .sk-box--mobile{right:calc(env(safe-area-inset-right, 0px) + 14px);bottom:118px;
      flex-direction:column;align-items:center;gap:clamp(5px, 2vw, 9px);max-height:calc(100vh - 140px);}
    .sk-box--desk{right:18px;bottom:22px;flex-direction:row;align-items:center;gap:8px;}
    /* 槽位尺寸自适应：小屏自动缩小，避免占满屏幕 */
    .sk-slot{pointer-events:auto;touch-action:none;user-select:none;-webkit-user-select:none;cursor:pointer;
      box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;
      background:rgba(10,16,26,.78);color:#fff;border:1px solid rgba(255,255,255,.28);
      box-shadow:0 4px 12px rgba(0,0,0,.35);border-radius:clamp(9px, 3vw, 13px);text-align:center;
      font-family:system-ui,"Microsoft YaHei",sans-serif;}
    .sk-box--mobile .sk-slot{width:clamp(42px, 13vw, 58px);height:clamp(42px, 13vw, 58px);
      font-size:clamp(10px, 3vw, 12px);}
    .sk-box--desk .sk-slot{min-width:56px;height:56px;font-size:12px;}
    .sk-label{font-weight:600;max-width:100%;padding:0 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .sk-key{font-size:clamp(9px, 2.6vw, 10px);color:rgba(255,255,255,.5);}
  `;
  document.head.appendChild(st);
}

export function createSkillSlots() {
  injectStyle();
  const coarse =
    (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
    'ontouchstart' in window;

  const box = document.createElement('div');
  box.className = 'sk-box ' + (coarse ? 'sk-box--mobile' : 'sk-box--desk');
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
    slot.labelEl.style.color = slot.act ? '#fff' : 'rgba(255,255,255,.35)';
    slot.el.style.display = (coarse && !slot.act) ? 'none' : '';
  }
  function refreshBox() {
    const any = slots.some((s) => s.act);
    box.style.display = (!coarse || any) ? '' : 'none';
  }

  // 预建全部槽位
  for (let i = 0; i < SLOT_COUNT; i++) {
    const keyName = SKILL_KEYS[i];
    const el = document.createElement('div');
    el.className = 'sk-slot';
    const label = document.createElement('div');
    label.className = 'sk-label';
    el.appendChild(label);
    const keyEl = document.createElement('div');
    keyEl.className = 'sk-key';
    keyEl.textContent = keyName.slice(-1);
    el.appendChild(keyEl);

    const slot = { el, labelEl: label, act: null, name: '', cdUntil: 0, keyName };
    // 触摸优先：自行捕获指针并阻止冒泡，确保点击技能槽不会同时被转视角区吃掉
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('click', (e) => { e.stopPropagation(); fire(slot); });
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
