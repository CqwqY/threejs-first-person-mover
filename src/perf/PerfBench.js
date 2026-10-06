// 场景性能测试台：在「真实的线上场景」里跑一组对照实验，逐帧采样并导出。
//
// 为什么独立成一个页面而不是给游戏加埋点：游戏主循环里掺着网络同步、玩家物理、聊天 UI，
// 噪声太大、且无法复现。这里只保留渲染相关的真实开销（地形 + 编辑器建筑 + 编辑器灯 + 天空 IBL
// + 太阳/环境光），再配一条确定性相机航点，保证每次跑的取景一致、可对比。
//
// ⚠ 三条项目铁律（本文件必须遵守）：
//   1. 有阴影的灯「数量」必须恒定 —— 绝不在帧循环里改灯的 castShadow / visible，
//      两者都会改变 three.js 的 numPointLightShadows，触发全场材质重编译。
//      关灯只允许改 intensity（见 no-light 场景）。
//   2. 帧循环里不重建资源（PMREM / 着色器 / 几何合并）—— 全部只在加载期做一次。
//   3. 切换 renderer.shadowMap.enabled 这类会触发重编译的开关，只允许在「场景边界」做，
//      且切换后必须重新 warmup（着色器编译尖峰不能算进统计）。

import * as THREE from 'three';
import { buildScenery } from '../world/buildScenery.js';
import {
  buildEditorBuildings, buildEditorLights, fetchRemoteScene, optimizeEditorScene,
} from '../world/EditorBuildings.js';
import { createLights, updateShadowBudgets } from '../world/Lights.js';
import { createTimeSky } from '../world/SkyBox.js';
import { DEFAULT_SETTINGS } from '../ui/SettingsPanel.js';
import { summarize, diffVs, samplesToCSV, summaryToCSV, download, stamp } from './metrics.js';

// ---------------- 确定性相机航点（保证多次运行取景一致）----------------
// 沿折线匀速前进，视线看向前方一点。地图量级参考审计报告：约 232×330m。
const WAYPOINTS = [
  [0, 2.2, 0],
  [70, 2.2, 50],
  [110, 2.2, -40],
  [-30, 2.2, -70],
  [-95, 2.2, 30],
];
const CAM_SPEED = 8; // 米/秒
const LOOK_AHEAD = 12; // 视线前视距离（米）

function buildPath(points) {
  const segs = [];
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    const a = new THREE.Vector3(...points[i]);
    const b = new THREE.Vector3(...points[(i + 1) % points.length]); // 首尾相连成环
    const len = a.distanceTo(b);
    segs.push({ a, b, len, start: total });
    total += len;
  }
  return { segs, total };
}

function samplePath(path, d, out) {
  const dd = ((d % path.total) + path.total) % path.total;
  for (const s of path.segs) {
    if (dd >= s.start && dd <= s.start + s.len) {
      const k = s.len > 0 ? (dd - s.start) / s.len : 0;
      return out.copy(s.a).lerp(s.b, k);
    }
  }
  return out.copy(path.segs[0].a);
}

// ---------------- 全局状态 ----------------
const UI = {};
let renderer = null;
let scene = null;
let camera = null;
let lightsBundle = null;
let sky = null;
let editorLightsGroup = null;
let path = null;

const state = {
  ready: false,
  running: false,
  rafId: 0,
  dist: 0,          // 相机沿航点已走过的距离
  yaw: 0,           // 固定机位模式的水平朝向（弧度，FIXED_VIEW 时每帧自增）
  lastT: 0,         // 上一帧开始时间（用于算真实帧间隔）
  scenarioIdx: -1,
  scenarioStart: 0,
  warmupMs: 1500,
  durationMs: 8000,
  baseScale: 1,
  timeOfDay: 0.5,   // 0=00:00 0.5=12:00，固定不推进，保证可比
  buildColliders: true,
  samples: [],      // 全部原始样本（含 scenario 字段）
  summaries: [],
  programsAtStart: 0,
  loadTimings: {},
  env: {},
};

// 正在生效的场景开关（用于结束后还原）
const active = { shadow: true, lightsOn: true, skyEnv: true, scale: 1 };

