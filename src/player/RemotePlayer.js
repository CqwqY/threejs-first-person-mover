// 职责：代表一个远程玩家，组合 PlayerState（数据）与 PlayerModel（外观），并对状态做插值渲染。
import { Config } from '../config.js';
import { PlayerState } from './PlayerState.js';
import { createPlayerModel } from './PlayerModel.js';

export class RemotePlayer {
  // id：网络玩家唯一标识；stateData：初始快照（可含 num 用于名牌）；name：可选的名牌文字覆盖
  constructor(id, stateData, name) {
    this.id = id;

    // target：最新网络目标状态；state：用于渲染的插值状态（不断向 target 逼近）
    this.target = new PlayerState().fromJSON(stateData);
    this.target.id = id;
    this.state = new PlayerState().fromJSON(stateData);
    this.state.id = id;

    // 名牌文字：优先用传入 name，其次从状态里的加入序号（num）推导，如"玩家1"
    const label = name || (stateData && stateData.num ? `玩家${stateData.num}` : id);

    // 外观模型（含头顶名牌）
    this.model = createPlayerModel(label);
    this.model.visible = true;

    // 初始对齐，避免首帧瞬移
    this.syncModel();
  }

  // 把模型位置/朝向同步到插值状态。
  // 模型原点在脚底，而 state.y 是相机高度（眼睛），所以脚底高度 = state.y - PLAYER_HEIGHT。
  syncModel() {
    this.model.position.set(this.state.x, this.state.y - Config.PLAYER_HEIGHT, this.state.z);
    this.model.rotation.set(0, this.state.yaw, 0);
  }

  // 收到新快照时更新目标状态
  applyState(stateData) {
    this.target.fromJSON(stateData);
  }

  // 每帧：把 state 向 target 插值，再把模型位置/朝向同步到 state
  update(dt) {
    // 简单线性插值（指数平滑）：alpha = 1 - exp(-15*dt)。
    // dt 越大 alpha 越大，收敛越快；dt 越小越平滑，用于平滑跟随远程玩家轨迹。
    const alpha = 1 - Math.exp(-15 * dt);
    this.state.lerpTo(this.target, alpha);

    this.syncModel();
  }
}