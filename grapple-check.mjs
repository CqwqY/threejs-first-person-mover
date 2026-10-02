// 纯逻辑自检（不依赖浏览器/WebGL）：
//  1) 柱子布局必须确定性（各端一致）且数量达标、间距合理
//  2) 手机技能弧的几何：相邻槽位不能叠在一起、弧必须落在跳跃键上方
//  3) 抓钩射线×AABB 的 slab 求交（复刻 Game._rayAabb 的算法，验证边界情形）
// 用法：node grapple-check.mjs
import { buildPillarLayout } from './src/world/GrappleArena.js';
import { Config } from './src/config.js';

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log('  FAIL ' + msg); } else { console.log('  ok   ' + msg); } };

console.log('== 1. 柱子布局 ==');
const a = buildPillarLayout();
const b = buildPillarLayout();
ok(a.length === Config.GRAPPLE_PILLAR_COUNT, '数量 = ' + Config.GRAPPLE_PILLAR_COUNT + '（实际 ' + a.length + '）');
ok(JSON.stringify(a) === JSON.stringify(b), '两次构建完全一致（确定性）');
let minPair = Infinity;
for (let i = 0; i < a.length; i++) {
  for (let j = i + 1; j < a.length; j++) minPair = Math.min(minPair, Math.hypot(a[i].x - a[j].x, a[i].z - a[j].z));
}
ok(minPair >= 5.19, '柱子两两间距 ≥ 5.2（实际最小 ' + minPair.toFixed(3) + '）');
ok(a.every((p) => p.topY > 2.5 && p.topY < 9.5), '顶面高度在 2.6~9.4 之间');
ok(a.every((p) => Math.hypot(p.x, p.z) < Config.GRAPPLE_ARENA_HALF - 1), '全部落在墙内');
// 出生平台环（半径 15）不能被柱子占住
const bad = a.filter((p) => Math.abs(Math.hypot(p.x, p.z) - 15) < 3);
ok(bad.length === 0, '柱子不与出生平台环重叠（实际 ' + bad.length + ' 个）');

console.log('== 2. 手机技能弧几何 ==');
// 与 SkillSlots.layoutArc 同一套参数
const R_OF = (n) => Math.min(200, Math.max(104, (n - 1) * 30));
const SLOT = 58; // clamp(42,12vmin,58) 的保守上限
const A0 = 178 * Math.PI / 180;
const A1 = 70 * Math.PI / 180;
for (const n of [1, 2, 3, 4, 5, 6, 8]) {
  const R = R_OF(n);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const ang = n === 1 ? Math.PI / 2 : (A0 + (A1 - A0) * (i / (n - 1)));
    pts.push({ x: Math.cos(ang) * R, y: -Math.sin(ang) * R });
  }
  let minD = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) minD = Math.min(minD, Math.hypot(pts[i].x - pts[i + 1].x, pts[i].y - pts[i + 1].y));
  const above = pts.every((p) => p.y <= 0.001); // 屏幕 y 向下：≤0 = 在圆心上方（跳跃键上方）
  ok(above, n + ' 槽：全部位于跳跃键上方');
  if (n > 1) ok(minD >= SLOT * 0.72, n + ' 槽：相邻中心距 ' + minD.toFixed(1) + 'px（不严重重叠）');
  console.log('     n=' + n + ' R=' + R.toFixed(0) + (n > 1 ? ' 间距=' + minD.toFixed(1) : ''));
}

console.log('== 3. 射线 × AABB ==');
// 复刻 Game._rayAabb
function rayAabb(o, d, b) {
  let tmin = 0;
  let tmax = Infinity;
  const lo = [b.cx - b.hx, b.cy - b.hy, b.cz - b.hz];
  const hi = [b.cx + b.hx, b.cy + b.hy, b.cz + b.hz];
  const oo = [o.x, o.y, o.z];
  const dd = [d.x, d.y, d.z];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(dd[i]) < 1e-8) {
      if (oo[i] < lo[i] || oo[i] > hi[i]) return null;
      continue;
    }
    let t1 = (lo[i] - oo[i]) / dd[i];
    let t2 = (hi[i] - oo[i]) / dd[i];
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  return tmin;
}
const box = { cx: 0, cy: 5, cz: -10, hx: 1, hy: 1, hz: 1 };
const hit = rayAabb({ x: 0, y: 5, z: 0 }, { x: 0, y: 0, z: -1 }, box);
ok(hit != null && Math.abs(hit - 9) < 1e-6, '正对命中，距离 9（实际 ' + hit + '）');
ok(rayAabb({ x: 5, y: 5, z: 0 }, { x: 0, y: 0, z: -1 }, box) === null, '横向偏离 → 不命中');
ok(rayAabb({ x: 0, y: 5, z: 0 }, { x: 1, y: 0, z: 0 }, box) === null, '背向 → 不命中');
// 射程不在这里判定：_rayHitWorld 用 best=maxDist 淘汰，所以远处命中会返回一个 > maxDist 的 t
const farBox = { cx: 0, cy: 5, cz: -100, hx: 1, hy: 1, hz: 1 };
const farT = rayAabb({ x: 0, y: 5, z: 0 }, { x: 0, y: 0, z: -1 }, farBox);
ok(farT != null && farT > Config.GRAPPLE_RANGE, '超距目标由调用方按 maxDist=' + Config.GRAPPLE_RANGE + ' 淘汰（t=' + farT + '）');
const inside = rayAabb({ x: 0.5, y: 5, z: -10 }, { x: 0, y: 0, z: -1 }, box);
ok(inside === 0, '起点在盒内 → 0（实际 ' + inside + '）');

console.log(fails === 0 ? '\nPASS' : '\n' + fails + ' FAILED');
process.exit(fails === 0 ? 0 : 1);
