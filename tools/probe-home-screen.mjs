// 自检：新主页的状态机（视频背景 / 登录态 / 玩家名 / 进度条变「点击进入」）与启动顺序。
//   node tools/probe-home-screen.mjs
//
// 用一份极简 DOM 桩真跑 createHomeScreen()：登录 → 加载 → 就绪 → 点击进入，
// 重点验证「就绪后指针不再被遮罩吞掉」（否则进度条变成的按钮自己点不动），
// 以及三支背景视频的交叉淡入轮播、失败降级与进入游戏后的资源释放。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  displayName, displayColor, progressLabel, progressWidth,
  HOME_VIDEOS, nextVideoIndex, createHomeScreen,
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
console.log('纯函数：视频轮播下标');
eq(HOME_VIDEOS.length, 3, '默认三支背景视频');
eq(nextVideoIndex(0, 3), 1, '第一支 → 第二支');
eq(nextVideoIndex(2, 3), 0, '第三支 → 回到第一支');
eq(nextVideoIndex(-1, 3), 0, '非法起点 -1 归一化为 0（错误恢复跳回第一支）');
eq(nextVideoIndex(0, 0), -1, '空列表返回 -1（调用方据此不播）');
ok(HOME_VIDEOS.every((u) => /^\/video\/home-[123]\.mp4$/.test(u)),
  '视频路径是纯 ASCII 无空格的 /video/home-N.mp4');

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
    // video 元素桩：够跑 play/pause/load 与 playing/ended/error 事件链
    this.src = '';
    this.paused = true;
    this.readyState = 0;
    this.muted = false;
    this.playsInline = false;
    this.loop = true;
    this.preload = '';
    this.loads = 0;
    this.plays = 0;
    this.pauses = 0;
  }
  setAttribute(k, v) { this._attrs[k] = String(v); }
  getAttribute(k) { return this._attrs[k] ?? null; }
  removeAttribute(k) { delete this._attrs[k]; }
  play() { this.plays++; this.paused = false; return Promise.resolve(); }
  pause() { this.pauses++; this.paused = true; }
  load() { this.loads++; this.readyState = 0; }
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
  _docL: {},
  head: new El('head'),
  body: new El('body'),
  createElement: (tag) => new El(tag),
  getElementById: (id) => doc._byId[id] || null,
  // document 级 capture 监听（自动播放被拦时的恢复入口）
  addEventListener(type, fn) { doc._docL[type] = fn; },
  removeEventListener(type) { delete doc._docL[type]; },
  dispatch(type, evt) { if (doc._docL[type]) doc._docL[type](evt); },
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
  return { home, root, bg, shade, center, bottom, nameEl, subEl, switchEl, bar, hint, fill, sweep, label,
    videos: bg.children };
}
let switchCalls = 0;

console.log('真跑状态机：login → loading → ready → entered');
const h = makeHome();
eq(h.home.phase, 'login', '初始处于登录检测阶段');
ok(h.root.style.cssText.includes('z-index:10000'), '主页遮罩层级为 10000');
ok(h.bg.style.cssText.includes('loading-bg.jpg'), '静态底图仍在，视频失败/缓冲时不会黑屏');
ok(h.bg.style.cssText.includes('overflow:hidden'), '背景层裁掉视频超出部分');
eq(h.root.children.length, 4, '主页仍只有 背景 / 压暗 / 中间 / 下方 四层（视频嵌在背景层内）');
ok(h.root.children.every((c) => c.tagName !== 'img'), '没有 Logo 图片节点（图标已弃用）');
eq(h.videos.length, 2, '背景层内两个 video 元素做交叉淡入');
ok(h.videos.every((v) => v.tagName === 'video'), '背景层的子元素确实是 video');
ok(h.videos.every((v) => v.muted === true && v.getAttribute('muted') === ''),
  '视频强制静音（移动端自动播放硬条件，也不和 BGM 抢）');
ok(h.videos.every((v) => v.playsInline === true && v.getAttribute('playsinline') === ''),
  'playsinline 已设置（否则 iOS 会强制全屏播放）');
ok(h.videos.every((v) => v.loop === false), '单支不 loop，由 ended 事件驱动三支轮播');
ok(h.videos.every((v) => /object-fit:cover/.test(v.style.cssText) && /opacity:0/.test(v.style.cssText)),
  '视频铺满且初始透明（没画面时露出静态底图）');
eq(h.videos[1].src, HOME_VIDEOS[0], '启动即播放第一支');
eq(h.videos[0].getAttribute('poster'), '/loading-bg.jpg', 'video 带 poster，没解码出帧时不会黑屏');
eq(h.videos[0].getAttribute('autoplay'), null, '不设 autoplay 属性（否则预载槽会跟着自动播，双份解码）');
eq(h.root.dataset.videoState, 'video', '启动后立刻淡入视频层（不再等 playing 事件）');
eq(h.videos[1].style.opacity, '1', '第一支启动即淡入（不依赖媒体事件）');
eq(h.bar.getAttribute('role'), 'progressbar', '进度条初始语义是进度条');
eq(h.bar.dataset.mode, 'loading', '进度条初始为加载模式');
eq(h.label.textContent, '等待登录', '登录阶段进度条提示等待登录');

