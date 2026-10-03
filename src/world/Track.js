// 职责：赛道（校园狂飙玩法）的唯一数据源与几何/判定。纯数学，**不依赖 three**，
// 所以编辑器（editor.html 的「赛道」编辑模式）和游戏运行时用的是**同一份**数据与判定，
// 不会出现「编辑器里看着对、进游戏差一截」。范本见同目录的 Boundary.js。
//
// 数据：{ name, laps, checkpoints: [{ x, y, z, w }] }
//  - checkpoints 是**有序**的门：车手必须按 0,1,2,… 的顺序依次穿过；穿过最后一个之后
//    再穿第 0 个 = 完成一圈。圈数跑满 laps 即完赛。
//  - 每个门：中心 (x,y,z)，宽度 w（米，沿「垂直于赛道行进方向」铺开）。
//    ⚠ 门自身**不存朝向**：横梁方向由「本门 → 下一个门」自动推出来（见 gateSpecs），
//      这样编辑器只摆点、不用再调角度，摆出来的门永远垂直于跑线。
//  - laps：跑几圈算完赛。
//
// 默认赛道 = 世界原点附近一个演示小方环（开箱即可玩）；编辑器里可任意重画。
// 存档里没有 track 字段时，调用方保持「没赛道」即可 —— 行为与改动前一致。
import { Config } from '../config.js';

export const TRACK_MAX_GATES = 64;      // 门数上限（防脏数据 / 误操作把赛道撑爆）
export const TRACK_MIN_GATES = 2;       // 少于 2 个门不成赛道（开不了这个玩法）
export const TRACK_GATE_W_MIN = 3;      // 门宽下限（米）：再窄车过不去
export const TRACK_GATE_W_MAX = 40;     // 门宽上限（米）
export const TRACK_GATE_W_DEF = 9;      // 默认门宽（米）
export const TRACK_GATE_H = 6;          // 门高（米）：视觉高度，也是过门判定允许的高度差
export const TRACK_LAPS_MIN = 1;
export const TRACK_LAPS_MAX = 20;
export const TRACK_LAPS_DEF = 3;
export const TRACK_MAX_ABS = 5000;      // 坐标绝对值上限（米）：挡住 NaN / 1e9 之类的脏数据
export const TRACK_START_BACK = 8;      // 起跑线放在 0 号门「后方」多少米（米）

const clamp = (v, a, b) => (v < a ? a : (v > b ? b : v));
const num = (v, fb) => (Number.isFinite(Number(v)) ? Number(v) : fb);

// 默认赛道：原点附近一个演示用的小方环。半径跟着地面尺寸走，小地图也不会溢出。
export function defaultTrack() {
  const R = clamp(Math.min(Config.GROUND_WIDTH, Config.GROUND_DEPTH) * 0.3, 20, 60);
  const w = TRACK_GATE_W_DEF;
  return {
    name: '校园狂飙',
    laps: TRACK_LAPS_DEF,
    checkpoints: [
      { x: R, y: 0, z: -R, w },
      { x: R, y: 0, z: R, w },
      { x: -R, y: 0, z: R, w },
      { x: -R, y: 0, z: -R, w },
    ],
  };
}

