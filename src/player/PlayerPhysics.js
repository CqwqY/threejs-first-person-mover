// 职责：只负责计算速度并写入 PlayerState（重力、跳跃、移动、边界）。不接触相机或场景对象。
// 与旧的实现相比，位置字段（x/y/z）与着地标志（onGround）不再自持，而是读写在传入的 state 上，
// 这样同一个物理逻辑既可驱动本地玩家，也可把结果序列化用于网络同步。
import * as THREE from 'three';
import { Config } from '../config.js';

export class PlayerPhysics {
  constructor() {
    // 速度是物理过程量，仍由物理模块内部维护
    this.velocity = new THREE.Vector3(0, 0, 0);
  }

  // 更新一帧物理。
  // dt：秒；input：Input 实例；cameraYaw：相机水平朝向（弧度）；state：PlayerState 实例，读写它的 x/y/z/onGround；
  // colliders：世界空间 AABB 碰撞体 [{cx,cy,cz,hx,hy,hz}]（可选）。
  update(dt, input, cameraYaw, state, colliders = []) {
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

    // 速度倍率：默认速度 ×（冲刺时乘冲刺倍率）。手机摇杆推满也算冲刺
    const sprint =
      input.sprinting() ||
      (input.joyMagnitude && input.joyMagnitude() >= 0.85);
    const speed = Config.MOVE_SPEED * (sprint ? Config.SPRINT_MULTIPLIER : 1);

    // ---- 2. 水平速度 ----
    this.velocity.x = move.x * speed;
    this.velocity.z = move.z * speed;

    // ---- 3. 重力：竖直方向速度持续向下累加（GRAVITY 为负值） ----
    this.velocity.y += Config.GRAVITY * dt;

    // ---- 4. 跳跃：只有站在地面才允许跳 ----
    // 采用一次性探测（consumeJump），防止按住空格时连续起跳
    if (state.onGround && input.consumeJump()) {
      this.velocity.y = Config.JUMP_VELOCITY; // 设置竖直初速度
      state.onGround = false;
    }

    // ---- 5. 积分更新位置：把位置写入 state，供相机与网络读取 ----
    state.x += this.velocity.x * dt;
    state.y += this.velocity.y * dt;
    state.z += this.velocity.z * dt;

    // ---- 5.5 世界碰撞体碰撞：水平方向把玩家挡在 AABB 之外 ----
    this._resolveWorldCollisions(state, colliders);

    // ---- 6. 地面碰撞：防止下穿地面，落到 PLAYER_HEIGHT 处即认为着地 ----
    if (state.y <= Config.PLAYER_HEIGHT) {
      state.y = Config.PLAYER_HEIGHT;
      this.velocity.y = 0;
      state.onGround = true;
    }

    // ---- 7. 边界限制：把玩家挡在矩形地面内（宽 x / 长 z） ----
    const limitX = Config.GROUND_WIDTH / 2 - Config.PLAYER_RADIUS;
    const limitZ = Config.GROUND_DEPTH / 2 - Config.PLAYER_RADIUS;
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
    const pr = Config.PLAYER_RADIUS;
    const hh = Config.PLAYER_HEIGHT / 2;

    for (const b of colliders) {
      const px = state.x;
      const py = state.y - hh; // 玩家竖直中心（着地时 = HEIGHT/2 = 0.85）
      const pz = state.z;

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
            state.y = b.cy + b.hy + Config.PLAYER_HEIGHT;
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
          state.y = b.cy + b.hy + Config.PLAYER_HEIGHT;
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
}