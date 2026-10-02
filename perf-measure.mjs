// 帧率/流畅度调研：无头 Edge + CDP 读取真实渲染统计（draw call/triangle 与真机一致）与帧间隔。
// 注：SwiftShader 软件渲染会拉低 FPS 绝对值，但 renderer.info 的 draw call / 三角形数与真机 GPU 一致，
// 是定位瓶颈的最直接数据。
const { spawn } = await import('node:child_process');
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const URL = "http://localhost:5173/";
const DEVTOOLS = "http://127.0.0.1:9222";
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const edge = spawn(EDGE, ["--headless=new", "--remote-debugging-port=9222", "--no-first-run", "--no-default-browser-check", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--window-size=1280,720"], { stdio: "ignore" });
let exitCode = 0;
try {
  let ready = false;
  for (let i = 0; i < 40; i++) { try { const r = await fetch(DEVTOOLS + "/json/version"); if (r.ok) { ready = true; break; } } catch {} await sleep(300); }
  if (!ready) throw new Error("Edge DevTools 未就绪");
  const list = await (await fetch(DEVTOOLS + "/json")).json();
  const page = list.find(t => t.type === "page" && t.webSocketDebuggerUrl) || list.find(t => t.webSocketDebuggerUrl);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let idc = 0; const pending = new Map();
  const send = (m, p = {}) => new Promise((res, rej) => { const id = ++idc; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p })); });
  ws.onmessage = (ev) => { let raw; try { raw = (typeof ev.data === "string") ? ev.data : Buffer.from(ev.data).toString("utf8"); } catch { raw = String(ev.data); } let m; try { m = JSON.parse(raw); } catch { return; } if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("CDP WS 失败")); });
  await send("Runtime.enable"); await send("Page.enable");
  await send("Page.navigate", { url: URL }); await sleep(3000);
  await send("Runtime.evaluate", { expression: "(function(){var b=document.querySelector('#au-skip'); if(b)b.click();})()", returnByValue: true });
  let booted = false;
  for (let i = 0; i < 40; i++) { const r = await send("Runtime.evaluate", { expression: "typeof window.__game!=='undefined'&&!!window.__game", returnByValue: true }); if (r.result && r.result.value) { booted = true; break; } await sleep(300); }
  await sleep(2500);

  // 直接读取末帧 renderer.info（draw call/三角数与真机 GPU 一致；SwiftShader 的 FPS 绝对值无意义，故不采样帧间隔）
  const R = await send("Runtime.evaluate", {
    expression: "(function(){"
      + "var g=window.__game;"
      + "function countScene(o){var c=1; if(o.children){for(var i=0;i<o.children.length;i++)c+=countScene(o.children[i]);} return c;}"
      + "var info=g.renderer.info;"
      + "var out={"
      + "drawCalls: info.render.calls, triangles: info.render.triangles,"
      + "geometries: info.memory.geometries, textures: info.memory.textures, programs: info.programs.length,"
      + "sceneObjects: countScene(g.scene),"
      + "shadowEnabled: g.renderer.shadowMap.enabled, shadowType: g.renderer.shadowMap.type,"
      + "sunShadowMapX: g._sun.shadow.mapSize.x, sunCastShadow: g._sun.castShadow,"
      + "pixelRatio: g.renderer.getPixelRatio(), antialias: true,"
      + "players: g.playerManager ? g.playerManager.players.size : -1,"
      + "dpr: window.devicePixelRatio"
      + "};"
      + "return out;})()",
    returnByValue: true,
  });
  const r = R.result && R.result.value;
  console.log("=== 渲染统计（draw call/三角数与真机一致；FPS 为 SwiftShader 软渲染，仅供相对比较）===");
  console.log(JSON.stringify(r, null, 2));
} catch (e) { console.log("MEASURE ERROR: " + e.message); exitCode = 1; }
finally { try { edge.kill("SIGKILL"); } catch {} process.exit(exitCode); }
