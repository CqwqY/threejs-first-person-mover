// 场景运动器：给编辑器摆件挂「被事件触发后开始运动」的能力，并让其碰撞体随动。
//
// 数据（编辑器 placed 记录上的 mover / movers 字段，EditorBuildings 负责注册）：
//   { type:'pingpong', axis, dist, speed, event }  往返平移（0..dist 来回）
//   { type:'oneway',   axis, dist, speed, event }  单向平移（触发后走到 dist 停住，不再响应）
//   { type:'rotate',   angle, speed, event }       往返旋转（-angle..+angle 来回）
//   { type:'rotate_oneway', angle, speed, event }  单向旋转（转满 angle 停住）
//   旋转运动器可选 pivot:{x,y,z}（局部偏移，相对物体原点，单位米）：配了就让旋转绕该点转，
//   而不是绕物体默认原点 —— 例：门绕端点开合（pivot 设在门轴那侧），避免绕脚底/边角甩飞。
//
// 行为约定（和「区域选项卡 → 事件」配套）：
//   · 往返 = toggle：第一次开始运动，再触发暂停，再触发继续。
//   · 单向(oneway) = 闩锁式往返：每次触发切换一次运动方向 —— 起点->去终点、终点->回起点、途中->反向；
//   · 暂停时保持当前姿态，不回弹归位 —— 玩家不会站在门里被门夹回原位。
//
// ⚠ 一个物体可以挂多个运动器（rec.movers 数组）：推进改成**增量式**（每帧只加「这一帧的位移
//   增量」，不再从 base 重设），所以「平移 X + 平移 Y」或「平移 + 旋转」能自然叠加；
//   但两个运动器写同一条轴仍会互相叠上去 —— 编辑器提示里已说明，别这么配。
//
// ⚠ 配了运动器的摆件就是**活动物体**：它的盒 / 凸包碰撞体每帧跟着重算（syncMoverColliders），
//   玩家撞得到、站得上、被夹住会被推开。两个例外：
//   · complex（trimesh）碰撞是从渲染网格烘死的三角形汤，重建成本与整栋楼三角形数同级 →
//     不支持随动（EditorBuildings 会打警告，需要随动请改成盒/凸包碰撞）；
//   · 这帧没动（暂停/未触发）时完全不重算，纯静态物件零开销。

import { sceneOn, sceneOff } from './sceneEvents.js';
import * as THREE from 'three';

const _movers = []; // { obj, cfg, active, t, rot, dir, moved, onMoved, off }
const _v = new THREE.Vector3(); // 随动重算的复用缓冲（不每帧分配）
// 服务器同步用：按「带运动器的 holder」聚合，一个 holder 上多个运动器只发一份 transform。
// id 按注册顺序分配（各端地图数据/注册顺序一致），场景重建时归零，所以两端能对上。
const _syncObjs = new Map(); // id -> { obj, movers:[m], onMoved }
let _syncSeq = 0;
let _moverMoving = false; // 本帧是否有运动器真的动了（供物理唤醒静止球，让平台能把球顶起/带着走）

// 注册一个运动器。obj 是 EditorBuildings 里带好位置/朝向/缩放的 holder。
// 运动量是「注册姿态 + 累计偏移」，场景重建后从零开始，不会漂移累积。
// onMoved（可选）：该物件**这一帧真的动了**之后调用，用于把碰撞体刷到新姿态。
export function registerSceneMover(obj, cfg, onMoved) {
  if (!obj || !cfg) return null;
  const type = String(cfg.type || '');
  const isRot = type.indexOf('rotate') === 0;
  const loop = type.indexOf('oneway') >= 0 ? 'oneway' : 'pingpong';
  const ev = String(cfg.event || '').trim();
  if (!ev) return null; // 没配事件名的运动器永远不会动，直接不注册
  const m = {
    obj,
    cfg: {
      kind: isRot ? 'rotate' : 'translate', // 兼容旧 type：'pingpong'=往返平移、'rotate'=往返旋转
      loop,
      event: ev,
      axis: ['x', 'y', 'z'].includes(cfg.axis) ? cfg.axis : 'y',
      dist: Math.max(0.1, Number(cfg.dist) || 2),
      speed: Math.max(0.1, Number(cfg.speed) || 2),
      angle: Math.max(1, Number(cfg.angle) || 90),
      // 旋转原点（局部偏移，相对物体原点，米）：配了就让旋转绕该点转（而非物体默认原点）。
      // 典型用途：门绕端点开合（pivot 设在门轴那侧），而不是绕脚底/边角甩飞。
      pivot: (cfg.pivot && (cfg.pivot.x || cfg.pivot.y || cfg.pivot.z))
        ? { x: Number(cfg.pivot.x) || 0, y: Number(cfg.pivot.y) || 0, z: Number(cfg.pivot.z) || 0 }
        : null,
    },
    active: false, // 等事件触发才开始
    t: 0,          // 平移当前偏移（米）
    rot: 0,        // 旋转当前角度（度）
    dir: 1,
    moved: false,  // 本帧是否移动过（决定要不要刷新碰撞体）
    onMoved: typeof onMoved === 'function' ? onMoved : null,
    off: null,     // 事件退订函数（clear 时用）
  };
  m.off = sceneOn(ev, () => {
    if (m.cfg.loop === 'oneway') {
      if (m.active) {
        m.dir = -m.dir;   // 闩锁式：运动中触发 -> 反向并继续运动
      } else {
        m.active = true;  // 暂停中触发 -> 端点时 dir 已翻向出发点，直接启程；途中则恢复
      }
      return;
    }
    m.active = !m.active; // 往返：toggle 开始/暂停/继续
  });
  _movers.push(m);
  // 按 holder 聚合：同一个物件挂多个运动器时只发一份 transform，避免互相覆盖
  if (!obj.__moverSyncId) {
    obj.__moverSyncId = 'ma' + (_syncSeq++);
    _syncObjs.set(obj.__moverSyncId, { obj, movers: [], onMoved: m.onMoved });
  }
  _syncObjs.get(obj.__moverSyncId).movers.push(m);
  return m;
}

