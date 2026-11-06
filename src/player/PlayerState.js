// 职责：纯数据容器，描述一个玩家在空间中的可序列化状态，供本地物理读写与网络快照传输。
// 仅使用普通对象字段，不引用任何 Three.js / 场景对象，方便 JSON 序列化与跨客户端传输。
// 角度最短弧插值：把 b-a 归一化到 [-π, π] 再插，避免跨 ±π 时反绕一整圈。
export function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export class PlayerState {
  constructor(id = '', x = 0, y = 0, z = 0, yaw = 0, pitch = 0, onGround = false) {
    this.id = id;
    this.x = x;
    this.y = y;
    this.z = z;
    this.yaw = yaw; // 水平朝向，弧度
    this.pitch = pitch; // 俯仰，弧度
    this.onGround = onGround;
    this.size = 1; // 体型倍率（1 = 正常）；由 NPC 效果改变，需同步给其他玩家
    this.health = 500; // 当前血量（上限 500，由 NPC/AI 接口改动，需同步）
    this.hold = ''; // 手持物的文字（3D 显示在手上，空串 = 手上没东西）
    this.wep = '';  // 手持武器：'' = 空，'club' = 棍子，'gatling' = 加特林
    this.ride = 0;  // 载具座位：0 = 没骑，1 = 驾驶，2 = 后座
    this.veh = '';  // 所乘载具的标识（Config.VEHICLE_ID），用于把前后座配成一对
    this.tp = 0;    // 瞬移序号：每次重生/传送自增。远端看到序号变了就直接落位，不插值、不平滑
    this.mt = '';   // 挂载目标（驾驶员玩家 id）：ride===2 时位置 = 目标权威位置 + 本地偏移，不链式计算
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
      size: this.size,
      health: this.health,
      hold: this.hold,
      wep: this.wep,
      ride: this.ride,
      veh: this.veh,
      tp: this.tp,
      mt: this.mt,
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
    if (data.size !== undefined) this.size = data.size;
    if (data.health !== undefined) this.health = data.health;
    if (data.hold !== undefined) this.hold = data.hold;
    if (data.wep !== undefined) this.wep = data.wep;
    if (data.ride !== undefined) this.ride = data.ride;
    if (data.veh !== undefined) this.veh = data.veh;
    if (data.tp !== undefined) this.tp = data.tp;
    if (data.mt !== undefined) this.mt = data.mt;
    return this;
  }

  // 把 x/y/z/yaw/size 向目标状态做线性插值；health/hold 直接同步（不做插值）。
  // alpha 介于 0~1，越接近 1 越贴近目标；pitch/onGround 不参与插值。
  lerpTo(target, alpha) {
    this.x += (target.x - this.x) * alpha;
    this.y += (target.y - this.y) * alpha;
    this.z += (target.z - this.z) * alpha;
    this.yaw = lerpAngle(this.yaw, target.yaw, alpha);
    const ts = target.size === undefined ? 1 : target.size;
    this.size += (ts - this.size) * alpha;
    if (target.health !== undefined) this.health = target.health;
    if (target.hold !== undefined) this.hold = target.hold;
    if (target.wep !== undefined) this.wep = target.wep;
    if (target.ride !== undefined) this.ride = target.ride;
    if (target.veh !== undefined) this.veh = target.veh;
    if (target.tp !== undefined) this.tp = target.tp;
    if (target.mt !== undefined) this.mt = target.mt;
    return this;
  }
}