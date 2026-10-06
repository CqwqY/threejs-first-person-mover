// 自检：每帧热路径的分配与资源复用（投掷物池化 / Boss 选目标 / 性能契约）
//
// 为什么要测：这类改动的收益是"少一次 GC 微卡"，**功能上完全看不出来**——
// 写错了（比如池里返回了 material=null 的 mesh、或者某处又去 dispose 共享材质）
// 表现可能是"投掷物突然变黑/报错"，也可能是"一点没变快"，两者都不会在编译期暴露。
// 所以这里真调用 Game 的原型方法验证复用与"绝不 dispose 共享资源"。
//
// 跑法：node tools/probe-perf-frame.mjs
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

const { Game } = await import(pathToFileURL(path.join(ROOT, 'src/core/Game.js')).href);
const src = fs.readFileSync(path.join(ROOT, 'src/core/Game.js'), 'utf8');

const P = Game.prototype;

// 假的宿主对象：_obtainProjMesh / _releaseProjMesh 只用到 scene 与 _projPool
function mkHost() {
  const scene = { added: [], removed: [], add(m) { this.added.push(m); }, remove(m) { this.removed.push(m); } };
  return { scene, _projPool: [] };
}

// ---------------------------------------------------------------- ① 池的复用
console.log('\n[1] 投掷物池：释放的 mesh 会被下次取用（不再每次开火都新建）');
{
  const h = mkHost();
  const a = P._obtainProjMesh.call(h, 0xff6a3c);
  ok(a && a.isMesh === true, '取到 mesh');
  eq(h.scene.added.length, 1, '取用时加进场景');
  P._releaseProjMesh.call(h, a);
  eq(h._projPool.length, 1, '释放后进了池');
  eq(h.scene.removed.length, 1, '释放时移出场景');
  eq(a.visible, false, '池里的 mesh 是隐藏的（不会被渲染）');

  const b = P._obtainProjMesh.call(h, 0x59c2ff);
  ok(b === a, '再次取用拿到的是同一个 mesh（真复用，不是新建）');
  eq(h._projPool.length, 0, '池被取空');
  eq(b.visible, true, '取出后重新可见');
  eq(b.material.color.getHex(), 0x59c2ff, '材质按新颜色重新绑定');
  eq(h.scene.added.length, 2, '复用也要重新加进场景（释放时已移除）');
}

// ---------------------------------------------------------------- ② 共享几何/材质
console.log('\n[2] 几何与材质是共享的（每次开火不再上传一份新几何）');
{
  const h = mkHost();
  const a = P._obtainProjMesh.call(h, 0x111111);
  const b = P._obtainProjMesh.call(h, 0x111111);
  ok(a.geometry === b.geometry, '两次取用的几何是同一份（没有 new SphereGeometry）');
  ok(a.material === b.material, '同色两次取用的材质是同一份（按颜色缓存）');
  const c = P._obtainProjMesh.call(h, 0x222222);
  ok(c.material !== a.material, '不同颜色用不同材质（缓存按颜色分键）');
  ok(c.geometry === a.geometry, '不同颜色仍共享几何');
}

// ---------------------------------------------------------------- ③ 绝不 dispose 共享资源（核心）
console.log('\n[3] 释放绝不 dispose 共享几何/材质（一处误 dispose = 全场投掷物变黑）');
{
  const h = mkHost();
  const a = P._obtainProjMesh.call(h, 0x333333);
  const geo = a.geometry, mat = a.material;
  let geoDisposed = 0, matDisposed = 0;
  const og = geo.dispose, om = mat.dispose;
  geo.dispose = function () { geoDisposed++; return og.apply(this, arguments); };
  mat.dispose = function () { matDisposed++; return om.apply(this, arguments); };
  P._releaseProjMesh.call(h, a);
  geo.dispose = og; mat.dispose = om;
  eq(geoDisposed, 0, '释放时没有 dispose 共享几何');
  eq(matDisposed, 0, '释放时没有 dispose 共享材质');

  // 复用取回后资源仍然可用（说明确实没被销毁）
  const b = P._obtainProjMesh.call(h, 0x333333);
  ok(b.geometry === geo && b.material === mat, '复用取回后几何/材质还是同一份且完好');

  // 池上限：超上限的 mesh 不再入池（避免一波爆发后常驻）
  const h2 = mkHost();
  const keep = [];
  for (let i = 0; i < 60; i++) keep.push(P._obtainProjMesh.call(h2, 0x444444));
  for (const m of keep) P._releaseProjMesh.call(h2, m);
  ok(h2._projPool.length <= 32, `池有上限（${h2._projPool.length} ≤ 32），不会无限增长`);
  ok(h2._projPool.length >= 8, '但也没小到失去复用意义');
}

