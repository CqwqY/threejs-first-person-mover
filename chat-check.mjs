// 纯逻辑自检（不需要浏览器/WebGL）：
//  1) 客户端与服务端的文本清洗规则必须一致（同一句话在本地回显与别人屏幕上要长得一样）
//  2) 聊天框的消息栏语义：最新一条在最下面、超过上限丢最旧的、纯文本渲染（绝不碰 innerHTML）、
//     「打开输入时消息不淡出」、淡出后真正从 DOM 移除
//  3) 手机按钮位置：必须排在左下角摇杆的正上方（两者用同一套 clamp 公式算高度）
//  4) 静态确认落地接线：T 键、sendChat、case 'chat'、输入时不响应移动键
// 用法：node chat-check.mjs
import { readFileSync } from 'node:fs';
import { cleanChatText, createChatBox } from './src/ui/ChatBox.js';
import { Config } from './src/config.js';

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log('  FAIL ' + msg); } else { console.log('  ok   ' + msg); } };
const fmt = (v) => {
  if (v && typeof v === 'object') return v.__tag ? ('<' + v.__tag + '>') : Object.prototype.toString.call(v);
  return JSON.stringify(v);
};
const eq = (a, b, msg) => ok(a === b, msg + '（实际 ' + fmt(a) + '）');

