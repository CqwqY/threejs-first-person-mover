// 自检：抓钩的「被拽着也能跳」+「松手继承惯性」+「技能槽免冷却」
//
// 起因（用户反馈）：
//   ① 钩锁拽人的时候按跳跃完全没反应 —— velocityHold 每帧把竖直速度整块写成拽人的值，
//      第 4 步刚设好的起跳速度当帧就被冲掉。零报错、纯手感问题，只能靠断言守住。
//   ② 松手就急停 —— 物理第 2 步每帧把水平速度**直接写成**「输入×速度」，
//      拽人的 25m/s 在松手下一帧被抹平，得有 momentum 接力。
//   ③ 抓钩自带 0.8 秒冷却 —— 其实是 SkillSlots 那道 800ms 防连点间隔，抓钩必须能豁免。
//
// 跑：node tools/probe-grapple-momentum.mjs（退出码非 0 = 有回归）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PlayerPhysics } from '../src/player/PlayerPhysics.js';
import { Config } from '../src/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
function ok(cond, name, extra = '') {
  if (cond) console.log('  ok    ' + name + (extra ? ' — ' + extra : ''));
  else { fails++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = (s) => s.replace(/\/\/.*$/gm, ''); // 去掉整行注释，避免注释里的假阳性
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

const PP = 'src/player/PlayerPhysics.js';
const GM = 'src/core/Game.js';
const SS = 'src/ui/SkillSlots.js';
const CF = 'src/config.js';
const pp = src(PP);
const pps = strip(pp);
const gm = src(GM);
const gms = strip(gm);
const ss = src(SS);
const cf = strip(src(CF));

console.log('\n【1】起跳冲量：velocityHold 覆盖竖直速度时必须叠上它');
const upd = bodyOf(pps, 'update(dt, input, cameraYaw, state, colliders = [])');
ok(upd.length > 0, 'PlayerPhysics.update 抽得到');
ok(/this\.velocity\.y = h\.y \+ this\._jumpExtra/.test(upd),
  '4.5 的竖直覆盖是 h.y + _jumpExtra（不是直接赋值）');
ok(/this\._jumpExtra \*= Math\.exp\(-dt \* JUMP_EXTRA_DECAY\)/.test(upd),
  '冲量余量逐帧衰减（不会一直往上飘）');
ok(/if \(state\.onGround\) \{[\s\S]{0,160}this\._jumpExtra = 0/.test(upd),
  '落地时把冲量余量清零');
ok(/this\._jumpExtra = this\.velocity\.y;/.test(upd), '起跳那帧记下冲量');
// ⚠ 累加/累乘型字段没初值 = NaN = 整块静默失效（踩过的坑），按行号断言"初值在首次 * = 之前"
const ctor = bodyOf(pps, 'constructor()');
ok(/this\._jumpExtra = 0;/.test(ctor), '_jumpExtra 在构造函数里有初值');
ok(/this\.momentum = null;/.test(ctor), 'momentum 在构造函数里有初值');
const iInit = pps.indexOf('this._jumpExtra = 0;');
const iMul = pps.indexOf('this._jumpExtra *=');
ok(iInit >= 0 && iMul > iInit, '_jumpExtra 的初值早于首次 *= ', `${iInit} < ${iMul}`);
ok(/const JUMP_EXTRA_DECAY = /.test(pp), 'JUMP_EXTRA_DECAY 是模块级具名常量');

console.log('\n【2】惯性继承：水平速度叠加 + 衰减 + 到期清空');
ok(/this\.velocity\.x \+= this\.momentum\.x;/.test(upd), 'momentum 叠加到水平速度（不是覆盖）');
ok(/this\.velocity\.z \+= this\.momentum\.z;/.test(upd), 'z 轴同样叠加');
ok(/this\.momentum\.t -= dt;/.test(upd), 'momentum 有时长计时');
ok(/this\.momentum\.x \*= mk;/.test(upd) && /this\.momentum\.z \*= mk;/.test(upd), 'x/z 都按 mk 衰减');
ok(/if \(this\.momentum\.t <= 0\) this\.momentum = null;/.test(upd), '到期置 null（不会永远带着）');
ok(/const MOMENTUM_DECAY = /.test(pp), 'MOMENTUM_DECAY 是模块级具名常量');

console.log('\n【3】Config 三个可调项存在且数值合理');
for (const [k, lo, hi] of [['GRAPPLE_INHERIT', 0.5, 1], ['GRAPPLE_INHERIT_TIME', 0.3, 2], ['GRAPPLE_ARRIVE_DAMP', 0, 0.5]]) {
  const m = new RegExp(k + ':\\s*([0-9.]+)').exec(cf);
  const v = m ? Number(m[1]) : NaN;
  ok(Number.isFinite(v) && v >= lo && v <= hi, k + ' = ' + (m ? m[1] : '缺失'), `应在 [${lo}, ${hi}]`);
}

console.log('\n【4】Game：惯性只在「半路松手」时继承');
const eg = bodyOf(gms, '_endGrapple(inherit = false)');
ok(eg.length > 0, '_endGrapple 带 inherit 形参（默认 false）');
ok(/phys\.momentum = \{ x: phys\.velocity\.x \* keep, z: phys\.velocity\.z \* keep, t: Config\.GRAPPLE_INHERIT_TIME \}/.test(eg),
  '继承时写入 phys.momentum（取真实速度，不是 hold）');
ok(/if \(inherit && pulling\)/.test(eg), '只有 inherit && 正在拽人才继承');
ok(/const pulling = !!\(\s*hold && this\._grapple && !this\._grapple\.flying\s*\)/.test(eg),
  'pulling 排除了「钩爪还在飞」的阶段');
const ug = bodyOf(gms, '_updateGrapple(dt)');
ok(ug.length > 0, '_updateGrapple 抽得到');
ok(/const arrived = dist <= stop;/.test(ug), '到点判定提成 arrived 变量');
ok(/this\._endGrapple\(!arrived\)/.test(ug), '超时（半路）= 继承惯性；正常到点 = 不继承');
ok(/velocity\.multiplyScalar\(Config\.GRAPPLE_ARRIVE_DAMP\)/.test(ug), '到点仍然收速度（防冲过柱子掉岩浆）');
const fg = bodyOf(gms, '_fireGrapple() {'); // ⚠ 必须带上 " {"：光写 _fireGrapple() 会先命中 `run: () => this._fireGrapple()`
ok(/this\._endGrapple\(true\)/.test(fg), '再按一次松手 = 半路松手，继承惯性');

console.log('\n【5】技能槽：抓钩免冷却（noCd 必须一路带到恢复链路）');
ok(/const cd = slot\.noCd \? 0 : COOLDOWN;/.test(strip(ss)), 'fire() 按 noCd 决定间隔');
ok(/if \(cd > 0\) \{/.test(strip(ss)), 'cd 为 0 时不做变暗反馈');
ok(/noCd: false \}/.test(ss), 'slot 对象带 noCd 字段');
ok(/slot\.noCd = opts\.noCd === true;/.test(bodyOf(strip(ss), 'function assign(index, opts)')), 'assign 写入 noCd');
ok(/slot\.noCd = false;/.test(bodyOf(strip(ss), 'function clearSlot(index)')), 'clearSlot 复位 noCd');
// ⚠ 别在整个文件里找 case 'grapple'：开头 1698 行那个 `case 'grapple': {` 是别处的分支块，
//   会先被命中（blockAt 抽到的是一大段不相关的代码）→ 必须限定在 _effectForItem 内部找。
// ⚠ 必须写完整签名 `_effectForItem(item) {`：只写 `_effectForItem(` 会先命中别处的**调用点**
const efi = bodyOf(gms, '_effectForItem(item) {');
const grappleCase = blockAt(efi, efi.indexOf("case 'grapple':"));
ok(grappleCase.length > 0 && /noCd: true,/.test(grappleCase), "_effectForItem 的 case 'grapple' 声明 noCd: true");
// ⚠ 匹配到 `});` 为止：写到第一个 `)` 就停会在箭头函数 `() => ...` 处被截断，丢掉后面的 noCd
const assignCalls = gms.match(/skillSlots\.assign\([\s\S]*?\}\);/g) || [];
ok(assignCalls.length >= 3, 'assign 调用点至少 3 处（装备 / 恢复 / Boss 还原）', String(assignCalls.length));
for (const c of assignCalls) {
  const isHoming = /_fireHomingMissile/.test(c);
  ok(isHoming || /noCd: eff\.noCd === true/.test(c), 'assign 转发了 noCd', c.slice(0, 64));
}

console.log('\n【6】真跑物理：被拽着（velocityHold）时按跳必须起得来');
const H = Config.PLAYER_HEIGHT;
function mkInput(jump = true) {
  let jumpLeft = jump ? 1 : 0;
  return {
    forwarded: () => 0, backwarded: () => 0,
    strafeRight: () => 0, strafeLeft: () => 0,
    joyX: 0, joyY: 0, joyMagnitude: () => 0,
    sprinting: () => false,
    isDown: () => false,
    consumeJump: () => (jumpLeft-- > 0),
  };
}
function runJump(withHold) {
  const state = { x: 0, y: H, z: 0, yaw: 0, pitch: 0, onGround: true };
  const phys = new PlayerPhysics();
  const dt = 1 / 60;
  const idle = mkInput(false);
  for (let i = 0; i < 5; i++) phys.update(dt, idle, 0, state, []);
  const y0 = state.y;
  const jump = mkInput(true);
  let peak = state.y;
  let vPeak = 0;
  for (let i = 0; i < 60; i++) {
    // 每帧重写 velocityHold：模拟抓钩拽人（水平 6m/s，竖直 0 —— 就是"拽着贴地跑"的场景）
    if (withHold) phys.velocityHold = { x: 6, y: 0, z: 0, t: 0.3 };
    phys.update(dt, jump, 0, state, []);
    peak = Math.max(peak, state.y);
    vPeak = Math.max(vPeak, phys.velocity.y);
  }
  return { rise: peak - y0, vPeak };
}
{
  const plain = runJump(false);
  const held = runJump(true);
  ok(plain.rise > 0.8, '无覆盖时普通跳跃高度正常（回归）', `rise=${plain.rise.toFixed(2)}m`);
  ok(held.rise > 0.8, '被 velocityHold 拽着时按跳也能起跳', `rise=${held.rise.toFixed(2)}m`);
  ok(held.vPeak > Config.JUMP_VELOCITY * 0.7, '起跳那下的竖直速度没被覆盖吃掉',
    `vPeak=${held.vPeak.toFixed(2)}（JUMP_VELOCITY=${Config.JUMP_VELOCITY}）`);
}

console.log('\n【7】真跑物理：松手后的惯性会冲一段、又一定会衰减完');
function runMomentum(use) {
  const state = { x: 0, y: H, z: 0, yaw: 0, pitch: 0, onGround: true };
  const phys = new PlayerPhysics();
  const dt = 1 / 60;
  const input = mkInput(false);
  if (use) phys.momentum = { x: 20, z: 0, t: Config.GRAPPLE_INHERIT_TIME };
  for (let i = 0; i < 30; i++) phys.update(dt, input, 0, state, []); // 0.5 秒
  return { dx: state.x - 0, phys };
}
{
  const off = runMomentum(false);
  const on = runMomentum(true);
  ok(Math.abs(off.dx) < 0.01, '无惯性时水平不动（回归）', `dx=${off.dx.toFixed(4)}`);
  ok(on.dx > 4, '有惯性时会顺着原方向冲一段', `dx=${on.dx.toFixed(2)}m`);
  // 再跑满 2 秒：必须衰减干净（不会一直滑）
  const state = { x: 0, y: H, z: 0, yaw: 0, pitch: 0, onGround: true };
  const phys = new PlayerPhysics();
  const input = mkInput(false);
  phys.momentum = { x: 20, z: 0, t: Config.GRAPPLE_INHERIT_TIME };
  for (let i = 0; i < 120; i++) phys.update(1 / 60, input, 0, state, []);
  ok(phys.momentum === null, '惯性到期后 momentum 被清空');
  ok(Math.abs(phys.velocity.x) < 0.5, '惯性衰减完水平速度回到输入值', `vx=${phys.velocity.x.toFixed(3)}`);
}

console.log(`\n${fails === 0 ? '全部通过' : fails + ' 项失败'}`);
process.exit(fails === 0 ? 0 : 1);
