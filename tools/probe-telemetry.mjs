// 自检：数据采集上报（Telemetry）—— 打点 / 采集聚合 / 上报契约 / 服务端清洗
//
// 三层断言：
//   ① 前端接线：main.js 打了哪些加载阶段点、Game 主循环调了 sampleFrame、设置面板有 telemetry 按钮；
//   ② 纯逻辑真跑：markLoadPhase/loadPhases 真在 Node 里记时；采样聚合数学（1% low / jank）口径正确；
//   ③ 服务端：/api/telemetry 路由存在、sanitizeTelemetry 真跑（脏数据被钳制/丢弃）。
//
// 跑：node tools/probe-telemetry.mjs（退出码非 0 = 有回归）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let fails = 0;
function ok(cond, name, extra = '') {
  if (cond) console.log('  ok    ' + name + (extra ? ' — ' + extra : ''));
  else { fails++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}
function blockAt(src, decl) {
  const i = src.indexOf(decl);
  if (i < 0) return '';
  const parenOpen = src.indexOf('(', i);
  let pDepth = 0, bodyOpen = -1;
  for (let j = parenOpen; j < src.length; j++) {
    if (src[j] === '(') pDepth++;
    else if (src[j] === ')') { pDepth--; if (pDepth === 0) { bodyOpen = src.indexOf('{', j); break; } }
  }
  if (bodyOpen < 0) return '';
  let depth = 0;
  for (let j = bodyOpen; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(i, j + 1); }
  }
  return src.slice(i);
}

const telSrc = read('src/util/Telemetry.js');
const gameSrc = read('src/core/Game.js');
const mainSrc = read('src/main.js');
const cfgSrc = read('src/config.js');
const srvSrc = read('server-remote/index.js');

console.log('\n【1】加载阶段打点：main.js 在关键节点标记');
{
  const marks = ['boot', 'authDone', 'gameStart', 'waitStart', 'sceneReady', 'welcomeReady', 'assetsDone', 'enter'];
  for (const m of marks) {
    ok(new RegExp("markLoadPhase\\(\\s*'" + m + "'\\s*\\)").test(mainSrc), "main.js 打了 '" + m + "' 点");
  }
  ok(/import\s*\{[^}]*markLoadPhase[^}]*\}\s*from\s*'\.\/util\/Telemetry\.js'/.test(mainSrc), 'main.js 引入了 markLoadPhase');
  // 点必须在 await 之后（否则测的是发起时刻，不是完成时刻）——断言 sceneReady 点在它的 await 之后
  const sceneIdx = mainSrc.indexOf("markLoadPhase('sceneReady')");
  const awaitIdx = mainSrc.indexOf('game.sceneReady()');
  ok(sceneIdx > awaitIdx && awaitIdx > 0, "'sceneReady' 点在 await game.sceneReady() 之后（记完成时刻）");
}

console.log('\n【2】纯逻辑真跑：markLoadPhase / loadPhases 真在 Node 里工作');
{
  const mod = await import('../src/util/Telemetry.js');
  ok(typeof mod.markLoadPhase === 'function', '导出 markLoadPhase');
  ok(typeof mod.loadPhases === 'function', '导出 loadPhases');
  ok(typeof mod.buildPayload === 'function', '导出 buildPayload（自检用）');
  mod.markLoadPhase('probeStageA');
  await new Promise((r) => setTimeout(r, 5));
  mod.markLoadPhase('probeStageB');
  const ph = mod.loadPhases();
  ok(ph.probeStageA != null, 'probeStageA 已记录');
  ok(ph.probeStageB > ph.probeStageA, '后打点的时刻严格大于先打点的', `A=${ph.probeStageA} B=${ph.probeStageB}`);
  ok(Number.isInteger(ph.probeStageA), '阶段值是整数毫秒');
  const pl = mod.buildPayload({ x: 1 });
  ok(pl.v === 1 && pl.kind === 'perf', 'buildPayload 带版本与 kind');
  ok(pl.device && typeof pl.device.dpr === 'number', 'buildPayload 含设备信息（dpr 为数值）');
  ok(pl.x === 1, 'buildPayload 透传额外字段');
}

