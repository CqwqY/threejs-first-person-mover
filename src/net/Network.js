// 职责：封装原生 WebSocket 客户端：连接、断线重连、消息注册与状态上报节流。
import { Config } from '../config.js';
import { PeerMesh } from './PeerMesh.js';

// 公共 STUN 服务器：2026-11-07 在源站（广东移动）用真实 Binding 请求逐个实测，按延迟排序。
// 实测通过：斗鱼 17ms / 湖南卫视 25ms / 华为云 40ms / B站 52ms / 小米 82ms / Cloudflare 184ms。
// 实测失败：腾讯 stun.qq.com 不回包；阿里云/腾讯云/百度/网易/抖音/360 的 stun 域名**根本不存在**。
// ⚠ STUN 只做 NAT 打洞（发现公网映射），不转发数据，救不了对称 NAT / CGNAT —— 那种情况必须 TURN。
const STUN_SERVERS = [
  'stun:stun.douyucdn.cn:18000',
  'stun:stun.hitv.com:3478',
  'stun:124.70.180.79:3478',
  'stun:stun.chat.bilibili.com:3478',
  'stun:stun.miwifi.com:3478',
  'stun:stun.cloudflare.com:3478',
];

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

    // WebRTC 直连状态：wss 连上后尝试建 DataChannel(UDP) 直连源站，绕开 CF 降延迟。
    // 失败 / 超时 / 不支持：静默回落 wss（绝不比现在更差）。
    this._transport = 'wss';          // 'wss' | 'webrtc'，供 UI / 调试查询
    this._rtc = { pc: null, dc: null, open: false, timer: null, early: [], remoteDescribed: false };
    this._stunRanked = null;          // 实测延迟后按快慢排序的 STUN 服务器 URL 列表

    // 玩家↔玩家 P2P 网格（**默认关闭**；?p2p=1 才启用）。
    // 实测：玩家↔玩家在对称 NAT 下打洞失败；但「客户端↔源站」直连是通的（服务端日志有 DataChannel 已打开）。
    // 所以主力走客户端↔源站直连，P2P 网格只作实验开关。
    const q = typeof location !== 'undefined' ? location.search : '';
    this._p2pEnabled = /(?:^|[?&])p2p=1(?:&|$)/.test(q);
    if (!this._p2pEnabled) this._rankStun(); // 主力路径需要 STUN 排序

    // 延迟测量（应用层 ping/pong，走当前数据通道）
    this._rtt = 0;
    this._lastPingSent = 0;
    this._selfId = '';
    this._meshHandlers = {};
    this._mesh = null;
    // ICE 服务器：STUN 列表 + 可选 TURN（URL 参数 ?turn=turn:host:port&turnuser=..&turnpass=..）
    const iceServers = STUN_SERVERS.map((u) => ({ urls: u }));
    try {
      if (typeof location !== 'undefined') {
        const sp = new URLSearchParams(location.search);
        const turnUrl = sp.get('turn');
        if (turnUrl === 'openrelay') {
          // 公共 TURN 预设（metered.ca openrelay，免费/尽力而为）——仅用于快速验证「是不是 NAT 打不通」。
          // ⚠ 数据会经第三方中继转发，确认是 NAT 问题后应换成自己的 coturn。
          const u = 'openrelayproject';
          iceServers.push(
            { urls: 'turn:openrelay.metered.ca:80', username: u, credential: u },
            { urls: 'turn:openrelay.metered.ca:443', username: u, credential: u },
            { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: u, credential: u }
          );
        } else if (turnUrl) {
          const s = { urls: turnUrl };
          const tu = sp.get('turnuser'); const tp = sp.get('turnpass');
          if (tu) s.username = tu;
          if (tp) s.credential = tp;
          iceServers.push(s);
        }
      }
    } catch { /* URLSearchParams 不可用则忽略 */ }
    if (this._p2pEnabled && typeof RTCPeerConnection !== 'undefined') {
      this._mesh = new PeerMesh({
        iceServers,
        maxDirect: 12,
        sendSignal: (to, data) => this.send({ t: 'signal', to, data }),
        onOpen: (id) => { if (this._meshHandlers.onOpen) this._meshHandlers.onOpen(id); },
        onClose: (id) => { if (this._meshHandlers.onClose) this._meshHandlers.onClose(id); },
        onState: (id, st) => { if (this._meshHandlers.onState) this._meshHandlers.onState(id, st); },
      });
    }
    // 无条件启动日志：任何一次进游戏都能看到网格到底有没有起来（排查「没有任何输出」用）。
    // 资源名带内容哈希，两端必须一致；不一致 = 有一端还是旧缓存。
    this._assetTag = 'dev';
    let asset = '';
    try {
      const s = typeof document !== 'undefined' ? document.querySelector('script[type="module"]') : null;
      if (s && s.src) {
        asset = s.src.split('/').pop();
        const m = asset.match(/-([A-Za-z0-9_-]{4,})\.js$/);
        this._assetTag = m ? m[1].slice(-6) : asset.slice(-8);
      }
    } catch { /* 忽略 */ }
    console.log('[p2p] 构建标记', {
      启用: this._p2pEnabled,
      有WebRTC: typeof RTCPeerConnection !== 'undefined',
      网格: !!this._mesh,
      资源: asset,
    });
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
    // 重连时先关掉上一次的直连资源，避免 PC/DC 泄漏；再复位状态机
    if (this._rtc.pc) { try { this._rtc.pc.close(); } catch {} }
    if (this._rtc.dc) { try { this._rtc.dc.close(); } catch {} }
    if (this._rtc.timer) { clearTimeout(this._rtc.timer); }
    this._rtc = { pc: null, dc: null, open: false, timer: null, early: [], remoteDescribed: false };
    this._transport = 'wss';
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
      // wss 已通：同时尝试「客户端↔源站」直连。源站有公网 IPv6，同局域网也走 host 候选，
      // 成功后上行全部走 UDP、绕开 Cloudflare；失败自动回落 wss，不影响现有功能。
      this._startWebRtc();
    };

    this.ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      // 延迟测量：pong 回填 RTT；收到 ping 就回 pong（服务端/对端都可能发）
      if (msg.t === 'pong') { this._onPong(msg); return; }
      if (msg.t === 'ping') { this.send({ t: 'pong', c: msg.c }); return; }
      // 信令投递回执：服务端明确告知 offer/answer 有没有送达对面
      if (msg.t === 'signal_ack') {
        console.log('[p2p] 信令投递' + (msg.ok ? '成功（对端在线）' : '失败（对端不在线）') + ' → ' + msg.to + ' [' + (msg.kind || '') + ']');
        return;
      }
      // 玩家网格信令（offer/answer/ICE）：交给 PeerMesh，不能当游戏消息分发
      if (msg.t === 'signal') { if (this._mesh) this._mesh.handleSignal(msg); return; }
      // WebRTC 直连信令：rtc_answer / rtc_ice 是握手用的，不能当游戏消息分发。
      // rtc_up 是服务器确认直连已开的回执，客户端无需处理。
      if (msg.t === 'rtc_answer') { this._onRtcAnswer(msg); return; }
      if (msg.t === 'rtc_ice') { this._onRtcIce(msg); return; }
      if (msg.t === 'rtc_up') { return; }
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

  // 发送 JSON 消息；未连接时静默丢弃。
  // 双通道：DataChannel(UDP 直连) 开好后优先走它（绕开 CF），否则走 wss(TCP)。
  send(msg) {
    const json = JSON.stringify(msg);
    if (this._rtc && this._rtc.open && this._rtc.dc && this._rtc.dc.readyState === 'open') {
      try { this._rtc.dc.send(json); return; } catch { /* 直连发送失败，落到下面走 wss */ }
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(json);
    }
  }

  // 注册消息回调
  onMessage(callback) {
    this._handlers.push(callback);
  }

  // 当前数据通道：'wss'（CF 代理 TCP）或 'webrtc'（直连 UDP）。供 UI / 调试显示。
  get transport() { return this._transport || 'wss'; }

  // 当前链路延迟（ms）：有 P2P 直连就用直连里最小的那个，否则用服务器 RTT。
  get rttMs() {
    const peer = this._mesh ? this._mesh.minRtt() : 0;
    return Math.round(peer || this._rtt) || 0;
  }

  // 当前直连玩家数（0 = 全部走服务器快照）
  get directLinks() { return this._mesh ? this._mesh.directCount() : 0; }

  // 同场玩家数（不含自己），HUD 用「直连N/总数」
  get peerCount() { return this._mesh ? (this._mesh.scopeSize || 0) : 0; }

  // 连接方式标签：直连N / wss
  netModeLabel() {
    const d = this.directLinks;
    if (d > 0) return '直连' + d;
    if (this._transport === 'webrtc') return '直连';
    return 'wss';
  }

  // 注册玩家网格回调：onOpen(id) / onClose(id) / onState(id, state)
  setMeshHandlers(h) {
    this._meshHandlers = Object.assign(this._meshHandlers || {}, h || {});
  }

  // 是否启用了 P2P 网格（HUD 用来区分「没启用」与「启用了但没打通」）
  get p2pEnabled() { return !!this._p2pEnabled; }

  // 当前前端包的短标记（入口 JS 哈希后 6 位），HUD 显示，用于一眼对比两端版本
  get assetTag() { return this._assetTag || 'dev'; }

  // 告诉网格「我是谁」（收到 welcome 后调用）
  setSelfId(id) {
    this._selfId = String(id || '');
    if (this._mesh) this._mesh.setSelfId(this._selfId);
    console.log('[p2p] 我的 id = ' + this._selfId);
  }

  // 告诉网格「当前同场有哪些玩家」（每次快照调用；大厅/房间自动切换）
  setScope(ids) {
    if (this._mesh) this._mesh.setScope(ids);
  }

  // 当前有几条玩家直连（调试/UI 用）
  get directLinkCount() {
    if (!this._mesh) return 0;
    let n = 0;
    for (const p of this._mesh.peers.values()) if (p.direct) n++;
    return n;
  }

  // 尝试建立 WebRTC 直连：经现有 wss 交换信令，DataChannel(UDP) 通了就接管游戏数据。
  // 失败 / 超时 / 不支持：静默回落 wss（绝不比现在更差）。
  _startWebRtc() {
    if (typeof RTCPeerConnection === 'undefined') return; // 非浏览器或老浏览器：直接跳过
    let pc, dc;
    try {
      pc = new RTCPeerConnection({ iceServers: this._iceServers() });
      dc = pc.createDataChannel('game');
      this._rtc.pc = pc;
      this._rtc.dc = dc;
    } catch (e) {
      return; // 建连失败就算了，继续用 wss
    }

    dc.onopen = () => {
      this._rtc.open = true;
      this._transport = 'webrtc';
      console.log('[net] WebRTC 直连已建立，多人数据走 UDP 直连');
    };
    dc.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      // 直连上的游戏消息与 wss 走同一套分发，复用现有 _handlers
      for (const handler of this._handlers) {
        try { handler(msg); } catch { /* 隔离单条异常 */ }
      }
    };
    const gathered = [];
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        gathered.push(e.candidate);
        this.send({
          t: 'rtc_ice',
          cand: e.candidate.candidate,
          mid: e.candidate.sdpMid,
          idx: e.candidate.sdpMLineIndex,
          ufrag: e.candidate.usernameFragment,
        });
      }
    };
    // 诊断：收集完候选后汇总类型与地址族，直连失败时能看出「有没有 IPv6 候选」这个关键点
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState !== 'complete') return;
      const types = {};
      let hasV6 = false, hasV4 = false;
      for (const c of gathered) {
        const t = c.type || 'host';
        types[t] = (types[t] || 0) + 1;
        const addr = c.address || '';
        if (addr.indexOf(':') >= 0) hasV6 = true;
        else if (addr) hasV4 = true;
      }
      console.log('[net] ICE 候选汇总', { 类型: types, IPv4: hasV4, IPv6: hasV6 });
      if (!hasV6) console.warn('[net] 本端没有 IPv6 候选：源站只有公网 IPv6，直连大概率失败（会回落 wss）');
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'failed' || s === 'disconnected' || s === 'closed') {
        this._rtc.open = false;
        this._transport = 'wss';
        console.warn('[net] WebRTC 连接状态 = ' + s + '，已回落 wss');
      }
    };
    // ICE 一旦 failed 立刻短路：打不通的 NAT 再等也不会通，别让人对着「建立中」干等满 8 秒
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') {
        console.warn('[net] ICE failed，直连失败，回落 wss');
        this._rtc.open = false;
        this._transport = 'wss';
        if (this._rtc.timer) { clearTimeout(this._rtc.timer); this._rtc.timer = null; }
      }
    };

    // 超时回落：8s 内直连没开起来就放弃，继续用 wss
    this._rtc.timer = setTimeout(() => {
      if (!this._rtc.open) {
        console.log('[net] WebRTC 直连超时，回落 wss');
        try { if (pc) pc.close(); } catch {}
        this._rtc.pc = null;
        this._rtc.dc = null;
      }
    }, 12000);

    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => {
        const ld = pc.localDescription;
        this.send({ t: 'rtc_offer', sdp: ld.sdp, type: ld.type });
      })
      .catch(() => { /* 协商失败，回落 wss */ });
  }

  // 收到服务器回的 answer：把它的 SDP 设为本端远端描述，完成握手，再灌入早到的候选。
  _onRtcAnswer(msg) {
    const pc = this._rtc.pc;
    if (!pc) return;
    pc.setRemoteDescription({ type: msg.type, sdp: msg.sdp })
      .then(() => this._flushEarlyCandidates())
      .catch(() => {});
  }

  // 收到服务器的 ICE 候选。trickle 候选可能早于 answer 到达，此时 setRemoteDescription 还没跑，
  // 直接 addIceCandidate 会抛 InvalidStateError ── 先存起来，等远端描述落地再灌。
  _onRtcIce(msg) {
    const pc = this._rtc.pc;
    if (!pc) return;
    const cand = { candidate: msg.cand, sdpMid: msg.mid, sdpMLineIndex: msg.idx };
    if (!this._rtc.remoteDescribed) {
      this._rtc.early.push(cand);
      return;
    }
    pc.addIceCandidate(cand).catch(() => {});
  }

  // 收到 pong：用同一个时钟域里的发送时间戳算 RTT，EWMA 平滑，过滤脏值。
  _onPong(msg) {
    const c = Number(msg.c);
    if (!Number.isFinite(c)) return;
    const sample = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - c;
    if (sample < 0 || sample > 5000) return;
    this._rtt = this._rtt > 0 ? this._rtt * 0.8 + sample * 0.2 : sample;
  }

  // 远端描述落地后，把缓存里早到的候选一次性补进去。
  _flushEarlyCandidates() {
    const rtc = this._rtc;
    rtc.remoteDescribed = true;
    const pending = rtc.early;
    rtc.early = [];
    for (const c of pending) {
      try { if (rtc.pc) rtc.pc.addIceCandidate(c).catch(() => {}); } catch { /* 过期候选忽略 */ }
    }
  }

  // 给 RTCPeerConnection 用的 iceServers：有实测排序就取最快的几个，否则用全量列表（ICE 内部会并发赛跑）。
  _iceServers() {
    const list = (this._stunRanked && this._stunRanked.length ? this._stunRanked : STUN_SERVERS).slice(0, 3);
    return list.map((u) => ({ urls: u }));
  }

  // 实测各 STUN 的往返延迟（以收到 srflx 候选为准），排序后缓存进 sessionStorage。
  // 后台运行，不阻塞首次连接；首次连接直接用全量列表，ICE 会自然选最快响应的那个。
  async _rankStun() {
    if (typeof RTCPeerConnection === 'undefined') return;
    if (this._stunRanked) return;
    // 命中会话缓存：10 分钟内不重复测
    try {
      const raw = sessionStorage.getItem('fpm_stun_rank');
      if (raw) {
        const c = JSON.parse(raw);
        if (c && c.ts && Date.now() - c.ts < 600000 && Array.isArray(c.list) && c.list.length) {
          this._stunRanked = c.list;
          console.log('[net] STUN 延迟排序（缓存）', c.list);
          return;
        }
      }
    } catch { /* sessionStorage 不可用则忽略，继续实测 */ }

    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const probeOne = (url) => new Promise((resolve) => {
      let pc;
      try { pc = new RTCPeerConnection({ iceServers: [{ urls: url }] }); }
      catch { resolve({ url, ms: Infinity }); return; }
      let done = false;
      const t0 = now();
      const finish = (ms) => {
        if (done) return;
        done = true;
        try { pc.close(); } catch { /* 忽略 */ }
        resolve({ url, ms });
      };
      pc.onicecandidate = (e) => {
        if (e.candidate && e.candidate.type === 'srflx') finish(now() - t0);
      };
      setTimeout(() => finish(Infinity), 2200);
      try {
        pc.createDataChannel('probe');
        pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => finish(Infinity));
      } catch { finish(Infinity); }
    });

    const results = await Promise.all(STUN_SERVERS.map(probeOne));
    const ok = results.filter((r) => Number.isFinite(r.ms)).sort((a, b) => a.ms - b.ms);
    if (ok.length) {
      this._stunRanked = ok.map((r) => r.url);
      console.log('[net] STUN 延迟排序（实测，ms）', ok.map((r) => r.url.replace('stun:', '') + '=' + Math.round(r.ms)));
      try { sessionStorage.setItem('fpm_stun_rank', JSON.stringify({ ts: Date.now(), list: this._stunRanked })); } catch { /* 忽略 */ }
    } else {
      console.warn('[net] 所有 STUN 均未返回 srflx（网络屏蔽，或纯 IPv4 客户端对只有公网 IPv6 的源站）');
    }
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

  // 物理可交互物：spawn / hit / state / gone。
  // 服务器不模拟，只钳数值后房间内转发（与 drop / meteor 同一套契约）。
  sendProp(ev, info) {
    if (!ev || !info || !info.id) return;
    this.send({
      t: 'prop',
      ev,
      id: info.id,
      kind: info.kind,
      x: info.x, y: info.y, z: info.z,
      vx: info.vx, vy: info.vy, vz: info.vz,
    });
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
        // P2P 直连固定 20Hz 广播：保证对端的到达间隔稳定。若像服务器那样静止降到 5Hz，
        // 对端会把 200ms 间隔误判成抖动、把插值缓冲撑大，画面重新变黏。
        if (this._mesh) this._mesh.broadcastState(st);
      }
      this._pendingState = null;
    }
    if (this._pendingVeh) {
      this.send({ t: 'veh', ...this._pendingVeh });
      this._pendingVeh = null;
    }
    // 应用层测延迟：约 1s 一次，走当前数据通道（P2P 直连或 wss）
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (now - this._lastPingSent > 1000) {
      this._lastPingSent = now;
      this.send({ t: 'ping', c: now });
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
    if ((st.tp | 0) !== (p.tp | 0)) return true;   // 瞬移序号变了必须立刻发，别等静止保活包
    if ((st.mt || '') !== (p.mt || '')) return true; // 挂载/解绑也要立刻发
    return false;
  }

  _copyState(st) {
    return {
      x: st.x || 0, y: st.y || 0, z: st.z || 0, yaw: st.yaw || 0,
      size: st.size, health: st.health, hold: st.hold, wep: st.wep, ride: st.ride, veh: st.veh,
      tp: st.tp, mt: st.mt,
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