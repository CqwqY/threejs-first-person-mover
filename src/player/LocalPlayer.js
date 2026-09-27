// 职责：协调第一人称本地玩家。读取输入更新 yaw/pitch，驱动物理，读写 PlayerState，并同步相机。
// 本地玩家的可序列化状态（PlayerState）由 PlayerManager 创建并注入，本类只读写它，不再自持位置。
import * as THREE from 'three';
import { Config } from '../config.js';
import { PlayerPhysics } from './PlayerPhysics.js';

export class LocalPlayer {
  // camera：渲染相机；input：输入实例；state：本玩家的 PlayerState 实例（来自 PlayerManager）
  // colliders：世界空间碰撞体数组 [{cx,cy,cz,hx,hy,hz}]，参与物理碰撞。
  constructor(camera, input, state, colliders) {
    this.camera = camera;
    this.input = input;
    this.state = state; // 读写这个 state，便于网络同步
    this.colliders = colliders || [];

    // 相机旋转顺序固定为 YXZ：先绕 Y（yaw）水平转向，再绕 X（pitch）俯仰，避免万向锁混乱
    this.camera.rotation.order = 'YXZ';

    // 物理模块（内部只持有速度，位置读写 state）
    this.physics = new PlayerPhysics();
    // 走路晃动状态：相位按实际移动距离推进；bobEnabled 由 Game 按视角切换（仅第一人称开启）
    this.bobEnabled = true;
    this._bobPhase = 0;
    this._prevX = this.state.x;
    this._prevZ = this.state.z;
  }

  // 更新一帧
  update(dt) {
    // ---- 1. 从鼠标移动量更新视角（yaw / pitch），写入 state ----
    const { x, y } = this.input.takeMouseDelta();
    // 鼠标右移（x>0）对应 yaw 增加（向右看）
    this.state.yaw -= x * Config.MOUSE_SENSITIVITY;
    // 鼠标上移（y<0）对应 pitch 增加（向上看）；这里为了让“上移=向上看”取负号
    this.state.pitch -= y * Config.MOUSE_SENSITIVITY;
    // 限制俯仰角在 ±80° 内，避免翻转
    const limit = THREE.MathUtils.degToRad(Config.MAX_PITCH_DEG);
    this.state.pitch = THREE.MathUtils.clamp(this.state.pitch, -limit, limit);

    // ---- 2. 驱动物理：把 yaw、state 与世界碰撞体一并传入，物理直接写 state 的 x/y/z/onGround ----
    this.physics.update(dt, this.input, this.state.yaw, this.state, this.colliders);

    // ---- 3. 同步相机位置与旋转（从 state 读取） ----
    this.camera.position.set(this.state.x, this.state.y, this.state.z);
    this.camera.rotation.y = this.state.yaw;
    this.camera.rotation.x = this.state.pitch;

    // ---- 4. 第一人称走路晃动：按本帧实际移动距离推进相位，叠加轻微上下起伏与左右摇摆 ----
    // 幅度随实际速度缩放，所以贴墙原地推着不会抖；离地或停下时相位归零，避免落地瞬间跳一下。
    const dx = this.state.x - this._prevX;
    const dz = this.state.z - this._prevZ;
    this._prevX = this.state.x;
    this._prevZ = this.state.z;
    if (this.bobEnabled && this.state.onGround) {
      const dist = Math.hypot(dx, dz);
      const v = dt > 0 ? dist / dt : 0;
      const amp = Math.min(v / Config.MOVE_SPEED, 1) * Config.BOB_AMPLITUDE;
      this._bobPhase += dist * Config.BOB_SPEED;
      // 上下起伏：一个步幅一次，所以用 phase * 2
      this.camera.position.y += Math.sin(this._bobPhase * 2) * amp;
      // 左右摇摆：沿相机右方向（cos yaw, 0, -sin yaw）偏移，形成自然的重心摆动
      const sway = Math.cos(this._bobPhase) * amp * 0.6;
      this.camera.position.x += Math.cos(this.state.yaw) * sway;
      this.camera.position.z -= Math.sin(this.state.yaw) * sway;
    } else {
      this._bobPhase = 0;
    }
  }

  // 返回本地玩家的可序列化状态，供网络层读取
  getState() {
    return this.state;
  }
}