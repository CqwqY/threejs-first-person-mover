// 自检：加载屏「分批加载」的等待语义（node tools/probe-asset-loading.mjs）
//
// 背景：用户报「模型有些手机没下下来或者没加载就放行了」。
// 根因：加载是**分批发起**的 ——
//   第一批：远端场景模型（sceneReady 触发）
//   第二批：玩家角色模型（boy-rig/girl-rig.glb，1~1.6MB）—— 要等 WebSocket 的
//           **welcome** 到了才发起，手机慢网可能晚好几秒。
// 旧的 waitAssets 只用「某一瞬间 pending===0」当判据，于是在两批之间那个空档就放行了，
// 第二批（角色）**还没开始下载**。手机上因此看到「人没出来就进游戏」。
//
// 本脚本**真跑 loadTracker 的分批时序**，断言：
//   ① 单批加载：登记→完成→安静期满 才 quietFor=true
//   ② 分批加载：第一批完成的瞬间 quietFor=false（不能放行）；第二批登记后仍 false；
//      两批都完成后 + 安静期才 true —— 这就是本次修复的核心
//   ③ whenIdle 语义不变（有待办时不 resolve，归零后 resolve）
//   ④ 失败任务也算「完成」（销账，不卡住加载屏）
// ⚠ 直接 import 真实 loadTracker.js 源码。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src', 'world', 'loadTracker.js');

const { track, stats, whenIdle, quietFor } = await import('file://' + SRC.replace(/\\/g, '/'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
function check(name, got, want) {
  const ok = got === want;
  if (!ok) { fails++; console.log(`  ✗ ${name}\n      期望 ${want}\n      实际 ${got}`); }
  else console.log(`  ok    ${name} = ${got}`);
}

const QUIET = 300; // 测试用缩短的安静期（生产是 900ms）

console.log('① 单批：登记 → 完成 → 安静期满');
{
  // 先确保空闲且安静够久（等过 QUIET）
  await sleep(QUIET + 60);
  check('初始（无任务）quietFor=true', quietFor(QUIET), true);

  let release;
  const p = new Promise((r) => { release = r; });
  track(p);
  check('登记后 pending=1', stats().pending, 1);
  check('有任务时 quietFor=false', quietFor(QUIET), false);

  release();
  await p;
  await sleep(10);
  check('任务刚完成、安静期未满 → quietFor=false（不能立刻放行）', quietFor(QUIET), false);
  await sleep(QUIET + 60);
  check('安静期满 → quietFor=true（可以放行）', quietFor(QUIET), true);
}

console.log('② 分批：第一批完成的空档**不能**放行（本次修复的核心）');
{
  await sleep(QUIET + 60);
  check('起点空闲', quietFor(QUIET), true);

  // ---- 第 1 批（模拟场景模型）----
  let r1;
  const batch1 = new Promise((r) => { r1 = r; });
  track(batch1);
  check('第 1 批登记 → pending=1', stats().pending, 1);
  r1();
  await batch1;
  await sleep(10);
  // ⚠ 这就是旧代码放行的那一瞬间：pending 已是 0，但安静期没满
  check('第 1 批完成瞬间 pending=0', stats().pending, 0);
  check('第 1 批完成瞬间 quietFor=false（旧代码正是在这里误放行）', quietFor(QUIET), false);

  // ---- 第 2 批（模拟 welcome 之后才发起的玩家模型）----
  await sleep(120); // 模拟「welcome 还没到」的空档
  check('空档期 still quietFor=false', quietFor(QUIET), false);
  let r2;
  const batch2 = new Promise((r) => { r2 = r; });
  track(batch2);
  check('第 2 批登记 → pending=1', stats().pending, 1);
  check('两批之间有任务 → quietFor=false', quietFor(QUIET), false);

  r2();
  await batch2;
  await sleep(10);
  check('第 2 批刚完成 → quietFor=false', quietFor(QUIET), false);
  await sleep(QUIET + 60);
  check('全部完成 + 安静期 → quietFor=true（此时才可放行）', quietFor(QUIET), true);
}

console.log('③ whenIdle 语义不变');
{
  await sleep(QUIET + 60);
  let r;
  const p = new Promise((res) => { r = res; });
  track(p);
  let resolved = false;
  const w = whenIdle().then(() => { resolved = true; });
  await sleep(30);
  check('有待办时 whenIdle 不 resolve', resolved, false);
  r();
  await p;
  await w;
  check('归零后 whenIdle resolve', resolved, true);
}

console.log('④ 失败任务也要销账（不让加载屏卡死）');
{
  await sleep(QUIET + 60);
  let rej;
  const p = new Promise((_, rj) => { rej = rj; });
  p.catch(() => {}); // 避免 unhandled rejection
  track(p);
  check('登记 → pending=1', stats().pending, 1);
  rej(new Error('模拟网络失败'));
  await sleep(30);
  check('失败后 pending 归零（失败也算完成）', stats().pending, 0);
  await sleep(QUIET + 60);
  check('失败后安静期满 → 可放行', quietFor(QUIET), true);
}

console.log('⑤ 源码层断言：main.js 必须等 welcome + 用安静期');
{
  const fs = await import('node:fs');
  const main = fs.readFileSync(path.join(HERE, '..', 'src', 'main.js'), 'utf8');
  check('导入了 quietFor', /import\s*\{[^}]*quietFor[^}]*\}\s*from\s*['"]\.\/world\/loadTracker\.js['"]/.test(main), true);
  check('waitAssets 里用了 quietFor', /quietFor\(QUIET_MS\)/.test(main), true);
  check('waitAssets 里等了 welcomeReady', /welcomeReady\(/.test(main), true);
  // 旧的「一看到 pending===0 就 return」必须消失
  check('旧「total>0 && pending===0 立即 return」已移除',
    /if\s*\(\s*total\s*>\s*0\s*&&\s*pending\s*===\s*0\s*\)\s*return;/.test(main), false);
}

console.log(fails === 0 ? '\n✓ 全部通过' : `\n✗ ${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