export function clearSceneMovers() {
  for (const m of _movers) if (m.off) m.off();
  _movers.length = 0;
  _syncObjs.clear();
  _syncSeq = 0;
}

export function sceneMoverCount() { return _movers.length; }

// ---- 服务器同步：全量姿态快照（服务端只转发，权威端是房间内编号最小的客户端）----
// 只发 transform + 各运动器的累计量；因为积分是「每帧加增量」，直接覆盖这两个量后
// 后续帧仍然自洽，不需要反推初始 base。新玩家进房时由服务端请求一次，全房间对齐。
// ⚠ ms 只带 [t, rot]，**不覆盖 active/dir**：那两个由 scene_event 广播同步，
//   快照是 3s 周期里的旧状态，写回去会把刚触发的运动硬生生关掉。
export function getSceneMoverSnapshot() {
  const out = [];
  for (const [id, rec] of _syncObjs) {
    const o = rec.obj;
    if (!o || !o.parent) continue;
    out.push({
      id,
      px: o.position.x, py: o.position.y, pz: o.position.z, ry: o.rotation.y,
      ms: rec.movers.map((m) => [m.t, m.rot]),
    });
  }
  return out;
}

// 返回成功套用的物件数。坏数据一律跳过，绝不把 NaN 写进物件 / 碰撞体。
export function applySceneMoverSnapshot(arr) {
  if (!Array.isArray(arr)) return 0;
  let n = 0;
  for (const s of arr) {
    if (!s) continue;
    const rec = _syncObjs.get(String(s.id || ''));
    if (!rec || !rec.obj) continue;
    const nums = [s.px, s.py, s.pz, s.ry].map(Number);
    if (nums.some((v) => !Number.isFinite(v))) continue;
    rec.obj.position.set(nums[0], nums[1], nums[2]);
    rec.obj.rotation.y = nums[3];
    if (Array.isArray(s.ms)) {
      for (let i = 0; i < rec.movers.length && i < s.ms.length; i++) {
        const row = s.ms[i], m = rec.movers[i];
        if (!Array.isArray(row) || row.length < 2) continue;
        const t = Number(row[0]), rot = Number(row[1]);
        if (!Number.isFinite(t) || !Number.isFinite(rot)) continue;
        m.t = t; m.rot = rot; // 只校正累计量，active/dir 由事件广播负责
      }
    }
    if (rec.onMoved) {
      try { rec.onMoved(); } catch (e) { console.warn('[sceneMovers] 同步姿态后刷碰撞体失败:', e); }
    }
    n++;
  }
  return n;
}
// 本帧是否有运动器在动：物理层据此唤醒所有静止球，使移动中的碰撞体（盒/凸包随动）能把球顶起。
export function sceneMoversMoving() { return _moverMoving; }

