// 自检：性能测试台（`perftest.html` + `src/perf/PerfBench.js`）的**面板可达性**
//
// ⚠⚠ 为什么单独立一条（用户反馈：「测试的遮罩有点大，手机测试的时候根本就没渲染多少」）：
//   手机上 HUD 是 `min(560px,94vw)` 宽，内容（标题+选项行+6 格统计+图表+结果表+日志）比屏幕还高 →
//   跑测试时整块画面被盖住，看不到在渲染什么；更糟的是 `html,body{touch-action:none}`（移动端清单要求的）
//   会让面板**自己滚不动**，底部按钮直接不可达。
//
//   ⚠ 但要说清一件事，免得后人误判：**面板盖住 canvas 不影响任何指标** ——
//   渲染器永远按 `window.innerWidth/Height` 全画布渲染，DOM 覆盖层不参与 GPU 工作。
//   所以这是「看得见」的可用性问题，不是数据正确性问题（本探针末组把这条钉进注释）。
//
//   ⇒ 修法：面板可收起 + 手机跑测试时**自动收起** + 收起后留一条细条（进度 + 实时 FPS）。
//
// 跑法：node tools/probe-perftest-hud.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
function ok(cond, msg) {
  if (cond) console.log('  PASS  ' + msg);
  else { console.log('  FAIL  ' + msg); fails++; }
}

const page = fs.readFileSync(path.join(ROOT, 'perftest.html'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'src/perf/PerfBench.js'), 'utf8');

// 花括号配对抽函数体（本项目探针固定写法：别用 slice(indexOf) 切到文件末尾）
function blockAt(src, anchor) {
  const i = src.indexOf(anchor);
  if (i < 0) return '';
  const s = src.indexOf('{', i);
  if (s < 0) return '';
  let d = 0;
  for (let k = s; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); }
  }
  return src.slice(i);
}

