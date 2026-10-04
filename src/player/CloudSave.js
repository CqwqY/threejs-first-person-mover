// 职责：账号通用存档的云同步 —— 学币 / 已购道具 / 兑换码 / 技能槽 / 性别。
// 策略与 Inventory.js 的背包云同步一致：整包 JSON + 修订号（fp_save_rev__）「后写覆盖」，
// 登录时拉服务端 /api/state，谁的 rev 大听谁的；本地改动则 rev+1 并延迟上传。
//
// ⚠ 本模块直接读写 localStorage（键 fp_wallet__ / fp_skill_slots__ / fpm-gender），
//   故意**不 import** Shop.js / Game.js —— 否则会与它们的 markSaveDirty() 形成循环依赖。
//   键名与那两处保持一致，改键名时三处都要改。
import { accountApi } from '../net/accountApi.js';

const REV_PREFIX = 'fp_save_rev__';
const PUSH_DELAY = 800;              // 连续改动（买东西/丢东西）合并成一次上传
const GENDER_KEY = 'fpm-gender';

let cloud = null;   // { token, id }：登录态下的存档身份；游客为 null
let timer = null;

function idOf(profile) {
  return (profile && (profile.username || profile.nickname)) || 'guest';
}
const walletKey = (id) => 'fp_wallet__' + id;
const skillKey = (id) => 'fp_skill_slots__' + id;

function readJSON(key) { try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (e) { return {}; } }
function writeJSON(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* 存储不可用 */ } }
function readRev(id) { const n = Number(localStorage.getItem(REV_PREFIX + id)); return Number.isFinite(n) ? n : 0; }
function writeRev(id, n) { try { localStorage.setItem(REV_PREFIX + id, String(n)); } catch (e) { /* ignore */ } }

// 本地五样东西 → 一个存档对象
function readBlob(id) {
  const w = readJSON(walletKey(id));
  return {
    coins: Math.max(0, Math.floor(Number(w.coins) || 0)),
    owned: Array.isArray(w.owned) ? w.owned.map(String) : [],
    redeemed: Array.isArray(w.redeemed) ? w.redeemed.map(String) : [],
    skillMap: readJSON(skillKey(id)),
    gender: localStorage.getItem(GENDER_KEY) === 'girl' ? 'girl' : 'boy',
  };
}

// 存档对象 → 写回本地键（保留钱包里其它字段，如日后新增的字段）
function applyBlob(id, data) {
  const d = data || {};
  const w = readJSON(walletKey(id));
  writeJSON(walletKey(id), {
    ...w,
    coins: Math.max(0, Math.floor(Number(d.coins) || 0)),
    owned: Array.isArray(d.owned) ? d.owned.map(String) : [],
    redeemed: Array.isArray(d.redeemed) ? d.redeemed.map(String) : (Array.isArray(w.redeemed) ? w.redeemed : []),
  });
  writeJSON(skillKey(id), (d.skillMap && typeof d.skillMap === 'object' && !Array.isArray(d.skillMap)) ? d.skillMap : {});
  try { localStorage.setItem(GENDER_KEY, d.gender === 'girl' ? 'girl' : 'boy'); } catch (e) { /* ignore */ }
}

// 「空存档」判定：用于首次上云时决定谁覆盖谁（避免空本地冲掉云端存档）
function blobEmpty(b) {
  if (!b) return true;
  const owned = Array.isArray(b.owned) ? b.owned.length : 0;
  const skills = (b.skillMap && typeof b.skillMap === 'object') ? Object.keys(b.skillMap).length : 0;
  return !(Number(b.coins) > 0 || owned > 0 || skills > 0);
}

// 登录/资料变化时调用。token 为空（游客）即关闭云同步（游客存档只在本机）。
export function setSaveAccount(token, profile) {
  const id = idOf(profile);
  if (!token || !id || id === 'guest') { cloud = null; return; }
  cloud = { token, id };
}
export function saveCloudEnabled() { return !!cloud; }

function schedulePush() {
  if (!cloud) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; pushSave(); }, PUSH_DELAY);
}

// 本地改动（买/丢东西、改技能槽）后调用：记一笔修订，稍后上传。
export function markSaveDirty() {
  if (!cloud) return;
  writeRev(cloud.id, readRev(cloud.id) + 1);
  schedulePush();
}

// 把本地整包上传。成功返回 true（失败不影响本地，下次改动会再试）。
export async function pushSave() {
  if (!cloud) return false;
  const { token, id } = cloud;
  const out = await accountApi('POST', '/api/state', { data: readBlob(id), rev: readRev(id) }, token);
  if (!out) return false;                        // 网络不通 / 老服务端：静默降级
  if (out.ok) { writeRev(id, out.rev || readRev(id)); return true; }
  if (out.error === 'stale' && out.data) {       // 服务端更新：以它为准覆盖本地
    applyBlob(id, out.data);
    writeRev(id, out.rev || 0);
    return true;
  }
  return false;
}

// 登录后拉一次服务端存档，按修订号决定谁覆盖谁。
// opts.forceGender：本次登录界面明确选了性别 → 用本地那份（用户的当场选择优先于云端旧值）。
// 返回落到本地的存档对象；null = 没同步成功（游客 / 离线 / 老服务端）。
export async function syncSave(opts = {}) {
  if (!cloud) return null;
  const { token, id } = cloud;
  const out = await accountApi('GET', '/api/state', null, token);
  if (!out || !out.ok) return null;

  const remoteRev = out.rev || 0;
  const remote = out.data || {};
  const local = readBlob(id);
  const localRev = readRev(id);

  let chosen;
  if (remoteRev > localRev) chosen = remote;                 // 云端更新：采用云端
  else if (remoteRev < localRev) chosen = local;             // 本地更新：用本地
  else chosen = blobEmpty(remote) ? local : (blobEmpty(local) ? remote : local); // 同修订号：空的让位

  if (opts.forceGender) chosen = { ...chosen, gender: readBlob(id).gender };

  applyBlob(id, chosen);
  const baseRev = Math.max(localRev, remoteRev);
  writeRev(id, baseRev);

  // 与云端不一致就推上去（首次上云 / 本地更新 / 强制性别）
  if (JSON.stringify(chosen) !== JSON.stringify(remote)) {
    const r = await accountApi('POST', '/api/state', { data: chosen, rev: baseRev }, token);
    if (r && r.ok) writeRev(id, r.rev || baseRev);
  }
  return chosen;
}

// 登录流程入口：设置账号并同步一次（main.js 在 new Game 之前 await 它）。
export async function initSaveSync(token, profile, opts = {}) {
  setSaveAccount(token, profile);
  if (!cloud) return null;
  return syncSave(opts);
}
