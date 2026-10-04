// 职责：玩家背包（物品存放）。本地 localStorage 持久化，按账号隔离；
// 登录用户用自己的账号键，游客用独立的钥匙。阿花把物品放进背包就在这里落地。
//
// 云存档（2026-10-04 加）：登录后背包还会同步到服务端 /api/bag，换设备/换浏览器打开是同一份。
// 同步策略 = 「按修订号后写覆盖」：每次本地改动 rev+1 并延迟上传；登录时拉服务端，
// 谁的 rev 大听谁的。这样两台设备交替玩不会互相丢东西，丢弃也真能丢掉（不会因取最大值而复活）。
// 老服务端没有 /api/bag → 请求失败静默降级为纯本地（与加这个功能之前完全一致）。
import { accountApi } from '../net/accountApi.js';

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

function writeBag(key, bag) {
  try {
    localStorage.setItem(key, JSON.stringify(bag));
  } catch (e) {
    /* 存储满/不可用：内部态仍在本次会话有效 */
  }
}

// 往背包加物品，返回该物品当前总数。
export function addToBag(key, item, n = 1) {
  const bag = loadBag(key);
  bag[item] = (bag[item] || 0) + n;
  writeBag(key, bag);
  bumpRev(key); // 云同步：本地改了就记一笔修订，稍后上传
  return bag[item];
}

// 从背包移除物品（销毁），返回剩余数量；减到 0 则整条删除。
export function removeFromBag(key, item, n = 1) {
  const bag = loadBag(key);
  if (!bag[item]) return 0;
  bag[item] = Math.max(0, bag[item] - n);
  if (bag[item] === 0) delete bag[item];
  writeBag(key, bag);
  bumpRev(key);
  return bag[item] || 0;
}

// 背包内物品总件数
export function totalItems(bag) {
  return Object.entries(bag).reduce((s, [, v]) => s + v, 0);
}

// ===================== 云同步 =====================

const REV_PREFIX = 'fp_bag_rev__'; // 修订号与背包本体分开存，避免污染背包 JSON
const PUSH_DELAY = 800;            // 连续操作（捡一堆东西）合并成一次上传

let cloud = null;   // { token, key }：登录态下的云存档身份；游客为 null
let timer = null;   // 上传防抖计时器

// 登录/资料变化时调用。token 为空（游客）即关闭云同步。
// ⚠ 资料没到也必须先关掉：那时 getBagKey 会退回 guest 键，一旦同步就会拿游客包覆盖账号的云端背包。
export function setBagAccount(token, profile) {
  const id = profile ? (profile.username || profile.nickname || '') : '';
  if (!token || !id) { cloud = null; return; }
  cloud = { token, key: getBagKey(profile) };
}

export function bagCloudEnabled() {
  return !!cloud;
}

function readRev(key) {
  const n = Number(localStorage.getItem(REV_PREFIX + key));
  return Number.isFinite(n) ? n : 0;
}

function writeRev(key, n) {
  try {
    localStorage.setItem(REV_PREFIX + key, String(n));
  } catch (e) { /* 存不下就下次再说，最坏结果是多同步一次 */ }
}

function bumpRev(key) {
  writeRev(key, readRev(key) + 1);
  schedulePush();
}

function schedulePush() {
  if (!cloud) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; pushBag(); }, PUSH_DELAY);
}

// 把本地背包整包上传。返回是否成功（失败不影响本地，下次改动会再试）。
export async function pushBag() {
  if (!cloud) return false;
  const { token, key } = cloud;
  const out = await accountApi('POST', '/api/bag', { bag: loadBag(key), rev: readRev(key) }, token);
  if (!out) return false;                       // 网络不通 / 老服务端：静默降级
  if (out.ok) { writeRev(key, out.rev || readRev(key)); return true; }
  if (out.error === 'stale' && out.bag) {       // 服务端那份更新：以它为准覆盖本地
    writeBag(key, out.bag);
    writeRev(key, out.rev || 0);
    return true;
  }
  return false;
}

// 把「游客背包」并入指定账号的背包（游客时捡的东西，登录后不能凭空消失）。
// 合并后清空游客包，避免下次登录再并一次。返回是否真的并入了东西。
export function takeGuestBag(key) {
  const guestKey = 'fp_bag__guest';
  if (!key || key === guestKey) return false;
  const guest = loadBag(guestKey);
  if (!Object.keys(guest).length) return false;
  const bag = loadBag(key);
  for (const k of Object.keys(guest)) bag[k] = (bag[k] || 0) + guest[k];
  writeBag(key, bag);
  try { localStorage.removeItem(guestKey); } catch (e) { /* 清不掉也只是下次重复并入，不会丢 */ }
  bumpRev(key);
  return true;
}

// 登录后拉一次服务端背包，按修订号决定谁覆盖谁。
// 返回 null = 没同步成功（游客 / 离线 / 老服务端）；否则 { changed, bag }，changed 表示本地被改写过。
export async function syncBag() {
  if (!cloud) return null;
  const { token, key } = cloud;
  const out = await accountApi('GET', '/api/bag', null, token);
  if (!out || !out.ok || !out.bag) return null;

  const localRev = readRev(key);
  const remoteRev = out.rev || 0;
  const before = JSON.stringify(loadBag(key));

  if (remoteRev > localRev) {
    writeBag(key, out.bag);                     // 别的设备更新过：采用云端
    writeRev(key, remoteRev);
  } else if (remoteRev < localRev) {
    await pushBag();                            // 本机离线时改过：把本地推上去
  } else {
    // 修订号相同（常见于第一次上云：两边都是 0）——本地空而云端有货时以云端为准，别把老存档冲掉
    const localEmpty = Object.keys(loadBag(key)).length === 0;
    if (localEmpty && Object.keys(out.bag).length > 0) writeBag(key, out.bag);
  }

  const after = JSON.stringify(loadBag(key));
  return { changed: after !== before, bag: loadBag(key) };
}
