// 自检：填充率治理（自适应分辨率 + 阴影重渲频率）
//
// 依据 fpm-perf-20261006-102317.json：基线 1.0× 仅 18.2fps，把分辨率压到
//   0.5× → 49.4fps（2.7×）；关面光源/环境反射几乎无变化（18.2→18.3）。
//   结论：填充率（像素着色）是唯一瓶颈，分辨率是唯一有效杠杆。
//   游戏已有自适应分辨率，但旧地板 0.6、起步 1.0，没吃到 0.5× 的红利。
//   本探针钉死三件事：① 自适应地板=0.5 且起步按画质档给低起点；
//                     ② 降/升阈值留迟滞防横跳；③ 阴影重渲从隔帧(2)改每 3 帧。
//
// 跑法：node tools/probe-adaptive-res.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'src/core/Game.js'), 'utf8');
let fails = 0;
function ok(cond, msg) {
  if (cond) console.log('  PASS  ' + msg);
  else { console.log('  FAIL  ' + msg); fails++; }
}
function has(re, msg) { ok(re.test(src), msg); }

// ---------------------------------------------------------------- ① 自适应地板 = 0.5
console.log('\n[1] 自适应分辨率地板钉在实测甜点 0.5×');
has(/FLOOR\s*=\s*0\.5/, '_adaptResolution 里 FLOOR = 0.5（E5: 0.5×→49.4fps）');
has(/s\s*=\s*Math\.max\(FLOOR,\s*s\s*-\s*0\.15\)/, '降到地板用 0.15 步长（比旧 0.2 更细，能停准在 0.5）');
has(/s\s*=\s*Math\.min\(1,\s*s\s*\+\s*0\.08\)/, '升回用 0.08 步长');
has(/fps\s*<\s*DROP\s*&&\s*s\s*>\s*FLOOR/, '低于 DROP 且未触底才降（地板 0.5 是硬下限）');

// ---------------------------------------------------------------- ② 阈值迟滞
console.log('\n[2] 降/升阈值留 12 帧迟滞，避免横跳');
has(/DROP\s*=\s*42/, 'DROP = 42（低于此才降，留余量）');
has(/RAISE\s*=\s*54/, 'RAISE = 54（高于此才升，与 DROP 拉开迟滞）');

// ---------------------------------------------------------------- ③ 起步按画质档给低起点
console.log('\n[3] 自动模式开局即接近稳态，跳过 1.0× 卡顿爬坡');
has(/_autoStartScale\(\)\s*\{/, '_autoStartScale() 集中起点逻辑');
has(/q\s*===\s*'high'\s*\?\s*1\s*:\s*q\s*===\s*'mid'\s*\?\s*0\.85\s*:\s*0\.7/, 'high=1 / mid=0.85 / low=0.7');
has(/this\._dynScale\s*=\s*this\._autoStartScale\(\)/, '_applyQuality 用统一起点（不被初始化顺序冲掉）');
has(/this\._dynScale\s*=\s*this\._autoStartScale\(\);\s*\/\/\s*自动模式从/, '_setRenderScale(auto) 也用统一起点');

// ---------------------------------------------------------------- ④ 阴影每 3 帧重渲
console.log('\n[4] 阴影重渲频率 2→3（吃掉基线那批 67ms 巨帧）');
has(/this\._shadowTick\s*=\s*\(this\._shadowTick\s*\+\s*1\)\s*%\s*3/, '_shadowTick 改 % 3（每 3 帧重渲）');
// 旧写法必须消失，否则说明没改干净
ok(!/_shadowTick\s*=\s*\(this\._shadowTick\s*\+\s*1\)\s*&\s*1/.test(src), '旧的「& 1」隔帧写法已移除');
has(/每 3 帧重渲/, '_applyQuality 注释同步为「每 3 帧」');

// ---------------------------------------------------------------- ⑤ 节流 1s
console.log('\n[5] 重建 drawingBuffer 节流 1s（旧 1.5s，太慢跟手差）');
has(/now\s*-\s*this\._dynLast\s*<\s*1000/, '自适应节流 1000ms');

console.log('\n' + (fails ? `✗ ${fails} 项失败` : '✓ 全部通过'));
process.exit(fails ? 1 : 0);
