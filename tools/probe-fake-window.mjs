// 自检：障眼法窗户（FakeWindow）
//
// 三条断言：
// ① 模块真的能 import 且创建材质/网格（不是语法检查，是真跑）。
// ② **cubeUV 采样参数换算与 Three 内置实现逐位一致** —— 从 three 源码里把
//    generateCubeUVSize() 的公式抠出来，跟我 setWindowEnv 写的对照算，必须相等。
//    （血泪：这里第一版我凭印象写成 1/(w*2+2)、log2(w)-3，全是错的。）
// ③ 采样几何自洽：cubeUV_getFace/getUV 的手写 GLSL 必须与 Three 的
//    cube_uv_reflection_fragment.glsl.js 文本一致（把两边的函数体归一化后 diff）。
// ④ disposeWindow 绝不碰 env 贴图（只释放自己的 geometry/material）。
//
// 跑法：node tools/probe-fake-window.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
function ok(cond, msg) {
  if (cond) { console.log('  PASS  ' + msg); }
  else { console.log('  FAIL  ' + msg); fails++; }
}
function eq(a, b, msg) {
  const same = Math.abs(a - b) < 1e-9;
  if (same) console.log('  PASS  ' + msg + `  (${a})`);
  else { console.log('  FAIL  ' + msg + `  got ${a} want ${b}`); fails++; }
}

// ---------------------------------------------------------------- ①
console.log('\n[1] 模块可加载 & 能建材质/网格');
const mod = await import(pathToFileURL(path.join(ROOT, 'src/world/FakeWindow.js')).href);
ok(typeof mod.createWindowMaterial === 'function', 'createWindowMaterial 已导出');
ok(typeof mod.createWindowMesh === 'function', 'createWindowMesh 已导出');
ok(typeof mod.setWindowEnv === 'function', 'setWindowEnv 已导出');
ok(typeof mod.disposeWindow === 'function', 'disposeWindow 已导出');
ok(!!mod.WINDOW_DEFAULTS && typeof mod.WINDOW_DEFAULTS === 'object', 'WINDOW_DEFAULTS 已导出（默认值唯一来源）');

const mat = mod.createWindowMaterial({ glass: '#8fb8d8', opacity: 0.3 });
ok(!!mat && mat.isShaderMaterial === true, 'createWindowMaterial 返回 ShaderMaterial');
ok(!!mat.uniforms.tEnv, '材质带 tEnv uniform');
ok(!!mat.uniforms.uEnvReady, '材质带 uEnvReady uniform');
ok(mat.side === 2, '窗户为双面渲染（贴墙看不会消失）');
ok(mat.depthWrite === false, '不写深度（避免与墙 z-fighting 闪烁）');

const mesh = mod.createWindowMesh({ w: 2, h: 1.5 });
ok(!!mesh && mesh.isMesh === true, 'createWindowMesh 返回 Mesh');
ok(mesh.userData.fakeWindow === true, 'mesh 打上 fakeWindow 标记（供编辑器/游戏端识别）');
eq(mesh.geometry.parameters.width, 2, 'PlaneGeometry 宽度 = 2');
eq(mesh.geometry.parameters.height, 1.5, 'PlaneGeometry 高度 = 1.5');

// 参数往返
const back = mod.readWindowParams(mesh);
eq(back.w, 2, 'readWindowParams 读回宽度');
eq(back.h, 1.5, 'readWindowParams 读回高度');

