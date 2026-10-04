// 职责：商人「小满」的商店浮层。全屏遮罩 + 居中的蓝色面板，顶部标题栏 + 右上角关闭。
// 顶部两个标签页：「道具」（原杂货铺商品）与「家具」（可摆放的 building 商品），点页签切换内容。
// 商品卡片：图标、名称、说明、价格、购买按钮；家具额外显示「剩 N 可摆」与「买了去摆放」。
import { getCatalog, unplacedCount } from '../player/Shop.js';
import { ensureTheme } from './theme.js';

export function createShopPanel({ onBuy, onRedeem, onPlace }) {
  ensureTheme();
  const ov = document.createElement('div');
  // 外层保留原有的全屏遮罩结构（铺满视口、可滚动、安全的内边距与打开/关闭的 display 逻辑）
  ov.style.cssText =
    'position:fixed;z-index:9700;top:0;left:0;width:100vw;height:100vh;overflow:auto;' +
    'background:rgba(255,255,255,.97);box-sizing:border-box;padding:70px 24px 40px;display:none;' +
    'font:14px/1.5 system-ui,"Microsoft YaHei",sans-serif;color:#1f2933;';
  // 内部内容区整体包进蓝色的 kui 面板
  ov.innerHTML =
    '<div class="kui-panel"><div class="kui-panel__body">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:10px;">' +
    '<h2 class="kui-title" style="margin:0;font-size:17px;font-weight:700;">小满的杂货铺</h2>' +
    '<div style="display:flex;align-items:center;gap:14px;">' +
    '<span class="shop-coins" style="font-weight:600;">学币 0</span>' +
    '<button type="button" class="shop-bar-close kui-iconbtn">×</button>' +
    '</div></div>' +
    '<div class="kui-tabs">' +
    '<button type="button" class="kui-tab is-active" data-tab="items">道具</button>' +
    '<button type="button" class="kui-tab" data-tab="furniture">家具</button>' +
    '</div>' +
    '<p class="shop-intro" style="margin:0 0 14px;color:var(--kui-ink-soft);">用学币换点好玩的东西。击败一次老师拿 50 学币。</p>' +
    '<div class="shop-redeem-row" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:0 0 18px;">' +
    '<input class="shop-code kui-input" type="text" placeholder="输入兑换码" autocomplete="off" spellcheck="false" ' +
    'style="min-width:180px;width:auto;" />' +
    '<button class="shop-redeem kui-btn kui-btn--primary" type="button">兑换</button>' +
    '<span class="shop-redeem-msg" style="font-size:13px;color:var(--kui-ink-soft);"></span>' +
    '</div>' +
    '<div class="shop-grid"></div>' +
    '</div></div>';
  document.body.appendChild(ov);

  const coinsEl = ov.querySelector('.shop-coins');
  const grid = ov.querySelector('.shop-grid');
  const intro = ov.querySelector('.shop-intro');
  const redeemRow = ov.querySelector('.shop-redeem-row');
  const codeInput = ov.querySelector('.shop-code');
  const redeemMsg = ov.querySelector('.shop-redeem-msg');
  const tabBtns = Array.from(ov.querySelectorAll('.kui-tab'));
  let tab = 'items';
  ov.querySelector('.shop-bar-close').addEventListener('click', () => { ov.style.display = 'none'; });
  ov.querySelector('.shop-redeem').addEventListener('click', submitCode);
  codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitCode(); });
  tabBtns.forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

  function setTab(t) {
    tab = t === 'furniture' ? 'furniture' : 'items';
    tabBtns.forEach((b) => b.classList.toggle('is-active', b.dataset.tab === tab));
    render();
  }

  function submitCode() {
    const r = onRedeem(codeInput.value);
    redeemMsg.style.color = r.ok ? 'var(--kui-ok)' : 'var(--kui-danger)';
    redeemMsg.textContent = r.ok ? ('兑换成功，+' + r.value + ' 学币') : r.reason;
    if (r.ok) codeInput.value = '';
  }

  // getState() 由 Game 注入：返回 { coins, owned:[id] }，保证界面与钱包永远一致
  let getState = () => ({ coins: 0, owned: [] });

  function makeCard(item, isFurn, st) {
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
    card.appendChild(head);
    card.appendChild(desc);

    if (isFurn) {
      const badge = document.createElement('div');
      badge.textContent = '家具 · 购买后在建造工具(B)里摆放';
      badge.style.cssText = 'font-size:12px;color:var(--kui-blue);';
      card.appendChild(badge);
    }

    const owned = st.owned.includes(item.id);
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;';
    const affordable = st.coins >= item.price;
    const price = document.createElement('div');
    if (isFurn) {
      price.textContent = item.price + ' 学币（剩 ' + unplacedCount(st, item.id) + ' 可摆）';
      price.style.cssText = 'font-weight:700;color:var(--kui-ink);';
    } else {
      price.textContent = item.price + ' 学币' + (owned ? '（已拥有）' : '');
      price.style.cssText = 'font-weight:700;color:' + (owned ? 'var(--kui-ink-soft)' : 'var(--kui-ink)') + ';';
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'kui-btn kui-btn--primary';
    btn.textContent = isFurn ? '购买' : (owned ? '再买一个' : '购买');
    btn.disabled = !affordable;
    btn.addEventListener('click', () => { onBuy(item.id); });

    row.appendChild(price);
    row.appendChild(btn);
    card.appendChild(row);

    if (isFurn) {
      const placeRow = document.createElement('div');
      placeRow.style.cssText = 'margin-top:4px;';
      const placeBtn = document.createElement('button');
      placeBtn.type = 'button';
      placeBtn.className = 'kui-btn';
      placeBtn.style.cssText = 'width:100%;';
      placeBtn.textContent = '买了去摆放';
      placeBtn.addEventListener('click', () => { if (onPlace) onPlace(); });
      placeRow.appendChild(placeBtn);
      card.appendChild(placeRow);
    }
    return card;
  }

  function render() {
    const st = getState();
    coinsEl.textContent = '学币 ' + st.coins;
    const isFurn = tab === 'furniture';
    // 兑换码与说明只在「道具」页签显示；家具页签换成家具说明
    redeemRow.style.display = isFurn ? 'none' : 'flex';
    intro.textContent = isFurn
      ? '花学币买家具，买了在「家具摆放工具(B)」里摆到场景里。占位方块可先在编辑器导入真实模型替换。'
      : '用学币换点好玩的东西。击败一次老师拿 50 学币。';

    grid.innerHTML = '';
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:14px;padding-top:6px;';
    const list = getCatalog().filter((it) => (isFurn ? it.kind === 'building' : it.kind !== 'building'));
    if (!list.length) {
      const e = document.createElement('div');
      e.textContent = isFurn ? '（暂无在售家具，去编辑器添加）' : '（暂无商品）';
      e.style.cssText = 'color:var(--kui-ink-soft);';
      grid.appendChild(e);
      return;
    }
    for (const item of list) grid.appendChild(makeCard(item, isFurn, st));
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
