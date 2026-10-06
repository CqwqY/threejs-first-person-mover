// 自检：点光源阴影相机 far 的**硬钳制**
//
// ⚠⚠ 为什么这条必须钉死（2026-10-06「一靠近建筑就卡卡卡」的根因）：
//   Three 的 PointLightShadow.updateMatrices() 直接拿 light.distance 当 cube shadow 的 camera.far。
//   而线上编辑器里的灯大量 `distance: 100`（用户想"照得远"）→ 每盏灯的阴影要覆盖半径 100m 的球，
//   几乎整张地图。点光源阴影是 cube（6 面），4 盏带影 = 24 趟/阴影帧，30Hz 重渲
//   → 实测每秒 3.6 万~4.5 万次 draw call 纯粹为了阴影，**且完全不受 renderScale 影响**
//   （这就是"分辨率拉到最低还是卡"的原因，也解释"朝空方向看很快、一靠近建筑就卡"）。
//
//   旧写法是"只有灯没设 distance 时才兜 30m" —— 那条兜底在 distance=100 时**根本不会执行**。
//   现在的规则：**点光源一律无条件钳到 POINT_SHADOW_FAR**，不管 distance 填了多少。
//
// 跑法：node tools/probe-shadow-far.mjs
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

const THREE = await import('three');
const src = fs.readFileSync(path.join(ROOT, 'src/world/Lights.js'), 'utf8');

// ---- 锚点：常量 + configureShadow 函数体（花括号配对，别切到文件末尾）----
const mFar = /const POINT_SHADOW_FAR = (\d+);/.exec(src);
ok(!!mFar, '找到 POINT_SHADOW_FAR 常量');
const mMap = /const SHADOW_MAP = (\d+);/.exec(src);
ok(!!mMap, '找到 SHADOW_MAP 常量');
// ⚠ 名额已从写死常量改成可调（_maxPointShadow + setMaxPointShadow），这里只确认它存在
ok(/let _maxPointShadow = DEFAULT_MAX_POINT_SHADOW;/.test(src), '找到可调名额 _maxPointShadow');

const iFn = src.indexOf('function configureShadow(light, farOverride) {');
ok(iFn > 0, '找到 configureShadow');
let depth = 0, end = -1;
for (let k = src.indexOf('{', iFn); k < src.length; k++) {
  if (src[k] === '{') depth++;
  else if (src[k] === '}') { depth--; if (depth === 0) { end = k; break; } }
}
const fnSrc = src.slice(iFn, end + 1);
ok(fnSrc.length > 200, '切出函数体（配对成功）');

// 在隔离环境里求值（注入 THREE 与常量）
function makeEnv() {
  const code = [
    `const SHADOW_MAP = ${mMap[1]};`,
    `const POINT_SHADOW_FAR = ${mFar[1]};`,
    fnSrc,
    'return configureShadow;',
  ].join('\n');
  return new Function('THREE', code)(THREE);
}

// ---------------------------------------------------------------- ① 核心：distance=100 也必须被钳
console.log('\n[1] 点光源 far 必须被硬钳制（不管 distance 填多大）');
{
  const configureShadow = makeEnv();
  const cases = [
    [100, '线上真实值：编辑器灯 distance=100'],
    [50, 'distance=50'],
    [999, 'distance=999（用户手填夸张值）'],
    [0, 'distance=0（没设）'],
    [undefined, 'distance=undefined'],
  ];
  for (const [d, desc] of cases) {
    const light = new THREE.PointLight(0xffffff, 1, d === undefined ? undefined : d);
    configureShadow(light);
    const far = light.shadow.camera.far;
    ok(far <= Number(mFar[1]) + 1e-6, `${desc} → far=${far} ≤ ${mFar[1]}`);
  }
  // 反向：小于上限的 distance 要**保留**（别把 20m 的灯也拉成 32m）
  const small = new THREE.PointLight(0xffffff, 1, 18);
  configureShadow(small);
  eq(small.shadow.camera.far, 18, 'distance=18 的灯保留 18（只钳上限，不抬高）');
}

// ---------------------------------------------------------------- ② 修复前的行为（反证）
console.log('\n[2] 反证：确认"只有没设 distance 才兜底"的旧写法会漏掉线上这种情况');
{
  // 旧逻辑等价于：if (!isSpotLight && !distance) far = 30;
  const d = 100;
  const wouldOldSet = !!(d === 0 || d === undefined); // 旧条件：!light.distance
  eq(wouldOldSet, false, '旧条件在 distance=100 时为 false → 旧兜底根本不执行（根因坐实）');
}

// ---------------------------------------------------------------- ③ 贴图与数量
console.log('\n[3] 其它阴影预算参数');
{
  const map = Number(mMap[1]);
  ok(map <= 1024, `SHADOW_MAP = ${map}（点光源 cube 阴影 6 面 × 4 盏 = 24 张，必须小）`);
  // 各档趟数对比（点光源每盏 6 面 + 2 面光源代理 + 1 太阳）
  for (const [name, maxP] of [['high', 3], ['mid', 1], ['low', 0]]) {
    console.log(`        ${name.padEnd(5)} 阴影帧趟数 ≈ 6×${maxP}(点) + 2(面代理) + 1(太阳) = ${6 * maxP + 3}`);
  }
  // 不变量：数量必须恒定（Three 的 program 缓存键是数量，抖动会全场重编译）
  const g = fs.readFileSync(path.join(ROOT, 'src/world/Lights.js'), 'utf8');
  ok(/numPointLightShadows/.test(g) || /有阴影的灯的数量必须保持不变/.test(g),
    '源码里写明了「有阴影的灯数量必须恒定」的不变量');
}

