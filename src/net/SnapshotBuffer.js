// 职责：远端玩家快照的环形缓冲 + 时间轴插值 + 外推 + 自适应延迟。
// 服务器以固定 ~20Hz 广播全体快照，网络抖动会打乱到达间隔、丢包会留空档。
// 这里收到快照时打本地时间戳入缓冲，渲染时按「当前时间 - 对抗延迟」在相邻两帧间线性插值，
// 缓冲耗尽（前方没有新帧）时用最近两帧差分出的速度继续外推，上限 EXTRAPOLATE_MAX。
import { Config } from '../config.js';

export class SnapshotBuffer {
  constructor() {
    this.baseDelay = Config.INTERP_DELAY_BASE;   // 初始缓冲延迟（ms），随后由自适应在 min~max 间调整
    this.minDelay = Config.INTERP_DELAY_MIN;     // 良好网络下的下限（ms）
    this.maxDelay = Config.INTERP_DELAY_MAX;     // 抖动大时的上限（ms）
    this.extrapolateMax = Config.EXTRAPOLATE_MAX; // 外推时长上限（ms）
    this.maxHistory = 48;                        // 最多保留的快照数

    this._buf = [];       // [{ t, data }]，t 为本地接收时间（ms），按 t 升序
    this._delay = this.baseDelay;                // 当前对抗延迟（ms）
    this._lastPush = 0;                          // 上次推入时间，用于抖动估计
    this._gaps = [];                             // 最近到达间隔（ms），用于抖动 p95
    this._gapMax = 128;
    this._delayT = 0;                            // 距下次调延迟的时间
  }

  // 收到新快照：入缓冲 + 更新到达间隔直方图。data 会被拷贝，外部复用同一对象也无妨。
  push(data, tRecvMs = performance.now()) {
    if (!data) return;
    if (this._lastPush) {
      const gap = tRecvMs - this._lastPush;
      if (gap > 0 && gap < 1000) {
        this._gaps.push(gap);
        if (this._gaps.length > this._gapMax) this._gaps.shift();
      }
    }
    this._lastPush = tRecvMs;
    this._buf.push({ t: tRecvMs, data: this._clone(data) });
    if (this._buf.length > this.maxHistory) this._buf.shift();
  }

  // 最新一份快照数据（用于同步 health/hold/ride 等非插值字段）
  latest() {
    return this._buf.length ? this._buf[this._buf.length - 1].data : null;
  }

  // 自适应抗抖延迟：按实测到达间隔的 p95 决定缓冲深度（要能盖住最坏的一次到达空档），
  // 再留 20ms 余量。范围钳在 60~250ms：网络好时压到最低、延迟小；抖动大时自动放宽。
  // 调整带 >10ms 迟滞 + 每步 ≤10ms，避免延迟来回震荡。
  suggestDelayMs(now = performance.now()) {
    if (now < this._delayT) return this._delay;
    this._delayT = now + 1000;
    if (!this._gaps.length) return this._delay;
    const s = [...this._gaps].sort((a, b) => a - b);
    const jitter = s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]; // p95（ms）
    const target = Math.max(this.minDelay, Math.min(this.maxDelay, jitter + 20));
    const d = target - this._delay;
    if (Math.abs(d) > 10) this._delay += Math.max(-10, Math.min(10, Math.round(d)));
    return this._delay;
  }

  // 在 tNow 时刻采样：返回插值两端 a/b 与 alpha，或外推结果。
  // 返回 null 表示缓冲还没填满、尚无可渲染的位置（调用方应沿用旧逻辑兜底）。
  sample(tNow) {
    const n = this._buf.length;
    if (n === 0) return null;
    const tSample = tNow - this._delay;
    const last = this._buf[n - 1];

    // 采样点已越过最新快照 → 用最后两点差分出的速度外推（有上限）
    if (tSample >= last.t) {
      if (n >= 2) return this._extrapolate(last, this._buf[n - 2], tNow);
      return { a: last.data, b: last.data, alpha: 0, extrapolating: false, t: last.t };
    }

    // 找到第一个 snapshot.t > tSample 作为 b，其前一份作为 a
    for (let i = 0; i < n; i++) {
      if (this._buf[i].t > tSample) {
        const b = this._buf[i];
        const a = i > 0 ? this._buf[i - 1] : null;
        // 采样点早于最早快照：缓冲还没填满，直接取最早一份（让调用方沿用旧 lerp 兜底）
        if (!a) return { a: b.data, b: b.data, alpha: 0, extrapolating: false, t: b.t };
        const span = b.t - a.t;
        const alpha = span > 0 ? Math.min(1, Math.max(0, (tSample - a.t) / span)) : 0;
        return { a: a.data, b: b.data, alpha, extrapolating: false, t: tSample };
      }
    }
    return { a: last.data, b: last.data, alpha: 0, extrapolating: false, t: last.t };
  }

  // 用最近两点差分出的速度延展到最后时刻（不超过 latest.t + EXTRAPOLATE_MAX）
  _extrapolate(latest, prev, tNow) {
    const span = latest.t - prev.t; // 最近两帧间隔（ms）
    const reach = tNow;
    if (reach - latest.t > this.extrapolateMax) {
      // 外推超限：钳到上限位置，避免无限外推穿墙
      return this._extrapolateTo(latest, prev, latest.t + this.extrapolateMax);
    }
    return this._extrapolateTo(latest, prev, reach);
  }

  _extrapolateTo(latest, prev, atMs) {
    const d = latest.data;
    const p = prev.data;
    const span = latest.t - prev.t;
    // 元数据原样保留（血量/手持/体型等），只有位置/朝向延展
    const out = { ...d };
    if (span > 0) {
      const k = (atMs - latest.t) / span;
      out.x = d.x + (d.x - p.x) * k;
      out.y = d.y + (d.y - p.y) * k;
      out.z = d.z + (d.z - p.z) * k;
      // 朝向外推容易跨 ±π 引入整圈旋转，这里保守取最近一份朝向，位置照常外推即可
    }
    return { a: out, b: out, alpha: 0, extrapolating: true, t: atMs };
  }

  _clone(d) {
    return {
      x: d.x, y: d.y, z: d.z, yaw: d.yaw, pitch: d.pitch,
      size: d.size, health: d.health, hold: d.hold, ride: d.ride, veh: d.veh,
      onGround: d.onGround,
    };
  }
}