// 每帧推进。数量级 = 编辑器里配了运动器的摆件数（个位数），全量遍历毫无压力。
export function updateSceneMovers(dt) {
  if (!_movers.length) return;
  const d = Math.min(Math.max(dt, 0), 0.1); // 掉帧/切后台回来的大 dt 钳住，防瞬移
  _moverMoving = false;
  for (const m of _movers) {
    if (!m.active || !m.obj.parent) continue;
    const c = m.cfg;
    if (c.kind === 'translate') {
      const prev = m.t;
      m.t += d * c.speed * m.dir;
      if (m.t >= c.dist) { m.t = c.dist; if (c.loop === 'oneway') { m.dir = -1; m.active = false; } else m.dir = -1; }
      else if (m.t <= 0) { m.t = 0; if (c.loop === 'oneway') { m.dir = 1; m.active = false; } else m.dir = 1; }
      if (m.t !== prev) m.obj.position[c.axis] += m.t - prev; // 增量式：多运动器叠加不互相覆写
    } else {
      const prev = m.rot;
      m.rot += d * c.speed * m.dir;
      if (m.rot >= c.angle) { m.rot = c.angle; if (c.loop === 'oneway') { m.dir = -1; m.active = false; } else m.dir = -1; }
      else if (m.rot <= -c.angle) { m.rot = -c.angle; if (c.loop === 'oneway') { m.dir = 1; m.active = false; } else m.dir = 1; }
      if (m.rot !== prev) {
        const dTheta = THREE.MathUtils.degToRad(m.rot - prev);
        const p = m.pivot;
        if (p) {
          // 绕「旋转原点」旋转：刚体绕其局部 pivot 点（在世界中固定）转 dTheta。
          // 例：门绕端点开合（pivot 设在门轴那侧），而非绕物体默认原点（脚底/边角）甩飞。
          const obj = m.obj;
          const ry = obj.rotation.y;
          const cosR = Math.cos(ry), sinR = Math.sin(ry);
          const sx = obj.scale.x, sz = obj.scale.z;
          const pwx = p.x * sx, pwz = p.z * sz;       // pivot 水平分量（含缩放）
          const px = obj.position.x + (cosR * pwx + sinR * pwz);
          const pz = obj.position.z + (-sinR * pwx + cosR * pwz);
          const c1 = Math.cos(dTheta), s1 = Math.sin(dTheta);
          const dx = obj.position.x - px, dz = obj.position.z - pz;
          obj.position.x = px + (c1 * dx - s1 * dz);
          obj.position.z = pz + (s1 * dx + c1 * dz);
          obj.rotation.y += dTheta;
        } else {
          m.obj.rotation.y += dTheta;
        }
      }
    }
    m.moved = true;
    _moverMoving = true; // 有运动器这一帧动了（平移/旋转都算）→ 物理需唤醒静止球
  }
  // 碰撞体随动：放在运动循环之后统一刷（每帧至多一次/物件），不让「谁先谁后」影响同一帧内的姿态。
  for (const m of _movers) {
    if (!m.moved) continue;
    m.moved = false;
    if (!m.onMoved) continue;
    // 一个物件的随动失败（数据坏了）不能连带后面所有运动体的碰撞一起停在旧位置
    try { m.onMoved(); } catch (e) { console.warn('[sceneMovers] 碰撞随动刷新失败:', e); }
  }
}

// ---- 活动物体的碰撞体随动 ----
// recs 由 EditorBuildings 收集，两种记录：
//   { kind:'box',    c, ox, oy, oz, rotOff }   —— c 是绕 Y 旋转的盒 { cx,cy,cz,hx,hy,hz,rotY }
//   { kind:'convex', c, local }                 —— c 是世界空间凸包 { vertices,... }，local 是 holder 局部顶点
//
// ⚠ 三种缓存必须一起失效，否则「盒子动了但物理还按旧位置算」：
//   __qBox   worldQuery.colliderBox 的世界包围盒缓存（抓钩射线/小球）
//   __bbox   projectileHit.colliderAabb 的 AABB 预筛缓存（投掷物）
//   _cvPrepared  PlayerPhysics._prepareConvex 的 SAT 法线/可站立面预计算
// 凸包的 minX/maxX/minZ/maxZ 由 _cvPrepared=false 触发重算，这里只先填 minY/maxY/cx/cy/cz。
export function syncMoverColliders(recs, holder) {
  if (!recs || !recs.length || !holder || !holder.matrixWorld) return;
  if (holder.updateMatrixWorld) holder.updateMatrixWorld(true);
  const mw = holder.matrixWorld;
  const rotY0 = holder.rotation ? (holder.rotation.y || 0) : 0;
  for (let k = 0; k < recs.length; k++) {
    const r = recs[k];
    const c = r && r.c;
    if (!c) continue;
    if (r.kind === 'box') {
      _v.set(r.ox || 0, r.oy || 0, r.oz || 0).applyMatrix4(mw);
      c.cx = _v.x; c.cy = _v.y; c.cz = _v.z;
      c.rotY = rotY0 + (r.rotOff || 0);
      c.__qBox = undefined;
      c.__bbox = undefined;
    } else {
      const lv = r.local, v = c.vertices;
      if (!lv || !v || v.length < lv.length) continue;
      let minY = Infinity, maxY = -Infinity, sx = 0, sy = 0, sz = 0;
      for (let i = 0; i < lv.length; i += 3) {
        _v.set(lv[i], lv[i + 1], lv[i + 2]).applyMatrix4(mw);
        v[i] = _v.x; v[i + 1] = _v.y; v[i + 2] = _v.z;
        if (_v.y < minY) minY = _v.y;
        if (_v.y > maxY) maxY = _v.y;
        sx += _v.x; sy += _v.y; sz += _v.z;
      }
      const n = lv.length / 3;
      c.minY = minY; c.maxY = maxY;
      c.cx = sx / n; c.cy = sy / n; c.cz = sz / n;
      c._cvPrepared = false;
      c.__qBox = undefined;
      c.__bbox = undefined;
    }
  }
}
