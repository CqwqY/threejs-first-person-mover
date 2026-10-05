// 自检：组合家具「编辑器 → 服务端 → 摆出来」这条链上的角度单位（node tools/probe-combo-sanitize.mjs）
//
// 为什么要测：用户报「面光源在家具的时候会横着转了 90°」。根因不在前端，而在**服务端消毒**：
//   sanitizeCombo 曾把 rotX 按**弧度**钳到 ±2π（≈±6.283），而客户端单位是**度** ——
//   编辑器存的 -90（朝下照）被夹成 -6.283**度**，摆出来就几乎水平，看上去正好横过来 90°。
//   同一个错误还让部件 rotY 只能转 ±12.57°、面光源 distance 干脆被整个丢掉。
//
// ⚠ 这里**直接跑服务端 index.js 里的真实源码**（按锚点切出来求值），不是复制一份逻辑来测 ——
//    复制品会和服务端漂移，测了等于没测。不 import index.js 是因为它会 bind 9000 端口起服务。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'server-remote', 'index.js');
const src = fs.readFileSync(SRC, 'utf8');

let fails = 0;
function check(name, got, want, eps = 1e-6) {
  const ok = (typeof want === 'number' && typeof got === 'number') ? Math.abs(got - want) <= eps : got === want;
  if (!ok) { fails++; console.log(`  ✗ ${name}\n      期望 ${want}\n      实际 ${got}`); }
  else console.log(`  ok    ${name} = ${typeof got === 'number' ? got.toFixed(4) : got}`);
}

// 切出 sanitizeCombo 及其依赖常量（锚点：DEG_LO 常量 → saveShop 之前）
const a = src.indexOf('const DEG_LO');
const b = src.indexOf('function saveShop');
if (a < 0 || b < 0 || b < a) { console.log('✗ 找不到 sanitizeCombo 的锚点，服务端源码结构变了'); process.exit(1); }
const chunk = src.slice(a, b);
const sanitizeCombo = new Function(chunk + '\nreturn sanitizeCombo;')();

console.log('① 面光源俯仰角 -90°（度！）必须原样穿过服务端：');
{
  const out = sanitizeCombo({ parts: [], lights: [{ type: 'area', x: 0, y: 3, z: 0, intensity: 3, width: 4, height: 3, rotY: 0, rotX: -90 }] });
  const l = out.lights[0];
  check('rotX -90 不被钳坏（曾经被夹成 -6.283）', l.rotX, -90);
  check('rotY 0 保留', l.rotY, 0);
}
{
  const out = sanitizeCombo({ parts: [], lights: [{ type: 'area', rotX: -45, rotY: 30 }] });
  check('rotX -45 保留（大角度不再被夹到边界）', out.lights[0].rotX, -45);
  check('rotY 30 保留（曾经上限只有 12.57）', out.lights[0].rotY, 30);
}

console.log('② 缺字段时的兜底必须和前端 AREA_LIGHT_DEFAULTS 对齐：');
{
  const out = sanitizeCombo({ parts: [], lights: [{ type: 'area' }] });
  check('缺 rotX → -90（朝下），不是 0（水平）', out.lights[0].rotX, -90);
  check('缺 distance → 14（与 AREA_SHADOW_DISTANCE 一致）', out.lights[0].distance, 14);
}

console.log('③ 面光源的 distance 必须活着（阴影代理的范围，丢了就等于白调）：');
{
  const out = sanitizeCombo({ parts: [], lights: [{ type: 'area', rotX: -90, distance: 25 }] });
  check('distance 25 保留', out.lights[0].distance, 25);
  check('width/height 缺 → 4 / 3', out.lights[0].width + 'x' + out.lights[0].height, '4x3');
}

console.log('④ 组合部件的 rotY 也是度，不能再按弧度钳：');
{
  const out = sanitizeCombo({ parts: [{ url: '/models/a.glb', rotY: 90 }], lights: [] });
  check('部件 rotY 90 保留', out.parts[0].rotY, 90);
  const out2 = sanitizeCombo({ parts: [{ url: '/models/a.glb', rotY: -180 }], lights: [] });
  check('部件 rotY -180 保留', out2.parts[0].rotY, -180);
}

console.log('⑤ 点光源不受影响：');
{
  const out = sanitizeCombo({ parts: [], lights: [{ type: 'point', distance: 20, decay: 2 }] });
  check('distance/decay 保留', out.lights[0].distance + '/' + out.lights[0].decay, '20/2');
  check('点光源不带 width/rotX', 'width' in out.lights[0] || 'rotX' in out.lights[0], false);
}

console.log('⑥ 前端默认值必须只有一个来源（AREA_LIGHT_DEFAULTS），不许各写各的：');
{
  const { AREA_LIGHT_DEFAULTS } = await import('../src/world/Lights.js');
  check('AREA_LIGHT_DEFAULTS.rotX 为 -90（朝下）', AREA_LIGHT_DEFAULTS.rotX, -90);
  const files = ['src/editor/EditorApp.js', 'src/world/EditorBuildings.js', 'src/world/BuildingTool.js'];
  for (const f of files) {
    const s = fs.readFileSync(path.join(HERE, '..', f), 'utf8');
    check(`${f} 引用 AREA_LIGHT_DEFAULTS`, s.includes('AREA_LIGHT_DEFAULTS'), true);
  }
  // 读存档那处是最容易写死 0 的地方（历史 bug）：断言它不再是 num(it.rotX, 0)
  const ed = fs.readFileSync(path.join(HERE, '..', 'src/editor/EditorApp.js'), 'utf8');
  check('编辑器读存档不再写死 rotX: 0', /rotX:\s*num\(it\.rotX,\s*0\)/.test(ed), false);
}

console.log(fails ? `\n✗ ${fails} 项不通过` : '\n✓ 全部通过');
process.exit(fails ? 1 : 0);
