// 自检：填充率治理（自适应分辨率 + 阴影重渲策略）
//
// 依据 fpm-perf-20261006-102317.json：基线 1.0× 仅 18.2fps，把分辨率压到
//   0.5× → 49.4fps（2.7×）；关面光源/环境反射几乎无变化（18.2→18.3）。
//   结论：填充率（像素着色）是唯一瓶颈，分辨率是唯一有效杠杆。
//
// ⚠ 2026-11-07 校准：自适应决策逻辑早已抽到 src/core/AdaptiveScale.js（纯函数，Node 可测），
//   Game._adaptResolution 只负责落字段；旧版这里还按 Game.js 里的硬编码常量
//   （FLOOR=0.5 / +0.08 / RAISE=54 / 1000ms / _shadowTick%3）做字符串断言，全是假失败。
//   现在改为：常量直接 import 真值 + 真跑决策函数 + Game 接线静态断言。
//
// 跑法：node tools/probe-adaptive-res.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPT, adaptScaleDecision, tsrScaleCap } from '../src/core/AdaptiveScale.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const game = read('src/core/Game.js');
const logic = read('src/core/AdaptiveScale.js');
let fails = 0;
function ok(cond, msg) {
  if (cond) console.log('  PASS  ' + msg);
  else { console.log('  FAIL  ' + msg); fails++; }
}
function eq(a, b, msg) {
  if (a === b) console.log('  PASS  ' + msg + '  (' + a + ')');
  else { console.log('  FAIL  ' + msg + '  got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)); fails++; }
}
function near(a, b, tol, msg) {
  ok(Math.abs(a - b) <= tol, msg + '  (' + a.toFixed(6) + ' vs ' + b.toFixed(6) + ')');
}

// ---------------------------------------------------------------- ① 常量
console.log('\n[1] 自适应常量（真值，来自 AdaptiveScale.js）');
eq(ADAPT.FLOOR, 0.5, '地板 0.5×：实测甜点，再低收益递减（E5: 0.5×→49.4fps）');
eq(ADAPT.DROP, 42, 'DROP = 42');
eq(ADAPT.RAISE, 56, 'RAISE = 56（贴近 vsync 上限，别一流畅就猛升）');
eq(ADAPT.DROP_STEP, 0.15, '降档步长 0.15');
eq(ADAPT.RAISE_STEP, 0.04, '升档步长 0.04（旧 0.08 太跳）');
eq(ADAPT.MIN_INTERVAL, 2000, '节流 2s（旧 1s 会频繁重建 drawingBuffer）');
eq(ADAPT.RAISE_COOLDOWN, 5000, '降档后 5s 冷却，治降→升→降震荡');
eq(ADAPT.CEIL, 0.95, '自动上限 0.95');
eq(ADAPT.UPSCALE_LIMIT, 0.98, '超分路径阈值 0.98');
ok(ADAPT.DROP < ADAPT.RAISE && ADAPT.CEIL < ADAPT.UPSCALE_LIMIT,
  '迟滞与硬切阈值有序（永不跨 0.98 突然切画质/色调）');
ok(/export function adaptScaleDecision/.test(logic), '决策逻辑是导出的纯函数');
ok(/只读入参|不改入参/.test(logic), '纯函数不改入参');

// ---------------------------------------------------------------- ② 真跑决策
console.log('\n[2] 真跑：降档 / 地板 / 升档 / 节流 / 冷却');
const d1 = adaptScaleDecision({ scale: 0.8, lastChange: 0, lastDrop: -1e9 }, 30, 10000);
near(d1.scale, 0.65, 1e-9, 'fps=30 从 0.8 降 0.15');
let low = { scale: 0.6, lastChange: 0, lastDrop: -1e9 };
for (let i = 0; i < 6; i++) {
  low = adaptScaleDecision(low, 20, 10000 + i * (ADAPT.MIN_INTERVAL + 1)) || low;
}
near(low.scale, ADAPT.FLOOR, 1e-9, '持续掉帧停在 0.5 地板，不会更低');
eq(adaptScaleDecision(low, 20, 99999), null, '触底后不再降');
eq(adaptScaleDecision({ scale: 0.8, lastChange: 0, lastDrop: -1e9 }, 50, 10000), null,
  '迟滞区间内不动');
eq(adaptScaleDecision({ scale: 0.8, lastChange: 0, lastDrop: -1e9 }, 60, 1000), null,
  'MIN_INTERVAL 内不重复调整');
const cool = adaptScaleDecision(d1, 60, 10000 + ADAPT.MIN_INTERVAL + 1);
eq(cool, null, '刚降档就流畅：冷却期内不回升');
const afterCool = adaptScaleDecision(d1, 60, 10000 + ADAPT.RAISE_COOLDOWN + 1);
ok(!!afterCool && afterCool.scale > d1.scale, '冷却结束后才允许回升');
eq(tsrScaleCap(null, 0.78), 0.78, 'TSR 自动上限 0.78（本轮新增区间）');

// ---------------------------------------------------------------- ③ Game 接线
console.log('\n[3] Game 接线：起点 / 决策入口 / 硬钳');
ok(/import \{ ADAPT, adaptScaleDecision, tsrScaleCap \}/.test(game), '导入纯逻辑模块');
ok(/adaptScaleDecision\(/.test(game) && /_dynDropAt/.test(game), '_adaptResolution 走纯决策并维护冷却');
ok(/_autoStartScale\(\)/.test(game), '_autoStartScale 集中起点逻辑');
ok(/q === 'high' \? 1 : q === 'mid' \? 0\.85 : 0\.7/.test(game), '非 TSR 的画质档起点 high/mid/low');
ok(/TSR_AUTO_TARGET/.test(game), 'TSR 开启时改走 0.67× 区间');
ok(/this\._dynScale = this\._autoStartScale\(\)/.test(game), '画质切换 / 设置切换用统一起点');
ok(/ADAPT\.CEIL/.test(game), '_applyRenderScale 仍保留自动模式硬钳');

// ---------------------------------------------------------------- ④ 阴影
console.log('\n[4] 阴影重渲策略（烘焙优先，旧 _shadowTick 已退役）');
ok(/_bakedReady/.test(game) && /_shadowPhaseDirty/.test(game),
  '烘焙就绪后按相位换贴图，shadow pass 整个跳过');
ok(/每 3 帧重渲/.test(game), '未烘焙路径的节流注释保留实测依据');
ok(!/_shadowTick\s*=\s*\(this\._shadowTick\s*\+\s*1\)\s*%\s*3/.test(game),
  '旧的 _shadowTick % 3 已被烘焙策略取代');

console.log('\n' + (fails ? '✗ ' + fails + ' 项失败' : '✓ 全部通过'));
process.exit(fails ? 1 : 0);
