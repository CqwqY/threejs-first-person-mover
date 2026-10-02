// 控制枪「技能槽装备 + 左键开火」行为验证（单次页面内 async 完成，避免跨 evaluate 引用不一致）。
const { spawn } = await import('node:child_process');
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const URL = "http://localhost:5173/";
const DEVTOOLS = "http://127.0.0.1:9222";
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const edge = spawn(EDGE, ["--headless=new", "--remote-debugging-port=9222", "--no-first-run", "--no-default-browser-check", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--window-size=1280,720"], { stdio: "ignore" });
let exitCode = 0; const errors = [];
try {
  let ready = false;
  for (let i = 0; i < 40; i++) { try { const r = await fetch(DEVTOOLS + "/json/version"); if (r.ok) { ready = true; break; } } catch {} await sleep(300); }
  if (!ready) throw new Error("Edge DevTools 未就绪");
  const list = await (await fetch(DEVTOOLS + "/json")).json();
  const page = list.find(t => t.type === "page" && t.webSocketDebuggerUrl) || list.find(t => t.webSocketDebuggerUrl);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let idc = 0; const pending = new Map();
  const send = (m, p = {}) => new Promise((res, rej) => { const id = ++idc; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p })); });
  ws.onmessage = (ev) => { let raw; try { raw = (typeof ev.data === "string") ? ev.data : Buffer.from(ev.data).toString("utf8"); } catch { raw = String(ev.data); } let m; try { m = JSON.parse(raw); } catch { return; } if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } else if (m.method === "Runtime.exceptionThrown") { const e = m.params.exceptionDetails; errors.push("EXCEPTION: " + ((e.exception && e.exception.description) || e.text)); } };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("CDP WS 失败")); });
  await send("Runtime.enable"); await send("Log.enable"); await send("Page.enable");
  await send("Page.navigate", { url: URL }); await sleep(3000);
  await send("Runtime.evaluate", { expression: "(function(){var b=document.querySelector('#au-skip'); if(b)b.click();})()", returnByValue: true });
  let booted = false;
  for (let i = 0; i < 40; i++) { const r = await send("Runtime.evaluate", { expression: "typeof window.__game!=='undefined'&&!!window.__game", returnByValue: true }); if (r.result && r.result.value) { booted = true; break; } await sleep(300); }
  await sleep(1500);

  // 单次页面内完成全部验证
  const R = await send("Runtime.evaluate", {
    expression: "(async function(){"
      + "var g=window.__game; var out={};"
      + "function frames(n){return new Promise(function(res){var i=0;(function loop(){if(i++>=n){res();}else requestAnimationFrame(loop);})();});}"
      + "out.ctrlRigType = typeof g._ctrlRig;"
      + "out.ctrlOnInit = g._ctrlOn;"
      + "out.kindInit = g._heldWeaponKind();"
      + "out.rigVisInit = g._ctrlRig ? g._ctrlRig.visible : 'noRig';"
      // 装备
      + "g._toggleCtrlGun();"
      + "out.ctrlOnAfterToggle = g._ctrlOn;"
      + "out.kindAfterToggle = g._heldWeaponKind();"
      // 左键开火（强制 pointerLock 守卫通过）
      + "var before=g._ctrlFireAt;"
      + "Object.defineProperty(document,'pointerLockElement',{configurable:true,get:function(){return g.renderer.domElement;}});"
      + "g.renderer.domElement.dispatchEvent(new MouseEvent('mousedown',{button:0,bubbles:true}));"
      + "out.fireByLeftClick = g._ctrlFireAt!==before;"
      + "await frames(20);"
      + "out.rigVisWhileOn = g._ctrlRig ? g._ctrlRig.visible : 'noRig';"
      // 收起
      + "g._toggleCtrlGun();"
      + "await frames(20);"
      + "out.ctrlOnOff = g._ctrlOn;"
      + "out.kindOff = g._heldWeaponKind();"
      + "out.rigVisOff = g._ctrlRig ? g._ctrlRig.visible : 'noRig';"
      + "return out;})()",
    returnByValue: true, awaitPromise: true,
  });
  const r = R.result && R.result.value;
  console.log("=== 控制枪装备/开火验证 ==="); console.log(JSON.stringify(r, null, 2));
  console.log("=== 运行期异常 (" + errors.length + ") ==="); errors.forEach(e => console.log(e));

  const ok = r && r.ctrlRigType === 'object' && r.ctrlOnInit === false && r.kindInit === '' &&
    r.ctrlOnAfterToggle === true && r.kindAfterToggle === 'ctrlgun' && r.fireByLeftClick === true &&
    r.rigVisWhileOn === true && r.ctrlOnOff === false && r.kindOff === '' && r.rigVisOff === false &&
    errors.length === 0;
  console.log(ok ? "OK: 控制枪已对齐加特林——技能槽装备(_ctrlOn)、左键开火(_fireCtrlGun 被点击触发)、rig 跟随装备态显隐" : "FAIL: 行为未完全对齐");
  if (!ok) exitCode = 2;
} catch (e) { console.log("TEST ERROR: " + e.message); exitCode = 1; }
finally { try { edge.kill("SIGKILL"); } catch {} process.exit(exitCode); }
