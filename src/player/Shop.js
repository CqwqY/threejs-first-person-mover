// 职责：学币钱包与商店商品表。
// 学币和「已购买」清单都写在 localStorage 里、按账号隔离：同一个账号在任意客户端打开读到的
// 都是同一份（这就是「一个账户互联」）；游客用独立的 guest 键，不与任何账号混用。
import { Config } from '../config.js';
import { getBagKey, loadBag, addToBag, removeFromBag } from './Inventory.js';
import { markSaveDirty } from './CloudSave.js';
import { accountApi } from '../net/accountApi.js';

const KEY_PREFIX = 'fp_wallet__';

// 商店在售商品。effect 会写进物品效果表（与阿花给的东西同一套），
// 所以买到手之后进背包、指定到技能槽，按数字键就能用。
export const SHOP_ITEMS = [
  {
    id: 'club',
    name: '棍子',
    price: 100,
    desc: '挥动横扫，被扫到的玩家会被撞飞出去。',
    effect: { k: 'club' },
  },
  {
    id: 'blackhole',
    name: '黑洞',
    price: 150,
    desc: '扔出去后会不断变大，10 秒后把范围内的人吸过去。',
    effect: { k: 'blackhole' },
  },
  {
    id: 'hide',
    name: '捉迷藏玩具',
    price: 80,
    desc: '变成任意颜色的方块。开始前先选和谁玩、谁抓；每 30 秒向抓的人报告自己的模糊方向。',
    effect: { k: 'hide' },
  },
  {
    id: 'gatling',
    name: '加特林',
    price: 200,
    desc: '按技能槽开火模式后，按住鼠标左键持续扫射。单发 5 点伤害，打久了会过热。',
    effect: { k: 'gatling' },
  },
  {
    id: 'ctrlgun',
    name: '控制枪',
    price: 180,
    desc: '发射激光抓住别人，移动视角就能把他拖着走；对方可以按空格挣脱。',
    effect: { k: 'control' },
  },
  {
    id: 'grapple',
    name: '抓钩',
    price: 160,
    desc: '朝准星方向甩出钩爪，勾到墙/箱/柱子就把自己拽过去；空中再按一次即可松手。',
    effect: { k: 'grapple' },
  },
  {
    id: 'hammer',
    name: '建造锤',
    price: 300,
    desc: '装备到技能槽，按对应数字键（手机点技能键）进入建造模式：攻击键变「放置」，血条变可滚动家具条，另有「编辑」键。',
    effect: { k: 'hammer' },
  },
];

// 目录可被服务端覆盖：GET /api/shop 拉到的最新商品表。为 null 时回退到上面写死的 SHOP_ITEMS。
let CATALOG = null;
export function setCatalog(items) {
  if (Array.isArray(items)) CATALOG = items;
}
export function getCatalog() {
  return CATALOG || SHOP_ITEMS;
}
// 查商品：优先服务端目录，其次写死兜底（断网也能买）
export function findItem(itemId) {
  const id = String(itemId);
  const list = CATALOG || SHOP_ITEMS;
  return list.find((it) => it.id === id) || null;
}
// 按显示名查商品：背包只存名字，渲染图标/归类时需要用名字反查目录项
export function itemByName(name) {
  const n = String(name);
  const list = CATALOG || SHOP_ITEMS;
  return list.find((it) => it.name === n) || null;
}
// 家具（可摆放的 building 商品）的名字集合：背包用它把「家具」页签与普通道具分开。
// 家具按「名字」存进背包（背包只认名字），所以这里也以名字为键。
export function furnitureNames() {
  const set = new Set();
  for (const it of (CATALOG || SHOP_ITEMS)) if (it.kind === 'building') set.add(it.name);
  return set;
}
// 某玩家还没摆出来的家具数量 = 背包里该家具名的件数
// （家具买下即进背包，随背包云同步到账号；换设备也是同一份）
export function unplacedCount(profile, itemId) {
  const it = findItem(itemId);
  if (!it) return 0;
  return loadBag(getBagKey(profile))[it.name] || 0;
}
// 摆出成功后从背包消耗 1 件，返回剩余数量
export function consumeOwned(profile, itemId) {
  const it = findItem(itemId);
  if (!it) return 0;
  return removeFromBag(getBagKey(profile), it.name, 1);
}
// 一次性迁移：把旧版记在 wallet.owned 里的家具（按 id 计数）搬进背包（按名字计数）。
// 幂等：owned 里没有家具时是空操作。在拿到商店目录后调用即可。
export function migrateFurnitureToBag(profile) {
  const w = loadWallet(profile);
  const furn = (CATALOG || SHOP_ITEMS).filter((it) => it.kind === 'building');
  let moved = 0;
  for (const it of furn) {
    let n = 0;
    while (w.owned.includes(it.id)) { w.owned.splice(w.owned.indexOf(it.id), 1); n++; }
    if (n > 0) { addToBag(getBagKey(profile), it.name, n); moved += n; }
  }
  if (moved) saveWallet(profile, w);
  return moved;
}

