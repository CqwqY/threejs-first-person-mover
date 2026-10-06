// 自检：人物「身体」绝不允许在空中消失（静默失效高危区）
//
// 症状（线上真出过）：对方在线、名牌与手持物都看得见，就是**人没了**，而且朝他挥武器也判定不到。
// 根因链：`buildBody` 里先 `bodyHolder.clear()` 再加新的身体 —— 只要中间任何一步失败
// （GLB 加载失败 / 抛错 / 被导航打断），bodyHolder 就永久空掉。名牌和手持物挂在 group 的
// 独立锚点上，跟 bodyHolder 无关 → 照常显示；攻击射线在模型里找不到网格 → 判定不到。
// 全程**零报错**，只能靠断言守住。
//
// 另有同链条的二次坑：AssetLoader 把**失败**的 Promise 也永久留在缓存里，
// 一次瞬时失败会毒死整场（之后再也不会重试）→ 也必须断言「失败即逐出缓存」。
//
// 跑：node tools/probe-player-body.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
function ok(cond, name, extra = '') {
  if (cond) console.log('  ok    ' + name + (extra ? ' — ' + extra : ''));
  else { fails++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
// 去掉整行注释再断言：注释里提到函数名的假阳性太常见了
const strip = (s) => s.replace(/\/\/.*$/gm, '');
// 花括号配对抽函数体（⚠ 不能用 indexOf 一路切到文件末尾，会把后面别的函数也算进来）
function blockAt(s, startIdx) {
  const i = s.indexOf('{', startIdx);
  if (i < 0) return '';
  let d = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '{') d++;
    else if (s[j] === '}') { d--; if (d === 0) return s.slice(i, j + 1); }
  }
  return '';
}
const bodyOf = (s, sig) => blockAt(s, s.indexOf(sig));

const PM = 'src/player/PlayerModel.js';
const AL = 'src/world/AssetLoader.js';
const MJ = 'src/main.js';
const pm = src(PM);
const al = src(AL);
const mj = src(MJ);
const pms = strip(pm);

console.log('\n【1】换身体：先加新的、再摘旧的（绝不允许出现空窗口）');
const swapBody = bodyOf(pm, 'export function swapBody(');
ok(swapBody.length > 0, 'swapBody 存在');
const iAdd = swapBody.indexOf('.add(');
const iRemove = swapBody.indexOf('.remove(');
ok(iAdd >= 0 && iRemove >= 0 && iAdd < iRemove,
  'swapBody 里 add 在 remove 之前', `add@${iAdd} remove@${iRemove}`);
ok(/\.slice\(\)/.test(swapBody), '先 .slice() 拷贝旧子节点再摘（边遍历边删会漏）');

