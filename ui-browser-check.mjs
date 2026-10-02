// 浏览器端自检（需要 dev server 常驻）：用无头 Edge + CDP 真机验证手机端 UI 收口。
//   · 桌面态：设置是居中弹窗（flex 居中 + 全屏遮罩），点遮罩空白处 / Esc / × 都能关，
//     且桌面端不出现「画面元素」区块（没注入动作就不该留一个点了没反应的按钮）
//   · 手机态（360x780 窄屏 + CDP 触屏模拟）：校卡显示时钟且完整落在小牌内、
//     顶部三个按钮不溢出屏幕、设置里的「画面元素」能进/出拖拽模式、旧左上角侧栏已消失
// 与纯逻辑自检（ui-check.mjs）分工：那边钉源码接线与算术关系，这边钉真实 DOM 行为。
// 前置：另开一个终端跑 `npm run dev`（或 vite --port 5173 --strictPort）。
// 用法：node ui-browser-check.mjs
import { spawn } from 'node:child_process';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9223;
const APP = 'http://127.0.0.1:5173/';
const PROF = 'C:/Users/Administrator/AppData/Local/Temp/edge-ui-probe-' + Date.now();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  FAIL ' + m); } else console.log('  ok   ' + m); };

const child = spawn(EDGE, [
  '--headless=new',
  '--remote-debugging-port=' + PORT,
  '--remote-allow-origins=*',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
  '--user-data-dir=' + PROF,
  '--window-size=430,932',
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio',
  'about:blank',
], { stdio: 'ignore' });

async function waitDevtools() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  return false;
}

let id = 0;
const pending = new Map();
let ws = null;
function send(method, params = {}) {
  const i = ++id;
  return new Promise((res) => { pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.error) throw new Error('CDP error: ' + JSON.stringify(r.error));
  const d = r.result;
  if (d.exceptionDetails) {
    throw new Error('eval: ' + (d.exceptionDetails.exception?.description || JSON.stringify(d.exceptionDetails)));
  }
  return d.result.value;
}
async function waitFor(expr, ms = 30000, label = expr) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await evaluate(expr)) return true; } catch { /* 页面还在加载 */ }
    await sleep(200);
  }
  throw new Error('超时等待：' + label);
}

async function enterGame() {
  await waitFor('!!document.querySelector("#au-skip")', 30000, '登录面板');
  await evaluate('document.querySelector("#au-skip").click(); true');
  await waitFor('!!window.__game && !!window.__game.settingsPanel', 40000, '游戏实例');
  await sleep(500);
}

