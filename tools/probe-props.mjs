// 物理可交互物探针：直接 import 真模块，验证
//   ① 布局确定性（两次生成 hash 必须一致）② 赛道/出生点/边界避让
//   ③ 踢的命中与偏移（射程按球面算）④ 道具间连锁 ⑤ 3 秒内全部静止且不陷地
//   ⑥ spawnBall 上限（商店充气足球）
// 2026-10-25 布局改为「操场中心唯一巨型足球」，检查点用服务器实测的 30 门真数据。
// 用法：node tools/probe-props.mjs
import { PhysicsProps } from '../src/world/physicsProps.js';
import { buildSoccerBallGeometry } from '../src/world/props/soccerBall.js';
import { PROP_KINDS } from '../src/world/props/defs.js';
import { Config } from '../src/config.js';

const scene = { add() {}, remove() {} };
const boundary = { minX: -115, maxX: 117, minZ: -155, maxZ: 175, showWalls: true, wallHeight: 3 };
// 服务器 data/editor-scene.json 实测的「校园狂飙」30 个门（2026-10-25 ssh 抓取）
const track = {
  checkpoints: [
    { x: -44, z: 130 }, { x: -67, z: 131 }, { x: -78, z: 147 }, { x: -92, z: 140 },
    { x: -96, z: 114 }, { x: -98, z: 93 }, { x: -111, z: 85 }, { x: -99, z: 49 },
    { x: -17, z: 48 }, { x: -9, z: 119 }, { x: 11, z: 127 }, { x: 11, z: 42 },
    { x: -9, z: -2 }, { x: -11, z: -77 }, { x: 8, z: -107 }, { x: 59, z: -108 },
    { x: 79, z: -83 }, { x: 77, z: 20 }, { x: 82, z: 47 }, { x: 82, z: 74 },
    { x: 83, z: 97 }, { x: 58, z: 94 }, { x: -29, z: 41 }, { x: -88, z: 45 },
    { x: -105, z: 64 }, { x: -93, z: 143 }, { x: 2, z: 154 }, { x: 49, z: 148 },
    { x: -4, z: 134 }, { x: -29, z: 130 },
  ],
};
const spawn = { x: 0, z: 0 };

function build() {
  const p = new PhysicsProps(scene, [], null);
  const stats = p.buildLayout({ spawn, track, boundary });
  return { p, stats };
}

const { p: a, stats } = build();
const { p: b } = build();
const ha = a.hash();
const hb = b.hash();

let fail = 0;
const ok = (cond, msg) => { if (!cond) { console.log('  FAIL: ' + msg); fail++; } };

// 足球几何：截角二十面体必须恰好 12 五边形 + 20 六边形 = 116 个三角形
{
  const g = buildSoccerBallGeometry(PROP_KINDS.ball.size[0] * 0.5);
  const tris = g.getAttribute('position').count / 3;
  console.log('=== 足球几何 ===');
  console.log('  三角形数:', tris, '（期望 116）');
  if (tris !== 116) { console.log('  FAIL: 足球几何面板数不对'); fail++; }
}

console.log('=== 布局 ===');
console.log('  统计:', stats.map((s) => `${s.zone}:${s.kind} ${s.got}/${s.want}`).join('  '));
console.log('  体数:', a.count, ' hash:', ha, '/', hb);
ok(a.count === 1, '布局应为「操场中心唯一大足球」，实际体数: ' + a.count);
ok(ha === hb, '两次生成 hash 不一致（确定性被破坏）');

const bodies = a.bodies.filter((x) => !x.pad);
ok(bodies.length === 1 && bodies[0].kind === 'ball', '唯一的体必须是 ball');
if (bodies.length === 1) {
  const bl = bodies[0];
  ok(Math.abs(bl.x - 35.4) < 0.01 && Math.abs(bl.z + 51.5) < 0.01,
    '大球没钉在操场中心 (35.4,-51.5): ' + bl.x + ',' + bl.z);
  ok(bl.r >= 2, '大球半径应 ≥2m（人能走进去）: ' + bl.r);
}

