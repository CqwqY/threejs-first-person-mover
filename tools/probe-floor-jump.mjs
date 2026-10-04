// 回归脚本：踩在薄地板 / 矮平台上必须站得住、跳得起来。
//
// 起因 bug：PlayerPhysics 第 6 步的「贴地兜底」只判「离地 < 0.6m」就无条件把玩家拉回平地并清零
// 竖直速度，从不看脚下踩的是什么 —— 于是站在任何低于 0.6m 的平台上（两块平放的薄地板、矮台阶）
// 都会被硬拽回平地，起跳速度当帧清零，表现为「踩上去跳不起来」，人还会陷进板里。
// 修法：记录本帧脚下支撑面高度 _supportY，兜底只在「脚下就是平地」时生效。
//
// 用法：node tools/probe-floor-jump.mjs（退出码非 0 = 有回归）
import { PlayerPhysics } from '../src/player/PlayerPhysics.js';
import { Config } from '../src/config.js';

const H = Config.PLAYER_HEIGHT;
const box = (cx, cy, cz, hx, hy, hz) => ({ cx, cy, cz, hx, hy, hz, rotY: 0 });

function mkInput(jump = true) {
  let jumpLeft = jump ? 1 : 0;
  return {
    forwarded: () => 0, backwarded: () => 0,
    strafeRight: () => 0, strafeLeft: () => 0,
    joyX: 0, joyY: 0, joyMagnitude: () => 0,
    sprinting: () => false,
    isDown: () => false,
    consumeJump: () => (jumpLeft-- > 0),
  };
}

// 站稳 → 起跳。返回 { settled, rise }；settled 是站稳后的高度，rise 是起跳净高度
function settleThenJump(colliders, sx, sz, standTop) {
  const state = { x: sx, y: standTop + H, z: sz, yaw: 0, pitch: 0, onGround: true };
  const phys = new PlayerPhysics();
  const dt = 1 / 60;
  // 1) 站稳 20 帧（不按跳）：不能掉下去
  const idle = mkInput(false);
  for (let i = 0; i < 20; i++) { phys.update(dt, idle, 0, state, colliders); idle.consumeJump(); }
  const settled = state.y;
  // 2) 按跳，跑 60 帧
  let peak = state.y;
  const jump = mkInput(true);
  for (let i = 0; i < 60; i++) { phys.update(dt, jump, 0, state, colliders); peak = Math.max(peak, state.y); }
  return { settled, rise: peak - settled };
}

let fails = 0;
function check(label, ok, detail) {
  if (!ok) { fails++; console.log('FAIL ' + label + '：' + detail); }
  return ok;
}

// ---- 1. 扫描两块薄地板的各种摆法 ----
const THICK = [0.05, 0.2, 0.5];   // 板半厚
const TOP_A = [0.1, 0.3];         // A 板顶面高度（都 < 0.6，正是兜底会误伤的范围）
const D_TOP = [-0.2, 0, 0.2];     // B 板顶面相对 A
const OFFSET = [0, 1.8, 4];       // 水平错开（板半宽 2）
let cases = 0;
for (const t of THICK) {
  for (const ta of TOP_A) {
    for (const dt2 of D_TOP) {
      const tb = ta + dt2;
      if (tb <= 0.02) continue;
      for (const off of OFFSET) {
        const A = box(-2, ta - t, 0, 2, t, 2);
        const B = box(-2 + off, tb - t, 0, 2, t, 2);
        for (const [px, tag] of [[-2, 'A中心'], [-0.2, 'A靠B边缘']]) {
          cases++;
          const { settled, rise } = settleThenJump([A, B], px, 0, ta);
          // 两块板边缘擦过时按哪块解析取决于浮点临界（ox≈oy），站在任一块顶上都算站住了
          const tops = [ta, tb].map((t) => t + H);
          const stood = tops.some((w) => Math.abs(settled - w) < 0.02);
          check(`厚${t} A顶${ta} B顶${tb.toFixed(2)} 错开${off} 站${tag}`,
            stood && rise > 0.5,
            `站稳高度 ${settled.toFixed(3)}（应 ${tops.map((v) => v.toFixed(2)).join(' 或 ')}），起跳 ${rise.toFixed(3)}m`);
        }
      }
    }
  }
}

// ---- 2. 单块薄地板对照（一块也一样要能站住能跳）----
for (const ta of [0.1, 0.3, 0.5]) {
  cases++;
  const { settled, rise } = settleThenJump([box(0, ta - 0.05, 0, 2, 0.05, 2)], 0, 0, ta);
  check(`单块薄地板 顶${ta}`, Math.abs(settled - (ta + H)) < 0.02 && rise > 0.5,
    `站稳高度 ${settled.toFixed(3)}，起跳 ${rise.toFixed(3)}m`);
}

// ---- 3. 高台（> 0.6m）本来就没问题，别被修坏 ----
{
  cases++;
  const top = 1.5;
  const { settled, rise } = settleThenJump([box(0, top - 0.25, 0, 2, 0.25, 2)], 0, 0, top);
  check(`高台 顶${top}`, Math.abs(settled - (top + H)) < 0.02 && rise > 0.5,
    `站稳高度 ${settled.toFixed(3)}，起跳 ${rise.toFixed(3)}m`);
}

// ---- 4. 平地上（无碰撞体）仍能正常跳 ----
{
  cases++;
  const { settled, rise } = settleThenJump([], 0, 0, 0);
  check('平地', Math.abs(settled - H) < 0.02 && rise > 0.5, `站稳高度 ${settled.toFixed(3)}，起跳 ${rise.toFixed(3)}m`);
}

console.log(`\n${cases} 个场景：${fails === 0 ? '全部通过' : fails + ' 个失败'}`);
process.exit(fails === 0 ? 0 : 1);