const SCENARIOS = [
  { id: 'baseline', name: '基线（原样）' },
  { id: 'no-shadow', name: 'E1 关阴影' },
  { id: 'no-light', name: 'E2 编辑器灯全灭' },
  { id: 'no-area', name: 'E3 只关面光源(3 盏 LTC)' },
  { id: 'no-sky-env', name: 'E4 关天空环境反射' },
  { id: 'low-res', name: 'E5 分辨率 0.5×' },
  { id: 'res-075', name: 'E6 分辨率 0.75×' },
];

// ---------------- 场景构建 ----------------
async function buildScene() {
  const t0 = performance.now();
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, DEFAULT_SETTINGS.viewFar || 300);

  renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(state.baseScale);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = DEFAULT_SETTINGS.exposure ?? 0.85;
  UI.stage.appendChild(renderer.domElement);
  log('渲染器已创建：pixelRatio=' + state.baseScale);

  // 1) 地形/地面（阴影成本的大头，必须包含）
  let t = performance.now();
  const roots = buildScenery(scene);
  state.loadTimings.scenery = Math.round(performance.now() - t);

  // 2) 场景数据：优先线上真实数据，失败回退打包数据
  let data = null;
  try {
    data = await fetchRemoteScene();
  } catch (e) {
    data = null;
  }
  state.env.dataSource = data ? '远端 /api/scene' : '本地打包 editorMapData';
  log('场景数据来源：' + state.env.dataSource);

  // 3) 编辑器建筑（碰撞体可选，用于对比构建耗时）
  t = performance.now();
  const colliders = [];
  buildEditorBuildings(scene, roots, data, state.buildColliders ? colliders : null);
  state.loadTimings.buildings = Math.round(performance.now() - t);
  state.loadTimings.colliders = colliders.length;

  // 4) 太阳 / 环境光 / 半球光
  lightsBundle = createLights();
  scene.add(lightsBundle.group);

  // 5) 编辑器摆放的光源
  t = performance.now();
  editorLightsGroup = buildEditorLights(scene, data);
  state.loadTimings.lights = Math.round(performance.now() - t);
  let lightCount = 0;
  if (editorLightsGroup) editorLightsGroup.traverse((o) => { if (o.isLight) lightCount++; });
  state.env.lightCount = lightCount;

  // 6) 天空 + 环境反射（PMREM 只在加载期建一次，绝不能进帧循环）
  t = performance.now();
  sky = createTimeSky(scene, renderer, { ambientRef: () => lightsBundle.ambient.intensity });
  state.loadTimings.sky = Math.round(performance.now() - t);

  // 7) 距离分级登记（与游戏一致的 LOD 行为）
  try {
    await optimizeEditorScene(scene);
  } catch (e) {
    log('场景优化跳过：' + e.message);
  }

  state.loadTimings.total = Math.round(performance.now() - t0);
  path = buildPath(WAYPOINTS);
  state.ready = true;
  log('场景就绪，总加载耗时 ' + state.loadTimings.total + 'ms；光源 ' + lightCount + ' 盏（含阴影代理）');
  setControlsEnabled(true);
}

// ---------------- 场景开关（只在场景边界调用）----------------
function applyScenario(id) {
  // 先完整还原上一个场景的所有状态
  renderer.shadowMap.enabled = true;
  active.shadow = true;
  restoreLights();
  active.skyEnv = true; // 恢复环境反射开关（下面 sky.update 会把 environment 与强度设回去）
  if (sky) sky.update(state.timeOfDay, camera);
  renderer.setPixelRatio(state.baseScale);

  if (id === 'no-shadow') {
    // 关阴影：会触发一次着色器重编译（programs 数会变），靠 warmup 消化掉
    renderer.shadowMap.enabled = false;
    active.shadow = false;
  } else if (id === 'no-light') {
    // ⚠ 只改 intensity：改 castShadow / visible 会改变带阴影灯的数量 → 全场材质重编译
    dimLights();
  } else if (id === 'no-area') {
    // 只关面光源（RectAreaLight，本场景 3 盏）：它走 LTC 模型 —— 每像素要查 LTC 矩阵纹理，
    // 是「逐像素光照」里最贵的一档。单独隔离它，用来判断填充率瓶颈里有多少是面光贡献的。
    // ⚠ 只改 intensity（不改 visible/castShadow），避免动到「带阴影灯的数量」触发全场重编译。
    dimLights((o) => o.isRectAreaLight);
  } else if (id === 'no-sky-env') {
    // 关天空 IBL：金属/光滑材质不再采样环境贴图，用于隔离环境反射的着色成本
    scene.environment = null;
    if ('environmentIntensity' in scene) scene.environmentIntensity = 0;
    active.skyEnv = false;
  } else if (id === 'low-res') {
    renderer.setPixelRatio(state.baseScale * 0.5);
  } else if (id === 'res-075') {
    // 0.75×：像素数 -44%。用来找「画质与帧率的甜点」，0.5× 太糊时可以落在这里
    renderer.setPixelRatio(state.baseScale * 0.75);
  }
}

