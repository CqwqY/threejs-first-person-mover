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

// 静止：跑 3 秒后应全部 resting
console.log('=== 静止 ===');
for (let i = 0; i < 180; i++) b.update(1 / 60, null);
const moving = b.bodies.filter((x) => !x.pad && !x.resting).length;
const sunk = b.bodies.filter((x) => !x.pad && x.y < 0.05).length;
console.log('  仍在动:', moving, ' 陷入地面:', sunk, ' / 共', b.bodies.filter((x) => !x.pad).length);
ok(moving === 0, '3 秒后仍有 ' + moving + ' 个在动（静止判定失效）');
ok(sunk === 0, '有道具陷进地面');

console.log(fail === 0 ? '\n✓ 全部通过' : `\n✗ ${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
