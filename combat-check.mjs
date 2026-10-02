// 纯逻辑自检（不依赖浏览器/WebGL），覆盖本轮「训练场/匹配分离 + 输赢机制」：
//  1) 出生点：从 server-remote/index.js 抽出 arenaSpawnForIndex / grappleSpawnForIndex，
//     与 src/game/MatchRules.js 的实现**逐点对拍**——两端各写一份、最容易改一边忘另一边。
//  2) judge：把六类结算场景（最后存活 / 同归于尽 / 限时金币 / 并列 / 单人 / 对手退房）
//     在 Node 里直接喂构造数据跑一遍，浏览器里几乎无法复现的情况都钉在这里。
//  3) 名次排序稳定性、formatClock、parseBest/isBetter/bestKey 往返。
//  4) 静态接线断言：新消息（train / die / coin.from）在客户端、网络层、服务端三处都接上了，
//     以及「训练场不走匹配队列」「观战不退房」这类容易回归的接线点。
// 用法：node combat-check.mjs
import { readFileSync } from 'node:fs';
import {
  MODE_RULES, modeRule, arenaSpawnForIndex, grappleSpawnForIndex, spawnForMode,
  survivalMs, trainingScore, judge, formatClock, bestKey, parseBest, isBetter,
} from './src/game/MatchRules.js';
import { Config } from './src/config.js';

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log('  FAIL ' + msg); } else { console.log('  ok   ' + msg); } };
const near = (a, b, eps = 1e-12) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------------------
// 0. 读源码（对拍 / 静态断言用）
// ---------------------------------------------------------------------------
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const gameSrc = read('./src/core/Game.js');
const netSrc = read('./src/net/Network.js');
const srvSrc = read('./server-remote/index.js');

