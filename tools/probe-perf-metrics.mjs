// 自检：性能统计指标（1% Low / 抖动 / 多轮合并）
//
// ⚠ 为什么必须钉：这几个数就是"评测结论"本身。算错了不会崩、只会**静默给出漂亮数字** ——
//   最容易踩的坑是「用 fps 排序算 1% Low」：fps 是 1000/ms 的非线性变换，
//   直接排 fps 会把偶发巨帧稀释掉（本探针 §2 专门做反证）。
//   项目实测就吃过这个亏：基线 avgFps 23.2 看着"还行"，但 maxMs 5815ms、jank 82%，
//   真正的体感是"周期性卡死几秒" —— 只看平均帧根本看不出来。
//
// 跑法：node tools/probe-perf-metrics.mjs
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

const m = await import(pathToFileURL(path.join(ROOT, 'src/perf/metrics.js')).href);

// 造样本：主体 60fps，但每 50 帧插一帧 200ms（模拟本项目"转到某朝向就卡一下"）
function mkMs(main = 16.7, spike = 200, every = 50, n = 200) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(i % every === 0 ? spike : main);
  return out;
}
const avgOf = (ms) => 1000 / (ms.reduce((s, v) => s + v, 0) / ms.length);

// ---------------------------------------------------------------- ① 平均帧会骗人
console.log('\n[1] 平均帧会骗人，1% Low 才暴露卡顿');
{
  const ms = mkMs();
  const desc = ms.slice().sort((a, b) => b - a);
  const avg = avgOf(ms);
  const low1 = m.lowFps(desc, 0.01);
  console.log(`        avgFps=${avg.toFixed(1)}  1%Low=${low1}  (巨帧 ${ms.filter((v) => v > 100).length} 个)`);
  ok(avg > 45, `平均帧看着还行（${avg.toFixed(1)}）`);
  ok(low1 < 15, `但 1% Low 掉到 ${low1} —— 这才是体感`);
  ok(low1 < avg * 0.35, '1% Low 明显低于平均帧（指标有效）');
}

// ---------------------------------------------------------------- ② 口径正确性
console.log('\n[2] 口径：取最差 1% 的**帧耗时**均值再换算（不是对 fps 做分位数插值）');
{
  const ms = mkMs();
  const desc = ms.slice().sort((a, b) => b - a);
  const n1 = Math.max(1, Math.round(desc.length * 0.01));

  // 实现口径：最差 1% 的 ms 求平均 → 倒数
  const expect = Math.round(1000 / (desc.slice(0, n1).reduce((s, v) => s + v, 0) / n1) * 10) / 10;
  eq(m.lowFps(desc, 0.01), expect, 'lowFps = 最差 1% 帧耗时均值的倒数（口径逐字对齐）');

  // 反证：把 fps 排序后**做分位数插值**（非线性变换下不能这么插）会偏离
  //   注意：单纯"按 fps 排序"是等价的（单调反相关），错的是插值/取值方式
  const fpsAsc = ms.map((v) => 1000 / v).sort((a, b) => a - b);
  const wrong = m.quantile(fpsAsc, 0.01);
  const right = m.quantile(ms.slice().sort((a, b) => a - b), 0.01);
  console.log(`        对 fps 取 1% 分位 = ${wrong.toFixed(1)}fps；对 ms 取 99% 分位再换算 = ${(1000 / right).toFixed(1)}fps`);
  ok(Math.abs(wrong - 1000 / right) > 1e-9 || n1 === fpsAsc.length,
    '两者在插值口径下确实不等（所以统计一律在 ms 域做，最后才换算）');
  ok(m.lowFps(desc, 0.01) === m.lowFps(desc, 0.01), '结果稳定可复现');
  ok(m.lowFps([], 0.01) === 0 && m.lowFps(null, 0.01) === 0, '空输入返回 0（不炸）');
}

// ---------------------------------------------------------------- ③ 抖动
console.log('\n[3] 抖动指标（标准差 / 变异系数）');
{
  const steady = m.jitter(new Array(100).fill(16.7));
  eq(steady.std, 0, '完全稳定的帧：标准差 0');
  const jittery = m.jitter(mkMs());
  ok(jittery.std > 20, `有巨帧时标准差显著变大（${jittery.std}）`);
  ok(jittery.cv > 0.8, `变异系数 ${jittery.cv} > 0.8 → 帧率极不稳`);
  ok(m.jitter([]).std === 0 && m.jitter([16]).std === 0, '空/单元素不炸');
}

// ---------------------------------------------------------------- ④ summarize 的字段完整性
console.log('\n[4] summarize 必须产出评测报告需要的全部列');
{
  const samples = mkMs().map((v, i) => ({
    ms: v, fps: 1000 / v, calls: 45, tris: 67000, geometries: 85, textures: 12, heap: 7e7, scenario: 't', t: i,
  }));
  const s = m.summarize('t', samples, 10, 12);
  for (const k of ['avgFps', 'low1Fps', 'low01Fps', 'p50Ms', 'p95Ms', 'p99Ms', 'maxMs', 'stdMs', 'cv',
    'jankPct', 'avgCalls', 'avgTris', 'avgGeometries', 'avgTextures', 'programsDelta', 'heapMB']) {
    ok(k in s, `含字段 ${k}`);
  }
  eq(s.programsDelta, 2, 'programsDelta = 结束 - 开始（重编译计数）');
  eq(s.maxMs, 200, 'maxMs 保留最差那一帧（不被统计抹平）');
  ok(s.avgGeometries === 85 && s.avgTextures === 12, '几何/贴图数进了汇总（显存的代理指标）');
}

// ---------------------------------------------------------------- ⑤ 多轮合并
console.log('\n[5] 多轮重复测试：报中位数，且巨帧取最差');
{
  const base = { frames: 100, avgFps: 0, low1Fps: 0, low01Fps: 0, p50Ms: 16, p95Ms: 20, p99Ms: 30, stdMs: 2, cv: 0.1, jankPct: 5, avgCalls: 45, avgTris: 67000, avgGeometries: 85, avgTextures: 12, programsDelta: 0, heapMB: 60 };
  const runs = [
    { ...base, avgFps: 60, low1Fps: 40, maxMs: 50 },
    { ...base, avgFps: 58, low1Fps: 36, maxMs: 60 },
    { ...base, avgFps: 61, low1Fps: 42, maxMs: 999 }, // 其中一轮出现巨帧
  ];
  const g = m.mergeRepeats('t', runs);
  eq(g.repeats, 3, '记录了轮数');
  eq(g.avgFps, 60, 'avgFps 取中位数（不被 58 或 61 带偏）');
  eq(g.maxMs, 999, '⚠ maxMs 取**最差那一轮** —— 中位数会把偶发巨帧抹掉，那是评测最该看到的');
  eq(g.runs.length, 3, '各轮原始值都保留（可查离散度）');
  eq(m.mergeRepeats('t', [runs[0]]).repeats, 1, '单轮直接返回（不套中位数）');
  eq(m.mergeRepeats('t', []), null, '空数组返回 null 不炸');
}

console.log('\n' + (fails ? `✗ ${fails} 项失败` : '✓ 全部通过'));
process.exit(fails ? 1 : 0);
