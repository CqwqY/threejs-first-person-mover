// 职责：纯数据容器，描述一个玩家在空间中的可序列化状态，供本地物理读写与网络快照传输。
// 仅使用普通对象字段，不引用任何 Three.js / 场景对象，方便 JSON 序列化与跨客户端传输。
export class PlayerState {
  constructor(id = '', x = 0, y = 0, z = 0, yaw = 0, pitch = 0, onGround = false) {
    this.id = id;
    this.x = x;
    this.y = y;
    this.z = z;
    this.yaw = yaw; // 水平朝向，弧度
    this.pitch = pitch; // 俯仰，弧度
    this.onGround = onGround;
  }

  // 生成用于网络传输的纯 JSON 快照（不包含 onGround 之外的派生/本地字段）
  toJSON() {
    return {
      id: this.id,
      x: this.x,
      y: this.y,
      z: this.z,
      yaw: this.yaw,
      pitch: this.pitch,
    };
  }

  // 从服务端快照数据更新自身字段（未提供的字段保持不变）
  fromJSON(data) {
    if (data.id !== undefined) this.id = data.id;
    if (data.x !== undefined) this.x = data.x;
    if (data.y !== undefined) this.y = data.y;
    if (data.z !== undefined) this.z = data.z;
    if (data.yaw !== undefined) this.yaw = data.yaw;
    if (data.pitch !== undefined) this.pitch = data.pitch;
    if (data.onGround !== undefined) this.onGround = data.onGround;
    return this;
  }

  // 把 x/y/z/yaw 向目标状态做线性插值。
  // alpha 介于 0~1，越接近 1 越贴近目标；pitch/onGround 不参与插值。
  lerpTo(target, alpha) {
    this.x += (target.x - this.x) * alpha;
    this.y += (target.y - this.y) * alpha;
    this.z += (target.z - this.z) * alpha;
    this.yaw += (target.yaw - this.yaw) * alpha;
    return this;
  }
}