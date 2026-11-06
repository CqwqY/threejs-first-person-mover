// 自检：自适应分辨率不再跨「超分阈值」硬切渲染路径 + 两条路径色调管线一致 + 夜间环境光地板。
//   node tools/probe-adaptive-quality.mjs
//
// 背景（用户报的「一流畅画质突然很高、环境光色调都变了」）：
//   ① 老逻辑 fps>54 每秒 +0.08 一路升到 1.0×，跨过 _useUpscale() 的 0.98 判据
//      → 渲染路径从「低分 RT + 升采样」硬切成「原生直渲」；
//   ② Three 渲进 RT 时不做 toneMapping（线性输出），升采样那趟只补 sRGB、漏了 ACES
//      → 两条路径颜色不一致，路径一切换整屏色调跟着变。
// 这里既真跑自适应决策，也静态钉死 shader 顺序与夜间参数，防止以后被改回去。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPT, adaptScaleDecision } from '../src/core/AdaptiveScale.js';
import { Config } from '../src/config.js';
import { envAt } from '../src/world/SkyBox.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' | ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'got=' + a + ' want=' + b); }
function near(a, b, eps, name) { ok(Math.abs(a - b) <= eps, name, 'got=' + a + ' want≈' + b); }

// 抽方法体：必须锚在「行首两空格 + 方法名(」的**定义**上，再用花括号配对收尾。
// 直接 indexOf('xxx(') 会命中早先出现的调用（例如设置面板 binds 里的 this._applyRenderScale()），
// 之后找到的第一个 { 属于别的方法体，断言就会假失败。
function methodBlock(src, name) {
  const re = new RegExp('\\n  ' + name + '\\(');
  const m = re.exec(src);
  if (!m) return '';
  const open = src.indexOf('{', m.index + m[0].length);
  if (open < 0) return '';
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return src.slice(open, k + 1);
  }
  return '';
}

console.log('常量护栏：');
ok(ADAPT.CEIL < ADAPT.UPSCALE_LIMIT,
  '自动模式上限 ' + ADAPT.CEIL + ' < 超分阈值 ' + ADAPT.UPSCALE_LIMIT + '（永不硬切路径）');
ok(ADAPT.FLOOR < ADAPT.CEIL && ADAPT.DROP < ADAPT.RAISE, '地板/上限、降档/升档阈值有序');
ok(ADAPT.RAISE_STEP < ADAPT.DROP_STEP, '升档步长小于降档步长（回升要慢）');

console.log('真跑决策：一路流畅也不越阈值');
let st = { scale: ADAPT.FLOOR, lastChange: 0, lastDrop: -1e9 };
let now = 0, rises = 0, maxScale = st.scale;
for (let i = 0; i < 80; i++) {
  now += 2500; // 每 2.5s 结算一次，> MIN_INTERVAL
  const d = adaptScaleDecision(st, 60, now);
  if (d) {
    ok(d.scale < ADAPT.UPSCALE_LIMIT, '第 ' + (i + 1) + ' 次升档仍在超分区间内', 'scale=' + d.scale);
    rises++;
    st = d;
    maxScale = Math.max(maxScale, st.scale);
  }
}
ok(rises > 5, '确实发生过多次升档（不是把自适应整个关掉）', 'rises=' + rises);
near(maxScale, ADAPT.CEIL, 1e-9, '最终收敛到自动上限 ' + ADAPT.CEIL);
eq(adaptScaleDecision(st, 60, now + 2500), null, '到顶后不再升');

console.log('节流、冷却、地板、迟滞：');
const lastStep = adaptScaleDecision({ scale: ADAPT.CEIL - 0.01, lastChange: 0, lastDrop: -1e9 }, 60, 10000);
ok(!!lastStep && Math.abs(lastStep.scale - ADAPT.CEIL) < 1e-9,
  '最后一小步能真正收敛到上限（防 0.01 判据把 0.94→0.95 吃掉）',
  'got=' + (lastStep ? lastStep.scale : 'null'));
eq(adaptScaleDecision(st, 60, now + 1000), null, 'MIN_INTERVAL 内不重复调整');
eq(adaptScaleDecision(st, 50, now + 2500), null, 'fps 落在迟滞区间内不动');
eq(adaptScaleDecision(st, 0, now + 2500), null, 'fps=0 不调整');
eq(adaptScaleDecision(st, NaN, now + 2500), null, 'fps=NaN 不调整');

