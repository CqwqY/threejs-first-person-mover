// 职责：封装原生 WebSocket 客户端：连接、断线重连、消息注册与状态上报节流。
import { Config } from '../config.js';

export class Network {
  constructor(url, token) {
    this.url = url;
    this.token = token || ''; // 登录会话 token；空串表示游客
    this.ws = null;

    // 消息回调列表
    this._handlers = [];
    // 重连状态
    this._reconnectAttempts = 0;
    this._maxReconnect = 5; // 最多重试次数
    this._reconnectDelay = 2000; // 重连间隔（毫秒）

    // 状态上报节流
    this._pendingState = null; // 待发送的最新状态
    this._pendingVeh = null;   // 待发送的后座乘客位置（仅驾驶员上报）
    this._sendInterval = null; // 20Hz 发送定时器
    this._sendRate = 20; // 上报频率（Hz）
    this._stateMuted = false; // true = 暂停上报自身位置（训练场本机兜底用）
  }

  // 建立连接并绑定事件
  connect() {
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      // 连接成功：重置重试计数
      this._reconnectAttempts = 0;
      // 连接握手：携带 token 登录；游客 token 为空不发送，服务端按未登录处理
      if (this.token) {
        this.send({ t: 'auth', token: this.token });
      }
    };

    this.ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      for (const handler of this._handlers) {
        handler(msg);
      }
    };

    this.ws.onclose = () => {
      this._scheduleReconnect();
    };

    this.ws.onerror = () => {
      // 触发 onclose 统一处理重连，这里直接关闭
      this.ws.close();
    };
  }

  // 断线后按间隔重连，超过最大次数则放弃
  _scheduleReconnect() {
    if (this._reconnectAttempts >= this._maxReconnect) return;
    this._reconnectAttempts++;
    setTimeout(() => this.connect(), this._reconnectDelay);
  }

  // 发送 JSON 消息；未连接时静默丢弃
  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  // 注册消息回调
  onMessage(callback) {
    this._handlers.push(callback);
  }

  // 命中上报：把自己的投掷伤害告诉服务器，由服务器转发给被命中的玩家扣血
  sendHit(target, damage) {
    if (!target) return;
    this.send({ t: 'hit', target, damage });
  }

  // 范围效果上报：把投掷物附带的范围增益发给服务器，转发给被覆盖的玩家
  sendFx(target, effect) {
    if (!target || !effect) return;
    this.send({ t: 'fx', target, effect });
  }

  // 黑洞：投掷者先把飞行模拟完，落地后再广播落点，其他人在同一位置生成同一个黑洞
  sendBlackHole(x, z) {
    this.send({ t: 'bh', x, z });
  }

  // 捉迷藏：开始 / 方向提示 / 结束，广播给所有人（只有相关的人会响应）
  sendHide(info) {
    if (!info || !info.ev) return;
    this.send({ t: 'hide', ...info });
  }

  // 击飞上报：被棍子扫到的玩家由服务器转发一条击飞冲量，由他自己客户端施加
  sendKnock(target, kx, ky, kz) {
    if (!target) return;
    this.send({ t: 'knock', target, kx, ky, kz });
  }

  // 控制枪：控制器把「吊住点」同步给被控者，或单方面宣布松开；
  // 被控者挣脱时也用同一条消息（target 指向控制器）回报，让控制器知道该收枪。
  sendCtrl(target, on, x, y, z) {
    if (!target) return;
    this.send({ t: 'ctrl', target, on: on ? 1 : 0, x, y, z });
  }

  // 匹配：请求进入对战房间（mode 指定玩法：'meteor' 躲避陨石混战 / 'grapple' 疯狂抓钩）
  sendMatch(mode) {
    this.send({ t: 'match', mode: mode || 'meteor' });
  }

  // 训练场：请求立刻开一个单人房（不排队、不等别人）。
  // 走房间而不是本机离线开，是为了让快照按房间隔离：否则训练场里的坐标会广播进大厅。
  sendTrain(mode) {
    this.send({ t: 'train', mode: mode || 'meteor' });
  }

  // 阵亡广播：由阵亡者自己上报（他知道最后一击来自谁），用于全场统计击杀数
  sendDie(by) {
    this.send({ t: 'die', by: by || '' });
  }

  // 暂停/恢复自身状态上报。仅用于「老服务端不支持训练场」时的本机兜底：
  // 那时本机离线在竞技场里，若继续上报坐标，大厅的人会看到你在竞技场里飘。
  setStateMuted(on) {
    this._stateMuted = !!on;
    if (on) this._pendingState = null;
  }

  // 取消匹配：还在队列里时退出
  sendCancelMatch() {
    this.send({ t: 'cancel_match' });
  }

  // 退出对战房间：回到大厅
  sendLeaveRoom() {
    this.send({ t: 'leave_room' });
  }

  // 陨石生成广播（房主发出，其他客户端据此复刻同一颗陨石，保证全场看到一致的落点）
  sendMeteor(info) {
    if (!info) return;
    const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
    this.send({ t: 'meteor', x: num(info.x, 0), z: num(info.z, 0), vy: num(info.vy, -20), r: num(info.r, 1.5) });
  }

  // 投掷物出手广播：让其他玩家看到「有一颗东西飞过去」
  sendProj(info) {
    if (!info) return;
    this.send({ t: 'proj', ...info });
  }

  // 加特林开火广播：每发一条，让其他人在同一位置看到同一颗子弹飞出去。
  // 只带「起点 + 方向 + 飞多远」——命中判定是开火者本地算的，服务器不参与，
  // 别人那边纯粹是画面复刻（走得慢一点/快一点都不影响伤害）。
  sendShot(info) {
    if (!info) return;
    const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
    this.send({
      t: 'shot',
      x: num(info.x, 0), y: num(info.y, 0), z: num(info.z, 0),
      dx: num(info.dx, 0), dy: num(info.dy, 0), dz: num(info.dz, 0),
      d: num(info.d, 0), // 飞行距离（米）：撞墙/命中目标就到头
    });
  }

  // 抓钩广播：ev='on' 甩出钩爪（带锚点、出手点与本次时长）/ 'off' 收回。
  // 绳子靠各端自己画：一端跟着那个玩家的模型（位置本来就由快照同步），另一端是钩爪。
  sendGrapple(info) {
    if (!info || !info.ev) return;
    const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
    this.send({
      t: 'grapple',
      ev: info.ev === 'off' ? 'off' : 'on',
      x: num(info.x, 0), y: num(info.y, 0), z: num(info.z, 0),     // 锚点
      ox: num(info.ox, 0), oy: num(info.oy, 0), oz: num(info.oz, 0), // 出手点（钩爪从这里飞出去）
      dur: num(info.dur, 1),                                        // 本次抓钩最长持续（秒）
    });
  }

  // 丢弃物品广播：让同场所有人看到同一个物品以同样的物理掉在地上
  sendDrop(info) {
    if (!info || !info.item) return;
    this.send({
      t: 'drop',
      id: String(info.id || '').slice(0, 40),
      item: String(info.item).slice(0, 24),
      x: Number(info.x) || 0,
      y: Number(info.y) || 0,
      z: Number(info.z) || 0,
      vx: Number(info.vx) || 0,
      vy: Number(info.vy) || 0,
      vz: Number(info.vz) || 0,
    });
  }

  // 拾取掉落物广播：带上掉落物 id，让同场其他人把它从地上移除（物品只能被捡走一次）
  sendPickup(id) {
    if (!id) return;
    this.send({ t: 'pickup', id: String(id).slice(0, 40) });
  }

  // 聊天发言：只发文本，昵称/颜色由服务端按登录资料补齐（客户端无法冒充别人）。
  // 同房间（或同大厅）的其他人会收到 {t:'chat', id, nick, color, text}。
  sendChat(text) {
    const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!s) return;
    this.send({ t: 'chat', text: s });
  }

  // 金币生成广播（房主发出）：全场用同一坐标复现同一枚金币
  sendCoinSpawn(info) {
    if (!info || !info.id) return;
    const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
    this.send({
      t: 'coin_spawn',
      id: String(info.id).slice(0, 40),
      x: num(info.x, 0), y: num(info.y, 0), z: num(info.z, 0),
    });
  }

  // 吃掉金币广播：让同场其他人把这枚金币移除
  sendCoinTaken(id) {
    if (!id) return;
    this.send({ t: 'coin', id: String(id).slice(0, 40) });
  }

  // 爆炸广播：让其他玩家在同样的位置播爆炸特效
  sendBoom(info) {
    if (!info) return;
    this.send({ t: 'boom', ...info });
  }

  // Boss 事件广播：召唤 / 位姿 / 弹幕 / 伤害 / 死亡，由服务器转发给其他玩家
  sendBoss(info) {
    if (!info || !info.ev) return;
    this.send({ t: 'boss', ...info });
  }

  // 玩家建造（教学楼）：买来的楼才能摆。服务器校验 + 限流后回执/广播。
  // sendBuildAdd 发 {itemId, x,y,z,rotY,scale}；sendBuildDel 发 {id}（仅自己摆的能删）。
  sendBuildAdd(info) {
    if (!info || !info.itemId) return;
    const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
    this.send({
      t: 'build_add',
      itemId: String(info.itemId),
      x: num(info.x, 0), y: num(info.y, 0), z: num(info.z, 0),
      rotY: num(info.rotY, 0), scale: num(info.scale, 1),
    });
  }

  sendBuildDel(id) {
    if (!id) return;
    this.send({ t: 'build_del', id: String(id).slice(0, 48) });
  }

  // 驾驶员上报后座乘客位置：只有驾驶员发，乘客自己不再单独上报，
  // 否则两个冲量在不同客户端独立推进，乘客会相对车身乱抖。
  sendVehPax(pax, x, y, z, yaw) {
    if (!pax) return;
    this._pendingVeh = { pax, x, y, z, yaw };
    this._ensureSendLoop();
  }

  // 节流上报状态：在 20Hz 周期内只发送最新的一次 {t:"state", ...state}
  sendState(state) {
    this._pendingState = state;
    this._ensureSendLoop();
  }

  // 启动统一的 20Hz 发送器：同一拍内把「自身状态」与「后座乘客」一起发出去
  _ensureSendLoop() {
    if (this._sendInterval) return; // 定时器已启动
    this._sendInterval = setInterval(() => this._flush(), 1000 / this._sendRate);
  }

  // 每拍结算一次：
  // - 状态有明显变化（位移 >2cm 或 朝向 >1°，或血量/手持/载具/体型变了）→ 按 20Hz 全速发
  // - 长时间没变化 → 降到 5Hz（每 4 拍发一次）保活，大幅减少静止玩家的上行包
  _flush() {
    const st = this._pendingState;
    if (st) {
      // 被静音（训练场本机兜底）时不发，但要照常把待发状态清掉，免得恢复后补发一个过期位置
      if (!this._stateMuted) {
        if (this._stateChanged(st)) {
          this.send({ t: 'state', ...st });
          this._lastSent = this._copyState(st);
          this._staticTicks = 0;
        } else {
          this._staticTicks = (this._staticTicks || 0) + 1;
          if (this._staticTicks >= SEND_STATIC_DIV) {
            this.send({ t: 'state', ...st });
            this._staticTicks = 0;
          }
        }
      }
      this._pendingState = null;
    }
    if (this._pendingVeh) {
      this.send({ t: 'veh', ...this._pendingVeh });
      this._pendingVeh = null;
    }
  }

  // 与上一次实际发出的状态比较，判断是否值得占用一个上行包
  _stateChanged(st) {
    const p = this._lastSent;
    if (!p) return true;
    if (Math.abs((st.x || 0) - p.x) > SEND_MOVE_EPS) return true;
    if (Math.abs((st.y || 0) - p.y) > SEND_MOVE_EPS) return true;
    if (Math.abs((st.z || 0) - p.z) > SEND_MOVE_EPS) return true;
    if (_angleDiff(st.yaw, p.yaw) > SEND_YAW_EPS) return true;
    if ((st.size || 1) !== (p.size || 1)) return true;
    if ((st.health | 0) !== (p.health | 0)) return true;
    if ((st.hold || '') !== (p.hold || '')) return true;
    if ((st.wep || '') !== (p.wep || '')) return true;
    if ((st.ride | 0) !== (p.ride | 0)) return true;
    if ((st.veh || '') !== (p.veh || '')) return true;
    return false;
  }

  _copyState(st) {
    return {
      x: st.x || 0, y: st.y || 0, z: st.z || 0, yaw: st.yaw || 0,
      size: st.size, health: st.health, hold: st.hold, wep: st.wep, ride: st.ride, veh: st.veh,
    };
  }
}

// 静止降频：没变化时每 N 拍补发一次（20Hz / 4 = 5Hz），既省带宽又不至于被服务器判为掉线
const SEND_STATIC_DIV = 4;
// 变化阈值：位移超过 2cm 或 朝向超过 1° 才算「动了」
const SEND_MOVE_EPS = 0.02;
const SEND_YAW_EPS = Math.PI / 180;

// 两角度的最短弧差（绝对值，0~π）
function _angleDiff(a, b) {
  let d = (a || 0) - (b || 0);
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d);
}