// 避让校验
function distSeg(px, pz, x1, z1, x2, z2) {
  const dx = x2 - x1, dz = z2 - z1, L = dx * dx + dz * dz || 1;
  let t = ((px - x1) * dx + (pz - z1) * dz) / L;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + dx * t), pz - (z1 + dz * t));
}
let trackBad = 0, spawnBad = 0, edgeBad = 0;
for (const x of bodies) {
  let d = Infinity;
  for (let i = 0; i < track.checkpoints.length; i++) {
    const p1 = track.checkpoints[i];
    const p2 = track.checkpoints[(i + 1) % track.checkpoints.length];
    d = Math.min(d, distSeg(x.x, x.z, p1.x, p1.z, p2.x, p2.z));
  }
  if (d < 7) trackBad++;
  if (Math.hypot(x.x - spawn.x, x.z - spawn.z) < 8) spawnBad++;
  if (x.x < boundary.minX + 3 || x.x > boundary.maxX - 3 || x.z < boundary.minZ + 3 || x.z > boundary.maxZ - 3) edgeBad++;
}
console.log('=== 避让 ===');
console.log('  压赛道(<7m):', trackBad, ' 压出生点(<8m):', spawnBad, ' 越界(<3m):', edgeBad);
ok(trackBad === 0, '有道具体压在赛道走廊内');
ok(spawnBad === 0, '有道具体压在出生点范围内');
ok(edgeBad === 0, '有道具体超出边界内缩');

// 踢：射程按球面算 —— 站在巨型球旁边（球心 ~3.1m 远）也必须能踢到
console.log('=== 踢 ===');
const ball = bodies[0];
const bx = ball.x, by = ball.y, bz = ball.z;
// 眼睛高度 ~1.6m，站在球南缘 3.1m 处往球心看（巨型球球心在 ~3.6m 高）
const eye = { x: bx, y: by - 2.0, z: bz - 3.1 };
const dirLen = Math.hypot(bx - eye.x, by - eye.y, bz - eye.z);
const hitOk = a.kick(eye.x, eye.y, eye.z, (bx - eye.x) / dirLen, (by - eye.y) / dirLen, (bz - eye.z) / dirLen);
const vAfter = Math.hypot(ball.vx, ball.vz);
console.log('  球旁命中:', hitOk, ' 速度:', vAfter.toFixed(2));
ok(hitOk === true, '站在球旁朝球心踢没命中（射程没按球面算？）');
ok(vAfter > 2, '踢后速度没起来: ' + vAfter);
const missOk = a.kick(bx, by + 8, bz - 3.1, 0, 0, 1);
ok(missOk === false, '瞄高处竟然也命中了');
console.log('  瞄偏命中:', missOk);

// 连锁：两块积木，前一块朝后一块撞过去（道具间球-球分离仍然有效）
console.log('=== 连锁 ===');
const d1 = new PhysicsProps(scene, [], null);
d1.enabled = true;
const m1 = d1._create('block', 0, 0.14, 0, 'k1');
const m2 = d1._create('block', 0.34, 0.14, 0, 'k2');
m1.vx = 6;
let pushed = false;
for (let i = 0; i < 30; i++) {
  d1.update(1 / 60, null);
  if (Math.abs(m2.vx) > 0.2) { pushed = true; break; }
}
console.log('  后块被带动:', pushed, ' m2.vx=', m2.vx.toFixed(2));
ok(pushed, '连锁没传过去（后块始终没动）');

// spawnBall：商店充气足球 + 上限
console.log('=== spawnBall ===');
const sb = new PhysicsProps(scene, [], null);
let spawnOk = true;
for (let i = 0; i < Config.PROP_BALL_MAX + 2; i++) {
  const nb = sb.spawnBall(i, 3, 0);
  if (!nb) spawnOk = false;
}
ok(spawnOk, 'spawnBall 返回 null');
ok(sb.count === Config.PROP_BALL_MAX, '场上球数应为上限 ' + Config.PROP_BALL_MAX + '，实际 ' + sb.count);
ok(sb.bodies.every((x) => String(x.id).startsWith('pb')), 'spawnBall 生成的 id 都应带 pb 前缀');
console.log('  上限内生成:', sb.count, ' id 前缀 pb ✓');

