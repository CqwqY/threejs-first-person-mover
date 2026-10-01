// 职责：只负责计算速度并写入 PlayerState（重力、跳跃、移动、边界）。不接触相机或场景对象。
// 与旧的实现相比，位置字段（x/y/z）与着地标志（onGround）不再自持，而是读写在传入的 state 上，
// 这样同一个物理逻辑既可驱动本地玩家，也可把结果序列化用于网络同步。
import * as THREE from 'three';
import { Config } from '../config.js';
import { resolveMove } from '../world/collision/characterSolver.js';

export class PlayerPhysics {
  constructor() {
    // 速度是物理过程量，仍由物理模块内部维护
    this.velocity = new THREE.Vector3(0, 0, 0);
    // complex（trimesh）与 simple（盒/凸包）两类碰撞体的每帧拆分缓冲（复用，避免每帧分配）
    this._trimeshes = [];
    this._simples = [];
    // 运行时状态（由 AI 商人 NPC / 外部注入，不必改 Config 全局）
    this.speedMult = 1;   // 移动速度倍率（默认 1 = 正常）
    this.sizeScale = 1;   // 体型倍率（身高/碰撞半径/边界按此缩放，默认 1 = 正常）
    this.sizeTarget = 1;  // 目标体型倍率；sizeScale 每帧向它平滑逼近（避免变大/变小时视点瞬移）
    this.jumpMult = 1;    // 起跳倍率（跳跃初速度乘它，默认 1 = 正常）
    this.gravityMult = 1; // 重力倍率（重力加速度乘它，默认 1 = 正常）
    this.speedMode = 'walk'; // 移动模式：walk/run/swim/fly，影响基础速度
    this.maxJumps = 1;    // 最大连跳次数（1 = 只能落地后跳）
    this._jumpsUsed = 0;  // 本次离地后已用掉的跳跃次数
    this.terminalVelocity = null; // 下坠速度上限（米/秒），null = 不限制
    this.frictionMult = 1;   // 地面摩擦倍率（仅影响无输入时的减速快慢）
    this.accelMult = 1;      // 加速度倍率（仅影响有输入时提速快慢）
    this.velocityHold = null; // 持续速度覆盖 {x,y,z,t}（t 秒内每帧强制该速度）
    this.jetpack = false; // 喷气背包：开启后按住 Space 可悬停/上升
    this.controlLock = false; // 锁定操控：对话栏打开等 UI 占用时，移动/跳/喷气不响应
  }

  // 移动模式对应的基础速度系数：走路 1、奔跑 1.6、游泳 0.6、飞行 1.2
  _modeFactor() {
    switch (this.speedMode) {
      case 'run': return 1.6;
      case 'swim': return 0.6;
      case 'fly': return 1.2;
      default: return 1;
    }
  }

