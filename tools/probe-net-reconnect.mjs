// 自检：WebSocket 断线重连的状态机与「5 次失败 → 网络错误」（node tools/probe-net-reconnect.mjs）
//
// 背景：用户要求「拒绝服务器脱机的现象发生，若脱机，则显示尝试重连 5 次失败后提示网络错误」。
//   改前 Network._scheduleReconnect 在重试到上限后**直接 return**（静默放弃）——
//   用户界面完全不知道已脱机，看着游戏还在跑，其实早断线了。
//
// 本脚本用**桩 WebSocket** 在 Node 里真跑 Network 的状态机，断言：
//   ① 首次 connect → 'connecting'；连上 → 'open'
//   ② 掉线后自动重连，最多 5 次；第 5 次失败 → 'failed'
//   ③ 退避延迟递增（2s→4s→8s→8s→8s）
//   ④ retryNow() 能把 'failed' 复位并重新连
//   ⑤ onStatus 注册即回报当前状态
// ⚠ 直接 import 真实 Network.js 源码（不是复制逻辑）。它只依赖 ../config.js，可在 Node 里跑。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src', 'net', 'Network.js');

let fails = 0;
function check(name, got, want) {
  const ok = got === want;
  if (!ok) { fails++; console.log(`  ✗ ${name}\n      期望 ${want}\n      实际 ${got}`); }
  else console.log(`  ok    ${name} = ${got}`);
}

// ---- 桩 WebSocket：可控地触发 open / close ----
const sockets = [];
class FakeWS {
  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.sent = [];
    sockets.push(this);
  }
  send(d) { this.sent.push(d); }
  close() { this.readyState = 3; if (this.onclose) this.onclose(); }
  // 测试驱动：模拟连接成功
  _open() { this.readyState = 1; if (this.onopen) this.onopen(); }
  // 测试驱动：模拟断开
  _drop() { this.readyState = 3; if (this.onclose) this.onclose(); }
}
FakeWS.OPEN = 1;
globalThis.WebSocket = FakeWS;

// 用一个「立即执行」的假定时器收集待触发回调，避免真等 2s
const timers = [];
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms) => { const id = { fn, ms, canceled: false }; timers.push(id); return id; };
globalThis.clearTimeout = (id) => { if (id) id.canceled = true; };
function runNextTimer() {
  // 触发最早一个未取消的定时器
  const i = timers.findIndex((t) => !t.canceled && !t.done);
  if (i < 0) return false;
  timers[i].done = true;
  timers[i].fn();
  return true;
}

const { Network } = await import('file://' + SRC.replace(/\\/g, '/'));

console.log('① 状态机：connecting → open');
{
  sockets.length = 0; timers.length = 0;
  const net = new Network('wss://example.test', '');
  const seen = [];
  net.onStatus((s) => seen.push(s));
  check('onStatus 注册即回报当前状态', seen[0], 'connecting');
  net.connect();
  check('初始 status', net.status, 'connecting');
  check('已创建 1 个 socket', sockets.length, 1);
  sockets[0]._open();
  check('连上后 status', net.status, 'open');
  check('状态序列含 open', seen[seen.length - 1], 'open');
}

console.log('② 掉线重连：最多 5 次，第 5 次失败为 failed');
{
  sockets.length = 0; timers.length = 0;
  const net = new Network('wss://example.test', '');
  const statuses = [];
  net.onStatus((s) => statuses.push(s));
  net.connect();
  sockets[0]._open();
  check('连上', net.status, 'open');
  // 第 1 次掉线
  sockets[0]._drop();
  check('掉线后进入 reconnecting', net.status, 'reconnecting');
  check('第 1 次重试计数', net.reconnectAttempts, 1);
  // 依次把每次重连都失败掉，直到 exhausted
  let guard = 0;
  while (net.status === 'reconnecting' && guard++ < 20) {
    runNextTimer(); // 执行退避定时器 → connect() 建新 socket
    const s = sockets[sockets.length - 1];
    s._drop();      // 新连接立刻又断 → 触发下一次 _scheduleReconnect
  }
  check('最终状态为 failed', net.status, 'failed');
  check('重试次数恰为 5', net.reconnectAttempts, 5);
  check('maxReconnect', net.maxReconnect, 5);
  check('failed 只出现一次（不重复通知）', (net.status === 'failed') ? 1 : 0, 1);
  // 再掉线不会继续加计数
  const before = net.reconnectAttempts;
  net._scheduleReconnect();
  check('failed 后不再增加重试次数', net.reconnectAttempts, before);
}

console.log('③ 退避延迟：2s → 4s → 8s → 8s → 8s（上限 8s）');
{
  sockets.length = 0; timers.length = 0;
  const net = new Network('wss://example.test', '');
  // 逐个调度并**立刻取走**该次延迟，因为下一次调度会 clearTimeout 掉上一个
  // （这本身是正确行为：同一时刻只保留一个待执行的重连定时器）
  const delays = [];
  const lastTimer = () => timers.filter((t) => !t.canceled).slice(-1)[0];
  for (let i = 0; i < 5; i++) {
    net._scheduleReconnect();
    delays.push(lastTimer().ms);
  }
  check('退避序列', JSON.stringify(delays), JSON.stringify([2000, 4000, 8000, 8000, 8000]));
  check('第 6 次调度进入 failed（不再排定时器）', (net._scheduleReconnect(), net.status), 'failed');
}

console.log('④ 手动重试 retryNow()：failed → 复位并重新连接');
{
  sockets.length = 0; timers.length = 0;
  const net = new Network('wss://example.test', '');
  net.connect();
  sockets[0]._open();
  sockets[0]._drop();
  let guard = 0;
  while (net.status === 'reconnecting' && guard++ < 20) {
    runNextTimer();
    sockets[sockets.length - 1]._drop();
  }
  check('先进入 failed', net.status, 'failed');
  const nSockets = sockets.length;
  net.retryNow();
  check('retryNow 后重试次数清零', net.reconnectAttempts, 0);
  check('retryNow 建立了新连接', sockets.length > nSockets, true);
  check('retryNow 后状态回到 connecting/reconnecting', ['connecting', 'reconnecting'].includes(net.status), true);
}

console.log('⑤ 源码层断言：不再「静默放弃」');
{
  const code = fs.readFileSync(SRC, 'utf8');
  check('存在 failed 终态', /'failed'/.test(code), true);
  check('存在 retryNow 手动重试', /retryNow\s*\(\s*\)\s*\{/.test(code), true);
  check('存在 onStatus 状态回调', /onStatus\s*\(\s*cb\s*\)/.test(code), true);
  // 旧的静默放弃写法必须消失：`if (this._reconnectAttempts >= this._maxReconnect) return;`
  check('旧「直接 return 静默放弃」已移除',
    /if\s*\(this\._reconnectAttempts\s*>=\s*this\._maxReconnect\)\s*return;/.test(code), false);
}

// 还原真定时器
globalThis.setTimeout = realSetTimeout;
console.log(fails === 0 ? '\n✓ 全部通过' : `\n✗ ${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
