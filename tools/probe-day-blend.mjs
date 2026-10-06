// 探针：验证「联机世界时刻硬跳 → 平滑过渡」修复（修"突然变很暗"）。
// 抽 Game.js 里三个纯方法在 Node 真跑，并复刻 _updateDayNight 联机分支的触发判定与过渡曲线。
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(__dir, '../src/core/Game.js'), 'utf8');

// 花括号配平抽方法体（避开 #if/#else 等伪花括号，纯 JS 方法体无此问题）
function blockAt(sig) {
  const i = src.indexOf(sig);
  if (i < 0) throw new Error('找不到签名: ' + sig);
  const j = src.indexOf('{', i);
  let depth = 0, k = j;
  for (; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) { k++; break; } }
  }
  return src.slice(j + 1, k - 1);
}

const lerpDay = new Function('a', 'b', 't', blockAt('  _lerpDay(a, b, t) {'));
const circularDayDist = new Function('a', 'b', blockAt('  _circularDayDist(a, b) {'));
const smoothstep = new Function('t', blockAt('  _smoothstep(t) {'));

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + name); } }
const near = (x, y, e = 1e-9) => Math.abs(x - y) <= e;

// ① lerpDay 最短弧（处理跨零点）
ok('lerpDay 跨零点中点=0', near(lerpDay(0.95, 0.05, 0.5), 0));
ok('lerpDay 跨零点终点=0.05', near(lerpDay(0.95, 0.05, 1), 0.05));
ok('lerpDay 0.1→0.9 最短弧中点=0', near(lerpDay(0.1, 0.9, 0.5), 0));
ok('lerpDay 同侧中点', near(lerpDay(0.5, 0.9, 0.5), 0.7));
ok('lerpDay 起点不变', near(lerpDay(0.5, 0.9, 0), 0.5));
ok('lerpDay 终点不变', near(lerpDay(0.5, 0.9, 1), 0.9));

// ② circularDayDist（0~0.5）
ok('dist 0.1,0.9=0.2', near(circularDayDist(0.1, 0.9), 0.2));
ok('dist 0.5,0.9=0.4', near(circularDayDist(0.5, 0.9), 0.4));
ok('dist 0.95,0.05=0.1', near(circularDayDist(0.95, 0.05), 0.1));
ok('dist 相同=0', near(circularDayDist(0.3, 0.3), 0));

// ③ smoothstep 端点/单调
ok('smoothstep(0)=0', smoothstep(0) === 0);
ok('smoothstep(1)=1', smoothstep(1) === 1);
ok('smoothstep(0.5)=0.5', near(smoothstep(0.5), 0.5));
ok('smoothstep 单调', smoothstep(0.2) < smoothstep(0.8));

// ④ 复刻 _updateDayNight 联机分支的触发判定
const DAY_SYNC_JUMP = 0.2, DAY_SYNC_BLEND = 4;
function step(state, target, dt) {
  let { blending, blendFrom, blendT, dayTime } = state;
  let base;
  if (blending) {
    blendT = Math.min(1, blendT + dt / DAY_SYNC_BLEND);
    base = lerpDay(blendFrom, target, smoothstep(blendT));
    if (blendT >= 1) blending = false;
  } else if (circularDayDist(dayTime, target) > DAY_SYNC_JUMP) {
    blendFrom = dayTime; blendT = 0; blending = true; base = blendFrom;
  } else {
    base = target;
  }
  return { blending, blendFrom, blendT, dayTime: base, base };
}

// 本地正午(0.5) 进服遇服务器深夜(0.95) → 触发过渡，首帧保持当前（不硬跳）
let st = { blending: false, blendFrom: 0, blendT: 0, dayTime: 0.5 };
let r = step(st, 0.95, 1 / 60);
ok('大跳变触发过渡', r.blending === true);
ok('首帧保持当前(不硬跳)', near(r.base, 0.5));

// 本地正午 遇服务器只差 0.1(0.6) → 不触发，直接采用（变化极小无感）
st = { blending: false, blendFrom: 0, blendT: 0, dayTime: 0.5 };
r = step(st, 0.6, 1 / 60);
ok('小差不触发过渡', r.blending === false);
ok('小差直接采用 target', near(r.base, 0.6));

// ⑤ 整段过渡曲线：本地0.5 → 服务器0.95（固定 target，忽略外推的微小量），跑满 4s
st = { blending: false, blendFrom: 0, blendT: 0, dayTime: 0.5 };
const dt = 1 / 60;
let prev = 0.5, maxJump = 0, monotonic = true;
const frames = Math.ceil(DAY_SYNC_BLEND / dt) + 5;
for (let i = 0; i < frames; i++) {
  r = step(st, 0.95, dt);
  st = r;
  const cur = r.base;
  const jump = Math.abs(((cur - prev + 0.5) % 1) - 0.5); // 最短弧单帧差
  if (jump > maxJump) maxJump = jump;
  if (cur < prev - 1e-9) monotonic = false; // 0.5→0.95 不跨零点，应单调增
  prev = cur;
}
ok('过渡末段抵达服务器时刻', near(prev, 0.95, 1e-3));
ok('过渡途中无大跳变(单帧<0.05)', maxJump < 0.05);
ok('过渡单调(不来回抖)', monotonic === true);

console.log(`\n[probe-day-blend] 通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