console.log('\n【2】两条构建路径都不再「先清空」');
for (const fn of ['function buildBody(', 'function buildStaticBody(']) {
  const b = bodyOf(pms, fn);
  ok(b.length > 0 && !/bodyHolder\.clear\(\)/.test(b), fn + ' 里没有 bodyHolder.clear()');
  ok(/swapBody\(entry,/.test(b), fn + ' 走 swapBody 换身体');
}

console.log('\n【3】两条路都失败时：必须把占位人形放回去（宁可是蓝方块也不能没人）');
const bs = bodyOf(pm, 'function buildStaticBody(');
ok(/ensureFallbackBody\(entry\)/.test(bs), 'buildStaticBody 的最终 catch 调 ensureFallbackBody');
const ef = bodyOf(pm, 'function ensureFallbackBody(');
ok(ef.length > 0, 'ensureFallbackBody 存在');
ok(/children\.length/.test(ef) && /return/.test(ef), 'ensureFallbackBody 只在 bodyHolder 为空时补');
ok(/console\.error/.test(bs), '彻底失败时有 console.error（不能静默）');
// 骨骼那条失败只是降级、不是终局，必须 warn 出来
ok(/console\.warn/.test(bodyOf(pm, 'function buildBody(')), '骨骼身体失败时有 console.warn');

console.log('\n【4】AssetLoader：失败的 Promise 必须逐出缓存（否则一次瞬时失败毒死整场）');
const lg = bodyOf(al, 'function loadGLB(');
ok(lg.length > 0, 'loadGLB 存在');
ok(/\.catch\(\(\)/.test(lg) && /cache\.delete\(url\)/.test(lg), 'loadGLB 失败时 cache.delete(url)');
ok(/cache\.get\(url\) === tracked/.test(lg), '只删「还是自己」的那条（别误删后来重新发起的加载）');
ok(/cache\.set\(url,/.test(lg), '仍然登记缓存（正常路径不受影响）');

console.log('\n【5】?pdbg 体检浮层接线（手机没控制台时用）');
ok(/export function debugPlayerBodies\(/.test(pm), 'PlayerModel 导出 debugPlayerBodies');
ok(/import \{ installPlayerDebugOverlay \}/.test(mj), 'main.js 引入 installPlayerDebugOverlay');
ok(/pdbg/.test(mj) && /installPlayerDebugOverlay\(game\)/.test(mj), 'main.js 在 ?pdbg 时装浮层');
ok(fs.existsSync(path.join(ROOT, 'src/debug/PlayerDebugOverlay.js')), 'PlayerDebugOverlay.js 存在');
const ov = src('src/debug/PlayerDebugOverlay.js');
ok(/pointer-events:\s*none/.test(ov), '浮层不吃点击（pointer-events:none）');
ok(/setInterval/.test(ov), '浮层定时刷新（不是每帧）');

console.log('\n【6】功能验证：swapBody 真的把身体换掉了');
try {
  const THREE = await import('three');
  const { swapBody } = await import('../src/player/PlayerModel.js');
  const bh = new THREE.Group();
  const oldBody = new THREE.Object3D();
  oldBody.name = 'old';
  bh.add(oldBody);
  const entry = { group: { userData: { bodyHolder: bh } }, faceHolder: null };
  const fresh = new THREE.Object3D();
  fresh.name = 'fresh';
  swapBody(entry, fresh);
  ok(bh.children.length === 1, '换完 bodyHolder 恰好 1 个子节点', '实际 ' + bh.children.length);
  ok(bh.children[0] === fresh, '留下的是新身体');
  // 空 entry / 空 node 不能炸
  swapBody(null, null);
  swapBody({ group: {} }, fresh);
  ok(true, 'swapBody 对空 entry / 空 node 不抛异常');
} catch (e) {
  ok(false, '功能验证可运行', String(e && e.message));
}

console.log('\n【7】快照缺席不许立刻删人（「出现一下就消失」的根因）');
{
  const PMF = 'src/player/PlayerManager.js';
  const pmsrc = fs.readFileSync(path.join(ROOT, PMF), 'utf8');
  const ap = bodyOf(pmsrc, 'applySnapshot(players)');
  ok(ap.length > 0, 'applySnapshot 存在');
  ok(/Array\.isArray\(players\)/.test(ap), '畸形包防御：players 不是数组直接忽略');
  const m = /const MISS_LIMIT = (\d+);/.exec(ap);
  ok(!!m && Number(m[1]) >= 20, 'MISS_LIMIT 存在且 ≥20 帧（≥1 秒）', m ? '实际 ' + m[1] : '没有');
  ok(/miss\.set\(id, n\)/.test(ap) && /n >= MISS_LIMIT/.test(ap),
    '删除走「连续缺席计数」，不是单帧缺席就删');
  ok(/miss\.delete\(data\.id\)/.test(ap), '见到人就把缺席计数清零');
  const rm = bodyOf(pmsrc, 'removePlayer(id, why)');
  ok(/_note\('remove', id, why\)/.test(rm), 'removePlayer 记流水（带原因）');
  ok(/console\.warn/.test(bodyOf(pmsrc, '_note(kind, id, why)')), '删人必须出声（console.warn），不许静默');
  const apd = bodyOf(pmsrc, 'addPlayer(id, stateData, name, color, gender, src)');
  ok(/_note\('add', id/.test(apd), 'addPlayer 记流水');
  ok(/miss\.delete\(id\)/.test(apd), '重新加入清掉缺席计数');
  ok(/removePlayer\(id, 'welcome 在线列表里没有他/.test(pmsrc), 'pruneTo 删人注明原因');
  ok(/removePlayer\(msg\.id, 'leave 消息'\)/.test(strip(fs.readFileSync(path.join(ROOT, 'src/core/Game.js'), 'utf8'))),
    'leave 是权威删除来源，Game.js 里注明原因');
  ok(/pm\.churn/.test(ov), '?pdbg 浮层显示增删流水');
}

console.log('\n【8】增量快照入库必须补全成全量（NaN → 人整只消失且打不到的根因）');
try {
  const { SnapshotBuffer } = await import('../src/net/SnapshotBuffer.js');
  const buf = new SnapshotBuffer();
  const t0 = 1000;
  buf.push({ id: 'a', x: 1, y: 2, z: 3, yaw: 0.5, size: 1, health: 100, hold: '', wep: '', ride: 0, veh: '' }, t0);
  // 服务端 delta 帧：没变的字段只发 {id}（见 server-remote/index.js diffSnapshotPlayers）
  buf.push({ id: 'a' }, t0 + 50);
  buf.push({ id: 'a' }, t0 + 100);
  const l = buf.latest();
  ok(Number.isFinite(l.x) && l.x === 1, 'delta 帧入库后 x 仍是全量值', '实际 ' + l.x);
  ok(Number.isFinite(l.y) && Number.isFinite(l.z) && Number.isFinite(l.yaw), 'y/z/yaw 同样补全');
  ok(l.health === 100, 'health 等非插值字段也补全', '实际 ' + l.health);
  const s = buf.sample(t0 + 200);
  ok(!!s, 'sample 返回结果');
  const bx = s.a.x + (s.b.x - s.a.x) * s.alpha;
  ok(Number.isFinite(bx), '插值结果不是 NaN', 'bx=' + bx);
} catch (e) {
  ok(false, 'SnapshotBuffer 可在 Node 里跑', String(e && e.message));
}
{
  const rp = strip(fs.readFileSync(path.join(ROOT, 'src/player/RemotePlayer.js'), 'utf8'));
  const sm = bodyOf(rp, 'syncModel()');
  ok(/Number\.isFinite\(nx \+ ny \+ nz\)/.test(sm), 'syncModel 有 NaN 防线（非有限数不写模型位置）');
  ok(/this\.buf\.push\(this\.state\)/.test(rp), '构造时入库的是合并后的全量 state（不是原始增量）');
  // applyState 里传原始增量是**允许**的：补全发生在 SnapshotBuffer.push 内部（不依赖调用方自觉）
  const sb = fs.readFileSync(path.join(ROOT, 'src/net/SnapshotBuffer.js'), 'utf8');
  ok(/const full = last \? this\._merge\(last, cur\) : cur;/.test(sb), 'push 内部把增量补全成全量');
  ok(/_merge\(prev, cur\)/.test(sb), '存在 _merge（缺字段沿用上一份样本）');
}

console.log(fails ? `\n✗ ${fails} 项未通过` : '\n✓ 全部通过');
process.exit(fails ? 1 : 0);
