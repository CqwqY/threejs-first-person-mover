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
  // dt：秒；input：Input 实例；cameraYaw：相机水平朝向（弧度）；state：PlayerState 实例，读写它的 x/y/z/onGround。
  update(dt, input, cameraYaw, state) {
    // ---- 1. 计算水平移动方向 ----
    // 相机朝向（yaw = rotation.y，采用 plane 上方旋转）对应的前方向：
    //   相机默认看向 -Z，绕 Y 轴旋转 yaw 后，前方单位向量 = (-sin yaw, 0, -cos yaw)
    const sin = Math.sin(cameraYaw);
    const cos = Math.cos(cameraYaw);
    const forward = new THREE.Vector3(-sin, 0, -cos);
    // 右向量（前 × 上）=(cos, 0, -sin)
    const right = new THREE.Vector3(cos, 0, -sin);

    // 根据 WASD 合成期望的水平移动方向（先不归一化）
    const move = new THREE.Vector3();
    move.addScaledVector(forward, Number(input.forwarded()) - Number(input.backwarded()));
    move.addScaledVector(right, Number(input.strafeRight()) - Number(input.strafeLeft()));

    // 斜向移动需要归一化，否则走斜线会更快
    if (move.lengthSq() > 0) {
      move.normalize();
    }

    // 速度倍率：默认速度 ×（冲刺时乘冲刺倍率）
    const speed = Config.MOVE_SPEED * (input.sprinting() ? Config.SPRINT_MULTIPLIER : 1);

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

    // ---- 6. 地面碰撞：防止下穿地面，落到 PLAYER_HEIGHT 处即认为着地 ----
    if (state.y <= Config.PLAYER_HEIGHT) {
      state.y = Config.PLAYER_HEIGHT;
      this.velocity.y = 0;
      state.onGround = true;
    }

    // ---- 7. 边界限制：把玩家挡在地面正方形内 ----
    const limit = Config.GROUND_SIZE / 2 - Config.PLAYER_RADIUS;
    state.x = THREE.MathUtils.clamp(state.x, -limit, limit);
    state.z = THREE.MathUtils.clamp(state.z, -limit, limit);
  }
}