function dimLights(filter) {
  if (!editorLightsGroup) return;
  editorLightsGroup.traverse((o) => {
    if (!o.isLight) return;
    if (filter && !filter(o)) return; // 传了过滤（如只关面光源）就只动匹配的那些
    if (o.userData.__perfBase === undefined) o.userData.__perfBase = o.intensity; // 存原件，便于还原
    o.intensity = 0;
  });
}

function restoreLights() {
  if (!editorLightsGroup) return;
  editorLightsGroup.traverse((o) => {
    if (!o.isLight) return;
    if (o.userData.__perfBase !== undefined) {
      o.intensity = o.userData.__perfBase;
      delete o.userData.__perfBase;
    }
  });
}

// ---------------- 每帧 ----------------
const _camPos = new THREE.Vector3();
const _camAhead = new THREE.Vector3();

// ---- 固定机位模式（2026-10-06 用户指定）----
// 把相机钉在 (0, 77) 原地**缓慢旋转**，用来稳定复现「朝向决定卡不卡」的现象：
// 朝空地方向帧率立刻回升、转到建筑那侧就开始掉 —— 说明瓶颈随**可见几何量**走
// （填充率 / draw call / 阴影 pass 的物体数），而不是随位置或时间走。
// 固定机位的好处是两次跑（改前 / 改后）能拿到**可逐帧对齐**的数据，不受路径漂移干扰。
// ⚠ 想回到原来的航点巡航模式：把 FIXED_VIEW 改成 false 即可。
const FIXED_VIEW = true;
const FIXED_POS = { x: 0, y: 1.7, z: 77 }; // 眼高 1.7m
const FIXED_YAW_SPEED = 0.15;              // 弧度/秒 ≈ 8.6°/s → 转一圈约 42 秒（"缓慢"）

function renderFrame(dtSec) {
  if (FIXED_VIEW) {
    state.yaw = (state.yaw || 0) + FIXED_YAW_SPEED * dtSec;
    camera.position.set(FIXED_POS.x, FIXED_POS.y, FIXED_POS.z);
    // 朝向约定与游戏一致：前方 = (-sin yaw, 0, -cos yaw)
    _camAhead.set(
      FIXED_POS.x - Math.sin(state.yaw) * 10,
      FIXED_POS.y,
      FIXED_POS.z - Math.cos(state.yaw) * 10
    );
    camera.lookAt(_camAhead);
  } else {
    // 相机沿航点前进（确定性）
    state.dist += CAM_SPEED * dtSec;
    samplePath(path, state.dist, _camPos);
    camera.position.copy(_camPos);
    samplePath(path, state.dist + LOOK_AHEAD, _camAhead);
    camera.lookAt(_camAhead);
  }

  // 与游戏一致：阴影相机以 sunTarget 为中心跟随相机，点/面光源阴影名额按距离分配
  lightsBundle.sunTarget.position.copy(camera.position);
  lightsBundle.sun.position.copy(lightsBundle.sunTarget.position).add(lightsBundle.offset);
  updateShadowBudgets(camera.position);

  // 首帧一次性预编译所有材质变体（含阴影），避免基准档把"首帧重编译"算进统计。
  // 与游戏的 Game._precompileShaders 同源思路；编译发生在 warmup 内（首帧），不计入帧耗时。
  if (!state.compiled) {
    try { if (renderer && typeof renderer.compile === 'function') renderer.compile(scene, camera); } catch (e) {}
    state.compiled = true;
  }

  // 天空与环境反射（固定时刻，不推进昼夜）。关环境反射的场景要跳过 update，
  // 否则 sky.update 每帧会把 scene.environment 又设回去，开关就白关了。
  if (sky && active.skyEnv) sky.update(state.timeOfDay, camera);

  renderer.render(scene, camera);
}

