// 自检：着色器预热（把"第一次看见某材质 / 第一次渲阴影"的编译挪进加载屏）
//
// ⚠⚠ 为什么这条值得钉死（2026-10-06，读外部调试清单后回头审计发现的缺口）：
//   旧版 Game._precompileShaders 只有一句 renderer.compile(scene, camera)，注释却写着"（含阴影）"——**错的**。
//   Three 的 WebGLRenderer.compile()：
//     · 只遍历**当前视锥内**的对象 → 背对相机/画面外的材质不编，转身第一次看见就当场编译；
//     · **不覆盖阴影深度（depth）材质变体**（阴影 pass 是另一套程序）。
//   症状就是单帧几百毫秒~数秒的长帧，恰好出现在"转到一个方向 / 第一帧渲阴影"的时刻。
//   同一份缺口在照妖镜下更明显：测试台只做了 compile，于是**第一个场景（基线）**吃掉整个冷启动，
//   报出 maxMs 5816ms、1% Low 0.2 —— 那是冷启动，不是 gameplay 卡顿。
//
// 本探针钉住的四件事：
//   ① Game 的预热必须"compile + 真渲一帧（关视锥剔除 + 强制阴影）"，且**必须还原**；
//   ② 置位 `_shadersCompiled` 要在函数开头（失败也不重入 —— 否则每帧重试就是每帧卡）；
//   ③ 超分 RT 的 MSAA 必须按内部分辨率分档（4× 样本 = 4 倍 RT 带宽，填充率瓶颈下是纯开销）；
//   ④ 测试台的预热必须对**每个场景**都做一遍 —— no-shadow / no-sky-env 会改 SHADOWMAP / USE_ENVMAP
//      这类编译期宏，切过去的第一帧会全部重编译（上一批数据里 E4 的 maxMs 3666ms 就是这么来的）。
//
// 跑法：node tools/probe-shader-warmup.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
function ok(cond, msg) {
  if (cond) console.log('  PASS  ' + msg);
  else { console.log('  FAIL  ' + msg); fails++; }
}
function eq(a, b, msg) {
  if (a === b) console.log('  PASS  ' + msg + `  (${a})`);
  else { console.log('  FAIL  ' + msg + `  got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); fails++; }
}

const game = fs.readFileSync(path.join(ROOT, 'src/core/Game.js'), 'utf8');
const bench = fs.readFileSync(path.join(ROOT, 'src/perf/PerfBench.js'), 'utf8');
const page = fs.readFileSync(path.join(ROOT, 'perftest.html'), 'utf8');

// ⚠ 本项目探针的固定坑：src.slice(indexOf('某函数')) 会一路扫到**文件末尾**，
//   把后面新加的函数一起断言进去。一律用**花括号配对**把函数体精确抽出来。
function blockAt(src, anchor) {
  const i = src.indexOf(anchor);
  if (i < 0) return '';
  const s = src.indexOf('{', i);
  if (s < 0) return '';
  let d = 0;
  for (let k = s; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); }
  }
  return src.slice(i);
}

// ---------------------------------------------------------------- ① Game 预热三步
console.log('\n[1] Game._precompileShaders：compile + 真渲一帧，且状态必须还原');
const warm = blockAt(game, '_precompileShaders() {');
ok(warm.length > 200, '抽到 _precompileShaders 函数体（花括号配对）');
ok(/r\.compile\(this\.scene, this\.camera\)/.test(warm), '① 先做 compile(scene, camera)（编当前视锥内的主 pass）');
ok(/frustumCulled = false/.test(warm), '② 临时关掉视锥剔除（把所有材质都提交给编译器）');
ok(/r\.render\(this\.scene, this\.camera\)/.test(warm), '③ 真的渲一帧（只 compile 覆盖不到阴影深度变体）');
ok(/shadowMap\.autoUpdate = true/.test(warm), '③ 渲染前强制打开阴影自动更新（让 depth 变体也编掉）');
ok(/finally/.test(warm), '还原写在 finally 里（抛异常也不会把 frustumCulled 永久改坏）');
ok(/o\.frustumCulled = true/.test(warm), '还原 frustumCulled');
ok(/shadowMap\.autoUpdate = prevAuto/.test(warm), '还原 shadowMap.autoUpdate');
// 收集到的对象必须逐个还原，不能只还原"关掉的那些里的第一个"
ok(/for \(const o of toggled\)/.test(warm), '逐个还原被改过的对象（不是抽样还原）');

console.log('\n[2] 预热必须先置位（失败也不重入），且不在每帧路径里');
{
  const iSet = warm.indexOf('this._shadersCompiled = true');
  const iRew = warm.indexOf('r.render(this.scene, this.camera)');
  ok(iSet > 0 && iRew > 0 && iSet < iRew,
    '置位 _shadersCompiled 在真渲染之前 —— 否则编译抛错后每帧重试 = 每帧卡');

  // 主循环 _loop 体内不得再出现"每帧预热"：预热是加载期一次性的
  const loop = blockAt(game, '_loop() {');
  ok(loop.length > 100, '抽到 _loop 函数体');
  ok(!/frustumCulled = false/.test(loop), '每帧路径里没有视锥剔除开关（那是加载期一次性的）');
  ok(!/renderer\.compile\(/.test(loop), '每帧路径里没有 compile()');

  // 帧内兜底可以留，但只能调一次预编译入口，不能内联那三步
  const fallback = /if \(!this\._shadersCompiled\) this\._precompileShaders\(\);/.test(game);
  ok(fallback, '帧内兜底是"调入口"而不是内联 —— 走同一个幂等函数');
}

console.log('\n[3] 注释里不得再出现"compile 含阴影"这类错误说法');
ok(!/预编译所有材质变体（含阴影）/.test(game), '删掉了误导性的"（含阴影）"注释');
ok(/不覆盖阴影深度/.test(game), '注释明确写了 compile() 不覆盖阴影深度');

// ---------------------------------------------------------------- ④ 超分 RT 的 MSAA 分档
console.log('\n[4] 超分 RT 的 MSAA 分档（4× 样本 = 4 倍 RT 带宽）');
const mFn = /_upSamples\(s\) \{/.exec(game);
ok(!!mFn, '存在 _upSamples(s) 分档函数');
const upSamples = blockAt(game, '_upSamples(s) {');
ok(/_aaOn/.test(upSamples), '画质档没开画布 MSAA 时（手机）一律 0');
// ⚠ 策略已改（实测后收敛成两档，别再按旧的三档写）：填充率是唯一瓶颈，
//   MSAA 的 2~4× 填充乘数只在原生分辨率才划算；一降分辨率（主 pass 像素已砍到 1/4~1/2）
//   就直接关掉，靠锐化升采样补锯齿。故只有「原生」给 4×，其余一律 0。
ok(/s >= 0\.999\) return 4/.test(upSamples), '仅原生分辨率（≥0.999×）才上 4× MSAA');
ok(/return 0;\s*\}/.test(upSamples), '降分辨率时一律 0（省掉这层填充）');
{
  const f = (s, aaOn) => (!aaOn ? 0 : s >= 0.999 ? 4 : 0);
  ok(f(1, true) === 4, '原生 1.0× → 4');
  ok(f(0.86, true) === 0 && f(0.7, true) === 0 && f(0.5, true) === 0, '0.86× / 0.7× / 0.5× → 0');
  ok(f(1, false) === 0, '画质档关掉画布 MSAA → 0（手机）');
  ok(f(0.5, true) <= f(0.8, true) && f(0.8, true) <= f(1, true), '分档单调不增（低分辨率不会反而更多样本）');
}
const rt = blockAt(game, '_ensureRT() {');
ok(rt.length > 100, '抽到 _ensureRT 函数体');
ok(/const samples = this\._upSamples\(s\);/.test(rt), 'RT 用的是分档结果，不是硬编码 4');
ok(/samples,/.test(rt) || /samples: samples/.test(rt), '构造 RT 时把 samples 用它');
ok(/this\._upRT\.samples === samples/.test(rt),
  '⚠ 复用判据连 samples 一起比 —— 否则跨 0.85 边界时分辨率刚好没变，samples 会永远停在旧值');
ok(!/samples: this\._aaOn \? 4 : 0/.test(rt), '删掉了"永远 4×"的旧写法');
ok(/samples: this\._aaOn/.test(game) === false, 'Game 里不再有任何硬编码 samples: this._aaOn ? 4 : 0');

// ---------------------------------------------------------------- ⑤ 测试台预热
console.log('\n[5] 测试台：预热必须真渲染，且覆盖每个场景的 shader 变体');
const bw = blockAt(bench, 'function warmupRender() {');
ok(bw.length > 200, '抽到 warmupRender 函数体');
ok(/renderer\.compile\(scene, camera\)/.test(bw), '先 compile');
ok(/frustumCulled = false/.test(bw), '临时关视锥剔除');
ok(/renderer\.render\(scene, camera\)/.test(bw), '真渲一帧（覆盖阴影深度变体）');
ok(/finally/.test(bw), '还原写在 finally 里');
ok(/for \(const o of toggled\) o\.frustumCulled = true;/.test(bw), '逐个还原');
ok(!/renderer\.compile\(scene, camera\); \} catch\(e\) \{\}\s*\n\s*state\.compiled = true;/.test(bench),
  '删掉了"只 compile 就收工"的旧预热');

{
  const startBody = blockAt(bench, 'function start() {');
  ok(startBody.length > 200, '抽到 start() 函数体');
  ok(/for \(const sc of SCENARIOS\)/.test(startBody), '对**每个**场景各预热一次');
  ok(/applyScenario\(sc\.id\)/.test(startBody), '预热前先切到该场景状态（no-shadow / no-sky-env 会改编译期宏）');
  ok(/warmupRender\(\)/.test(startBody), '每个场景都调真渲染预热');
  const iLoopWarm = startBody.indexOf('for (const sc of SCENARIOS)');
  const iNext = startBody.indexOf('nextScenario()');
  ok(iLoopWarm > 0 && iNext > 0 && iLoopWarm < iNext,
    '预热排在 nextScenario() 之前 —— 否则只预热了基线，第一个量到的场景仍吃编译');
  ok(/applyScenario\('baseline'\)/.test(startBody.slice(iLoopWarm)),
    '预热完切回 baseline 再开跑（避免带着最后一个场景的状态起测）');
}

// ---------------------------------------------------------------- ⑥ 移动端输入清单（外部调试清单点名项）
console.log('\n[6] 测试页移动端：viewport-fit + touch-action + safe-area');
ok(/viewport-fit=cover/.test(page), 'viewport-fit=cover（刘海屏不被裁）');
ok(/user-scalable=no/.test(page), 'user-scalable=no（双击缩放不抢手势）');
ok(/touch-action:none/.test(page), 'touch-action:none（拖动不被页面滚动抢走）');
ok(/overscroll-behavior:none/.test(page), 'overscroll-behavior:none（禁下拉刷新打断整轮测试）');
ok(/env\(safe-area-inset-/.test(page), 'HUD 让出安全区');
ok(/#stage canvas \{[^}]*touch-action:none/.test(page), '画布自身也吃触摸');
ok(!/一键跑完 5 个对照实验/.test(page), '标题里的"5 个"文案已改（现在场景数更多）');

console.log('\n' + (fails ? `✗ ${fails} 项失败` : '✓ 全部通过'));
process.exit(fails ? 1 : 0);
