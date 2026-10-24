// 物理可交互物的布局规则（P0）。
//
// 重要前提（2026-10-24 实测 editor-scene.json 得出，别再退回旧假设）：
//   1. 赛道「校园狂飙」30 个检查点绕全场一圈（x[-111,83] z[-108,154]），**直接穿过操场**
//      ⇒ 避让必须按「到检查点折线的距离」算，不能写死某个矩形。
//   2. 场景里 `未命名` 那件是一块 ~157×294m、厚 1m 的底板（顶面 y=1），它是地面不是障碍；
//      而 `111`/`playground` 的 box collider 是 enabled:false（碰撞来自 GLB trimesh）。
//      ⇒ 落点高度与合法性只能运行期探测（向下射线 + sphereWorldMTV），不能离线算。
//
// 所以这里只放「锚点 + 半径 + 数量上限」，具体落点由 PhysicsProps.buildLayout 探测决定。
// 数量是上限：校验不过就少生成，启动日志会打印 实际/上限。

export const P0_ZONES = [
  {
    id: 'Z1', name: '操场',
    anchor: [35, -51], r: 38,
    items: [
      { kind: 'ball', n: 6 },
      { kind: 'block', n: 20 },      // 会摆成 4 排多米诺，每排 5 块
      { kind: 'bin', n: 4 },
      { kind: 'trampoline', n: 1 },
    ],
  },
  {
    id: 'Z2', name: '主楼南前庭',
    anchor: [-19, 138], r: 16,
    items: [
      { kind: 'crate', n: 12 },
      { kind: 'desk', n: 4 },
      { kind: 'trampoline', n: 1 },
    ],
  },
  {
    id: 'Z3', name: '体育馆东侧',
    anchor: [-55, 5], r: 14,
    items: [
      { kind: 'desk', n: 2 },
      { kind: 'bin', n: 3 },
    ],
  },
  {
    id: 'Z4', name: '中央大道',
    anchor: [0, 60], r: 18,
    items: [
      { kind: 'ball', n: 2 },
      { kind: 'crate', n: 2 },
      { kind: 'bin', n: 2 },
    ],
  },
];

// 固定种子：改这一行 = 换一套布局（两端必须同步改，否则道具位置对不上）
export const PROP_SEED = 0x9e3779b9;

export function mulberry32(a) {
  let s = a | 0;
  return function rnd() {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 点到折线的最近距离（赛道避让用）。checkpoints 为 [{x,z}, …]，首尾相连。
export function trackDistance(px, pz, checkpoints) {
  if (!Array.isArray(checkpoints) || checkpoints.length < 2) return Infinity;
  let best = Infinity;
  const n = checkpoints.length;
  for (let i = 0; i < n; i++) {
    const a = checkpoints[i];
    const b = checkpoints[(i + 1) % n];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const L = dx * dx + dz * dz;
    let t = L > 1e-9 ? ((px - a.x) * dx + (pz - a.z) * dz) / L : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = a.x + dx * t;
    const cz = a.z + dz * t;
    const d = Math.hypot(px - cx, pz - cz);
    if (d < best) best = d;
  }
  return best;
}
