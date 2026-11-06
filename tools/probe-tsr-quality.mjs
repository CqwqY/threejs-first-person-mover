// 自检：本轮「超分提升不明显」的 7 个根因是否真的被修掉。
//
// 三层：
//   ① 静态闸门 —— shader 关键字、注入白名单、Game 接线顺序、HUD 可观测、降级出声；
//   ② Node 真跑   —— mipBiasFor 公式、共享 uniform、注入幂等/原回调保留、反馈曲线、
//                     自适应区间上限、TSR 的 HDR RT 与 uFeedback 落盘；
//   ③ 护栏       —— 不产生 NaN、永不跨 0.98 路径硬切、失败路径不静默。
// ⚠ 只验数学与状态机，不验 GLSL 编译（那要浏览器 GL 上下文与真驱动）。
//
// 跑法：node tools/probe-tsr-quality.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { TemporalUpscale } from '../src/world/TemporalUpscale.js';
import {
  mipBiasFor, setMipBias, getMipBias, injectMipBias, applyMipBias,
  applyMipBiasToScene, canInjectBias, MIP_MARK, mipBiasUniform,
} from '../src/world/MipBias.js';
import { ADAPT, adaptScaleDecision, tsrScaleCap } from '../src/core/AdaptiveScale.js';
import { Config } from '../src/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
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
// 类方法体：从方法签名那一行开始做花括号配对。
// ⚠ 不能用 indexOf(name) —— 会命中设置面板 binds 里的调用，也会扫到文件末尾。
function methodBlock(src, name) {
  const re = new RegExp('^\\s*' + name + '\\s*\\([^)]*\\)\\s*\\{', 'm');
  const m = re.exec(src);
  if (!m) return '';
  const open = m.index + m[0].length - 1;
  let d = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}' && --d === 0) return src.slice(open, k + 1);
  }
  return src.slice(open);
}

const game = read('src/core/Game.js');
const tsr = read('src/world/TemporalUpscale.js');
const mip = read('src/world/MipBias.js');
const cfg = read('src/config.js');
const panel = read('src/ui/SettingsPanel.js');

// ---------------------------------------------------------------- ① 参数
console.log('\n[1] Config：本轮新增参数的取值与有序性');
eq(Config.TSR_HDR_RT, true, 'TSR 路径强制 HDR RT（8bit 会量化掉 jitter 细节）');
ok(Config.TSR_HISTORY_MAX > 0.9 && Config.TSR_HISTORY_MAX < 1, '静止反馈上限接近 1');
ok(Config.TSR_VAR_GAMMA >= 1.5, '方差裁剪放宽，不再把细线裁掉');
ok(Config.TSR_FEEDBACK_MIN > 0 && Config.TSR_FEEDBACK_MIN < Config.TSR_MOTION_FEEDBACK,
  '反馈下限 < 运动反馈 < 静止上限');
ok(Config.TSR_MOTION_FEEDBACK < Config.TSR_HISTORY_MAX, '运动时反馈确实低于静止');
ok(Config.TSR_MIP_BIAS > 0 && Config.TSR_MIP_BIAS_MIN < 0, '负 mip bias 已启用且有下限');
ok(Config.TSR_AUTO_TARGET > ADAPT.FLOOR && Config.TSR_AUTO_TARGET < Config.TSR_AUTO_CEIL,
  'TSR 自动起点落在 [地板, 上限] 内');
ok(Config.TSR_AUTO_CEIL < ADAPT.UPSCALE_LIMIT, 'TSR 自动上限仍低于 0.98（永不路径硬切）');
ok(Config.TSR_AUTO_TARGET < 0.75, '自动起点落在 DLSS Quality 等效区间（0.67× 左右）');
ok(/TSR_AUTO_TARGET: 0\.67/.test(cfg), '起点确为 0.67×');

// ---------------------------------------------------------------- ② shader 静态闸门
console.log('\n[2] resolve shader：过度裁剪 / 降权 / 收敛 三处修复');
const frag = tsr.slice(tsr.indexOf('const FRAG'), tsr.indexOf('export class TemporalUpscale'));
ok(/loY = min\(mnY, mu - uVarGamma \* sigma\)/.test(frag)
  && /hiY = max\(mxY, mu \+ uVarGamma \* sigma\)/.test(frag),
  '方差裁剪与邻域 min/max 取「并集」（不再双重限幅）');