function walletKey(profile) {
  const id = profile ? (profile.username || profile.nickname || '') : '';
  return KEY_PREFIX + (id || 'guest');
}

// 读钱包：{ coins: 学币数, owned: [已购商品 id], redeemed: [已用过的兑换码] }
export function loadWallet(profile) {
  try {
    const raw = JSON.parse(localStorage.getItem(walletKey(profile)) || '{}');
    return {
      coins: Math.max(0, Math.floor(Number(raw && raw.coins) || 0)),
      owned: Array.isArray(raw && raw.owned) ? raw.owned.map(String) : [],
      redeemed: Array.isArray(raw && raw.redeemed) ? raw.redeemed.map(String) : [],
    };
  } catch (e) {
    return { coins: 0, owned: [], redeemed: [] };
  }
}

function saveWallet(profile, w) {
  try {
    localStorage.setItem(walletKey(profile), JSON.stringify(w));
  } catch (e) {
    /* 存储不可用：本次会话内仍然是同一个对象，界面照常工作 */
  }
  markSaveDirty(); // 学币/已购是账号存档的一部分 → 触发云同步
}

// 加/扣学币。返回变动后的余额。
export function addCoins(profile, n) {
  const w = loadWallet(profile);
  w.coins = Math.max(0, w.coins + Math.floor(Number(n) || 0));
  saveWallet(profile, w);
  return w.coins;
}

export function isOwned(profile, itemId) {
  return loadWallet(profile).owned.includes(String(itemId));
}

// 购买：学币不够才拒绝；已拥有的商品可以重复购买（多买几个用来丢/送人）。
// owned 只记录「曾经买过」，用于界面标记与首购提示，不用于拦截。
// 成功返回 { ok:true, coins, item, repeat }，失败返回 { ok:false, reason }。
export function buyItem(profile, itemId) {
  const item = findItem(itemId);
  if (!item) return { ok: false, reason: '没有这件商品' };
  const w = loadWallet(profile);
  const repeat = w.owned.includes(item.id);
  if (w.coins < item.price) return { ok: false, reason: '学币不够（还差 ' + (item.price - w.coins) + '）' };
  w.coins -= item.price;
  // 家具不算「已拥有道具」（它进背包、按件数计），只有普通道具才记进 owned
  if (item.kind !== 'building' && !repeat) w.owned.push(item.id);
  saveWallet(profile, w);
  return { ok: true, coins: w.coins, item, repeat };
}

// 击败老师之类的奖励入口统一走这里，方便以后调数值
export function rewardBossKill(profile) {
  return addCoins(profile, Config.BOSS_COIN_REWARD);
}

// 兑换码：**校验与记账都在服务端**（POST /api/redeem），客户端不再内置码表。
// 为什么搬走：码表写在前端 = 谁都能从 JS 里翻出来；「用过没有」只记在本地 localStorage
// = 清一次缓存就能重复领。服务端按身份记账（登录 u:<id> / 游客 anon:<真实 IP>），
// 这里只负责把服务端返回的学币入账（并存一份本地 redeemed 记录，省掉重复请求）。
// token：登录会话令牌（游客传空串，服务端按 IP 记账）。
// 失败（网络不通 / 老服务端没有该接口）给一句人话，**不做本地兜底** —— 兜底就等于把码表又搬回前端。
// 成功返回 { ok:true, coins, value }，失败返回 { ok:false, reason }。
export async function redeemCode(profile, code, token) {
  const c = String(code || '').trim();
  if (!c) return { ok: false, reason: '请输入兑换码' };
  const out = await accountApi('POST', '/api/redeem', { code: c }, token);
  if (!out) return { ok: false, reason: '兑换服务暂时不可用，请稍后再试' };
  if (!out.ok) {
    const msg = String(out.error || '');
    // 老服务端没有这个接口时会回 not found —— 直接说人话，别让玩家以为是码错了
    if (msg === 'not found') return { ok: false, reason: '服务端还没更新（缺少兑换接口），请先更新后端' };
    return { ok: false, reason: msg || '兑换失败' };
  }
  const value = Math.max(0, Math.floor(Number(out.value) || 0));
  const key = c.toLowerCase().replace(/\s+/g, '');
  const w = loadWallet(profile);
  if (!w.redeemed.includes(key)) w.redeemed.push(key);
  w.coins += value;
  saveWallet(profile, w);
  return { ok: true, coins: w.coins, value };
}
