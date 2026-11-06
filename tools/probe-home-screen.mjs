// 自检：新主页的状态机（底图 / 登录态 / 玩家名 / 进度条变「点击进入」）与启动顺序。
//   node tools/probe-home-screen.mjs
//
// 用一份极简 DOM 桩真跑 createHomeScreen()：登录 → 加载 → 就绪 → 点击进入，
// 重点验证「就绪后指针不再被遮罩吞掉」（否则进度条变成的按钮自己点不动）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  displayName, displayColor, progressLabel, progressWidth, createHomeScreen,
} from '../src/ui/HomeScreen.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' | ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'got=' + a + ' want=' + b); }

console.log('纯函数：昵称 / 颜色 / 进度文案');
eq(displayName({ nickname: '小明', username: 'u1' }), '小明', '优先昵称');
eq(displayName({ username: 'u1' }), 'u1', '无昵称回退用户名');
eq(displayName(null), '', '无资料返回空串');
eq(displayColor({ nicknameColor: '#ffcc00' }), '#ffcc00', '合法昵称色');
eq(displayColor({ nicknameColor: 'red' }), '#ffffff', '非 hex 颜色兜底为白');
eq(displayColor({}), '#ffffff', '缺字段兜底为白');
eq(progressLabel(3, 12), '正在加载 3 / 12  (25%)', '进度文案');
eq(progressWidth(3, 12), 25, '进度百分比');
eq(progressWidth(0, 0), 10, '总量未知时慢慢爬');
eq(progressWidth(99, 0), 85, '未知总量上限 85%');
eq(progressWidth(20, 10), 100, 'done>total 钳到 100%');

// ---- 极简 DOM 桩 ----
class El {
  constructor(tag) {
    this.tagName = tag;
    this.style = { cssText: '' };
    this.dataset = {};
    this.children = [];
    this.parentElement = null;
    this.textContent = '';
    this.className = '';
    this.id = '';
    this._attrs = {};
    this._listeners = {};
    this._removed = false;
  }
  setAttribute(k, v) { this._attrs[k] = String(v); }
  getAttribute(k) { return this._attrs[k] ?? null; }
  appendChild(c) {
    this.children.push(c);
    c.parentElement = this;
    if (c.id && globalThis.document) globalThis.document._byId[c.id] = c;
    return c;
  }
  remove() {
    if (this.parentElement) {
      const i = this.parentElement.children.indexOf(this);
      if (i >= 0) this.parentElement.children.splice(i, 1);
    }
    this._removed = true;
  }
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  dispatch(type, evt) { for (const fn of (this._listeners[type] || [])) fn(evt); }
}
const doc = {
  _byId: {},
  head: new El('head'),
  body: new El('body'),
  createElement: (tag) => new El(tag),
  getElementById: (id) => doc._byId[id] || null,
};
globalThis.document = doc;
globalThis.requestAnimationFrame = (fn) => { fn(); return 1; }; // 同步执行，断言稳定

function mockEvt() {
  return {
    prevented: false, stopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
  };
}

function makeHome() {
  doc.body.children.length = 0;
  const home = createHomeScreen({ onSwitchAccount: () => { switchCalls++; } });
  const root = home.root;
  const [bg, shade, center, bottom] = root.children;
  const [nameEl, subEl, switchEl] = center.children;
  const [bar, hint] = bottom.children;
  const [fill, sweep, label] = bar.children;
  return { home, root, bg, shade, center, bottom, nameEl, subEl, switchEl, bar, hint, fill, sweep, label };
}
let switchCalls = 0;

console.log('真跑状态机：login → loading → ready → entered');
const h = makeHome();
eq(h.home.phase, 'login', '初始处于登录检测阶段');
ok(h.root.style.cssText.includes('z-index:10000'), '主页遮罩层级为 10000');
ok(h.bg.style.cssText.includes('loading-bg.jpg'), '底图层使用校门夜景底图');
eq(h.root.children.length, 4, '主页只有 底图 / 压暗 / 中间 / 下方 四层');
ok(h.root.children.every((c) => c.tagName !== 'img'), '没有 Logo 图片节点（图标已弃用）');
eq(h.bar.getAttribute('role'), 'progressbar', '进度条初始语义是进度条');
eq(h.bar.dataset.mode, 'loading', '进度条初始为加载模式');
eq(h.label.textContent, '等待登录', '登录阶段进度条提示等待登录');

h.home.setStatus('请登录', '登录后即可进入校园');
eq(h.nameEl.textContent, '请登录', '未登录时中间提示请登录');
eq(h.subEl.textContent, '登录后即可进入校园', '副标题同步');
eq(h.switchEl.style.display, 'none', '未登录不显示切换账号');

h.home.setProfile({ nickname: '小明', username: 'u1', nicknameColor: '#ffcc00' });
eq(h.nameEl.textContent, '小明', '登录后中间显示玩家名字');
eq(h.nameEl.style.color, '#ffcc00', '沿用昵称颜色');
eq(h.switchEl.style.display, 'block', '已登录显示切换账号');
h.switchEl.dispatch('click', mockEvt());
eq(switchCalls, 1, '切换账号回调可触发');

