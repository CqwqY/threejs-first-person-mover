// 静态断言：WebRTC 直连「概率成功、失败后重试无效」的回归守卫。
//
// 背景（用户反馈）：进游戏**有概率**能拿到 UDP 直连（HUD 显示 UDP），拿不到时 HUD 一直是 CF，
// 而且「怎么重试都不行」。根因有两处，且都是零报错的静默失效：
//   ① 客户端 _retryRtc 只重试 RTC_MAX_RETRY(=2) 次就 return，之后整场不再尝试；
//      而打洞是概率事件，2 次根本不够，且用户没有任何手动再试入口。
//   ② 服务端 ensurePeer 用固定名字 'peer-' + ws.__id 建 PeerConnection；
//      重试时同名重建，旧实例 close() 是异步的 → 新实例撞上旧名 → 建连直接失败。
//      表现就是「第一次能连、一旦失败重试永远连不上」。
//
// 本脚本只读源码做静态断言（node tools/probe-rtc-retry.mjs），不跑网络。
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const net = read('src/net/Network.js');
const rtc = read('../fp-relay/webrtc-relay.js');

let fails = 0;
function has(src, needle, label) {
  const ok = src.includes(needle);
  if (!ok) { fails++; console.log('  ✗ ' + label + '\n      缺少: ' + JSON.stringify(needle)); }
  else console.log('  ok    ' + label);
}
// 用花括号配对抽函数体，避免 indexOf 扫到文件末尾把后面的函数也算进来
function blockAt(src, signature) {
  const start = src.indexOf(signature);
  if (start < 0) return '';
  let i = src.indexOf('{', start);
  if (i < 0) return '';
  let depth = 0;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return src.slice(start);
}

console.log('[probe-rtc-retry] WebRTC 直连重试守卫');

// ---- 客户端：常量 ----
has(net, 'const RTC_MAX_RETRY = 30', '快重试上限已提到 30（单轮成功率 10%~30%，30 轮累计 96%~99.9%）');
has(net, 'const RTC_MAX_SLOW = 4', '慢速兜底轮数常量存在');
has(net, 'const RTC_SLOW_BASE_DELAY = 30000', '慢速兜底起始间隔存在');
has(net, 'const RTC_LOG_EVERY = 5', '重试日志节流常量存在（30 轮不刷屏）');

// ---- 客户端：单轮超时必须短 ----
// 实测：成功的轮次全部在 600~900ms 内握手完成，失败的轮次 8s 也毫无进展（respRecv=0）。
// 所以单轮等 12s 是纯浪费，会让 20 次重试拖到四分钟以上。这里钉死 ≤ 5s。
const attempt = net.match(/const RTC_ATTEMPT_TIMEOUT = (\d+)/);
has(net, 'const RTC_ATTEMPT_TIMEOUT = 2500', '单轮协商超时常量存在且为 2.5s');
if (attempt && Number(attempt[1]) > 5000) { fails++; console.log('  ✗ 单轮超时 ' + attempt[1] + 'ms 过长（实测成功都在 1s 内，必须 ≤ 5000ms）'); }
else if (attempt) console.log('  ok    单轮超时 ' + attempt[1] + 'ms 在合理范围');
// 超时回调必须用常量，不能又写回硬编码
has(net, '}, RTC_ATTEMPT_TIMEOUT);', '超时定时器使用 RTC_ATTEMPT_TIMEOUT 常量');
if (/\}\s*,\s*12000\s*\)/.test(net)) { fails++; console.log('  ✗ 仍存在硬编码 12000ms 的 RTC 超时'); }
else console.log('  ok    已无硬编码 12000ms 的 RTC 超时');

// ---- 客户端：_rtc 状态机含 slowRound / slowTimer ----
has(net, 'slowRound: 0, slowTimer: null', '_rtc 初始化含 slowRound/slowTimer');
has(net, 'if (this._rtc.slowTimer) { clearTimeout(this._rtc.slowTimer); }', 'connect 复位时清理 slowTimer');

// ---- 客户端：_retryRtc 必须走「快重试 + 慢速兜底」，不能到上限就 return ----
const retry = blockAt(net, '_retryRtc(reason) {');
has(retry, 'r.slowTimer = setTimeout', '_retryRtc 在快重试用尽后安排慢速兜底');
has(retry, 'r.retries = 0', '转入慢速兜底时重置快重试计数');
has(retry, 'RTC_MAX_SLOW', '_retryRtc 以 slowRound 上限作为最终放弃条件');

// ---- 客户端：统一的拆旧→建新，且 rtc_reset 先发 ----
const restart = blockAt(net, '_restartRtc() {');
has(restart, "this.send({ t: 'rtc_reset' })", '_restartRtc 先通知服务端释放旧 PC');
has(restart, 'this._startWebRtc()', '_restartRtc 再发起新一轮协商');
has(restart, 'if (r.pc || r.open) return', '_restartRtc 不叠加重启');

// ---- 客户端：手动重试入口 + 全局挂载 ----
const manual = blockAt(net, 'retryDirect() {');
has(manual, 'r.retries = 0', 'retryDirect 清零重试计数');
has(manual, 'this._restartRtc()', 'retryDirect 走统一重启');
has(net, 'window.__netRetryDirect', '手动重试已挂到 window');

// ---- 客户端：连上后要清掉所有重试定时器 ----
const onopen = blockAt(net, 'dc.onopen = () => {');
has(onopen, 'clearTimeout(this._rtc.slowTimer)', 'dc.onopen 清 slowTimer');
has(onopen, 'clearTimeout(this._rtc.retryTimer)', 'dc.onopen 清 retryTimer');

// ---- 服务端：PeerConnection 名字必须每次唯一 ----
has(rtc, '__rtcSeq = (ws.__rtcSeq || 0) + 1', '服务端自增 rtc 序号');
has(rtc, "'peer-' + ws.__id + '-' + ws.__rtcSeq", '服务端 peer 名带序号（避免同名重建失败）');
// 服务端 rtc_offer 必须「有旧 PC 就先释放再重建」，不能只在 failed 状态重建
const offerBlock = blockAt(rtc, "if (msg.t === 'rtc_offer') {");
has(offerBlock, 'if (ws.__rtc) {', 'rtc_offer 有旧 PC 就先 closeRtc 重建（不再只看 failed 状态）');
has(offerBlock, 'ensurePeer(ws)', 'rtc_offer 之后才建新 PC');
// 旧的固定名写法不能残留
const fixedName = /new PeerConnection\(\s*'peer-'\s*\+\s*ws\.__id\s*,/.test(rtc);
if (fixedName) { fails++; console.log('  ✗ 仍存在固定 peer 名 new PeerConnection(\'peer-\'+ws.__id, ...)'); }
else console.log('  ok    已无固定 peer 名');

console.log('');
if (fails) { console.log('✗ ' + fails + ' 项失败'); process.exit(1); }
console.log('✓ 全部通过');
