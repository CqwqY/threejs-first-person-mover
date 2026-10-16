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
    this._maxReconnect = 5; // 最多重试次数（5 次全失败即判定「网络错误」）
    this._reconnectDelay = 2000; // 重连起始间隔（毫秒），之后指数退避
    this._reconnectMaxDelay = 8000; // 退避上限
    this._reconnectTimer = null;   // 待执行的重连定时器（失败判定/手动重试时要能取消）

    // 连接状态机：'connecting' | 'open' | 'reconnecting' | 'failed'
    // 传给 UI 的语义：
    //   connecting   首次连接中（开局，还没成功过）
    //   open         已连上（正常游玩）
    //   reconnecting 掉线后正在重连（attempt: 第几次 / max: 总次数）
    //   failed       重连 5 次都失败 —— 已脱机，需要提示「网络错误」并提供手动重试
    this._status = 'connecting';
    this._statusHandlers = [];
    this._everOpened = false; // 是否成功连上过（用于区分「首次连接」与「断线重连」）

    // 状态上报节流
    this._pendingState = null; // 待发送的最新状态
    this._pendingVeh = null;   // 待发送的后座乘客位置（仅驾驶员上报）
    this._sendInterval = null; // 20Hz 发送定时器
    this._sendRate = 20; // 上报频率（Hz）
    this._stateMuted = false; // true = 暂停上报自身位置（训练场本机兜底用）
  }

  // 当前连接状态（供 UI 主动查询）
  get status() { return this._status; }
  get reconnectAttempts() { return this._reconnectAttempts; }
  get maxReconnect() { return this._maxReconnect; }

  // 注册连接状态回调：cb(status, info)
  //   info = { attempt, max } —— 仅在 reconnecting / failed 时有意义
  onStatus(cb) {
    if (typeof cb !== 'function') return;
    this._statusHandlers.push(cb);
    // 注册即回报一次当前状态，避免 UI 错过之前的变化
    try { cb(this._status, this._statusInfo()); } catch { /* 隔离单个回调的异常 */ }
  }

  _statusInfo() {
    return { attempt: this._reconnectAttempts, max: this._maxReconnect };
  }

  _setStatus(s) {
    if (this._status === s) return;
    this._status = s;
    const info = this._statusInfo();
    for (const cb of this._statusHandlers) {
      try { cb(s, info); } catch { /* 隔离单个回调的异常，别让 UI 报错打断网络层 */ }
    }
  }

  // 建立连接并绑定事件
  connect() {
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    // 首次连接与断线重连对外状态不同：重连时 UI 要显示「重连中 (n/5)」
    this._setStatus(this._everOpened || this._reconnectAttempts > 0 ? 'reconnecting' : 'connecting');

    try {
      this.ws = new WebSocket(this.url);
    } catch (e) {
      // 构造 WebSocket 就抛（URL 非法等）：走统一的失败路径，别让异常冒出去
      this.ws = null;
      this._scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      // 连接成功：重置重试计数
      const wasReconnect = this._everOpened;
      this._reconnectAttempts = 0;
      this._everOpened = true;
      // ⚠ 先记标志再切状态 —— 状态回调里要立刻读它来区分「首次连上」与「重连恢复」
      this._lastOpenWasReconnect = wasReconnect;
      this._setStatus('open');
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
      try { this.ws.close(); } catch { /* 已关闭则忽略 */ }
    };
  }

  // 断线后按间隔重连；指数退避；超过最大次数则标记 failed（不静默放弃）
  _scheduleReconnect() {
    if (this._status === 'failed') return; // 已是终态，等手动 retry
    if (this._reconnectAttempts >= this._maxReconnect) {
      // 5 次都失败：判定「网络错误」，通知 UI 并停止自动重连
      this._setStatus('failed');
      return;
    }
    this._reconnectAttempts++;
    this._setStatus('reconnecting');
    // 指数退避：2s → 4s → 8s → 8s → 8s（上限 8s）
    const delay = Math.min(this._reconnectDelay * Math.pow(2, this._reconnectAttempts - 1), this._reconnectMaxDelay);
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, delay);
  }

  // 手动重试（UI 上「网络错误」面板里的按钮）：清零计数，重新开始连
  retryNow() {
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this._reconnectAttempts = 0;
    this.connect();
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

  // 邀请传送：请 target 传送到我这里。带上**我此刻的坐标**（他要落在这儿），
  // 服务器只做转发与钳制 —— 真正瞬移由对方客户端执行。
  sendTpInvite(target, x, y, z) {
    if (!target) return;
    this.send({ t: 'tp_invite', target, x, y, z });
  }

  // 回复别人的传送邀请：ok=true 同意（我这就传送过去）/ false 拒绝。
  // target 指向**发起邀请的人**（与 ctrl 的「挣脱时 target 指回控制器」同一套约定）。
  sendTpReply(target, ok) {
    if (!target) return;
    this.send({ t: 'tp_reply', target, ok: ok ? 1 : 0 });
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

  // sendBuildMove 发 {id, x,y,z,rotY,scale}：仅能移动自己摆的家具（服务端校验 owner）
  sendBuildMove(info) {
    if (!info || !info.id) return;
    const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
    this.send({
      t: 'build_move',
      id: String(info.id).slice(0, 48),
      x: num(info.x, 0), y: num(info.y, 0), z: num(info.z, 0),
      rotY: num(info.rotY, 0), scale: num(info.scale, 1),
    });
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