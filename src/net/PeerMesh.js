// 职责：玩家↔玩家 P2P 网格。每个玩家与其他玩家建 WebRTC DataChannel 直连，绕开经 Cloudflare 的
// wss 中继，只搬运「高频移动状态」；聊天/商店/建造/道具/匹配仍走服务器。
//
// 设计要点：
//   1) 逐对混合：打不通的那一对自动回落到服务器快照（playerManager.applySnapshot），绝不更差。
//   2) 信令复用现有 wss：offer/answer/ICE 以 {t:'signal', to, data} 发给服务器，服务器原样转给目标。
//   3) 谁发起：约定「id 较小的一方发起」，天然避免双方同时 offer 的 glare。
//   4) 状态通道用 unordered + maxRetransmits:0：丢一帧就是一帧，后一帧照常到，不出现 TCP 队头阻塞。
//
// 本文件不引用 Three.js，纯浏览器 API；在非浏览器环境下由调用方保证不实例化。

const OPEN_TIMEOUT = 8000; // 单对建连超时：打不通就回落服务器，别无限等

export class PeerMesh {
  // opts: { iceServers, sendSignal(to,data), onOpen(id), onClose(id), onState(id,data), maxDirect }
  constructor(opts) {
    this.selfId = '';
    this.maxDirect = opts.maxDirect || 12;
    this.iceServers = opts.iceServers || [];
    this.sendSignal = opts.sendSignal;
    this.onOpen = opts.onOpen;
    this.onClose = opts.onClose;
    this.onState = opts.onState;
    this.peers = new Map(); // peerId -> { pc, dc, direct, early, remoteDescribed, timer }
  }

  setSelfId(id) {
    this.selfId = String(id || '');
  }

  // 由服务端快照推导「同场玩家」集合（大厅或房间都适用）：新增的去连，消失的拆除。
  setScope(ids) {
    if (!Array.isArray(ids)) return;
    const scope = new Set();
    for (const raw of ids) {
      const id = String(raw || '');
      if (id && id !== this.selfId) scope.add(id);
    }
    // 离开同场的：拆掉直连，回落服务器快照
    for (const id of [...this.peers.keys()]) {
      if (!scope.has(id)) this.removePeer(id);
    }
    this.scopeSize = scope.size; // 同场人数（HUD 显示「直连N/总人数」用）
    if (!this.selfId) return;
    // 新增的：id 较小的一方主动发起；另一方先占位等对方 offer
    for (const id of scope) {
      if (this.peers.has(id)) continue;
      if (this._busyCount() >= this.maxDirect) break; // 达到直连上限，其余走服务器
      if (this.selfId < id) {
        this._startOffer(id).catch(() => {});
      } else {
        this._ensurePeer(id);
      }
    }
  }

  // 已经建了 PC（连接中或已直连）的数量，用于直连上限
  _busyCount() {
    let n = 0;
    for (const p of this.peers.values()) if (p.pc) n++;
    return n;
  }

  _ensurePeer(peerId) {
    let p = this.peers.get(peerId);
    if (!p) {
      p = { pc: null, dc: null, direct: false, early: [], remoteDescribed: false, timer: null, rtt: 0, sentOffer: false, gotSignal: false, gathered: [] };
      this.peers.set(peerId, p);
    }
    return p;
  }

