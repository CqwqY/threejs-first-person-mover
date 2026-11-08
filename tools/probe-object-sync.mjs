// 静态 + 运行时断言：足球(prop) 与编辑器运动器的服务器同步链路。
// 这两处失效都是「零报错、整块功能消失」：
//   ① PhysicsProps 拿到 undefined 的 network → 所有 t:'prop' 上报短路；
//   ② 场景事件只在本地触发，服务端从不转发 → 各端平台位置各异。
// 另外钉死 WebRTC 两条入站通道必须共用同一套信令过滤（之前 DC 那条漏了 → RTT 恒 0）。
import fs from 'node:fs';
import {
  sceneOn, sceneFire, clearSceneEvents, setSceneEventSyncHook,
} from '../src/world/sceneEvents.js';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const game = read('src/core/Game.js');
const net = read('src/net/Network.js');
const events = read('src/world/sceneEvents.js');
const movers = read('src/world/sceneMovers.js');
const props = read('src/world/physicsProps.js');
const cache = read('src/world/assetCache.js');
const server = fs.readFileSync(new URL('../../fp-relay/index.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const rtc = fs.readFileSync(new URL('../../fp-relay/webrtc-relay.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

let pass = 0;
const fails = [];
function ok(name, cond) { if (cond) pass++; else fails.push(name); }
function has(src, text, name) { ok(name, src.includes(text)); }

// ---- ① P0：network 必须在 PhysicsProps 之后补注入，且顺序正确 ----
const iProps = game.indexOf('new PhysicsProps(');
const iNet = game.indexOf('new Network(');
const iInject = game.indexOf('this.props.net = this.network;');
ok('PhysicsProps 先于 Network 构造', iProps > 0 && iNet > iProps);
ok('network 补注入存在且在构造之后', iInject > iNet);
has(props, 'if (this.net && this.localId)', '上报依赖 net 与 localId');

// ---- ② 事件同步：hook / 本地事件 / 远端事件 / 进出区域不广播 ----
has(events, 'setSceneEventSyncHook', '事件同步 hook 导出');
has(events, 'o.remote !== true', '远端事件不再上报（防回环）');
has(events, 'o.broadcast !== false', '支持纯本地事件');
ok('进出区域标 broadcast:false', (game.match(/sceneFire\(ev\.(enter|leave), \{ broadcast: false \}\)/g) || []).length === 2);
has(game, 'setSceneEventSyncHook((ev) => this.network.send({ t: \'scene_event\', ev }))', 'Game 注入上报');
has(game, "case 'scene_event'", 'Game 处理远端事件');
has(game, 'sceneFire(msg.ev, { remote: true })', '远端事件只本地执行');

// ---- ③ 运动器姿态快照 ----
has(movers, 'export function getSceneMoverSnapshot', '快照导出');
has(movers, 'export function applySceneMoverSnapshot', '快照套用');
has(movers, 'ms: rec.movers.map((m) => [m.t, m.rot])', '快照不覆盖 active/dir');
has(movers, 'if (rec.onMoved)', '套用后刷新碰撞体');
has(game, 'getSceneMoverSnapshot()', 'Game 上报快照');
has(game, 'applySceneMoverSnapshot(msg.movers)', 'Game 套用快照');
has(game, "case 'scene_sync_req'", 'Game 响应即时快照请求');
has(game, 'this._sceneSyncAcc = 0', '累加器构造期初始化');
has(game, 'this._sceneSyncAcc += dt', '累加器每帧累加');
has(game, 'this._pendingProps = []', '补发球列表构造期初始化');
has(game, 'Array.isArray(msg.props)', 'welcome 接收补发球');
has(game, "this.props.applyRemote('spawn', p)", '布局完成后补建球');

// ---- ④ 客户端两条入站通道统一过滤 ----
has(net, '_dispatch(msg)', '统一分发方法');
ok('wss 与 dc 都走 _dispatch', (net.match(/this\._dispatch\(msg\)/g) || []).length >= 2);
has(net, "if (msg.t === 'pong')", 'pong 过滤');
has(net, "if (msg.t === 'signal_ack')", 'signal_ack 过滤');
has(net, 'this._handlers.slice()', '回调遍历用拷贝');
has(net, 'out.qx = info.qx', 'sendProp 透传四元数');
// 用花括号配对抽函数体：别用 slice(indexOf) 一路扫到文件末尾，会把后面新加的代码也算进来（假阳性）
function blockAt(src, marker) {
  const s = src.indexOf(marker);
  if (s < 0) return '';
  const open = src.indexOf('{', s);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(s, i + 1); }
  }
  return '';
}
const emptyCatch = /\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/;
ok('统一分发内无空 catch', !emptyCatch.test(blockAt(net, '_dispatch(msg)')));
ok('DC 入站回调内无空 catch', !emptyCatch.test(blockAt(net, 'dc.onmessage = (e) =>')));

// ---- ⑤ 服务端 ----
has(server, "if (msg.t === 'scene_event')", '服务端转发场景事件');
has(server, "if (msg.t === 'scene_sync')", '服务端转发姿态快照');
has(server, 'const ballState = new Map()', '服务端记录球状态');
has(server, 'props }));', 'welcome 补发球列表');
has(server, 'out.qw = num(msg.qw', '服务端透传四元数');
has(server, 'if (!out.kind && prev && prev.kind) out.kind = prev.kind', 'state 沿用 spawn 的 kind');
has(server, "auth.send(JSON.stringify({ t: 'scene_sync_req' }))", '事件后请求即时快照');
has(server, 'if (auth !== ws) return', '只有权威端快照被放行');
has(rtc, 'if (sent !== false)', '检查 DataChannel 发送返回值');
has(rtc, "console.warn('[rtc] DataChannel 消息处理异常", 'DC 消息异常出声');

// ---- ⑥ boy-rig 重烘焙后必须升缓存版本 ----
has(cache, "const CACHE_NAME = 'fpm-assets-v7'", '缓存版本已升 v7');

// ---- ⑦ 运行时：事件 hook 不回环、纯本地不广播 ----
clearSceneEvents();
const calls = [];
const sent = [];
sceneOn('door', () => calls.push('door'));
setSceneEventSyncHook((ev) => sent.push(ev));
sceneFire('door');
ok('本地事件触发订阅', calls.length === 1);
ok('本地事件上报一次', sent.length === 1 && sent[0] === 'door');
sceneFire('door', { remote: true });
ok('远端事件触发订阅', calls.length === 2);
ok('远端事件不再上报', sent.length === 1);
sceneFire('door', { broadcast: false });
ok('纯本地事件触发订阅', calls.length === 3);
ok('纯本地事件不上报', sent.length === 1);
sceneFire('nothing');
ok('空事件不上报', sent.length === 1);
setSceneEventSyncHook(null);
clearSceneEvents();

console.log('[probe-object-sync] ' + pass + ' 项通过，' + fails.length + ' 项失败');
for (const f of fails) console.log('  FAIL ' + f);
if (fails.length) process.exit(1);
