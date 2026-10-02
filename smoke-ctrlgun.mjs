// 无头 Edge + CDP 冒烟测试：加载游戏，捕获运行期异常，确认 canvas 已创建。
// 使用 Node 22 内置全局 WebSocket（EventTarget 风格）。
const { spawn } = await import('node:child_process');

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const URL = "http://localhost:5173/";
const DEVTOOLS = "http://127.0.0.1:9222";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const edge = spawn(EDGE, [
  "--headless=new",
  "--remote-debugging-port=9222",
  "--no-first-run",
  "--no-default-browser-check",
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--ignore-gpu-blocklist",
  "--window-size=1280,720",
], { stdio: "ignore" });

let exitCode = 0;
const errors = [];
const logs = [];

try {
  // 等 DevTools 端口
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(DEVTOOLS + "/json/version"); if (r.ok) { ready = true; break; } } catch {}
    await sleep(300);
  }
  if (!ready) throw new Error("Edge DevTools 端口未就绪");

  // 列出已存在目标（headless 启动时有一个 about:blank page），取 page 类型的 WS
  const jl = await fetch(DEVTOOLS + "/json");
  const list = await jl.json();
  const page = list.find(t => t.type === "page" && t.webSocketDebuggerUrl) || list.find(t => t.webSocketDebuggerUrl);
  if (!page) throw new Error("没有可用目标: " + JSON.stringify(list));
  const wsUrl = page.webSocketDebuggerUrl;

  const ws = new WebSocket(wsUrl);
  let idc = 0;
  const pending = new Map();
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++idc;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  ws.onmessage = (ev) => {
    let raw;
    try { raw = (typeof ev.data === "string") ? ev.data : Buffer.from(ev.data).toString("utf8"); }
    catch { raw = String(ev.data); }
    let m;
    try { m = JSON.parse(raw); }
    catch { console.log("[RAW-FRAME] " + raw.slice(0, 160)); return; }
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
    } else if (m.method) {
      if (m.method === "Runtime.exceptionThrown") {
        const e = m.params.exceptionDetails;
        errors.push("EXCEPTION: " + ((e.exception && e.exception.description) || e.text) +
          (e.stackTrace && e.stackTrace.callFrames[0] ? " @ " + e.stackTrace.callFrames[0].url + ":" + e.stackTrace.callFrames[0].lineNumber : ""));
      } else if (m.method === "Log.entryAdded") {
        const e = m.params.entry;
        if (e.level === "error" || e.level === "warning") logs.push("[" + e.level + "] " + e.text);
      } else if (m.method === "Network.responseReceived") {
        const r = m.params.response;
        if (r.status >= 400) logs.push("[HTTP " + r.status + "] " + (m.params.response.url || m.params.url));
      } else if (m.method === "Network.loadingFailed") {
        logs.push("[FAIL] " + (m.params.errorText || "") + " reqId=" + m.params.requestId);
      }
    }
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("CDP WS 连接失败")); });
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Network.enable");
  await send("Page.enable");
  await send("Page.navigate", { url: URL });
  await sleep(3000);

  // 无头环境无人点登录框：点「游客进入」让 ensureAuth 放行，游戏才会真正启动
  const clicked = await send("Runtime.evaluate", {
    expression: "(function(){ var b=document.querySelector('#au-skip'); if(b){ b.click(); return true;} return false; })()",
    returnByValue: true,
  });
  console.log("点击游客进入: " + (clicked.result && clicked.result.value));

  // 等 window.__game 出现（即 new Game 跑完）
  let booted = false;
  for (let i = 0; i < 40; i++) {
    const r = await send("Runtime.evaluate", { expression: "typeof window.__game !== 'undefined' && !!window.__game", returnByValue: true });
    if (r.result && r.result.value) { booted = true; break; }
    await sleep(300);
  }
  await sleep(2000); // 让主循环跑几帧

  const probe = await send("Runtime.evaluate", {
    expression: "(function(){"
      + "var g=window.__game; if(!g) return {booted:false};"
      + "var rig=g._ctrlRig;"
      + "var camHasRig = !!(rig && g.camera && rig.parent === g.camera);"
      + "var modelChildren = rig ? (rig.children[0] ? rig.children[0].children.length : 0) : -1;"
      + "var inScene = !!(rig && g.scene && g.scene.getObjectById(rig.id));"
      // 模拟装备控制枪：直接把可见性逻辑跑一遍
      + "var before = rig ? rig.visible : null;"
      + "if(rig) rig.visible = true;"
      + "return {"
      + "booted:true, hasRig: !!rig, camHasRig: camHasRig, modelChildren: modelChildren,"
      + "rigScale: rig ? rig.scale.x : null, rigPosZ: rig ? rig.position.z : null,"
      + "visibleBefore: before, visibleAfterForce: rig ? rig.visible : null"
      + "};"
      + "})()",
    returnByValue: true,
  });
  const state = probe.result && probe.result.value;

  console.log("=== 页面状态 / 控制枪 rig ===");
  console.log(JSON.stringify(state, null, 2));
  console.log("=== 运行期异常 (" + errors.length + ") ===");
  errors.forEach(e => console.log(e));
  console.log("=== console error/warning (" + logs.length + ") ===");
  logs.slice(0, 20).forEach(l => console.log(l));

  if (errors.length > 0) exitCode = 2;
  else if (!state || !state.booted) { console.log("WARN: 游戏未启动（__game 未出现）"); exitCode = 3; }
  else if (!state.hasRig) { console.log("WARN: Game._ctrlRig 不存在"); exitCode = 4; }
  else if (!state.camHasRig) { console.log("WARN: _ctrlRig 未挂在相机下（第一人称不会显示）"); exitCode = 5; }
  else console.log("OK: 游戏启动无异常；控制枪第一人称 rig 已创建并挂在相机下（camHasRig=true，含控制枪模型 "+state.modelChildren+" 个子件）");
} catch (e) {
  console.log("SMOKE ERROR: " + e.message);
  exitCode = 1;
} finally {
  try { edge.kill("SIGKILL"); } catch {}
  process.exit(exitCode);
}
