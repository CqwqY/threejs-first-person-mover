// 性能测试页的统计与导出工具（纯函数，无副作用，便于单独校验）。
// 职责：把逐帧原始样本压缩成可判读的统计摘要，并提供 JSON / CSV 导出。

// 分位数：sorted 必须已按升序排列
export function quantile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function mean(list) {
  if (!list.length) return 0;
  let s = 0;
  for (const v of list) s += v;
  return s / list.length;
}

// 卡顿判定阈值：帧耗时超过 33.3ms 即低于 30fps，视作一次可感知卡顿
export const JANK_MS = 33.3;

/**
 * 「1% Low / 0.1% Low」：把**帧耗时**从大到小排，取最差的那一小撮求平均，再折成帧率。
 *
 * ⚠ 口径：取**帧耗时**最差的那一小撮求平均、再取倒数。
 *   （排序本身：fps 与 ms 单调反相关，按哪个排出来的"最差集合"是一样的；
 *     真正不能做的是**对 fps 做分位数插值** —— 1000/x 是非线性的，
 *     插值结果不等于把帧耗时插值完再取倒数，报出来的数会偏。）
 *   它的意义：平均 60 而 1% Low 只有 18，说明在周期性卡顿 —— 只看平均帧看不出来。
 *   本项目基线就是这种：avgFps 23.2、maxMs **5815ms**、jank 82%。
 *
 * @param {number[]} msSortedDesc 已按**降序**排好的帧耗时数组
 * @param {number} pct 0.01 = 1% Low，0.001 = 0.1% Low
 */
export function lowFps(msSortedDesc, pct) {
  if (!msSortedDesc || !msSortedDesc.length) return 0;
  const n = Math.max(1, Math.round(msSortedDesc.length * pct));
  let s = 0;
  for (let i = 0; i < n && i < msSortedDesc.length; i++) s += msSortedDesc[i];
  const avgMs = s / Math.min(n, msSortedDesc.length);
  return avgMs > 0 ? round(1000 / avgMs, 1) : 0;
}

/** 帧耗时标准差与变异系数（抖动程度）。CV 越大 = 帧率越不稳，"体感比平均帧更差"。 */
export function jitter(ms) {
  if (!ms || ms.length < 2) return { std: 0, cv: 0 };
  const m = mean(ms);
  if (!m) return { std: 0, cv: 0 };
  let acc = 0;
  for (const v of ms) acc += (v - m) * (v - m);
  const std = Math.sqrt(acc / (ms.length - 1));
  return { std: round(std, 2), cv: round(std / m, 3) };
}

/**
 * 把一个 scenario 的逐帧样本压缩成摘要。
 * samples: [{ t, ms, calls, tris, programs, geometries, textures, heap, x, y, z }]
 * programsStart / programsEnd：该场景开始/结束时的 shader program 数量，
 *   差值 > 0 说明期间发生了着色器重编译（本项目的大卡顿来源之一，必须盯住）。
 */
export function summarize(scenario, samples, programsStart, programsEnd) {
  const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
  const fps = samples.map((s) => s.fps);
  const calls = samples.map((s) => s.calls);
  const tris = samples.map((s) => s.tris);
  const heap = samples.map((s) => s.heap).filter((v) => Number.isFinite(v) && v > 0);
  const jank = ms.filter((v) => v > JANK_MS).length;
  // 1% Low 用**降序**的帧耗时（见 lowFps 的注释：不能拿 fps 排）
  const msDesc = ms.slice().reverse();
  const jt = jitter(ms);
  const geo = samples.map((s) => s.geometries).filter((v) => Number.isFinite(v));
  const tex = samples.map((s) => s.textures).filter((v) => Number.isFinite(v));
  return {
    scenario,
    frames: samples.length,
    avgFps: round(mean(fps), 1),
    // ⚠ 评测三件套：平均帧 + 1% Low + 0.1% Low。只看平均帧会漏掉"周期性卡顿"。
    low1Fps: lowFps(msDesc, 0.01),
    low01Fps: lowFps(msDesc, 0.001),
    p50Ms: round(quantile(ms, 0.5), 2),
    p95Ms: round(quantile(ms, 0.95), 2),
    p99Ms: round(quantile(ms, 0.99), 2),
    maxMs: round(ms.length ? ms[ms.length - 1] : 0, 2),
    stdMs: jt.std,   // 帧耗时标准差
    cv: jt.cv,       // 变异系数：越接近 0 越稳
    jankFrames: jank,
    jankPct: round(samples.length ? (jank / samples.length) * 100 : 0, 1),
    avgCalls: Math.round(mean(calls)),
    avgTris: Math.round(mean(tris)),
    // 显存占用的**代理指标**：Web 拿不到真实 VRAM，用 GPU 资源对象数代替（能反映泄漏与膨胀）
    avgGeometries: geo.length ? Math.round(mean(geo)) : null,
    avgTextures: tex.length ? Math.round(mean(tex)) : null,
    programsStart: programsStart ?? 0,
    programsEnd: programsEnd ?? 0,
    programsDelta: (programsEnd ?? 0) - (programsStart ?? 0),
    heapMB: heap.length ? round(mean(heap) / 1048576, 1) : null,
  };
}