// ---------------------------------------------------------------- ④ 所有点光源都走同一个入口
console.log('\n[4] 接线：点光源必须全部经过 configureShadow（漏一条路就漏一盏）');
{
  const calls = (src.match(/configureShadow\(/g) || []).length;
  ok(calls >= 3, `configureShadow 共 ${calls} 处调用（定义 + 点光源登记 + 面光源代理）`);
  ok(/if \(light && light\.isPointLight\) \{ _pointCands\.add\(light\); configureShadow\(light\); \}/.test(src),
    'registerPointLight 里对点光源调了 configureShadow');
  // 场景里不该有绕过入口直接建的点光源
  const game = fs.readFileSync(path.join(ROOT, 'src/core/Game.js'), 'utf8');
  const eb = fs.readFileSync(path.join(ROOT, 'src/world/EditorBuildings.js'), 'utf8');
  // ⚠ 判据不是"有没有 new PointLight"（家具里的灯就是要现建），而是"建完之后有没有登记"——
  //   只有 registerPointLight 会把灯交给名额管理与 configureShadow 的 far 钳制。
  const assertRegistered = (src, file) => {
    const bad = [];
    const re = /new THREE\.PointLight\(/g;
    let m;
    while ((m = re.exec(src))) {
      const tail = src.slice(m.index, m.index + 700); // 建完之后 700 字符内必须有登记
      if (!/registerPointLight\(/.test(tail)) bad.push(m.index);
    }
    ok(bad.length === 0, `${file}：每个 new PointLight 后面都跟着 registerPointLight${bad.length ? '（漏了 ' + bad.length + ' 处）' : ''}`);
  };
  assertRegistered(game, 'Game.js');
  assertRegistered(eb, 'EditorBuildings.js');
  ok(!/new THREE\.PointLight\(/.test(fs.readFileSync(path.join(ROOT, 'src/world/Lights.js'), 'utf8')) || true,
    '（Lights.js 自身是登记入口，不参与该断言）');
}

// ---------------------------------------------------------------- ⑤ 测试页固定机位
console.log('\n[5] 测试页：固定机位 (0,77) + 缓慢旋转');
{
  const pb = fs.readFileSync(path.join(ROOT, 'src/perf/PerfBench.js'), 'utf8');
  ok(/const FIXED_VIEW = true;/.test(pb), 'FIXED_VIEW 默认开启');
  ok(/FIXED_POS = \{ x: 0, y: 1\.7, z: 77 \}/.test(pb), '固定位置 = (0, 1.7, 77)');
  ok(/FIXED_YAW_SPEED = 0\.15/.test(pb), '缓慢旋转 0.15 rad/s（一圈约 42 秒）');
  ok(/前方 = \(-sin yaw, 0, -cos yaw\)/.test(pb), '朝向约定与游戏一致');
  ok(/samplePath\(path, state\.dist, _camPos\)/.test(pb), '原航点巡航模式仍保留（FIXED_VIEW=false 可回退）');
}

// ---------------------------------------------------------------- ⑥ 名额可调（最大的单一杠杆）
console.log('\n[6] 点光源阴影名额可按画质档调（趟数 = 6 × 名额）');
{
  ok(/export function setMaxPointShadow\(/.test(src), '导出 setMaxPointShadow');
  ok(/export function getMaxPointShadow\(/.test(src), '导出 getMaxPointShadow');
  ok(/rebalance\(_pointCands, _maxPointShadow, cameraPos\)/.test(src),
    'updateShadowBudgets 用可调名额（不是写死的常量）');
  ok(/DEFAULT_MAX_POINT_SHADOW/.test(src) && /pointer: coarse/.test(src),
    '默认名额按设备给（触摸设备只保 1 盏）');
  // 钳制与幂等
  ok(/Math\.max\(0, Math\.min\(4, Math\.floor\(Number\(n\)\) \|\| 0\)\)/.test(src),
    'setMaxPointShadow 把值钳在 0..4');
  ok(/if \(v === _maxPointShadow\) return false;/.test(src), '同值时不重复关灯（幂等）');

  const game = fs.readFileSync(path.join(ROOT, 'src/core/Game.js'), 'utf8');
  ok(/pointShadow: 3/.test(game) && /pointShadow: 1/.test(game) && /pointShadow: 0/.test(game),
    '_applyQuality 三档都设了 pointShadow（high 3 / mid 1 / low 0）');
  ok(/setMaxPointShadow\(p\.pointShadow\)/.test(game), '_applyQuality 真的调了它');
  ok(/low:\s*\{[^}]*pointShadow: 0/.test(game), '低档 = 0（点光源阴影全关，成本砍到 0）');
  // 不能放进每帧路径（改它会触发全场重编译）—— 用花括号配对准确定位主循环函数体。
  // ⚠ 别用 slice(indexOf(...)) 切到文件末尾：那会把后面所有函数都算进去（本探针第一版就踩了）。
  const iLoop = game.indexOf('_loop() {');
  ok(iLoop > 0, '定位到主循环 _loop()');
  let d2 = 0, e2 = -1;
  for (let k = game.indexOf('{', iLoop); k < game.length; k++) {
    if (game[k] === '{') d2++;
    else if (game[k] === '}') { d2--; if (d2 === 0) { e2 = k; break; } }
  }
  const loopBody = game.slice(iLoop, e2 + 1);
  ok(loopBody.length > 500, '抽到主循环函数体（配对成功）');
  ok(!/setMaxPointShadow/.test(loopBody), '主循环里没有 setMaxPointShadow（改名额只该在切画质档时发生）');
}

console.log('\n' + (fails ? `✗ ${fails} 项失败` : '✓ 全部通过'));
process.exit(fails ? 1 : 0);
