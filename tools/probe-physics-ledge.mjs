// 守卫探针：站在**碰撞体顶上**往边缘走出去时，人必须能**掉下去**，不能被吸回台面。
// 症状（用户实测）：「AI 走出碰撞体顶部边缘的时候跳起会被拉回去，导致一直走不动」。
// 这是 PlayerPhysics 的竖直解析分支：脚下悬空后 py 仍高于盒中心 ⇒ 每帧按"落到盒顶"把人抬回去。
// 本探针在 Node 里真跑 PlayerPhysics（无 DOM 依赖），复现"站在台面上往外走"的全过程。
import fs from 'node:fs';
import { PlayerPhysics } from '../src/player/PlayerPhysics.js';
import { Config } from '../src/config.js';

const H = Config.PLAYER_HEIGHT;
const DT = 1 / 60;
let fails = 0;
function ok(cond, name, extra) {
  if (cond) console.log('  ok   ' + name);
  else { console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); fails++; }
}

const HUGE = { minX: -1e6, maxX: 1e6, minZ: -1e6, maxZ: 1e6 };

function walkOffTopOf(hy, label) {
  // 盒子：水平 8(x) × 6(z)，高 2*hy，底面 y=0 ⇒ 顶面 = 2*hy。中心在原点。
  const box = { cx: 0, cy: hy, cz: 0, hx: 4, hy, hz: 3 };
  const phy = new PlayerPhysics();
  phy.bound = HUGE;
  const state = { x: 0, y: 2 * hy + H, z: 0, onGround: true };
  // 朝 +x 走（Game 的朝向约定：fwd = (-sin yaw, -cos yaw) ⇒ 朝 +x 时 yaw = atan2(-1, 0)）
  const yaw = Math.atan2(-1, 0);
  const input = {
    forwarded: () => 1, backwarded: () => 0, strafeRight: () => 0, strafeLeft: () => 0,
    joyX: 0, joyY: 0, joyMagnitude: () => 0, sprinting: () => false,
    consumeJump: () => false, isDown: () => false,
  };
  const traj = [];
  for (let i = 0; i < 60 * 8; i++) {
    phy.update(DT, input, yaw, state, [box]);
    if (i % 30 === 0) traj.push([Math.round(state.x * 100) / 100, Math.round(state.y * 100) / 100]);
  }
  const feet = state.y - H;
  return { state, feet, traj, top: 2 * hy };
}

for (const [hy, name] of [[1.5, '3.0m 高（楼顶）'], [0.6, '1.2m 高（矮台）'], [0.3, '0.6m 高（台阶）']]) {
  const r = walkOffTopOf(hy, name);
  // 走过去 8 秒：应当已经走下台面、落回地面（脚底 ≈ 0）
  ok(r.feet < 0.05, '[' + name + '] 走出边缘后落到地面（脚底≈0）', 'feet=' + r.feet.toFixed(3) + ' x=' + r.state.x.toFixed(2) + ' traj=' + JSON.stringify(r.traj));
  ok(r.state.x > 4.5, '[' + name + '] 水平方向确实走远了（没被顶回台面）', 'x=' + r.state.x.toFixed(2));
  ok(r.state.onGround === true, '[' + name + '] 落地后是"着地"状态', 'onGround=' + r.state.onGround);
}

// ---- 凸包（collisionMode:'complex' 的模型 → 编辑器烘出的 convex 碰撞体）----
// 同样的 8×6×3 盒子，但按**凸包**给出（12 个三角面）。玩家站在顶面往外走必须也能掉下去。
function convexBox(hx, hy, hz) {
  const v = [
    -hx, 0, -hz, hx, 0, -hz, hx, 0, hz, -hx, 0, hz,
    -hx, 2 * hy, -hz, hx, 2 * hy, -hz, hx, 2 * hy, hz, -hx, 2 * hy, hz,
  ];
  const f = [
    0, 1, 2, 0, 2, 3,          // 底
    4, 5, 6, 4, 6, 7,          // 顶
    0, 1, 5, 0, 5, 4,          // z-
    1, 2, 6, 1, 6, 5,          // x+
    2, 3, 7, 2, 7, 6,          // z+
    3, 0, 4, 3, 4, 7,          // x-
  ];
  return { type: 'convex', vertices: v, faces: f };
}

function walkOffConvex(hx, hy, hz, label) {
  const cv = convexBox(hx, hy, hz);
  const phy = new PlayerPhysics();
  phy.bound = HUGE;
  const state = { x: 0, y: 2 * hy + H, z: 0, onGround: true };
  const yaw = Math.atan2(-1, 0);
  const input = {
    forwarded: () => 1, backwarded: () => 0, strafeRight: () => 0, strafeLeft: () => 0,
    joyX: 0, joyY: 0, joyMagnitude: () => 0, sprinting: () => false,
    consumeJump: () => false, isDown: () => false,
  };
  const traj = [];
  for (let i = 0; i < 60 * 8; i++) {
    phy.update(DT, input, yaw, state, [cv]);
    if (i % 30 === 0) traj.push(Math.round(state.x * 100) / 100 + '/' + Math.round(state.y * 100) / 100);
  }
  return { state, feet: state.y - H, traj };
}

{
  const r = walkOffConvex(4, 1.5, 3, 'convex 3.0m');
  ok(r.feet < 0.05, '[convex 3.0m 高] 走出边缘后落到地面', 'feet=' + r.feet.toFixed(3) + ' x=' + r.state.x.toFixed(2) + ' traj=' + r.traj.join(' '));
  ok(r.state.x > 4.5, '[convex 3.0m 高] 水平走远了（没被吸回台面）', 'x=' + r.state.x.toFixed(2));
}

// ---- （原「Students.js 起跳两条硬约束」静态断言已随 NPC 系统移除：2026-10-16）----

console.log(fails ? '\n✗ ' + fails + ' 条断言失败' : '\n✓ 全部通过');
process.exit(fails ? 1 : 0);