console.log('真跑视频轮播：三支交叉淡入 + 循环');
const [vA, vB] = h.videos;
vB.dispatch('playing', null);
eq(vB.style.opacity, '1', '第一支 playing 后淡入');
eq(vA.src, HOME_VIDEOS[1], '空出的槽立刻预载第二支（切换零等待）');
vB.dispatch('ended', null);
vA.dispatch('playing', null);
eq(vA.style.opacity, '1', '第二支交叉淡入');
eq(vB.style.opacity, '0', '第一支淡出');
eq(vB.paused, true, '淡出的旧视频已暂停（不会双份解码）');
eq(vB.src, HOME_VIDEOS[2], '预载第三支');
vA.dispatch('ended', null);
vB.dispatch('playing', null);
eq(vB.style.opacity, '1', '第三支播放');
vB.dispatch('ended', null);
vA.dispatch('playing', null);
eq(vA.src, HOME_VIDEOS[0], '第三支结束后循环回第一支');

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
// 模拟「自动播放被浏览器拦下」：当前视频停在 paused。
vA.paused = true; vB.paused = true;
const playsBefore = vA.plays + vB.plays;
const blocked = mockEvt();
h.root.dispatch('pointerdown', blocked);
ok(blocked.prevented && blocked.stopped, '加载阶段遮罩吞掉指针事件');
ok(vA.plays + vB.plays > playsBefore, '交互时补一次 play（自动播放被拦后的恢复路径）');
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
ok(h.videos.every((v) => v.paused === true), '进入游戏后视频全部暂停');
ok(h.videos.every((v) => v.getAttribute('src') === null), '进入游戏后释放 src（不再后台解码 720p60）');
await Promise.resolve();
ok(resolved, 'markReady 返回的 Promise 已 resolve（main.js 才会继续初始化）');

// 点击屏幕任意处也能进入（保留旧行为）
const h2 = makeHome();
h2.home.beginLoading();
h2.home.markReady();
h2.root.dispatch('click', mockEvt());
eq(h2.home.done, true, '就绪后点击任意处也可进入');

// document 级恢复：登录弹窗 z-index 更高，点它时主页 root 收不到事件，
// 必须靠 document capture 才能把被拦下的自动播放救回来。
console.log('document 级恢复：登录弹窗内的点击也能触发');
const h4 = makeHome();
const [a4, b4] = h4.videos;
a4.paused = true; b4.paused = true;
const plays4 = a4.plays + b4.plays;
doc.dispatch('pointerdown', mockEvt());
ok(a4.plays + b4.plays > plays4, 'document capture 借弹窗内点击补播（主页 root 收不到该事件）');
ok(doc._docL.pointerdown === undefined, '补播成功后一次性监听被移除');

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
ok(/loading-bg\.jpg/.test(homeSrc), '静态兜底底图仍保留（视频失败不黑屏）');
ok(/setAttribute\('role', 'button'\)/.test(homeSrc), '进度条通过 role 变为按钮');
ok(/HOME_VIDEOS/.test(homeSrc) && /\/video\/home-3\.mp4/.test(homeSrc), '三支视频路径写死在常量里，便于换片');
ok(/addEventListener\('playing'/.test(homeSrc) && /addEventListener\('ended'/.test(homeSrc),
  '轮播靠 playing / ended 驱动，不依赖 duration 轮询');
ok(/addEventListener\('error'/.test(homeSrc) && /disableVideo/.test(homeSrc),
  '加载失败有跳过与永久降级，且 console.warn 出声');
ok(/armTimeout/.test(homeSrc) && /8 秒内没有进入播放状态/.test(homeSrc),
  '缓冲/自动播放超时有兜底，不会永久停在 poster 上');
ok(/stopVideos\(\);/.test(homeSrc) && /beginEnter/.test(homeSrc), '进入游戏立刻释放视频解码资源');
ok(/resumeVideos\(\)/.test(homeSrc) && /pointerdown/.test(homeSrc), '自动播放被拦时借首次交互恢复');
ok(/armGlobalResume/.test(homeSrc) && /document\.addEventListener\('pointerdown', onFirst, true\)/.test(homeSrc),
  '恢复监听挂在 document capture（登录弹窗内的点击也能触发）');
ok(/setAttribute\('poster', bgUrl\)/.test(homeSrc), 'poster 用静态底图，淡入不会黑屏');
ok(!/setAttribute\('autoplay'/.test(homeSrc) && /slot !== active && slot !== wantSlot/.test(homeSrc),
  '预载槽既不自动播、也不会被 canplay 补播（不会双份解码）');
ok(/reveal\(next\);/.test(homeSrc) && /addEventListener\('playing', onProgress\)/.test(homeSrc),
  '淡入不再以 playing/canplay 为前提（事件只用于补播）');
ok(/homevideo=0|videoDisabledByUrl/.test(homeSrc), '有 ?homevideo=0 临时关闭开关');
ok(/object-fit:cover/.test(homeSrc), '视频按比例铺满不拉伸');
for (const u of HOME_VIDEOS) {
  ok(fs.existsSync(path.join(ROOT, 'public', u.slice(1))), '素材存在 ' + u);
  ok(!/\s|\(|\)/.test(u), '路径无空格括号 ' + u);
}

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
