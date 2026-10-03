// 对战的「规则」——全部是纯函数：不 import three、不碰 DOM、不碰网络。
// 单独抽出来的理由有两条：
//   1) 出生点必须与服务端 server-remote/index.js 的 arenaSpawnForIndex / grappleSpawnForIndex
//      完全一致（那边建房间发坐标、这边训练场自己算坐标，两处独立实现最容易走偏）。
//      抽到这里 + 自检里从服务端源码抽出同名函数逐点对拍，就能把「改一边忘另一边」钉死。
//   2) 输赢判定是这一局里最容易写错、又最难在浏览器里复现的部分（要凑齐人数、限时、平局）。
//      做成纯函数后，自检可以在 Node 里直接喂构造数据把每种情况都跑一遍。
import { Config } from '../config.js';

// ---------------------------------------------------------------------------
// 模式表
// ---------------------------------------------------------------------------
// 两个模式各用一套判定：
//   meteor （躲避陨石混战）：同场其他人都倒下/退房后，最后活着的那个赢。
//   grapple（疯狂抓钩）    ：限时内吃到金币最多的赢（吃不到金币的可以活着，但赢不了）。
export const MODE_RULES = {
  meteor: { win: 'lastAlive', timed: false },
  grapple: { win: 'mostCoins', timed: true },
  // 校园狂飙：不开竞技场、不排队判胜负（在校园大世界里各跑各的，用时最短者胜，见 Game._startRace）
  circuit: { win: 'fastestLaps', timed: false },
};

export function modeRule(mode) {
  return MODE_RULES[mode] || MODE_RULES.meteor;
}

// ---------------------------------------------------------------------------
// 出生点（必须与 server-remote/index.js 逐字对齐）
// ---------------------------------------------------------------------------

// 竞技场出生点：以原点为中心环形分布、面朝中心。
// 相机前方 = (-sin yaw, -cos yaw)，要让它指向中心需 yaw = atan2(x, z)（与大厅 spawnForNum 同一约定）。
export function arenaSpawnForIndex(i, total) {
  const r = Config.COMBAT_SPAWN_RADIUS;
  const ang = (i / Math.max(1, total)) * Math.PI * 2;
  const x = Math.cos(ang) * r;
  const z = Math.sin(ang) * r;
  return { x, z, yaw: Math.atan2(x, z) };
}

// 疯狂抓钩的出生点：6 个起始平台（半径 GRAPPLE_SPAWN_RADIUS 的六边形，顶面 6m），多个玩家同台错开。
export function grappleSpawnForIndex(i) {
  const k = i % 6;
  const ang = (k / 6) * Math.PI * 2;
  const x = Math.cos(ang) * Config.GRAPPLE_SPAWN_RADIUS;
  const z = Math.sin(ang) * Config.GRAPPLE_SPAWN_RADIUS;
  return { x, z, y: Config.GRAPPLE_SPAWN_TOP_Y, yaw: Math.atan2(x, z) };
}

// 按模式取出生点
export function spawnForMode(mode, i, total) {
  return mode === 'grapple' ? grappleSpawnForIndex(i) : arenaSpawnForIndex(i, total);
}

// ---------------------------------------------------------------------------
// 名次与胜负
// ---------------------------------------------------------------------------

// 存活时长（毫秒）：活着算到 now，阵亡算到阵亡时刻。
export function survivalMs(e, startedAt, now) {
  const end = e && e.alive ? now : (e && e.diedAt) || startedAt;
  return Math.max(0, end - startedAt);
}

// 训练场的「成绩」只有一个数字，方便和本机最好记录比：
//   陨石混战 = 活了多久（毫秒）；疯狂抓钩 = 吃了多少金币。
export function trainingScore(mode, row) {
  if (!row) return 0;
  return mode === 'grapple' ? Math.max(0, row.coins | 0) : Math.max(0, row.survivalMs | 0);
}

// 并列判定键：只含「成绩」维度，不含 id。
// 名次靠它判并列（两个人都吃了 5 枚金币、都活着 → 同为第 1 名）。
// 注意它必须与 sortKey 的前缀一致，否则「排序相邻却判不出并列」。
function tieKey(mode, e, startedAt, now) {
  const alive = e.alive ? 0 : 1;               // 活着的排前面
  const surv = survivalMs(e, startedAt, now);
  if (mode === 'grapple') return [-(e.coins | 0), -surv, alive];
  return [alive, -surv];
}