// 归一化：任何来源（后端场景 JSON、localStorage、手抄数值）都先过这里 ——
// 缺字段补默认、非法/超界的门直接丢掉、宽度与圈数夹回范围、数量截断到上限。
// 不是对象 / 不是数组时返回 null（调用方保持默认，行为与改动前一致）。
export function normalizeTrack(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const d = defaultTrack();
  const list = Array.isArray(raw.checkpoints) ? raw.checkpoints : [];
  const cps = [];
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    const x = num(c.x, NaN);
    const z = num(c.z, NaN);
    // 没有合法水平坐标的门（含 null/''/NaN）直接丢 —— 别让一个手抄错的点把车手引到墙里
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    if (Math.abs(x) > TRACK_MAX_ABS || Math.abs(z) > TRACK_MAX_ABS) continue;
    cps.push({
      x,
      y: clamp(num(c.y, 0), -TRACK_MAX_ABS, TRACK_MAX_ABS),
      z,
      w: clamp(num(c.w, TRACK_GATE_W_DEF), TRACK_GATE_W_MIN, TRACK_GATE_W_MAX),
    });
    if (cps.length >= TRACK_MAX_GATES) break;
  }
  const name = (typeof raw.name === 'string' && raw.name.trim())
    ? raw.name.trim().slice(0, 24)
    : d.name;
  return {
    name,
    laps: Math.round(clamp(num(raw.laps, d.laps), TRACK_LAPS_MIN, TRACK_LAPS_MAX)),
    checkpoints: cps,
  };
}

// 这条赛道能不能开赛（编辑器可以做出「只摆了一个门」的中间状态，那时不能开）
export function isTrackRunnable(t) {
  return !!t && Array.isArray(t.checkpoints) && t.checkpoints.length >= TRACK_MIN_GATES;
}

// 门的世界几何：编辑器画预览、游戏画实体门都用它。
// 返回 [{ index, x, y, z, w, h, dx, dz, rx, rz }]：
//   (dx,dz) = 该门的行进方向（本门 → 下一门，归一化；只有 1 个门时取 (1,0)）
//   (rx,rz) = 门面的横向（= 垂直于行进方向），两根柱子就摆在 ±w/2 的横向位置上
export function gateSpecs(t) {
  const cps = (t && Array.isArray(t.checkpoints)) ? t.checkpoints : [];
  const n = cps.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = cps[i];
    const nx = cps[(i + 1) % n];
    let dx = nx.x - c.x;
    let dz = nx.z - c.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) { dx = 1; dz = 0; } else { dx /= len; dz /= len; }
    // 横向 = 行进方向逆时针转 90°（在 xz 平面上）：(dx,dz) → (dz,-dx)
    out.push({
      index: i,
      x: c.x, y: c.y, z: c.z,
      w: c.w, h: TRACK_GATE_H,
      dx, dz,
      rx: dz, rz: -dx,
    });
  }
  return out;
}

// 起跑位姿：在 0 号门「后方」TRACK_START_BACK 米处、面朝 0 号门。
// 返回 { x, y, z, yaw }，yaw 沿用项目约定（前方 = (-sin yaw, -cos yaw)）。
export function startPose(t, back = TRACK_START_BACK) {
  const specs = gateSpecs(t);
  if (!specs.length) return null;
  const g = specs[0];
  const x = g.x - g.dx * back;
  const z = g.z - g.dz * back;
  // 前方 = (dx,dz) → -sin(yaw) = dx, -cos(yaw) = dz → yaw = atan2(-dx, -dz)
  return { x, y: g.y, z, yaw: Math.atan2(-g.dx, -g.dz) };
}

// 第 i 个门是不是被 (x,y,z) 穿过了。水平距离落在门宽内、垂直差不超门高即算过。
// extra：额外宽容度（一般传玩家/车辆的碰撞半径，让「贴着门框过」也算数）。
export function inGate(cp, x, y, z, extra = 0) {
  if (!cp) return false;
  const r = cp.w / 2 + Math.max(0, Number(extra) || 0);
  const dx = x - cp.x;
  const dz = z - cp.z;
  if (dx * dx + dz * dz > r * r) return false;
  return Math.abs(y - cp.y) <= TRACK_GATE_H;
}

// 下一个该穿的门（环形）
export function nextGateIndex(i, total) {
  if (!(total > 0)) return -1;
  return (i + 1) % total;
}

// 赛道规模提示（几处文案共用）
export function trackSummary(t) {
  if (!t || !Array.isArray(t.checkpoints)) return { gates: 0, laps: 0 };
  return { gates: t.checkpoints.length, laps: t.laps };
}
