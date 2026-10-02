// 职责：学币钱包与商店商品表。
// 学币和「已购买」清单都写在 localStorage 里、按账号隔离：同一个账号在任意客户端打开读到的
// 都是同一份（这就是「一个账户互联」）；游客用独立的 guest 键，不与任何账号混用。
import { Config } from '../config.js';

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
];

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

// 购买：已有 / 学币不够都会拒绝。成功返回 { ok:true, coins }，失败返回 { ok:false, reason }。
export function buyItem(profile, itemId) {
  const item = SHOP_ITEMS.find((it) => it.id === itemId);
  if (!item) return { ok: false, reason: '没有这件商品' };
  const w = loadWallet(profile);
  if (w.owned.includes(item.id)) return { ok: false, reason: '已经买过了' };
  if (w.coins < item.price) return { ok: false, reason: '学币不够（还差 ' + (item.price - w.coins) + '）' };
  w.coins -= item.price;
  w.owned.push(item.id);
  saveWallet(profile, w);
  return { ok: true, coins: w.coins, item };
}

// 击败老师之类的奖励入口统一走这里，方便以后调数值
export function rewardBossKill(profile) {
  return addCoins(profile, Config.BOSS_COIN_REWARD);
}

// 兑换码：大小写不敏感，每个账号每个码只能用一次。
// 成功返回 { ok:true, coins, value }，失败返回 { ok:false, reason }。
export function redeemCode(profile, code) {
  const c = String(code || '').trim().toLowerCase();
  if (!c) return { ok: false, reason: '请输入兑换码' };
  const codes = Config.REDEEM_CODES || {};
  if (!Object.prototype.hasOwnProperty.call(codes, c)) return { ok: false, reason: '兑换码无效' };
  const value = Math.max(0, Math.floor(Number(codes[c]) || 0));
  const w = loadWallet(profile);
  if (w.redeemed.includes(c)) return { ok: false, reason: '这个兑换码已经兑换过了' };
  w.coins += value;
  w.redeemed.push(c);
  saveWallet(profile, w);
  return { ok: true, coins: w.coins, value };
}
