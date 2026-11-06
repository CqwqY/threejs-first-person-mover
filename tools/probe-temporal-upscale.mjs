// 自检：时域超分（TSR）的关键不变量。
//
// 分两层：
//   ① 静态断言 —— Game/SettingsPanel/Config 的接入点、降级路径、预热、复位钩点；
//      以及 shader 里几条「写反了就整屏糊/花」的符号与 NaN 防线。
//   ② Node 里真跑 —— 用真 three 的矩阵/RT 对象 + stub renderer，验证 Halton 相位、
//      投影矩阵恢复、静止场景重投影恒等、历史 ping-pong、失败降级。
//      ⚠ 只验数学与状态机，不验 GLSL 编译（那要浏览器 GL 上下文）。
//
// 跑法：node tools/probe-temporal-upscale.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { TemporalUpscale } from '../src/world/TemporalUpscale.js';
import { Config } from '../src/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
function ok(cond, msg) {
  if (cond) console.log('  PASS  ' + msg);
  else { console.log('  FAIL  ' + msg); fails++; }
}
function eq(a, b, msg) {
  if (a === b) console.log('  PASS  ' + msg + '  (' + a + ')');
  else { console.log('  FAIL  ' + msg + '  got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)); fails++; }
}
function near(a, b, tol, msg) {
  ok(Math.abs(a - b) <= tol, msg + '  (' + a.toFixed(6) + ' vs ' + b.toFixed(6) + ')');
}
// 本项目探针固定坑：slice(indexOf(...)) 会扫到文件末尾。一律花括号配对抽函数体。
function blockAt(src, anchor) {
  const i = src.indexOf(anchor);
  if (i < 0) return '';
  const s = src.indexOf('{', i);
  if (s < 0) return '';
  let d = 0;
  for (let k = s; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); }
  }
  return src.slice(i);
}

const game = fs.readFileSync(path.join(ROOT, 'src/core/Game.js'), 'utf8');
const panel = fs.readFileSync(path.join(ROOT, 'src/ui/SettingsPanel.js'), 'utf8');
const tsr = fs.readFileSync(path.join(ROOT, 'src/world/TemporalUpscale.js'), 'utf8');

// ---------------------------------------------------------------- ① 静态：接入点
console.log('\n[1] Game 接入：两条路径分离、预热、复位、可观测');
const ensureTargets = blockAt(game, '_ensureTargets() {');
ok(ensureTargets.length > 200, '抽到 _ensureTargets 函数体');
ok(/this\._tsr\.ensure\(rw, rh, dw, dh, rtype\)/.test(ensureTargets), 'TSR 尺寸/格式统一由 ensure 管理');
ok(/getDrawingBufferSize\(this\._dispSize\)/.test(ensureTargets), '历史图按真实 drawingBuffer 尺寸建');
ok(/this\._tsrFailed = true/.test(ensureTargets) && /console\.warn/.test(ensureTargets), '建不出来永久降级且出声');
ok(/this\._tsr\.dispose\(\)/.test(ensureTargets), '失败对象连同两张历史 RT 一起释放');
ok(/this\._upRT\.dispose\(\)/.test(ensureTargets) && /this\._upRT = null/.test(ensureTargets), 'TSR 路径不复用 _upRT（防设置面板误 dispose）');

const renderFrame = blockAt(game, '_renderFrame() {');
ok(renderFrame.length > 200, '抽到 _renderFrame 函数体');
ok(/tsr\.beginFrame\(this\.camera\)/.test(renderFrame), '渲染主场景前应用亚像素抖动');
ok(/tsr\.endFrame\(this\.camera\)/.test(renderFrame), '渲染后立即恢复干净投影矩阵');
ok(/tsr\.resolve\(this\.renderer, this\.camera, jitter\)/.test(renderFrame), '时域累积跑在主场景与 present 之间');
ok(/histTex \|\| sceneRT\.texture/.test(renderFrame), 'resolve 失败/首帧退回本帧颜色，不会黑屏');
ok(/this\.renderer\.info\.render\.calls/.test(renderFrame), '统计仍在 resolve/present 之前取');