// 排序键 = 并列判定键 + id。末尾的 id 只负责「各端迭代顺序不同也能得到同一顺序」，
// 它是稳定排序的保证，但**不参与并列判定**（否则任意两个人键都不相等，并列永远不成立）。
function sortKey(mode, e, startedAt, now) {
  return tieKey(mode, e, startedAt, now).concat([String(e.id)]);
}

function cmpKey(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * 算名次表与胜负。
 *
 * @param {object} o
 * @param {string} o.mode          'meteor' | 'grapple'
 * @param {number} o.startedAt     本局开始时刻（performance.now() 同源）
 * @param {number} o.now           当前时刻
 * @param {Array}  o.entries       [{ id, nick, color, alive, diedAt, coins, kills }]
 * @param {number} [o.roundSeconds] 限时（秒），默认取配置
 * @param {boolean}[o.solo]        单人／训练场：不判输赢（但抓钩限时到了仍然结束）
 * @returns {{ rows: Array, winnerId: string|null, over: boolean, reason: string|null }}
 *   rows[].rank 并列同名次（1,2,2,4…），me 由调用方按 id 自行判断
 */
export function judge(o) {
  const mode = o.mode === 'grapple' ? 'grapple' : 'meteor';
  const startedAt = Number(o.startedAt) || 0;
  const now = Math.max(startedAt, Number(o.now) || 0);
  const solo = !!o.solo;
  const roundSeconds = Number.isFinite(o.roundSeconds) ? o.roundSeconds : Config.COMBAT_ROUND_SECONDS;
  const entries = (Array.isArray(o.entries) ? o.entries : []).filter((e) => e && e.id != null);

  const decorated = entries.map((e) => ({
    id: String(e.id),
    nick: e.nick || '玩家',
    color: e.color || '#ffffff',
    alive: !!e.alive,
    diedAt: Number(e.diedAt) || null,
    coins: Math.max(0, e.coins | 0),
    kills: Math.max(0, e.kills | 0),
    survivalMs: survivalMs(e, startedAt, now),
  }));

  decorated.sort((a, b) => cmpKey(sortKey(mode, a, startedAt, now), sortKey(mode, b, startedAt, now)));

  // 并列同名次：与前一名的「成绩键」完全相同就沿用它的名次（1,2,2,4…）
  const rows = [];
  let prevKey = null, prevRank = 0;
  decorated.forEach((e, i) => {
    const k = tieKey(mode, e, startedAt, now);
    const rank = (prevKey && cmpKey(k, prevKey) === 0) ? prevRank : i + 1;
    prevKey = k; prevRank = rank;
    rows.push({ ...e, rank });
  });

  const total = rows.length;
  const aliveCount = rows.filter((r) => r.alive).length;
  const elapsed = now - startedAt;
  const timeUp = modeRule(mode).timed && elapsed >= roundSeconds * 1000;

  let over = false, reason = null, winnerId = null;
  if (solo) {
    // 训练场：没有对手就不存在「赢」，但抓钩限时到了照样收场（去结算看成绩）
    over = timeUp;
    reason = over ? 'timeUp' : null;
  } else if (total >= 2) {
    if (mode === 'meteor' && aliveCount <= 1) {
      over = true;
      reason = 'lastAlive';
      winnerId = aliveCount === 1 ? (rows.find((r) => r.alive) || {}).id || null : null; // 同归于尽 → 无人获胜
    } else if (timeUp) {
      over = true;
      reason = 'timeUp';
      winnerId = rows.length ? rows[0].id : null;
    }
  }

  return { rows, winnerId, over, reason };
}

// 把毫秒格式化成「M:SS」（超过一小时也照样按分钟累计，对战不会那么长）
export function formatClock(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

// ---------------------------------------------------------------------------
// 训练场最好记录（纯函数 + 可注入的存储，方便自检里换成假的 localStorage）
// ---------------------------------------------------------------------------
export function bestKey(mode) {
  return 'fpm.train.best.' + (mode === 'grapple' ? 'grapple' : 'meteor');
}

// 读出来的东西必须是有限的非负数，否则一律当没有记录（存档被手改 / 老版本残留都不能让界面炸）。
// 注意要先挡掉 null / ''：Number(null) === 0、Number('') === 0，不挡的话「没记录」会变成
// 一个 0 分的假记录（首局的 0 分就不算新纪录，「暂无」也永远显示不出来）。
export function parseBest(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// 成绩是不是更好（没有旧记录也算更好）。两个模式的成绩都是「越大越好」：
// 陨石混战比活了多久，疯狂抓钩比吃了多少金币。
export function isBetter(prev, next) {
  if (prev == null) return true;
  return next > prev;
}
