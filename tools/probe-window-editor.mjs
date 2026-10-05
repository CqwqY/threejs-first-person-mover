// 自检：障眼法窗户的「编辑器六步清单」与序列化往返
//
// 记忆里明确写着：编辑器加工具页签**漏一步就点不动**，且「序列化」这一步最容易漏
// （本项目曾在「面光源 distance 只写给点光源、面光源不落盘」上栽过）。
// 所以这里按真实源码逐条断言，而不是靠肉眼。
//
// 跑法：node tools/probe-window-editor.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'editor.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'src/editor/EditorApp.js'), 'utf8');
const eb = fs.readFileSync(path.join(ROOT, 'src/world/EditorBuildings.js'), 'utf8');
const sb = fs.readFileSync(path.join(ROOT, 'src/world/SkyBox.js'), 'utf8');
const game = fs.readFileSync(path.join(ROOT, 'src/core/Game.js'), 'utf8');

let fails = 0;
function ok(cond, msg) {
  if (cond) console.log('  PASS  ' + msg);
  else { console.log('  FAIL  ' + msg); fails++; }
}
function has(src, needle, msg) { ok(src.includes(needle), msg); }
function miss(src, needle, msg) { ok(!src.includes(needle), msg); }

// ------------------------------------------------------- 六步清单
console.log('\n[1] 编辑器工具页签「六步清单」逐条核对');
// ① editor.html：按钮 + 面板
has(html, 'id="tWindow"', '①a editor.html 有工具按钮 #tWindow');
has(html, 'id="windowPanel"', '①b editor.html 有面板 #windowPanel');
// ② StepUI 引用
has(app, "btnWindow: document.getElementById('tWindow')", '②a StepUI 引用了 tWindow');
has(app, "windowPanel: document.getElementById('windowPanel')", '②b StepUI 引用了 windowPanel');
// ③ 手动绑 onclick（记忆：不是遍历自动绑）
has(app, "StepUI.btnWindow.onclick = () => setMode('window')", '③ 手写了 btnWindow.onclick（漏了就是「点都点不了」）');
// ④ setMode 的按钮清理数组 + map 表
ok(/'codes', 'window'\]/.test(app), '④a setMode 的按钮清理数组含 window');
has(app, 'codes: StepUI.btnCodes, window: StepUI.btnWindow', '④b setMode 的 map 表含 window');
// ⑤ 面板显隐分支
has(app, "const isWindow = m === 'window'", '⑤a setMode 计算 isWindow');
has(app, 'StepUI.windowPanel.style.display = isWindow', '⑤b setMode 显示/隐藏 windowPanel');
// ⑥ 进入时拉数据 / 回填面板
has(app, 'if (isWindow) syncWindowPanel()', '⑥ 进入窗户模式即回填面板');

