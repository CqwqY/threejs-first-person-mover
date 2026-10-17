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
const setRes = document.getElementById('setRes');
const setName = document.getElementById('setName');
const btnFrames = document.getElementById('btnFrames');

let renderer, scene, camera, director, timeline, recorder;
let editRunning = false;
let scrubbing = false;          // 用户正在拖动时间轴（覆盖自由飞行，预览插值）
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

  director = new DirectorCam(camera, canvas);
  timeline = new Timeline();
  recorder = new Recorder(canvas);

  syncSettings();
  bindUI();

  // 加载场景
  loadText.textContent = '正在构建校园场景（含服务器场景）…';
  await buildCampusScene(scene, renderer);
  loadOverlay.style.display = 'none';
  loadText.textContent = '';

  startEditLoop();
}

function syncSettings() {
  timeline.fps = parseInt(setFps.value, 10) || 30;
  timeline.duration = parseFloat(setDur.value) || 5;
  timeSlider.max = String(timeline.duration);
  timeSlider.step = (1 / timeline.fps).toFixed(4);
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
  setDur.addEventListener('change', () => { syncSettings(); refreshKeyMarks(); });

  // 时间轴：拖动时预览插值位姿（覆盖自由飞行），松开后恢复自由控制
  timeSlider.addEventListener('input', () => {
    scrubbing = true;
    timeLabel.textContent = `t = ${timeSlider.value}s`;
    const t = parseFloat(timeSlider.value);
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
    label.textContent = `t=${k.t.toFixed(2)}s`;
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
  const max = timeline.duration;
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
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// 进入渲染模式并按关键帧插值逐帧抓图，帧存进 recorder.frames。
async function renderFrames() {
  if (timeline.keys.length < 2) {
    throw new Error('至少需要 2 个关键帧才能插值渲染。');
  }
  editRunning = false; // 停编辑循环
  scrubbing = false;
  modeBadge.textContent = '渲染模式';
  hint.style.display = 'none';

  syncSettings();
  const fps = timeline.fps;
  const total = Math.max(2, Math.round(fps * timeline.duration));

  // 按所选分辨率设置渲染尺寸（不更新 CSS 显示尺寸，保持全屏缩放）
  const [rw, rh] = (setRes.value || '').split('x').map((n) => parseInt(n, 10));
  if (rw && rh) {
    renderer.setPixelRatio(1);
    renderer.setSize(rw, rh, false);
    camera.aspect = rw / rh;
    camera.updateProjectionMatrix();
  }

  renderPanel.style.display = 'block';
  recorder.frames = [];
  for (let i = 0; i < total; i++) {
    const t = i / fps;
    timeline.sampleAt(t, _sampleOut);
    applySample();
    renderer.render(scene, camera);
    const blob = await recorder.grabFrame(); // 画好一帧，抓一帧
    recorder.frames.push(blob);
    const p = Math.round(((i + 1) / total) * 100);
    renderBar.style.width = p + '%';
    renderLabel.textContent = `逐帧渲染 ${p}%  (${i + 1}/${total})`;
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
  try {
    await renderFrames();
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