const applyScale = blockAt(game, '_applyRenderScale(w, h) {');
ok(/this\._ensureTargets\(\)/.test(applyScale), '分辨率/窗口变化走统一 RT 入口');
ok(/this\._tsr\.reset\(\)/.test(applyScale), '退回原生分辨率时清历史');
const warm = blockAt(game, '_precompileShaders() {');
ok(/this\._tsr\.precompile\(r\)/.test(warm), 'resolve 着色器在加载屏预热');
ok(/this\._ensureTargets\(\)/.test(warm), '预热同时把历史 RT 真建出来');
const teleport = blockAt(game, '_markTeleport() {');
ok(/this\._tsr\.reset\(\)/.test(teleport), '重生/传送/换房清历史');
const rescan = blockAt(game, '_rescanLod() {');
ok(/this\._tsr\.reset\(\)/.test(rescan), '世界重建清历史');
const bindTsr = blockAt(game, 'tsr: (v) => {');
ok(/this\._tsrOn = !!v/.test(bindTsr) && /this\._tsr\.reset\(\)/.test(bindTsr), '设置面板开关即时生效且清历史');
ok(/'sharpen', 'tsr', 'antiAlias'/.test(game), 'tsr 在设置面板 fields 里');
ok(/accumFrames/.test(game) && /getMipBias\(\)/.test(game) && /' TSR'/.test(game),
  '性能 HUD 能确认 TSR 生效（累积帧数 + 负 mip bias + 内部比例）');
ok(/tsr: true/.test(panel) && /id: 'tsr'/.test(panel), '默认开 + 面板有开关');
eq(Config.TSR_ENABLED, true, 'Config 总开关默认开');
ok(Config.TSR_HISTORY_MAX > 0 && Config.TSR_HISTORY_MAX < 1, '历史权重上限在 (0,1)');

// ---------------------------------------------------------------- ② 静态：shader 防线
console.log('\n[2] shader 防线：符号、NaN、鬼影、功耗');
ok(/e\[8\] \+= \(2 \* jx\) \/ this\.renderW/.test(tsr) && /e\[9\] \+= \(2 \* jy\) \/ this\.renderH/.test(tsr),
  '抖动改的是投影矩阵 NDC 平移项');
ok(/vec2 src = vUv \* uRenderSize - 0\.5 - uJitter/.test(tsr),
  'jitter 相位反解符号与投影矩阵一致（写反了超采样会散掉）');
ok(/uHistoryValid < 0\.5 \|\| inside < 0\.5/.test(tsr) && /return;/.test(tsr),
  '首帧/越界完全不采样未初始化的历史（0 * NaN 仍 NaN）');
ok(/vec4 clip = vec4\(vUv \* 2\.0 - 1\.0, centerD \* 2\.0 - 1\.0, 1\.0\)/.test(tsr),
  '重投影 clip.xy 取显示像素 NDC（用 centerUv 会把历史吸附到低分辨率网格，越积越糊）');