  // 更新一帧物理。
  // dt：秒；input：Input 实例；cameraYaw：相机水平朝向（弧度）；state：PlayerState 实例，读写它的 x/y/z/onGround；
  // colliders：世界空间 AABB 碰撞体 [{cx,cy,cz,hx,hy,hz}]（可选）。
  update(dt, input, cameraYaw, state, colliders = []) {
    // ---- 0. 体型平滑过渡：sizeScale 以固定速率逼近 sizeTarget，约 0.3 秒完成一轮变化 ----
    if (this.sizeScale !== this.sizeTarget) {
      const rate = 3.2;
      this.sizeScale += (this.sizeTarget - this.sizeScale) * Math.min(1, dt * rate);
      if (Math.abs(this.sizeTarget - this.sizeScale) < 0.005) this.sizeScale = this.sizeTarget;
    }

    // ---- 1. 计算水平移动方向 ----
    // 相机朝向（yaw = rotation.y，采用 plane 上方旋转）对应的前方向：
    //   相机默认看向 -Z，绕 Y 轴旋转 yaw 后，前方单位向量 = (-sin yaw, 0, -cos yaw)
    const sin = Math.sin(cameraYaw);
    const cos = Math.cos(cameraYaw);
    const forward = new THREE.Vector3(-sin, 0, -cos);
    // 右向量（前 × 上）=(cos, 0, -sin)
    const right = new THREE.Vector3(cos, 0, -sin);

    // 根据 WASD + 手机摇杆合成期望的水平移动方向（先不归一化）
    const move = new THREE.Vector3();
    move.addScaledVector(forward, Number(input.forwarded()) - Number(input.backwarded()));
    move.addScaledVector(right, Number(input.strafeRight()) - Number(input.strafeLeft()));
    // 摇杆：y 前(+1)/后(-1) 沿 forward，x 右(+1)/左(-1) 沿 right（joyX/joyY 为属性，非函数）
    move.addScaledVector(forward, input.joyY);
    move.addScaledVector(right, input.joyX);

    // 斜向移动需要归一化，否则走斜线会更快
    if (move.lengthSq() > 0) {
      move.normalize();
    }
    // 对话栏等 UI 占用输入时锁定水平移动（重力/碰撞仍生效，人不会飘走）
    if (this.controlLock) move.set(0, 0, 0);

    // 速度倍率：默认速度 ×（冲刺时乘冲刺倍率）。手机摇杆推满也算冲刺
    const sprint =
      input.sprinting() ||
      (input.joyMagnitude && input.joyMagnitude() >= 0.85);
    const speed = Config.MOVE_SPEED * this.speedMult * this._modeFactor() * (sprint ? Config.SPRINT_MULTIPLIER : 1);

    // ---- 2. 水平速度 ----
    // 默认（倍率均为 1）直接赋值，手感与原来完全一致；
    // 一旦 NPC 调过加速度/摩擦，就改用指数逼近，让提速/减速更"有惯性"。
    const targetVx = move.x * speed;
    const targetVz = move.z * speed;
    if (this.accelMult === 1 && this.frictionMult === 1) {
      this.velocity.x = targetVx;
      this.velocity.z = targetVz;
    } else {
      const moving = (move.x !== 0 || move.z !== 0);
      // 有输入按加速度逼近目标；无输入时地面按摩擦力刹车、空中只留很小空气阻力
      const rate = moving ? 12 * this.accelMult : (state.onGround ? 10 * this.frictionMult : 1.5);
      const k = 1 - Math.exp(-dt * rate);
      this.velocity.x += (targetVx - this.velocity.x) * k;
      this.velocity.z += (targetVz - this.velocity.z) * k;
    }

    // ---- 3. 重力：竖直方向速度持续向下累加（GRAVITY 为负值）----
    this.velocity.y += Config.GRAVITY * this.gravityMult * dt;
    // 终端速度：限制下坠最快速度，避免高重力下穿地
    if (this.terminalVelocity && this.velocity.y < -this.terminalVelocity) {
      this.velocity.y = -this.terminalVelocity;
    }

    // ---- 3.5 喷气背包：开启且按住空格、又在空中时，把竖直速度托住为上升/悬停 ----
    // 地面起跳仍走正常 jump；只要在空中按住空格就一直往上升，松开自然下落。
    if (this.jetpack && !this.controlLock && input.isDown && input.isDown('Space') && !state.onGround) {
      this.velocity.y = Math.max(this.velocity.y + (Config.JETPACK_LIFT - this.velocity.y) * Math.min(1, dt * 8), Config.JETPACK_LIFT);
    }

    // ---- 4. 跳跃：落地后重置连跳次数；只要还有剩余次数就允许再跳 ----
    // 采用一次性探测（consumeJump），防止按住空格时连续起跳
    if (state.onGround) this._jumpsUsed = 0;
    if (!this.controlLock && this._jumpsUsed < this.maxJumps && input.consumeJump()) {
      this.velocity.y = Config.JUMP_VELOCITY * this.jumpMult; // 设置竖直初速度（受起跳倍率影响）
      this._jumpsUsed++;
      state.onGround = false;
    }

    // ---- 4.5 持续速度覆盖：NPC 给的速度在 seconds 内每帧强制生效（覆盖重力/输入）----
    if (this.velocityHold && this.velocityHold.t > 0) {
      const h = this.velocityHold;
      if (h.x !== null) this.velocity.x = h.x;
      if (h.y !== null) this.velocity.y = h.y;
      if (h.z !== null) this.velocity.z = h.z;
      h.t -= dt;
      if (h.t <= 0) this.velocityHold = null;
    }

    // ---- 5. 积分更新位置：把位置写入 state，供相机与网络读取 ----
    // complex（trimesh）与 simple（盒/凸包）分成两条互不干扰的解析路径：
    //   - complex：位移交给 characterSolver 的子步进解算（含垂直子步进，防高速下落穿透薄楼板）；
    //   - simple：保持原有单步积分 + AABB/OBB/凸包解析，行为完全不变。
    const trimeshes = this._trimeshes;
    const simples = this._simples;
    trimeshes.length = 0;
    simples.length = 0;
    for (const c of colliders) {
      if (c && c.type === 'trimesh') trimeshes.push(c);
      else simples.push(c);
    }

    if (trimeshes.length) {
      resolveMove(state, this.velocity, trimeshes, dt); // 位置在解算器内部按子步推进
    } else {
      state.x += this.velocity.x * dt;
      state.y += this.velocity.y * dt;
      state.z += this.velocity.z * dt;
    }

    // ---- 5.5 世界碰撞体碰撞：水平方向把玩家挡在 AABB 之外（simple 碰撞体，行为不变）----
    this._resolveWorldCollisions(state, simples);

    // ---- 5.6 地面吸附：脚底仍贴近可站立地面（坡面 / 盒顶 / 平地）时把 y 吸附上去（simple 碰撞体）----
    // 目的：重力每帧把玩家往坡面里嵌、再被碰撞解析推出，会让玩家沿坡持续下滑（像踩冰）。
    // 吸附只做竖直修正（不产生任何水平位移），因此输入为零时玩家能稳稳停在坡上。
    this._snapToGround(state, simples);

    // ---- 6. 地面碰撞：防止下穿地面，落到 PLAYER_HEIGHT 处即认为着地 ----
    const groundY = Config.PLAYER_HEIGHT * this.sizeScale;
    if (state.y <= groundY) {
      state.y = groundY;
      this.velocity.y = 0;
      state.onGround = true;
    } else if (state.onGround && state.y - groundY < 0.6) {
      // 缩小体型时脚底会离地：仍站在地面（落差很小）就贴回地面，避免悬空/掉落感
      state.y = groundY;
      this.velocity.y = 0;
    }

    // ---- 7. 边界限制：把玩家挡在矩形地面内（宽 x / 长 z） ----
    const rScale = Config.PLAYER_RADIUS * this.sizeScale;
    const limitX = Config.GROUND_WIDTH / 2 - rScale;
    const limitZ = Config.GROUND_DEPTH / 2 - rScale;
    state.x = THREE.MathUtils.clamp(state.x, -limitX, limitX);
    state.z = THREE.MathUtils.clamp(state.z, -limitZ, limitZ);
  }