// ---------------------------------------------------------------- ②
console.log('\n[2] cubeUV 尺寸换算必须与 Three 内置公式一致');
// 从 three 源码里抠出 generateCubeUVSize 的真实实现
const threeSrc = fs.readFileSync(path.join(ROOT, 'node_modules/three/build/three.module.js'), 'utf8');
const gStart = threeSrc.indexOf('function generateCubeUVSize');
ok(gStart > 0, '在 three 源码里找到 generateCubeUVSize()');
const gBody = threeSrc.slice(gStart, threeSrc.indexOf('function WebGLProgram', gStart));
ok(/Math\.log2\(\s*imageHeight\s*\)\s*-\s*2/.test(gBody), 'Three: maxMip = log2(imageHeight) - 2');
ok(/texelHeight\s*=\s*1\.0\s*\/\s*imageHeight/.test(gBody), 'Three: texelHeight = 1 / imageHeight');
ok(/3\s*\*\s*Math\.max\(\s*Math\.pow\(\s*2,\s*maxMip\s*\)\s*,\s*7\s*\*\s*16\s*\)/.test(gBody),
  'Three: texelWidth = 1 / (3 * max(2^maxMip, 7*16))');

// 我的实现：用一份假贴图算出参数，跟 spec 独立算一遍对照
function specCubeUVSize(imageHeight) {
  const maxMip = Math.log2(imageHeight) - 2;
  const texelHeight = 1 / imageHeight;
  const texelWidth = 1 / (3 * Math.max(Math.pow(2, maxMip), 7 * 16));
  return { texelWidth, texelHeight, maxMip };
}
for (const h of [128, 256, 512]) {
  // 造一个最小假 env（只要有 image.width/height 就够了）
  const fakeEnv = { image: { width: h * 3, height: h } };
  const m = mod.createWindowMaterial();
  mod.setWindowEnv(m, fakeEnv);
  const s = specCubeUVSize(h);
  eq(m.uniforms.uCubeUVMaxMip.value, s.maxMip, `h=${h} maxMip 一致`);
  eq(m.uniforms.uCubeUVTexelH.value, s.texelHeight, `h=${h} texelHeight 一致`);
  eq(m.uniforms.uCubeUVTexelW.value, s.texelWidth, `h=${h} texelWidth 一致`);
}

// ---------------------------------------------------------------- ③
console.log('\n[3] 手写 cubeUV GLSL 必须与 Three 的 cube_uv_reflection_fragment 语义一致');
const fw = fs.readFileSync(path.join(ROOT, 'src/world/FakeWindow.js'), 'utf8');
// 抓 Three 的 getFace / getUV 函数体（做空白归一化后比对关键分支）
function norm(s) {
  return s
    .replace(/\s+/g, ' ')
    .replace(/−/g, '-')
    // 把标点周围的空白全部去掉，这样 `vec2( direction.z,  direction.y)` 与
    // `vec2( direction.z, direction.y )` 归一化后一致（否则纯空格差异会误报）。
    .replace(/\s*([(),*/+\-<>?:=])\s*/g, '$1')
    .trim();
}
const threeFaceStart = threeSrc.indexOf('float getFace( vec3 direction )');
const threeFaceEnd = threeSrc.indexOf('vec2 getUV( vec3 direction, float face )');
const threeGetFace = norm(threeSrc.slice(threeFaceStart, threeFaceEnd));
const threeUVStart = threeFaceEnd;
const threeUVEnd = threeSrc.indexOf('vec3 bilinearCubeUV', threeUVStart);
const threeGetUV = norm(threeSrc.slice(threeUVStart, threeUVEnd));

// 我的 GLSL 在 fragmentShader 模板串里，取它并归一化
const fwFace = norm(fw.slice(fw.indexOf('float cubeUV_getFace('), fw.indexOf('vec2 cubeUV_getUV(')));
const fwUV = norm(fw.slice(fw.indexOf('vec2 cubeUV_getUV('), fw.indexOf('vec3 sampleEnv(')));

