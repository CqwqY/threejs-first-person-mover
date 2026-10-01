// 职责：玩家背包（物品存放）。本地 localStorage 持久化，按账号隔离；
// 登录用户用自己的账号键，游客用独立的钥匙。阿花把物品放进背包就在这里落地。

export function getBagKey(profile = null) {
  const id = profile ? (profile.username || profile.nickname || '') : '';
  return 'fp_bag__' + (id || 'guest');
}

// 读整个背包：{ 物品名: 数量 }
export function loadBag(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || '{}');
  } catch (e) {
    return {};
  }
}

// 往背包加物品，返回该物品当前总数。
export function addToBag(key, item, n = 1) {
  const bag = loadBag(key);
  bag[item] = (bag[item] || 0) + n;
  try {
    localStorage.setItem(key, JSON.stringify(bag));
  } catch (e) {
    /* 存储满/不可用：内部态仍在本次会话有效 */
  }
  return bag[item];
}

// 从背包移除物品（销毁），返回剩余数量；减到 0 则整条删除。
export function removeFromBag(key, item, n = 1) {
  const bag = loadBag(key);
  if (!bag[item]) return 0;
  bag[item] = Math.max(0, bag[item] - n);
  if (bag[item] === 0) delete bag[item];
  try {
    localStorage.setItem(key, JSON.stringify(bag));
  } catch (e) {
    /* 存储不可用：本次会话内仍然生效 */
  }
  return bag[item] || 0;
}

// 背包内物品总件数
export function totalItems(bag) {
  return Object.entries(bag).reduce((s, [, v]) => s + v, 0);
}