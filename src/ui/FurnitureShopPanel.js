// 职责：玩家侧的「家具商店」独立页面（与小满杂货铺分开）。
// 只列出 kind:'building' 的家具商品；玩家花学币买（消耗式：买 1 件得 1 个摆放额度），
// 买了可点「买了去摆放」直接打开建造工具(B)把家具摆到场景里（占位方块，编辑器可换真模型）。
import { getCatalog, unplacedCount } from '../player/Shop.js';
import { ensureTheme } from './theme.js';

export function createFurnitureShopPanel({ onBuy, onPlace }) {
  ensureTheme();
  const ov = document.createElement('div');
  // 外层全屏遮罩（铺满视口、可滚动、打开/关闭用 display 切换），复用 kui 面板样式
  ov.style.cssText =
    'position:fixed;z-index:9700;top:0;left:0;width:100vw;height:100vh;overflow:auto;' +
    'background:rgba(255,255,255,.97);box-sizing:border-box;padding:70px 24px 40px;display:none;' +
    'font:14px/1.5 system-ui,"Microsoft YaHei",sans-serif;color:#1f2933;';
  ov.innerHTML =
    '<div class="kui-panel"><div class="kui-panel__body">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:10px;">' +
    '<h2 class="kui-title" style="margin:0;font-size:17px;font-weight:700;">家具商店</h2>' +
    '<div style="display:flex;align-items:center;gap:14px;">' +
    '<span class="shop-coins" style="font-weight:600;">学币 0</span>' +
    '<button type="button" class="shop-bar-close kui-iconbtn">×</button>' +
    '</div></div>' +
    '<p style="margin:0 0 14px;color:var(--kui-ink-soft);">花学币买家具，买了在「家具摆放工具(B)」里摆到场景里。' +
    '占位方块可先在编辑器导入真实模型替换。</p>' +
    '<div class="shop-grid"></div>' +
    '</div></div>';
  document.body.appendChild(ov);

  const coinsEl = ov.querySelector('.shop-coins');
  const grid = ov.querySelector('.shop-grid');
  ov.querySelector('.shop-bar-close').addEventListener('click', () => { ov.style.display = 'none'; });

  // getState() 由 Game 注入：返回 { coins, owned:[id] }，保证界面与钱包永远一致
  let getState = () => ({ coins: 0, owned: [] });

  function render() {
    const st = getState();
    coinsEl.textContent = '学币 ' + st.coins;
    grid.innerHTML = '';
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:14px;padding-top:6px;';
    const items = getCatalog().filter((it) => it.kind === 'building');
    if (!items.length) {
      const e = document.createElement('div');
      e.textContent = '（暂无在售家具，去编辑器添加）';
      e.style.cssText = 'color:var(--kui-ink-soft);';
      grid.appendChild(e);
      return;
    }
    for (const item of items) {
      const avail = unplacedCount(st, item.id); // 还可摆的额度（= 已买未摆数量）
      const card = document.createElement('div');
      card.style.cssText =
        'display:flex;flex-direction:column;gap:8px;padding:16px 14px;' +
        'border:2px solid var(--kui-blue-dark);border-radius:var(--kui-radius);' +
        'background:var(--kui-paper);box-shadow:var(--kui-shadow);';

      const head = document.createElement('div');
      head.style.cssText = 'display:flex;align-items:center;gap:10px;';
      const icon = document.createElement('div');
      icon.textContent = item.name.charAt(0);
      icon.style.cssText =
        'width:42px;height:42px;border-radius:var(--kui-radius);display:flex;align-items:center;justify-content:center;' +
        'background:var(--kui-blue);color:var(--kui-paper);font-weight:700;font-size:19px;flex:0 0 auto;';
      const title = document.createElement('div');
      title.textContent = item.name;
      title.style.cssText = 'font-weight:700;font-size:15px;color:var(--kui-ink);';
      head.appendChild(icon);
      head.appendChild(title);

      const desc = document.createElement('div');
      desc.textContent = item.desc;
      desc.style.cssText = 'color:var(--kui-ink-soft);font-size:13px;min-height:38px;';

      const badge = document.createElement('div');
      badge.textContent = '家具 · 购买后在建造工具(B)里摆放';
      badge.style.cssText = 'font-size:12px;color:var(--kui-blue);';

      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;';
      const affordable = st.coins >= item.price;
      const price = document.createElement('div');
      price.textContent = item.price + ' 学币（剩 ' + avail + ' 可摆）';
      price.style.cssText = 'font-weight:700;color:var(--kui-ink);';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'kui-btn kui-btn--primary';
      btn.textContent = '购买';
      btn.disabled = !affordable;
      btn.addEventListener('click', () => { onBuy(item.id); });

      row.appendChild(price);
      row.appendChild(btn);

      const placeRow = document.createElement('div');
      placeRow.style.cssText = 'margin-top:4px;';
      const placeBtn = document.createElement('button');
      placeBtn.type = 'button';
      placeBtn.className = 'kui-btn';
      placeBtn.style.cssText = 'width:100%;';
      placeBtn.textContent = '买了去摆放';
      placeBtn.addEventListener('click', () => { if (onPlace) onPlace(); });
      placeRow.appendChild(placeBtn);

      card.appendChild(head);
      card.appendChild(desc);
      card.appendChild(badge);
      card.appendChild(row);
      card.appendChild(placeRow);
      grid.appendChild(card);
    }
  }

  return {
    el: ov,
    setState: (fn) => { getState = fn; },
    render,
    isOpen: () => ov.style.display !== 'none',
    open() { render(); ov.style.display = 'block'; },
    close() { ov.style.display = 'none'; },
    toggle() { if (this.isOpen()) this.close(); else this.open(); },
  };
}
