// 自检：墙体挖洞（FakeWindow 的 hole 部分）
//
// 挖洞是「零额外开销」方案（fragment discard），但它有三个极易静默失效的点，
// 所以必须真跑真验：
// ① onBeforeCompile 注入的**锚点**必须在 Three 真实着色器里存在，
//    且注入后 GLSL 结构合法（uniform 声明在函数外、discard 在 main 内）。
//    —— 锚点写错的表现是「什么都没发生」，控制台一片安静（本项目踩过 5 次静默失效）。
// ② 注入必须**幂等**：onBeforeCompile 在程序重建时会被反复调用，
//    重复注入会让 #define 出现两次 → 编译直接报错。
// ③ 阴影深度材质必须**单独**处理（主材质补丁对它就是无效），
//    且深度材质必须 alphaTest > 0 —— Three 的深度 shader 只有 alphaTest 开了才保留
//    discard 语句所在的分支。
// ④ Merge.js 的材质指纹**不包含** onBeforeCompile —— 这是洞参数必须走共享 uniform 的
//    根本原因，必须由本探针把这条约束钉死（否则以后有人改成「每材质一份参数」会静默失效）。
// ⑤ computeHoleBox 的轴对齐包围盒必须真的**包住**旋转后的窗户盒子（不能比它小），
//    否则洞会缺角。
//
// 跑法：node tools/probe-wall-hole.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
function ok(cond, msg) {
  if (cond) console.log('  PASS  ' + msg);
  else { console.log('  FAIL  ' + msg); fails++; }
}
function eq(a, b, msg) {
  if (a === b) console.log('  PASS  ' + msg + `  (${a})`);
  else { console.log('  FAIL  ' + msg + `  got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); fails++; }
}
function near(a, b, eps, msg) {
  const d = Math.abs(a - b);
  if (d <= (eps == null ? 1e-6 : eps)) console.log('  PASS  ' + msg + `  (${a})`);
  else { console.log('  FAIL  ' + msg + `  got ${a} want ${b} (|d|=${d})`); fails++; }
}

const threeSrc = fs.readFileSync(path.join(ROOT, 'node_modules/three/build/three.module.js'), 'utf8');
const THREE = await import('three');
const mod = await import(pathToFileURL(path.join(ROOT, 'src/world/FakeWindow.js')).href);

// ---------------------------------------------------------------- ① 导出齐全
console.log('\n[1] 挖洞 API 导出齐全');
for (const name of ['MAX_HOLES', 'holeUniforms', 'computeHoleBox', 'setHoleList',
  'injectHoleCode', 'patchBuildingMaterial', 'patchShadowMaterial', 'applyWindowHoles', 'resetHolePatches']) {
  ok(name in mod, `导出 ${name}`);
}
ok(mod.MAX_HOLES >= 8, `MAX_HOLES 足够大（${mod.MAX_HOLES}）`);
ok(holeArr('uHoles', THREE.Vector4), 'holeUniforms.uHoles 是 Vector4 数组');
ok(holeArr('uHoleHalf', THREE.Vector3), 'holeUniforms.uHoleHalf 是 Vector3 数组');
function holeArr(key, ctor) {
  const v = mod.holeUniforms[key] && mod.holeUniforms[key].value;
  return Array.isArray(v) && v.length === mod.MAX_HOLES && v.every((x) => x instanceof ctor);
}
ok(mod.holeUniforms.uHoleCount.value === 0, '初始 uHoleCount = 0（不开洞）');

// ---------------------------------------------------------------- ② computeHoleBox
console.log('\n[2] computeHoleBox：轴对齐墙 = 精确半尺寸；旋转墙 = 保守包围盒');
{
  // 轴对齐（无旋转）：应为 (w/2, h/2, depth/2) 精确值
  const b = mod.computeHoleBox({ x: 1, y: 2, z: 3, rotX: 0, rotY: 0, rotZ: 0, xw: 2, xh: 1.6 }, 1.0);
  eq(b.cx, 1, '轴对齐：中心 x');
  eq(b.cy, 2, '轴对齐：中心 y');
  eq(b.cz, 3, '轴对齐：中心 z');
  near(b.hx, 1.0, 1e-9, '轴对齐：hx = w/2');
  near(b.hy, 0.8, 1e-9, '轴对齐：hy = h/2');
  near(b.hz, 0.5, 1e-9, '轴对齐：hz = depth/2');

  // rotY = 90°：窗户面朝 ±X，则「宽」跑到世界里是 z 方向
  const b2 = mod.computeHoleBox({ x: 0, y: 0, z: 0, rotY: Math.PI / 2, xw: 2, xh: 1.0 }, 1.0);
  near(b2.hx, 0.5, 1e-6, 'rotY=90°：hx 变成 depth/2');
  near(b2.hy, 0.5, 1e-6, 'rotY=90°：hy 仍 h/2');
  near(b2.hz, 1.0, 1e-6, 'rotY=90°：hz 变成 w/2');

  // 45° 旋转：轴对齐包围盒必须**不小于**旋转后盒子的真实投影
  const w = 2.0, d = 1.0, ang = Math.PI / 4;
  const b3 = mod.computeHoleBox({ rotY: ang, xw: w, xh: 0, rotX: 0, rotZ: 0 }, d);
  const expectX = Math.abs((w / 2) * Math.cos(ang)) + Math.abs((d / 2) * Math.sin(ang));
  near(b3.hx, expectX, 1e-6, 'rotY=45°：hx = 投影和（不是简单相加）');
  ok(b3.hx >= (w / 2) * Math.cos(ang) - 1e-9, 'hx 覆盖旋转后的真实投影');
  ok(b3.hz >= (w / 2) * Math.sin(ang) - 1e-9, 'hz 覆盖旋转后的真实投影');

  // 三轴都转：不能出现 NaN
  const b4 = mod.computeHoleBox({ rotX: 0.3, rotY: 0.4, rotZ: 0.5, xw: 1.4, xh: 1.2 }, 0.8);
  ok([b4.hx, b4.hy, b4.hz].every((v) => Number.isFinite(v) && v > 0), '三轴旋转 → 半轴均为有限正数');
}

// ---------------------------------------------------------------- ③ setHoleList
console.log('\n[3] setHoleList：写入共享 uniform，多余槽位必须清干净');
{
  const wins = [
    { x: 0, y: 1, z: 0, xw: 2, xh: 1, rotY: 0 },
    { x: 5, y: 1, z: 0, xw: 2, xh: 1, rotY: Math.PI / 2 },
  ];
  const n = mod.setHoleList(wins, 1.0);
  eq(n, 2, '返回生效洞数 = 2');
  eq(mod.holeUniforms.uHoleCount.value, 2, 'uHoleCount = 2');
  ok(mod.holeUniforms.uHoles.value[0].w === 1, '槽 0 已启用（w=1）');
  ok(mod.holeUniforms.uHoles.value[1].w === 1, '槽 1 已启用（w=1）');
  ok(mod.holeUniforms.uHoles.value[2].w === 0, '槽 2 未启用（w=0）');
  // 清干净：重新写更少的洞，残留槽必须归零
  mod.setHoleList([wins[0]], 1.0);
  eq(mod.holeUniforms.uHoleCount.value, 1, '重写为 1 个洞');
  ok(mod.holeUniforms.uHoles.value[1].w === 0, '上一轮的槽 1 已被清掉（不残留）');
  near(mod.holeUniforms.uHoleHalf.value[1].x, 0, 0, '上一轮的槽 1 半轴也归零');
  // 超量截断
  const many = Array.from({ length: mod.MAX_HOLES + 50 }, () => ({ x: 0, y: 0, z: 0, xw: 1, xh: 1 }));
  eq(mod.setHoleList(many, 1), mod.MAX_HOLES, '超量时截断到 MAX_HOLES');
  mod.setHoleList([], 1);
  eq(mod.holeUniforms.uHoleCount.value, 0, '清空后 uHoleCount = 0');
}

// ---------------------------------------------------------------- ④ 注入锚点必须在真源码里存在
console.log('\n[4] 注入锚点在 Three 真实着色器里存在');
const { ShaderLib } = await import('three');
{
  const physV = ShaderLib.physical.vertexShader;
  const physF = ShaderLib.physical.fragmentShader;
  const depthV = ShaderLib.depth.vertexShader;
  const depthF = ShaderLib.depth.fragmentShader;

  ok(physV.indexOf('#include <fog_vertex>') !== -1, 'physical.vertex 有 #include <fog_vertex>（我们的首选锚点）');
  ok(physV.indexOf('#include <begin_vertex>') < physV.indexOf('#include <fog_vertex>'),
    'begin_vertex 在 fog_vertex 之前（transformed 此时已定义）');
  ok(physF.indexOf('#include <clipping_planes_fragment>') !== -1, 'physical.fragment 有 clipping_planes_fragment');
  ok(depthF.indexOf('#include <clipping_planes_fragment>') !== -1, 'depth.fragment 有 clipping_planes_fragment');
  ok(depthV.indexOf('#include <fog_vertex>') === -1, 'depth.vertex **没有** fog_vertex → 必然走兜底分支（已验证）');
  ok(depthV.lastIndexOf('}') > depthV.indexOf('void main()'), 'depth.vertex 兜底锚点（最后一个 }）位于 main 之内');
  // 深度材质必须保留 alphatest 分支才可能 discard
  ok(depthF.indexOf('#include <alphatest_fragment>') !== -1 || depthF.indexOf('alphatest') !== -1,
    'depth.fragment 含 alphatest（alphaTest>0 时 discard 才会被保留）');
}

// ---------------------------------------------------------------- ⑤ injectHoleCode 真跑
console.log('\n[5] injectHoleCode：真注入，检查 GLSL 结构合法 + 幂等');
{
  const shader = {
    uniforms: {},
    vertexShader: ShaderLib.physical.vertexShader,
    fragmentShader: ShaderLib.physical.fragmentShader,
  };
  const did = mod.injectHoleCode(shader);
  ok(did === true, '首次注入返回 true');
  ok(shader.uniforms.uHoleCount === mod.holeUniforms.uHoleCount, '注入后 shader.uniforms 引用共享 uniform（uHoleCount）');
  ok(shader.uniforms.uHoles === mod.holeUniforms.uHoles, '注入后 shader.uniforms 引用共享 uniform（uHoles）');
  ok(shader.uniforms.uHoleHalf === mod.holeUniforms.uHoleHalf, '注入后 shader.uniforms 引用共享 uniform（uHoleHalf）');

  // vertex：varying 声明 + 赋值各一次
  const vDecls = countOccurrences(shader.vertexShader, 'varying vec3 vFpmWorldPos;');
  const vAssigns = countOccurrences(shader.vertexShader, 'vFpmWorldPos =');
  eq(vDecls, 1, 'vertex 里 varying 声明恰好 1 次');
  eq(vAssigns, 1, 'vertex 里 varying 赋值恰好 1 次');
  // 赋值必须在 void main() 之后、最后一个 } 之前
  const iAssign = shader.vertexShader.indexOf('vFpmWorldPos =');
  ok(iAssign > shader.vertexShader.indexOf('void main() {'), 'vertex 赋值在 main 体内');
  ok(iAssign < shader.vertexShader.lastIndexOf('}'), 'vertex 赋值在 main 结束前');

  // fragment：声明 + 判定函数 + discard
  ok(countOccurrences(shader.fragmentShader, 'bool inAnyWindowHole(') === 1, 'fragment 里判定函数恰好 1 个');
  ok(shader.fragmentShader.indexOf('bool inAnyWindowHole(') < shader.fragmentShader.indexOf('void main() {'),
    '判定函数声明在 main **之外**（GLSL 不允许函数嵌套）');
  ok(countOccurrences(shader.fragmentShader, 'varying vec3 vFpmWorldPos;') === 1, 'fragment 里 varying 声明恰好 1 次');
  ok(shader.fragmentShader.indexOf('inAnyWindowHole(vFpmWorldPos)) discard') !== -1, 'fragment 里含 discard 调用');
  const iDiscard = shader.fragmentShader.indexOf('inAnyWindowHole(vFpmWorldPos)) discard');
  ok(iDiscard > shader.fragmentShader.indexOf('void main() {'), 'discard 在 main 体内');
  ok(countOccurrences(shader.fragmentShader, 'uniform float uHoleCount;') === 1, 'uniform uHoleCount 声明恰好 1 次');
  ok(countOccurrences(shader.fragmentShader, '#define MAX_WINDOW_HOLES') === 1, '#define 恰好 1 次');

  // 幂等：再注入一次必须无变化
  const before = shader.fragmentShader;
  const did2 = mod.injectHoleCode(shader);
  ok(did2 === false, '二次注入返回 false（幂等守卫生效）');
  eq(shader.fragmentShader, before, '二次注入没有改动 shader 文本');

  // 深度材质（走兜底锚点）也要能注入成功
  const dsh = {
    uniforms: {},
    vertexShader: ShaderLib.depth.vertexShader,
    fragmentShader: ShaderLib.depth.fragmentShader,
  };
  ok(mod.injectHoleCode(dsh) === true, '深度材质也能注入（走兜底锚点）');
  eq(countOccurrences(dsh.vertexShader, 'vFpmWorldPos ='), 1, '深度 vertex 里赋值 1 次');
  eq(countOccurrences(dsh.fragmentShader, 'inAnyWindowHole(vFpmWorldPos)) discard'), 1, '深度 fragment 里 discard 1 次');
  // 深度材质的 discard 必须落在 main 里
  ok(dsh.fragmentShader.indexOf('inAnyWindowHole(vFpmWorldPos)) discard') > dsh.fragmentShader.indexOf('void main() {'),
    '深度 discard 在 main 体内');

  // 大括号必须配平（粗略但有效：注入没把结构写坏）
  ok(braceBalance(shader.fragmentShader) === 0, '注入后 fragment 大括号配平');
  ok(braceBalance(shader.vertexShader) === 0, '注入后 vertex 大括号配平');
  ok(braceBalance(dsh.fragmentShader) === 0, '注入后深度 fragment 大括号配平');
  ok(braceBalance(dsh.vertexShader) === 0, '注入后深度 vertex 大括号配平');

  // ⚠ 更严格的一条：注入**净增**的花括号必须正好抵消。
  //    （不能直接比对绝对平衡 —— three 的 physical fragment 里 #if/#else 分支内含花括号，
  //      朴素计数在全量展开后会给出非 0，那是预处理指令的假象，与本注入无关。）
  const dF = braceBalance(shader.fragmentShader) - braceBalance(ShaderLib.physical.fragmentShader);
  const dV = braceBalance(shader.vertexShader) - braceBalance(ShaderLib.physical.vertexShader);
  const dDF = braceBalance(dsh.fragmentShader) - braceBalance(ShaderLib.depth.fragmentShader);
  const dDV = braceBalance(dsh.vertexShader) - braceBalance(ShaderLib.depth.vertexShader);
  eq(dF, 0, 'fragment 注入净增花括号为 0（不破坏结构）');
  eq(dV, 0, 'vertex 注入净增花括号为 0');
  eq(dDF, 0, '深度 fragment 注入净增花括号为 0');
  eq(dDV, 0, '深度 vertex 注入净增花括号为 0');
  // 注入内容恰好是「varying 声明 + 函数 + 2 组花括号」
  eq(countOccurrences(shader.fragmentShader, '{') - countOccurrences(ShaderLib.physical.fragmentShader, '{'), 2,
    'fragment 只多了 2 个 {（判定函数的函数体 + for 循环体）');

  // include 展开后不得残留未解析的 #include（确认锚点替换没把 include 吃掉）
  ok(shader.fragmentShader.indexOf('#include <clipping_planes_fragment>') !== -1,
    '注入后 clipping_planes_fragment 的 include 指令仍保留（只是后面多了一行 discard）');
  ok(dsh.fragmentShader.indexOf('#include <clipping_planes_fragment>') !== -1,
    '深度材质注入后 clipping_planes_fragment 的 include 指令仍保留');
  ok(dsh.vertexShader.indexOf('#include <begin_vertex>') !== -1,
    '深度材质注入后 begin_vertex 仍保留（我们插在它之后）');
}

function countOccurrences(s, sub) {
  let n = 0, i = 0;
  for (;;) {
    const j = s.indexOf(sub, i);
    if (j === -1) break;
    n++; i = j + sub.length;
  }
  return n;
}
function braceBalance(s) {
  let d = 0;
  for (const c of s) { if (c === '{') d++; else if (c === '}') d--; }
  return d;
}

// ---------------------------------------------------------------- ⑥ patchBuildingMaterial
console.log('\n[6] patchBuildingMaterial：包装 onBeforeCompile，且不破坏原回调');
{
  let origCalls = 0;
  const mat = new THREE.MeshStandardMaterial();
  mat.onBeforeCompile = () => { origCalls++; };
  const first = mod.patchBuildingMaterial(mat);
  ok(first === true, '首次 patch 返回 true');
  const second = mod.patchBuildingMaterial(mat);
  ok(second === false, '重复 patch 返回 false（不会包两层 → 不会出现两份 #define）');

  // 真跑一次 onBeforeCompile，确认原回调被保留 & 注入生效
  const shader = { uniforms: {}, vertexShader: ShaderLib.physical.vertexShader, fragmentShader: ShaderLib.physical.fragmentShader };
  mat.onBeforeCompile(shader);
  eq(origCalls, 1, '原 onBeforeCompile 回调被调用（没被吃掉）');
  ok(shader.fragmentShader.indexOf('inAnyWindowHole') !== -1, 'patch 后注入生效');
  // 原回调抛异常也不能阻断注入
  const mat2 = new THREE.MeshStandardMaterial();
  mat2.onBeforeCompile = () => { throw new Error('boom'); };
  mod.patchBuildingMaterial(mat2);
  const sh2 = { uniforms: {}, vertexShader: ShaderLib.physical.vertexShader, fragmentShader: ShaderLib.physical.fragmentShader };
  let threw = false;
  try { mat2.onBeforeCompile(sh2); } catch (e) { threw = true; }
  ok(!threw, '原回调抛异常时仍不向外抛（try/catch 兜底）');
  ok(sh2.fragmentShader.indexOf('inAnyWindowHole') !== -1, '原回调抛异常后注入仍然生效');

  // 不是材质的输入要安全返回 false
  ok(mod.patchBuildingMaterial(null) === false, 'null 输入返回 false');
  ok(mod.patchBuildingMaterial({}) === false, '无 onBeforeCompile 的对象返回 false');
}

// ---------------------------------------------------------------- ⑦ patchShadowMaterial
console.log('\n[7] patchShadowMaterial：深度材质必须换成可 discard 的，且 alphaTest>0');
{
  const light = new THREE.DirectionalLight(0xffffff, 1);
  const before = light.shadow.customDepthMaterial;
  const did = mod.patchShadowMaterial(light);
  ok(did === true, '首次 patch 阴影返回 true');
  const dm = light.shadow.customDepthMaterial;
  ok(dm && dm.isMeshDepthMaterial === true, 'customDepthMaterial 已替换为 MeshDepthMaterial');
  ok(dm !== before, '确实换掉了原来的（null）');
  ok(dm.alphaTest > 0, 'alphaTest > 0（否则 Three 深度 shader 会把 discard 优化掉）');
  eq(dm.depthPacking, THREE.RGBADepthPacking, 'depthPacking 用 RGBADepthPacking（与 Three 阴影一致）');
  ok(mod.patchShadowMaterial(light) === false, '重复 patch 返回 false（幂等）');
  // 深度材质真的能注入
  const sh = { uniforms: {}, vertexShader: ShaderLib.depth.vertexShader, fragmentShader: ShaderLib.depth.fragmentShader };
  dm.onBeforeCompile(sh);
  ok(sh.fragmentShader.indexOf('inAnyWindowHole(vFpmWorldPos)) discard') !== -1, '阴影深度材质注入 discard 成功');
  ok(mod.patchShadowMaterial(null) === false, 'null 光源返回 false');
  ok(mod.patchShadowMaterial({}) === false, '无 shadow 的对象返回 false');
}

// ---------------------------------------------------------------- ⑧ applyWindowHoles 总入口
console.log('\n[8] applyWindowHoles：一个入口把数据 + 材质 + 阴影全部处理');
{
  mod.resetHolePatches();
  const m1 = new THREE.MeshStandardMaterial();
  const m2 = new THREE.MeshStandardMaterial();
  const light = new THREE.DirectionalLight(0xffffff, 1);
  const wins = [{ x: 0, y: 2, z: 0, xw: 2, xh: 1.5, rotY: 0 }];
  const st = mod.applyWindowHoles(wins, [m1, m2], [light], { depth: 1.0 });
  eq(st.count, 1, '写入 1 个洞');
  eq(st.patched, 2, '给 2 个材质打了补丁');
  eq(st.shadow, 1, '给 1 盏灯打了阴影补丁');
  // ⚠ Three 的 material.needsUpdate 是**只写 setter**（读取恒为 undefined），
  //   真正可断言的是 version 自增 —— 版本变了才会重编译。
  ok(m1.version > 0 && m2.version > 0, `打过补丁的材质 version 自增（强制重编译）  (${m1.version}/${m2.version})`);
  // 无窗户时（count=0）也要能安全工作
  const st2 = mod.applyWindowHoles([], [], [], {});
  eq(st2.count, 0, '空窗户列表 → 0 个洞');
  eq(mod.holeUniforms.uHoleCount.value, 0, '空列表后 uHoleCount=0（shader 分支直接跳过）');
}

// ---------------------------------------------------------------- ⑨ Merge 指纹约束
console.log('\n[9] ⚠ Merge 指纹不含 onBeforeCompile —— 洞参数必须走共享 uniform（约束钉死）');
{
  const mergeSrc = fs.readFileSync(path.join(ROOT, 'src/world/Merge.js'), 'utf8');
  const skipLine = mergeSrc.split('\n').find((l) => l.indexOf('MATERIAL_SKIP_KEYS') !== -1 && l.indexOf('Set(') !== -1);
  ok(!!skipLine, '找到 MATERIAL_SKIP_KEYS 定义');
  for (const key of ['defines', 'uniforms', 'userData']) {
    ok(skipLine.indexOf("'" + key + "'") !== -1, `指纹跳过 '${key}'（洞参数挂材质 uniform 会被合并吃掉）`);
  }
  // onBeforeCompile 是函数 → valueSig 折成 'fn'，**等于不参与区分** —— 必须显式断言
  ok(mergeSrc.indexOf("if (t === 'function') return 'fn';") !== -1,
    "函数型属性折成 'fn'（onBeforeCompile 相同 → 指纹相同 → 材质被合并）");
  // 因此本项目**只能**用共享 uniform：断言实现里没有任何「按材质存洞」的写法
  const fw = fs.readFileSync(path.join(ROOT, 'src/world/FakeWindow.js'), 'utf8');
  ok(fw.indexOf('holeUniforms') !== -1, '挖洞参数集中在 holeUniforms（共享对象）');
  ok(!/mat\.uniforms\.uHoles\s*=/.test(fw), '没有任何「把洞参数写进单个材质自己的 uniforms」的写法');
}

// ---------------------------------------------------------------- ⑩ 与真实源码逐字对照 GLSL
console.log('\n[10] 判定函数语义与手写实现一致（防止有人改坏边界比较）');
{
  const fw = fs.readFileSync(path.join(ROOT, 'src/world/FakeWindow.js'), 'utf8');
  // 抽取 holeChunkGLSL 产出的函数体
  const iFn = fw.indexOf('bool inAnyWindowHole');
  ok(iFn !== -1, '源码里能找到判定函数');
  const body = fw.slice(iFn, fw.indexOf('return false;', iFn) + 40);
  // 必须是「三轴同时 <=」才算命中（与 computeHoleBox 的轴对齐盒语义对应）
  ok(body.indexOf('df.x <= hf.x && df.y <= hf.y && df.z <= hf.z') !== -1,
    '命中判定为三轴同时 <= 半轴（轴对齐盒语义）');
  ok(body.indexOf('abs(') !== -1, '用 abs 取到中心的绝对距离（盒关于中心对称）');
  ok(body.indexOf('hl.w < 0.5') !== -1, '未启用槽位用 w 标志位跳过');
  ok(body.indexOf('float(i) >= uHoleCount') !== -1, '超出有效数量的槽位提前 break（省循环）');
}

// ---------------------------------------------------------------- 结果
console.log('\n' + (fails ? `✗ ${fails} 项失败` : '✓ 全部通过'));
process.exit(fails ? 1 : 0);
