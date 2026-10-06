// 静态自检：perftest 现在跑真实玩家物理解算（对齐实机 CPU 开销）+ auto 起步档对齐游戏。
// 不启动浏览器，只断言源码里关键实现齐备，避免「改了但漏接」的静默失效。
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dir, '..');
const SRC = readFileSync(resolve(root, 'src/perf/PerfBench.js'), 'utf8');
const HTML = readFileSync(resolve(root, 'perftest.html'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } }

// ---- 1. 物理玩家注入 ----
ok('导入 PlayerPhysics', SRC.includes("import { PlayerPhysics } from '../player/PlayerPhysics.js'"));
ok('模块级 physPlayer 声明', /let physPlayer = null;/.test(SRC));
ok('buildScene 内 new PlayerPhysics', SRC.includes('physPlayer = new PlayerPhysics();'));
ok('碰撞体写入 state.colliders', SRC.includes('state.colliders = colliders;'));
ok('每帧调用 physPlayer.update', SRC.includes('physPlayer.update(dtSec, PERF_INPUT, 0, perfState, state.colliders)'));
ok('物理玩家沿航点推进（physDist）', SRC.includes('state.physDist = (state.physDist || 0) + CAM_SPEED * dtSec'));
ok('零输入桩 PERF_INPUT 定义', SRC.includes('const PERF_INPUT = {'));
ok('perfState 载体定义', SRC.includes('const perfState = { x: 0, y: 1.7, z: 0, onGround: false }'));
ok('物理在 render 之前跑（与游戏一致：先算状态再渲）',
  SRC.includes('physPlayer.update(dtSec, PERF_INPUT, 0, perfState, state.colliders)') &&
  SRC.indexOf('physPlayer.update') < SRC.indexOf('renderer.render(scene, camera);'));

// ---- 2. auto 起步档对齐游戏 _autoStartScale（high=1/mid=0.85/low=0.7）----
ok('autoStartScaleFor 定义且 mid=0.85',
  /function autoStartScaleFor\(q\)\s*\{\s*return \(\{ high: 1, mid: 0\.85, low: 0\.7 \}\)\[q\] \|\| 0\.85;/.test(SRC));
ok('start() 用 autoStartScaleFor 设起步（非硬编码 1）',
  SRC.includes('state.dynScale = autoStartScaleFor(state.quality)'));
ok('auto 自适应地板 0.5', SRC.includes('const FLOOR = 0.5;'));

// ---- 3. 导出标注（避免被误读为实机帧率）----
ok('meta 含 simulatedCpu', SRC.includes("simulatedCpu: 'physics(local)'"));
ok('meta 含平均有效分辨率 renderScaleAvg', SRC.includes('renderScaleAvg:'));
ok('自适应累计 dynSum/dynN', SRC.includes('state.dynSum += s; state.dynN++;'));

// ---- 4. UI 引导用 auto 档 ----
ok('html 提示用 auto 档且说明是实机上限',
  HTML.includes('测手机务必用 <b>auto</b> 档') && HTML.includes('是实机帧率的<b>上限</b>'));
ok('html 默认 auto 已选中', /<option value="auto" selected>/.test(HTML));

// ---- 5. 与真实游戏口径一致性（这些常量必须和 Game.js 同源）----
ok('QUALITY_DPR mid=1.5 与 Game presets.dpr 对齐',
  /QUALITY_DPR = \(\{ high: 2, mid: 1\.5, low: 1 \}\)/.test(SRC));

console.log('\nprobe-perftest-cpu: ' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
