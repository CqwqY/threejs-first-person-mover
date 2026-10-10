// 守卫探针：System2（LLM「灵魂」）规划层（在 Node 里真跑 server-remote/npcworld.js）。
// 守的是这几条静默失效：
//   ① planNext 真的提交意图：GLM 返回 {goalType:'canteen',...} 后，学生目标点 tx/tz 落在对应 zone 内、且开始移动；
//   ② GLM 返回 null（宕机/没配 key）→ 自动回退 decide()（规则大脑），学生照常移动、broadcast 无 NaN、goal 为空；
//   ③ GLM 返回非法 goalType（如 'zzz'）→ resolveGoalType 归一成 wander，学生照样走动、不崩溃。
// 临时数据写到项目根之外（E:/_fpm_probe_plan），别在项目里留 tmp/。
import fs from 'node:fs';
import path from 'node:path';
import { createNpcWorld } from '../server-remote/npcworld.js';

const TMP = 'E:/_fpm_probe_plan';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
function ok(cond, name, extra) {
  if (cond) console.log('  ok   ' + name);
  else { console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); fails++; }
}

function freshDir(name) {
  const d = path.join(TMP, name);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function writeScene(dir) {
  fs.writeFileSync(path.join(dir, 'editor-scene.json'), JSON.stringify({
    boundary: {}, scenery: [],
    placed: [{ id: 'b1', kind: 'building', name: '教学楼', x: 0, y: 0, z: 0, rotY: 0, scale: { x: 1, y: 1, z: 1 }, fw: 20, fd: 10 }],
    lights: [],
  }));
}
function writeStudents(dir, x, z) {
  const list = [];
  for (let i = 0; i < 8; i++) {
    list.push({
      id: 's' + (i + 1), name: '学生' + (i + 1), sex: i % 2 ? 'f' : 'm', cls: '高二(1)班', persona: '普通学生',
      x: x + i * 0.4, z: z + i * 0.4, hx: x, hz: z, tx: x, tz: z,
      rot: 0, st: 'idle', zoneId: '', stayUntil: 0, decideAt: 0, planAt: 0, intent: null, aiAt: 0, walkUntil: 0, stuck: 0,
      needs: { hunger: 0.4, fatigue: 0.3, fun: 0.4, study: 0.5, social: 0.3, bladder: 0.2 },
      mem: [], think: [],
    });
  }
  fs.writeFileSync(path.join(dir, 'students.json'), JSON.stringify(list, null, 2));
}
function writeZones(dir) {
  fs.writeFileSync(path.join(dir, 'zones.json'), JSON.stringify([
    { id: 'za', name: '第一教学楼', type: 'classroom', minX: 40, maxX: 60, minZ: 40, maxZ: 60 },
    { id: 'zb', name: '学生饭堂', type: 'canteen', minX: -40, maxX: -20, minZ: -40, maxZ: -20 },
  ]));
}
const CANTEEN = { minX: -40, maxX: -20, minZ: -40, maxZ: -20 };
const inRect = (x, z, r) => x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ;
const anyNaN = (list) => list.some((s) => !Number.isFinite(s.x) || !Number.isFinite(s.z) || !Number.isFinite(s.tx) || !Number.isFinite(s.tz));

console.log('[1] planNext 真的提交意图：目标点落在对应 zone 内且开始移动');
{
  const dir = freshDir('plan');
  writeScene(dir);
  writeStudents(dir, 10, 10);
  writeZones(dir);
  const kinds = [];
  let firstS1 = null;
  const frames = [];
  const w = createNpcWorld({
    dataDir: dir,
    broadcast: (m) => {
      if (m.t !== 'npc') return;
      frames.push(m.list.map((s) => ({ id: s.id, x: s.x, z: s.z, tx: s.tx, tz: s.tz, st: s.st, goal: s.goal })));
    },
    getDayTime: () => 0.35, // 8.4 点：课表是 classroom，但 LLM 意图（canteen）应胜出
    askStudent: async (input) => {
      kinds.push(String(input.kind || ''));
      if (input.kind === 'plan') return { goalType: 'canteen', goal: '去吃饭', activity: '打饭坐下吃', plan: '走到饭堂', durationSec: 120, thought: '有点饿' };
      return { say: '嗯。', think: '', mem: '' };
    },
  });
  await sleep(2000);
  w.dispose();
  firstS1 = frames.find((f) => f.find((s) => s.id === 's1'))?.find((s) => s.id === 's1');
  ok(kinds.includes('plan'), '确实走到了 LLM 规划调用（kind=plan）', 'kinds=' + kinds.join(','));
  const last1 = frames[frames.length - 1]?.find((s) => s.id === 's1');
  ok(!!last1, '拿到 s1 的最终帧');
  if (last1) {
    ok(last1.goal === 'canteen', 'broadcast 带 goal=canteen（意图已落地）', 'goal=' + last1.goal);
    ok(inRect(last1.tx, last1.tz, CANTEEN), '目标点 tx/tz 落在饭堂 zone 内', 'tx=' + last1.tx + ' tz=' + last1.tz);
    const init1 = frames[0]?.find((s) => s.id === 's1');
    const moved = Math.hypot(last1.x - (init1 ? init1.x : 10), last1.z - (init1 ? init1.z : 10));
    ok(moved > 0.3, 's1 朝着饭堂移动了', '位移=' + moved.toFixed(2) + 'm');
    ok(!anyNaN(frames.map((f) => f.find((s) => s.id === 's1'))), '全程坐标无 NaN');
  }

  // 慢环（"用 LLM 训练神经"）：LLM 的决策必须回写成可训练标签，否则闭环没闭上
  const sftPath = path.join(dir, 'feed', 'llm_plan.csv');
  const sft = fs.existsSync(sftPath) ? fs.readFileSync(sftPath, 'utf8').trim().split('\n') : [];
  ok(sft.length >= 2, '写了 llm_plan.csv（表头 + ≥1 样本行）', '行数=' + sft.length);
  const header = (sft[0] || '').split(',');
  ok(header.length === 23 && header[21] === 'action' && header[22] === 'weight',
    'CSV 表头 = 21 状态 + action + weight', header.join('|'));
  const row0 = (sft[1] || '').split(',');
  ok(row0[22 - 1] === 'canteen', '首个样本动作 = canteen（LLM 的选择被写成标签）', 'row=' + (sft[1] || ''));
  ok(Number(row0[6]) > 1 && Number(row0[6]) <= 24, 'hour 列是原始小时 0~24（不是归一化值）', 'hour=' + row0[6]);
  const prefPath = path.join(dir, 'feed', 'llm_pref.csv');
  const pref = fs.existsSync(prefPath) ? fs.readFileSync(prefPath, 'utf8').trim().split('\n') : [];
  ok(pref.length >= 2, '写了 llm_pref.csv（chosen/rejected 偏好对，供 DPO）', '行数=' + pref.length);
  const ph = (pref[0] || '').split(',');
  ok(ph[21] === 'chosen' && ph[22] === 'rejected', '偏好表头含 chosen/rejected', ph.slice(-2).join('|'));
}

console.log('[2] GLM 返回 null（宕机/没配 key）→ 回退规则大脑，照常移动、无 NaN');
{
  const dir = freshDir('fallback');
  writeScene(dir);
  writeStudents(dir, 10, 10);
  writeZones(dir);
  const frames = [];
  const w = createNpcWorld({
    dataDir: dir,
    broadcast: (m) => { if (m.t === 'npc') frames.push(m.list.map((s) => ({ id: s.id, x: s.x, z: s.z, tx: s.tx, tz: s.tz, st: s.st, goal: s.goal }))); },
    getDayTime: () => 0.35,
    askStudent: async (input) => (input.kind === 'plan' ? null : { say: '', think: '', mem: '' }),
  });
  await sleep(2600);
  w.dispose();
  const init1 = frames[0]?.find((s) => s.id === 's1');
  const last1 = frames[frames.length - 1]?.find((s) => s.id === 's1');
  ok(!!init1 && !!last1, '拿到 s1 首尾帧');
  const moved = last1 ? Math.hypot(last1.x - init1.x, last1.z - init1.z) : 0;
  ok(moved > 0.3, '回退后 s1 仍在移动（规则大脑接管，不卡死）', '位移=' + moved.toFixed(2) + 'm');
  ok(last1 && last1.goal === '', '回退时 goal 为空（intent=null）', 'goal=' + (last1 && last1.goal));
  ok(!anyNaN(frames.map((f) => f.find((s) => s.id === 's1'))), '回退全程坐标无 NaN');
}

console.log('[3] GLM 返回非法 goalType（"zzz"）→ 归一成 wander，照样走动、不崩溃');
{
  const dir = freshDir('badgoal');
  writeScene(dir);
  writeStudents(dir, 10, 10);
  writeZones(dir);
  const frames = [];
  const w = createNpcWorld({
    dataDir: dir,
    broadcast: (m) => { if (m.t === 'npc') frames.push(m.list.map((s) => ({ id: s.id, x: s.x, z: s.z, tx: s.tx, tz: s.tz, st: s.st, goal: s.goal }))); },
    getDayTime: () => 0.35,
    askStudent: async (input) => (input.kind === 'plan'
      ? { goalType: 'zzz', goal: '随便', activity: '溜达', plan: '走走', durationSec: 120, thought: '不知道' }
      : { say: '', think: '', mem: '' }),
  });
  await sleep(2600);
  w.dispose();
  const init1 = frames[0]?.find((s) => s.id === 's1');
  const last1 = frames[frames.length - 1]?.find((s) => s.id === 's1');
  ok(!!init1 && !!last1, '拿到 s1 首尾帧');
  const moved = last1 ? Math.hypot(last1.x - init1.x, last1.z - init1.z) : 0;
  ok(moved > 0.3, '非法 goalType 归一成 wander 后 s1 仍在移动', '位移=' + moved.toFixed(2) + 'm');
  ok(last1 && (last1.goal === 'wander' || last1.goal === ''), 'goal 被规范成 wander（或空），不会是脏值', 'goal=' + (last1 && last1.goal));
  ok(!anyNaN(frames.map((f) => f.find((s) => s.id === 's1'))), '非法 goalType 全程坐标无 NaN');
}

console.log(fails ? '\n✗ ' + fails + ' 条断言失败' : '\n✓ 全部通过');
process.exit(fails ? 1 : 0);
