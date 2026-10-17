// 影片导演单页入口：加载校园场景 → 自由飞行打关键帧 → 逐帧渲染 → ffmpeg 合成导出。
// 不依赖登录 / 联机 / 游戏内 UI，纯前端。
import * as THREE from 'three';
import { buildCampusScene } from './sceneBuilder.js';
import { DirectorCam } from './DirectorCam.js';
import { Timeline } from './timeline.js';
import { Recorder } from './Recorder.js';

const canvas = document.getElementById('view');
const loadOverlay = document.getElementById('loadOverlay');
const loadText = document.getElementById('loadText');
const modeBadge = document.getElementById('modeBadge');
const hint = document.getElementById('hint');
const timeSlider = document.getElementById('timeSlider');
const timeLabel = document.getElementById('timeLabel');
const keyList = document.getElementById('keyList');
const btnKey = document.getElementById('btnKey');
const btnRender = document.getElementById('btnRender');
const renderPanel = document.getElementById('renderPanel');
const renderBar = document.getElementById('renderBar');
const renderLabel = document.getElementById('renderLabel');
const setFps = document.getElementById('setFps');
const setDur = document.getElementById('setDur');
const frameCount = document.getElementById('frameCount');
const setRes = document.getElementById('setRes');
const setName = document.getElementById('setName');
const btnFrames = document.getElementById('btnFrames');

let renderer, scene, camera, director, timeline, recorder;
let lights = null;              // buildCampusScene 返回的灯光（含太阳、sunTarget、offset）
let timeSky = null;             // buildCampusScene 返回的天空（需每帧 update 才显形）
let editRunning = false;
let scrubbing = false;          // 用户正在拖动时间轴（覆盖自由飞行，预览插值）
const CINEMATIC_TIME = 0.5;     // 影片默认时段：正午（白天，最亮、天空盒最清晰）
const _sampleOut = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), fov: 70 };
const clock = new THREE.Clock();

init();

async function init() {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 2000);
  camera.position.set(0, 6, 24);

  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: true, // 逐帧 toBlob 抓帧必须
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // 阴影：游戏里默认开 PCFSoft，影片要真实光照就必须开
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  director = new DirectorCam(camera, canvas);
  timeline = new Timeline();
  recorder = new Recorder(canvas);

  syncSettings();
  bindUI();

  // 加载场景
  loadText.textContent = '正在构建校园场景（含服务器场景）…';
  const built = await buildCampusScene(scene, renderer);
  lights = built.lights;
  timeSky = built.timeSky;
  setupLightsAndShadows();
  loadOverlay.style.display = 'none';
  loadText.textContent = '';

  startEditLoop();
}

