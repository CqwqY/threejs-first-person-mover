// 职责：商人「小满」的商店浮层。全屏白底、顶部标题栏 + 右上角关闭，与背包浮层同一套观感。
// 商品卡片：图标、名称、说明、价格、购买按钮；已购商品显示「已拥有」。
import { SHOP_ITEMS } from '../player/Shop.js';

export function createShopPanel({ onBuy, onRedeem }) {
  const ov = document.createElement('div');
  ov.style.cssText =
    'position:fixed;z-index:9700;top:0;left:0;width:100vw;height:100vh;overflow:auto;' +
    'background:rgba(255,255,255,.97);box-sizing:border-box;padding:70px 24px 40px;display:none;' +
    'font:14px/1.5 system-ui,"Microsoft YaHei",sans-serif;color:#1f2933;';
  ov.innerHTML =
    '<div style="position:fixed;top:0;left:0;right:0;z-index:1;display:flex;justify-content:space-between;align-items:center;' +
    'background:linear-gradient(150deg,#c99a3b,#8a6416);color:#fff;padding:14px 18px;box-sizing:border-box;">' +
    '<h2 style="margin:0;font-size:17px;font-weight:700;">小满的杂货铺</h2>' +
    '<div style="display:flex;align-items:center;gap:14px;">' +
    '<span class="shop-coins" style="font-weight:600;">学币 0</span>' +
    '<button type="button" class="shop-bar-close" style="border:0;background:rgba(255,255,255,.2);color:#fff;cursor:pointer;' +
    'font-size:16px;width:34px;height:34px;border-radius:8px;">×</button></div></div>' +
    '<p style="margin:0 0 14px;color:#7b8794;">用学币换点好玩的东西。击败一次老师拿 50 学币。</p>' +
    '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:0 0 18px;">' +
    '<input class="shop-code" type="text" placeholder="输入兑换码" autocomplete="off" spellcheck="false" ' +
    'style="font:14px/1.4 system-ui,\'Microsoft YaHei\',sans-serif;color:#1f2933;border:1px solid #cbd5e1;' +
    'border-radius:8px;padding:8px 10px;background:#fff;min-width:180px;" />' +
    '<button class="shop-redeem" type="button" style="border:0;cursor:pointer;border-radius:8px;padding:9px 18px;' +
    'color:#fff;font-weight:600;background:linear-gradient(150deg,#c99a3b,#8a6416);">兑换</button>' +
    '<span class="shop-redeem-msg" style="font-size:13px;color:#7b8794;"></span></div>' +
    '<div class="shop-grid"></div>';
  document.body.appendChild(ov);

  const coinsEl = ov.querySelector('.shop-coins');
  const grid = ov.querySelector('.shop-grid');
  const codeInput = ov.querySelector('.shop-code');
  const redeemMsg = ov.querySelector('.shop-redeem-msg');
  ov.querySelector('.shop-bar-close').addEventListener('click', () => { ov.style.display = 'none'; });
  ov.querySelector('.shop-redeem').addEventListener('click', submitCode);
  codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitCode(); });

  function submitCode() {
    const r = onRedeem(codeInput.value);
    redeemMsg.style.color = r.ok ? '#2e7d32' : '#b03030';
    redeemMsg.textContent = r.ok ? ('兑换成功，+' + r.value + ' 学币') : r.reason;
    if (r.ok) codeInput.value = '';
  }

  // getState() 由 Game 注入：返回 { coins, owned:[id] }，保证界面与钱包永远一致
  let getState = () => ({ coins: 0, owned: [] });

  function render() {
    const st = getState();
    coinsEl.textContent = '学币 ' + st.coins;
    grid.innerHTML = '';
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:14px;padding-top:6px;';
    for (const item of SHOP_ITEMS) {
      const owned = st.owned.includes(item.id);
      const card = document.createElement('div');
      card.style.cssText =
        'display:flex;flex-direction:column;gap:8px;padding:16px 14px;border:1px solid #e2e8f0;' +
        'border-radius:14px;background:#fff;box-shadow:0 4px 14px rgba(0,0,0,.06);';

      const head = document.createElement('div');
      head.style.cssText = 'display:flex;align-items:center;gap:10px;';
      const icon = document.createElement('div');
      icon.textContent = item.name.charAt(0);
      icon.style.cssText =
        'width:42px;height:42px;border-radius:12px;display:flex;align-items:center;justify-content:center;' +
        'background:linear-gradient(150deg,#c99a3b,#8a6416);color:#fff;font-weight:700;font-size:19px;flex:0 0 auto;';
      const title = document.createElement('div');
      title.textContent = item.name;
      title.style.cssText = 'font-weight:700;font-size:15px;';
      head.appendChild(icon);
      head.appendChild(title);

      const desc = document.createElement('div');
      desc.textContent = item.desc;
      desc.style.cssText = 'color:#52606d;font-size:13px;min-height:38px;';

      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;';
      const price = document.createElement('div');
      price.textContent = owned ? '已拥有' : (item.price + ' 学币');
      price.style.cssText = 'font-weight:700;color:' + (owned ? '#7b8794' : '#b07d16') + ';';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = owned ? '已拥有' : '购买';
      btn.disabled = owned;
      btn.style.cssText =
        'border:0;cursor:pointer;border-radius:8px;padding:6px 18px;color:#fff;font-weight:600;' +
        'background:' + (owned ? '#cbd5e1' : 'linear-gradient(150deg,#c99a3b,#8a6416)') + ';';
      btn.addEventListener('click', () => { onBuy(item.id); });

      row.appendChild(price);
      row.appendChild(btn);
      card.appendChild(head);
      card.appendChild(desc);
      card.appendChild(row);
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
