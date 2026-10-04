// 浏览器端自检（需要 dev server 常驻）：用无头 Edge + CDP 真机验证手机端 UI 收口。
//   · 桌面态：设置是居中弹窗（flex 居中 + 全屏遮罩），点遮罩空白处 / Esc / × 都能关，
//     且桌面端不出现「画面元素」区块（没注入动作就不该留一个点了没反应的按钮）
//   · 手机态（360x780 窄屏 + CDP 触屏模拟）：校卡显示时钟且完整落在小牌内、
//     顶部三个按钮不溢出屏幕、设置里的「画面元素」能进/出拖拽模式、旧左上角侧栏已消失
//   · 手机横屏（780x360 + 触屏）：两个触控区首尾相接（改前中间留着 46.8px 的盲区，
//     手指落进去既不走也不转视角）、移动区补满全高、摇杆/跳跃键/顶部一排都不越界
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
  await waitFor('!!document.querySelector("#au-skip")', 60000, '登录面板');
  await evaluate('document.querySelector("#au-skip").click(); true');
  await waitFor('!!window.__game && !!window.__game.settingsPanel', 60000, '游戏实例');
  await sleep(500);
}

// 手机态导航：设备尺寸 + 触屏模拟 + 真的重新加载一次。
// URL 必须带时间戳：同一份 URL 连着导航第二次时，浏览器可能认为「已经在那一页了」
// 而不重新加载，于是后续 waitFor 只能等到上一次遗留的 DOM，表现为「等不到登录面板」。
// （软件渲染下每加载一次 3D 场景都不算快，超时也给得宽一些。）
async function gotoPhone(w, h) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
  await send('Page.navigate', { url: APP + '?ts=' + Date.now() });
  await enterGame();
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

  // ---- 顶部按钮：结构必须是「图标键 + 外置文字」，文字不在按钮里（2026-10-04 用户要求）----
  const top = await evaluate(`(() => {
    const g = window.__game;
    const out = [];
    for (const [name, b] of [['背包', g._btnBag], ['设置', g._btnSettings], ['对战', g._btnCombat]]) {
      if (!b) { out.push({ name, missing: true }); continue; }
      const wrap = b.parentElement;
      const lbl = b._label;
      out.push({
        name,
        tag: b.tagName,
        // 按钮自己的文字（应为空，文字全在外置 label 上）
        ownText: (b.textContent || '').trim(),
        // 外置标签必须是按钮的**兄弟节点**，不是子节点
        labelOutside: !!(lbl && lbl !== b && wrap && wrap.contains(lbl) && !b.contains(lbl)),
        labelText: lbl ? lbl.textContent : '',
        hasSvg: !!b.querySelector('svg'),
        title: b.title,
        // 图标键的实际尺寸（方形，约 36px）
        w: Math.round(b.getBoundingClientRect().width),
        h: Math.round(b.getBoundingClientRect().height),
        inViewport: b.getBoundingClientRect().right <= innerWidth + 1,
      });
    }
    return out;
  })()`);
  for (const t of top) {
    ok(!t.missing, `桌面：${t.name} 按钮存在`);
    if (t.missing) continue;
    ok(t.hasSvg, `桌面：${t.name} 按钮里有图标`);
    ok(t.ownText === '', `桌面：${t.name} 按钮内无文字（实际「${t.ownText}」）`);
    ok(t.labelOutside, `桌面：${t.name} 文字在按钮外（label 是兄弟节点）`);
    ok(t.labelText.length > 0, `桌面：${t.name} 外置文字非空（实际「${t.labelText}」）`);
    ok(t.w > 0 && Math.abs(t.w - t.h) <= 2, `桌面：${t.name} 是方形图标键（${t.w}x${t.h}）`);
    ok(t.inViewport, `桌面：${t.name} 未溢出屏幕`);
  }
  // 文案切换不能把图标抹掉（外置 label 结构就是为了这个）
  const keepIcon = await evaluate(`(() => {
    const g = window.__game;
    g._setCombatBtnText('退出对战');
    const hasIcon = !!g._btnCombat.querySelector('svg');
    const txt = g._btnCombat._label ? g._btnCombat._label.textContent : '';
    const title = g._btnCombat.title;
    g._setCombatBtnText('对战匹配');
    return { hasIcon, txt, title };
  })()`);
  ok(keepIcon.hasIcon, '桌面：切换文案后图标仍在（没被 textContent 抹掉）');
  ok(keepIcon.txt === '退出对战', `桌面：外置文字跟着变（实际「${keepIcon.txt}」）`);
  ok(keepIcon.title === '退出对战', '桌面：title 也跟着变（图标化后悬停提示要准）');

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
  await gotoPhone(360, 780);

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
    // 期望把手数 = LAYOUT_ITEMS 里在当前页面上真实存在元素的项数
    expected: ['.mc-jump','.mc-drive','.mc-atk','.mc-view','.sk-box','.hp-box','.chat-tab']
      .filter((s) => !!document.querySelector(s)).length,
  }))()`);
  ok(!edit.panelOpen, '「调整位置」自动收起设置弹窗（否则弹窗盖住要摆的控件）');
  // ⚠ 别硬编码 4：LAYOUT_ITEMS 现在是 7 项（跳/驾驶/攻击/人称/技能槽/血条/对话选项卡），
  // 实际把手数 = 「列表里有、且当前页面上确实有元素」的项数（有些控件按状态才创建）。
  // 早先断言写死 4 是因为那时列表更短，改布局项后没跟着改。
  ok(edit.handles === edit.expected, `每个可摆控件都浮出把手（实际 ${edit.handles}，期望 ${edit.expected}）`);
  ok(edit.tags.length === edit.expected, `每个把手带标签（${edit.tags.length}，期望 ${edit.expected}）`);
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
  ok(await evaluate(`document.querySelectorAll('.ml-handle').length === ${edit.expected}`),
    '可反复进出（第二次把手数与第一次一致）');
  await evaluate('document.querySelector(".ml-edit-bar button").click(); true');
  await sleep(300);

  // ============ 手机横屏（780x360 + 触屏）============
  // 横屏的坑和竖屏不一样：竖屏上下窄，横屏左右窄，而刘海也跑到侧边去了。
  // 这里钉两件事：① 两个触控区必须首尾相接 —— 曾经是 44vw + 50vw，中间永远留着
  // 6vw 的缝（横屏 780px 时 46.8px），手指落进去「既不走也不转视角」；
  // ② 横屏时移动区补满全高（竖屏那份留给「上半屏看路」的余量在 360px 高度上已无必要）。
  console.log('== C. 手机横屏（780x360，touch）==');
  await gotoPhone(780, 360);

  const land = await evaluate(`(() => {
    const R = (s) => {
      const e = document.querySelector(s);
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height };
    };
    const left = R('.mc-left');
    const right = R('.mc-right');
    const joy = R('.mc-joy');
    const jump = R('.mc-jump');
    const card = R('.idc-card');
    const rowEl = window.__game ? window.__game._topRow : null;
    const rowR = rowEl ? rowEl.getBoundingClientRect() : null;
    const btns = rowEl ? [...rowEl.children].map((b) => b.getBoundingClientRect()) : [];
    const gap = (left && right) ? right.l - left.r : null;
    // 沿两区交界线纵向采样：改之前这一列命中的是 .CANVAS，也就是「那头摸不到」
    const mid = (left && right) ? (left.r + right.l) / 2 : null;
    const probes = [];
    if (mid !== null) {
      for (let y = 30; y < innerHeight - 30; y += 30) {
        const el = document.elementFromPoint(mid, y);
        probes.push(el ? String(el.className || el.tagName) : 'null');
      }
    }
    // 血条正好落在移动区里，但它是 pointer-events:none，应该穿透到触控区去
    const hp = document.querySelector('.hp-box');
    let hpHit = '';
    if (hp) {
      const hr = hp.getBoundingClientRect();
      const el = document.elementFromPoint(hr.left + hr.width / 2, hr.top + hr.height / 2);
      hpHit = el ? String(el.className || el.tagName) : 'null';
    }
    return {
      landscape: matchMedia('(orientation: landscape)').matches,
      vw: innerWidth, vh: innerHeight,
      left, right, joy, jump, gap, probes, hpHit,
      cardRight: card ? card.r : -1,
      rowLeft: rowR ? rowR.left : -1,
      btnCount: btns.length,
      btnInView: btns.length > 0 && btns.every((b) => b.left >= -0.5 && b.right <= innerWidth + 0.5),
      btnRightMost: btns.length ? Math.max(...btns.map((b) => b.right)) : -1,
    };
  })()`);
  ok(land.landscape, '横屏：matchMedia(orientation: landscape) 为真（模拟生效）');
  ok(land.vw === 780 && land.vh === 360, `横屏：视口 780x360（实际 ${land.vw}x${land.vh}）`);
  ok(land.gap !== null && land.gap <= 0.5, `两个触控区首尾相接、没有盲区（缝宽 ${land.gap}px；改前是 46.8px）`);
  // 交界线上不该有任何一处落到画布 —— 落到画布就等于「摸不到」（改前这一列全是 .CANVAS，
  // 手指落进去既不走也不转视角）。顶部那排按钮 z=9500 横跨分界线，命中它是正常的层级关系，
  // 所以只要求「没有画布命中」+「绝大多数点归触控区」。
  const canvasHits = land.probes.filter((c) => c === 'CANVAS' || c === 'null').length;
  const zoneHits = land.probes.filter((c) => c.includes('mc-zone')).length;
  ok(canvasHits === 0,
    `交界线纵向取 ${land.probes.length} 点，没有一处落到画布（落到画布＝那一段既不走也不转视角）`);
  ok(zoneHits >= land.probes.length - 2,
    `其中 ${zoneHits}/${land.probes.length} 点命中触控区（余下的是盖在其上的顶部按钮行）`);
  ok(land.left.h >= land.vh - 1, `横屏移动区补满全高（${land.left.h} / ${land.vh}）`);
  ok(land.right.h >= land.vh - 1, `横屏视角区仍是全高（${land.right.h}）`);
  ok(land.joy.l >= 0 && land.joy.r <= land.vw && land.joy.t >= 0 && land.joy.b <= land.vh, '摇杆完整在视口内');
  ok(land.jump.l >= 0 && land.jump.r <= land.vw && land.jump.t >= 0 && land.jump.b <= land.vh, '跳跃键完整在视口内');
  ok(land.joy.r < land.jump.l,
    `摇杆与跳跃键不重叠（摇杆右缘 ${land.joy.r.toFixed(1)} < 跳跃键左缘 ${land.jump.l.toFixed(1)}）`);
  ok(land.rowLeft >= land.cardRight - 0.5, `按钮行不压校卡（行起点 ${land.rowLeft} ≥ 校卡右缘 ${land.cardRight}）`);
  ok(land.btnInView, `横屏下 ${land.btnCount} 个按钮都在屏幕内（最右 ${land.btnRightMost.toFixed(1)}）`);
  ok(land.hpHit.includes('mc-zone'), '血条不吃触摸（pointer-events:none → 穿透到移动区）');

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