  // 玩家 AABB：竖直占据 [state.y - HEIGHT, state.y]（state.y 是玩家顶部 / 相机高度），
  // 竖直中心 = state.y - HEIGHT/2；XZ 半宽 = PLAYER_RADIUS。
  // 碰撞体为世界空间包围盒 [{cx,cy,cz,hx,hy,hz[,rotY]}]（可选）。不带 rotY 时按 AABB（未旋转盒）；
  // 带 rotY（Y 轴旋转弧度）时该盒为 OBB，用 XZ 平面 2D SAT（玩家正方形对旋转矩形）+ Y 轴单独判定的方式检测。
  // 沿最小穿透轴解析，从而既能挡侧面、也能从顶部顶面着陆（不能从上方穿入）。
  _resolveWorldCollisions(state, colliders) {
    if (!colliders || colliders.length === 0) return;
    const pr = Config.PLAYER_RADIUS * this.sizeScale;
    const hh = (Config.PLAYER_HEIGHT / 2) * this.sizeScale;

    for (const b of colliders) {
      const px = state.x;
      const py = state.y - hh; // 玩家竖直中心（着地时 = HEIGHT/2 = 0.85）
      const pz = state.z;

      // ---- 凸包碰撞体：玩家 AABB 对凸多面体，用「凸包面法线 + 世界三轴」做 SAT ----
      if (b.type === 'convex') {
        this._resolveConvex(state, b, px, py, pz, pr, hh);
        continue;
      }

      const theta = b.rotY || 0;

      // ---- AABB 快速路径：盒子未旋转，沿用原有三轴独立判定 ----
      if (theta === 0) {
        const ox = b.hx + pr - Math.abs(px - b.cx);
        const oy = b.hy + hh - Math.abs(py - b.cy);
        const oz = b.hz + pr - Math.abs(pz - b.cz);
        if (ox <= 0 || oy <= 0 || oz <= 0) continue;

        // 选最小穿透轴解析（竖直优先，其次 X 再 Z，保证顶面着陆稳定）
        if (oy <= ox && oy <= oz) {
          if (py > b.cy) {
            state.y = b.cy + b.hy + Config.PLAYER_HEIGHT * this.sizeScale;
            if (this.velocity.y < 0) this.velocity.y = 0;
            state.onGround = true;
          } else {
            state.y = b.cy - b.hy;
            if (this.velocity.y > 0) this.velocity.y = 0;
          }
        } else if (ox <= oz) {
          state.x += px > b.cx ? ox : -ox;
        } else {
          state.z += pz > b.cz ? oz : -oz;
        }
        continue;
      }

      // ---- OBB：玩家（AABB）对绕 Y 轴旋转的包围盒 ----
      // Y 轴旋转不改变顶面/底面位置，竖直重叠仍按世界 Y 独立判定。
      const oy = b.hy + hh - Math.abs(py - b.cy);
      if (oy <= 0) continue;

      // 盒本地 X / Z 在 XZ 平面的世界方向（单位向量）
      const cos = Math.cos(theta), sin = Math.sin(theta);
      const u2 = { x: cos, z: -sin }; // 盒本地 +X
      const w2 = { x: sin, z: cos };  // 盒本地 +Z

      // XZ 平面 2D SAT：候选分离轴 = 玩家 X、玩家 Z、盒本地 X、盒本地 Z
      const cand = [{ x: 1, z: 0 }, { x: 0, z: 1 }, u2, w2];
      let minPen = Infinity;
      let bestL = null;
      let separated = false;
      for (const L of cand) {
        // 玩家正方形（XZ 半长 pr，轴对齐）在单位轴 L 上的投影 = pr*(|Lx|+|Lz|)
        const pProj = pr * (Math.abs(L.x) + Math.abs(L.z));
        // 旋转盒在 L 上的投影 = hx*|L·u| + hz*|L·w|
        const bProj = b.hx * Math.abs(L.x * u2.x + L.z * u2.z)
                    + b.hz * Math.abs(L.x * w2.x + L.z * w2.z);
        const cDist = Math.abs((px - b.cx) * L.x + (pz - b.cz) * L.z);
        const ovl = pProj + bProj - cDist;
        if (ovl <= 0) { separated = true; break; } // 存在分离轴，XZ 不相交
        if (ovl < minPen) { minPen = ovl; bestL = L; }
      }
      if (separated) continue;

      // 竖直穿透最小 → 顶面/底面解析（保持在转动的盒顶站稳）
      if (oy <= minPen) {
        if (py > b.cy) {
          state.y = b.cy + b.hy + Config.PLAYER_HEIGHT * this.sizeScale;
          if (this.velocity.y < 0) this.velocity.y = 0;
          state.onGround = true;
        } else {
          state.y = b.cy - b.hy;
          if (this.velocity.y > 0) this.velocity.y = 0;
        }
        continue;
      }

      // 否则沿最小穿透的 XZ 分离轴方向，把玩家推出盒体
      const dir = ((px - b.cx) * bestL.x + (pz - b.cz) * bestL.z) >= 0 ? 1 : -1;
      state.x += bestL.x * minPen * dir;
      state.z += bestL.z * minPen * dir;
    }
  }