ok(!/max\(toYCoCg\(mn\)/.test(frag) && !/min\(toYCoCg\(mx\)/.test(frag),
  '旧的 AABB ∩ min/max 交集写法已移除');
ok(/uFeedback/.test(frag) && /clamp\(uFeedback, uHistoryMin, uHistoryMax\)/.test(frag),
  '反馈权重由 JS 传入并夹在护栏内');
ok(/length\(hY - cY\) \* 1\.5/.test(frag), '颜色置信度不再用 *3.0 猛砍历史');
ok(/clamp\(1\.0 - length\(hY - cY\) \* 1\.5, 0\.0, 1\.0\)/.test(frag),
  'colorConf 本身不再设 0.08 的硬下限');
ok(/smoothstep\(0\.035, 0\.16, abs\(curA - h\.a\)\)/.test(frag),
  '深度置信度阈值放宽到 0.035~0.16');
ok(/max\(colorConf, 0\.35\) \* max\(depthConf, 0\.4\)/.test(frag),
  '最坏情况仍保留 0.14 的历史权重，不退化成单帧');
ok(/Config\.TSR_HDR_RT\) type = THREE\.HalfFloatType/.test(tsr),
  'ensure 里强制 HalfFloat（sceneRT + 两张历史图）');
ok(/this\._accum = Math\.min\(64, this\._accum \+ 1\)/.test(tsr)
  && /const ramp = this\._accum \/ \(this\._accum \+ 1\)/.test(tsr),
  '反馈按累积帧数 n/(n+1) 自加速收敛');
ok(/this\._feedback = Math\.max\(Config\.TSR_FEEDBACK_MIN/.test(tsr), '反馈有下限，不会归零');
ok(/reset\(\)[\s\S]{0,320}this\._accum = 0/.test(tsr), 'reset 会清零累积帧数');
ok(/get accumFrames\(\)/.test(tsr) && /get feedback\(\)/.test(tsr), '暴露诊断 getter');

console.log('\n[2b] 升采样 shader：8 邻域自适应锐化');
ok(/vec3 lu = texture2D/.test(game) && /vec3 rd = texture2D/.test(game), '八个邻域都采样');
ok(/\* 0\.125/.test(game), '归一化系数是 1/8（不是旧版 0.25）');
ok(/smoothstep\(0\.02, 0\.5, contrast\)/.test(game), '高对比处自动收力防过冲');
ok(/#include <tonemapping_fragment>/.test(game) && /#include <colorspace_fragment>/.test(game),
  'ACES + sRGB 顺序保留（与原生直渲同色调）');
ok(/toneMapped: true/.test(game), '升采样材质显式打开 toneMapped');
ok(!/clamp\(sharp, 0\.0, 1\.0\)/.test(game), 'tone 前的硬 clip 仍未复活');

// ---------------------------------------------------------------- ③ mip bias 真跑
console.log('\n[3] 负 LOD bias：公式 / 共享 uniform / 注入幂等 / 白名单');
near(mipBiasFor(0.67, true), Math.log2(0.67), 1e-9, '0.67× → log2(0.67) ≈ -0.578');
near(mipBiasFor(0.5, true), -1, 1e-9, '0.5× → -1.0（FSR2 推荐值）');
eq(mipBiasFor(1, true), 0, '原生 1.0× → 0（不干预 mip 选择）');
eq(mipBiasFor(0.67, false), 0, 'enabled=false → 0');
eq(mipBiasFor(0.4, true), Math.max(Config.TSR_MIP_BIAS_MIN, Math.log2(0.4)), '地板值 clamp');
eq(mipBiasFor(0.05, true), Config.TSR_MIP_BIAS_MIN, '极端低比例被 MIN 钳住');
eq(mipBiasFor(NaN, true), 0, 'NaN 比例 → 0（不产生 NaN bias）');
eq(mipBiasFor(Infinity, true), 0, 'Infinity 比例 → 0');
eq(mipBiasFor(-1, true), 0, '负比例 → 0');
const prevK = Config.TSR_MIP_BIAS;
Config.TSR_MIP_BIAS = 0;
eq(mipBiasFor(0.5, true), 0, 'kill-switch（系数 0）→ 0');
Config.TSR_MIP_BIAS = prevK;

eq(setMipBias(-0.58), -0.58, 'setMipBias 生效');
eq(mipBiasUniform.value, -0.58, '共享 uniform 被更新（无需重编译）');
eq(setMipBias(0.4), 0, '正值被钳到 0，绝不放大 mip 模糊');
eq(getMipBias(), 0, '钳制后共享 uniform 也为 0');
setMipBias(0);

const sh = {
  fragmentShader: 'void main() {\n  vec4 c = texture2D( map, vMapUv );\n  float a = texture2D( alphaMap, vAlphaMapUv ).a;\n}\n',
  uniforms: {},
};
eq(injectMipBias(sh), true, '注入成功');
ok(sh.fragmentShader.indexOf(MIP_MARK) === 0, 'uniform 声明插在最前面');
ok(/texture2D\(map, vMapUv, fpmMipBias\)/.test(sh.fragmentShader), 'map 采样带 bias');
ok(/texture2D\(alphaMap, vAlphaMapUv, fpmMipBias\)/.test(sh.fragmentShader), 'alphaMap 采样带 bias');
eq(sh.uniforms.fpmMipBias, mipBiasUniform, 'uniform 指向共享对象');
const once = sh.fragmentShader;
eq(injectMipBias(sh), false, '第二次注入幂等');
eq(sh.fragmentShader, once, '幂等注入不改变源码');
const untouched = { fragmentShader: 'void main() { vec4 c = texture2D( shadowMap, vUv ); }', uniforms: {} };
eq(injectMipBias(untouched), false, '白名单外的采样不注入');
ok(untouched.fragmentShader.indexOf(MIP_MARK) === -1, '没替换就不插 uniform（不改 program key）');
eq(untouched.uniforms.fpmMipBias, undefined, '未注入的 shader 不多出 uniform');

const bad = { fragmentShader: null };
eq(injectMipBias(bad), false, '非字符串 fragmentShader 安全跳过');

// ⚠⚠ 最易静默失效的一处：onBeforeCompile 拿到的是**未展开 #include** 的 ShaderLib 模板，
//   里面只有 `#include <map_fragment>`，没有 texture2D 字样。若注入没先 resolveIncludes，
//   下面这条必然返回 false —— 探针全绿、跑起来却一点效果都没有。
ok(/texture2D\(\s*map\s*,\s*vMapUv\s*\)/.test(THREE.ShaderChunk.map_fragment),
  'Three r' + THREE.REVISION + ' 的 map_fragment 仍是 texture2D(map, vMapUv) 写法（升级需重审）');
ok(/resolveIncludes\(shader\.fragmentShader, 0\)/.test(mip), '注入前先递归展开 #include');
const tpl = {
  fragmentShader: '#include <common>\nvoid main() {\n  #include <map_fragment>\n  #include <alphamap_fragment>\n}\n',
  uniforms: {},
};
eq(injectMipBias(tpl), true, '对真实 ShaderLib 模板（只有 #include）也能注入');
ok(/texture2D\(map, vMapUv, fpmMipBias\)/.test(tpl.fragmentShader), '展开后 map 采样带 bias');
ok(/texture2D\(alphaMap, vAlphaMapUv, fpmMipBias\)/.test(tpl.fragmentShader), '展开后 alphaMap 采样带 bias');
ok(!/#include <map_fragment>/.test(tpl.fragmentShader), '纹理相关 include 已被展开');
eq(tpl.uniforms.fpmMipBias, mipBiasUniform, '展开路径同样挂上共享 uniform');

ok(/shadowMap|envMap/.test(mip) === false || /绝不碰 envMap/.test(mip),
  '源码明确排除了 envMap / shadowMap');
ok(/isSpriteMaterial/.test(mip) && /isShaderMaterial/.test(mip), '排除 Sprite / 自定义 ShaderMaterial');
ok(/console\.warn/.test(mip), '注入失败出声，不静默吞掉');

let origCalled = 0;
const mat = { onBeforeCompile: () => { origCalled++; }, isMeshStandardMaterial: true };
eq(applyMipBias(mat), true, '包装单个材质');
eq(applyMipBias(mat), false, '重复包装幂等');
mat.onBeforeCompile(sh, null);
eq(origCalled, 1, '原 onBeforeCompile 被保留并调用');
ok(/customProgramCacheKey/.test(mip) && /\|fpm-mipbias/.test(mip),
  'program cache key 把注入/未注入材质分开（防 shader 串味）');
ok(typeof mat.customProgramCacheKey === 'function'
  && /\|fpm-mipbias$/.test(mat.customProgramCacheKey()),
  '包装后的 cache key 带专属后缀');
eq(canInjectBias({ isShaderMaterial: true, onBeforeCompile() {} }), false, 'ShaderMaterial 排除');
eq(canInjectBias({ isSpriteMaterial: true, onBeforeCompile() {} }), false, 'Sprite 排除');
eq(canInjectBias({ isMeshDepthMaterial: true, onBeforeCompile() {} }), false, '深度材质排除');

const mA = { onBeforeCompile() {} }, mB = { onBeforeCompile() {} }, mC = { onBeforeCompile() {} };
const fakeScene = { traverse(cb) { cb({ material: mA }); cb({ material: [mB, mA] }); cb({ material: mC }); } };
const added = [];
eq(applyMipBiasToScene(fakeScene, (m) => added.push(m)), 3, '场景遍历去重后包装 3 个材质');
eq(added.length, 3, 'onNew 只回调新包装的材质');
eq(applyMipBiasToScene(fakeScene, (m) => added.push(m)), 0, '二次扫描不再重复包装');
eq(added.length, 3, '二次扫描不触发额外 needsUpdate');

// ---------------------------------------------------------------- ④ 反馈曲线真跑
console.log('\n[4] TSR 状态机：静止快速收敛 / 运动降权 / reset 归零');
class StubRenderer {
  constructor() { this.target = null; this.capabilities = { isWebGL2: true }; this.renders = []; }
  getContext() { return {}; }
  setRenderTarget(t) { this.target = t; }
  render(s, c) { this.renders.push({ s, c, target: this.target }); }
  compile() { /* stub */ }
}
const stub = new StubRenderer();
const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 500);
cam.position.set(0, 1.6, 0);
cam.updateMatrixWorld(true);
const t = new TemporalUpscale(stub);
eq(t.ensure(1280, 720, 1920, 1080, THREE.UnsignedByteType), true, 'ensure 成功');
eq(t.sceneRT.texture.type, THREE.HalfFloatType, '即使调用方传 8bit，TSR 仍用 HalfFloat');
const proj0 = cam.projectionMatrix.elements.slice();
let jitter = null;
for (let i = 0; i < 12; i++) { jitter = t.beginFrame(cam); t.endFrame(cam); }
ok(!!jitter, 'beginFrame 返回有效抖动');
eq(cam.projectionMatrix.elements.every((v, i) => v === proj0[i]), true, 'endFrame 完整还原投影矩阵');
ok(t.accumFrames === 12, '累积帧数随静止帧增长');
ok(t.feedback > 0.85, '静止 12 帧后反馈 > 0.85（旧版固定 0.88 要 30 帧才有观感）');
ok(t.feedback <= Config.TSR_HISTORY_MAX + 1e-9, '反馈不超过 HISTORY_MAX');
const u = t._mat.uniforms;
eq(t.resolve(stub, cam, jitter), true, 'resolve 成功');
near(u.uFeedback.value, t.feedback, 1e-9, 'uFeedback 真的写进 uniform（不是只算不落盘）');
eq(u.uFeedback.value > 0.85, true, 'resolve 用的是高反馈');

for (let i = 0; i < 6; i++) {
  cam.position.x += 0.5;
  cam.updateMatrixWorld(true);
  jitter = t.beginFrame(cam);
  t.endFrame(cam);
}
ok(t.feedback < 0.7, '相机明显移动时反馈降到 ~0.62（防拖影）');
ok(t.feedback >= Config.TSR_FEEDBACK_MIN, '运动反馈仍高于下限');
eq(t.resolve(stub, cam, jitter), true, '运动帧 resolve 仍成功');
// uInvVP 必须是「消掉 jitter 的干净 VP」的逆，否则静止画面每天被平移一次、越积越糊。
ok(u.uInvVP.value.equals(t._curVP.clone().invert()),
  'uInvVP = 当前帧干净 VP 的逆（未被 jitter 污染）');
near(u.uInvVP.value.elements[0], Math.tan(30 * Math.PI / 180) * (16 / 9), 1e-6,
  'VP 逆的 [0][0] = tan(fov/2)*aspect（透视矩阵求逆的解析解）');
t.reset();
eq(t.accumFrames, 0, 'reset 清零累积');
eq(t.feedback, Config.TSR_FEEDBACK_MIN, 'reset 后反馈回到下限');

// ---------------------------------------------------------------- ⑤ 自适应区间
console.log('\n[5] 自适应区间：TSR 模式压到 0.5~0.78，永不跨 0.98');
eq(tsrScaleCap(null, 0.78), 0.78, '默认 TSR 上限 0.78');
eq(tsrScaleCap(0.9, 0.78), 0.9, 'URL ?tsrscale 可抬高，但仍 < 0.98');
eq(tsrScaleCap(1.5, 0.78), ADAPT.CEIL, '越界的 override 被 ADAPT.CEIL 硬钳');
eq(tsrScaleCap(null, null), 0.78, 'autoCeil 缺失时兜底 0.78');
ok(tsrScaleCap(0.9, 0.78) < ADAPT.UPSCALE_LIMIT, '任何情况都不越过超分阈值');

let st = { scale: 0.67, lastChange: 0, lastDrop: -1e9 };
let maxTsr = st.scale;
for (let i = 1; i <= 40; i++) {
  const d = adaptScaleDecision(st, 60, 10000 + i * (ADAPT.MIN_INTERVAL + 1), { ceil: 0.78 });
  if (d) { st = d; maxTsr = Math.max(maxTsr, d.scale); }
}
near(maxTsr, 0.78, 1e-9, 'TSR 模式最终收敛到 0.78 而不是 0.95');
eq(adaptScaleDecision(st, 60, 10000 + 41 * ADAPT.MIN_INTERVAL, { ceil: 0.78 }), null, '到顶后不再升');
let stNo = { scale: 0.67, lastChange: 0, lastDrop: -1e9 };
for (let i = 1; i <= 40; i++) {
  const d = adaptScaleDecision(stNo, 60, 10000 + i * (ADAPT.MIN_INTERVAL + 1));
  if (d) stNo = d;
}
near(stNo.scale, ADAPT.CEIL, 1e-9, '不传 opts 时旧行为完全不变（仍收敛到 0.95）');
let stFloor = { scale: 0.55, lastChange: 0, lastDrop: -1e9 };
const dFloor = adaptScaleDecision(stFloor, 20, 10000, { ceil: 0.78, floor: 0.52 });
near(dFloor.scale, 0.52, 1e-9, 'floor 覆盖生效');

console.log('\n[5b] Game 接线：区间 / 注入顺序 / 诊断 / 降级');
ok(/import \{ applyMipBiasToScene, mipBiasFor, setMipBias, getMipBias \}/.test(game),
  'MipBias 模块已导入');
ok(/import \{ ADAPT, adaptScaleDecision, tsrScaleCap \}/.test(game), 'tsrScaleCap 纯函数已导入');
const adapt = methodBlock(game, '_adaptResolution');
ok(/tsrScaleCap\(\)/.test(adapt) && /adaptScaleDecision\(/.test(adapt),
  '自适应主入口传入 TSR 区间上限');
const autoStart = methodBlock(game, '_autoStartScale');
ok(/TSR_AUTO_TARGET/.test(autoStart) && /_tsrScaleCap\(\)/.test(autoStart),
  '起点走 TSR 0.67× 区间');
const autoMode = methodBlock(game, '_tsrAutoMode');
ok(!/_useUpscale\(\)/.test(autoMode), '起点判定不依赖 _useUpscale（避免循环依赖）');
const applyScale = methodBlock(game, '_applyRenderScale');
ok(/ADAPT\.CEIL/.test(applyScale), '_applyRenderScale 仍保留硬钳');
const precompile = methodBlock(game, '_precompileShaders');
ok(precompile.indexOf('applyMipBiasToScene') < precompile.indexOf('applyFragmentPrecisionToScene'),
  'mipbias 先包装、片元精度后包装（外层调用内层 prev）');
ok(/if \(_fragN > 0\)/.test(precompile), '两种注入共用一次 needsUpdate 遍历');
const syncMip = methodBlock(game, '_syncMipBias');
ok(/mipBiasFor\(/.test(syncMip) && /getMipBias\(\)/.test(syncMip), 'bias 随分辨率实时同步');
ok(/onNew|mat\.needsUpdate = true/.test(syncMip), '补扫只标新材质，不全场重编译');
ok(/console\.warn/.test(syncMip), '补扫失败出声');
const renderFrame = methodBlock(game, '_renderFrame');
ok(/this\._syncMipBias\(\)/.test(renderFrame), '_renderFrame 每帧同步 bias');
ok(/accumFrames/.test(game) && /getMipBias\(\) < 0/.test(game),
  'HUD 显示累积帧数与负 bias（能确认是否真的生效）');
ok(/\?mipbias=0|q\.get\('mipbias'\)/.test(game), 'URL kill-switch 存在');
ok(/tsrscale/.test(game), 'URL ?tsrscale= A/B 通道存在');
ok(/this\._sharpen = 0\.7/.test(game) && /sharpen: 0\.7/.test(panel), '锐化默认强度已提高且与面板一致');
ok(/时域超分/.test(panel) && /67%/.test(panel), '设置面板说明了新的自动区间');

console.log('\n' + (fails ? 'FAIL ' + fails + ' 项' : 'ALL PASS'));
if (fails) process.exitCode = 1;