  _ensurePc(peerId) {
    const p = this._ensurePeer(peerId);
    if (p.pc) return p;
    if (typeof RTCPeerConnection === 'undefined') return p;
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    p.pc = pc;
    p.gathered = [];
    p.sentOffer = false;
    p.gotSignal = false;
    p.remoteDescribed = false;
    p.early = [];

    pc.onicecandidate = (e) => {
      if (!e.candidate || !e.candidate.candidate) return;
      p.gathered.push(e.candidate);
      this.sendSignal(peerId, {
        kind: 'ice',
        candidate: {
          candidate: e.candidate.candidate,
          sdpMid: e.candidate.sdpMid,
          sdpMLineIndex: e.candidate.sdpMLineIndex,
          usernameFragment: e.candidate.usernameFragment,
        },
      });
    };
    // 诊断：候选收集完，汇总类型与地址族。没有 srflx/relay 且没有 IPv6 ⇒ 蜂窝 CGNAT 打不通
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState !== 'complete') return;
      let v4 = 0; let v6 = 0; let srflx = 0;
      for (const c of p.gathered) {
        if (c.type === 'srflx' || c.type === 'relay') srflx++;
        const a = c.address || '';
        if (a.indexOf(':') >= 0) v6++; else if (a) v4++;
      }
      console.log('[p2p] 本端候选 → ' + peerId, { 数量: p.gathered.length, srflx, IPv4: v4, IPv6: v6 });
    };
    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      if (s === 'failed') {
        console.warn('[p2p] ICE failed → ' + peerId + '（两端网络无法互通，回落服务器）');
        this._downgrade(peerId);
      } else if (s === 'connected' || s === 'completed') {
        console.log('[p2p] ICE ' + s + ' → ' + peerId);
      }
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'failed' || s === 'disconnected' || s === 'closed') this._downgrade(peerId);
    };
    // 被动方：对方建好 data channel 后从这里拿到
    pc.ondatachannel = (ev) => {
      if (ev.channel && ev.channel.label === 'state') this._attach(peerId, ev.channel);
    };
    return p;
  }

  async _startOffer(peerId) {
    const p = this._ensurePc(peerId);
    if (!p.pc) return;
    const dc = p.pc.createDataChannel('state', { ordered: false, maxRetransmits: 0 });
    this._attach(peerId, dc);
    const offer = await p.pc.createOffer();
    await p.pc.setLocalDescription(offer);
    p.sentOffer = true;
    console.log('[p2p] 已发 offer → ' + peerId);
    this.sendSignal(peerId, { kind: 'offer', sdp: offer.sdp || '' });
  }

  // 处理服务器转来的对方信令（offer / answer / ICE）
  handleSignal(msg) {
    const peerId = String((msg && msg.from) || '');
    const data = msg && msg.data;
    if (!peerId || peerId === this.selfId || !data) return;
    const p = this._ensurePc(peerId);
    if (!p.pc) return;
    p.gotSignal = true;
    (async () => {
      if (data.kind === 'offer') {
        console.log('[p2p] 收到 offer ← ' + peerId + '，回 answer');
        await p.pc.setRemoteDescription({ type: 'offer', sdp: data.sdp || '' });
        this._flushEarly(peerId);
        const ans = await p.pc.createAnswer();
        await p.pc.setLocalDescription(ans);
        this.sendSignal(peerId, { kind: 'answer', sdp: ans.sdp || '' });
      } else if (data.kind === 'answer') {
        console.log('[p2p] 收到 answer ← ' + peerId);
        await p.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp || '' });
        this._flushEarly(peerId);
      } else if (data.kind === 'ice' && data.candidate) {
        // 早于 answer 到达的候选先存着，等远端描述落地再灌（否则 InvalidStateError）
        if (!p.remoteDescribed) { p.early.push(data.candidate); return; }
        try { await p.pc.addIceCandidate(data.candidate); } catch { /* 过期候选忽略 */ }
      }
    })().catch(() => { /* 单条信令失败不判死整条连接 */ });
  }

  _flushEarly(peerId) {
    const p = this.peers.get(peerId);
    if (!p || !p.pc) return;
    p.remoteDescribed = true;
    const pending = p.early;
    p.early = [];
    for (const c of pending) {
      try { p.pc.addIceCandidate(c).catch(() => {}); } catch { /* 忽略 */ }
    }
  }

  _attach(peerId, dc) {
    const p = this._ensurePeer(peerId);
    p.dc = dc;
    dc.onopen = () => {
      if (p.timer) { clearTimeout(p.timer); p.timer = null; }
      if (p.direct) return;
      p.direct = true;
      console.log('[p2p] 直连建立 → ' + peerId);
      if (this.onOpen) this.onOpen(peerId);
    };
    dc.onclose = () => { this._downgrade(peerId); };
    dc.onmessage = (e) => {
      let st;
      try { st = JSON.parse(e.data); } catch { return; }
      if (!st) return;
      // 延迟探针：_p = 对方发来的时间戳（回 _q）；_q = 对方对我 _p 的回执（算 RTT）
      if (st._p !== undefined) {
        try { if (p.dc && p.dc.readyState === 'open') p.dc.send(JSON.stringify({ _q: st._p })); } catch { /* 忽略 */ }
        return;
      }
      if (st._q !== undefined) {
        const sample = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - Number(st._q);
        if (Number.isFinite(sample) && sample >= 0 && sample < 5000) {
          p.rtt = p.rtt > 0 ? p.rtt * 0.8 + sample * 0.2 : sample;
        }
        return;
      }
      if (this.onState) this.onState(peerId, st);
    };
    // 超时兜底：DC 迟迟不开就拆掉，回归服务器快照
    if (!p.timer) {
      p.timer = setTimeout(() => {
        p.timer = null;
        if (p.direct) return;
        const why = (p.sentOffer ? '已发 offer' : '未发 offer') + (p.gotSignal ? '，收到过对端信令' : '，未收到对端任何信令');
        console.warn('[p2p] 直连超时 → ' + peerId + '（' + why + '），回落服务器');
        this._downgrade(peerId);
      }, OPEN_TIMEOUT);
    }
  }

  // 把本端状态广播给所有已直连的玩家（未直连的那部分仍由服务器快照负责）
  broadcastState(st) {
    if (!this.peers.size) return;
    let json;
    try { json = JSON.stringify(st); } catch { return; }
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const ping = now - (this._lastPing || 0) > 1000;
    if (ping) this._lastPing = now;
    for (const p of this.peers.values()) {
      if (p.direct && p.dc && p.dc.readyState === 'open') {
        try { p.dc.send(json); } catch { /* 单条发送失败忽略 */ }
        // 每 1s 发一个测延迟探针（复用 state 通道，用保留键 _p 区分）
        if (ping) { try { p.dc.send(JSON.stringify({ _p: now })); } catch { /* 忽略 */ } }
      }
    }
  }

  // 当前直连玩家数
  directCount() {
    let n = 0;
    for (const p of this.peers.values()) if (p.direct) n++;
    return n;
  }

  // 直连里最小的 RTT（ms）；尚未测出返回 0
  minRtt() {
    let m = 0;
    for (const p of this.peers.values()) {
      if (p.direct && p.rtt > 0) m = m > 0 ? Math.min(m, p.rtt) : p.rtt;
    }
    return m;
  }

  _downgrade(peerId) {
    const p = this.peers.get(peerId);
    if (!p) return;
    if (p.timer) { clearTimeout(p.timer); p.timer = null; }
    if (p.direct) {
      p.direct = false;
      console.warn('[p2p] 直连断开，该玩家回落服务器快照 → ' + peerId);
      if (this.onClose) this.onClose(peerId);
    }
    try { if (p.dc) p.dc.close(); } catch { /* 忽略 */ }
    try { if (p.pc) p.pc.close(); } catch { /* 忽略 */ }
    p.pc = null;
    p.dc = null;
    p.early = [];
    p.remoteDescribed = false;
    p.gathered = [];
    p.sentOffer = false;
    p.gotSignal = false;
    p.rtt = 0;
  }

  removePeer(peerId) {
    this._downgrade(peerId);
    this.peers.delete(peerId);
  }
}
