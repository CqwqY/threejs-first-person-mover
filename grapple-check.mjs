// 纯逻辑自检（不依赖浏览器/WebGL）：
//  1) 柱子布局必须确定性（各端一致）且数量达标、间距合理
//  2) 手机技能轮盘的几何：全部落在按钮上方、扇区角度与槽位序号可逆、缩放后不叠在一起
//  3) 静态确认抓钩/掉落物已改用 worldQuery（其数学在 world-query-check.mjs 里逐条验证）
// 用法：node grapple-check.mjs
import { readFileSync } from 'node:fs';
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

console.log('== 2. 手机技能轮盘几何 ==');
// 与 SkillSlots.layoutWheel / sectorIndex 同一套公式
const SLOT_PX_OF = (vmin) => Math.min(56, Math.max(42, vmin * 0.12)); // clamp(42px,12vmin,56px)
const WHEEL_R_OF = (vmin) => Math.round(Math.min(112, Math.max(74, vmin * 0.19)));
const FAN_HI = 160; // 左上方（度）
const FAN_LO = 20;  // 右上方
const SPAN = (FAN_HI - FAN_LO) * Math.PI / 180;
const SCALE_OF = (n, R, slotPx) => {
  if (n <= 1) return 1;
  const chord = 2 * R * Math.sin(SPAN / (2 * (n - 1)));
  return Math.max(0.58, Math.min(1, chord / (slotPx * 1.06)));
};
const SECTOR_OF = (ang, n) => (n <= 1 ? 0
  : Math.round(Math.max(0, Math.min(1, (FAN_HI - ang) / (FAN_HI - FAN_LO))) * (n - 1)));
// 屏幕坐标：y 向下，所以「上方」= y ≤ 0
const POINTS_OF = (n, R, flip) => {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const deg = n === 1 ? 90 : (FAN_HI - (FAN_HI - FAN_LO) * (i / (n - 1)));
    const a = deg * Math.PI / 180;
    pts.push({ x: Math.cos(a) * R, y: -flip * Math.sin(a) * R, deg });
  }
  return pts;
};
for (const vmin of [360, 480, 820]) {
  for (const n of [1, 2, 3, 4, 5, 6, 8]) {
    const R = WHEEL_R_OF(vmin);
    const slotPx = SLOT_PX_OF(vmin);
    const scale = SCALE_OF(n, R, slotPx);
    const pts = POINTS_OF(n, R, 1);
    ok(pts.every((p) => p.y <= 1e-9), 'vmin=' + vmin + ' n=' + n + '：轮盘全部落在按钮上方');
    // 扇形角度按顺序均匀铺开：手指角度必须能原样映射回第 i 个槽
    const back = pts.map((p) => SECTOR_OF(p.deg, n));
    ok(back.every((v, i) => v === i), 'vmin=' + vmin + ' n=' + n + '：扇区角度 ↔ 槽位序号可逆（' + back.join(',') + '）');
    // 缩放后的实际间距：不能叠得看不清（≥ 自身尺寸的 0.62）
    let minD = Infinity;
    for (let i = 0; i + 1 < pts.length; i++) minD = Math.min(minD, Math.hypot(pts[i].x - pts[i + 1].x, pts[i].y - pts[i + 1].y));
    if (n > 1) {
      const eff = minD * (1);
      ok(eff >= slotPx * scale * 0.62, 'vmin=' + vmin + ' n=' + n + '：间距 ' + eff.toFixed(1) + 'px vs 槽位 ' + (slotPx * scale).toFixed(1) + 'px（缩放 ' + scale.toFixed(2) + '）');
    }
  }
}
// 按钮贴着屏幕顶部时，轮盘要翻到下方（否则会跑出屏幕）
const cyTop = 30;
const R1 = WHEEL_R_OF(480);
const flipTop = (cyTop - 8 < R1 + 56 * 0.9) ? -1 : 1;
ok(flipTop === -1, '按钮贴近顶部 → 轮盘翻到下方（flip=' + flipTop + '）');
const cyBottom = 500;
const flipBottom = (cyBottom - 8 < R1 + 56 * 0.9) ? -1 : 1;
ok(flipBottom === 1, '按钮在常规位置（跳跃键上方）→ 轮盘朝上展开');
ok(POINTS_OF(4, R1, -1).every((p) => p.y >= -1e-9), '翻到下方时全部落在按钮下方');

// 抓钩的射线求交已下沉到 src/world/collision/worldQuery.js（盒 OBB / 凸包 / trimesh / 隐式地面），
// 专项测试在 world-query-check.mjs，这里不重复。只做一次静态确认：Game 不再自带那套 AABB 近似。
const gameSrc = readFileSync(new URL('./src/core/Game.js', import.meta.url), 'utf8');
ok(!gameSrc.includes('_rayAabb('), 'Game._rayAabb 已移除（改用 worldQuery.raycastWorld）');
ok(gameSrc.includes('raycastWorld('), '抓钩射线走 worldQuery.raycastWorld');
ok(gameSrc.includes('moveSphereWorld('), '掉落物物理走 worldQuery.moveSphereWorld');

console.log(fails === 0 ? '\nPASS' : '\n' + fails + ' FAILED');
process.exit(fails === 0 ? 0 : 1);
