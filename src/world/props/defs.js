// 物理可交互物：物件定义表（纯数据，P0 六种）。
// 每个 kind 的 r 是「碰撞球半径」——物理积分统一用 moveSphereWorld（球近似），
// 视觉上可以是盒子/圆柱/球，尺寸见 size（长宽高或直径），两者不要求严格一致。
//
// rest = 恢复系数（越大越弹），fric = 摩擦（越小越滑）。
// shadow = 是否投阴影：小件一律不开（阴影是像素着色的开销大头）。
// pad = true 表示「静态触发器」而非动态刚体（蹦床）。

export const PROP_KINDS = {
  // 快递纸箱：轻、可推、可叠、可踢
  crate: {
    label: '纸箱',
    r: 0.35, mass: 3, rest: 0.22, fric: 0.80,
    shape: 'box', size: [0.62, 0.62, 0.62], color: 0xc0955a, shadow: false,
  },

  // 巨型充气足球：真·截角二十面体足球几何（12 五边形 + 20 六边形，见 soccerBall.js），
  // 透明玻璃质感。直径 5.2m ⇒ 人可以直接走进去（道具不与玩家碰撞，走进去只会把它慢慢顶开，
  // 像推一颗巨型沙滩球）。mass 6：走路推得动但不会飞，一脚能踢出 ~6m/s。
  ball: {
    label: '巨型足球气球',
    r: 2.6, mass: 6, rest: 0.82, fric: 0.45,
    shape: 'soccer', size: [5.2], color: 0xffffff, shadow: false,
    transparent: true, opacity: 0.45,
  },

  // 垃圾桶：重、圆、一推就滚很远
  bin: {
    label: '垃圾桶',
    r: 0.42, mass: 8, rest: 0.30, fric: 0.70,
    shape: 'cyl', size: [0.78, 1.04], color: 0x4f6f5c, shadow: false,
  },

  // 课桌：很重，单人踢不动、只能慢慢推（质量衰减在 applyImpulse 里）
  desk: {
    label: '课桌',
    r: 0.55, mass: 18, rest: 0.10, fric: 0.90,
    shape: 'box', size: [1.10, 0.76, 0.62], color: 0x8a6a45, shadow: true,
  },

  // 积木：多米诺的一节，轻、矮、连锁倒
  block: {
    label: '积木',
    r: 0.12, mass: 0.8, rest: 0.10, fric: 0.70,
    shape: 'box', size: [0.24, 0.44, 0.24], color: 0x7fb0ff, shadow: false,
  },

  // 蹦床：静态触发器，踩上去按落速弹起（不参与刚体积分）
  trampoline: {
    label: '蹦床',
    pad: true,
    size: [2.0, 0.18, 2.0], color: 0x2f6b5f, shadow: true,
  },
};

// 允许通过 URL / 控制台用别名
export const PROP_ALIAS = {
  box: 'crate', cardboard: 'crate',
  basketball: 'ball', soccer: 'ball',
  trash: 'bin', garbage: 'bin',
  table: 'desk',
  domino: 'block', toy: 'block',
  tramp: 'trampoline', pad: 'trampoline',
};

export function resolveKind(name) {
  const key = String(name || '').trim();
  if (PROP_KINDS[key]) return key;
  const alias = PROP_ALIAS[key];
  return alias && PROP_KINDS[alias] ? alias : null;
}
