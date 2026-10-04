// 职责：电脑端「操作说明」——用 Kenney Input Prompts Pixel 的键位图块列出实际按键。
//
// 为什么做成独立模块：
//   键位表会随玩法改动（骑车加档位、对战加技能…），散在面板 HTML 里很容易和真实绑定脱节。
//   这里把「动作 → 键位」集中成一份数据，绑定真变了只改这一处。
//
// 图块来自 public/ui/keys/*.png（16x16 像素画，由 tools/extract-input-prompts.mjs 从
// 官方 816 格图集切出）。像素画**不能平滑缩放**，所以靠 .kui-key 的 image-rendering 控制。
import { ensureTheme } from './theme.js';

// 动作 → 键位。键名对应 public/ui/keys 下的文件名（无扩展名）。
//
// ⚠⚠ 这份表**必须和 src/config.js 的真实绑定对齐**，别凭记忆写：
//   NPC_KEY / VEHICLE_KEY 都是 'KeyF'（一个键两用：靠近阿花是对话，靠近车是上下车）
//   PICKUP_KEY='KeyE'（拾取掉落物，不是对话！）· BOSS_SHIELD_KEY='KeyQ'
//   SOUL_KEY='KeyP'（灵魂出窍）· DROP_MODIFIER_KEY='KeyY'（+数字键丢指定槽位）
//   F5 切人称在 Game 构造里硬编码（不是 config）
//   改绑定时回来同步这个表，否则面板就在骗人了。
export const KEYBINDS = [
  {
    group: '移动',
    items: [
      { keys: ['w', 'a', 's', 'd'], label: '前后左右' },
      { keys: ['shift'], label: '冲刺（消耗体力）' },
      { keys: ['space'], label: '跳跃 / 喷气上升' },
    ],
  },
  {
    group: '视角与交互',
    items: [
      { keys: ['mouseL'], label: '攻击（需先点画面锁定鼠标）' },
      { keys: ['f5'], label: '切换第一 / 第三人称' },
      { keys: ['e'], label: '拾取脚下的掉落物' },
      { keys: ['f'], label: '与阿花对话 / 上下车（看靠近谁）' },
    ],
  },
  {
    group: '载具',
    items: [
      { keys: ['w', 's'], label: '前进 / 倒车' },
      { keys: ['a', 'd'], label: '转向' },
      { keys: ['space'], label: '刹车' },
    ],
  },
  {
    group: '战斗与物品',
    items: [
      { keys: ['q'], label: '开启护盾（对战）' },
      { keys: ['p'], label: '灵魂出窍' },
      { keys: ['d1', 'd2', 'd3'], label: '切换技能槽' },
      { keys: ['y', 'd1'], label: '丢弃指定槽位物品' },
      { keys: ['esc'], label: '关闭面板 / 暂停' },
    ],
  },
];

// 键位图块 URL。文件名里没有扩展名，这里统一补。
// 用 Vite 的 BASE_URL 走相对路径，这样部署到子路径（GitHub Pages 项目页）也不会 404。
function keyUrl(name) {
  return `${import.meta.env?.BASE_URL || '/'}ui/keys/${name}.png`;
}

// 造一个键位图块元素
function keyEl(name) {
  const s = document.createElement('span');
  s.className = 'kui-key';
  s.style.backgroundImage = `url("${keyUrl(name)}")`;
  s.setAttribute('aria-hidden', 'true');
  return s;
}

// 导出给 HUD 用：把键位图块**贴到按钮上**（「攻击」贴左键、「护盾」贴 Q…）。
//
// 为什么不在设置面板里列一张表就完事：玩家在打 Boss 的那一刻，眼睛看的是屏幕中间那颗按钮，
// 不是设置面板——键位得写在按钮本身上才叫说明。面板里那份完整键位表是「回头查」用的，两者互补。
//
// 用法：btn.appendChild(keyBadge('mouseL')); btn.appendChild(文字 span)
// 外观在 theme.js 的 .kui-btn--key 里（横排居中），这里只管图块本体。
export function keyBadge(name, { size = '1.5em' } = {}) {
  const s = keyEl(name);
  s.style.width = size;
  s.style.height = size;
  s.style.flex = '0 0 auto';
  return s;
}

// 造「[W][A][S][D] 前后左右」这样一行
function bindRow(keys, label) {
  const row = document.createElement('div');
  row.style.cssText =
    'display:flex;align-items:center;gap:5px;padding:3px 0;font-size:12px;color:var(--kui-ink-soft);';
  const kb = document.createElement('span');
  kb.style.cssText = 'display:flex;align-items:center;gap:2px;flex:0 0 auto;min-width:88px;';
  for (const k of [].concat(keys)) kb.appendChild(keyEl(k));
  const lb = document.createElement('span');
  lb.textContent = label;
  row.appendChild(kb);
  row.appendChild(lb);
  return row;
}

// 建「操作说明」区块，返回元素。coarsePointer 为真时返回 null（手机不需要键盘提示）。
export function createKeyHints({ coarse = false } = {}) {
  ensureTheme();
  if (coarse) return null; // 手机上没有物理键盘，列 WASD 只会占地方

  const box = document.createElement('div');
  box.className = 'kui-panel__body key-hints';
  box.style.cssText =
    'border-top:1px solid var(--kui-blue-soft);margin-top:12px;padding-top:10px;';

  const title = document.createElement('div');
  title.style.cssText = 'font-weight:600;margin-bottom:4px;';
  title.textContent = '操作说明（电脑）';
  box.appendChild(title);

  const hint = document.createElement('div');
  hint.style.cssText = 'font-size:11px;line-height:1.6;color:var(--kui-ink-soft);margin-bottom:6px;';
  hint.textContent = '键位图块来自 Kenney Input Prompts。';
  box.appendChild(hint);

  for (const g of KEYBINDS) {
    const h = document.createElement('div');
    h.style.cssText =
      'font-size:11px;font-weight:700;color:var(--kui-blue-deep);letter-spacing:1px;margin:8px 0 2px;';
    h.textContent = g.group;
    box.appendChild(h);
    for (const it of g.items) box.appendChild(bindRow(it.keys, it.label));
  }
  return box;
}