// ---------------------------------------------------------------------------
// 假 DOM：只实现 ChatBox 用到的那一小撮 API，让消息栏逻辑能在 Node 里真跑一遍。
// style 会把 cssText 按 `k: v;` 解析成驼峰属性（真实浏览器行为），否则
// 「创建时写在 cssText 里的 display:none」在测试里读不到。
// innerHTML 故意做成「一读就抛」：一旦有人用 innerHTML 渲染消息，这里立刻炸出来。
// ---------------------------------------------------------------------------
function makeStyle() {
  let text = '';
  const obj = {};
  Object.defineProperty(obj, 'cssText', {
    get: () => text,
    set: (v) => {
      text = String(v == null ? '' : v);
      for (const k of Object.keys(obj)) if (k !== 'cssText') delete obj[k];
      for (const part of text.split(';')) {
        const i = part.indexOf(':');
        if (i < 0) continue;
        const key = part.slice(0, i).trim();
        if (!key) continue;
        obj[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = part.slice(i + 1).trim();
      }
    },
    enumerable: true,
  });
  return obj;
}
class FakeEl {
  constructor(tag) {
    this.__tag = String(tag || 'div');
    this.tagName = this.__tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = makeStyle();
    this.className = '';
    this._text = '';
    this.listeners = {};
    this.value = '';
    this.placeholder = '';
    this.maxLength = 0;
    this.autocomplete = '';
    this.type = '';
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  get innerHTML() { throw new Error('聊天框不允许使用 innerHTML（会造成注入）'); }
  set innerHTML(_v) { throw new Error('聊天框不允许使用 innerHTML（会造成注入）'); }
  get firstChild() { return this.children[0] || null; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  insertBefore(c, ref) {
    c.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
    return c;
  }
  remove() {
    const p = this.parentNode;
    if (!p) return;
    const i = p.children.indexOf(this);
    if (i >= 0) p.children.splice(i, 1);
    this.parentNode = null;
  }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  fire(type, ev) { for (const fn of (this.listeners[type] || [])) fn(ev || {}); }
  setPointerCapture() { /* 假实现 */ }
  focus() { doc.activeElement = this; }
  blur() { if (doc.activeElement === this) doc.activeElement = null; }
}
const doc = {
  head: new FakeEl('head'),
  body: new FakeEl('body'),
  activeElement: null,
  createElement: (t) => new FakeEl(t),
};
globalThis.document = doc;
globalThis.window = {
  innerWidth: 390,
  innerHeight: 844,
  addEventListener: () => {},
  matchMedia: () => ({ matches: false }),
};
globalThis.visualViewport = undefined;

// 取容器里最上面那层的全部后代文本（用于验证渲染内容）
const textOf = (el) => {
  let s = el.textContent || '';
  for (const c of el.children) s += textOf(c);
  return s;
};
const findChild = (el, pred, depth = 0) => {
  for (const c of el.children) {
    if (pred(c)) return c;
    if (depth < 6) { const r = findChild(c, pred, depth + 1); if (r) return r; }
  }
  return null;
};

// ---------------------------------------------------------------------------
console.log('== 1. 文本清洗（客户端 vs 服务端必须一致）==');
const serverSrc = readFileSync('./server-remote/index.js', 'utf8');
const mFn = serverSrc.match(/function cleanChat\(v\)\s*\{[\s\S]*?\n\}/);
ok(!!mFn, '服务端存在 cleanChat 实现（内联提取，避免真的起一个服务）');
const serverClean = mFn ? new Function('CHAT_MAX_LEN', 'return ' + mFn[0])(80) : null;

const samples = [
  '你好啊',
  '  <b>加粗</b> 去掉标签  ',
  '换行\n也要\n压掉',
  'a\u0000b\u001fc',
  '   ',
  '',
  null,
  undefined,
  '<script>alert(1)</script>',
  'x'.repeat(200),
  '中文'.repeat(60),
];
let mismatch = 0;
for (const s of samples) {
  const a = cleanChatText(s, Config.CHAT_MAX_LEN);
  const b = serverClean ? serverClean(s) : a;
  // 差异只允许出现在长度截断上（客户端 60 字 / 服务端 80 字），前缀必须一模一样
  if (!(b.startsWith(a) || a.startsWith(b))) {
    mismatch++;
    console.log('    差异: ' + JSON.stringify(s) + ' → 客户端 ' + JSON.stringify(a) + ' / 服务端 ' + JSON.stringify(b));
  }
}
ok(mismatch === 0, '全部样例两侧前缀一致（不一致 ' + mismatch + ' 例）');
eq(cleanChatText('<i>hi</i>', 60), 'hi', '标签被剥掉');
eq(cleanChatText('a\n\nb', 60), 'a b', '换行压成空格');
eq(cleanChatText('x'.repeat(100), 10), 'xxxxxxxxxx', '按上限截断');
eq(cleanChatText('    ', 60), '', '纯空白 → 空串');
eq(cleanChatText('x'.repeat(100), 80).length, 80, '服务端上限 80 字生效');

// ---------------------------------------------------------------------------
console.log('== 2. 消息栏语义 ==');
let sent = [];
const box = createChatBox({ coarse: true, logMax: 4, lineLife: 0.08, fade: 0.05 });
box.setOnSend((t) => sent.push(t));
const log = findChild(box.root, (c) => c.className.includes('chat-log'));
const bar = findChild(box.root, (c) => c.className.includes('chat-bar'));
const fab = findChild(box.root, (c) => c.className.includes('chat-fab'));
const input = findChild(box.root, (c) => c.className.includes('chat-input'));
ok(!!(log && bar && fab && input), '四个部件都建出来了（消息栏 / 输入条 / 按钮 / 输入框）');

box.add({ nick: '甲', color: '#ff0000', text: '第一条' });
box.add({ nick: '乙', color: '#00ff00', text: '第二条' });
const l0 = findChild(box.root, (c) => c.className.includes('chat-line'));
eq(textOf(l0), '乙：第二条', '最新一条排在 DOM 最前（配合 column-reverse 显示在最下面）');
ok(log.style.cssText.includes('column-reverse'), '消息栏用 column-reverse：溢出的老消息被裁在顶部');
const nickSpan = l0.children[0];
ok(String(nickSpan.style.cssText).includes('#00ff00'), '昵称按服务端下发的颜色着色（' + nickSpan.style.cssText + '）');
eq(nickSpan.textContent, '乙：', '昵称与冒号在独立的 span 里');
eq(l0.children[1].textContent, '第二条', '正文用 textContent 写入（上面 innerHTML 的 getter 没被触发即为证）');

// 注入尝试：标签会被剥掉，剩下的也只会当纯文本
box.add({ nick: '丙', text: '<img src=x onerror=alert(1)>哈' });
const inj = findChild(box.root, (c) => c.className.includes('chat-line'));
eq(textOf(inj), '丙：哈', 'HTML 标签被清洗，不会留下可执行内容');

// 上限：logMax=4，再加几条，最旧的必须被丢掉
box.add({ nick: '丁', text: '三' });
box.add({ nick: '戊', text: '四' });
box.add({ nick: '己', text: '五' });
const lines = [];
(function collect(el) {
  for (const c of el.children) {
    if (c.className.includes('chat-line')) lines.push(c);
    collect(c);
  }
})(box.root);
ok(lines.length <= 4, '同时最多保留 logMax=4 条（实际 ' + lines.length + '）');
const all = lines.map(textOf).join('|');
ok(!all.includes('第一条'), '最旧的「第一条」已被丢弃');
ok(all.includes('己：五'), '最新的「己：五」还在');

// 系统提示：没有昵称前缀
box.add({ sys: true, text: '系统提示' });
const sysLine = findChild(box.root, (c) => c.className.includes('chat-line--sys'));
eq(textOf(sysLine), '系统提示', '系统提示不带昵称前缀');

// ---------------------------------------------------------------------------
console.log('== 3. 开关与发送 ==');
eq(bar.style.display, 'none', '初始输入条是收起的');
eq(fab.style.display, 'flex', '手机端按钮默认可见');
box.open();
eq(bar.style.display, 'flex', '打开后输入条显示');
eq(fab.style.display, 'none', '打开后收起按钮（避免和输入条抢位置）');
eq(doc.activeElement, input, '打开后输入框自动聚焦（手机即弹键盘）');
ok(box.isOpen(), 'isOpen() 返回 true');

input.value = '  大家好  ';
input.fire('keydown', { key: 'Enter', preventDefault() {}, stopPropagation() {} });
eq(sent.length, 1, '回车发送了一次');
eq(sent[0], '大家好', '发送前已清洗（去空白）');
eq(input.value, '', '发送后清空输入框');
ok(!box.isOpen(), '手机上发完自动收起');

input.value = '被拦住';
box.setSendBlocked(() => true);
box.open();
input.fire('keydown', { key: 'Enter', preventDefault() {}, stopPropagation() {} });
eq(sent.length, 1, 'sendBlocked 为真时不发送');
box.close();

input.value = '不要发出去';
box.open();
input.fire('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} });
ok(!box.isOpen(), 'Esc 关闭输入条');
eq(input.value, '', '关闭时丢弃未发送的内容');
eq(fab.style.display, 'flex', '关闭后按钮重新出现');

// 「打开输入时消息不淡出」：开一条长命消息，打开面板等一段时间，它必须还在
const box2 = createChatBox({ coarse: false, logMax: 10, lineLife: 0.06, fade: 0.02 });
box2.add({ nick: '甲', text: '别消失' });
box2.open();
await new Promise((r) => setTimeout(r, 160));
const still = findChild(box2.root, (c) => c.className.includes('chat-line'));
ok(!!still, '输入框开着时消息不会淡出（方便边打字边看）');
box2.close();
await new Promise((r) => setTimeout(r, 220));
const gone = findChild(box2.root, (c) => c.className.includes('chat-line'));
ok(!gone, '关闭输入框后消息按生命周期淡出并从 DOM 移除');

// ---------------------------------------------------------------------------
console.log('== 4. 位置：手机按钮排在摇杆正上方 ==');
const parseBottom = (s) => {
  const m = String(s || '').match(/calc\(env\(safe-area-inset-bottom, 0px\) \+ (\d+)px\)/);
  return m ? Number(m[1]) : NaN;
};
const joyOf = (vw, vh) => Math.min(124, Math.max(92, Math.min(vw, vh) * 0.26));
for (const [vw, vh] of [[390, 844], [844, 390], [360, 640]]) {
  globalThis.window.innerWidth = vw;
  globalThis.window.innerHeight = vh;
  const b = createChatBox({ coarse: true, logMax: 4, lineLife: 10, fade: 0.5 });
  b.relayout();
  const bottom = parseBottom(b.root.style.bottom);
  const joy = joyOf(vw, vh);
  const joyTop = 26 + joy + 4; // .mc-joy 的 bottom 26 + 高 clamp(92,26vmin,124) + 2px 边框×2
  ok(Number.isFinite(bottom) && bottom >= joyTop, vw + 'x' + vh + '：聊天栏底边 ' + bottom + 'px ≥ 摇杆顶边 ' + joyTop.toFixed(0) + 'px');
  ok(bottom <= vh * 0.6, vw + 'x' + vh + '：底边没有高到屏幕中部（' + bottom + 'px）');
}
globalThis.window.innerWidth = 390;
globalThis.window.innerHeight = 844;
const desk = createChatBox({ coarse: false, logMax: 4, lineLife: 10, fade: 0.5 });
desk.relayout();
eq(parseBottom(desk.root.style.bottom), 16, '桌面端贴底（没有摇杆要避让）');
ok(String(desk.root.style.cssText).includes('safe-area-inset-left'), 'left 交给构造时的行内样式（含 safe-area），relayout 不改它');

// ---------------------------------------------------------------------------
console.log('== 5. 静态接线 ==');
const gameSrc = readFileSync('./src/core/Game.js', 'utf8');
const netSrc = readFileSync('./src/net/Network.js', 'utf8');
const inputSrc = readFileSync('./src/core/Input.js', 'utf8');
ok(gameSrc.includes("import { createChatBox }"), 'Game 导入了聊天模块');
ok(gameSrc.includes('Config.CHAT_KEY'), 'T 键用 Config.CHAT_KEY（不写死字符串）');
ok(gameSrc.includes('this._sendChat('), 'Game 有 _sendChat');
ok(gameSrc.includes("case 'chat'"), 'Game 处理服务端下发的 chat 消息');
ok(gameSrc.includes('this.input.clearKeys()'), '打开聊天时清掉按住的键（不会边打字边走路）');
ok(gameSrc.includes('isEditableTarget(document.activeElement)'),
  '所有游戏热键在输入框聚焦时让路（4 处统一用 isEditableTarget）');
ok(inputSrc.includes('export function isEditableTarget'), 'Input 导出 isEditableTarget');
ok(inputSrc.includes('if (isEditableTarget(e.target)) return;'), 'Input 在文本框输入时不接管按键');
ok(netSrc.includes('sendChat(text)'), 'Network 有 sendChat');
ok(netSrc.includes("t: 'chat', text: s"), '上行消息字段为 {t,text}（昵称由服务端补）');
ok(serverSrc.includes("if (msg.t === 'chat')"), '服务端处理 chat');
ok(serverSrc.includes("t: 'chat', id, nick, color, text"), '服务端下发的字段含昵称与颜色');
ok(serverSrc.includes('roomBroadcast(ws.__room'), '聊天按房间广播（对战房里聊不到大厅）');
ok(serverSrc.includes('chatAllowed(ws)'), '服务端有刷屏限流');
ok(!/innerHTML/.test(readFileSync('./src/ui/ChatBox.js', 'utf8')), 'ChatBox 源码里完全没有 innerHTML');

console.log('');
console.log(fails === 0 ? '全部通过' : (fails + ' 项失败'));
process.exit(fails === 0 ? 0 : 1);