// ---------------------------------------------------------------- ④ 源码：投掷物路径不再自建/自毁资源
console.log('\n[4] 源码约束：投掷物路径不再 per-shot 建/毁资源');
{
  ok(!/new THREE\.SphereGeometry\(0\.16/.test(src), '不再每次开火 new SphereGeometry');
  // ⚠ 必须限定在投掷物的两个入口函数体内：模块级的 projMaterial() 里**本来就该**有一处
  //   `new MeshStandardMaterial`（那是缓存工厂，只跑一次）。
  const fnBody = (decl) => {
    const i = src.indexOf(decl);
    if (i < 0) return '';
    let depth = 0;
    for (let k = src.indexOf('{', i); k < src.length; k++) {
      if (src[k] === '{') depth++;
      else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(i, k + 1); }
    }
    return src.slice(i);
  };
  const throwBody = fnBody('_throwProjectile(spec) {');
  const remoteBody = fnBody('_spawnRemoteProjectile(msg) {');
  ok(throwBody.length > 200 && remoteBody.length > 100, '抽到两个投掷物入口的函数体');
  ok(!/new THREE\.Mesh/.test(throwBody), '_throwProjectile 不再 new Mesh');
  ok(!/new THREE\.Mesh/.test(remoteBody), '_spawnRemoteProjectile 不再 new Mesh');
  ok(!/new THREE\.MeshStandardMaterial/.test(throwBody + remoteBody), '投掷物入口不再新建材质');
  ok(!/\.dispose\(\)/.test(throwBody + remoteBody), '投掷物入口不再 dispose 任何东西');
  ok(/const PROJ_GEO = new THREE\.SphereGeometry/.test(src), '有一份模块级共享几何 PROJ_GEO');
  ok(/function projMaterial\(color\)/.test(src), '有按颜色缓存的 projMaterial()');
  ok(/const PROJ_POOL_MAX = \d+/.test(src), '池有上限常量');

  // 投掷物的三个回收点都必须走 _releaseProjMesh
  const rel = (src.match(/_releaseProjMesh\(/g) || []).length;
  ok(rel >= 4, `_releaseProjMesh 有 ${rel} 处调用（命中 / boom 收远端 / 清场 + 定义）`);
  // 投掷物路径里不得再出现直接 dispose
  const directDispose = /this\._projectiles[\s\S]{0,400}?\.mesh\.material\.dispose\(\)/.test(src);
  ok(!directDispose, '投掷物路径里不再有 mesh.material.dispose()');
  ok(/\/\/ ⚠ 共享资源\*\*绝不能 dispose\*\*/.test(src) || /绝不能 dispose/.test(src),
    '源码里写明了「共享资源绝不能 dispose」的警示（防后人改回去）');
}

// ---------------------------------------------------------------- ⑤ Boss 选目标不再建中间数组
console.log('\n[5] _updateBoss 选目标：不建中间数组/对象');
{
  const i = src.indexOf('_updateBoss(dt) {');
  ok(i > 0, '定位到 _updateBoss');
  let depth = 0, end = -1;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) { end = k; break; } }
  }
  const body = src.slice(i, end + 1);
  ok(body.length > 200, '抽到函数体');
  ok(!/const\s+players\s*=\s*\[/.test(body), '不再每帧 new players 数组');
  ok(!/players\.push/.test(body), '不再逐个 push 玩家对象');
  ok(/let\s+best\s*=\s*Config\.BOSS_CHASE_RANGE/.test(body), '仍然是"最近且在追击范围内"才成为目标（语义不变）');
  ok(/if \(this\.boss\.mode === 'idle'\)/.test(body), 'idle 早返回仍在（Boss 未召唤时整块跳过）');
}

// ---------------------------------------------------------------- ⑥ 保留的对照：不该被误改的
console.log('\n[6] 对照组：追踪导弹 / 捉迷藏方块仍是"各自持有资源"（它们是低频、长寿命）');
{
  ok(/this\._missiles/.test(src) && /_morphs/.test(src), '导弹与方块系统仍在');
  // 这两个系统每局数量少、生命周期长，不属于 GC 热点，故意不改 —— 探针只记录，不强制
  ok(true, '（仅记录：它们的 dispose 保留原样）');
}

console.log('\n' + (fails ? `✗ ${fails} 项失败` : '✓ 全部通过'));
process.exit(fails ? 1 : 0);