// 掉帧降档 → 立刻流畅：冷却期内不许升，冷却过后才升。
let drop = adaptScaleDecision({ scale: 0.9, lastChange: 0, lastDrop: -1e9 }, 30, 10000);
ok(!!drop, 'fps=30 触发降档');
ok(drop.scale < 0.9 && drop.scale < ADAPT.UPSCALE_LIMIT, '降档结果仍在超分区间内', 'scale=' + drop.scale);
ok(drop.lastDrop === 10000, '降档记录了时刻');
eq(adaptScaleDecision(drop, 60, 10000 + ADAPT.MIN_INTERVAL + 1), null, '降档后立刻流畅：冷却期内不回升');
const cooled = adaptScaleDecision(drop, 60, 10000 + ADAPT.RAISE_COOLDOWN + 1);
ok(!!cooled && cooled.scale > drop.scale, '冷却结束后允许小幅回升');

let low = { scale: 0.8, lastChange: 0, lastDrop: -1e9 };
for (let i = 0; i < 20; i++) {
  low = adaptScaleDecision(low, 20, 10000 + (i + 1) * ADAPT.MIN_INTERVAL) || low;
}
near(low.scale, ADAPT.FLOOR, 1e-9, '持续掉帧最终停在地板，不会无限降');

// 入参被别处写成 1.0（构造期默认值）时，降档结果也必须落回超分区间。
const fromOne = adaptScaleDecision({ scale: 1, lastChange: 0, lastDrop: -1e9 }, 30, 10000);
ok(!!fromOne && fromOne.scale < ADAPT.UPSCALE_LIMIT, '从 1.0× 起步降档后回到超分区间');

