// 职责：导演自由飞行相机。复用游戏的 Input 类（指针锁定 + 键位），数学搬自 Game._updateSoul。
// 与玩家控制器完全解耦：直接持有并驱动一个 PerspectiveCamera，不走 LocalPlayer。
import * as THREE from 'three';
import { Input } from '../core/Input.js';

const SENS = 0.0022;           // 鼠标灵敏度（弧度/像素）
const BASE_SPEED = 8;          // 飞行速度（单位/秒）
const SPRINT_MUL = 3;          // 按住 Shift 加速倍率
const PITCH_LIMIT = THREE.MathUtils.degToRad(89);

export class DirectorCam {
  constructor(camera, canvas) {
    this.camera = camera;
    this.camera.rotation.order = 'YXZ';
    this.input = new Input();
    this.input.setCanvas(canvas);
    this.yaw = 0;
    this.pitch = 0;
    this.speed = BASE_SPEED;
    this.pos = camera.position.clone();
  }

  // 每帧调用：消费鼠标增量 + 键位，更新相机位姿（编辑模式下由主循环驱动）
  update(dt) {
    const { x, y } = this.input.takeMouseDelta();
    this.yaw -= x * SENS;
    this.pitch -= y * SENS;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -PITCH_LIMIT, PITCH_LIMIT);

    const cosP = Math.cos(this.pitch);
    const sinP = Math.sin(this.pitch);
    const fwd = new THREE.Vector3(-Math.sin(this.yaw) * cosP, sinP, -Math.cos(this.yaw) * cosP);
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const move = new THREE.Vector3();
    if (this.input.forwarded()) move.add(fwd);
    if (this.input.backwarded()) move.sub(fwd);
    if (this.input.strafeRight()) move.add(right);
    if (this.input.strafeLeft()) move.sub(right);
    if (this.input.isDown('Space')) move.y += 1;
    if (this.input.isDown('ControlLeft') || this.input.isDown('ControlRight')) move.y -= 1;
    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar(this.speed * (this.input.sprinting() ? SPRINT_MUL : 1) * dt);
      this.pos.add(move);
    }
    if (this.pos.y < 0.2) this.pos.y = 0.2; // 别钻到地面以下

    this._apply();
  }

  _apply() {
    this.camera.position.copy(this.pos);
    this.camera.rotation.set(this.pitch, this.yaw, 0);
  }

  // 读出当前相机状态（用于打关键帧）
  getState() {
    return {
      pos: this.camera.position.toArray(),
      quat: this.camera.quaternion.toArray(),
      fov: this.camera.fov,
    };
  }

  // 套用一段状态（用于关键帧插值预览 / 逐帧渲染）
  setState(st) {
    this.camera.position.fromArray(st.pos);
    this.camera.quaternion.fromArray(st.quat);
    this.pos.copy(this.camera.position);
    const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
    this.yaw = e.y;
    this.pitch = e.x;
    if (typeof st.fov === 'number' && Math.abs(st.fov - this.camera.fov) > 1e-3) {
      this.camera.fov = st.fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