  // 玩家 AABB 对凸多面体（凸包）碰撞：SAT。
  // 分离轴 = 世界 X/Y/Z（玩家面法线）+ 凸包各三角面法线（去重、封顶）。
  // 取最小穿透轴解析：若为世界 Y 且玩家在凸包质心上方则顶面着陆（站在凸包顶部），否则沿该轴推出。
  _resolveConvex(state, b, px, py, pz, pr, hh) {
    const V = b.vertices;
    const F = b.faces;
    const pC = { x: px, y: py, z: pz };
    const cC = { x: b.cx, y: b.cy, z: b.cz };

    // 候选轴：世界三轴 + 去重后的凸包面法线
    const axes = [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }];
    const seen = new Set();
    for (let i = 0; i + 2 < F.length; i += 3) {
      const i0 = F[i] * 3, i1 = F[i + 1] * 3, i2 = F[i + 2] * 3;
      const ax = V[i1] - V[i0], ay = V[i1 + 1] - V[i0 + 1], az = V[i1 + 2] - V[i0 + 2];
      const bx = V[i2] - V[i0], by = V[i2 + 1] - V[i0 + 1], bz = V[i2 + 2] - V[i0 + 2];
      let nx = ay * bz - az * by;
      let ny = az * bx - ax * bz;
      let nz = ax * by - ay * bx;
      let len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (len < 1e-9) continue;
      nx /= len; ny /= len; nz /= len;
      const key = nx.toFixed(3) + ',' + ny.toFixed(3) + ',' + nz.toFixed(3);
      if (seen.has(key)) continue;
      seen.add(key);
      axes.push({ x: nx, y: ny, z: nz });
      if (axes.length >= 48) break; // 面数很多时封顶，避免每帧过重
    }