/**
 * 把同一场景的多轮结果合并成一行（多次重复测试用）。
 * 报**各轮的原始值** + 中位数 —— 只报平均会把"某一轮特别差"抹平。
 */
export function mergeRepeats(scenario, rows) {
  if (!rows || !rows.length) return null;
  if (rows.length === 1) return { ...rows[0], repeat: 1, repeats: 1 };
  const med = (key) => {
    const v = rows.map((r) => r[key]).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    return v.length ? round(quantile(v, 0.5), 2) : null;
  };
  return {
    scenario,
    repeats: rows.length,
    runs: rows.map((r) => ({ avgFps: r.avgFps, low1Fps: r.low1Fps, p50Ms: r.p50Ms })),
    frames: rows[0].frames,
    avgFps: med('avgFps'),
    low1Fps: med('low1Fps'),
    low01Fps: med('low01Fps'),
    p50Ms: med('p50Ms'),
    p95Ms: med('p95Ms'),
    p99Ms: med('p99Ms'),
    maxMs: Math.max(...rows.map((r) => r.maxMs || 0)), // 最差那一轮的巨帧要保留，不能被中位数抹掉
    stdMs: med('stdMs'),
    cv: med('cv'),
    jankPct: med('jankPct'),
    avgCalls: med('avgCalls'),
    avgTris: med('avgTris'),
    avgGeometries: med('avgGeometries'),
    avgTextures: med('avgTextures'),
    programsDelta: med('programsDelta'),
    heapMB: med('heapMB'),
  };
}

function round(v, d) {
  const f = Math.pow(10, d);
  return Math.round(v * f) / f;
}

// 相对基线的差值（用于结果表里一眼看出收益）
export function diffVs(baseline, row) {
  if (!baseline || baseline === row) return null;
  return {
    fps: row.avgFps - baseline.avgFps,
    fpsPct: baseline.avgFps ? round(((row.avgFps - baseline.avgFps) / baseline.avgFps) * 100, 1) : 0,
    ms: row.p50Ms - baseline.p50Ms,
    msPct: baseline.p50Ms ? round(((row.p50Ms - baseline.p50Ms) / baseline.p50Ms) * 100, 1) : 0,
    calls: row.avgCalls - baseline.avgCalls,
  };
}

const SAMPLE_COLS = ['scenario', 't', 'ms', 'fps', 'calls', 'tris', 'programs', 'geometries', 'textures', 'heapMB', 'x', 'y', 'z'];

export function samplesToCSV(samples) {
  const lines = [SAMPLE_COLS.join(',')];
  for (const s of samples) {
    lines.push([
      s.scenario, s.t, s.ms, s.fps, s.calls, s.tris, s.programs, s.geometries, s.textures,
      s.heap != null ? round(s.heap / 1048576, 2) : '', s.x, s.y, s.z,
    ].join(','));
  }
  return lines.join('\n');
}

// 评测报告的标准列：平均帧 / 1% Low / 0.1% Low / 分位帧耗时 / 抖动 / 卡顿比 / 负载 / 资源
// ⚠ low1Fps 与 low01Fps 是"体感"的主要来源，只报 avgFps 会漏掉周期性卡顿。
const SUMMARY_COLS = [
  'scenario', 'frames', 'avgFps', 'low1Fps', 'low01Fps',
  'p50Ms', 'p95Ms', 'p99Ms', 'maxMs', 'stdMs', 'cv',
  'jankFrames', 'jankPct', 'avgCalls', 'avgTris',
  'avgGeometries', 'avgTextures', 'programsDelta', 'heapMB',
];

export function summaryToCSV(summaries) {
  const lines = [SUMMARY_COLS.join(',')];
  for (const s of summaries) {
    lines.push(SUMMARY_COLS.map((c) => (s[c] == null ? '' : s[c])).join(','));
  }
  return lines.join('\n');
}

// 导出：Blob + <a download>。文件名自带时间戳，便于多次对比。
export function download(filename, text, mime) {
  const blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 立刻 revoke 在部分浏览器会中断下载，延后释放
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}
