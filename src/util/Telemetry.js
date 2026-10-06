// 职责：采集「加载过程」与「运行期渲染」的性能数据，上报到服务端，供手机端性能分析。
//
// 为什么要有它：本项目的瓶颈（填充率 / 自适应分辨率 / LOD）**只有真机数据**能说清，
//   而开发机上拿不到苹果手机（iOS Safari）的实际表现。让玩家在手机上点一下「数据采集」，
//   把「加载了多久、各阶段卡在哪、稳定后多少帧、draw call / 三角面 / 分辨率多少」回报上来，
//   就能在桌面上复盘真机问题，而不是靠猜。
//
// 数据量必须小（用户明确要求）：
//   · 加载阶段只记**几个时间点**（毫秒），不记逐条资源；
//   · 运行期只看**聚合指标**（平均帧、1% low、卡顿比、平均 draw call/三角面/分辨率），
//     不上报逐帧原始样本；
//   · 整包约 1~2 KB，一次一条，服务端按行追加。
//
// 三个入口：
//   ① markLoadPhase(name)  —— 在 main.js 的加载流程里打点（await 前后各一次），
//                             拿到「场景拉取 / welcome / 模型到位 / 总时长」各阶段耗时。
//   ② startRenderSample(game, seconds) —— 采集运行期渲染指标，采够 seconds 秒后 resolve。
//   ③ report(payload) —— POST 到 API_BASE + /api/telemetry。
//
// 全程 try/catch + 可关（?tel=0）：采集本身绝不能拖垮游戏。

import { API_BASE, Config } from '../config.js';

// ---- 加载阶段打点 ----
// name -> performance.now()（进程内单调时钟）。首次打点前可能有几百 ms 的脚本启动，
// 所以另记一个模块加载时刻作为 0 点，报「相对启动」的毫秒更直观。
const _t0 = (typeof performance !== 'undefined' ? performance.now() : 0);
const _phases = new Map();

export function markLoadPhase(name) {
  if (!name) return;
  if (typeof performance === 'undefined') return;
  try { _phases.set(String(name), performance.now() - _t0); } catch (e) { /* 忽略 */ }
}

// 取一份「阶段 → 相对启动毫秒」的快照（取整到毫秒）。
export function loadPhases() {
  const o = {};
  for (const [k, v] of _phases) o[k] = Math.round(v);
  return o;
}

// ---- 设备 / 环境信息 ----
// 注意：Web 拿不到很多原生指标（真实内存、电池、GPU 精确型号），拿不到的**不编**，
// 明确留 undefined，服务端也不补 —— 免得下游把假数据当真。
function deviceInfo() {
  const nav = (typeof navigator !== 'undefined') ? navigator : {};
  const info = {
    ua: String(nav.userAgent || '').slice(0, 300),
    platform: String(nav.platform || ''),
    lang: String(nav.language || ''),
    cores: Number(nav.hardwareConcurrency) || null,   // 逻辑核心数（iPhone 常见 6~8）
    memGB: Number(nav.deviceMemory) || null,          // Chrome 系有；Safari 无
    dpr: Number((typeof window !== 'undefined' && window.devicePixelRatio) || 1),
    screen: (typeof window !== 'undefined' && window.screen)
      ? (window.screen.width + 'x' + window.screen.height) : '',
    msaa: true, // 由调用方（Game）覆盖成真实的 _aaOn
  };
  return info;
}

// GPU 型号字符串：仅作参考（不同引擎/隐私设置下可能被模糊或为空）。
function gpuName(renderer) {
  try {
    const gl = renderer && renderer.getContext && renderer.getContext();
    if (!gl) return '';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const s = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    return String(s || '').slice(0, 160);
  } catch (e) { return ''; }
}

// ---- 运行期渲染采样 ----
// 采集期间每帧调 sampleFrame(dt, game)；到点后由调用方取 summarizeRender()。
// 内部只做 O(1) 累加 + 每秒一个桶（用于算 1% low 与抖动），不保存逐帧数组。
let _rs = null;

export function isSampling() { return !!_rs; }

export function startRenderSample(game, seconds) {
  const dur = Math.max(3, Number(seconds) || 20);
  _rs = {
    dur,
    endAtMs: 0,
    frames: 0,
    startTs: 0,
    msBuckets: [],   // 每秒的帧耗时样本（该秒内的帧耗时列表）
    curSec: 0,
    curMs: [],
    callsAcc: 0, trisAcc: 0, scaleAcc: 0, scaleN: 0,
    maxMs: 0,
    game,
  };
  return _rs;
}

// 每帧调用（从 Game 主循环接进来）。dt 单位秒。
export function sampleFrame(dt, game) {
  const rs = _rs;
  if (!rs) return;
  const now = performance.now();
  if (!rs.startTs) { rs.startTs = now; rs.endAtMs = now + rs.dur * 1000; rs.curSec = 0; }

  // 帧耗时：dt 是秒，转毫秒。⚠ dt 已被 Game clamp 到 MAX_DELTA_TIME(0.1s=100ms)，
  //   超过 100ms 的巨帧会被记成 100ms —— 这是 Game 的既有限制，聚合指标里说明即可。
  const ms = Math.min(100, Math.max(0, dt * 1000));
  rs.frames++;
  rs.curMs.push(ms);
  if (ms > rs.maxMs) rs.maxMs = ms;

  // 逐秒分桶（避免保存整帧数组；桶数 = 采集秒数）
  const sec = Math.floor((now - rs.startTs) / 1000);
  if (sec !== rs.curSec) {
    if (rs.curMs.length) rs.msBuckets.push(rs.curMs);
    rs.curMs = [];
    rs.curSec = sec;
  }

  // 渲染量累加（game 每帧已把这一趟的统计存在 _sceneCalls/_sceneTris）
  const g = game || rs.game;
  if (g) {
    if (Number.isFinite(g._sceneCalls)) rs.callsAcc += g._sceneCalls;
    if (Number.isFinite(g._sceneTris)) rs.trisAcc += g._sceneTris;
    if (Number.isFinite(g._dynScale)) { rs.scaleAcc += g._dynScale; rs.scaleN++; }
  }

  if (now >= rs.endAtMs) finishRenderSample();
}

