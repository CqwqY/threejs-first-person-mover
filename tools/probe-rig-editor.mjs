// 静态断言：编辑器「骨骼」页签的接线必须齐全。
// 这类失效是静默的：按钮没绑 onclick = 点了没反应，面板没进显隐分支 = 永远看不到，
// 而且 node --check / esbuild 都抓不到「少一行 DOM 绑定」这种错误。
// 编辑器页签共 6 步（见 .workbuddy/memory/MEMORY-assets-ui.md），这里逐项钉死。
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const html = read('editor.html');
const app = read('src/editor/EditorApp.js');
const rig = read('src/editor/RigEditor.js');
const bake = read('tools/auto-rig.mjs');
const vite = read('vite.config.js');
const presets = JSON.parse(read('src/player/rigPresets.json'));

let pass = 0;
const fails = [];
function ok(name, cond) {
  if (cond) pass++;
  else fails.push(name);
}
function has(src, text, name) { ok(name, src.includes(text)); }

// ① HTML：工具按钮 + 面板 + 所有控件 id 都必须存在且唯一
const ids = [
  'tRig', 'rigPanel', 'rigGender', 'rigBone', 'rigX', 'rigY', 'rigZ',
  'rigScaleZ', 'rigScaleY', 'rigOffsetY', 'rigShowMesh', 'rigBtnFocus',
  'rigBtnAutoFit', 'rigBtnCopyOther', 'rigBtnReset', 'rigBtnSave',
  'rigBtnExport', 'rigFile', 'rigStatus', 'rigBoneInfo',
];
for (const id of ids) {
  const hits = html.split('id="' + id + '"').length - 1;
  ok('editor.html 唯一 id=' + id, hits === 1);
}

// ② StepUI 引用 + import + 实例创建
has(app, "import { createRigEditor } from './RigEditor.js';", 'EditorApp import');
has(app, "btnRig: document.getElementById('tRig')", 'StepUI.btnRig');
has(app, "rigPanel: document.getElementById('rigPanel')", 'StepUI.rigPanel');
has(app, 'createRigEditor({ scene, camera, controls })', '创建 rigEditor 实例');

// ③ setMode：模式数组 / map / 显隐 / gizmo / 组合退出 / 面板回收
ok('setMode 模式数组含 rig', /\['select'[^;]*'window', 'rig'\]/.test(app));
has(app, 'rig: StepUI.btnRig', 'setMode map.rig');
has(app, "const isRig = m === 'rig';", 'setMode isRig');
has(app, 'rigPanel.style.display = isRig', '面板显隐分支');
ok('rig 不挂 3D 轴', /isBound \|\| isTrack \|\| isShop \|\| isFurn \|\| isRig/.test(app));
ok('组合模式会退出', /'codes' \|\| m === 'rig'/.test(app));
has(app, "StepUI.btnRig.onclick = () => setMode('rig')", '按钮 onclick（漏了点不动）');
has(app, 'rigEditor.activate()', '进入时 activate');
has(app, 'rigEditor.deactivate()', '离开时 deactivate');
ok('activate 排在相机恢复之后', app.indexOf('rigEditor.activate()') > app.indexOf('restoreAllVisible();'));
has(app, "if (StepUI.rigPanel) StepUI.rigPanel.style.display = 'none';", '组合模式隐藏面板');

// ④ RigEditor：导出、配置源、可视化、失败出声、无空 catch
has(rig, 'export function createRigEditor', '导出 createRigEditor');
has(rig, "import defaultPresets from '../player/rigPresets.json'", '读共享配置');
has(rig, "instantiate('/assets/' + g + '.glb')", '加载原始未绑骨模型');
has(rig, 'function refreshViz()', '骨骼点刷新');
has(rig, 'holder.add(bonesGroup)', '异步空窗期骨骼点可见');
has(rig, 'holder.userData.noCull = true', '预览模型排除背面收敛');
has(rig, 'obj.visible = false;', '切性别时旧模型不串显示');
has(rig, "fetch('/api/rig-presets'", '写入项目文件通道');
ok('无空 catch', !/\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/.test(rig));

// ⑤ 烘焙脚本：必须真的按性别读配置，不能还用一套写死的 BONE_DEF
has(bake, 'function presetsFor(gender)', '按性别取配置');
has(bake, "new URL('../src/player/rigPresets.json', import.meta.url)", '读共享配置');
has(bake, 'const cfg = presetsFor(gender);', 'bake 调用 presetsFor');
has(bake, 'const BONE_DEF = cfg.bones;', 'bake 用配置里的骨骼');
has(bake, 'const anims = cfg.anims;', 'bake 用配置里的动画');
ok('没有模块级 N_BONES', !/^const N_BONES =/m.test(bake));
has(bake, 'const DEFAULT_BONES = [', '内置默认兜底');

// ⑥ vite dev 写盘接口
has(vite, "'/api/rig-presets'", 'dev 写盘路由');
has(vite, "path.join(root, 'src', 'player', 'rigPresets.json')", '写回源码配置');

// ⑦ 配置内容：两套独立、拓扑完整、父骨引用有效、无 NaN
for (const g of ['boy', 'girl']) {
  const c = presets[g];
  ok(g + ' 存在', !!c);
  if (!c) continue;
  ok(g + ' 17 根骨', Array.isArray(c.bones) && c.bones.length === 17);
  ok(g + ' 3 段动画', Array.isArray(c.anims) && c.anims.length === 3);
  const names = new Set(c.bones.map((b) => b[0]));
  ok(g + ' 骨名唯一', names.size === c.bones.length);
  ok(g + ' 父骨引用有效', c.bones.every((b) => b[1] === null || names.has(b[1])));
  ok(g + ' 坐标均为有限数', c.bones.every((b) => Array.isArray(b[2]) && b[2].length === 3 && b[2].every(Number.isFinite)));
  ok(g + ' 动画参数齐全', c.anims.every((a) => ['period', 'A', 'A2', 'A3'].every((k) => Number.isFinite(a[k]))));
}

console.log('[probe-rig-editor] ' + pass + ' 项通过，' + fails.length + ' 项失败');
for (const f of fails) console.log('  FAIL ' + f);
if (fails.length) process.exit(1);
