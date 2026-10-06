// 自检：准星 + 「瞄中光点」高亮 + 抓钩拖拽期间无视碰撞。
// 跑法：node aim-check.mjs
//
// 这一轮的三件事都容易「看起来对、实际不对」，所以都尽量用真代码跑一遍而不是只做字符串断言：
//  1) 无视碰撞：直接驱动真的 PlayerPhysics，用同一个墙碰撞体跑两次（开关 noClip 各一次），
//     看人是被挡住还是真的穿过去。
//  2) 光点落地：用真的 buildGrappleArena 拿碰撞体，逐根柱子验「落地点站着不与任何碰撞体重叠」，
//     否则抓钩会把人送到柱子内部、下一帧被弹出去掉进岩浆。
//  3) 准星/高亮：真的调一次 ensureTheme() 把主题 CSS 抓下来，确认类名与 is-hot 规则都在。
import { readFileSync } from 'node:fs';

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log('  FAIL ' + msg); } else { console.log('  ok   ' + msg); } };
const eq = (a, b, msg) => ok(a === b, msg + '（实际 ' + JSON.stringify(a) + '）');

const { Config } = await import('./src/config.js');
const { PlayerPhysics } = await import('./src/player/PlayerPhysics.js');
const { buildGrappleArena, buildPillarLayout, GRAPPLE_SPAWN_RADIUS, GRAPPLE_SPAWN_TOP_Y, GRAPPLE_SPAWN_COUNT } =
  await import('./src/world/GrappleArena.js');
const THREE = await import('three');

const gameSrc = readFileSync('./src/core/Game.js', 'utf8');
const physicsSrc = readFileSync('./src/player/PlayerPhysics.js', 'utf8');

// ---------------------------------------------------------------------------
// 1. noClip：抓钩拖拽期间无视碰撞
// ---------------------------------------------------------------------------
console.log('== 1. 抓钩拖拽期间无视碰撞（驱动真 PlayerPhysics）==');

// 最小 Input 替身：物理只用到下面这几个
const noInput = {
  forwarded: () => false, backwarded: () => false,
  strafeLeft: () => false, strafeRight: () => false,
  sprinting: () => false, joyX: 0, joyY: 0, joyMagnitude: () => 0,
  isDown: () => false, consumeJump: () => false,
};

// 一堵墙：x ∈ [4,6]、y ∈ [0,10]、z ∈ [-5,5]，玩家从 x=0 被 25m/s 往 +x 拽
const wall = { cx: 5, cy: 5, cz: 0, hx: 1, hy: 5, hz: 5 };
const H = Config.PLAYER_HEIGHT;

function pullThrough(noClip) {
  const phys = new PlayerPhysics();
  const state = { id: 'local', x: 0, y: H, z: 0, onGround: true };
  phys.noClip = noClip;
  const dt = 1 / 60;
  for (let i = 0; i < 40; i++) {          // 40 帧 ≈ 0.67s，25m/s 足够走完 16m
    phys.velocityHold = { x: Config.GRAPPLE_SPEED, y: 0, z: 0, t: 1 }; // 每帧重设，模拟 _updateGrapple
    phys.update(dt, noInput, 0, state, [wall]);
  }
  return state.x;
}

const xBlocked = pullThrough(false);
const xPassed = pullThrough(true);
ok(xBlocked <= 4 - Config.PLAYER_RADIUS + 1e-6, '关闭 noClip：人被墙挡在 x<4（实际 x=' + xBlocked.toFixed(2) + '）');
ok(xPassed > 6, '开启 noClip：人真的穿过了墙（实际 x=' + xPassed.toFixed(2) + '）');
ok(xPassed > xBlocked + 5, '两种状态的差距足够大，不是巧合（Δ=' + (xPassed - xBlocked).toFixed(2) + 'm）');

// 开关必须只在「疯狂抓钩」模式打开，且每条退出路径都要收掉
ok(/noClip = !!\(this\._combat && this\._combat\.mode === 'grapple'\)/.test(gameSrc),
  'noClip 只在 grapple 模式打开（主世界勾墙不穿模）');
ok(/_endGrapple\(\)[\s\S]{0,400}?physics\.noClip = false;/.test(gameSrc) ||
   /physics\.noClip = false;[\s\S]{0,400}?this\._grapple = null;/.test(gameSrc),
  '_endGrapple 里关掉 noClip（松手/死亡/切场景都走这里）');
