// 职责：代表一个远程玩家，组合 PlayerState（数据）与 PlayerModel（外观），并对状态做插值渲染。
import { PlayerState } from './PlayerState.js';
import { createPlayerModel } from './PlayerModel.js';

export class RemotePlayer {
  // id：网络玩家唯一标识；stateData：初始快照（JSON 对象或 PlayerState）
  constructor(id, stateData) {
    this.id = id;

    // target：最新网络目标状态；state：用于渲染的插值状态（不断向 target 逼近）
    this.target = new PlayerState().fromJSON(stateData);
    this.target.id = id;
    this.state = new PlayerState().fromJSON(stateData);
    this.state.id = id;

    // 外观模型
    this.model = createPlayerModel();
    this.model.visible = true;

    // 初始对齐，避免首帧瞬移
    this.model.position.set(this.state.x, this.state.y, this.state.z);
    this.model.rotation.set(0, this.state.yaw, 0);
  }

  // 收到新快照时更新目标状态
  applyState(stateData) {
    this.target.fromJSON(stateData);
  }

  // 把 state 向 target 插值，再把模型位置/朝向同步到 state
  update(dt) {
    // 简单线性插值（指数平滑）：alpha = 1 - exp(-15*dt)。
    // dt 越大 alpha 越大，收敛越快；dt 越小越平滑，用于平滑跟随远程玩家轨迹。
    const alpha = 1 - Math.exp(-15 * dt);
    this.state.lerpTo(this.target, alpha);

    // 同步模型外观（仅使用 yaw 水平旋转）
    this.model.position.set(this.state.x, this.state.y, this.state.z);
    this.model.rotation.set(0, this.state.yaw, 0);
  }
}