    let minOverlap = Infinity;
    let minAxis = null;
    for (const L of axes) {
      // 玩家 AABB 在该轴上的投影半宽 = pr*|Lx| + hh*|Ly| + pr*|Lz|
      const wA = pr * (Math.abs(L.x) + Math.abs(L.z)) + hh * Math.abs(L.y);
      const cA = pC.x * L.x + pC.y * L.y + pC.z * L.z;
      // 凸包顶点在该轴上的投影范围
      let vMin = Infinity, vMax = -Infinity;
      for (let i = 0; i < V.length; i += 3) {
        const d = V[i] * L.x + V[i + 1] * L.y + V[i + 2] * L.z;
        if (d < vMin) vMin = d;
        if (d > vMax) vMax = d;
      }
      const overlap = Math.min(cA + wA, vMax) - Math.max(cA - wA, vMin);
      if (overlap <= 1e-6) return; // 存在分离轴，不相交
      if (overlap < minOverlap) { minOverlap = overlap; minAxis = L; }
    }
    if (!minAxis) return;

    // 世界 Y 轴穿透最小：玩家整体在凸包顶之上 → 顶面着陆；整体在底之下 → 挡回；
    // 竖直中心嵌在凸包内（侧面撞进/陷在内部）→ 沿水平穿透更小的方向推出，避免把玩家「顶高」。
    const isY = Math.abs(minAxis.y) > 0.999;
    if (isY) {
      if (py > b.maxY) {
        state.y = b.maxY + Config.PLAYER_HEIGHT * this.sizeScale;
        if (this.velocity.y < 0) this.velocity.y = 0;
        state.onGround = true;
      } else if (py < b.minY) {
        state.y = b.minY;
        if (this.velocity.y > 0) this.velocity.y = 0;
      } else {
        // 玩家中心在凸包竖直范围内：按 X / Z 中穿透更小的轴水平推出
        let vMinX = Infinity, vMaxX = -Infinity, vMinZ = Infinity, vMaxZ = -Infinity;
        for (let i = 0; i < V.length; i += 3) {
          const vx = V[i], vz = V[i + 2];
          if (vx < vMinX) vMinX = vx; if (vx > vMaxX) vMaxX = vx;
          if (vz < vMinZ) vMinZ = vz; if (vz > vMaxZ) vMaxZ = vz;
        }
        const ox = Math.min(px + pr, vMaxX) - Math.max(px - pr, vMinX);
        const oz = Math.min(pz + pr, vMaxZ) - Math.max(pz - pr, vMinZ);
        if (ox <= oz) state.x += px > b.cx ? ox : -ox;
        else state.z += pz > b.cz ? oz : -oz;
      }
      return;
    }

    // 统一把最小穿透轴的方向翻向「玩家所在的一侧」（翻转不改变推出量，只让后续符号判断简单）
    const sd = (px - cC.x) * minAxis.x + (py - cC.y) * minAxis.y + (pz - cC.z) * minAxis.z;
    const dir = sd >= 0 ? 1 : -1;
    const nx = minAxis.x * dir, ny = minAxis.y * dir, nz = minAxis.z * dir;

