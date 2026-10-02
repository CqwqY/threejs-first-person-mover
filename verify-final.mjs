import { spawn } from 'child_process';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const DEV = 'http://127.0.0.1:5173/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let edge;
const errors = [];
const logs = [];

function wsSend(ws, method, params, id) {
  return new Promise((resolve) => {
    const onMsg = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id === id) { ws.removeEventListener('message', onMsg); resolve(m); }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}

(async () => {
  edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--remote-debugging-port=9222', '--no-sandbox', '--use-gl=swiftshader'], { stdio: 'ignore' });
  await sleep(2000);
  const list = await (await fetch('http://127.0.0.1:9222/json')).json();
  const page = list.find((t) => t.type === 'page') || list[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res) => { ws.onopen = res; });
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params && m.params.exceptionDetails;
      errors.push('EXC: ' + JSON.stringify((d && (d.exception || d.text)) || m.params));
    } else if (m.method === 'Log.entryAdded') {
      const e = m.params.entry;
      if (e.level === 'error') logs.push('[error] ' + e.text);
    }
  };
  let nextId = 1;
  const send = (method, params) => wsSend(ws, method, params, nextId++);
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: DEV });
  // 等登录面板 #au-skip 出现（vite 冷启动预构建依赖可能较慢），最多 60s
  let loginReady = false;
  for (let i = 0; i < 60; i++) {
    const r = await send('Runtime.evaluate', { expression: '!!document.querySelector("#au-skip")', returnByValue: true });
    if (r.result && r.result.value === true) { loginReady = true; break; }
    await sleep(1000);
  }
  if (!loginReady) { console.log('FAIL: 登录面板 #au-skip 未出现（模块加载失败？）'); ws.close(); if (edge) edge.kill(); process.exit(1); }
  // 绕过登录框：点「游客进入」
  await send('Runtime.evaluate', { expression: "document.querySelector('#au-skip').click(); 'ok';", returnByValue: true });
  // 轮询 __game 就绪，最多 30s
  let ready = false;
  for (let i = 0; i < 50; i++) {
    const r = await send('Runtime.evaluate', { expression: '!!window.__game', returnByValue: true });
    if (r.result && r.result.value === true) { ready = true; break; }
    await sleep(1000);
  }
  if (!ready) {
    const diag = await send('Runtime.evaluate', { expression: "({canvas: document.querySelectorAll('canvas').length, hasLogin: !!document.querySelector('#au-skip'), bodyLen: document.body.innerHTML.length})", returnByValue: true });
    console.log('FAIL: __game 未初始化。诊断=' + JSON.stringify(diag.result && diag.result.value));
    ws.close(); if (edge) edge.kill(); process.exit(1);
  }
  const probe = await send('Runtime.evaluate', {
    expression: `(async () => {
      const g = window.__game;
      if (!g) return { noGame: true };
      const out = { ok: true, notes: [] };
      // P0-B 画质档默认 mid：dpr=1.5, shadowMap.type=PCF(1)
      out.dpr = g._qualityDpr;
      out.shadowType = g.renderer.shadowMap.type;
      if (Math.abs(out.dpr - 1.5) > 0.001) { out.ok = false; out.notes.push('dpr=' + out.dpr + ' !=1.5'); }
      if (out.shadowType !== 1) { out.ok = false; out.notes.push('shadowType=' + out.shadowType + ' !=1(PCF)'); }
      // 控制枪手机适配：技能槽装备 → 攻击按钮显示 + 手持上报 ctrlgun
      g._toggleCtrlGun();
      out.ctrlOn = g._ctrlOn;
      out.attackDisplay = g._attackBtn ? g._attackBtn.style.display : 'NO_BTN';
      out.kind = g._heldWeaponKind();
      if (!g._ctrlOn) { out.ok = false; out.notes.push('ctrlOn false after toggle'); }
      if (g._attackBtn && g._attackBtn.style.display !== '') { out.ok = false; out.notes.push('attack btn hidden: ' + g._attackBtn.style.display); }
      if (g._heldWeaponKind() !== 'ctrlgun') { out.ok = false; out.notes.push('kind=' + g._heldWeaponKind()); }
      // 左键开火：_ctrlFireAt 改变（无人也走后坐计时分支）
      const before = g._ctrlFireAt || 0;
      g._fireCtrlGun();
      out.fireChanged = (g._ctrlFireAt || 0) > before;
      // 收起：攻击按钮应隐藏
      g._toggleCtrlGun();
      out.attackDisplayOff = g._attackBtn ? g._attackBtn.style.display : 'NO_BTN';
      out.ctrlOnOff = g._ctrlOn;
      // P0-A：Boss 应为 idle（早返回路径），且不崩
      out.bossMode = g.boss ? g.boss.mode : 'NO_BOSS';
      return out;
    })()`,
    returnByValue: true, awaitPromise: true,
  });
  const res = probe.result && probe.result.value;
  console.log('=== 验证结果 ===');
  console.log(JSON.stringify(res, null, 2));
  console.log('=== 运行期异常 (' + errors.length + ') ===');
  errors.slice(0, 10).forEach((e) => console.log(e));
  console.log('=== console error (' + logs.length + ') ===');
  logs.slice(0, 10).forEach((l) => console.log(l));
  if (errors.length > 0) console.log('FAIL: 有运行期异常');
  else if (!res || res.noGame) console.log('FAIL: 游戏未初始化');
  else if (!res.ok) console.log('FAIL: 断言未通过');
  else console.log('PASS: 全部断言通过，0 异常');
  ws.close();
  if (edge) edge.kill();
  process.exit(0);
})().catch((e) => { console.error('SCRIPT ERROR', e); if (edge) edge.kill(); process.exit(1); });
