// 职责：协调第一人称本地玩家。读取输入更新 yaw/pitch，驱动物理，读写 PlayerState，并同步相机。
// 本地玩家的可序列化状态（PlayerState）由 PlayerManager 创建并注入，本类只读写它，不再自持位置。
import * as THREE from 'three';
import { Config } from '../config.js';
import { PlayerPhysics } from './PlayerPhysics.js';

// 把角度折到 [-π, π]：相机缓动必须走「最短方向」，否则从 179° 转到 -179° 会绕一大圈。
function wrapPi(a) {
  let v = (a + Math.PI) % (Math.PI * 2);
  if (v < 0) v += Math.PI * 2;
  return v - Math.PI;
}

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
    // 碰撞体宽相位网格的显式失效入口（见 PlayerPhysics.markCollidersDirty）。
    // Game 原地改写 colliders（竞技场切换 / 赛道增删 / 拉到远程场景）后**必须**调它 ——
    // 原地改写时数组长度可能恰好不变，光靠长度检测抓不到。
    this.markCollidersDirty = () => this.physics.markCollidersDirty();
    // 走路晃动状态：相位按实际移动距离推进；bobEnabled 由 Game 按视角切换（仅第一人称开启）
    this.bobEnabled = true;
    this._bobPhase = 0;
    this._prevX = this.state.x;
    this._prevZ = this.state.z;
    this._vehSpeed = 0; // 电动车驾驶速度（带惯性，见 _driveVehicle）
    this._vehSteer = 0; // 平滑后的方向盘位置（-1 左 / 0 正 / +1 右），见 _driveVehicle
    // 骑车相机（仅电脑）拆成两层，见 update()：
    //   _camYaw  = 相机自己的水平朝向，按 RIDE_CAM_LAG 缓动追车头 → 转弯时视角是「被一股力慢慢拖过去」的
    //   _rideLook = 鼠标掰出来的自由视角偏移，按 RIDE_CAM_RECENTER 慢慢回正（随时可以再掰）
    //   这两层拉力在**车停住时都停掉**（见 update 里的 stopped）
    this._camYaw = state.yaw;
    this._rideLook = 0;
    this.rideLookEnabled = false; // 由 Game 按触屏判定设置（手机不开）
    this._rideLookMax = THREE.MathUtils.degToRad(Config.RIDE_LOOK_MAX_DEG);
    // 骑车视角：false = 视角操控（自由视角，鼠标/触屏可左右掰头看）；true = 锁视角（相机恒在车后，不甩）。
    // 默认跟随设置 rideView（Game 构造时写入）；也能在骑行中由 HUD 按钮实时切换。
    this._rideViewLocked = false;
  }

  // 骑行中由 HUD 按钮 / 设置项实时切换「视角操控 / 锁视角」
  setRideViewLocked(on) {
    this._rideViewLocked = !!on;
    if (this._rideViewLocked && this.state.ride) {
      // 一锁就立刻对齐到车后，不拖泥带水
      this._camYaw = this.state.yaw;
      this._rideLook = 0;
    }
  }

  // 相机实际用的水平朝向 = 缓动跟上的车头 + 自由视角偏移（不骑车/手机时两层都恒等于 state.yaw）
  get viewYaw() {
    return this._camYaw + this._rideLook;
  }

  // 下车 / 切场景时立刻对齐（别等下一帧的 update，免得有一帧歪着看）
  resetRideLook() {
    this._rideLook = 0;
    this._camYaw = this.state.yaw;
  }

  // 电动车驾驶：油门（W / 摇杆前推）→ 有惯性地点加速；松油门靠阻力滑行；跳跃键（骑乘时跳跃本来就无效）当刹车；
  // 左右（A/D，或手机上的左右转向按钮）改**车头朝向**，速度越快转向越有效（静止打方向没用）。
  // 水平速度用 physics.velocityHold 每帧覆盖（y 传 null → 保留重力/落地），所以「转的是车，不是横着平移」。
  _driveVehicle(dt) {
    const inp = this.input;
    const fwd = inp.forwarded && inp.forwarded() ? 1 : 0;
    const back = inp.backwarded && inp.backwarded() ? 1 : 0;
    const joyY = inp.joyY || 0;
    const thr = Math.min(1, Math.max(0, joyY) + fwd);
    const rev = Math.min(1, Math.max(0, -joyY) + back);
    // 转向：右为正。⚠ yaw 的符号约定是「yaw 减小 = 向右转」（与鼠标视角的 `yaw -= x` 一致），
    // 所以这里必须用 `-=`；写成 `+=` 会让 A / D 整个反过来。
    const steer = (inp.strafeRight && inp.strafeRight() ? 1 : 0) - (inp.strafeLeft && inp.strafeLeft() ? 1 : 0);
    const braking = !!(inp.isDown && inp.isDown('Space'));
    // 刹车用的就是空格（骑乘时跳跃本来就无效）——顺手把它消费掉，免得攒到下车那一瞬间蹦一下
    if (inp.consumeJump) inp.consumeJump();

    const maxF = Config.VEHICLE_SPEED;
    const maxR = maxF * Config.VEHICLE_REVERSE_RATIO;
    let sp = this._vehSpeed || 0;
    if (braking) {
      const dec = Config.VEHICLE_BRAKE * dt;
      sp = Math.abs(sp) <= dec ? 0 : sp - Math.sign(sp) * dec; // 刹车：往 0 收，不反向
    } else if (thr > 0) {
      sp += Config.VEHICLE_ACCEL * thr * dt;
    } else if (rev > 0) {
      sp -= Config.VEHICLE_ACCEL * 0.8 * rev * dt;
    } else {
      sp -= sp * Math.min(1, Config.VEHICLE_DRAG * dt); // 松油门 = 惯性滑行（阻力系数越小越"溜"）
      if (Math.abs(sp) < 0.15) sp = 0;
    }
    sp = Math.max(-maxR, Math.min(maxF, sp));
    this._vehSpeed = sp;

    // 转向：把「按钮的一开一关」平滑成渐进的方向盘 —— 否则按下/松开都是一瞬间满舵，
    // 车头会「咔」地扭一下，手感很不顺滑（手机上尤其明显）。
    // 抓地力随速度上来（静止/极慢时打方向不动），倒车时方向反过来。
    const k = 1 - Math.exp(-dt * Config.VEHICLE_STEER_SMOOTH);
    this._vehSteer = (this._vehSteer || 0) + (steer - (this._vehSteer || 0)) * k;
    if (Math.abs(this._vehSteer) < 0.01) this._vehSteer = 0;
    const grip = Math.min(1, Math.abs(sp) / 2.5) * (sp < -0.01 ? -1 : 1);
    if (this._vehSteer) this.state.yaw -= this._vehSteer * Config.VEHICLE_TURN * dt * grip;

    const fx = -Math.sin(this.state.yaw);
    const fz = -Math.cos(this.state.yaw);
    this.physics.velocityHold = { x: fx * sp, y: null, z: fz * sp, t: 0.06 };
  }

  // 更新一帧
  update(dt) {
    // ---- 1. 从鼠标移动量更新视角（yaw / pitch），写入 state ----
    const { x, y } = this.input.takeMouseDelta();
    // yaw 的符号约定：**yaw 减小 = 向右转**（前方 = (-sin yaw, -cos yaw)，yaw=0 朝 -Z，yaw 减小转向 +X）。
    // 所以鼠标右移（x>0）要减 —— 这里写 `-=` 是对的，别被"右移该增加"的直觉带反。
    // 骑电动车时车头由「转向」控制（A/D 或手机左右按钮），鼠标只负责俯仰 ——
    // 否则一动视角车头就跟着甩，配上惯性根本没法开。
    // 电脑上另给一层「软跟随相机」（只影响相机，state.yaw / 广播 / 车头一点不动）：
    //   ① 转弯时相机不是瞬间锁死在车头上，而是按 RIDE_CAM_LAG 缓动跟过去 → 视角像被一股力慢慢拖过去；
    //   ② 鼠标可以随时把它掰开（自由视角），松手后按 RIDE_CAM_RECENTER 慢慢回正；
    //   ③ 车停住（速度 ≤ RIDE_CAM_MIN_SPEED）时 ①② 都不施加，视角停在哪就是哪。
    if (!this.state.ride) {
      this.state.yaw -= x * Config.MOUSE_SENSITIVITY;
      // 不在车上：两层都对齐朝向，相机行为与改动前完全一致
      this._camYaw = this.state.yaw;
      this._rideLook = 0;
    } else if (this._rideViewLocked) {
      // 锁视角：相机始终贴在车后（只跟着车头转向），鼠标左右不掰视角、也不做软跟随。
      // 这是「锁视角按钮」开启时的状态——开车时视角稳稳朝前，适合专心看路 / 看车把。
      this._camYaw = this.state.yaw;
      this._rideLook = 0;
      // 鼠标 x 在这段被整段吞掉（不写任何视角量），pitch 仍由下方统一处理。
    } else if (this.rideLookEnabled) {
      this._rideLook = THREE.MathUtils.clamp(
        this._rideLook - x * Config.MOUSE_SENSITIVITY,
        -this._rideLookMax, this._rideLookMax
      );
      // 「回正力」和「跟随拉力」只在车真的在动的时候才施加 ——
      // 停着的时候没有「车头方向」可追，再拽就只是把玩家刚掰过去的视角硬拉回来
      // （等红灯/停车时想转头看四周，结果视角自己往回爬，很烦）。
      // ⚠ 只对**驾驶位**判静止：乘客（ride === 2）拿不到车速，不能当成静止把他甩在原地不跟车头转。
      // ⚠ 用的是上一帧的速度（_driveVehicle 在下面第 1.5 步才更新），差一帧无所谓。
      const stopped = this.state.ride === 1
        && Math.abs(this._vehSpeed || 0) <= Config.RIDE_CAM_MIN_SPEED;
      if (!stopped) {
        // 「回正力」：指数衰减，松手后会自己回到车头方向（越小回得越慢，0 = 不回）
        this._rideLook *= Math.exp(-dt * Config.RIDE_CAM_RECENTER);
        if (Math.abs(this._rideLook) < 1e-4) this._rideLook = 0;
        // 「跟随拉力」：把相机朝向按最短角缓动到车头方向
        const d = wrapPi(this.state.yaw - this._camYaw);
        this._camYaw += d * (1 - Math.exp(-dt * Config.RIDE_CAM_LAG));
      }
    } else {
      // 手机：不做软跟随相机，两层对齐（行为与改动前一致）
      this._camYaw = this.state.yaw;
      this._rideLook = 0;
    }
    // 鼠标上移（y<0）对应 pitch 增加（向上看）；这里为了让“上移=向上看”取负号
    this.state.pitch -= y * Config.MOUSE_SENSITIVITY;
    // 限制俯仰角在 ±80° 内，避免翻转
    const limit = THREE.MathUtils.degToRad(Config.MAX_PITCH_DEG);
    this.state.pitch = THREE.MathUtils.clamp(this.state.pitch, -limit, limit);

    // ---- 1.5 驾驶位：接管水平速度（惯性 + 刹车 + 转向）----
    if (this.state.ride === 1) this._driveVehicle(dt);
    else { this._vehSpeed = 0; this._vehSteer = 0; }

    // ---- 2. 驱动物理：把 yaw、state 与世界碰撞体一并传入，物理直接写 state 的 x/y/z/onGround ----
    this.physics.update(dt, this.input, this.state.yaw, this.state, this.colliders);

    // ---- 3. 同步相机位置与旋转（从 state 读取） ----
    // 水平朝向用 viewYaw（缓动跟上的车头 + 自由视角偏移）：骑车时能左右转头看而不影响行驶方向。
    if (this.state.ride) {
      // 骑车第一人称：相机在眼睛基础上再下沉一点，低头就能看见车把（默认相机太高，只看得见前方路）。
      this.camera.position.set(this.state.x, this.state.y - Config.RIDE_EYE_DROP, this.state.z);
    } else {
      this.camera.position.set(this.state.x, this.state.y, this.state.z);
    }
    this.camera.rotation.y = this.viewYaw;
    this.camera.rotation.x = this.state.pitch;

    // ---- 4. 第一人称走路晃动：按本帧实际移动距离推进相位，叠加轻微上下起伏与左右摇摆 ----
    // 幅度随实际速度缩放，所以贴墙原地推着不会抖；离地或停下时相位归零，避免落地瞬间跳一下。
    // 骑车时不晃（车本身有速度，再叠走路摆动很怪）。
    const dx = this.state.x - this._prevX;
    const dz = this.state.z - this._prevZ;
    this._prevX = this.state.x;
    this._prevZ = this.state.z;
    if (this.bobEnabled && this.state.onGround && !this.state.ride) {
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