// 骑乘（仓鼠球）：进入后人被锁在球里，球贴着玩家脚下跟滚
console.log('=== 骑乘 ===');
const rb = new PhysicsProps(scene, [], null);
const ballR = rb._create('ball', 5, 3.6, 5, 'ride1');
const rider = { x: 5, z: 5, y: 1 + 1.7, vx: 2, vz: 0, height: 1.7 };
ok(rb.enterBall(ballR) === true, 'enterBall 失败');
ok(rb.ridingBall === ballR && ballR.ridden, 'ridingBall 状态没建立');
ok(rb.enterBall(ballR) === false, '已在球里还允许再进入');
// 让骑手真的走动（位置推进），球要跟随 + 真实滚动（无滑动）
const q0 = ballR.mesh.quaternion.clone();
for (let i = 0; i < 30; i++) {
  rider.x += rider.vx / 60;
  rb.update(1 / 60, rider);
}
ok(Math.abs(ballR.x - rider.x) < 1e-6 && Math.abs(ballR.z - rider.z) < 1e-6, '骑乘球没跟着玩家水平位置');
ok(Math.abs(ballR.y - (rider.y - rider.height + ballR.r)) < 1e-6, '骑乘球高度没贴到玩家脚底+半径');
ok(Math.abs(ballR.vx - rider.vx) < 0.05, '骑乘球速度没收敛到玩家速度（远端看不到滚）');
ok(ballR.mesh.quaternion.angleTo(q0) > 0.05, '骑乘移动时球没真实滚动（无滑动旋转）');
// 骑乘中的球不能被 aim / kick / 贴身推
const eyeR = { x: ballR.x, y: ballR.y, z: ballR.z - 4 };
ok(rb.aimBall(eyeR.x, eyeR.y, eyeR.z, 0, 0, 1) === null, '骑乘中的球不应再被 aim 到');
const kickRidden = rb.kick(eyeR.x, eyeR.y, eyeR.z, 0, 0, 1);
ok(kickRidden === false, '骑乘中的球不应被踢');
ok(rb.exitBall() === true && !ballR.ridden && rb.ridingBall === null, 'exitBall 没清干净');
// 出来后 aim 命中 / 瞄偏不命中
const aimHit = rb.aimBall(eyeR.x, eyeR.y, eyeR.z, 0, 0, 1);
ok(aimHit === ballR, 'aimBall 没命中球心正前方的球');
const aimMiss = rb.aimBall(eyeR.x, eyeR.y + 6, eyeR.z, 0, 0, 1);
ok(aimMiss === null, 'aimBall 瞄高处不应命中');
console.log('  进入/跟随/排除/退出 ✓');

// 静止：跑 3 秒后应全部 resting
console.log('=== 静止 ===');
for (let i = 0; i < 180; i++) b.update(1 / 60, null);
const moving = b.bodies.filter((x) => !x.pad && !x.resting).length;
const sunk = b.bodies.filter((x) => !x.pad && x.y < 0.05).length;
console.log('  仍在动:', moving, ' 陷入地面:', sunk, ' / 共', b.bodies.filter((x) => !x.pad).length);
ok(moving === 0, '3 秒后仍有 ' + moving + ' 个在动（静止判定失效）');
ok(sunk === 0, '有道具陷进地面');

// 滑索：挂索定位的纯数学（Game._nearestZipline / _updateZipline 用它）
console.log('=== 滑索 ===');
const { projectOnSegment, cableLength } = await import('../src/world/builtins.js');
const zLen = cableLength(0, 9, 0, 0, 3.6, 15);
const zMid = projectOnSegment(0, 6.3, 7.5, 0, 9, 0, 0, 3.6, 15); // 索中点正上方
ok(Math.abs(zMid.t - 0.5) < 1e-6, '索中点投影 t 应为 0.5，实际 ' + zMid.t);
ok(Math.abs(zMid.y - (9 + (3.6 - 9) * 0.5)) < 1e-6, '索中点高度不对');
ok(zMid.dist < 0.05, '中点到索的距离应≈0，实际 ' + zMid.dist);
const zOut = projectOnSegment(0, 20, -5, 0, 9, 0, 0, 3.6, 15);
ok(zOut.t === 0, '越过近端应夹在 t=0，实际 ' + zOut.t);
const zFar = projectOnSegment(0, 0, 40, 0, 9, 0, 0, 3.6, 15);
ok(zFar.t === 1, '越过远端应夹在 t=1，实际 ' + zFar.t);
ok(zLen > 15 && zLen < 17, '索长异常: ' + zLen.toFixed(2));
console.log('  投影/夹取 索长=' + zLen.toFixed(2) + 'm ✓');