// 从源码里按函数名抽出 `function NAME(...) { ... }` 的完整文本（花括号配对扫描）。
function extractFn(src, name) {
  const at = src.indexOf('function ' + name + '(');
  if (at < 0) return null;
  const open = src.indexOf('{', at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  return null;
}

console.log('== 0. 服务端出生点函数可抽出 ==');
const srvArena = extractFn(srvSrc, 'arenaSpawnForIndex');
const srvGrapple = extractFn(srvSrc, 'grappleSpawnForIndex');
ok(!!srvArena, 'server-remote/index.js 里找到 arenaSpawnForIndex');
ok(!!srvGrapple, 'server-remote/index.js 里找到 grappleSpawnForIndex');

// 把服务端那三个函数放进一个沙箱求值（它们只依赖 Math，无外部引用）
let srv = null;
if (srvArena && srvGrapple) {
  const srvSpawn = extractFn(srvSrc, 'spawnForMode') || '';
  srv = new Function(
    srvArena + '\n' + srvGrapple + '\n' + srvSpawn +
    '\nreturn { arenaSpawnForIndex, grappleSpawnForIndex, spawnForMode };'
  )();
}

console.log('== 1. 出生点与客户端纯逻辑模块逐点对拍 ==');
if (srv) {
  let bad = 0, checked = 0;
  for (let total = 1; total <= 8; total++) {
    for (let i = 0; i < total; i++) {
      for (const mode of ['meteor', 'grapple']) {
        const a = spawnForMode(mode, i, total);
        const b = srv.spawnForMode(mode, i, total);
        checked++;
        const same = near(a.x, b.x) && near(a.z, b.z) && near(a.yaw, b.yaw) &&
          (((a.y == null) === (b.y == null)) && (a.y == null || near(a.y, b.y)));
        if (!same) { bad++; if (bad <= 3) console.log('    x 差异 ' + mode + ' i=' + i + '/' + total + ' ' + JSON.stringify(a) + ' vs ' + JSON.stringify(b)); }
      }
    }
  }
  ok(bad === 0, checked + ' 个 (mode,i,total) 组合，两端出生点完全一致（差异 ' + bad + '）');
  // 抓钩多玩家时按 i%6 分台：8 人时第 7 人回到第 1 个平台
  const g0 = srv.grappleSpawnForIndex(0), g6 = srv.grappleSpawnForIndex(6);
  ok(near(g0.x, g6.x) && near(g0.z, g6.z), '抓钩第 7 人复用第 1 个起始平台（i%6）');
  // 陨石出生点确实落在半径 COMBAT_SPAWN_RADIUS 的圆上
  const a0 = spawnForMode('meteor', 1, 4);
  ok(near(Math.hypot(a0.x, a0.z), Config.COMBAT_SPAWN_RADIUS), '陨石出生点到中心 = COMBAT_SPAWN_RADIUS(' + Config.COMBAT_SPAWN_RADIUS + ')');
  const gsp = spawnForMode('grapple', 2, 5);
  ok(near(Math.hypot(gsp.x, gsp.z), Config.GRAPPLE_SPAWN_RADIUS) && gsp.y === Config.GRAPPLE_SPAWN_TOP_Y,
    '抓钩出生点到中心 = ' + Config.GRAPPLE_SPAWN_RADIUS + '，y = ' + Config.GRAPPLE_SPAWN_TOP_Y);
} else {
  ok(false, '未能抽出服务端函数，跳过对拍');
}

console.log('== 2. 模式规则表 ==');
ok(MODE_RULES.meteor.win === 'lastAlive' && MODE_RULES.meteor.timed === false, '陨石：活到最后者胜、不限时');
ok(MODE_RULES.grapple.win === 'mostCoins' && MODE_RULES.grapple.timed === true, '抓钩：金币最多者胜、限时');
ok(modeRule('unknown').win === 'lastAlive', '未知模式回退到陨石规则（不炸）');

// ---------------------------------------------------------------------------
// 3. judge：六类结算场景
// ---------------------------------------------------------------------------
console.log('== 3. judge 结算判定 ==');
const T0 = 1000;
const R = Config.COMBAT_ROUND_SECONDS;
const ent = (id, o) => Object.assign({ id, nick: id, alive: true, diedAt: null, coins: 0, kills: 0 }, o || {});

// A) 陨石：最后一个活着的人获胜
{
  const res = judge({
    mode: 'meteor', startedAt: T0, now: T0 + 90000,
    entries: [ent('a'), ent('b', { alive: false, diedAt: T0 + 30000 }), ent('c', { alive: false, diedAt: T0 + 60000 })],
  });
  ok(res.over === true && res.reason === 'lastAlive', '陨石：只剩 1 人 → 结束（reason=' + res.reason + '）');
  ok(res.winnerId === 'a', '陨石：获胜者是唯一存活者 a');
  ok(res.rows[0].id === 'a' && res.rows[0].rank === 1, '陨石：名次第 1 是 a');
  ok(res.rows.map((r) => r.id).join(',') === 'a,c,b', '陨石：名次表按存活时长排（a,c,b）');
  ok(res.rows[0].survivalMs === 90000 && res.rows[1].survivalMs === 60000, '存活时长计入 rows');
}

// B) 陨石：同归于尽 → 不判赢（winnerId 为 null）但仍结束
{
  const res = judge({
    mode: 'meteor', startedAt: T0, now: T0 + 90000,
    entries: [ent('a', { alive: false, diedAt: T0 + 40000 }), ent('b', { alive: false, diedAt: T0 + 50000 })],
  });
  ok(res.over === true && res.reason === 'lastAlive', '陨石：全员阵亡 → 结束');
  ok(res.winnerId === null, '陨石：无人存活 → winnerId 为 null（无人获胜）');
}

// C) 抓钩：限时到了 → 金币最多者胜
{
  const res = judge({
    mode: 'grapple', startedAt: T0, now: T0 + R * 1000,
    entries: [ent('a', { coins: 3 }), ent('b', { coins: 7 }), ent('c', { coins: 5 })],
  });
  ok(res.over === true && res.reason === 'timeUp', '抓钩：到 ' + R + ' 秒 → 结束（reason=' + res.reason + '）');
  ok(res.winnerId === 'b', '抓钩：金币最多的 b 获胜');
  ok(res.rows.map((r) => r.id).join(',') === 'b,c,a', '抓钩：名次表按金币降序（b,c,a）');
  ok(res.rows.map((r) => r.rank).join(',') === '1,2,3', '抓钩：名次 1,2,3');
}
// C2) 抓钩：还没到时间 → 不结束（哪怕已有人领先）
{
  const res = judge({
    mode: 'grapple', startedAt: T0, now: T0 + R * 1000 - 1,
    entries: [ent('a', { coins: 9 }), ent('b', { coins: 0 })],
  });
  ok(res.over === false && res.winnerId === null, '抓钩：未到时限 → 不结束');
}

// D) 并列同名次（竞赛式排名 1,1,3）
{
  const res = judge({
    mode: 'grapple', startedAt: T0, now: T0 + R * 1000,
    entries: [ent('a', { coins: 5 }), ent('b', { coins: 5 }), ent('c', { coins: 3 })],
  });
  ok(res.rows.map((r) => r.rank).join(',') === '1,1,3', '两枚并列 → 名次 1,1,3（实际 ' + res.rows.map((r) => r.rank).join(',') + '）');
  ok(res.rows[0].id === 'a' && res.rows[1].id === 'b', '并列时按 id 稳定排序（a 在前）');
  ok(res.winnerId === 'a', '并列第一时 winnerId 取排序后的第一个（a）');
}

// E) 单人 / 训练场：不判输赢，但抓钩限时到了照样收场
{
  const m = judge({ mode: 'meteor', startedAt: T0, now: T0 + 999999, solo: true, entries: [ent('me')] });
  ok(m.over === false && m.winnerId === null, '单人·陨石：无论多久都不判结束（自己练到想退）');
  const g1 = judge({ mode: 'grapple', startedAt: T0, now: T0 + R * 1000, solo: true, entries: [ent('me', { coins: 4 })] });
  ok(g1.over === true && g1.reason === 'timeUp' && g1.winnerId === null, '单人·抓钩：到时限结束，但不算「赢」');
  const g2 = judge({ mode: 'grapple', startedAt: T0, now: T0 + R * 1000 - 1, solo: true, entries: [ent('me')] });
  ok(g2.over === false, '单人·抓钩：未到时限不结束');
}

// F) 对手退房（= 出局，与阵亡同算法的「不存活」）→ 场上只剩我一人即获胜
{
  const res = judge({
    mode: 'meteor', startedAt: T0, now: T0 + 20000,
    entries: [ent('a'), ent('b', { alive: false, diedAt: T0 + 8000 })],
  });
  ok(res.over === true && res.winnerId === 'a', '对手退房 → 最后一人获胜');
}
// F2) 人不够（<2）且非单人：不判输赢（避免单人误判胜利）
{
  const res = judge({ mode: 'meteor', startedAt: T0, now: T0 + 20000, entries: [ent('a')] });
  ok(res.over === false, '场上不足 2 人且非训练场 → 不判输赢');
}

// 名次表的排序与输入顺序无关
{
  const base = [ent('a', { coins: 5 }), ent('b', { coins: 5 }), ent('c', { coins: 9 })];
  const r1 = judge({ mode: 'grapple', startedAt: T0, now: T0 + R * 1000, entries: base });
  const r2 = judge({ mode: 'grapple', startedAt: T0, now: T0 + R * 1000, entries: [base[2], base[0], base[1]] });
  ok(r1.rows.map((r) => r.id + ':' + r.rank).join(',') === r2.rows.map((r) => r.id + ':' + r.rank).join(','),
    '打乱输入顺序 → 名次表完全一致');
  // 负零 / 浮点噪声：-0 与 0 必须视为同一成绩（不能因 -0 排在 0 前而错位）
  const rz = judge({ mode: 'grapple', startedAt: T0, now: T0 + R * 1000, entries: [ent('a', { coins: -0 }), ent('b', { coins: 0 })] });
  ok(rz.rows.map((r) => r.rank).join(',') === '1,1', '金币 -0 与 0 视为并列（不会被负零拆开）');
}
// 空表 / 脏数据不炸
{
  const res = judge({ mode: 'meteor', startedAt: T0, now: T0 + 1000, entries: [null, { noId: 1 }, ent('a')] });
  ok(res.rows.length === 1, 'entries 里的 null / 无 id 项被过滤');
}

console.log('== 4. 格式化与最好记录 ==');
ok(formatClock(0) === '0:00', 'formatClock(0) = 0:00');
ok(formatClock(65000) === '1:05', 'formatClock(65000) = 1:05');
ok(formatClock(125000) === '2:05', 'formatClock(125000) = 2:05');
ok(formatClock(-500) === '0:00', 'formatClock 负数收敛到 0:00');
ok(bestKey('grapple') === 'fpm.train.best.grapple' && bestKey('x') === 'fpm.train.best.meteor', 'bestKey 只认两种模式');
ok(parseBest(null) === null && parseBest('') === null && parseBest(undefined) === null, 'parseBest：无记录 → null（不被 Number(null)=0 骗成 0 分）');
ok(parseBest('abc') === null && parseBest('-3') === null && parseBest('NaN') === null, 'parseBest：非法 / 负数 → null');
ok(parseBest('1250') === 1250 && parseBest('0') === 0, 'parseBest：合法值原样返回（0 是合法成绩）');
ok(isBetter(null, 0) === true, 'isBetter：没有记录时 0 分也是新纪录');
ok(isBetter(5000, 5001) === true && isBetter(5000, 5000) === false && isBetter(5000, 4999) === false, 'isBetter：严格更大才算更好');
ok(trainingScore('grapple', { coins: 7, survivalMs: 999 }) === 7, 'trainingScore：抓钩取金币');
ok(trainingScore('meteor', { coins: 7, survivalMs: 999 }) === 999, 'trainingScore：陨石取存活时长');
ok(survivalMs({ alive: false, diedAt: T0 + 3000 }, T0, T0 + 99999) === 3000, 'survivalMs：阵亡算到阵亡时刻（不随时间长大）');
ok(survivalMs({ alive: true, diedAt: T0 + 1 }, T0, T0 + 7000) === 7000, 'survivalMs：存活算到当前');

console.log('== 5. 静态接线断言 ==');
// —— 训练场 / 匹配分两组 ——
ok(gameSrc.includes("group('训练场'") && gameSrc.includes("group('玩家匹配'"), '模式面板分「训练场 / 玩家匹配」两组');
ok(/card\.appendChild\(mk\('meteor', 'kui-btn--primary', 'soloTip', \(m\) => this\._startTraining\(m\)\)\)/.test(gameSrc), '训练场按钮走 _startTraining');
ok(/card\.appendChild\(mk\('meteor', 'kui-btn--primary', 'tip', \(m\) => this\._startMatch\(m\)\)\)/.test(gameSrc), '匹配按钮走 _startMatch');
ok(/this\.network\.sendTrain\(mode\)/.test(gameSrc) && /this\.network\.sendMatch\(mode\)/.test(gameSrc), '两个入口分别发 train / match');
// 训练场绝不能发 match（否则会排进队列、被 12 秒超时拖住）
{
  const at = gameSrc.indexOf('_startTraining(mode) {');
  const seg = at >= 0 ? gameSrc.slice(at, at + 600) : '';
  ok(seg.length > 0 && !seg.includes('sendMatch('), '训练场入口不发 sendMatch（只发 sendTrain）');
}
// —— 输赢 / 观战 / 结算 ——
ok(/_enterSpectate\(\)|_enterSpectate\(\)/.test(gameSrc) && gameSrc.includes('_updateSpectate()'), '观战：有进入与相机更新');
ok(!gameSrc.includes('_pendingCombatExit'), '旧的 _pendingCombatExit（阵亡即退房）已彻底移除');
ok(gameSrc.includes("case 'died':") && gameSrc.includes('_onRemoteDied(msg)'), '客户端已接服务端 died 中继');
ok(/this\.network\.sendDie\(/.test(gameSrc) && netSrc.includes('sendDie('), '阵亡上报 sendDie 已接（Network + Game）');
ok(/if \(msg\.from\)/.test(gameSrc) && /st\.coins\+\+/.test(gameSrc), 'coin 广播按 from 记战绩');
ok(gameSrc.includes('_endRound(this._scoreRows())'), '训练场主动退出 → 先出成绩面板再退');
ok(gameSrc.includes('if (this._trainLocal) break;'), "case 'join' 有 _trainLocal 守卫（本机兜底时不放大厅玩家进竞技场）");
ok(netSrc.includes('setStateMuted(') && netSrc.includes('_stateMuted'), 'Network 支持状态静音（本机兜底训练场用）');
// —— 服务端 ——
ok(/msg\.t === 'train'/.test(srvSrc), '服务端已支持 train（立刻开单人房）');
ok(/t: 'died', id: ws\.__id, by/.test(srvSrc), '服务端 die → died 中继带上击杀者');
ok(/t: 'coin', id, from: ws\.__id/.test(srvSrc), '服务端 coin 广播带上 from（金币排名可用）');
ok(srvSrc.includes('SUPPORTED_MODES.has(mode)'), '服务端校验 mode 白名单');
// —— 配置 ——
ok(Number.isFinite(Config.COMBAT_ROUND_SECONDS) && Config.COMBAT_ROUND_SECONDS > 0, '配置有 COMBAT_ROUND_SECONDS');
ok(Config.SPECTATE_DIST > 0 && Config.SPECTATE_LIFT > 0, '配置有观战相机距离/抬高');
ok(Config.GRAPPLE_SPAWN_COUNT === 6, '抓钩起始平台数 = 6（与服务端 i%6 对齐）');

console.log(fails === 0 ? '\nPASS' : '\n' + fails + ' FAILED');
process.exit(fails === 0 ? 0 : 1);
