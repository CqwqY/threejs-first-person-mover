// 遥测（性能采集）数据体检：读服务端 data/telemetry.jsonl，按设备分组聚合帧率/渲染量/加载耗时。
// 用法：
//   node tools/telemetry-report.mjs [文件路径] [--top 10] [--raw]
//   默认路径 _telemetry.jsonl（先用 scp 从服务器拉下来：
//   scp cai@100.127.187.92:/home/cai/fp-relay/data/telemetry.jsonl _telemetry.jsonl）
//   路径写成 - （或干脆不给）时**读 stdin**，可以管道直接看、不落盘：
//   ssh cai@100.127.187.92 "cat /home/cai/fp-relay/data/telemetry.jsonl" | node tools/telemetry-report.mjs
// 说明：每行一条 JSON（服务端 sanitizeTelemetry 写入的字段见 server-remote/index.js）。
import fs from 'node:fs';

const argv = process.argv.slice(2);
const argPath = argv.find((a) => !a.startsWith('--'));
const useStdin = !argPath || argPath === '-';
const file = useStdin ? '<stdin>' : argPath;
const topN = Number((argv.find((a) => a.startsWith('--top=')) || '--top=8').split('=')[1]) || 8;
const wantRaw = argv.includes('--raw');

function readText() {
  if (useStdin) {
    try { return fs.readFileSync(0, 'utf8'); } catch (e) { return ''; }
  }
  if (!fs.existsSync(file)) {
    console.error('找不到遥测文件：' + file);
    console.error('先从服务器拉：scp cai@100.127.187.92:/home/cai/fp-relay/data/telemetry.jsonl ' + file);
    console.error('或者直接看（不落盘）：ssh cai@100.127.187.92 "cat /home/cai/fp-relay/data/telemetry.jsonl" | node tools/telemetry-report.mjs');
    process.exit(1);
  }
  return fs.readFileSync(file, 'utf8');
}
const text = readText();
if (!text.trim()) {
  console.error('没有读到遥测数据。可用：ssh cai@100.127.187.92 "cat /home/cai/fp-relay/data/telemetry.jsonl" | node tools/telemetry-report.mjs');
  process.exit(1);
}