function quantile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

let _rsSummary = null;
let _rsWaiters = [];

function finishRenderSample() {
  const rs = _rs;
  if (!rs) return;
  if (rs.curMs.length) rs.msBuckets.push(rs.curMs);
  const all = [];
  for (const b of rs.msBuckets) for (const v of b) all.push(v);
  all.sort((a, b) => a - b);
  const n = all.length || 1;
  const sum = all.reduce((s, v) => s + v, 0);
  const meanMs = sum / n;
  const jank = all.filter((v) => v > 33.3).length; // <30fps 记一次卡顿
  // 1% low：把帧耗时降序取最差 1% 求平均再取倒数（口径同 perf/metrics.js lowFps）
  const desc = all.slice().reverse();
  const m = Math.max(1, Math.round(n * 0.01));
  let s1 = 0; for (let i = 0; i < m && i < desc.length; i++) s1 += desc[i];
  const low1Ms = m ? s1 / Math.min(m, desc.length) : 0;

  _rsSummary = {
    frames: rs.frames,
    avgFps: meanMs > 0 ? Math.round((1000 / meanMs) * 10) / 10 : 0,
    low1Fps: low1Ms > 0 ? Math.round((1000 / low1Ms) * 10) / 10 : 0,
    p50Ms: Math.round(quantile(all, 0.5) * 100) / 100,
    p95Ms: Math.round(quantile(all, 0.95) * 100) / 100,
    maxMs: Math.round(rs.maxMs * 100) / 100,
    jankPct: Math.round((jank / n) * 1000) / 10,
    avgCalls: rs.frames ? Math.round(rs.callsAcc / rs.frames) : 0,
    avgTris: rs.frames ? Math.round(rs.trisAcc / rs.frames) : 0,
    avgScale: rs.scaleN ? Math.round((rs.scaleAcc / rs.scaleN) * 100) / 100 : null,
  };
  _rs = null;
  const ws = _rsWaiters.slice();
  _rsWaiters.length = 0;
  for (const r of ws) r(_rsSummary);
}

// 等到采样结束，返回渲染聚合指标。采集未开始则返回 null。
export function waitRenderSample() {
  if (_rsSummary) return Promise.resolve(_rsSummary);
  if (!_rs) return Promise.resolve(null);
  return new Promise((resolve) => { _rsWaiters.push(resolve); });
}

// 采集完成后取一次，然后清掉（避免下次误读上次结果）。
export function takeRenderSummary() {
  const s = _rsSummary;
  _rsSummary = null;
  return s;
}

// ---- 上报 ----
// 组装完整 payload（加载阶段 + 渲染指标 + 设备 + 上下文），并 POST。
// 失败不抛（返回 { ok:false, error }），调用方据此 toast。
export async function report(extra = {}) {
  const payload = {
    v: 1,
    kind: 'perf',
    ts: Date.now(),
    phases: loadPhases(),
    render: takeRenderSummary(),
    device: deviceInfo(),
    ...extra,
  };
  if (payload.device && extra && typeof extra.msaa === 'boolean') payload.device.msaa = extra.msaa;
  return post(payload);
}

async function post(payload) {
  try {
    const url = String(API_BASE || '').replace(/\/+$/, '') + (Config.TELEMETRY_PATH || '/api/telemetry');
    const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 12000) : null;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl ? ctrl.signal : undefined,
    });
    if (timer) clearTimeout(timer);
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok || !data || data.ok === false) {
      return { ok: false, error: (data && data.error) || ('http ' + res.status) };
    }
    return { ok: true, id: data.id || null };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// ---- 自动上报开关（持久化在 localStorage，默认开启）----
// 用户要「采集苹果用户的加载/渲染数据上报服务器」，所以默认开：
//   普通链接进游戏也会自动测 20 秒上报，不必每条都带 ?tel=1；不想上报可在设置里关。
// ?tel=1 / ?tel=0 可临时覆盖（见 main.js / Game._telemetryAutoEnabled）。
const AUTO_KEY = 'fpm-telemetry-auto';
export function telemetryAutoGet() {
  try {
    if (typeof localStorage === 'undefined') return true; // 非浏览器（node 自检）：视为开启
    const v = localStorage.getItem(AUTO_KEY);
    if (v === null) return true; // 未设置过 → 默认开
    return v === '1' || v === 'true';
  } catch (e) { return true; }
}
export function telemetryAutoSet(on) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(AUTO_KEY, on ? '1' : '0');
  } catch (e) { /* 忽略（隐私模式等） */ }
}

// 供自检：不联网，只验证 payload 结构（纯函数部分）。
export function buildPayload(extra = {}) {
  return {
    v: 1,
    kind: 'perf',
    ts: Date.now(),
    phases: loadPhases(),
    device: deviceInfo(),
    ...extra,
  };
}
