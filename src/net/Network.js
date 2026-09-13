// 职责：封装原生 WebSocket 客户端：连接、断线重连、消息注册与状态上报节流。
import { Config } from '../config.js';

export class Network {
  constructor(url) {
    this.url = url;
    this.ws = null;

    // 消息回调列表
    this._handlers = [];
    // 重连状态
    this._reconnectAttempts = 0;
    this._maxReconnect = 5; // 最多重试次数
    this._reconnectDelay = 2000; // 重连间隔（毫秒）

    // 状态上报节流
    this._pendingState = null; // 待发送的最新状态
    this._sendInterval = null; // 20Hz 发送定时器
    this._sendRate = 20; // 上报频率（Hz）
  }

  // 建立连接并绑定事件
  connect() {
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      // 连接成功：重置重试计数
      this._reconnectAttempts = 0;
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

  // 节流上报状态：在 20Hz 周期内只发送最新的一次 {t:"state", ...state}
  sendState(state) {
    this._pendingState = state;
    if (this._sendInterval) return; // 定时器已启动

    this._sendInterval = setInterval(() => {
      if (this._pendingState) {
        this.send({ t: 'state', ...this._pendingState });
        this._pendingState = null;
      }
    }, 1000 / this._sendRate);
  }
}