// 让影片场景拥有与游戏一致的实时光照 + 阴影：
//   · 太阳方向光默认只照「第 1 层」（游戏用 enableDynamicLighting 把物体挪到层 1 来接光）；
//     影片里物体都在第 0 层，反向把太阳扩到第 0 层，省去改物体层 + 相机层，效果一致更直接。
//   · 给所有非天空网格开启投影 / 接收阴影（地面只收、建筑收发都开）。
function setupLightsAndShadows() {
  if (lights && lights.sun) lights.sun.layers.enable(0);
  scene.traverse((o) => {
    if (o.isMesh && o.material && o.material.side !== THREE.BackSide) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
}

// 每帧渲染前：把阴影太阳跟随相机（让阴影覆盖当前取景区），并刷新天空盒/环境反射。
function framePreRender() {
  if (lights && lights.sunTarget) {
    lights.sunTarget.position.copy(camera.position);
    lights.sun.position.copy(camera.position).add(lights.offset);
  }
  if (timeSky) timeSky.update(CINEMATIC_TIME, camera);
}

function syncSettings() {
  timeline.fps = parseInt(setFps.value, 10) || 30;            // 每秒渲染多少帧（密度）
  timeline.duration = Math.max(0.1, parseFloat(setDur.value) || 5); // 镜头总时长（秒）
  const total = timeline.totalFrames;                        // = round(fps × 时长)
  if (timeSlider) {
    timeSlider.max = timeline.duration.toFixed(4);
    timeSlider.step = (1 / timeline.fps).toFixed(4);
  }
  if (frameCount) {
    frameCount.textContent = `总帧数: ${total}（${timeline.fps}fps × ${timeline.duration}s）`;
  }
  refreshKeyList();
  refreshKeyMarks();
}

function bindUI() {
  window.addEventListener('resize', () => {
    if (editRunning) {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight, false);
    }
  });

  setFps.addEventListener('change', syncSettings);
  setDur.addEventListener('change', syncSettings);

  // 时间轴：拖动时预览插值位姿（覆盖自由飞行），松开后恢复自由控制
  timeSlider.addEventListener('input', () => {
    scrubbing = true;
    const t = parseFloat(timeSlider.value);
    const frame = Math.round(t * timeline.fps);
    timeLabel.textContent = `t = ${t.toFixed(2)}s（帧 ${frame}）`;
    if (timeline.sampleAt(t, _sampleOut)) applySample();
  });
  timeSlider.addEventListener('change', () => { scrubbing = false; });

  btnKey.addEventListener('click', addKeyAtCursor);
  btnRender.addEventListener('click', renderAndExport);
  btnFrames.addEventListener('click', exportFrames);
}

function addKeyAtCursor() {
  const t = parseFloat(timeSlider.value);
  timeline.setKey(t, director.getState());
  refreshKeyList();
  refreshKeyMarks();
}

function applySample() {
  camera.position.copy(_sampleOut.pos);
  camera.quaternion.copy(_sampleOut.quat);
  if (Math.abs(_sampleOut.fov - camera.fov) > 1e-3) {
    camera.fov = _sampleOut.fov;
    camera.updateProjectionMatrix();
  }
}

function refreshKeyList() {
  keyList.innerHTML = '';
  if (timeline.keys.length === 0) {
    const li = document.createElement('div');
    li.className = 'key-empty';
    li.textContent = '还没有关键帧 — 调好机位后点「打关键帧」';
    keyList.appendChild(li);
    return;
  }
  timeline.keys.forEach((k) => {
    const item = document.createElement('div');
    item.className = 'key-item';
    const label = document.createElement('span');
    const frame = Math.round(k.t * timeline.fps);
    label.textContent = `t = ${k.t.toFixed(2)}s（帧 ${frame}）`;
    const del = document.createElement('button');
    del.textContent = '删除';
    del.addEventListener('click', () => {
      timeline.removeKeyAt(k.t);
      refreshKeyList();
      refreshKeyMarks();
    });
    item.appendChild(label);
    item.appendChild(del);
    keyList.appendChild(item);
  });
}

// 在时间轴上方画关键帧小标记
function refreshKeyMarks() {
  const marks = document.getElementById('keyMarks');
  marks.innerHTML = '';
  const max = timeline.duration || 1;
  timeline.keys.forEach((k) => {
    const dot = document.createElement('div');
    dot.className = 'key-dot';
    dot.style.left = (k.t / max * 100) + '%';
    marks.appendChild(dot);
  });
}

function startEditLoop() {
  editRunning = true;
  modeBadge.textContent = '编辑模式';
  hint.style.display = '';
  const tick = () => {
    if (!editRunning) return;
    const dt = Math.min(clock.getDelta(), 0.1);
    if (!scrubbing) director.update(dt); // 拖动时间轴时由插值接管
    framePreRender();
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// 进入渲染模式并按关键帧插值逐帧抓图，帧存进 recorder.frames。
// captureVideo=true 时直接抓 VideoFrame（跳过 PNG 往返，WebCodecs 合成 MP4 专用，快很多）；
// 否则抓 PNG Blob（帧序列导出 / 兜底用）。
async function renderFrames({ captureVideo = false } = {}) {
  if (timeline.keys.length < 2) {
    throw new Error('至少需要 2 个关键帧才能插值渲染。');
  }
  editRunning = false; // 停编辑循环
  scrubbing = false;
  modeBadge.textContent = '渲染模式';
  hint.style.display = 'none';

  syncSettings();
  const fps = timeline.fps;
  // 总帧数 = fps × 时长：fps 翻一倍 → 同样时长内渲染的帧数翻倍 → 画面更平滑（这就是「一秒多少帧」）
  const total = Math.max(2, timeline.totalFrames);
  const frameDur = 1_000_000 / fps; // 微秒（VideoFrame 时间戳用）
  const gl = renderer.getContext();  // 用于渲染后 finish，确保抓到的是当帧而非上一帧

  // 渲染尺寸：
  //  · 明确选了分辨率（如 1080p）→ 按所选像素精确渲染（pixelRatio=1，输出就是该分辨率，不变形不缩水）。
  //  · 「自适应屏幕」→ 保留设备像素比（不降清晰度，导出产物与屏幕同分辨率）。
  //  ⚠ 绝不为提速强制降 pixelRatio：那会直接 lowering 导出画质（用户明确要求不降画面）。
  //    提速度靠的是下面的「直接抓 VideoFrame 跳过 PNG 往返」，而不是砍分辨率。
  const [rw, rh] = (setRes.value || '').split('x').map((n) => parseInt(n, 10));
  if (rw && rh) {
    renderer.setPixelRatio(1);
    renderer.setSize(rw, rh, false);
    camera.aspect = rw / rh;
  } else {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    camera.aspect = window.innerWidth / window.innerHeight;
  }
  camera.updateProjectionMatrix();

  renderPanel.style.display = 'block';
  recorder.frames = [];

  // 心跳 rAF：渲染导出时编辑循环已停，浏览器会因「没有 rAF 消费者」把页面当成空闲，
  // 从而节流任务（PNG 分支表现为必须移动鼠标才推进）。这里只挂心跳保持唤醒，不渲染任何东西。
  let keepAliveId = 0;
  const keepAlive = () => { keepAliveId = requestAnimationFrame(keepAlive); };
  keepAliveId = requestAnimationFrame(keepAlive);
  const yieldFrame = () => new Promise((r) => requestAnimationFrame(r));

  try {
    for (let i = 0; i < total; i++) {
      // 第 i 帧：取 t = i / fps 秒处的相机位姿，再真渲染一次（类似 Blender 逐帧渲染）
      const t = i / fps;
      timeline.sampleAt(t, _sampleOut);
      applySample();
      framePreRender();
      renderer.render(scene, camera);
      if (captureVideo) {
        gl.finish(); // 等 GPU 真正画完当帧再抓，避免抓到上一帧 → 导出视频出现重复帧/顿挫
        // 直接把刚渲染好的画布包成 VideoFrame，省掉「编码 PNG → 解码回帧」的双重开销
        recorder.frames.push(new VideoFrame(canvas, {
          timestamp: Math.round(i * frameDur),
          duration: Math.round(frameDur),
        }));
      } else {
        const blob = await recorder.grabFrame(); // 画好一帧，抓一帧
        recorder.frames.push(blob);
      }
      const p = Math.round(((i + 1) / total) * 100);
      renderBar.style.width = p + '%';
      renderLabel.textContent = `逐帧渲染 ${p}%  (${i + 1}/${total})`;
      if (captureVideo) await yieldFrame(); // 让出主线程：更新进度条 + 保持页面唤醒
    }
  } finally {
    if (keepAliveId) cancelAnimationFrame(keepAliveId);
  }
}

// 渲染后把视口 / 模式还原回编辑态，方便继续拍下一段
function restoreViewport() {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderPanel.style.display = 'none';
  renderBar.style.width = '0%';
  modeBadge.textContent = '编辑模式';
  hint.style.display = '';
  scrubbing = false;
  startEditLoop();
}

// 「渲染并导出」：优先 MP4（WebCodecs→ffmpeg），都不行则降级为帧序列
async function renderAndExport() {
  // WebCodecs 可用就直接抓 VideoFrame（跳过 PNG 往返）；否则抓 PNG，后续走 ffmpeg / 帧序列兜底
  const useVideo = (typeof VideoFrame !== 'undefined' && typeof VideoEncoder !== 'undefined');
  try {
    await renderFrames({ captureVideo: useVideo });
  } catch (e) {
    alert(e.message);
    restoreViewport();
    return;
  }
  const baseName = (setName.value || 'campus_tour').trim();
  renderLabel.textContent = '合成视频中（首次需加载编码器）…';
  let res;
  try {
    res = await recorder.exportVideo({
      fps: timeline.fps,
      baseName,
      captureVideo: useVideo,
      onProgress: (p) => {
        const pp = Math.round(p * 100);
        renderBar.style.width = pp + '%';
        if (pp < 100) renderLabel.textContent = `合成视频 ${pp}%`;
      },
    });
  } catch (e) {
    console.error(e);
    renderLabel.textContent = '导出失败：' + e.message;
    return;
  }

  if (res.method === 'webcodecs') {
    renderLabel.textContent = `导出完成：${baseName}.mp4 已开始下载（WebCodecs）。`;
  } else if (res.method === 'ffmpeg') {
    renderLabel.textContent = '导出完成：cinematic.mp4 已开始下载。';
  } else if (res.method === 'folder') {
    renderLabel.textContent = `导出完成：帧序列已写入你选择的「${baseName}/」文件夹。`;
  } else {
    renderLabel.textContent = `导出完成：${baseName}.zip 已下载（浏览器不支持选文件夹）。`;
  }
  setTimeout(restoreViewport, 900);
}

// 「导出帧序列」：先让你选文件夹（用户手势内），再渲染，最后直接写入 / 打包 ZIP
async function exportFrames() {
  if (timeline.keys.length < 2) {
    alert('至少需要 2 个关键帧才能插值渲染。');
    return;
  }
  const baseName = (setName.value || 'campus_tour').trim();
  // 在用户手势内选文件夹（避免渲染后激活失效）；不支持/取消则降级 ZIP
  let dirHandle = null;
  try {
    dirHandle = await recorder.pickFolder();
  } catch (_) { dirHandle = null; }

  try {
    await renderFrames();
  } catch (e) {
    alert(e.message);
    restoreViewport();
    return;
  }

  renderLabel.textContent = '写入帧序列中…';
  try {
    const res = await recorder.exportFrames({
      dirHandle,
      baseName,
      onProgress: (p) => {
        const pp = Math.round(p * 100);
        renderBar.style.width = pp + '%';
        renderLabel.textContent = `写入帧序列 ${pp}%`;
      },
    });
    if (res.method === 'folder') {
      renderLabel.textContent = `导出完成：帧序列已写入你选择的「${baseName}/」文件夹。`;
    } else {
      renderLabel.textContent = `导出完成：${baseName}.zip 已下载（浏览器不支持选文件夹）。`;
    }
  } catch (e) {
    console.error(e);
    renderLabel.textContent = '导出失败：' + e.message;
    return;
  }
  setTimeout(restoreViewport, 900);
}