const lines = text.split('\n').filter((s) => s.trim());
const recs = [];
let bad = 0;
for (const line of lines) {
  try {
    recs.push(JSON.parse(line));
  } catch (e) {
    bad++;
  }
}
if (!recs.length) {
  console.error('文件里没有可解析的记录（' + lines.length + ' 行，' + bad + ' 行坏）');
  process.exit(1);
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const median = (arr) => {
  const a = arr.filter((x) => x != null).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const avg = (arr) => {
  const a = arr.filter((x) => x != null);
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
};
const r1 = (v) => (v == null ? '-' : (Math.round(v * 10) / 10).toFixed(1));
const r0 = (v) => (v == null ? '-' : String(Math.round(v)));
const ts = (v) => (v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '-');

// 分组键：优先 GPU 名（最能代表设备档），退回 platform+screen
function groupKey(r) {
  const gpu = String((r.ctx && r.ctx.gpu) || '').trim();
  const dev = r.device || {};
  if (gpu) return gpu.slice(0, 40);
  return [dev.platform || '?', dev.screen || '?', 'cores=' + (dev.cores ?? '?')].join(' ');
}

const groups = new Map();
for (const r of recs) {
  const k = groupKey(r);
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}

console.log('遥测文件：' + file);
console.log('总条数：' + recs.length + (bad ? '（坏行 ' + bad + '）' : ''));
const tsAll = recs.map((r) => num(r.serverTs)).filter((x) => x != null);
console.log('时间范围：' + ts(Math.min(...tsAll)) + '  ~  ' + ts(Math.max(...tsAll)));
console.log('');

const rows = [];
for (const [k, list] of groups) {
  const last = list[list.length - 1];
  const dev = last.device || {};
  const ctx = last.ctx || {};
  rows.push({
    key: k,
    n: list.length,
    fps: median(list.map((r) => num(r.render && r.render.avgFps))),
    low1: median(list.map((r) => num(r.render && r.render.low1Fps))),
    p95: median(list.map((r) => num(r.render && r.render.p95Ms))),
    jank: median(list.map((r) => num(r.render && r.render.jankPct))),
    calls: median(list.map((r) => num(r.render && r.render.avgCalls))),
    tris: avg(list.map((r) => num(r.render && r.render.avgTris))),
    scale: median(list.map((r) => num(ctx.renderScale ?? (r.ctx && r.ctx.renderScale)))),
    qual: String(ctx.quality || '-'),
    shadow: ctx.shadow ? 'Y' : 'N',
    msaa: ctx.msaa || dev.msaa ? 'Y' : 'N',
    dpr: r0(num(dev.dpr)),
    cores: r0(num(dev.cores)),
    mem: r0(num(dev.memGB)),
    screen: String(dev.screen || '-'),
    boot: avg(list.map((r) => num(r.phases && r.phases.boot))),
    enter: avg(list.map((r) => num(r.phases && r.phases.enter))),
    assets: avg(list.map((r) => num(r.phases && r.phases.assetsDone))),
  });
}
rows.sort((a, b) => b.n - a.n);

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
const head = ['设备/GPU', '条', 'fps', 'low1', 'p95ms', 'jank%', 'calls', 'tris', 'scale', '画质', '影', 'MSAA', 'dpr', '核', 'GB', '屏', '启动ms', '进场ms', '资源ms'];
console.log(head.map((h, i) => (i === 0 ? pad(h, 34) : padL(h, Math.max(h.length, 6)))).join(' '));
for (const x of rows.slice(0, topN)) {
  const cells = [
    pad(x.key.slice(0, 34), 34),
    padL(x.n, 6), padL(r1(x.fps), 6), padL(r1(x.low1), 6), padL(r1(x.p95), 6), padL(r1(x.jank), 6),
    padL(r0(x.calls), 6), padL(r0(x.tris / 1000) + 'k', 6), padL(r1(x.scale), 6), padL(x.qual, 6),
    padL(x.shadow, 6), padL(x.msaa, 6), padL(x.dpr, 6), padL(x.cores, 6), padL(x.mem, 6), padL(x.screen, 6),
    padL(r0(x.boot), 6), padL(r0(x.enter), 6), padL(r0(x.assets), 6),
  ];
  console.log(cells.join(' '));
}

// 全量分位：不分组看整体
const allFps = recs.map((r) => num(r.render && r.render.avgFps));
const allP95 = recs.map((r) => num(r.render && r.render.p95Ms));
const sortAsc = (a) => a.filter((x) => x != null).sort((x, y) => x - y);
const pct = (a, p) => {
  const s = sortAsc(a);
  if (!s.length) return null;
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
console.log('');
console.log('全量：fps 中位 ' + r1(median(allFps)) + ' / p10 ' + r1(pct(allFps, 0.1)) + ' / p90 ' + r1(pct(allFps, 0.9)));
console.log('全量：p95 帧耗时 中位 ' + r1(median(allP95)) + ' ms / p90 ' + r1(pct(allP95, 0.9)) + ' ms');

if (wantRaw) {
  console.log('');
  console.log('最近 ' + Math.min(5, recs.length) + ' 条明细：');
  for (const r of recs.slice(-5)) {
    console.log(JSON.stringify({
      ts: ts(r.serverTs),
      kind: r.kind,
      fps: num(r.render && r.render.avgFps),
      p95: num(r.render && r.render.p95Ms),
      jank: num(r.render && r.render.jankPct),
      scale: num(r.ctx && r.ctx.renderScale),
      quality: r.ctx && r.ctx.quality,
      gpu: r.ctx && r.ctx.gpu,
      ua: r.device && String(r.device.ua || '').slice(0, 80),
    }));
  }
}
