// 自检：本轮四改动（夜晚白黑闪 / 失阴影改 XZ / 填充率再抠 / 手机测试对齐实机）
//
// ① 天空穹顶交叉淡入：当前(from)恒不透明 → 透明球壳数恒 ≤1 → 杜绝两张同位透明球壳
//    在手机 TBDR 上逐帧抢序导致的整屏白黑闪。
// ② 灯光失阴影的判据：从 3D 距离改为只算 XZ 平面（忽略 Y），同一竖井上下灯照样保阴影。
// ③ 填充率再抠：MSAA 仅原生分辨率上（降分辨率时主 pass 已被砍，MSAA 的 2~4× 填充乘数纯浪费，
//    锐化升采样已补偿边缘）。
// ④ 手机测试台对齐实机：加 auto 档（镜像游戏 _adaptResolution），默认开启 → 弱机帧率 = 实机。
//
// 跑法：node tools/probe-night-xz-fill.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const srcLights = read('src/world/Lights.js');
const srcSky = read('src/world/SkyBox.js');
const srcGame = read('src/core/Game.js');
const srcBench = read('src/perf/PerfBench.js');
const htmlPerf = read('perftest.html');
let fails = 0;
function ok(cond, msg) { if (cond) console.log('  PASS  ' + msg); else { console.log('  FAIL  ' + msg); fails++; } }
function has(src, re, msg) { ok(re.test(src), msg); }

// ---------------------------------------------------------------- ① 天空穹顶白黑闪
console.log('\n[1] 天空穹顶交叉淡入：当前(from)恒不透明，透明球壳数恒 ≤1（防手机 TBDR 白黑闪）');
has(srcSky, /const wantTransparent = opacity < 0\.999;/, 'update 里按 opacity 决定透明开关');
has(srcSky, /mat\.transparent !== wantTransparent/, 'transparent 翻转才置 needsUpdate（不每帧重编译）');
has(srcSky, /杜绝两张透明球壳抢序|整屏白黑闪|白黑闪/, '注释点明「两张透明球壳抢序 → 整屏白黑闪」的修复意图');

// ---------------------------------------------------------------- ② 失阴影判据改 XZ
console.log('\n[2] 灯光失阴影判据：3D 距离 → 仅 XZ 平面（忽略 Y）');
has(srcLights, /list\.push\(\[dx \* dx \+ dz \* dz, l\]\)/, 'rebalance 只用 dx²+dz²（水平距离）');
ok(!/dx \* dx \+ dy \* dy \+ dz \* dz/.test(srcLights), '旧的 3D 距离（含 dy²）已移除');
has(srcLights, /只看水平距离，忽略 Y/, '注释说明「只看水平距离，忽略 Y」');

// ---------------------------------------------------------------- ③ 填充率：MSAA 仅原生分辨率
console.log('\n[3] 填充率再抠：降分辨率时不再上 MSAA（锐化升采样已补偿边缘）');
has(srcGame, /_upSamples\(s\)\s*\{[\s\S]*?if \(!this\._aaOn\) return 0;[\s\S]*?if \(s >= 0\.999\) return 4;[\s\S]*?return 0;/,
  '_upSamples：关 → 原生(≥0.999)给 4× → 其余 0（不再有 0.7/0.85 两档）');
ok(!/if \(s <= 0\.85\) return 2;/.test(srcGame), '旧的「0.85→2×」档已移除');
ok(!/if \(s <= 0\.7\) return 0;/.test(srcGame), '旧的「0.7」边界已移除');

// ---------------------------------------------------------------- ④ 手机测试台对齐实机（auto 档）
console.log('\n[4] 手机测试台加 auto 档（镜像游戏自适应分辨率），默认开启 → 帧率=实机');
has(htmlPerf, /<option value="auto" selected>/, 'perftest.html 分辨率默认 auto（跟随游戏）');
has(srcBench, /state\.autoScale = \(sv === 'auto'\)/, '读到 autoScale 标志');
has(srcBench, /function adaptResolution\(fps\)/, '实现 adaptResolution（同源游戏 _adaptResolution）');
has(srcBench, /function basePR\(\)/, 'basePR：min(设备像素比, 画质档 dpr 封顶)，与游戏一致');
has(srcBench, /function currentPR\(\)/, 'currentPR：auto 模式返回 basePR×dynScale');
has(srcBench, /renderer\.setPixelRatio\(currentPR\(\)\)/, 'applyScenario 还原像素比走 currentPR（auto/固定统一入口）');
has(srcBench, /renderer\.setPixelRatio\(basePR\(\) \* 0\.5\)/, 'E5 0.5× 与游戏 renderScale 同语义（乘基准）');
has(srcBench, /adaptResolution\(1000 \/ ms\)/, 'tick 里按真实帧率收敛（auto 模式）');

console.log('\n' + (fails ? `✗ ${fails} 项失败` : '✓ 全部通过'));
process.exit(fails ? 1 : 0);
