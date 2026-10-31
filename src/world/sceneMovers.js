// 场景运动器：给编辑器摆件挂「被事件触发后开始运动」的能力。
//
// 数据（编辑器 placed 记录上的 mover 字段，EditorBuildings 负责注册）：
//   { type:'pingpong', axis:'x'|'y'|'z', dist:米, speed:米/秒, event:'触发事件名' }
//   { type:'rotate',   angle:度,        speed:度/秒,        event:'触发事件名' }
//
// 行为约定（和「选项卡 → 事件」配套）：
//   · 事件触发 = toggle：第一次开始运动，再触发暂停，再触发继续。
//   · pingpong 在 0..dist 之间线性往返（开门/升降/平移都够用）；
//     rotate 在 -angle..+angle 之间往返（绕本地 Y 轴，可做转门/闸机）。
//   · 暂停时保持当前姿态，不回弹归位 —— 玩家不会站在门里被门夹回原位。
//
// ⚠ 运动是**纯视觉 + 摆件级**的：不改碰撞体（碰撞在场景构建时已按静态烘好）。
//   给门做运动时，编辑器里别给门体配碰撞（或关掉启用），否则人会被"看不见的门"挡住。

import { sceneOn, sceneOff } from './sceneEvents.js';
import * as THREE from 'three';

const _movers = []; // { obj, cfg, base, baseRot, active, t, rot, dir, off }

// 注册一个运动器。obj 是 EditorBuildings 里带好位置/朝向/缩放的 holder，
// base 记录注册时的姿态 —— 运动永远是「原姿态 + 偏移」，重建场景后从零开始，不会漂移累积。
export function registerSceneMover(obj, cfg) {
  if (!obj || !cfg) return null;
  const type = cfg.type === 'rotate' ? 'rotate' : 'pingpong';
  const ev = String(cfg.event || '').trim();
  if (!ev) return null; // 没配事件名的运动器永远不会动，直接不注册
  const m = {
    obj,
    cfg: {
      type,
      event: ev,
      axis: ['x', 'y', 'z'].includes(cfg.axis) ? cfg.axis : 'y',
      dist: Math.max(0.1, Number(cfg.dist) || 2),
      speed: Math.max(0.1, Number(cfg.speed) || 2),
      angle: Math.max(1, Number(cfg.angle) || 90),
    },
    base: obj.position.clone(),
    baseRot: obj.rotation.y,
    active: false, // 等事件触发才开始
    t: 0,          // pingpong 当前位移（米）
    rot: 0,        // rotate 当前角度（度）
    dir: 1,
    off: null,     // 事件退订函数（clear 时用）
  };
  m.off = sceneOn(ev, () => { m.active = !m.active; });
  _movers.push(m);
  return m;
}

export function clearSceneMovers() {
  for (const m of _movers) if (m.off) m.off();
  _movers.length = 0;
}

export function sceneMoverCount() { return _movers.length; }

// 每帧推进。数量级 = 编辑器里配了运动器的摆件数（个位数），全量遍历毫无压力。
export function updateSceneMovers(dt) {
  const d = Math.min(Math.max(dt, 0), 0.1); // 掉帧/切后台回来的大 dt 钳住，防瞬移
  for (const m of _movers) {
    if (!m.active || !m.obj.parent) continue;
    const c = m.cfg;
    if (c.type === 'pingpong') {
      m.t += d * c.speed * m.dir;
      if (m.t >= c.dist) { m.t = c.dist; m.dir = -1; }
      else if (m.t <= 0) { m.t = 0; m.dir = 1; }
      m.obj.position.set(m.base.x, m.base.y, m.base.z);
      m.obj.position[c.axis] += m.t;
    } else {
      m.rot += d * c.speed * m.dir;
      if (m.rot >= c.angle) { m.rot = c.angle; m.dir = -1; }
      else if (m.rot <= -c.angle) { m.rot = -c.angle; m.dir = 1; }
      m.obj.rotation.y = m.baseRot + THREE.MathUtils.degToRad(m.rot);
    }
  }
}