function tick(now) {
  if (!state.running) return;
  state.rafId = requestAnimationFrame(tick);

  // 真实帧间隔 = 相邻两帧开始时刻之差（含 rAF 调度，比只测 render() 更能反映卡顿）
  const ms = state.lastT ? (now - state.lastT) : 0;
  state.lastT = now;

  const dtSec = Math.min(0.1, ms / 1000);
  renderFrame(dtSec);

  const elapsed = now - state.scenarioStart;
  if (elapsed < state.warmupMs) {
    // warmup：跳过统计，消化着色器编译尖峰
    const sc = SCENARIOS[state.scenarioIdx];
    UI.prog.textContent = sc.name + ' · 预热中 ' + ((state.warmupMs - elapsed) / 1000).toFixed(1) + 's';
    return;
  }

  if (ms > 0) collectSample(now, ms, elapsed);

  const sc = SCENARIOS[state.scenarioIdx];
  const left = (state.warmupMs + state.durationMs - elapsed) / 1000;
  UI.prog.textContent = sc.name + ' · 采样中 ' + Math.max(0, left).toFixed(1) + 's';

  if (elapsed >= state.warmupMs + state.durationMs) finishScenario();
}

function collectSample(now, ms, elapsed) {
  const info = renderer.info;
  const sc = SCENARIOS[state.scenarioIdx];
  const programs = info.programs ? info.programs.length : 0;
  state.samples.push({
    scenario: sc.id,
    t: Math.round(elapsed),
    ms: round2(ms),
    fps: round2(1000 / ms),
    calls: info.render.calls,
    tris: info.render.triangles,
    programs,
    geometries: info.memory.geometries,
    textures: info.memory.textures,
    heap: (performance.memory && performance.memory.usedJSHeapSize) || null,
    x: round2(camera.position.x), y: round2(camera.position.y), z: round2(camera.position.z),
  });

  const s = state.samples[state.samples.length - 1];
  UI.fps.textContent = s.fps.toFixed(0);
  UI.ms.textContent = s.ms.toFixed(1);
  UI.calls.textContent = s.calls;
  UI.tris.textContent = s.tris.toLocaleString();
  UI.progs.textContent = programs + (programs - state.programsAtStart > 0 ? ' (+' + (programs - state.programsAtStart) + ')' : '');
  if (s.heap) UI.heap.textContent = (s.heap / 1048576).toFixed(0);
  drawChart();
}

function round2(v) { return Math.round(v * 100) / 100; }

// ---------------- 流程控制 ----------------
function start() {
  if (!state.ready || state.running) return;
  state.samples = [];
  state.summaries = [];
  state.scenarioIdx = -1;
  state.dist = 0;
  state.yaw = 0;      // 与 nextScenario 一致：从同一朝向开跑，各场景才可比
  state.lastT = 0;
  state.compiled = false;
  setControlsEnabled(false);
  UI.btnStop.disabled = false;
  // 一次性预编译基准（阴影开）的全部材质变体，与 Game._precompileShaders 同源。
  // 必须在记录 programsAtStart 之前完成，否则基准档会把"首帧编译"误算成 +7 重编译假象。
  try {
    applyScenario('baseline');
    updateShadowBudgets(camera.position);
    if (renderer && typeof renderer.compile === 'function') renderer.compile(scene, camera);
  } catch (e) {}
  state.compiled = true;
  nextScenario();
}

function nextScenario() {
  state.scenarioIdx++;
  if (state.scenarioIdx >= SCENARIOS.length) { finishAll(); return; }
  const sc = SCENARIOS[state.scenarioIdx];
  applyScenario(sc.id);
  // ⚠⚠ 每个场景必须从**同一个机位与朝向**重新开始，否则各场景看到的世界完全不同、数据不可比。
  //   上一版只重置了航点距离、没重置 yaw：固定机位模式下 5 个场景各自扫过 69° 的**不同扇区**，
  //   avgTris 在 45k~131k 之间乱跳，于是得出了"关阴影反而更慢"这种假结论（实际是朝向不同）。
  state.yaw = 0;
  state.dist = 0;
  state.scenarioStart = performance.now();
  state.lastT = 0;
  // 记录本场景开始时的 program 数量，用于探测重编译
  state.programsAtStart = renderer.info.programs ? renderer.info.programs.length : 0;
  state.running = true;
  state.rafId = requestAnimationFrame(tick);
}