    // ---- 可站立斜面：最小穿透轴是坡面法线（竖直分量达阈值，且不是世界 Y 轴）----
    // 这种面视为「地面」而不是「墙」：推出方向仍取坡面法线（所以上坡方向可行走、不会被当成墙挡住），
    // 但把推出量的水平分量按 SLOPE_GRIP 抵消、改用等量的竖直吸附补齐（推导见下）。
    // 这样重力每帧把玩家嵌入斜面时不再每帧产生一点水平推出，从而不会沿坡持续下滑；输入为零即可稳停。
    // 穿透过深（超过地面吸附距离，如高速坠落穿入）时仍走原有法线推出，避免一帧内瞬移。
    const absNy = Math.abs(ny);
    if (absNy >= Config.SLOPE_MAX_NORMAL_Y && absNy < 0.999 && minOverlap <= Config.GROUND_SNAP_DISTANCE) {
      const horiz = 1 - Config.SLOPE_GRIP; // 水平分量保留比例（抓地越强保留越少）
      // 需要的位移 d 要满足 n·d = minOverlap：水平分量取 n.xz*minOverlap*horiz，
      // 则竖直分量 dy = minOverlap * (1 - horiz * (1 - ny^2)) / ny。
      // 校验：SLOPE_GRIP=0（horiz=1）→ dy = minOverlap*ny，与旧的法线推出完全等价；
      //       SLOPE_GRIP=1（horiz=0）→ 水平为 0、dy = minOverlap/ny，即纯竖直吸附到坡面。
      state.x += nx * minOverlap * horiz;
      state.z += nz * minOverlap * horiz;
      state.y += minOverlap * (1 - horiz * (1 - ny * ny)) / ny;
      if (ny > 0) {
        // 玩家在坡面之上：算着地，清掉向下速度（否则重力会逐帧累加，导致每帧更深地嵌入）
        if (this.velocity.y < 0) this.velocity.y = 0;
        state.onGround = true;
      } else if (this.velocity.y > 0) {
        // 玩家在坡面之下（顶到坡的底面）：挡回向上速度
        this.velocity.y = 0;
      }
      return;
    }

