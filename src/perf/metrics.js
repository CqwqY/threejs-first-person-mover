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
  return {
    scenario,
    frames: samples.length,
    avgFps: round(mean(fps), 1),
    p50Ms: round(quantile(ms, 0.5), 2),
    p95Ms: round(quantile(ms, 0.95), 2),
    maxMs: round(ms.length ? ms[ms.length - 1] : 0, 2),
    jankFrames: jank,
    jankPct: round(samples.length ? (jank / samples.length) * 100 : 0, 1),
    avgCalls: Math.round(mean(calls)),
    avgTris: Math.round(mean(tris)),
    programsStart: programsStart ?? 0,
    programsEnd: programsEnd ?? 0,
    programsDelta: (programsEnd ?? 0) - (programsStart ?? 0),
    heapMB: heap.length ? round(mean(heap) / 1048576, 1) : null,
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

const SUMMARY_COLS = ['scenario', 'frames', 'avgFps', 'p50Ms', 'p95Ms', 'maxMs', 'jankFrames', 'jankPct', 'avgCalls', 'avgTris', 'programsDelta', 'heapMB'];

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
