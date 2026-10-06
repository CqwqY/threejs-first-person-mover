// 静态自检：距离分级材质 LOD + 太阳阴影相机收紧（填充率优化落地）
// 不依赖运行时，纯文本断言，确保"实现没写错"（不证明它是瓶颈——瓶颈靠 perftest 实测）。
import { readFileSync } from 'fs';

const F = (p) => readFileSync(p, 'utf8');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.error('  ✗', m); } };

const game = F('src/core/Game.js');
const lights = F('src/world/Lights.js');
const editor = F('src/editor/EditorApp.js');

console.log('[A] 距离分级材质 LOD 方法齐备');
ok(game.includes('_scanLodCandidates('), 'Game 有 _scanLodCandidates');
ok(game.includes('_lodCheap('), 'Game 有 _lodCheap（廉价副本）');
ok(game.includes('_updateLod('), 'Game 有 _updateLod（每帧评估）');
ok(game.includes('_setLod('), 'Game 有 _setLod（按画质档开关）');
ok(game.includes('_rescanLod('), 'Game 有 _rescanLod（世界重建重扫）');

console.log('[B] LOD 落地到渲染循环与画质档');
ok(/\n\s*this\._updateLod\(this\.camera\.position\);/.test(game), '_updateLod 在每帧渲染循环里被调用');
ok(game.includes('this._setLod(q !== \'high\')'), '_applyQuality 按画质档开关 LOD（high 关）');
ok(game.includes('if (this._lodCands.length === 0) this._scanLodCandidates();'), '_updateLod 兜底补扫一次');

console.log('[C] 廉价副本确实砍片元成本（关接收阴影 + 关环境反射）');
const cheap = game.slice(game.indexOf('_lodCheap(base) {'));
const cheapBody = cheap.slice(0, cheap.indexOf('\n  }') + 1);
ok(cheapBody.includes('c.receiveShadow = false'), '_lodCheap 关 receiveShadow（主 pass 少一次阴影采样）');
ok(cheapBody.includes('c.envMapIntensity = 0'), '_lodCheap 关 envMapIntensity（少一次 IBL 采样，实测 E4≈0 影响）');
ok(cheapBody.includes('_cheapCache.set(base.uuid, c)'), '_lodCheap 按 base.uuid 缓存（共享几何/贴图，程序只编一次）');

console.log('[D] 距离判据只用 XZ（与失阴影一致，忽略 Y）');
const upd = game.slice(game.indexOf('_updateLod(camPos) {'));
const updBody = upd.slice(0, upd.indexOf('\n  }\n') + 1);
ok(updBody.includes('e.cx - camPos.x') && updBody.includes('e.cz - camPos.z'), '_updateLod 取水平 dx/dz（cx/cz 为缓存的世界中心 XZ）');
ok(!/dy/.test(updBody.slice(0, updBody.indexOf('const far'))), '_updateLod 不使用 Y 距离');
ok(updBody.includes('(dx * dx + dz * dz) > d2'), '远判定 = 水平距离平方 > 阈值²');

console.log('[E] 只换 material、绝不碰 visible（防静默失效#3）');
ok(!/__lodFar[^=]*=\s*true[^;]*visible/.test(updBody), '_updateLod 不改动 visible');
ok(updBody.includes('e.mesh.material = this._lodCheap(e.base)') && updBody.includes('e.mesh.material = e.base'), '_updateLod 只切换 material 引用');

console.log('[F] 太阳阴影相机收紧（减少阴影 pass 填充）');
ok(lights.includes('directional.shadow.camera.far = R + 80;'), 'Lights.createLights 太阳阴影 far = R+80');
ok(editor.includes('sun.shadow.camera.far = SHADOW_R + 80;'), 'EditorApp 太阳阴影 far = SHADOW_R+80');

console.log('[G] 预热覆盖 LOD 廉价材质（避免首次切换编译卡顿）');
ok(game.includes('this._lodCands[i].mesh.material = this._lodCheap(this._lodCands[i].base);') &&
   game.includes('if (typeof r.compile === \'function\') r.compile(this.scene, this.camera);'),
   '_precompileShaders 临时挂廉价副本并 compile 一次');

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