h.home.beginLoading();
eq(h.home.phase, 'loading', '进入加载阶段');
h.home.setProgress(3, 12);
eq(h.fill.style.width, '25%', '进度条走真实百分比');
ok(h.hint.textContent.includes('3 / 12'), '提示显示已加载件数', h.hint.textContent);
h.home.setProgress(0, 0);
eq(h.fill.style.width, '10%', '总量未知时的缓慢爬升');
h.home.setProgress(12, 12);
eq(h.fill.style.width, '100%', '加载完成进度条满');

// 登录/加载阶段：点击必须被遮罩吞掉，不能漏进游戏
const blocked = mockEvt();
h.root.dispatch('pointerdown', blocked);
ok(blocked.prevented && blocked.stopped, '加载阶段遮罩吞掉指针事件');
const onSwitch = mockEvt();
onSwitch.target = h.switchEl;
h.root.dispatch('pointerdown', onSwitch);
ok(!onSwitch.prevented && !onSwitch.stopped, '切换账号被放行（capture 不吞它的 click）');

let resolved = false;
const readyPromise = h.home.markReady();
readyPromise.then(() => { resolved = true; });
eq(h.home.phase, 'ready', 'markReady 切到就绪阶段');
eq(h.bar.dataset.mode, 'ready', '同一条进度条变成按钮模式');
eq(h.bar.getAttribute('role'), 'button', '语义切换为按钮');
eq(h.label.textContent, '点击进入游戏', '进度条文字变为点击进入游戏');
eq(h.label.style.opacity, '1', '按钮文字可见');
eq(h.bar.style.cursor, 'pointer', '按钮可点');
ok(/58px/.test(h.bar.style.height), '进度条本体长高成按钮', h.bar.style.height);
eq(h.root.dataset.readyPainted, '1', '就绪态已绘制');
eq(h.fill.style.opacity, '0', '进度填充淡出');

// ⚠ 就绪后必须放行指针，否则「点击进入」按钮点不动
const allowed = mockEvt();
h.root.dispatch('pointerdown', allowed);
ok(!allowed.prevented && !allowed.stopped, '就绪阶段不再吞掉指针事件');

h.home.setProgress(1, 100);
eq(h.fill.style.width, '100%', '就绪后进度更新被忽略（不会把按钮打回进度条）');

h.bar.dispatch('click', mockEvt());
eq(h.home.done, true, '点击进度条按钮后进入');
eq(h.root.dataset.phase, 'entered', '状态机到 entered');
eq(h.root.style.opacity, '0', '主页开始淡出');
await Promise.resolve();
ok(resolved, 'markReady 返回的 Promise 已 resolve（main.js 才会继续初始化）');

// 点击屏幕任意处也能进入（保留旧行为）
const h2 = makeHome();
h2.home.beginLoading();
h2.home.markReady();
h2.root.dispatch('click', mockEvt());
eq(h2.home.done, true, '就绪后点击任意处也可进入');

// 兜底 finish()
const h3 = makeHome();
h3.home.finish();
eq(h3.home.done, true, 'finish() 兜底可直接结束');

console.log('静态闸门：结构与接线');
const homeSrc = read('src/ui/HomeScreen.js');
const main = read('src/main.js');
const auth = read('src/ui/AuthUI.js');
ok(!fs.existsSync(path.join(ROOT, 'src/ui/LoadingScreen.js')), '旧 LoadingScreen.js 已删除（无死代码）');
ok(!/favicon-512\.png/.test(homeSrc), '主页不再引用弃用的校门 Logo 图片');
ok(!/enterBar/.test(homeSrc), '不再有独立的居中点击进入大横条');
ok(/loading-bg\.jpg/.test(homeSrc), '主页使用全屏底图');
ok(/setAttribute\('role', 'button'\)/.test(homeSrc), '进度条通过 role 变为按钮');

const zHome = Number((homeSrc.match(/z-index:(\d+)/) || [])[1]);
const zAuth = Number((auth.match(/z-index:(\d+)/) || [])[1]);
ok(zAuth > zHome, '登录弹窗层级 ' + zAuth + ' > 主页 ' + zHome + '（弹窗能盖在底图上）');
ok(/请登录/.test(auth), '弹窗文案为请登录');
ok(/onNeedLogin/.test(auth) && /cachedProfile/.test(auth), '登录态可通知主页，且离线有昵称缓存');
ok(/暂不登录（游客）/.test(auth), '保留弱化的游客降级入口（后端不可达时不会卡死）');

ok(main.indexOf('const home = createHomeScreen(') > 0, 'main 先创建主页');
ok(main.indexOf('const home = createHomeScreen(') < main.indexOf('auth = await ensureAuth('),
  '主页先于登录检测挂载（弹窗背后是底图而不是空白）');
ok(/onNeedLogin/.test(main) && /home\.setProfile/.test(main), '登录结果驱动中间文字');
ok(/cachedProfile\(\)/.test(main), '接口暂时不通时用缓存昵称显示名字');
ok(/home\.beginLoading\(\)/.test(main), 'Game 启动后切到加载阶段');
ok(/waitAssets\(home, game\)/.test(main) && /await home\.markReady\(\)/.test(main),
  '真实加载进度仍接老链路，完成后进度条变按钮');
ok(!/createLoadingScreen/.test(main), 'main 不再引用旧加载屏');

console.log('\n' + (fail ? '✗ ' + fail + ' 项不符（共 ' + (pass + fail) + ' 项）'
  : '✓ 全部通过（' + pass + ' 项）'));
process.exit(fail ? 1 : 0);
