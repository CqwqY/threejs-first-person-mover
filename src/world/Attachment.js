// 职责：通用「挂载」原语 —— 把一个部件 / 乘员绑定到另一个对象身上。
//
// 核心约定（对应「坐车时所有人运动以驾驶员为准」）：
//   · 挂载物的位置 = 目标「权威位置」 + 目标朝向下的局部偏移，直接算出结果；
//   · 目标位置必须来自同一份网络权威快照（或本地权威 state），**不等本地先把目标算完再算挂载物**；
//     这样没有链式依赖、没有双帧延迟，也不会因为插值/物理顺序产生相对车身的抖动；
//   · 所有客户端用同一份目标数据 + 同一偏移公式，各自算出一致的世界位置。
//
// 坐标约定（与 LocalPlayer / Game._updateVehicle 完全一致）：
//   目标前向 = (-sin yaw, -cos yaw)；「后方」= (+sin yaw, +cos yaw)；右向 = (cos yaw, -sin yaw)。
import { Config } from '../config.js';

/**
 * 由目标权威状态直接解析挂载物的世界位姿（纯函数，无副作用、无状态、无顺序依赖）。
 * @param {object} target 目标状态，至少含 {x, y, z, yaw}，可含 pitch
 * @param {object} [offset] 局部偏移（米）：back 向后 / right 向右 / up 向上
 * @returns {{x:number,y:number,z:number,yaw:number,pitch:number}|null}
 */
export function resolveMount(target, offset) {
  if (!target || !Number.isFinite(target.x + target.y + target.z)) return null;
  const o = offset || {};
  const yaw = Number(target.yaw) || 0;
  const back = Number(o.back) || 0;
  const right = Number(o.right) || 0;
  const up = Number(o.up) || 0;
  const sy = Math.sin(yaw), cy = Math.cos(yaw);
  return {
    x: target.x + sy * back + cy * right,
    y: target.y + up,
    z: target.z + cy * back - sy * right,
    yaw,
    pitch: target.pitch,
  };
}

// 载具后座的统一偏移定义：改这里一处，本地乘客 / 远端乘客 / 旧兜底路径全部一致。
export function vehicleSeatPose(driver) {
  return resolveMount(driver, { back: Config.VEHICLE_SEAT_BACK });
}

/**
 * 把一个 THREE.Object3D 绑到目标上，返回一个每帧调用的更新函数。
 * 适用于「部件绑定在运动平台 / 车体 / 道具上」这类纯视觉随动。
 * @param {THREE.Object3D} obj 被绑定的部件
 * @param {() => object} getTarget 取目标权威状态的函数
 * @param {object} [offset] 局部偏移
 */
export function bindObject(obj, getTarget, offset) {
  return function updateMountedObject() {
    const p = resolveMount(getTarget(), offset);
    if (!p || !obj) return null;
    obj.position.set(p.x, p.y, p.z);
    obj.rotation.y = p.yaw;
    return p;
  };
}