function finishScenario() {
  state.running = false;
  cancelAnimationFrame(state.rafId);
  const sc = SCENARIOS[state.scenarioIdx];
  const own = state.samples.filter((s) => s.scenario === sc.id);
  const programsEnd = renderer.info.programs ? renderer.info.programs.length : 0;
  const sum = summarize(sc.name, own, state.programsAtStart, programsEnd);
  state.summaries.push(sum);
  renderTable();
  log(sc.name + '：平均 ' + sum.avgFps + ' FPS，p50 ' + sum.p50Ms + 'ms，最大 ' + sum.maxMs +
    'ms，draw call ' + sum.avgCalls + '，卡顿帧 ' + sum.jankFrames + ' 帧' +
    (sum.programsDelta ? '，⚠着色器 +' + sum.programsDelta : ''));
  setTimeout(nextScenario, 120); // 留一点间隔，避免状态切换与上一帧重叠
}

function finishAll() {
  state.running = false;
  setControlsEnabled(true);
  UI.btnStop.disabled = true;
  // 还原到基线状态，便于手动再看画面
  applyScenario('baseline');
  if (sky) sky.update(state.timeOfDay, camera);
  renderFrame(0);
  UI.prog.textContent = '测试完成 · 共 ' + state.summaries.length + ' 个场景';
  log('全部场景跑完，可导出结果。');
  drawChart();
}

function stop() {
  state.running = false;
  cancelAnimationFrame(state.rafId);
  setControlsEnabled(true);
  UI.btnStop.disabled = true;
  UI.prog.textContent = '已手动停止';
  log('已停止。');
}

// ---------------- 结果展示 ----------------
function renderTable() {
  const base = state.summaries[0];
  const rows = state.summaries.map((s) => {
    const d = diffVs(base, s);
    const dTxt = d ? (d.fps >= 0 ? '+' : '') + d.fps.toFixed(1) + ' FPS (' + (d.fpsPct >= 0 ? '+' : '') + d.fpsPct + '%)' : '—';
    const dCall = d ? (d.calls >= 0 ? '+' : '') + d.calls : '—';
    return '<tr><td>' + s.scenario + '</td><td>' + s.frames + '</td><td><b>' + s.avgFps + '</b></td><td>' +
      s.p50Ms + '</td><td>' + s.p95Ms + '</td><td>' + s.maxMs + '</td><td>' + s.jankFrames + ' (' + s.jankPct + '%)</td><td>' +
      s.avgCalls + '</td><td>' + s.avgTris.toLocaleString() + '</td><td>' +
      (s.programsDelta ? '<span class="warn">+' + s.programsDelta + '</span>' : '0') + '</td><td>' + dTxt + '</td><td>' + dCall + '</td></tr>';
  }).join('');
  UI.tbody.innerHTML = rows;
}

function drawChart() {
  const c = UI.chart;
  const ctx = c.getContext('2d');
  const W = c.width, H = c.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0e1420';
  ctx.fillRect(0, 0, W, H);

  // 参考线：16.7ms(60fps) / 33.3ms(30fps)
  const maxMs = 60;
  const yOf = (ms) => H - Math.min(1, ms / maxMs) * H;
  ctx.strokeStyle = '#2a3a52';
  ctx.setLineDash([4, 4]);
  for (const [v, label] of [[16.7, '60fps'], [33.3, '30fps']]) {
    ctx.beginPath(); ctx.moveTo(0, yOf(v)); ctx.lineTo(W, yOf(v)); ctx.stroke();
    ctx.fillStyle = '#5c6b82';
    ctx.fillText(label + ' (' + v + 'ms)', 4, yOf(v) - 3);
  }
  ctx.setLineDash([]);

  const list = state.samples.slice(-240);
  if (list.length < 2) return;
  const step = W / (list.length - 1);
  ctx.strokeStyle = '#4ea1ff';
  ctx.beginPath();
  list.forEach((s, i) => {
    const y = yOf(s.ms);
    if (i === 0) ctx.moveTo(0, y); else ctx.lineTo(i * step, y);
  });
  ctx.stroke();
}

// ---------------- 导出 ----------------
function buildExport() {
  return {
    meta: {
      exportedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      screen: window.screen.width + 'x' + window.screen.height,
      devicePixelRatio: window.devicePixelRatio,
      renderScale: state.baseScale,
      timeOfDay: state.timeOfDay,
      warmupMs: state.warmupMs,
      durationMs: state.durationMs,
      dataSource: state.env.dataSource,
      lightCount: state.env.lightCount,
      waypoints: WAYPOINTS,
      loadTimings: state.loadTimings,
      renderer: {
        shadowMapEnabled: renderer.shadowMap.enabled,
        toneMapping: 'ACESFilmic',
        exposure: renderer.toneMappingExposure,
        pixelRatio: renderer.getPixelRatio(),
      },
    },
    summaries: state.summaries,
    samples: state.samples,
  };
}

