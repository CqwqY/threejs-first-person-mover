// 自检：服务端快照增量压缩（delta）
//
// 背景（实测数据）：8 人快照 1406 字节，其中
//   · nick / color / room / num 占 31%，这些字段**一辈子不变**，每帧重发纯浪费
//   · hold / wep / veh 常态是 null，再占约 20%
// 20Hz 下这是每人 549KB/20 秒的下行。手机上下行都贵。
//
// 为什么敢只改服务端：客户端 PlayerState.fromJSON 写成
//   if (data.x !== undefined) this.x = data.x;
// 缺字段 = 保持旧值 → "省略没变的字段"对旧客户端天然安全，不需要版本协商。
//
// ⚠ 本探针**不 import index.js**（import 会真的 bind 端口起服务），而是按锚点切出
//   diffSnapshotPlayers 用 new Function 求值 —— 既不启动服务，也不复制一份逻辑（复制必漂移）。
//
// 跑法：node tools/probe-snapshot-delta.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
function ok(cond, msg) {
  if (cond) console.log('  PASS  ' + msg);
  else { console.log('  FAIL  ' + msg); fails++; }
}
function eq(a, b, msg) {
  if (a === b) console.log('  PASS  ' + msg + `  (${a})`);
  else { console.log('  FAIL  ' + msg + `  got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); fails++; }
}

const src = fs.readFileSync(path.join(ROOT, 'server-remote/index.js'), 'utf8');

// ---- 锚点：常量 + 函数体（花括号配对）----
const mEvery = /const FULL_SNAPSHOT_EVERY = (\d+);/.exec(src);
ok(!!mEvery, '找到 FULL_SNAPSHOT_EVERY 常量');
const iFn = src.indexOf('function diffSnapshotPlayers(list, forceFull) {');
ok(iFn > 0, '找到 diffSnapshotPlayers');
let depth = 0, end = -1;
for (let k = src.indexOf('{', iFn); k < src.length; k++) {
  if (src[k] === '{') depth++;
  else if (src[k] === '}') { depth--; if (depth === 0) { end = k; break; } }
}
const fnSrc = src.slice(iFn, end + 1);
ok(fnSrc.length > 300, '切出函数体（配对成功）');

// 在隔离环境里求值（自带 _lastSent / _snapSeq，互不污染）
function makeEnv() {
  const code = [
    `const FULL_SNAPSHOT_EVERY = ${mEvery[1]};`,
    'let _lastSent = new Map();',
    'let _snapSeq = 0;',
    fnSrc,
    'return { diffSnapshotPlayers, stats: () => ({ cacheSize: _lastSent.size, seq: _snapSeq }) };',
  ].join('\n');
  return new Function(code)();
}

function mkPlayer(id, i, moving) {
  return {
    id, num: i,
    x: moving ? 10 + i * 0.01 : 10,
    y: 1.7, z: moving ? -5 - i * 0.01 : -5,
    yaw: moving ? 0.3 + i * 0.001 : 0.3,
    size: 1, health: 100, hold: null, wep: null, ride: 0, veh: null,
    nick: '玩家' + i, color: '#ffffff', room: null,
  };
}
const bytesOf = (players, time) => JSON.stringify({ t: 'snapshot', players, time }).length;

// ---------------------------------------------------------------- ① 首帧必须全量
console.log('\n[1] 新出现的 id 首帧必须全量（否则客户端拿不到 nick/color）');
{
  const env = makeEnv();
  const list = [mkPlayer('a', 1, false), mkPlayer('b', 2, false)];
  const out = env.diffSnapshotPlayers(list, false);
  eq(out.length, 2, '两人都在');
  ok(out[0].nick === '玩家1' && out[0].color === '#ffffff',
    '首帧带上了静态字段（nick/color）—— 少了的话名牌会一直是默认值');
  eq(Object.keys(out[0]).length, Object.keys(list[0]).length, '首帧字段数与全量一致');
}

// ---------------------------------------------------------------- ② 静止玩家：第二帧只剩 id
console.log('\n[2] 没变化时只发 id（这才是省下来的）');
{
  const env = makeEnv();
  const list = [mkPlayer('a', 1, false), mkPlayer('b', 2, false)];
  env.diffSnapshotPlayers(list, false); // 首帧全量
  const out = env.diffSnapshotPlayers(list, false);
  eq(Object.keys(out[0]).length, 1, '第二帧只发 id（其余字段客户端保持旧值）');
  eq(Object.keys(out[0])[0], 'id', '发出来的那个就是 id');
  const fullB = bytesOf(list.map((p) => ({ ...p })), 0.4);
  const thinB = bytesOf(out, 0.4);
  ok(thinB < fullB * 0.25, `整包 ${fullB}B → ${thinB}B（静止时几乎只剩骨架）`);
}

// ---------------------------------------------------------------- ③ 移动玩家：只发变化的字段
console.log('\n[3] 移动中只发真正变了的字段');
{
  const env = makeEnv();
  const p1 = mkPlayer('a', 1, false);
  env.diffSnapshotPlayers([p1], false);
  const p2 = mkPlayer('a', 1, false);
  p2.x = 10.5; p2.z = -5.5; // 只动了位置
  const out = env.diffSnapshotPlayers([p2], false);
  const keys = Object.keys(out[0]).sort().join(',');
  eq(keys, 'id,x,z', '只发了 id + x + z（yaw/y/health/nick 都没变，不发）');

  // 换成"拿起了武器"：只发 wep
  // ⚠ 必须**基于上一帧那份**改（p2），否则位置也会跟着变，测出来是 id,x,z,wep（第一版就踩了）
  const p3 = { ...p2 };
  p3.wep = 'gatling';
  const out3 = env.diffSnapshotPlayers([p3], false);
  eq(Object.keys(out3[0]).sort().join(','), 'id,wep', '拿起武器只发 wep');
  eq(out3[0].wep, 'gatling', '值正确');
}

// ---------------------------------------------------------------- ④ 兜底全量
console.log('\n[4] 每 FULL_SNAPSHOT_EVERY 帧兜底一次全量');
{
  const env = makeEnv();
  const list = [mkPlayer('a', 1, false)];
  const every = Number(mEvery[1]);
  let fullFrames = 0;
  for (let i = 1; i <= every * 2 + 2; i++) {
    const out = env.diffSnapshotPlayers(list, false);
    if (Object.keys(out[0]).length > 1) fullFrames++;
  }
  ok(fullFrames >= 2, `${every * 2 + 2} 帧里有 ${fullFrames} 帧是全量（周期生效）`);
  // 强制全量
  const forced = env.diffSnapshotPlayers(list, true);
  ok(Object.keys(forced[0]).length > 1, 'forceFull=true 时立即全量（新连接进来走这条）');
}

// ---------------------------------------------------------------- ⑤ 缓存清理
console.log('\n[5] 离线玩家要清出缓存（否则 Map 随"来过的人"无限涨）');
{
  const env = makeEnv();
  env.diffSnapshotPlayers([mkPlayer('a', 1, false), mkPlayer('b', 2, false)], false);
  eq(env.stats().cacheSize, 2, '两人进缓存');
  env.diffSnapshotPlayers([mkPlayer('a', 1, false)], false);
  eq(env.stats().cacheSize, 1, 'b 离线后被清掉');
  // b 再回来 → 必须重新全量
  const out = env.diffSnapshotPlayers([mkPlayer('a', 1, false), mkPlayer('b', 2, false)], false);
  const bOut = out.find((o) => o.id === 'b');
  ok(Object.keys(bOut).length > 1, 'b 回来时重新全量（nick/color 补齐）');
}

// ---------------------------------------------------------------- ⑥ 体积收益（核心）
console.log('\n[6] 端到端体积对比：8 人房间、60 帧（3 秒）');
{
  const N = 8, FRAMES = 60;
  // 场景 A：全员站立不动（大厅里常见）
  let fullA = 0, deltaA = 0;
  {
    const env = makeEnv();
    for (let f = 0; f < FRAMES; f++) {
      const list = Array.from({ length: N }, (_, i) => mkPlayer('p' + i, i + 1, false));
      const full = list.map((p) => ({ ...p }));
      const delta = env.diffSnapshotPlayers(list, false);
      fullA += bytesOf(full, 0.4);
      deltaA += bytesOf(delta, 0.4);
    }
  }
  // 场景 B：全员移动（位置每帧都在变，省不到位置字段）
  let fullB = 0, deltaB = 0;
  {
    const env = makeEnv();
    for (let f = 0; f < FRAMES; f++) {
      const list = Array.from({ length: N }, (_, i) => mkPlayer('p' + i, i + 1, true));
      // 让位置每帧都变
      for (const p of list) p.x += f * 0.001;
      const full = list.map((p) => ({ ...p }));
      const delta = env.diffSnapshotPlayers(list, false);
      fullB += bytesOf(full, 0.4);
      deltaB += bytesOf(delta, 0.4);
    }
  }
  const cut = (a, b) => ((1 - b / a) * 100).toFixed(1) + '%';
  console.log(`        静止：全量 ${fullA}B → delta ${deltaA}B（省 ${cut(fullA, deltaA)}）`);
  console.log(`        移动：全量 ${fullB}B → delta ${deltaB}B（省 ${cut(fullB, deltaB)}）`);
  ok(deltaA < fullA * 0.35, `静态场景省下 ${cut(fullA, deltaA)}（>65%，主要是昵称/颜色/空字段）`);
  ok(deltaB < fullB * 0.75, `移动场景省下 ${cut(fullB, deltaB)}（位置每帧都变，仍能省掉静态字段）`);
}

// ---------------------------------------------------------------- ⑦ 客户端兼容性（静态断言）
console.log('\n[7] 客户端天然兼容"缺字段"（这是敢只改服务端的前提）');
{
  const ps = fs.readFileSync(path.join(ROOT, 'src/player/PlayerState.js'), 'utf8');
  ok(/if \(data\.x !== undefined\) this\.x = data\.x;/.test(ps),
    'PlayerState.fromJSON 是"只在字段存在时才更新" → 缺字段 = 保持旧值');
  const rp = fs.readFileSync(path.join(ROOT, 'src/player/RemotePlayer.js'), 'utf8');
  ok(/applyState|fromJSON/.test(rp), 'RemotePlayer 走同一条更新路径');
  // 服务端不该出现"整包替换"的写法
  ok(!/players:\s*list\b/.test(src.slice(src.indexOf('setInterval(() => {\n  const list = worldPlayers()'), src.length)),
    '广播处没有退回成直接发全量 list');
}

console.log('\n' + (fails ? `✗ ${fails} 项失败` : '✓ 全部通过'));
process.exit(fails ? 1 : 0);