// PC 端统一互动键：F 同时管「滑索 / 大足球 / 上下车」，必须只有一个分派入口。
// 这里做静态断言，防「某天又给滑索单独挂一个 keydown」→ 一次按键同时抓索 + 进球。
console.log('=== 互动键 ===');
{
  const { readFileSync } = await import('node:fs');
  const norm = (f) => readFileSync(new URL(f, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const game = norm('../src/core/Game.js');
  const cfg = norm('../src/config.js');

  ok(/INTERACT_KEY:\s*'KeyF'/.test(cfg), 'config 里 INTERACT_KEY 必须是 KeyF');
  ok(/BALL_ENTER_KEY:\s*'KeyF'/.test(cfg), 'config 里 BALL_ENTER_KEY 必须与 INTERACT_KEY 同键');
  ok(!/ZIPLINE_KEY/.test(cfg), '滑索不该再有独立按键（已并入 INTERACT_KEY）');

  // 只能有 1 处 keydown 判 INTERACT_KEY。按「判断语句」计数，不要按文件切片数：
  // 注释和 toast 里也会出现 Config.INTERACT_KEY，切片法必然误判成多个监听。
  const count = (re) => (game.match(re) || []).length;
  const listeners = count(/e\.code\s*!==\s*Config\.INTERACT_KEY/g);
  ok(listeners === 1, '判 INTERACT_KEY 的 keydown 应恰好 1 处，实际 ' + listeners);
  ok(!game.includes('Config.ZIPLINE_KEY'), 'Game.js 里不该再引用 Config.ZIPLINE_KEY');
  // 球不能再单独挂 keydown（否则和 F 分派重复触发）
  const ballKeyListeners = count(/e\.code\s*!==\s*Config\.BALL_ENTER_KEY/g);
  ok(ballKeyListeners === 0, '大足球不该再单独挂 keydown（并入 _interactKey）');

  // 抽函数体必须花括号配对（src.slice(indexOf) 会扫到文件末尾）
  const blockAt = (src, marker) => {
    const i = src.indexOf(marker);
    if (i < 0) return '';
    const s = src.indexOf('{', i);
    let d = 0;
    for (let k = s; k < src.length; k++) {
      if (src[k] === '{') d++;
      else if (src[k] === '}') { d--; if (d === 0) return src.slice(s, k + 1); }
    }
    return '';
  };
  const body = blockAt(game, '\n  _interactKey() {');
  ok(body.length > 0, '找不到 _interactKey() 函数体');
  // 退出路径必须排在进入路径前：索上松手 → 球里出来 → 车上下来 → 才去抓索/进球/上车
  const iZip = body.indexOf('this._zip)');
  const iBall = body.indexOf('ridingBall');
  const iRide = body.indexOf('localState.ride');
  const iNear = body.indexOf('_nearestZipline()');
  const iAim = body.indexOf('_ballAimed()');
  ok(iZip >= 0 && iZip < iBall, '「索上松手」必须排在「球里出来」之前');
  ok(iBall < iRide, '「球里出来」必须排在「车上下来」之前');
  ok(iRide < iNear, '「车上下来」必须排在「抓索」之前');
  ok(iNear < iAim, '「抓索」必须排在「进球」之前');
  // 长按自动重复会把「抓上」立刻变「松手」
  // keydown 里是 `if (...) return;` 单行写法（无花括号），不能用 blockAt 配对，
  // 直接取判断语句后面的 300 字符窗口即可（这一段就是监听器体）
  const iKey = game.indexOf('e.code !== Config.INTERACT_KEY');
  const keyDownBlock = iKey >= 0 ? game.slice(iKey, iKey + 300) : '';
  ok(/e\.repeat/.test(keyDownBlock), 'interact 键的 keydown 必须挡 e.repeat（长按会瞬间抓了又松）');
  console.log('  单入口分派 + 退出路径优先 + repeat 守卫 ✓');
}

// 事件系统 + 运动器 + 三维区域：编辑器「运动/事件」链路的行为验证。
// 手法与滑索节一致：直接 import 真模块跑真分支（sceneEvents/sceneMovers 都是纯逻辑，node 可跑）。
console.log('=== 事件与运动器 ===');
{
  const ev = await import('../src/world/sceneEvents.js');
  const mv = await import('../src/world/sceneMovers.js');
  const bl = await import('../src/world/builtins.js');
  const hits = [];
  ev.sceneOn('open_door', () => hits.push('a'));
  ev.sceneOn('open_door', () => hits.push('b'));
  ok(ev.sceneFire('open_door') === 2, 'fire 应送达 2 个订阅者');
  ok(hits.length === 2, '订阅者应被同步调用');
  ok(ev.sceneFire('nobody') === 0, '无匹配事件应返回 0（调用方据此提示）');
  // 单个订阅者抛错不拖垮其它订阅者
  let reached = false;
  ev.sceneOn('boom', () => { throw new Error('x'); });
  ev.sceneOn('boom', () => { reached = true; });
  ev.sceneFire('boom');
  ok(reached, '一个订阅者抛错不该拦住后面的订阅者');
  ev.clearSceneEvents();

  // 运动器：事件触发 = toggle（开始/暂停/继续），pingpong 0..dist 往返
  // 假 holder 要带 position.clone()（registerSceneMover 会快照初始姿态；真 Object3D 有）
  const mkHolder = () => ({
    position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; }, clone() { return { x: this.x, y: this.y, z: this.z }; } },
    rotation: { y: 0 },
    parent: {},
  });
  const holder = mkHolder();
  const m = mv.registerSceneMover(holder, { type: 'pingpong', axis: 'x', dist: 2, speed: 2, event: 'go' });
  ok(m !== null, '配置齐全的运动器应注册成功');
  ok(mv.registerSceneMover(holder, { type: 'pingpong', event: '' }) === null, '没配事件名的运动器不应注册');
  mv.updateSceneMovers(1 / 60);
  ok(holder.position.x === 0, '未触发事件时不应运动');
  ev.sceneFire('go'); // 开始
  for (let i = 0; i < 60; i++) mv.updateSceneMovers(1 / 60); // 1s * 2m/s = 恰好走满 dist=2 → 应反向
  ok(Math.abs(holder.position.x - 2) < 0.05, '1 秒后应走到 dist=2 端点，实际 ' + holder.position.x.toFixed(3));
  ev.sceneFire('go'); // 暂停
  const paused = holder.position.x;
  for (let i = 0; i < 60; i++) mv.updateSceneMovers(1 / 60);
  ok(holder.position.x === paused, '暂停期间位置不应变化');
  ev.sceneFire('go'); // 继续（暂停发生在端点 2，dir 已是回程方向）
  for (let i = 0; i < 60; i++) mv.updateSceneMovers(1 / 60); // 1 秒走 2m → 回到起点
  ok(Math.abs(holder.position.x) < 0.05, '继续 1 秒应回到起点，实际 ' + holder.position.x.toFixed(3));
  // 大 dt 钳制：切后台回来一帧 5s 不该瞬移（当前 active，从 0 出发）
  mv.updateSceneMovers(5);
  ok(Math.abs(holder.position.x) < 0.25, '单帧 dt=5s 应被钳到 0.1s（位移 ≤0.25m），实际 ' + holder.position.x.toFixed(3));
  // 旋转运动器：往返 -angle..+angle
  const rh = mkHolder();
  mv.registerSceneMover(rh, { type: 'rotate', angle: 90, speed: 90, event: 'spin' });
  ev.sceneFire('spin');
  for (let i = 0; i < 60; i++) mv.updateSceneMovers(1 / 60);
  ok(Math.abs(rh.rotation.y - Math.PI / 2) < 0.02, '1 秒 90 度/秒应转到 +90°，实际 ' + (rh.rotation.y * 180 / Math.PI).toFixed(1));
  mv.clearSceneMovers();
  ev.sceneFire('go');
  mv.updateSceneMovers(1 / 60);
  console.log('  事件订阅/触发/容错 + pingpong 往返 + 暂停继续 + dt 钳制 + 旋转 ✓');

  // 三维区域：局部盒判定（worldToLocal 之后的点）
  ok(bl.pointInZoneLocal(0, 1, 0) === true, '区域中心点应在区域内');
  ok(bl.pointInZoneLocal(1.99, 2.9, -1.99) === true, '贴近角落的点应在区域内');
  ok(bl.pointInZoneLocal(2.1, 1, 0) === false, '超出 ±2 的 X 不应在区域内');
  ok(bl.pointInZoneLocal(0, 3.1, 0) === false, '高于 3m 的点不应在区域内');
  ok(bl.pointInZoneLocal(0, -0.1, 0) === false, '低于区域底面的点不应在区域内');
  console.log('  区域局部盒判定（含边界外一点）✓');
}

console.log(fail === 0 ? '\n✓ 全部通过' : `\n✗ ${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