    // 其余情况（墙面 / 陡面 / 深穿透）：沿最小穿透轴把玩家推出凸包，保持原有行为
    state.x += minAxis.x * minOverlap * dir;
    state.y += minAxis.y * minOverlap * dir;
    state.z += minAxis.z * minOverlap * dir;
  }

  // ---- 地面吸附（ground snap）----
  // 玩家仍处于着地状态（且不在上升）时，在脚底下方 GROUND_SNAP_DISTANCE 范围内找「最高的可站立地面」，
  // 把玩家沿竖直方向吸附到该地面高度：上坡时 y 跟着坡面抬升、下坡时 y 跟着坡面下降（不掉空、不微跳），
  // 停坡时每帧的微小嵌入被竖直补齐而不是被水平推出，因此不会持续下滑。
  // 只做竖直修正、绝不产生水平位移；且只在「地面位于脚底之下」时生效，所以不会顺着吸附爬台阶/爬墙。
  // 可站立地面 = 平地(y=0) / 盒与绕 Y 旋转盒的顶面 / 凸包上法线竖直分量达阈值的面（含斜面）。
  _snapToGround(state, colliders) {
    if (this.velocity.y > 0) return; // 上升（跳跃）中不吸附
    if (!state.onGround) return; // 空中不吸附，正常下落交给碰撞解析
    // 正在坠落时不吸附：onGround 可能是「走下平台」前的残留状态，
    // 此时若吸附会把玩家在离地仍有一段距离时就拉到地面并清零竖直速度，表现为「坠落震一下」。
    if (this.velocity.y < -Config.GROUND_SNAP_MAX_FALL_SPEED) return;

    const pr = Config.PLAYER_RADIUS * this.sizeScale;
    const feet = state.y - Config.PLAYER_HEIGHT * this.sizeScale; // 脚底高度
    const snap = Config.GROUND_SNAP_DISTANCE;

    // 候选地面高度：取脚底及其以下（含极小容差）中最高的一个
    let best = feet + 1e-4 >= 0 ? 0 : -Infinity; // 平地（y = 0）
    for (const b of colliders) {
      let y = null;
      if (b.type === 'convex') {
        // 粗筛：凸包整体都在脚底之上、或最高点已经低于吸附范围时，不可能成为支撑面
        if (b.minY !== undefined && b.minY > feet + 1e-4) continue;
        if (b.maxY !== undefined && b.maxY < feet - snap) continue;
        y = this._convexStandHeight(b, state.x, state.z, pr);
      } else if (this._overFootprint(state.x, state.z, pr, b)) {
        y = b.cy + b.hy; // 盒顶面（绕 Y 旋转不改变顶面高度）
      }
      if (y === null || y > feet + 1e-4) continue; // 面在脚底之上：不吸附（交给碰撞解析）
      if (y > best) best = y;
    }

    if (best === -Infinity) return;
    if (feet - best > Math.min(snap, Config.GROUND_SNAP_MAX_GAP)) return; // 落差过大 = 正在下落，交给碰撞解析正常着陆

    state.y = best + Config.PLAYER_HEIGHT * this.sizeScale;
    if (this.velocity.y < 0) this.velocity.y = 0;
    state.onGround = true;
  }

  // 求凸包在 (x,z) 处「可站立面」的接触高度（没有可站立面则返回 null）。
  // 与 _resolveConvex 的推出约定保持一致：以玩家 AABB 脚底角点中沿坡面法线最低者刚触面为准，
  // 故接触高度 = 该面在 (x,z) 的平面高度 + pr*(|nx|+|nz|)/ny（面越斜，这一补偿越大）。
  // 两者用同一约定，才不会出现「解析抬一点、吸附压一点」的来回抖动。
  _convexStandHeight(b, x, z, pr) {
    const V = b.vertices;
    const F = b.faces;
    if (!Array.isArray(V) || !Array.isArray(F)) return null;
    const minNy = Config.SLOPE_MAX_NORMAL_Y;
    let best = null;
    for (let i = 0; i + 2 < F.length; i += 3) {
      const i0 = F[i] * 3, i1 = F[i + 1] * 3, i2 = F[i + 2] * 3;
      // 三角面法线 = 两边叉乘后归一化
      const eax = V[i1] - V[i0], eay = V[i1 + 1] - V[i0 + 1], eaz = V[i1 + 2] - V[i0 + 2];
      const ebx = V[i2] - V[i0], eby = V[i2 + 1] - V[i0 + 1], ebz = V[i2 + 2] - V[i0 + 2];
      let nx = eay * ebz - eaz * eby;
      let ny = eaz * ebx - eax * ebz;
      let nz = eax * eby - eay * ebx;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (len < 1e-9) continue;
      nx /= len; ny /= len; nz /= len;
      if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; } // 统一朝上，便于按平面求高度
      if (ny < minNy) continue; // 陡面 / 竖直面：不可站立，按墙处理
      // 面所在平面 n·p = d，再求 (x,z) 处的高度并做「脚底角点触面」补偿
      const d = nx * V[i0] + ny * V[i0 + 1] + nz * V[i0 + 2];
      const h = (d - nx * x - nz * z + pr * (Math.abs(nx) + Math.abs(nz))) / ny;
      if (best !== null && h <= best) continue; // 已有更高的可站面
      // 只在 (x,z) 落在该三角面的 XZ 投影内时才有效（否则是外推出来的假地面）
      if (!this._pointInTriXZ(x, z, V[i0], V[i0 + 2], V[i1], V[i1 + 2], V[i2], V[i2 + 2])) continue;
      best = h;
    }
    return best;
  }

  // (x,z) 是否落在三角形 (ax,az)/(bx,bz)/(cx,cz) 的 XZ 投影内（含边界，同号判定）
  _pointInTriXZ(x, z, ax, az, bx, bz, cx, cz) {
    const d1 = (x - bx) * (az - bz) - (z - bz) * (ax - bx);
    const d2 = (x - cx) * (bz - cz) - (z - cz) * (bx - cx);
    const d3 = (x - ax) * (cz - az) - (z - az) * (cx - ax);
    const neg = d1 < -1e-9 || d2 < -1e-9 || d3 < -1e-9;
    const pos = d1 > 1e-9 || d2 > 1e-9 || d3 > 1e-9;
    return !(neg && pos);
  }

  // 玩家水平正方形（半宽 pr）是否与盒（AABB / 绕 Y 旋转的 OBB）的顶面投影相交。
  // 用于判断脚下这块盒顶能否作为吸附地面（仅高度判断，不做穿透解析）。
  _overFootprint(x, z, pr, b) {
    const dx = x - b.cx, dz = z - b.cz;
    const theta = b.rotY || 0;
    if (theta === 0) {
      return Math.abs(dx) <= b.hx + pr && Math.abs(dz) <= b.hz + pr;
    }
    // 把偏移投影到盒本地 X / Z 轴（本地 +X = (cos,-sin)，本地 +Z = (sin,cos)），按玩家半径做圆近似
    const cos = Math.cos(theta), sin = Math.sin(theta);
    const lu = dx * cos - dz * sin;
    const lw = dx * sin + dz * cos;
    return Math.abs(lu) <= b.hx + pr && Math.abs(lw) <= b.hz + pr;
  }
}