function exportJSON() {
  if (!state.summaries.length) { log('还没有可导出的数据，先跑一次测试。'); return; }
  download('fpm-perf-' + stamp() + '.json', JSON.stringify(buildExport(), null, 2), 'application/json');
}

function exportCSV() {
  if (!state.summaries.length) { log('还没有可导出的数据，先跑一次测试。'); return; }
  // 两个文件：摘要 + 逐帧原始样本
  download('fpm-perf-summary-' + stamp() + '.csv', summaryToCSV(state.summaries), 'text/csv');
  setTimeout(() => download('fpm-perf-frames-' + stamp() + '.csv', samplesToCSV(state.samples), 'text/csv'), 300);
}

async function copySummary() {
  if (!state.summaries.length) { log('还没有可复制的数据，先跑一次测试。'); return; }
  const base = state.summaries[0];
  const lines = state.summaries.map((s) => {
    const d = diffVs(base, s);
    return s.scenario + ' | ' + s.avgFps + ' FPS | p50 ' + s.p50Ms + 'ms | p95 ' + s.p95Ms + 'ms | max ' + s.maxMs +
      'ms | 卡顿 ' + s.jankFrames + '帧(' + s.jankPct + '%) | draw ' + s.avgCalls +
      (d ? ' | vs基线 ' + (d.fps >= 0 ? '+' : '') + d.fps.toFixed(1) + 'FPS' : '');
  });
  const txt = ['# fpm 性能测试 ' + new Date().toLocaleString(), '数据源: ' + state.env.dataSource,
    '加载耗时(ms): ' + JSON.stringify(state.loadTimings), ''].concat(lines).join('\n');
  try {
    await navigator.clipboard.writeText(txt);
    log('摘要已复制到剪贴板。');
  } catch (e) {
    log('复制失败（可能是权限），摘要已输出到控制台。');
    console.log(txt);
  }
}

// ---------------- UI 绑定 ----------------
function log(msg) {
  const el = UI.log;
  el.textContent += '[' + new Date().toLocaleTimeString() + '] ' + msg + '\n';
  el.scrollTop = el.scrollHeight;
}

function setControlsEnabled(on) {
  UI.btnStart.disabled = !on;
  [UI.selDuration, UI.selScale, UI.selTime, UI.chkColliders].forEach((e) => { if (e) e.disabled = !on; });
}

function readControls() {
  state.durationMs = Number(UI.selDuration.value) * 1000;
  state.baseScale = Number(UI.selScale.value);
  state.timeOfDay = Number(UI.selTime.value);
  if (renderer) renderer.setPixelRatio(state.baseScale);
}

function bind() {
  UI.btnStart.onclick = () => { readControls(); start(); };
  UI.btnStop.onclick = stop;
  UI.btnJson.onclick = exportJSON;
  UI.btnCsv.onclick = exportCSV;
  UI.btnCopy.onclick = copySummary;
  window.addEventListener('resize', () => {
    if (!renderer || !camera) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

function init() {
  const id = (s) => document.getElementById(s);
  Object.assign(UI, {
    stage: id('stage'), chart: id('chart'), log: id('log'), tbody: id('tbody'),
    btnStart: id('btnStart'), btnStop: id('btnStop'), btnJson: id('btnJson'), btnCsv: id('btnCsv'), btnCopy: id('btnCopy'),
    selDuration: id('selDuration'), selScale: id('selScale'), selTime: id('selTime'), chkColliders: id('chkColliders'),
    fps: id('statFps'), ms: id('statMs'), calls: id('statCalls'), tris: id('statTris'), progs: id('statProgs'),
    heap: id('statHeap'), prog: id('prog'), src: id('src'),
  });
  bind();
  readControls();
  state.buildColliders = UI.chkColliders.checked;
  setControlsEnabled(false);
  buildScene().then(() => {
    if (UI.src) UI.src.textContent = state.env.dataSource;
  }).catch((e) => {
    log('场景构建失败：' + (e && e.message ? e.message : e));
    console.error(e);
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
