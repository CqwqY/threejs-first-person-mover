// 建造模式「编辑」交互的守卫探针（纯静态断言，不依赖浏览器/WebGL）。
// 守两件事：
//  ① 删除必须**乐观删除**（先本地移除再发请求）—— 只发请求等回执 = 服务端查不到记录时不广播
//     → 模型永远不消失（用户报的「点了删除不会立即去除模型」）。
//  ② 编辑操作是「模式 → 轴向 → 滑动调节」三段式；且只提供服务端存得下的轴
//     （服务端 build_move 只存 x/y/z + 单个 scale + rotY），否则重载打回原形 = 静默失效。
// 用法：node tools/probe-build-edit.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'src', 'world', 'BuildingTool.js'), 'utf8').replace(/\r\n/g, '\n');

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ok   ' : '  FAIL ') + msg); if (!cond) fails++; };

// 花括号配对抽函数体（不要用 indexOf 到文件尾的切片写法，会把后面的代码全断言进去）
function blockAt(anchor) {
  const i = src.indexOf(anchor);
  if (i < 0) return '';
  const b = src.indexOf('{', i);
  let depth = 0;
  for (let p = b; p < src.length; p++) {
    if (src[p] === '{') depth++;
    else if (src[p] === '}') { depth--; if (depth === 0) return src.slice(b, p + 1); }
  }
  return '';
}

console.log('[1] 删除：先本地移除，再通知服务端');
const del = blockAt('function deleteEdit');
ok(del.includes('onDel(id)'), '先调 onDel 本地移除（含退出编辑态）');
ok(del.indexOf('onDel(id)') < del.indexOf('sendBuildDel(id)'), '顺序：本地删除在发请求之前');
ok(del.includes("onToast('已删除')"), '删除给出反馈（不能静默）');

console.log('[2] 三段式编辑：模式 → 轴向 → 滑动');
const strip = blockAt('function refreshStrip');
ok(/\['move', '移动'\], \['scale', '缩放'\], \['rotate', '旋转'\]/.test(strip), '底部有三种操作模式：移动/缩放/旋转');
ok(strip.includes('state.editOp = op'), '点模式切换 state.editOp');
ok(strip.includes('state.editAxis = ax'), '点轴向切换 state.editAxis');
ok(strip.includes('axesFor(op)[0][0]'), '换模式后轴向落回该模式第一个可用轴（避免轴向不存在）');
ok(strip.includes('mkSlider()'), '第三行是滑动调节条');

console.log('[3] 滑动条：向上加、向下减');
const slider = blockAt('function mkSlider');
ok(slider.includes('const dy = startY - e.clientY'), '位移按「向上为正」计算');
ok(/while \(dy - acc >= STEP_PX\) \{ acc \+= STEP_PX; editStep\(1\)/.test(slider), '向上滑过一档 → +1');
ok(slider.includes('editStep(-1)'), '向下滑 → -1');
ok(slider.includes("touch-action:none"), '禁掉页面滚动（否则手机上滑动会带着页面动）');
ok(slider.includes("'wheel'"), 'PC 上滚轮也能调');
ok(slider.includes('pointercancel'), 'pointercancel 收尾（手指被系统打断时不卡住）');

console.log('[4] 一档改动落到三种操作上');
const step = blockAt('function editStep');
ok(step.includes('nudge(') && step.includes("state.editOp === 'move'"), '移动：走 nudge（含范围钳制）');
ok(step.includes('e.mesh.scale.setScalar(s)'), '缩放：改 mesh 与 rec 的 scale');
ok(step.includes('state.rotY = (state.rotY + dir * ROT_STEP)'), '旋转：按档改 rotY');
ok(step.includes('refreshSlider()'), '每档刷新滑块上的数值');

console.log('[5] 只提供服务端存得下的轴（防重载打回原形）');
const axes = blockAt('const AXES_BY_OP = ');
ok(axes.includes("move: [['x'") && axes.includes("['z', 'Z 前后']"), '移动：X / Y / Z 三轴（服务端存 x/y/z）');
ok(axes.includes("scale: [['all'"), '缩放：只有整体等比（服务端只存单个 scale）');
ok(axes.includes("rotate: [['y'"), '旋转：只有绕竖轴 Y（服务端只存 rotY）');
const commit = blockAt('function commitEdit');
ok(commit.includes('scale: Number(e.rec.scale) || 1'), '完成时把当前 scale 提交上去（原来写死 1）');

console.log(fails ? '\n' + fails + ' 条失败' : '\n全部通过');
process.exit(fails ? 1 : 0);