try {
  if (!(await waitDevtools())) throw new Error('无头浏览器没起来（9223 未响应）');
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); p(msg); }
  });
  await send('Page.enable');
  await send('Runtime.enable');

  // ============ 桌面态 ============
  console.log('== A. 桌面态：设置是居中弹窗 ==');
  await send('Page.navigate', { url: APP });
  await enterGame();
  await evaluate('window.__game.settingsPanel.open(); true');
  await sleep(350);
  const desk = await evaluate(`(() => {
    const p = window.__game.settingsPanel;
    const root = p.root;
    const cs = getComputedStyle(root);
    const r = root.querySelector('.gx-card').getBoundingClientRect();
    const lay = root.querySelector('.gx-layout');
    return {
      display: cs.display,
      pos: cs.position,
      inset0: cs.top === '0px' && cs.left === '0px',
      centered: Math.abs(r.left - (innerWidth - r.right)) < 2,
      inViewport: r.top > 0 && r.bottom < innerHeight && r.left > 0 && r.right < innerWidth,
      layoutDisplay: lay ? getComputedStyle(lay).display : 'missing',
      title: root.querySelector('.kui-title').textContent,
      fabCount: document.querySelectorAll('.gx-fab').length,
    };
  })()`);
  ok(desk.display === 'flex', `桌面：弹窗用 flex 居中（实际 display=${desk.display}）`);
  ok(desk.pos === 'fixed' && desk.inset0, '桌面：外层是全屏遮罩（inset:0）');
  ok(desk.centered && desk.inViewport, '桌面：卡片水平居中且完整在视口内');
  ok(desk.title === '设置', `桌面：标题为「设置」（实际「${desk.title}」）`);
  ok(desk.layoutDisplay === 'none', '桌面：无「画面元素」区块（没注入动作 → 保持隐藏）');
  ok(desk.fabCount === 0, '桌面：没有额外的悬浮齿轮按钮');

  // 点遮罩空白处关闭
  await evaluate(`(() => {
    const el = document.elementFromPoint(4, 4);
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  })()`);
  await sleep(200);
  ok(await evaluate('!window.__game.settingsPanel.isOpen()'), '桌面：点遮罩空白处能关闭');

  // Esc 关闭
  await evaluate('window.__game.settingsPanel.open(); true');
  await sleep(150);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(250);
  ok(await evaluate('!window.__game.settingsPanel.isOpen()'), '桌面：Esc 能关闭');

  // 关闭按钮仍可用
  await evaluate('window.__game.settingsPanel.open(); true');
  await sleep(150);
  await evaluate('window.__game.settingsPanel.root.querySelector(".gx-win-close").click(); true');
  await sleep(200);
  ok(await evaluate('!window.__game.settingsPanel.isOpen()'), '桌面：右上角 × 能关闭');

  // ============ 手机态（360x780 窄屏 + 触屏）============
  console.log('== B. 手机态（360x780，touch）==');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 360, height: 780, deviceScaleFactor: 2, mobile: true,
  });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
  await send('Page.navigate', { url: APP });
  await enterGame();

  const mob = await evaluate(`(() => {
    const idc = document.querySelector('.idc');
    const card = document.querySelector('.idc-card').getBoundingClientRect();
    const time = document.querySelector('.idc-time');
    const tcs = getComputedStyle(time);
    const tr = time.getBoundingClientRect();
    const row = window.__game._topRow;
    const btns = row ? [...row.children].map(b => b.getBoundingClientRect()) : [];
    return {
      coarse: matchMedia('(pointer: coarse)').matches,
      vw: innerWidth,
      timeText: time.textContent,
      timeVisible: tcs.display !== 'none' && tcs.visibility !== 'hidden' && tr.width > 3,
      timeFormatOk: /^\\d{2}:\\d{2}$/.test(time.textContent),
      timeInsideCard: tr.left >= card.left - 0.5 && tr.right <= card.right + 0.5,
      cardRight: card.right,
      rowLeft: row ? row.getBoundingClientRect().left : -1,
      btnCount: btns.length,
      btnInView: btns.length > 0 && btns.every(b => b.left >= -0.5 && b.right <= innerWidth + 0.5),
      btnRightMost: btns.length ? Math.max(...btns.map(b => b.right)) : -1,
      hasOldBar: !!document.querySelector('.ml-bar'),
    };
  })()`);
  ok(mob.coarse, '手机态：matchMedia(pointer: coarse) 为真（模拟生效）');
  ok(mob.vw === 360, `手机态：视口宽 360（实际 ${mob.vw}）`);
  ok(mob.timeVisible, `校卡时钟可见（display=${mob.timeVisible ? 'block' : 'none'}）`);
  ok(mob.timeFormatOk, `时钟格式为 HH:MM（实际「${mob.timeText}」）`);
  ok(mob.timeInsideCard, '时钟完整落在小牌内（没被 overflow 裁掉）');
  ok(!mob.hasOldBar, '旧的左上角「布局」侧栏已消失');
  ok(mob.btnCount === 3, `顶部按钮还是 3 个（实际 ${mob.btnCount}）`);
  ok(mob.btnInView, `360px 窄屏下三个按钮都在屏幕内（最右 ${mob.btnRightMost.toFixed(1)}px ≤ 360）`);
  ok(mob.rowLeft >= mob.cardRight - 0.5,
    `按钮行起点（${mob.rowLeft.toFixed(1)}）不压住校卡（右缘 ${mob.cardRight.toFixed(1)}）`);

  // 设置里的「画面元素」
  await evaluate('window.__game.settingsPanel.open(); true');
  await sleep(350);
  const lay = await evaluate(`(() => {
    const p = window.__game.settingsPanel;
    const box = p.root.querySelector('.gx-layout');
    const cs = getComputedStyle(box);
    const r = box.getBoundingClientRect();
    const btns = [...box.querySelectorAll('.gx-layout-actions button')].map(b => b.textContent);
    const rootR = p.root.querySelector('.gx-card').getBoundingClientRect();
    return {
      display: cs.display,
      visible: cs.display !== 'none' && r.height > 10,
      inCard: r.top >= rootR.top - 1 && r.bottom <= rootR.bottom + 1,
      btns,
      cardInView: rootR.top >= -1 && rootR.bottom <= innerHeight + 1,
    };
  })()`);
  ok(lay.display !== 'none' && lay.visible, '手机端：设置里有「画面元素」区块且可见');
  ok(lay.btns.join('/') === '调整位置/检查/重置位置', `三个按钮文案正确（实际「${lay.btns.join('/')}」）`);
  ok(lay.inCard, '布局区块完整落在弹窗卡片内（没被裁掉）');
  ok(lay.cardInView, '窄屏下弹窗卡片完整在视口内');

  // 「检查」不改动任何锚点、只提示
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('.gx-layout-actions button')].find(x => x.textContent === '检查');
    b.click(); return true;
  })()`);
  await sleep(300);
  ok(await evaluate('!document.querySelector(".ml-handle")'), '「检查」是只读的（不生成拖拽把手）');
  ok(await evaluate('window.__game.settingsPanel.isOpen()'), '「检查」不关闭设置弹窗');

  // 「调整位置」→ 弹窗关闭 + 进入拖拽模式
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('.gx-layout-actions button')].find(x => x.textContent === '调整位置');
    b.click(); return true;
  })()`);
  await sleep(400);
  const edit = await evaluate(`(() => ({
    panelOpen: window.__game.settingsPanel.isOpen(),
    handles: document.querySelectorAll('.ml-handle').length,
    tags: [...document.querySelectorAll('.ml-tag')].map(t => t.textContent),
    bar: !!document.querySelector('.ml-edit-bar'),
    barButton: (document.querySelector('.ml-edit-bar button') || {}).textContent || '',
    barTop: (() => { const b = document.querySelector('.ml-edit-bar'); return b ? b.getBoundingClientRect().top : -1; })(),
  }))()`);
  ok(!edit.panelOpen, '「调整位置」自动收起设置弹窗（否则弹窗盖住要摆的控件）');
  ok(edit.handles === 4, `4 个可摆控件都浮出把手（实际 ${edit.handles}）`);
  ok(edit.tags.length === 4, `每个把手带标签（${edit.tags.length} 个）`);
  ok(edit.bar && edit.barButton === '完成', '编辑器顶部条 + 「完成」按钮出现');
  ok(edit.barTop === 0, '顶部条贴在屏幕顶（top=0）');

  // 「完成」退出
  await evaluate('document.querySelector(".ml-edit-bar button").click(); true');
  await sleep(400);
  const after = await evaluate(`(() => ({
    handles: document.querySelectorAll('.ml-handle').length,
    bar: !!document.querySelector('.ml-edit-bar'),
  }))()`);
  ok(after.handles === 0, '点「完成」后把手全部移除');
  ok(!after.bar, '点「完成」后顶部条消失');

  // 再进一次，确认可反复进出（把手数组没被复用污染）
  await evaluate(`(() => {
    window.__game.settingsPanel.open();
    const b = [...document.querySelectorAll('.gx-layout-actions button')].find(x => x.textContent === '调整位置');
    b.click(); return true;
  })()`);
  await sleep(400);
  ok(await evaluate('document.querySelectorAll(".ml-handle").length === 4'), '可反复进出（第二次仍是 4 个把手）');
  await evaluate('document.querySelector(".ml-edit-bar button").click(); true');
  await sleep(300);

  console.log(fails === 0 ? '\nPASS 全部通过' : `\nFAIL ${fails} 条未通过`);
} catch (e) {
  console.log('  FAIL 探针异常：' + (e && e.message ? e.message : e));
  fails++;
} finally {
  try { if (ws) ws.close(); } catch { /* 忽略 */ }
  try { child.kill(); } catch { /* 忽略 */ }
  await sleep(300);
  process.exit(fails === 0 ? 0 : 1);
}
