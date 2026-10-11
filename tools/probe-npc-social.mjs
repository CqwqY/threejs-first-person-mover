// 守卫探针：P0「对话能改变它」——在 Node 里真跑 server-remote/npcworld.js。
// 守的是：
//   ① 搭话后 NPC 的**心情**确实变了（mood）、对说话人的**关系**确实变了（rel['p:x'].trust）；
//   ② 对话给的 goalType 会**直接改道**（intent 落地 + 开始走）；
//   ③ 规划(plan)与搭话(talk)的 prompt 都会带上 mood/rel（否则"改变"传不给下一次决策）。
// 临时数据写到项目根之外（E:/_fpm_probe_social）。
import fs from 'node:fs';
import path from 'node:path';
import { createNpcWorld } from '../server-remote/npcworld.js';

const TMP = 'E:/_fpm_probe_social';
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
  fs.writeFileSync(path.join(dir, 'editor-scene.json'), JSON.stringify({ scenery: [], placed: [] }));
}
function writeStudents(dir, mood) {
  const list = [];
  for (let i = 0; i < 8; i++) {
    list.push({
      id: 's' + (i + 1), name: '学生' + (i + 1), sex: 'm', cls: '高二(1)班', persona: '普通学生',
      x: 10 + i * 0.4, z: 10, hx: 10, hz: 10, tx: 10, tz: 10, wx: 10, wz: 10, path: null, pathIdx: 0, pathTries: 0,
      rot: 0, st: 'idle', zoneId: '', stayUntil: 0, decideAt: 0, planAt: 0, intent: null, aiAt: 0, walkUntil: 0, stuck: 0,
      needs: { hunger: 0.4, fatigue: 0.3, fun: 0.4, study: 0.5, social: 0.3, bladder: 0.2 },
      mood, rel: {}, mem: [], think: [],
    });
  }
  fs.writeFileSync(path.join(dir, 'students.json'), JSON.stringify(list, null, 2));
}
function writeZones(dir) {
  fs.writeFileSync(path.join(dir, 'zones.json'), JSON.stringify([
    { id: 'zc', name: '学生饭堂', type: 'canteen', minX: 40, maxX: 60, minZ: 40, maxZ: 60 },
  ]));
}

console.log('[1] 搭话改变心情/关系/去向');
{
  const dir = freshDir('talk');
  writeScene(dir);
  writeStudents(dir, { valence: 0.4, energy: 0.5, focus: 0.5 });
  writeZones(dir);
  const seen = [];
  const w = createNpcWorld({
    dataDir: dir,
    broadcast: () => {},
    getDayTime: () => 0.35,
    askStudent: async (input) => {
      seen.push({ kind: input.kind, mood: input.student && input.student.mood, rel: input.student && input.student.rel });
      if (input.kind === 'talk') return { say: '好呀，谢谢！', think: '他挺客气', mem: '玩家请我吃饭', mood: '开心', affinity: 0.8, goalType: 'canteen' };
      if (input.kind === 'plan') return { goalType: 'rest', goal: '歇会', activity: '', plan: '', durationSec: 60, thought: '' };
      return { say: '', think: '', mem: '' };
    },
  });
  await sleep(120);
  const out = await w.talk('s1', '请你去吃饭', '小明', null, 'p:u1');
  await sleep(120);
  const st = w.stateOf('s1');
  w.dispose();
  ok(!!out && out.say === '好呀，谢谢！', 'talk 正常回话', JSON.stringify(out));
  ok(st && st.mood.valence > 0.5, '心情被改：valence 0.4 → 变高（mood 开心）', st && ('valence=' + st.mood.valence.toFixed(3)));
  ok(st && st.rel && st.rel['p:u1'] && st.rel['p:u1'].trust > 0.3, '对说话人的关系被改：trust > 0.3', st && JSON.stringify(st.rel));
  ok(st && st.intent && st.intent.goalType === 'canteen', '对话给的 goalType 落地成意图', st && JSON.stringify(st.intent));
  ok(st && (st.st === 'walk' || st.st === 'act'), '因此真的开始行动（walk/act）', st && st.st);
  const talkCall = seen.find((x) => x.kind === 'talk');
  ok(talkCall && talkCall.mood && typeof talkCall.mood.valence === 'number', 'talk 的 prompt 里带了 mood', talkCall && JSON.stringify(talkCall.mood));
}

console.log('[2] plan 的 prompt 带 mood/rel（"改变"能传给下一次决策）');
{
  const dir = freshDir('plan');
  writeScene(dir);
  writeStudents(dir, { valence: 0.9, energy: 0.2, focus: 0.6 }); // 心情很好但很累
  writeZones(dir);
  // 先制造一条关系
  let planMood = null, planRel = null;
  const w = createNpcWorld({
    dataDir: dir,
    broadcast: () => {},
    getDayTime: () => 0.35,
    askStudent: async (input) => {
      if (input.kind === 'talk') return { say: '嗯', think: '', mem: '', mood: '开心', affinity: 0.9, goalType: '' };
      if (input.kind === 'plan') { planMood = input.student && input.student.mood; planRel = input.student && input.student.rel; return null; } // 回 null → 回退规则大脑（只看 prompt 是否带 mood/rel）
      return { say: '', think: '', mem: '' };
    },
  });
  await sleep(360); // 等首个 tick 触发一次 plan（TICK_MS=200）
  await w.talk('s2', '你好', '小明', null, 'p:u1');
  await sleep(80);
  w.dispose();
  ok(!!planMood && typeof planMood.valence === 'number', 'plan prompt 带 mood', JSON.stringify(planMood));
  ok(!!planMood && planMood.valence > 0.5, 'plan 的 mood 是真实的（文件里 valence≈0.9）', JSON.stringify(planMood));
  ok(!!planRel && typeof planRel === 'object', 'plan prompt 带 rel（关系摘要）', JSON.stringify(planRel));
}

console.log(fails ? '\n✗ ' + fails + ' 条断言失败' : '\n✓ 全部通过');
process.exit(fails ? 1 : 0);
