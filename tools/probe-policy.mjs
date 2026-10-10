// 守卫：学生策略网络的两端契约 + 端到端推理。
// 1) train.py 的 STATE_KEYS / ACTIONS 必须与 policy.js 逐字一致（否则 loadPolicy 会 contract-mismatch 退回规则）。
// 2) 若本机有 python：跑 gen_synthetic + train 产出模型，loadPolicy 后断言"上课→教室 / 午饭饿→饭堂 / 深夜累→宿舍"。
// 3) 无 python 也能跑：用一个手搓线性模型验证前向 + argmax 数学正确。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { STATE_KEYS, ACTIONS, PolicyNet, loadPolicy } from '../server-remote/policy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const ok = (c, n, ex) => { console.log((c ? '  ok   ' : '  FAIL ') + n + (c ? '' : '  → ' + (ex || ''))); if (!c) fails++; };

// ---------- 1) 契约一致性（train.py ↔ policy.js）----------
console.log('[1] 契约一致性');
{
  const py = fs.readFileSync(path.join(ROOT, 'tools/npc-policy/train.py'), 'utf8');
  const ord = (arr) => { const i = arr.map((k) => py.indexOf("'" + k + "'")); return i.every((v) => v >= 0) && i.every((v, k, a) => k === 0 || v > a[k - 1]); };
  ok(ord(STATE_KEYS), 'train.py 含全部 21 个状态键且顺序一致', 'STATE_KEYS 顺序或缺失');
  ok(ord(ACTIONS), 'train.py 含全部 15 个动作且顺序一致', 'ACTIONS 顺序或缺失');
  ok(STATE_KEYS.length === 21 && ACTIONS.length === 15, '维度正确（21 状态 / 15 动作）');
}

// ---------- 3) 前向 + argmax 数学（不依赖 python）----------
console.log('[2] 前向/argmax 数学');
{
  const W = []; const b = [];
  for (let i = 0; i < ACTIONS.length; i++) { W.push(new Array(STATE_KEYS.length).fill(0)); b.push(-100); }
  const ci = ACTIONS.indexOf('classroom'); const hi = STATE_KEYS.indexOf('hour');
  W[ci][hi] = 10; b[ci] = 0; // 仅当 hour 特征大时选 classroom
  const net = new PolicyNet({ state: STATE_KEYS, actions: ACTIONS, hidden: [], weights: [W], biases: [b], meta: {} });
  const x = new Array(STATE_KEYS.length).fill(0); x[hi] = 0.5; // hour=12 → /24=0.5
  ok(net.decide(x) === 'classroom', '手搓模型：hour 高 → classroom');
  const lv = net.forwardVec(x);
  ok(lv.length === ACTIONS.length && lv[ci] > lv[(ci + 1) % ACTIONS.length], 'forwardVec 输出 15 维且 classroom 最大');
}

// ---------- 2) 端到端（需要 python）----------
function findPython() {
  for (const p of [process.env.PYTHON_BIN, 'C:/Users/Administrator/.workbuddy/binaries/python/versions/3.13.12/python.exe', 'python3', 'python']) {
    if (!p) continue;
    try { execFileSync(p, ['--version'], { stdio: 'ignore' }); return p; } catch { /* next */ }
  }
  return null;
}
const py = findPython();
if (!py) {
  console.log('[3] 跳过端到端（本机无 python）；以上两项已通过');
} else {
  console.log('[3] 端到端（gen_synthetic + train + 推理）');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fpm_policy_'));
  try {
    const gen = path.join(ROOT, 'tools/npc-policy/gen_synthetic.py');
    const train = path.join(ROOT, 'tools/npc-policy/train.py');
    execFileSync(py, [gen, '-n', '2500', '-o', path.join(tmp, 'feed/sft_pretrain.csv')], { stdio: 'ignore' });
    execFileSync(py, [train, '--data', path.join(tmp, 'feed'), '--out', path.join(tmp, 'campus_policy.json'), '--epochs', '14'], { stdio: 'ignore' });
    const lp = loadPolicy(tmp);
    ok(lp.ready, 'loadPolicy 成功', lp.reason);
    ok(lp.net && lp.net.contractOk, '契约一致（contractOk）');
    const x1 = new Array(STATE_KEYS.length).fill(0);
    x1[STATE_KEYS.indexOf('hour')] = 8 / 24; x1[STATE_KEYS.indexOf('cur_classroom')] = 1; x1[STATE_KEYS.indexOf('hasClass')] = 1;
    const x2 = new Array(STATE_KEYS.length).fill(0);
    x2[STATE_KEYS.indexOf('hour')] = 12 / 24; x2[STATE_KEYS.indexOf('hunger')] = 0.95; x2[STATE_KEYS.indexOf('cur_canteen')] = 1;
    const x3 = new Array(STATE_KEYS.length).fill(0);
    x3[STATE_KEYS.indexOf('hour')] = 23 / 24; x3[STATE_KEYS.indexOf('fatigue')] = 0.95; x3[STATE_KEYS.indexOf('cur_dorm')] = 1;
    ok(lp.net.decide(x1) === 'classroom', '上课时段 → classroom', lp.net.decide(x1));
    ok(lp.net.decide(x2) === 'canteen', '午饭且饿 → canteen', lp.net.decide(x2));
    ok(lp.net.decide(x3) === 'dorm', '深夜且累 → dorm', lp.net.decide(x3));
  } catch (e) {
    ok(false, '端到端运行', String(e && e.message || e));
  }
}

console.log(fails ? '\n✗ ' + fails + ' 条断言失败' : '\n✓ 全部通过');
process.exit(fails ? 1 : 0);
