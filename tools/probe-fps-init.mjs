// 自检：主循环「帧率采样累加器」必须被初始化（node tools/probe-fps-init.mjs）
//
// 为什么要测：用户报「FPS 一直显示 --」。根因是本文件里 `this._fpsAcc += dt` / `this._fpsN++`
//   这两个累加器**从未初始化**（全项目只在主循环那 4 行出现过，没有任何 `= 0`）。
//   于是首帧 `undefined + dt` → **NaN**，`NaN >= 0.5` **恒为 false** → 整块 `if` 永不执行，
//   `_updateFpsBadge` / `_adaptResolution` 从来没跑过，且**不报任何错**（静默失效）。
//   这同时也意味着「自适应分辨率」在此前一直没生效。
//
// 教训与规则：`this._x += …` / `this._x++` 这种**累加型字段**，若字段在构造函数里没有初值，
//   首帧就产生 NaN 并静默失效 —— 和之前「碰撞全没了」（未声明变量 + 空 catch）同一类坑。
//
// ⚠ 这里直接读 Game.js 源码做静态断言，不复制逻辑。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_FILE = path.join(HERE, '..', 'src', 'core', 'Game.js');
const src = fs.readFileSync(SRC_FILE, 'utf8');

// 取 Game.js 构造函数体（锚点：constructor( → _precompileShaders）
// —— 判断「字段有没有初值」必须只看构造函数，否则主循环里 `this._x = 0`（结算重置）
//    会被误当成初始化，脚本就形同虚设（这是本脚本第一版的盲区）。
const ctorStart = src.indexOf('constructor(');
const ctorEnd = src.indexOf('_precompileShaders()');
if (ctorStart < 0 || ctorEnd < 0 || ctorEnd < ctorStart) {
  console.log('✗ 找不到构造函数锚点，Game.js 结构变了'); process.exit(1);
}
const ctor = src.slice(ctorStart, ctorEnd);

let fails = 0;
function check(name, ok) {
  if (!ok) { fails++; console.log(`  ✗ ${name}`); }
  else console.log(`  ok    ${name}`);
}

console.log('① 帧率累加器 _fpsAcc / _fpsN 必须在构造函数里初始化：');
{
  check('主循环里仍在用 this._fpsAcc += / this._fpsN++',
    /this\._fpsAcc\s*\+=/.test(src) && /this\._fpsN\s*\+\+/.test(src));
  // ⚠ 只看构造函数体内，不看主循环的结算重置
  check('构造函数里 this._fpsAcc = 0', /this\._fpsAcc\s*=\s*0\s*;/.test(ctor));
  check('构造函数里 this._fpsN = 0', /this\._fpsN\s*=\s*0\s*;/.test(ctor));
}

console.log('② 全项目扫描：累加字段必须在「首次累加」之前就赋过初值：');
{
  const SRC_DIR = path.join(HERE, '..', 'src');
  const files = [];
  (function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.js')) files.push(p);
    }
  })(SRC_DIR);

  let total = 0;
  for (const f of files) {
    const code = fs.readFileSync(f, 'utf8');
    const rel = path.relative(SRC_DIR, f).replace(/\\/g, '/');
    // 找每个字段的首次累加位置
    const firstAcc = new Map();
    for (const m of code.matchAll(/this\.(_[A-Za-z0-9]+)\s*\+=/g)) {
      if (!firstAcc.has(m[1])) firstAcc.set(m[1], m.index);
    }
    for (const [name, accIdx] of firstAcc) {
      total++;
      // 初值必须出现在首次累加**之前**（this._x = …，排除 ==/===）
      const re = new RegExp(`this\\.${name}\\s*=(?!=)`, 'g');
      let ok = false;
      for (const m of code.matchAll(re)) { if (m.index < accIdx) { ok = true; break; } }
      check(`${rel}: ${name} 在首次累加前有初值`, ok);
    }
  }
  check(`src/ 下共扫描 ${total} 个累加字段（应 > 0）`, total > 0);
}

console.log('③ 回归防护：帧率结算块必须同时喂角标与自适应分辨率：');
{
  const a = src.indexOf('this._fpsAcc += dt;');
  check('找到帧率累加行', a >= 0);
  if (a >= 0) {
    const blk = src.slice(a, a + 400);
    check('结算块调用 _adaptResolution(fps)', /_adaptResolution\(fps\)/.test(blk));
    check('结算块调用 _updateFpsBadge(fps)', /_updateFpsBadge\(fps\)/.test(blk));
  }
}

console.log(fails === 0 ? '\n✓ 全部通过' : `\n✗ ${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
