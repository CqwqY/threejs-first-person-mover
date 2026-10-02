// 职责：场地边界（俗称「空气墙」）的唯一数据源与几何。纯数学，不依赖 three，
// 因此编辑器（editor.html 的边界编辑模式）和游戏运行时用的是**同一份**几何/夹取逻辑，
// 不会出现「编辑器里看着对、进游戏差一截」。
//
// 数据：{ minX, maxX, minZ, maxZ, showWalls, wallHeight }
//  - minX/maxX/minZ/maxZ：四边独立，所以边界可以是任意矩形（不必对称于原点）
//  - showWalls：是否在游戏里画出半透明墙。默认 false —— 保持「空气墙」原样（看不见但挡人），
//    想看清楚边界在哪就把编辑器里的「画出实墙」勾上
//  - wallHeight：画出实墙时的高度
//
// 默认值 = 地面范围（世界居中，宽 x / 深 z），与 Config.GROUND_* 一致。
// 存档里没有 boundary 字段时，调用方直接用默认值 = 完全不改变原有行为。
import { Config } from '../config.js';

export const BOUNDARY_MIN_SPAN = 2;    // 任一边的最小跨度（米）：再小就没法站人，夹一下防手滑
export const BOUNDARY_MAX_ABS = 5000;  // 坐标绝对值上限（米）：挡住 NaN/1e9 之类的脏数据
export const BOUNDARY_THICKNESS = 0.5; // 「画出实墙」时的墙厚（米）；碰撞不依赖它（夹取负责挡人）

const clamp = (v, a, b) => (v < a ? a : (v > b ? b : v));

// 默认边界 = 地面边缘
export function defaultBoundary() {
  const hw = Config.GROUND_WIDTH / 2;
  const hd = Config.GROUND_DEPTH / 2;
  return {
    minX: -hw, maxX: hw, minZ: -hd, maxZ: hd,
    showWalls: false, wallHeight: Config.WALL_HEIGHT,
  };
}

// 归一化：任何来源（后端场景 JSON、localStorage、手抄的数值）都可能缺字段或非法，
// 一律先过这里：缺的补默认、非法值夹回范围、写反的自动交换、跨度太小往外扩到最小跨度。
// 完全不认识（null / 非对象）时返回 null —— 调用方保持默认边界即可，行为与改动前一致。
export function normalizeBoundary(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const d = defaultBoundary();
  const num = (v, fb) => (Number.isFinite(Number(v)) ? Number(v) : fb);
  let minX = clamp(num(raw.minX, d.minX), -BOUNDARY_MAX_ABS, BOUNDARY_MAX_ABS);
  let maxX = clamp(num(raw.maxX, d.maxX), -BOUNDARY_MAX_ABS, BOUNDARY_MAX_ABS);
  let minZ = clamp(num(raw.minZ, d.minZ), -BOUNDARY_MAX_ABS, BOUNDARY_MAX_ABS);
  let maxZ = clamp(num(raw.maxZ, d.maxZ), -BOUNDARY_MAX_ABS, BOUNDARY_MAX_ABS);
  if (minX > maxX) { const t = minX; minX = maxX; maxX = t; }
  if (minZ > maxZ) { const t = minZ; minZ = maxZ; maxZ = t; }
  // 跨度太小：以中心为基准往两边撑到最小跨度（中心可能已被夹到边缘，再夹一次保证结果仍在范围内）
  if (maxX - minX < BOUNDARY_MIN_SPAN) {
    const c = (minX + maxX) / 2;
    minX = clamp(c - BOUNDARY_MIN_SPAN / 2, -BOUNDARY_MAX_ABS, BOUNDARY_MAX_ABS);
    maxX = clamp(c + BOUNDARY_MIN_SPAN / 2, -BOUNDARY_MAX_ABS, BOUNDARY_MAX_ABS);
  }
  if (maxZ - minZ < BOUNDARY_MIN_SPAN) {
    const c = (minZ + maxZ) / 2;
    minZ = clamp(c - BOUNDARY_MIN_SPAN / 2, -BOUNDARY_MAX_ABS, BOUNDARY_MAX_ABS);
    maxZ = clamp(c + BOUNDARY_MIN_SPAN / 2, -BOUNDARY_MAX_ABS, BOUNDARY_MAX_ABS);
  }
  return {
    minX, maxX, minZ, maxZ,
    showWalls: raw.showWalls === true,
    wallHeight: clamp(num(raw.wallHeight, d.wallHeight), 0.2, 100),
  };
}

// 把 (state.x, state.z) 夹进边界内。r = 半径（玩家半径 / 掉落物半径）。
// 边界比直径还窄时就退化为「居中」，避免 min+r > max-r 导致抖动。
export function clampToBoundary(state, b, r) {
  if (!b) return;
  const rr = Math.max(0, Number(r) || 0);
  if (b.maxX - b.minX > rr * 2) state.x = clamp(state.x, b.minX + rr, b.maxX - rr);
  else state.x = (b.minX + b.maxX) / 2;
  if (b.maxZ - b.minZ > rr * 2) state.z = clamp(state.z, b.minZ + rr, b.maxZ - rr);
  else state.z = (b.minZ + b.maxZ) / 2;
}

// 四面墙的几何（世界空间，编辑器画预览、游戏画半透明墙都用它）：
// 每面墙是沿某条边铺开的薄板，中心正好落在边界线上（一半进一半出），
// 长度 = 该边的跨度 + 一个墙厚，让四条边在角上互相交叠 —— 宁可角上叠一点，也不要留缝。
// 返回 [{ side, cx, cz, hx, hz, rotY }]，side ∈ '+x'/'-x'/'-z'/'+z'，hx/hz 为半宽半长。
export function boundaryWallSpecs(b, thickness = BOUNDARY_THICKNESS) {
  if (!b) return [];
  const t = Math.max(0.1, Number(thickness) || BOUNDARY_THICKNESS);
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;
  const halfX = (b.maxX - b.minX) / 2 + t / 2;
  const halfZ = (b.maxZ - b.minZ) / 2 + t / 2;
  return [
    { side: '+x', cx: b.maxX, cz, hx: t / 2, hz: halfZ, rotY: 0 },
    { side: '-x', cx: b.minX, cz, hx: t / 2, hz: halfZ, rotY: 0 },
    { side: '-z', cx, cz: b.minZ, hx: halfX, hz: t / 2, rotY: 0 },
    { side: '+z', cx, cz: b.maxZ, hx: halfX, hz: t / 2, rotY: 0 },
  ];
}

// 边界尺寸（宽 x / 深 z），几处提示文案共用
export function boundarySpan(b) {
  if (!b) return { w: 0, d: 0 };
  return { w: b.maxX - b.minX, d: b.maxZ - b.minZ };
}
