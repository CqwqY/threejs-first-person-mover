// 职责：代表一个远程玩家，组合 PlayerState（数据）与 PlayerModel（外观），并对状态做插值渲染。
import { Config } from '../config.js';
import { PlayerState, lerpAngle } from './PlayerState.js';
import { createPlayerModel, updateNameTag, setModelScale, setHeldItem, setHealthBar } from './PlayerModel.js';
import { SnapshotBuffer } from '../net/SnapshotBuffer.js';

// 位置趋近：把「正常移动」与「异常跳变」区分开，异常部分按有限速度平滑，
// 避免丢包外推超前后被真实快照拉回时一帧瞬移（观感上像瞬移/抽搐）。
// - 单帧位移不超过 SNAP_MAX_SPEED 对应值：视为正常移动（含载具 16m/s），直接跟随、零额外延迟
// - 超过的部分（断流恢复的追赶、外推回弹）：按 SNAP_CORRECT_SPEED 逐帧抹平
const SNAP_MAX_SPEED = 22;     // 米/秒：正常水平速度上限（载具 16，留出加速余量）
const SNAP_CORRECT_SPEED = 12; // 米/秒：异常跳变的修正速度

function _approach(cur, target, dt) {
  const d = target - cur;
  if (d >= 0) return cur + Math.min(d, SNAP_MAX_SPEED * dt);
  return cur - Math.min(-d, SNAP_CORRECT_SPEED * dt);
}

export class RemotePlayer {
  // id：网络玩家唯一标识；stateData：初始快照（可含 num 用于名牌）；name：可选的名牌文字覆盖；color：名牌文字颜色
  constructor(id, stateData, name, color) {
    this.id = id;

    // target：最新网络目标状态；state：用于渲染的插值状态（不断向 target 逼近）
    this.target = new PlayerState().fromJSON(stateData);
    this.target.id = id;
    this.state = new PlayerState().fromJSON(stateData);
    this.state.id = id;

    // 名牌文字：优先用传入 name，其次从状态里的加入序号（num）推导，如"玩家1"
    const label = name || (stateData && stateData.num ? `玩家${stateData.num}` : id);
    this.name = label; // 记下来供界面（如捉迷藏的选人列表）展示，避免到处只能看到 id
    // 人物素材：仅两份（girl/boy），按加入序号奇偶确定，让不同玩家使用不同模型
    const num = (stateData && stateData.num) || 0;
    const gender = num % 2 === 0 ? 'girl' : 'boy';

    // 外观模型（人物 GLB + 头顶名牌）
    this.model = createPlayerModel(label, gender, color || '#ffffff');
    this.model.visible = true;

    // 快照缓冲：时间轴插值 + 外推 + 自适应延迟（INTERP_MODE = 'off' 时退回旧的指数平滑）
    this.buf = new SnapshotBuffer();
    this.buf.push(stateData);

    // 初始对齐，避免首帧瞬移
    this.syncModel();
  }

  // 把模型位置/朝向/体型同步到插值状态。
  // 模型原点在脚底，而 state.y 是相机高度（眼睛），所以脚底高度 = state.y - PLAYER_HEIGHT * 体型。
  syncModel() {
    const s = this.state.size || 1;
    setModelScale(this.model, s);
    setHeldItem(this.model, this.state.wep || '', this.state.hold || '');
    setHealthBar(this.model, this.state.health, Config.HEALTH_MAX); // 头顶血量条
    this.model.position.set(this.state.x, this.state.y - Config.PLAYER_HEIGHT * s, this.state.z);
    this.model.rotation.set(0, this.state.yaw, 0);
  }

  // 收到新快照时：入缓冲（带本地接收时间戳），同时仍更新 target 作为旧逻辑兜底
  applyState(stateData) {
    this.target.fromJSON(stateData);
    this.buf.push(stateData);
  }

  // 击飞预演：挥棍者本地给被扫玩家补一段与真实物理同向的弧线（速度 + 重力），
  // 当帧就能看到撞飞方向，不用等网络插值慢慢赶，观感跟手。
  applyKnockPreview(kx, ky, kz) {
    this._knockVx = kx;
    this._knockVy = ky;
    this._knockVz = kz;
    this._knockT = Config.CLUB_KNOCK_HOLD;
  }

  // 刷新头顶名牌文字/颜色（登录资料晚于 welcome 到达时用）
  setLabel(text, color) {
    if (text) this.name = text;
    updateNameTag(this.model, text, color || '#ffffff');
  }

  // 每帧：从快照缓冲按时间轴采样插值（缓冲耗尽则外推），写入 state，再同步模型
  update(dt) {
    if (Config.INTERP_MODE === 'off') {
      // 旧逻辑：指数平滑追最新快照（保留作为一键回退的对比基线）
      const alpha = 1 - Math.exp(-15 * dt);
      this.state.lerpTo(this.target, alpha);
    } else {
      // 新逻辑：按「当前时间 - 自适应延迟」在缓冲里取插值两端，缓冲耗尽时按最后速度外推
      const now = performance.now();
      this.buf.suggestDelayMs(now);
      const s = this.buf.sample(now);
      if (s) {
        const { a, b, alpha } = s;
        // 采样出的「基准位置」
        const bx = a.x + (b.x - a.x) * alpha;
        const by = a.y + (b.y - a.y) * alpha;
        const bz = a.z + (b.z - a.z) * alpha;
        // 水平方向：正常前进直接跟随（保持低延迟、无额外拖影）；只有基准位置向后跳
        // （典型是丢包外推超前后被真实快照拉回）才按有限速度平滑修正，避免一帧瞬移。
        this.state.x = _approach(this.state.x, bx, dt);
        this.state.z = _approach(this.state.z, bz, dt);
        // 垂直方向不做限速：下落速度可能远超水平，限速会造成明显拖影
        this.state.y = by;
        this.state.yaw = lerpAngle(a.yaw, b.yaw, alpha); // 最短弧，跨 ±π 不绕整圈
        // 服务器快照不含 pitch（远端俯仰不参与同步），只在确实带值时更新，别写成 undefined
        if (a.pitch !== undefined) this.state.pitch = a.pitch;
        // 体型/血量/手持/载具这类非连续字段直接取最新快照，不做插值
        const latest = this.buf.latest();
        if (latest) {
          this.state.size = latest.size === undefined ? 1 : latest.size;
          if (latest.health !== undefined) this.state.health = latest.health;
          if (latest.hold !== undefined) this.state.hold = latest.hold;
          if (latest.wep !== undefined) this.state.wep = latest.wep;
          if (latest.ride !== undefined) this.state.ride = latest.ride;
          if (latest.veh !== undefined) this.state.veh = latest.veh;
        }
      } else {
        // 缓冲还没填满：退回旧逻辑，避免首次出现时模型留在原点
        const alpha = 1 - Math.exp(-15 * dt);
        this.state.lerpTo(this.target, alpha);
      }
    }

    // 击飞预演：把被扫飞的弧线本地推一段，期间累加重力，别让角色掉进地里。
    if ((this._knockT || 0) > 0) {
      this._knockT -= dt;
      this.state.x += this._knockVx * dt;
      this.state.y += this._knockVy * dt;
      this.state.z += this._knockVz * dt;
      this._knockVy += Config.GRAVITY * dt;
      const minY = Config.PLAYER_HEIGHT * (this.state.size || 1);
      if (this.state.y < minY) this.state.y = minY;
    }

    this.syncModel();
    // 行走动画由主循环里的 tickPlayerModels(dt) 统一驱动：
    // 那里按「模型帧间位移」算速度，本机与远端走同一套，避免两处各写一份速度滤波。
  }
}