// ------------------------------------------------------- 序列化
console.log('\n[2] 序列化：窗户字段必须全部落盘（最容易漏的一步）');
// 切出 serialize() 里的 placed 映射段
const serStart = app.indexOf('placed: state.placed.map');
const serEnd = app.indexOf('// 光源：与 placed 平级', serStart);
ok(serStart > 0 && serEnd > serStart, '找到 serialize() 的 placed 段');
const serSeg = app.slice(serStart, serEnd);
has(serSeg, "kind: 'window'", '序列化写出 kind: window（游戏端靠它分流）');
for (const f of ['rotX', 'rotY', 'rotZ', 'xw', 'xh', 'glass', 'opacity', 'mirror']) {
  has(serSeg, f + ':', `序列化写出 ${f}`);
}
// ⚠ 关键回归：窗户分支必须在「读 scale」之前 return，否则会因没有 scale 而崩
ok(/if \(rec\.kind === 'window'\) \{[\s\S]{0,900}?\n\s*return \{/.test(serSeg),
  '窗户分支在 placed 映射里提前 return（不落到普通模型的 scale 逻辑）');

console.log('\n[3] 反序列化：restore() 必须读回窗户字段');
const resStart = app.indexOf('for (const it of placedList) {');
const resEnd = app.indexOf('// 3) 重建光源', resStart);
ok(resStart > 0 && resEnd > resStart, '找到 restore() 的 placed 循环');
const resSeg = app.slice(resStart, resEnd);
has(resSeg, "it.kind === 'window'", 'restore 识别 kind === window');
for (const f of ['rotX', 'rotY', 'rotZ', 'xw', 'xh', 'glass', 'opacity', 'mirror']) {
  has(resSeg, f + ':', `restore 读回 ${f}`);
}
has(resSeg, 'buildWindowObject(wrec)', 'restore 调 buildWindowObject 建网格');
has(resSeg, 'continue;', 'restore 的窗户分支 continue（不进模型加载路径）');

// ------------------------------------------------------- 游戏端消费
console.log('\n[4] 游戏端 EditorBuildings 必须能消费窗户数据');
const ebPlaced = eb.slice(eb.indexOf('placed.forEach((it) => {'));
const ebWinIdx = ebPlaced.indexOf("it.kind === 'window'");
const ebScaleIdx = ebPlaced.indexOf('const sc = normScale(it.scale)');
ok(ebWinIdx > 0, 'EditorBuildings 识别 it.kind === window');
ok(ebWinIdx < ebScaleIdx, '窗户分支在 normScale(it.scale) **之前**（否则 undefined 会崩）');
has(ebPlaced, 'createWindowMesh(', 'EditorBuildings 用 createWindowMesh 建窗户');
has(ebPlaced, 'holder.rotation.set(', '窗户用三轴旋转（贴斜墙需要 rotX/rotZ）');
has(ebPlaced, 'windowMeshes.push(mesh)', '窗户登记进 windowMeshes 便于后续同步环境贴图');
ok(/it\.kind === 'window'[\s\S]{0,1400}?return;/.test(ebPlaced.slice(ebWinIdx)),
  '窗户分支及时 return（不参与碰撞体/LOD/批次合并）');
has(eb, 'export function syncFakeWindowEnvs', '导出 syncFakeWindowEnvs');
has(eb, 'syncFakeWindowEnvs(scene)', 'buildEditorBuildings 结束时同步一次环境贴图');

// ------------------------------------------------------- 环境贴图换新
console.log('\n[5] 环境贴图换新必须通知窗户（否则窗里永远是旧天空）');
has(sb, 'opts.onEnvChange', 'SkyBox createTimeSky 支持 onEnvChange 回调');
ok((sb.match(/notifyEnv\(\)/g) || []).length >= 2,
  `SkyBox 在两处环境赋值后都调了 notifyEnv()（实得 ${(sb.match(/notifyEnv\(\)/g) || []).length} 处）`);
ok(!sb.split('\n').some((l) => /^\s*import\b/.test(l) && l.includes('EditorBuildings')),
  'SkyBox 的真实 import 语句里没有 EditorBuildings（用回调而非直接依赖，避免循环引用）');
has(game, 'onEnvChange: () => syncFakeWindowEnvs(this.scene)', 'Game 把 onEnvChange 接到 syncFakeWindowEnvs');

// ------------------------------------------------------- 每帧不写 uniform
console.log('\n[6] 不在帧循环里无脑写 uniform（性能约定）');
const loopStart = app.indexOf('function loop() {');
const loopEnd = app.indexOf('requestAnimationFrame(loop);', loopStart);
const loopSeg = app.slice(loopStart, loopEnd);
has(loopSeg, 'if (scene.environment !== _lastWindowEnv)', '编辑器 loop 只在环境贴图**引用变化**时才同步');
ok(!/refreshWindowMaterial\(/.test(loopSeg), '编辑器 loop 里不逐帧刷窗户材质');

// ------------------------------------------------------- 不释放共享资源
console.log('\n[7] 不得误释放共享的环境贴图');
const fwSrc = fs.readFileSync(path.join(ROOT, 'src/world/FakeWindow.js'), 'utf8');
const dispoSeg = fwSrc.slice(fwSrc.indexOf('export function disposeWindow'));
ok(!/tEnv[^;]*\.dispose\(/.test(dispoSeg), 'disposeWindow 不 dispose tEnv');
// 游戏端窗户段（ebPlaced 在 §4 已切出）
const ebWinSeg = ebPlaced.slice(ebWinIdx, ebWinIdx + 1800);
has(ebWinSeg, 'env: scene.environment || null', '游戏端（EditorBuildings）只**引用**环境贴图（不 clone、不 dispose）');
has(app, 'const env = scene.environment || null;', '编辑器 buildWindowObject 只**引用**环境贴图（不 clone、不 dispose）');

// ------------------------------------------------------- 无静默吞错
console.log('\n[8] 新增代码不得有空 catch 吞错（本项目血泪教训）');
const newBlocks = [
  ['FakeWindow.js', fwSrc],
  ['EditorBuildings 窗户段', ebPlaced.slice(ebWinIdx, ebWinIdx + 1600)],
];
for (const [name, src] of newBlocks) {
  const empties = src.match(/catch\s*\(\s*\)\s*\{\s*\}/g) || [];
  ok(empties.length === 0, `${name} 没有空 catch（实得 ${empties.length} 处）`);
}

// ------------------------------------------------------- 挖洞（hole）链路
console.log('\n[9] 挖洞（hole）字段的「五步链」必须全部打通');
// ① HTML 有勾选框
has(html, 'id="winHole"', '①a editor.html 有挖洞勾选框 #winHole');
has(html, '挖穿墙体', '①b editor.html 有挖洞说明区');
// ② StepUI 引用 + 回填 + 事件
has(app, "winHole: document.getElementById('winHole')", '②a StepUI 引用 winHole');
has(app, 'StepUI.winHole.checked = rec.hole === true', '②b syncWindowPanel 回填勾选状态');
has(app, "StepUI.winHole.addEventListener('change'", '②c 勾选框绑了 change 事件');
has(app, 'rec.hole = !!StepUI.winHole.checked', '②d change 写回 rec.hole');
// ③ 新建/复制带默认值
ok(/hole: true,/.test(app), '③a 新建窗户默认开洞（hole: true）');
ok(/hole: rec\.hole === true,/.test(app), '③b 复制窗户带上 hole 字段');
// ④ 序列化 / 反序列化
has(serSeg, 'hole:', '④a serialize 写出 hole');
has(resSeg, 'hole: it.hole === true', '④b restore 读回 hole（旧存档缺省 false，不会突然到处开洞）');
// ⑤ 游戏端消费 + 应用
has(ebPlaced, 'if (it.hole === true)', '⑤a EditorBuildings 收集 hole 窗户');
has(eb, '_holeWins.push', '⑤b 收集进 _holeWins（供 applyEditorHoles 用）');
has(eb, 'export function applyEditorHoles', '⑤c 导出 applyEditorHoles');
has(eb, 'applyWindowHoles(wins, mats, lights', '⑤d 调 applyWindowHoles 真正打补丁');
ok(/await whenEditorLoadsSettled\(\);[\s\S]{0,400}?applyEditorHoles\(scene\)/.test(eb),
  '⑤e 挖洞在**模型加载完之后**才应用（材质此刻才存在）');
ok(eb.indexOf('applyEditorHoles(scene)') < eb.indexOf('mergeSceneBatches(scene)'),
  '⑤f 挖洞在跨物件合并**之前**（避免补丁打在将被丢弃的材质实例上）');

console.log('\n[10] 挖洞的性能契约：零额外 draw call / 三角面 / 渲染趟数');
// 挖洞是纯 shader discard —— 不得引入任何新的 Mesh / 渲染 pass
const holeApplySrc = fwSrc.slice(fwSrc.indexOf('export function applyWindowHoles'));
ok(!/new THREE\.Mesh/.test(holeApplySrc), 'applyWindowHoles 不新建任何 Mesh（不增加 draw call）');
ok(!/new THREE\.WebGLRenderTarget/.test(fwSrc), 'FakeWindow 不创建 RenderTarget（不增加渲染趟数/显存）');
ok(!/PlaneGeometry/.test(holeApplySrc), 'applyWindowHoles 不建几何（不增加三角面）');
// 每帧不同步
ok(!/syncHoles\(\)/.test(loopSeg), '编辑器 loop 里不逐帧同步挖洞（syncHoles 会遍历材质）');

console.log('\n[11] 编辑器挖洞同步的调用时机（漏一处 = 洞不跟手）');
// 拖拽结束
has(app, "state.selected.kind === 'window' && state.selected.hole) syncHoles()",
  '拖动窗户结束 → syncHoles（洞跟着走）');
// 面板改尺寸/朝向 → 洞形状变了
ok(/if \(rebuildGeo\) applyWindowTransform\(rec\);[\s\S]{0,200}?if \(rec\.hole\) syncHoles\(\)/.test(app),
  '面板改尺寸/朝向 → syncHoles（洞形状跟着变）');
// 删除
ok(/if \(wasWindow\) syncHoles\(\)/.test(app), '删除挖洞窗户 → syncHoles（洞跟着消失）');
// 新建 / 复制 / 模型加载完
ok(/syncHoles\(\);\s*return rec;/.test(app), '新建窗户 → syncHoles');
ok(/syncHoles\(\);\s*return wcopy;/.test(app), '复制窗户 → syncHoles');
has(app, 'autoFitCollider(item); syncHoles();', '新放模型加载完 → syncHoles（晚到的材质也能吃上补丁）');

console.log('\n[12] 挖洞共享 uniform（Merge 指纹不含 onBeforeCompile 的应对）');
has(app, 'applyWindowHoles(wins, mats, lights, { depth: HOLE_DEPTH })',
  '编辑器走统一入口 applyWindowHoles（洞参数写入共享 uniform）');
ok(!/mats\[i\]\.uniforms/.test(app), '编辑器没有把洞参数写进单个材质自己的 uniforms');
has(app, 'const HOLE_DEPTH = 1.2;', '编辑器定义洞厚常量（穿透厚墙）');

console.log('\n' + (fails === 0 ? '✅ 全部通过' : `❌ ${fails} 项失败`));
process.exit(fails === 0 ? 0 : 1);
