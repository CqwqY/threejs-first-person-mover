// 职责：商人「小满」的商店浮层。全屏遮罩 + 居中的蓝色面板，顶部标题栏 + 右上角关闭。
// 顶部两个标签页：「道具」（原杂货铺商品）与「家具」（可摆放的 building 商品），点页签切换内容。
// 家具页签额外有：搜索框（按名称/描述过滤）、分类 chips（类目取自商品描述里的「（类目）」标注）、
// 商品卡片带模型预览图（public/furn-previews/<id>.png，加载失败回退矢量图标），悬停放大细看。
// 商品卡片：图标、名称、说明、价格、购买按钮；家具额外显示「剩 N 可摆」与「买了去摆放」。
import { getCatalog, unplacedCount } from '../player/Shop.js';
import { ensureTheme } from './theme.js';
import { itemIconSvg, itemIconKeyFor } from './itemIcons.js';

export function createShopPanel({ onBuy, onRedeem, onPlace, getProfile }) {
  const prof = getProfile || (() => null);
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
    '<div class="shop-furn-tools" style="display:none;">' +
    '<input class="shop-furn-search kui-input" type="text" placeholder="搜索家具：名称 / 描述关键词" autocomplete="off" spellcheck="false" ' +
    'style="width:100%;box-sizing:border-box;margin:0 0 10px;" />' +
    '<div class="shop-furn-cats" style="display:flex;gap:6px;flex-wrap:wrap;margin:0 0 14px;"></div>' +
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
  const furnTools = ov.querySelector('.shop-furn-tools');
  const furnSearch = ov.querySelector('.shop-furn-search');
  const furnCats = ov.querySelector('.shop-furn-cats');
  let tab = 'items';
  // 家具页签的过滤状态：furnQ 是搜索词，furnCat 是当前分类（'all' 或描述里标注的类目名）
  let furnQ = '';
  let furnCat = 'all';
  ov.querySelector('.shop-bar-close').addEventListener('click', () => { ov.style.display = 'none'; });
  ov.querySelector('.shop-redeem').addEventListener('click', submitCode);
  codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitCode(); });
  tabBtns.forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  // 搜索只重刷商品区，不动兑换码/页签状态（输入频繁，全量 render 会白重建分类条）
  furnSearch.addEventListener('input', () => { furnQ = furnSearch.value.trim(); renderGrid(); });

  function setTab(t) {
    tab = t === 'furniture' ? 'furniture' : 'items';
    tabBtns.forEach((b) => b.classList.toggle('is-active', b.dataset.tab === tab));
    render();
  }

  // 兑换走服务端（码表在服务端），所以是异步的：给「兑换中…」反馈并防连点，
  // 否则玩家连按会发好几个请求（虽然服务端只认第一次，但界面会乱）。
  let redeeming = false;
  async function submitCode() {
    if (redeeming) return;
    const raw = codeInput.value;
    if (!String(raw || '').trim()) {
      redeemMsg.style.color = 'var(--kui-danger)';
      redeemMsg.textContent = '请输入兑换码';
      return;
    }
    redeeming = true;
    redeemMsg.style.color = 'var(--kui-ink-soft)';
    redeemMsg.textContent = '兑换中…';
    let r;
    try {
      r = await onRedeem(raw);
    } catch (e) {
      r = { ok: false, reason: '兑换失败：' + (e && e.message ? e.message : e) };
    }
    redeeming = false;
    if (!r) r = { ok: false, reason: '兑换失败' };
    redeemMsg.style.color = r.ok ? 'var(--kui-ok)' : 'var(--kui-danger)';
    redeemMsg.textContent = r.ok ? ('兑换成功，+' + r.value + ' 学币') : r.reason;
    if (r.ok) codeInput.value = '';
  }

  // getState() 由 Game 注入：返回 { coins, owned:[id] }，保证界面与钱包永远一致
  let getState = () => ({ coins: 0, owned: [] });

  // 家具类目：直接取商品描述里的「（类目）」标注（卫浴/厨房/坐具 等），不另存一份数据
  function catOf(item) {
    const m = /（([^（）]+)）/.exec(String(item.desc || ''));
    return m ? m[1] : '其他';
  }

  // 家具卡片顶部的模型预览图：public/furn-previews/<id>.png（gen-furn-previews.mjs 生成）。
  // 加载失败（没生成过/新商品还没渲染预览）回退为矢量图标；悬停放大方便细看。
  function buildPreview(item) {
    const pv = document.createElement('div');
    pv.style.cssText =
      'height:92px;display:flex;align-items:center;justify-content:center;' +
      'border-radius:var(--kui-radius);background:#eaf2fb;';
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = item.name;
    img.src = (import.meta.env?.BASE_URL || './') + 'furn-previews/' + item.id + '.png';
    img.style.cssText =
      'max-width:94%;max-height:84px;object-fit:contain;position:relative;' +
      'transition:transform .15s ease;cursor:zoom-in;';
    img.addEventListener('mouseenter', () => { img.style.transform = 'scale(1.9)'; img.style.zIndex = '5'; });
    img.addEventListener('mouseleave', () => { img.style.transform = ''; img.style.zIndex = ''; });
    img.addEventListener('error', () => {
      pv.innerHTML = itemIconSvg(itemIconKeyFor(item), { size: '40px' });
      pv.style.color = 'var(--kui-blue-dark)';
    });
    pv.appendChild(img);
    return pv;
  }

  function makeCard(item, isFurn, st) {
    const card = document.createElement('div');
    card.style.cssText =
      'display:flex;flex-direction:column;gap:8px;padding:16px 14px;' +
      'border:2px solid var(--kui-blue-dark);border-radius:var(--kui-radius);' +
      'background:var(--kui-paper);box-shadow:var(--kui-shadow);';

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:10px;';
    const icon = document.createElement('div');
    icon.innerHTML = itemIconSvg(itemIconKeyFor(item), { size: '26px' });
    icon.style.cssText =
      'width:42px;height:42px;border-radius:var(--kui-radius);display:flex;align-items:center;justify-content:center;' +
      'background:var(--kui-blue);color:var(--kui-paper);flex:0 0 auto;';
    const title = document.createElement('div');
    title.textContent = item.name;
    title.style.cssText = 'font-weight:700;font-size:15px;color:var(--kui-ink);';
    head.appendChild(icon);
    head.appendChild(title);

    const desc = document.createElement('div');
    desc.textContent = item.desc;
    desc.style.cssText = 'color:var(--kui-ink-soft);font-size:13px;min-height:38px;';
    card.appendChild(head);
    if (isFurn) card.appendChild(buildPreview(item));
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
      price.textContent = item.price + ' 学币（背包 ' + unplacedCount(prof(), item.id) + ' 件可摆）';
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
    // 兑换码与说明只在「道具」页签显示；家具页签换成搜索 + 分类条 + 家具说明
    redeemRow.style.display = isFurn ? 'none' : 'flex';
    furnTools.style.display = isFurn ? 'block' : 'none';
    intro.textContent = isFurn
      ? '花学币买家具；买「建造锤」后按技能键进入建造模式即可摆放。可按分类筛选或直接搜索。'
      : '用学币换点好玩的东西。击败一次老师拿 50 学币。';

    grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:14px;padding-top:6px;';
    renderGrid(st);
  }

  // 分类 chips：点「全部/某类目」只重刷商品区。类目与数量从当前在售家具统计。
  function renderCats(allFurn) {
    const counts = new Map();
    for (const it of allFurn) {
      const c = catOf(it);
      counts.set(c, (counts.get(c) || 0) + 1);
    }
    furnCats.innerHTML = '';
    const mkChip = (label, key, n) => {
      const b = document.createElement('button');
      b.type = 'button';
      const active = furnCat === key;
      b.textContent = label + (n != null ? ' ' + n : '');
      b.style.cssText =
        'font-size:12px;padding:4px 12px;border-radius:999px;cursor:pointer;' +
        'border:1px solid var(--kui-blue-dark);' +
        'background:' + (active ? 'var(--kui-blue-dark)' : 'transparent') + ';' +
        'color:' + (active ? '#fff' : 'var(--kui-ink)') + ';';
      b.addEventListener('click', () => { furnCat = key; renderGrid(); });
      furnCats.appendChild(b);
    };
    mkChip('全部', 'all', allFurn.length);
    for (const [c, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) mkChip(c, c, n);
  }

  function renderGrid(stIn) {
    const st = stIn || getState();
    coinsEl.textContent = '学币 ' + st.coins;
    const isFurn = tab === 'furniture';
    grid.innerHTML = '';
    let list = getCatalog().filter((it) => (isFurn ? it.kind === 'building' : it.kind !== 'building'));
    if (isFurn) {
      renderCats(list);
      if (furnCat !== 'all') list = list.filter((it) => catOf(it) === furnCat);
      if (furnQ) {
        const q = furnQ.toLowerCase();
        list = list.filter((it) => (String(it.name) + ' ' + String(it.desc)).toLowerCase().includes(q));
      }
    }
    if (!list.length) {
      const e = document.createElement('div');
      e.textContent = isFurn
        ? (furnQ || furnCat !== 'all' ? '（没有符合的家具，换个词或点「全部」试试）' : '（暂无在售家具，去编辑器添加）')
        : '（暂无商品）';
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