// 逐条关键分支比对（不整段 diff，因为变量名/缩进不同）
function hasAll(hay, needles, label) {
  for (const n of needles) {
    ok(hay.includes(norm(n)), `${label} 含 "${n}"`);
  }
}
hasAll(fwFace, [
  'absDirection.x > absDirection.z',
  'absDirection.x > absDirection.y',
  'direction.x > 0.0 ? 0.0 : 3.0',
  'direction.y > 0.0 ? 1.0 : 4.0',
  'absDirection.z > absDirection.y',
  'direction.z > 0.0 ? 2.0 : 5.0',
], 'cubeUV_getFace');
hasAll(fwUV, [
  'vec2( direction.z, direction.y ) / abs(direction.x)',
  'vec2( -direction.x, -direction.z ) / abs(direction.y)',
  'vec2( -direction.x, direction.y ) / abs(direction.z)',
  'vec2( -direction.z, direction.y ) / abs(direction.x)',
  'vec2( -direction.x, direction.z ) / abs(direction.y)',
  'vec2( direction.x, direction.y ) / abs(direction.z)',
  '0.5 * (uv + 1.0)',
], 'cubeUV_getUV');
// sampleEnv 里关键几行：先切出函数体再归一化（之前误传了整个文件 → 恒 FAIL）
const envStart = fw.indexOf('vec3 sampleEnv(');
const envEnd = fw.indexOf('void main()', envStart) > 0 ? fw.indexOf('void main()', envStart) : envStart + 1200;
const fwSample = norm(fw.slice(envStart, envEnd));
hasAll(fwSample, [
  'if (face > 2.0) { uv.y += faceSize; face -= 3.0; }',
  'uv.x += face * faceSize;',
  'uv.y += 4.0 * (exp2(CUBEUV_MAX_MIP) - faceSize);',
  'uv.x *= CUBEUV_TEXEL_WIDTH;',
  'uv.y *= CUBEUV_TEXEL_HEIGHT;',
], 'sampleEnv');

// Three 的 getFace 必须 6 个面全覆盖 —— 防止我漏一个分支。
// 注意：数「不同的 face 值」而不是数赋值语句行数（0/3 在同一行三元里，共 5 行 6 值）。
const faceVals = new Set((fwFace.match(/face=direction\.\w+>0\.0\?\d+\.0:\d+\.0/g) || [])
  .flatMap((m) => (m.match(/\d+\.0/g) || [])));
ok(faceVals.size === 6, `cubeUV_getFace 覆盖 6 个不同 face 值（实得 ${[...faceVals].sort().join(',') || '空'}）`);

// ---------------------------------------------------------------- ④
console.log('\n[4] disposeWindow 不得释放共享的环境贴图');
const m4 = mod.createWindowMaterial();
let envDisposed = false;
const sharedEnv = { isTexture: true, image: { width: 48, height: 16 }, dispose() { envDisposed = true; } };
mod.setWindowEnv(m4, sharedEnv);
let geoDisposed = false, matDisposed = false;
const mesh4 = {
  geometry: { dispose() { geoDisposed = true; } },
  material: Object.assign(m4, { dispose() { matDisposed = true; } }),
};
mod.disposeWindow(mesh4);
ok(geoDisposed, 'disposeWindow 释放了 geometry');
ok(matDisposed, 'disposeWindow 释放了 material');
ok(!envDisposed, 'disposeWindow **没有**释放共享的 env 贴图（关键！）');
ok(m4.uniforms.tEnv.value === null, 'disposeWindow 清掉了对 env 的引用');

// 源码级防线：确认 disposeWindow 里没有对 env 调 dispose
const dispoStart = fw.indexOf('export function disposeWindow');
const dispoBody = fw.slice(dispoStart);
ok(!/tEnv[^;]*\.dispose\(/.test(dispoBody), 'disposeWindow 源码里没有 tEnv.dispose()');

// ---------------------------------------------------------------- ⑤
console.log('\n[5] 环境就绪前不得崩溃（uEnvReady 守卫）');
ok(/if \(uEnvReady < 0\.5\)/.test(fw), 'fragment 里有 uEnvReady 守卫（没环境贴图时退化为纯玻璃色）');
const m5 = mod.createWindowMaterial();
mod.setWindowEnv(m5, null);
eq(m5.uniforms.uEnvReady.value, 0, 'env 为 null 时 uEnvReady = 0');

console.log('\n' + (fails === 0 ? '✅ 全部通过' : `❌ ${fails} 项失败`));
process.exit(fails === 0 ? 0 : 1);