ok(!/vec4 clip = vec4\(centerUv/.test(tsr), 'clip.xy 不再误用低分辨率像素中心');
ok(/uInvVP/.test(tsr) && /uPrevVP/.test(tsr) && /不含 jitter|消掉 jitter/.test(tsr),
  '重投影用消掉 jitter 的 VP，静止画面原地累积');
ok(/variance clipping/.test(tsr) && /depthConf/.test(tsr) && /colorConf/.test(tsr),
  'YCoCg 方差裁剪 + 深度/颜色双重置信度压鬼影');
ok(/isFar/.test(tsr), '天空/背景（深度 1）强制原地累积，避免假视差拖影');
ok(/texture2D\(tLut/.test(tsr) && !/Math\.sin/.test(tsr.split('const FRAG')[1] || ''),
  'Lanczos 权重查表，片元里不跑 sin');
ok(/samples: 0/.test(tsr), 'TSR 的 RT 不开 MSAA（depthTexture 与多重采样不能共存）');
ok(/Math\.ceil\(8 \/ Math\.max/.test(tsr), '相位长度按 FSR2 的 8 * ratio^2 取');
ok(/console\.warn/.test(blockAt(tsr, 'ensure(rw, rh, dw, dh, type) {')), 'RT 创建失败出声');

// ---------------------------------------------------------------- ③ Node 真跑
console.log('\n[3] Node 真跑：RT / 抖动 / 矩阵 / 重投影 / 历史');
class StubRenderer {
  constructor(webgl2 = true) {
    this.target = null;
    this.renders = [];
    this.capabilities = { isWebGL2: webgl2 };
    this.throwOnRender = false;
  }
  getContext() { return {}; }
  setRenderTarget(t) { this.target = t; }
  render(scene, cam) {
    if (this.throwOnRender) throw new Error('stub GL failure');
    this.renders.push({ scene, cam, target: this.target });
  }
  compile() { /* stub */ }
  getDrawingBufferSize(v) { return v.set(1920, 1080); }
}
const stub = new StubRenderer();
eq(TemporalUpscale.supported(stub), true, 'WebGL2 能力检测通过');
eq(TemporalUpscale.supported(new StubRenderer(false)), false, 'WebGL1 一律退回 CAS');

const t = new TemporalUpscale(stub);
eq(t.ensure(960, 540, 1920, 1080, THREE.UnsignedByteType), true, 'ensure 成功');
eq(t.sceneRT.width, 960, '主场景 RT 宽 = 显示宽 * 0.5');
eq(t.sceneRT.height, 540, '主场景 RT 高 = 显示高 * 0.5');
ok(!!t.sceneRT.depthTexture, '主场景 RT 带可读深度纹理');
eq(t.sceneRT.samples, 0, '主场景 RT 无多重采样');
eq(t.hist[0].width, 1920, '历史图 0 为显示分辨率');
eq(t.hist[1].height, 1080, '历史图 1 为显示分辨率');
eq(t.hist[0].texture.type, THREE.HalfFloatType, 'TSR 历史图强制 HalfFloat（8bit 会量化掉 jitter 细节）');
eq(t.sceneRT.texture.type, THREE.HalfFloatType, 'TSR 主场景 RT 同样为 HalfFloat');
// 关掉 TSR_HDR_RT 时必须能退回调用方传进来的 8bit，不能把 format 写死。
const prevHdr = Config.TSR_HDR_RT;
Config.TSR_HDR_RT = false;
const tLdr = new TemporalUpscale(stub);
eq(tLdr.ensure(960, 540, 1920, 1080, THREE.UnsignedByteType), true, '关闭 HDR 后 ensure 仍成功');
eq(tLdr.hist[0].texture.type, THREE.UnsignedByteType, 'TSR_HDR_RT=0 时历史图回退 8bit');
Config.TSR_HDR_RT = prevHdr;
const firstRT = t.sceneRT;
eq(t.ensure(960, 540, 1920, 1080, THREE.UnsignedByteType), true, '同尺寸复用');
eq(t.sceneRT, firstRT, '同尺寸不重建 RT（热路径零分配）');
t._hasHistory = true;
t.ensure(640, 360, 1920, 1080, THREE.UnsignedByteType);
eq(t._hasHistory, false, '尺寸变化自动清历史');

// 回到 0.5 倍，验抖动相位
t.ensure(960, 540, 1920, 1080, THREE.UnsignedByteType);
const cam = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 500);
cam.position.set(3, 1.7, 8);
cam.rotation.set(0.1, 0.4, 0, 'YXZ');
cam.updateMatrixWorld();
const proj0 = cam.projectionMatrix.elements.slice();
const inv0 = cam.projectionMatrixInverse.elements.slice();

const phases = [];
for (let i = 0; i < 32; i++) {
  const j = t.beginFrame(cam);
  phases.push([j.x, j.y]);
  t.endFrame(cam);
}
eq(t._phases, 32, '0.5x 抖动序列长度 = ceil(8 * 2^2) = 32');
ok(phases.every(([x, y]) => Math.abs(x) < 0.5 && Math.abs(y) < 0.5), '所有相位都在渲染像素内');
ok(phases.every(([x, y]) => Math.abs(x) + Math.abs(y) > 1e-4), '序列不产生零向量');
eq(new Set(phases.map((p) => p.join(','))).size, 32, '32 个相位互不重复');
const j33 = t.beginFrame(cam);
t.endFrame(cam);
ok(Math.abs(j33.x - phases[0][0]) < 1e-9 && Math.abs(j33.y - phases[0][1]) < 1e-9, '第 33 帧回到第 1 相位');
ok(proj0.every((v, i) => Math.abs(v - cam.projectionMatrix.elements[i]) < 1e-12), 'endFrame 完全还原投影矩阵');
ok(inv0.every((v, i) => Math.abs(v - cam.projectionMatrixInverse.elements[i]) < 1e-12), 'endFrame 完全还原投影逆矩阵');

// 静止场景：curVP == prevVP 时，重投影必须把 clip 点原样送回（否则历史被反复重采样）
const invVP = t._curVP.clone().invert();
const clip = new THREE.Vector4(0.37, -0.21, 0.85, 1);
const world = clip.clone().applyMatrix4(invVP);
const back = world.clone().applyMatrix4(t._curVP);
near(back.x / back.w, clip.x, 1e-6, '静止重投影 UV.x 恒等');
near(back.y / back.w, clip.y, 1e-6, '静止重投影 UV.y 恒等');

// 抖动确实改了 NDC 平移项，且符号与 shader 的 -uJitter 对应
const j = t.beginFrame(cam);
ok(Math.abs(cam.projectionMatrix.elements[8] - proj0[8]) > 1e-9, 'beginFrame 改了 e[8]');
near(cam.projectionMatrix.elements[8] - proj0[8], (2 * j.x) / 960, 1e-12, 'e[8] 偏移 = 2*jx/renderW');
near(cam.projectionMatrix.elements[9] - proj0[9], (2 * j.y) / 540, 1e-12, 'e[9] 偏移 = 2*jy/renderH');
const u = t._mat.uniforms;
eq(u.uRenderSize.value.x, 960, 'resolve uniform 渲染尺寸');
const firstVP = t._curVP.clone();
const wroteIdx = 1 - t.histIdx;
const writeRT = t.hist[wroteIdx];
eq(t.resolve(stub, cam, j), true, 'resolve 成功');
eq(stub.renders[stub.renders.length - 1].target, writeRT, 'resolve 写入 ping-pong 的写缓冲');
eq(stub.target, null, 'resolve 后恢复默认帧缓冲');
eq(t.historyTexture, writeRT.texture, 'historyTexture 指向刚写入的那张');
eq(u.uHistoryValid.value, 0, '首帧确实以 0 权重写（shader 早退）');
near(u.uInvVP.value.elements[0], invVP.elements[0], 1e-9, 'uInvVP = 当前干净 VP 的逆');
t.endFrame(cam);
const j2 = t.beginFrame(cam);
eq(t.resolve(stub, cam, j2), true, '第二帧 resolve 成功');
eq(u.uHistoryValid.value, 1, '第二帧起历史生效');
eq(u.uPrevVP.value.equals(firstVP), true, '第二帧拿到的是第一帧的干净 VP');
t.endFrame(cam);

// 相机瞬移自动清历史
const beforeJump = t._hasHistory;
cam.position.set(200, 1.7, 8);
cam.updateMatrixWorld();
const j3 = t.beginFrame(cam);
eq(t._hasHistory, false, '单帧位移超过阈值自动清历史');
t.endFrame(cam);
eq(beforeJump, true, '跳变前确实已有历史（断言有效）');

// 失败降级：出声 + failed + 不留在 RT 上
const warns = [];
const origWarn = console.warn;
console.warn = (...a) => { warns.push(a.join(' ')); };
stub.throwOnRender = true;
const j4 = t.beginFrame(cam);
const failed = t.resolve(stub, cam, j4);
t.endFrame(cam);
console.warn = origWarn;
eq(failed, false, 'resolve 抛错返回 false');
eq(t.failed, true, '标记永久失败（Game 会退回 CAS）');
eq(stub.target, null, '失败后也恢复默认帧缓冲');
ok(warns.length > 0 && warns.join(' ').includes('时域累积失败'), '降级出声，不静默');
eq(t.ensure(960, 540, 1920, 1080, THREE.UnsignedByteType), false, '失败后 ensure 不再重试');

// LUT 编码往返
const lut = t._lut.image.data;
const decode = (i) => (lut[i * 4] / 255) * 1.25 - 0.25;
near(decode(0), 1, 0.01, 'Lanczos LUT: x=0 -> 1');
near(decode(255), 0, 0.01, 'Lanczos LUT: x=2 -> 0');
eq(lut.length, 256 * 4, 'LUT 为 256x1 RGBA8');

console.log('\n' + (fails ? 'FAIL ' + fails + ' 项' : 'ALL PASS'));
process.exit(fails ? 1 : 0);