// ⚠ 中间隔着注释与「宽相位」那几行，所以不能要求 `{` 的下一行就是 _resolveWorldCollisions：
//   只要「碰撞解析」与「地面吸附」都落在同一个 noClip 分支里即可（之前写死相邻行 → 假阳性）
ok(/if \(!this\.noClip\) \{[\s\S]{0,800}?this\._resolveWorldCollisions[\s\S]{0,600}?this\._snapToGround/.test(physicsSrc),
  '物理层在 noClip 时整段跳过碰撞与地面吸附');
ok(/this\.noClip = false;/.test(physicsSrc), 'PlayerPhysics 默认 noClip = false');

// ---------------------------------------------------------------------------
// 2. 光点抓钩的落地点：必须站在柱顶且不与任何碰撞体重叠
// ---------------------------------------------------------------------------
console.log('\n== 2. 光点抓钩落地点 ==');

const scene = new THREE.Scene();
const arena = buildGrappleArena(scene);
const pillars = buildPillarLayout();
const boxes = arena.colliders.filter((c) => c && c.type !== 'convex');
eq(arena.beacons.length, pillars.length, '每根柱子一颗光点（' + pillars.length + ' 颗）');

// 玩家 AABB（顶在 state.y，占 [y-HEIGHT, y]）与某个盒是否重叠 —— 与 PlayerPhysics 同一套判定
function overlaps(state, b) {
  const pr = Config.PLAYER_RADIUS;
  const hh = H / 2;
  const py = state.y - hh;
  const ox = b.hx + pr - Math.abs(state.x - b.cx);
  const oy = b.hy + hh - Math.abs(py - b.cy);
  const oz = b.hz + pr - Math.abs(state.z - b.cz);
  return ox > 0 && oy > 0 && oz > 0;
}

let worstDepth = -Infinity;   // 落地后脚底高出柱顶多少（要 ≥0：站在顶面上，不是嵌进去）
let worstSnap = 0;            // 从「松手点」到柱心的水平位移（要小，不能是远距离瞬移）
let worstClear = Infinity;    // 落地后离最近的非目标碰撞体的净空
let bad = 0;
for (let i = 0; i < pillars.length; i++) {
  const p = pillars[i];
  const beacon = arena.beacons[i];
  const landY = beacon.topY + H;                 // Game 里 landY 的算法
  const land = { x: beacon.x, y: landY, z: beacon.z };
  // ① 站上去不能和任何碰撞体重叠（含这根柱子自己：脚底刚好在顶面，不该有竖直重叠）
  for (const b of boxes) { if (overlaps(land, b)) bad++; }
  // ② 脚底相对柱顶的高度
  worstDepth = Math.max(worstDepth, (landY - H) - p.topY);
  // ③ 松手点到柱心的水平距离（抓钩是在柱顶上方 1m 处停的，还要退 0.9m）
  const dist3 = Config.GRAPPLE_BEACON_Y + Config.GRAPPLE_BEACON_STOP;
  worstSnap = Math.max(worstSnap, Math.min(p.half, dist3));
  // ④ 离最近的别的柱子/墙还有多少净空
  for (const b of boxes) {
    if (b === undefined) continue;
    if (Math.abs(b.cx - p.x) < 1e-6 && Math.abs(b.cz - p.z) < 1e-6 && Math.abs(b.cy - p.topY / 2) < 1e-6) continue; // 柱子自己
    const gap = Math.max(
      Math.abs(land.x - b.cx) - (b.hx + Config.PLAYER_RADIUS),
      Math.abs(land.z - b.cz) - (b.hz + Config.PLAYER_RADIUS)
    );
    worstClear = Math.min(worstClear, gap);
  }
}
ok(bad === 0, '16 个落地点都不与任何碰撞体重叠（重叠 ' + bad + ' 次）');
ok(Math.abs(worstDepth) < 1e-9, '落地点脚底正好在柱顶面（误差 ' + worstDepth.toFixed(6) + 'm）');
ok(worstSnap <= 1.9, '落地时的水平修正量 ≤ 一根柱子的半边长（最差 ' + worstSnap.toFixed(2) + 'm）');
ok(worstClear > 0, '落地点与其它柱子/墙都有净空（最小 ' + worstClear.toFixed(2) + 'm）');

// 出生平台 → 光点：射程内必须至少勾得到一根柱子，否则这个玩法起手就是死局
let reachable = 0;
for (let k = 0; k < GRAPPLE_SPAWN_COUNT; k++) {
  const ang = (k / GRAPPLE_SPAWN_COUNT) * Math.PI * 2;
  const sx = Math.cos(ang) * GRAPPLE_SPAWN_RADIUS;
  const sz = Math.sin(ang) * GRAPPLE_SPAWN_RADIUS;
  const sy = GRAPPLE_SPAWN_TOP_Y + H;
  for (const b of arena.beacons) {
    if (Math.hypot(b.x - sx, b.y - sy, b.z - sz) <= Config.GRAPPLE_RANGE) reachable++;
  }
}
ok(reachable >= GRAPPLE_SPAWN_COUNT, '每个出生点都至少勾得到一根柱子（可勾组合 ' + reachable + ' 个）');

// Game 侧确实把 landY 记进抓钩状态、并在到点时用上
ok(/landY: beacon\.topY \+ Config\.PLAYER_HEIGHT/.test(gameSrc), '抓钩状态里记下柱顶站立点 landY');
ok(/landX: beacon\.x/.test(gameSrc) && /landZ: beacon\.z/.test(gameSrc), 'landX/landZ 取光点（柱心）水平坐标');
// ⚠ 到点判定已被提成 `const arrived = dist <= stop;`，落地那段搬进了 `if (arrived) {`：
//   语义没变（超时≠到点，不瞬移），但断言必须跟着走，否则必然假阳性。
ok(/const arrived = dist <= stop;/.test(gameSrc)
   && /if \(arrived\) \{[\s\S]{0,600}?if \(g\.landY != null\) \{/.test(gameSrc),
  '只在正常到点（arrived）时落地（超时在半空不瞬移）');
ok(/this\.localState\.y = g\.landY;/.test(gameSrc), '到点后把人放到柱顶');

arena.dispose();

// ---------------------------------------------------------------------------
// 3. 准星与「瞄中光点」高亮
// ---------------------------------------------------------------------------
console.log('\n== 3. 准星 + 攻击键高亮 ==');

ok(/_createCrosshair\(\)/.test(gameSrc), 'Game 创建准星元素');
ok(/el\.className = 'kui-crosshair'/.test(gameSrc), '准星用 .kui-crosshair 类');
ok(/for \(const k of \['t', 'b', 'l', 'r', 'c'\]\)/.test(gameSrc), '准星由 4 条短线 + 中心点组成');
ok(/_updateAimUI\(\)/.test(gameSrc), 'Game 有 _updateAimUI');
ok(/this\._updateBeacons\(\);\s*\n\s*\/\/[^\n]*\n\s*this\._updateAimUI\(\);/.test(gameSrc),
  '_updateAimUI 紧跟在 _updateBeacons 之后（读它的 _beaconAimed）');
ok(/this\._beaconAimed = aimed;/.test(gameSrc), '_updateBeacons 每帧都写 _beaconAimed（退出模式后不会卡在热态）');
ok(/_pickBeacon\(s, _gDir\)/.test(gameSrc) && /classList\.toggle\('is-hot', hot\)/.test(gameSrc),
  '瞄中光点 → 准星加 is-hot');
ok(/classList\.toggle\('mc-atk--hot', hot\)/.test(gameSrc), '瞄中光点 → 手机攻击键加 mc-atk--hot');
ok(/this\._attackBtn && this\._attackCoarse\.*\)/.test(gameSrc) || /if \(this\._attackBtn && this\._attackCoarse\)/.test(gameSrc),
  '高亮只作用于手机端圆形攻击键（桌面是长条+鼠标左键）');
ok(/this\.input && this\.input\.locked/.test(gameSrc), 'PC 上只在指针锁定时显示准星');
ok(/this\.aiChat\.isOpen\(\)[\s\S]{0,200}?this\.shop\.isOpen\(\)/.test(gameSrc),
  '打开对话/聊天/商店面板时收起准星');

// 真的调一次 ensureTheme，把注入的 CSS 抓下来验规则（不是读源码字符串）
let css = '';
globalThis.document = {
  createElement: () => ({ set textContent(v) { css = v; }, get textContent() { return css; } }),
  head: { appendChild() {} },
};
const { ensureTheme } = await import('./src/ui/theme.js');
ensureTheme();
ok(css.length > 0, 'ensureTheme 注入了样式表（' + css.length + ' 字符）');
ok(/\.kui-crosshair \{/.test(css), 'CSS 里有 .kui-crosshair 基础规则');
ok(/\.kui-crosshair\.is-hot \{/.test(css) && /scale\(1\.22\)/.test(css), 'CSS 里有 is-hot 放大态');
ok(/\.kui-crosshair\.is-hot > i \{/.test(css) && /#ffd24a/.test(css), 'is-hot 时准星线条转金色 + 发光');
ok(/\.kui-crosshair > i\.c \{/.test(css), 'CSS 有中心点规则');
ok(/\.mc-atk--hot \{/.test(css) && /!important/.test(css), 'CSS 有 .mc-atk--hot 且用 !important 覆盖行内样式');
ok(/box-shadow: 0 0 0 1px rgba\(0, 0, 0, \.6\)/.test(css), '准星线条带深色描边（深色场景里也看得见）');
ok(!/crosshair_a\.png/.test(css), '不再用纯黑的 crosshair_a.png 贴图');

console.log('\n' + (fails ? fails + ' 项失败' : '全部通过'));
process.exit(fails ? 1 : 0);
