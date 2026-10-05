// 自检：骑乘/赛车状态下的 UI 隐藏（node tools/probe-ride-ui.mjs）
//
// 为什么要测：用户报「赛车状态也把该隐藏的隐藏」。对照代码发现——**对战状态**有一套
//   完整的隐藏逻辑（_enterCombat 里逐个藏 portalHint/merchantHint/vehHint/chatTab +
//   _updateSkillBarVisibility + _updateBossUI），但**骑乘/赛车状态**没有对齐，
//   结果骑车时技能槽、Boss 血条、传送门提示还挂在画面上。
//
// 本次做法（对齐对战 + 零风险）：新增 CSS 类 body.kui-ride，整组隐藏顶栏/校卡/技能槽；
//   JS 侧 _mountVehicle / _dismountVehicle 切换该类，并把 ride 并入 _updateSkillBarVisibility
//   与 _updateBossUI 的判定。
//
// ⚠ 这里直接按锚点切出 Game.js / theme.js 的**真实源码**做断言，不复制逻辑 ——
//   复制品会与源码漂移，测了等于没测。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAME = path.join(HERE, '..', 'src', 'core', 'Game.js');
const THEME = path.join(HERE, '..', 'src', 'ui', 'theme.js');
const game = fs.readFileSync(GAME, 'utf8');
const theme = fs.readFileSync(THEME, 'utf8');

let fails = 0;
function check(name, got, want) {
  const ok = got === want;
  if (!ok) { fails++; console.log(`  ✗ ${name}\n      期望 ${want}\n      实际 ${got}`); }
  else console.log(`  ok    ${name} = ${got}`);
}

console.log('① CSS：body.kui-ride 必须藏顶栏 + 校卡；且**不得**藏技能槽 / 车速表：');
{
  const hasRideRule = /body\.kui-ride\s+\.kui-toprow/.test(theme)
    && /body\.kui-ride\s+#idc-layout/.test(theme);
  check('body.kui-ride 含 .kui-toprow + #idc-layout', hasRideRule, true);
  // 精确取「body.kui-ride ... { ... }」这条真实规则块
  const rideBlocks = [...theme.matchAll(/body\.kui-ride[^^{}]*\{([^}]*)\}/g)].map((m) => m[1]);
  check('找到 body.kui-ride 规则块', rideBlocks.length > 0, true);
  // ⚠ 技能槽必须 JS 层管（SkillSlots.setVisible），不能 CSS 藏 ——
  //   否则 MobileControls 的刹车键在 setDriving 时量不到技能槽位置，会飞掉
  check('body.kui-ride 不隐藏技能槽 .sk-box（留给 JS 管，防刹车键定位错乱）',
    rideBlocks.some((blk) => /\.sk-box/.test(blk)), false);
  check('body.kui-ride 不隐藏车速表 .spd-box（驾驶必需）',
    rideBlocks.some((blk) => /\.spd-box/.test(blk)), false);
}

console.log('② JS：上车/下车必须切换 body.kui-ride：');
{
  // 用「方法定义」的锚点，别撞上调用点（文件里 _dismountVehicle() 的调用在定义之前）
  const ma = game.indexOf('_mountVehicle(seat, driverId) {');
  const da = game.indexOf('_dismountVehicle() {');
  const vb = game.indexOf('_vehFor(id) {');
  if (ma < 0 || da < 0 || vb < 0 || !(ma < da && da < vb)) { console.log('  ✗ 找不到 mount/dismount 定义锚点'); process.exit(1); }
  const mount = game.slice(ma, da);
  const dismount = game.slice(da, vb);
  check('_mountVehicle 里 add(kui-ride)', /classList\.add\(\s*['"]kui-ride['"]\s*\)/.test(mount), true);
  check('_dismountVehicle 里 remove(kui-ride)', /classList\.remove\(\s*['"]kui-ride['"]\s*\)/.test(dismount), true);
}

console.log('③ 技能栏判定：ride 必须并入条件：');
{
  const a = game.indexOf('_updateSkillBarVisibility() {');
  const b = game.indexOf('_isBuildActive() {');
  if (a < 0 || b < 0 || b < a) { console.log('  ✗ 找不到 _updateSkillBarVisibility 锚点'); process.exit(1); }
  const chunk = game.slice(a, b);
  // 取 setVisible(...) 的条件表达式（真实源码），把 this.xxx 换成桩变量后求值
  const condSrc = (chunk.match(/setVisible\(([^;]*?)\);/) || [])[1];
  check('找到 setVisible 的条件表达式', !!condSrc, true);
  if (condSrc) {
    const js = condSrc
      .replace(/this\._combat/g, '_combat')
      .replace(/this\._soul/g, '_soul')
      .replace(/this\._isBuildActive\(\)/g, '_isBuildActive()')
      .replace(/this\.localState\.ride/g, 'localState.ride');
    const evalCond = new Function('_combat', '_soul', '_isBuildActive', 'localState', `return (${js});`);
    const mk = (combat, soul, build, ride) => evalCond(combat, soul, () => build, { ride });
    check('走路（无任何状态）→ 显示', mk(false, false, false, 0), true);
    check('骑乘/赛车 ride=1 → 隐藏', mk(false, false, false, 1), false);
    check('后座 ride=2 → 隐藏', mk(false, false, false, 2), false);
    check('对战 → 隐藏（原有行为不回退）', mk(true, false, false, 0), false);
    check('灵魂出窍 → 隐藏（原有行为不回退）', mk(false, true, false, 0), false);
    check('建造模式 → 隐藏（原有行为不回退）', mk(false, false, true, 0), false);
  }
}

console.log('④ Boss UI 判定：ride 必须并入 showPortal / showShield / showAtk：');
{
  const a = game.indexOf('_updateBossUI() {');
  const b = game.indexOf('const bar = this._bossBar;');
  if (a < 0 || b < 0 || b < a) { console.log('  ✗ 找不到 _updateBossUI 锚点'); process.exit(1); }
  const chunk = game.slice(a, b);
  check('riding 变量已定义', /const\s+riding\s*=\s*!!this\.localState\.ride/.test(chunk), true);
  check('showPortal 并入 !riding', /showPortal\s*=[^;]*!riding[^;]*;/.test(chunk), true);
  check('showShield 并入 !riding', /showShield\s*=[^;]*!riding[^;]*;/.test(chunk), true);
  check('showAtk 并入 !riding', /showAtk\s*=[^;]*!riding[^;]*;/.test(chunk), true);
  // Boss 血条：riding 时强制 none（只看紧邻 bar 的那段）
  const afterBar = game.slice(b, b + 500);
  check('骑乘时 Boss 血条强制收起', /if\s*\(\s*riding\s*\)\s*\{\s*bar\.box\.style\.display\s*=\s*'none'/.test(afterBar), true);
}

console.log(fails === 0 ? '\n✓ 全部通过' : `\n✗ ${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