console.log('静态闸门：Game.js 的接入与色彩管线');
const game = read('src/core/Game.js');
ok(/ADAPT, adaptScaleDecision/.test(game), '导入了自适应纯逻辑模块');
ok(/ADAPT\.UPSCALE_LIMIT/.test(game), '_useUpscale 共用同一个阈值常量');
ok(/this\._dynDropAt = -1e9/.test(game), '构造期初始化降档冷却时刻（防 NaN 静默失效）');
const applyScale = methodBlock(game, '_applyRenderScale');
ok(/ADAPT\.CEIL/.test(applyScale), '_applyRenderScale 内有自动模式硬钳（覆盖所有设 1.0 的入口）');
const startScale = methodBlock(game, '_autoStartScale');
ok(/ADAPT\.CEIL/.test(startScale), '画质档起点也封在自动上限内');
const adapt = methodBlock(game, '_adaptResolution');
ok(/adaptScaleDecision\(/.test(adapt) && /_dynDropAt/.test(adapt), '自适应主入口走纯决策函数并维护冷却');
ok(!/s \+ 0\.08/.test(adapt), '老的一秒 +0.08 猛升逻辑已移除');

// shader 顺序：RT 里是线性色，必须 tonemapping 在前、colorspace 在后，且不能在 tonemap 前截到 1.0。
const cas = methodBlock(game, '_ensureUpscale');
const iTone = cas.indexOf('#include <tonemapping_fragment>');
const iColor = cas.indexOf('#include <colorspace_fragment>');
ok(iTone >= 0 && iColor > iTone, 'CAS 升采样补了 ACES，且顺序为 tonemapping → colorspace');
ok(/vec4\(max\(sharp, 0\.0\), 1\.0\)/.test(cas), 'tonemap 之前不再把 HDR 截到 1.0');
ok(!/clamp\(sharp, 0\.0, 1\.0\)/.test(cas), '旧的硬 clip 已移除');
ok(/toneMapped: true/.test(cas), '升采样材质显式 toneMapped=true（ACES 注入的前提）');
// 证明「在 ShaderMaterial 里写 #include <tonemapping_fragment>」确实会被 three 展开成 ACES，
// 而不是写了也没人实现（否则等于没修）。
const programs = read('node_modules/three/src/renderers/webgl/WebGLPrograms.js');
const program = read('node_modules/three/src/renderers/webgl/WebGLProgram.js');
ok(/toneMapping = renderer\.toneMapping/.test(programs) && /currentRenderTarget === null/.test(programs),
  'Three：只有渲到屏幕才做 toneMapping（渲进 RT 时是线性色）');
ok(/tonemapping_pars_fragment/.test(program) && /#define TONE_MAPPING/.test(program),
  'Three：屏幕 pass 会注入 TONE_MAPPING 与 ACES 函数，ShaderMaterial 的 include 有效');

console.log('静态闸门：夜间环境光');
const cfg = read('src/config.js');
const sky = read('src/world/SkyBox.js');
const dayNight = methodBlock(game, '_updateDayNight');
ok(/Config\.NIGHT_AMBIENT_MIN/.test(dayNight) && /Config\.NIGHT_HEMI_MIN/.test(dayNight),
  '昼夜循环用 Config 的夜间环境光/半球光下限');
ok(/Config\.NIGHT_BG_MIN/.test(dayNight), '兜底背景夜间不再为 0');
ok(!/0\.3 \+ 0\.7 \* sunUp/.test(dayNight) && !/0\.25 \+ 0\.75 \* sunUp/.test(dayNight),
  '旧的夜间 0.30/0.25 系数已移除');
ok(/night: 0\.56, space: 0\.32/.test(sky), '时段 IBL 的 night/space 已抬亮');
ok(/NIGHT_AMBIENT_MIN/.test(cfg) && /NIGHT_HEMI_MIN/.test(cfg) && /NIGHT_BG_MIN/.test(cfg),
  'Config 里有三个可调夜间常量');

console.log('真跑夜间光照曲线：');
ok(Config.NIGHT_AMBIENT_MIN > 0.3 && Config.NIGHT_AMBIENT_MIN < 1,
  '环境光夜间地板比旧 0.30 大、且仍低于白天', 'got=' + Config.NIGHT_AMBIENT_MIN);
ok(Config.NIGHT_HEMI_MIN > 0.25 && Config.NIGHT_HEMI_MIN < 1,
  '半球光夜间地板比旧 0.25 大、且仍低于白天', 'got=' + Config.NIGHT_HEMI_MIN);
ok(Config.NIGHT_BG_MIN > 0 && Config.NIGHT_BG_MIN < 1, '背景夜间地板在 (0,1)');
// 与 Game._updateDayNight 完全相同的公式：base * (min + (1-min) * sunUp)
const ambAt = (sunUp) => 1 * (Config.NIGHT_AMBIENT_MIN + (1 - Config.NIGHT_AMBIENT_MIN) * sunUp);
const hemiAt = (sunUp) => 1 * (Config.NIGHT_HEMI_MIN + (1 - Config.NIGHT_HEMI_MIN) * sunUp);
near(ambAt(0), Config.NIGHT_AMBIENT_MIN, 1e-12, '午夜环境光 = 夜间地板');
near(ambAt(1), 1, 1e-12, '正午环境光仍是 100% 基准');
near(hemiAt(0), Config.NIGHT_HEMI_MIN, 1e-12, '午夜半球光 = 夜间地板');
near(hemiAt(1), 1, 1e-12, '正午半球光仍是 100% 基准');
ok(ambAt(0.5) > ambAt(0) && ambAt(0.5) < ambAt(1), '环境光随太阳高度单调递增');
const at = (h) => h / 24;
const nightI = envAt(at(19)).intensity, dayI = envAt(at(12)).intensity, spaceI = envAt(at(2)).intensity;
near(dayI, 1, 1e-12, '白天 IBL 强度未变');
ok(nightI > 0.45, '夜晚 IBL 比旧 0.45 更亮', 'got=' + nightI);
ok(spaceI > 0.25, '深夜 IBL 比旧 0.25 更亮', 'got=' + spaceI);
ok(dayI / spaceI >= 3, '最亮/最暗仍有 3 倍以上昼夜层次', 'ratio=' + (dayI / spaceI).toFixed(2));

console.log('静态闸门：手动 100% 仍是逃生口');
const panel = read('src/ui/SettingsPanel.js');
ok(/options: \['auto', '100'/.test(panel), '设置面板仍可手动钉 100% 走原生直渲');

console.log('\n' + (fail ? '✗ ' + fail + ' 项不符（共 ' + (pass + fail) + ' 项）'
  : '✓ 全部通过（' + pass + ' 项）'));
process.exit(fail ? 1 : 0);