// ---------------------------------------------------------------- ① 面板必须能滚、能收
console.log('\n[1] 面板在手机上必须「可达」—— 限高 + 自己能滚 + 可收起');
const hudRule = /#hud \{[\s\S]*?\}/.exec(page);
ok(!!hudRule, '找到 #hud 样式规则');
const hudCss = hudRule ? hudRule[0] : '';
ok(/max-height/.test(hudCss), '#hud 有限高（否则内容比屏幕高，底部按钮跑到屏外）');
ok(/overflow-y:\s*auto/.test(hudCss), '#hud 允许纵向滚动');
// ⚠ 关键：html/body 是 touch-action:none（防手势被页面抢走），所以面板必须**自己**声明 pan-y
ok(/touch-action:\s*pan-y/.test(hudCss), '⚠ #hud 自己声明 touch-action:pan-y —— 否则在 touch-action:none 的页面上滚不动');
ok(/overscroll-behavior:\s*contain/.test(hudCss), '滚到底不把滚动传给页面');
ok(/#hud\.collapsed \{[^}]*display:\s*none/.test(page), '#hud.collapsed 收起（display:none）');
ok(/@media \(max-width:640px\)[\s\S]*?#stats \{ grid-template-columns:repeat\(3,1fr\)/.test(page),
  '窄屏统计格 6 列 → 3 列（6 列时每格约 50px，数字会挤成两行）');

// ---------------------------------------------------------------- ② 收起后的细条
console.log('\n[2] 收起后留一条细条，读数不丢');
ok(/id="hudMini"/.test(page), '存在 #hudMini');
ok(/#hudMini \{[^}]*display:none/.test(page), '#hudMini 默认隐藏');
ok(/#hudMini\.show \{[^}]*display:flex/.test(page), '#hudMini.show 时显示');
ok(/id="miniProg"/.test(page), '细条含进度 #miniProg');
ok(/id="miniFps"/.test(page), '细条含实时 FPS #miniFps');
ok(/id="btnHudHide"/.test(page) && /id="btnHudShow"/.test(page), '收起/展开两个按钮都在');
// 细条必须是"能看见画面"的量级：一行、贴合顶部
ok(/white-space:\s*nowrap/.test(page), '细条内容不换行（否则又会变成一块）');

// ---------------------------------------------------------------- ③ JS 接线
console.log('\n[3] JS 接线：收起逻辑 + 进度双写 + 实时 FPS');
for (const id of ['hud', 'hudMini', 'hudHide', 'hudShow', 'miniProg', 'miniFps']) {
  ok(new RegExp(`${id}: id\\('`).test(js) || new RegExp(`${id}:\\s*id\\(`).test(js), `UI.${id} 已引用`);
}
ok(/function setHudCollapsed\(/.test(js), '存在 setHudCollapsed(v)');
ok(/function isSmallScreen\(/.test(js), '存在 isSmallScreen()');
ok(/function setProg\(/.test(js), '存在 setProg(text)（进度双写）');
ok(/matchMedia\('\(pointer: coarse\)'\)/.test(js), 'isSmallScreen 认触摸设备（不只是屏宽）');
ok(/UI\.hudHide\.onclick = \(\) => setHudCollapsed\(true\)/.test(js), '收起按钮接线');
ok(/UI\.hudShow\.onclick = \(\) => setHudCollapsed\(false\)/.test(js), '展开按钮接线');

{
  const startBody = blockAt(js, 'function start() {');
  ok(startBody.length > 200, '抽到 start() 函数体');
  ok(/if \(isSmallScreen\(\)\) setHudCollapsed\(true\)/.test(startBody),
    '⚠ start() 里手机自动收起 —— 否则跑测试时整屏被 HUD 盖住，看不到画面');
  ok(startBody.indexOf('setHudCollapsed(true)') > startBody.indexOf('state.compiled = false'),
    '收起发生在开始采样之前（不是跑完才收）');
}
{
  const finishBody = blockAt(js, 'function finishAll() {');
  ok(/setHudCollapsed\(false\)/.test(finishBody), 'finishAll 后自动展开（结果表要能看）');
  const stopBody = blockAt(js, 'function stop() {');
  ok(/setHudCollapsed\(false\)/.test(stopBody), 'stop 后也展开');
}

// 进度必须双写：细条是收起后**唯一**可见的地方，漏写就等于收起后看不见进度
{
  const progFn = blockAt(js, 'function setProg(text) {');
  ok(/UI\.prog\.textContent = text/.test(progFn) && /UI\.miniProg\.textContent = text/.test(progFn),
    'setProg 同时写大面板与细条');
  const stray = (js.match(/UI\.prog\.textContent\s*=/g) || []).length;
  ok(stray === 1, `全文件只有 setProg 内部一处直写 UI.prog.textContent（实得 ${stray} 处）—— 其余走 setProg，避免漏写细条`);
}
ok(/UI\.miniFps\.textContent = s\.fps\.toFixed\(0\)/.test(js), '每帧把实时 FPS 写进细条');

// ---------------------------------------------------------------- ④ 尺寸变化三通道
console.log('\n[4] 画布尺寸跟随（否则画面被截/留黑边，填充率数据就没意义）');
ok(/window\.addEventListener\('resize'/.test(js), '监听 resize');
ok(/visualViewport[\s\S]{0,80}addEventListener\('resize'/.test(js),
  '监听 visualViewport resize —— 手机地址栏收起时 iOS 的 window resize 不一定触发');
ok(/addEventListener\('orientationchange'/.test(js), '监听 orientationchange（横竖屏切换）');
{
  const onResize = blockAt(js, 'const onResize = () => {');
  ok(/camera\.aspect = window\.innerWidth \/ window\.innerHeight/.test(onResize), '重算 aspect');
  ok(/renderer\.setSize\(window\.innerWidth, window\.innerHeight\)/.test(onResize), '重设画布尺寸');
}

// ---------------------------------------------------------------- ⑤ 页面结构完整性
console.log('\n[5] 页面结构完整');
ok(/<div id="hud">/.test(page) && /<div id="hudMini">/.test(page) && /<div id="stage">/.test(page),
  '#hud / #hudMini / #stage 三个容器都在');
ok(/<script type="module" src="\.\/src\/perf\/PerfBench\.js"><\/script>/.test(page), '入口脚本还在');
ok(/class="sub"/.test(page) && /\.hd h1 \.sub \{ display:none; \}/.test(page),
  '副标题在手机上隐藏（不占行）');
ok(/table\.scroll \{ display:block; overflow-x:auto/.test(page), '结果表窄屏可横向滚动（12 列挤不下）');

console.log('\n' + (fails ? `✗ ${fails} 项失败` : '✓ 全部通过'));
process.exit(fails ? 1 : 0);