console.log('\n【3】采样聚合口径：1% low 用「帧耗时降序取最差」、jank = >33.3ms');
{
  // 采样模块导出了 sampleFrame/waitRenderSample；这里只做静态口径断言（真跑需 rAF/window）
  const fin = blockAt(telSrc, 'function finishRenderSample');
  ok(fin.includes('v > 33.3'), 'jank 阈值 33.3ms（<30fps）');
  ok(/desc\s*=\s*all\.slice\(\)\.reverse\(\)/.test(fin), '1% low 用降序帧耗时（不能拿 fps 排）');
  ok(fin.includes('1000 / low1Ms'), '1% low 由最差帧耗时取倒数折成帧率');
  ok(fin.includes('avgCalls') && fin.includes('avgTris'), '上报含平均 draw call 与三角面');
  ok(/Math\.min\(100,\s*Math\.max\(0,\s*dt\s*\*\s*1000\)\)/.test(telSrc), '单帧耗时按 dt clamp 到 ≤100ms（与 Game 的 MAX_DELTA_TIME 一致）');
}

console.log('\n【4】Game 接线：主循环喂样本 + 设置按钮回调 + 采集中不重入');
{
  ok(/sampleFrame\(dt,\s*this\)/.test(gameSrc), 'Game 主循环每帧调 sampleFrame(dt, this)');
  ok(/sampleFrame\(dt,\s*this\)[\s\S]{0,40}return/.test(gameSrc) || /if\s*\(!rs\)\s*return/.test(telSrc), '未采样时 sampleFrame 立刻返回（零开销）');
  const run = blockAt(gameSrc, 'async _runTelemetry');
  ok(run.includes('startRenderSample'), '_runTelemetry 调 startRenderSample');
  ok(run.includes('waitRenderSample'), '_runTelemetry 等 waitRenderSample');
  ok(run.includes('reportTelemetry'), '_runTelemetry 调 reportTelemetry');
  ok(run.includes('_telRunning'), '_runTelemetry 有重入保护（_telRunning）');
  ok(/telemetry:\s*\(\)\s*=>\s*this\._runTelemetry\(\)/.test(gameSrc), '设置面板 telemetry 绑到 _runTelemetry');
  // 采集器开了必须能关：Game 里不能无 try/catch 地 await（会拖垮循环）—— 断言有 catch
  ok(/catch\s*\(/.test(run), '_runTelemetry 有 try/catch（采集失败不影响游戏）');
}

console.log('\n【5】设置面板：data采集 是 action 项且 gameOnly');
{
  const spSrc = read('src/ui/SettingsPanel.js');
  ok(/id:\s*'telemetry'/.test(spSrc), 'FIELDS 含 telemetry 项');
  const idx = spSrc.indexOf("id: 'telemetry'");
  const around = spSrc.slice(idx, idx + 260);
  ok(/kind:\s*'action'/.test(around), 'telemetry 是 action 类型（点一下回调一次）');
  ok(/gameOnly:\s*true/.test(around), 'telemetry 仅游戏端显示');
}

console.log('\n【6】config：采集时长与上报路径');
{
  ok(/TELEMETRY_SECONDS\s*:\s*\d+/.test(cfgSrc), 'Config.TELEMETRY_SECONDS 已定义');
  ok(/TELEMETRY_PATH\s*:\s*'\/api\/telemetry'/.test(cfgSrc), "Config.TELEMETRY_PATH = '/api/telemetry'");
  const secs = Number((cfgSrc.match(/TELEMETRY_SECONDS\s*:\s*(\d+)/) || [])[1]);
  ok(secs >= 5 && secs <= 60, '采集时长在合理区间（5~60s）', secs + 's');
}

console.log('\n【7】服务端：/api/telemetry 路由 + 限流 + 体积上限 + 追加写入');
{
  ok(/url\.pathname === '\/api\/telemetry'/.test(srvSrc), '服务端有 /api/telemetry 路由');
  ok(/req\.method === 'POST'[\s\S]{0,40}\/api\/telemetry/.test(srvSrc), '仅 POST');
  ok(/16 \* 1024/.test(srvSrc), '体积硬上限 16KB');
  ok(/TELEMETRY_LAST/.test(srvSrc) && /30000/.test(srvSrc), '同 IP 30 秒限流');
  ok(/fs\.appendFileSync\(TELEMETRY_FILE/.test(srvSrc), '按行追加 fs.appendFileSync 到 TELEMETRY_FILE');
  ok(/telemetry\.jsonl/.test(srvSrc), '落盘文件是 telemetry.jsonl');
  ok(/clientIpOf\(req\)/.test(srvSrc), '用真实 IP（clientIpOf 走 XFF）');
}

console.log('\n【8】服务端清洗 sanitizeTelemetry 真跑（脏数据被钳制/丢弃）');
{
  // 从服务端源码里抽出 sanitizeTelemetry 函数体，在 Node 里 eval 执行
  const fn = blockAt(srvSrc, 'function sanitizeTelemetry');
  ok(fn.length > 0, '抽出 sanitizeTelemetry 函数体');
  // eslint-disable-next-line no-new-func
  const sanitize = new Function('raw', 'ip', fn + '\nreturn sanitizeTelemetry(raw, ip);');
  const dirty = {
    kind: 'perf', v: 999,
    phases: { boot: -50, sceneReady: 1234.7, unknownStage: 9, enter: 9e9 },
    render: { frames: 1e9, avgFps: -5, low1Fps: 1e6, p50Ms: 16.7, jankPct: 250, avgCalls: 45, avgTris: 67000, avgScale: 99 },
    device: { ua: 'x'.repeat(999), cores: 8.9, dpr: 3, memGB: -1, msaa: 1 },
    renderScale: 0.5, shadow: 1, quality: 'mid', gpu: 'y'.repeat(999), colliders: 44, players: 7,
  };
  const r = sanitize(dirty, '203.0.113.7');
  ok(typeof r.id === 'string' && r.id.startsWith('t_'), '生成 id（t_ 前缀）');
  ok(r.ip === '203.0.113.7', '记录真实 IP');
  ok(r.v <= 99, 'v 被钳制到 ≤99', 'v=' + r.v);
  ok(r.phases.boot === 0, '负的加载耗时被钳到 0', 'boot=' + r.phases.boot);
  ok(r.phases.sceneReady === 1234.7, '正常加载耗时保留');
  ok(r.phases.unknownStage === undefined, '未知阶段键被丢弃');
  ok(r.phases.enter <= 600000, '超大加载耗时被钳到 600000', 'enter=' + r.phases.enter);
  ok(r.render.frames <= 1e7, 'frames 被钳制');
  ok(r.render.avgFps === 0, '负 avgFps 被钳到 0');
  ok(r.render.jankPct <= 100, 'jankPct 被钳到 ≤100', 'jankPct=' + r.render.jankPct);
  ok(r.device.ua.length <= 300, 'UA 限长 300', 'len=' + r.device.ua.length);
  ok(r.device.dpr === 3, 'dpr 保留');
  ok(r.device.memGB === 0, '负 memGB 被钳到 0');
  ok(r.device.msaa === true, 'msaa 真值化（1 → true）');
  ok(r.ctx.gpu.length <= 160, 'gpu 字符串限长 160');
  ok(typeof r.ctx.shadow === 'boolean', 'shadow 真值化为 boolean');
  ok(r.serverTs > 0, '带服务端时间戳');
  // 非法输入不炸
  const r2 = sanitize({}, '');
  ok(r2 && typeof r2.id === 'string', '空对象输入不抛，返回结构完整');
}

console.log('');
// ===== 【9】自动上报总开关（telemetryAutoGet/Set + 接线）=====
console.log('\n[9] 自动上报总开关（开关本身 + 接线）');
const teleUrl = pathToFileURL(path.join(ROOT, 'src/util/Telemetry.js')).href;
const Tele = await import(teleUrl);
ok(Tele.telemetryAutoGet() === true, '默认（node 无 localStorage）开启自动上报');
let setThrew = false;
try { Tele.telemetryAutoSet(false); Tele.telemetryAutoSet(true); } catch (e) { setThrew = true; }
ok(!setThrew, 'telemetryAutoSet 不抛（node 无 localStorage 时静默）');
const sp = read('src/ui/SettingsPanel.js');
ok(/id:\s*'telemetryAuto'/.test(sp) && /kind:\s*'toggle'/.test(sp), 'SettingsPanel 有 telemetryAuto 持久化 toggle 项');
ok(/telemetryAutoGet\(\)/.test(sp), 'SettingsPanel 用真实开关值初始化显示');
const game = read('src/core/Game.js');
ok(/telemetryAuto:\s*\(v\)\s*=>/.test(game), 'Game binds 接了 telemetryAuto（切换即持久化）');
ok(/_telemetryAutoEnabled\(\)\s*\{[^}]*return telemetryAutoGet\(\)/.test(game), 'Game 有 _telemetryAutoEnabled 读开关');
const mainJs = read('src/main.js');
ok(/_telemetryAutoEnabled\(\)/.test(mainJs), 'main.js 进游戏时读开关决定是否自动采集');
ok(/_telParam\s*===\s*'0'\s*\?\s*false/.test(mainJs), '?tel=0 强制关优先级最高');

console.log('');
if (fails) { console.log('✗ 数据采集探针失败 ' + fails + ' 项'); process.exit(1); }
console.log('✓ 数据采集探针全部通过');
