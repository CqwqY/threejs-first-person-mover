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

console.log('[3] NPC↔NPC 闲聊：双方都记账/改心情/改关系，台词广播出来');
{
  const dir = freshDir('chat');
  writeScene(dir);
  // 学生彼此拉开 >5m：避免主循环自动开聊，专测 forceChat
  const list = [];
  for (let i = 0; i < 8; i++) {
    list.push({
      id: 's' + (i + 1), name: '学生' + (i + 1) + '号', sex: 'm', cls: '高二(1)班', persona: '普通学生',
      x: i * 10, z: 0, hx: i * 10, hz: 0, tx: i * 10, tz: 0, wx: i * 10, wz: 0, path: null, pathIdx: 0, pathTries: 0,
      rot: 0, st: 'idle', zoneId: '', stayUntil: 0, decideAt: 0, planAt: 1e15, intent: null, aiAt: 0, walkUntil: 0, stuck: 0, chatAt: 0, talkingUntil: 0,
      needs: { hunger: 0.4, fatigue: 0.3, fun: 0.4, study: 0.5, social: 0.3, bladder: 0.2 },
      mood: { valence: 0.4, energy: 0.5, focus: 0.5 }, rel: {}, mem: [], think: [],
    });
  }
  fs.writeFileSync(path.join(dir, 'students.json'), JSON.stringify(list, null, 2));
  writeZones(dir);
  const says = [];
  const w = createNpcWorld({
    dataDir: dir,
    broadcast: (m) => { if (m.t === 'npc_say') says.push({ id: m.id, say: m.say }); },
    getDayTime: () => 0.35,
    askStudent: async (input) => {
      if (input.kind === 'chat') return {
        lines: [{ who: 'a', text: '你听说玩家的事了吗？' }, { who: 'b', text: '没，快说说。' }, { who: 'a', text: '回头讲给你。' }],
        topic: '玩家八卦', memA: '我向学生2号号打听了玩家的事', memB: '学生1号号要跟我讲玩家的事', moodA: '开心', moodB: '好奇', bond: 0.5,
      };
      if (input.kind === 'plan') return null;
      return { say: '', think: '', mem: '' };
    },
  });
  await sleep(50);
  await w.forceChat('s1', 's2');
  await sleep(2600); // 等延迟广播的第 2~3 句
  const a = w.stateOf('s1'), b = w.stateOf('s2');
  w.dispose();
  ok(says.length >= 2, '对话台词广播出来了（≥2 句，玩家能偷听）', JSON.stringify(says));
  ok(says.some((s) => s.id === 's1') && says.some((s) => s.id === 's2'), '两个学生都发了言', JSON.stringify(says.map((s) => s.id)));
  ok(!!a && a.mem.some((m) => /打听|玩家/.test(m.text)), 's1 记住了这次闲聊', a && JSON.stringify(a.mem));
  ok(!!b && b.mem.length > 0, 's2 也记住了这次闲聊', b && JSON.stringify(b.mem));
  ok(!!a && a.rel['s2'] && a.rel['s2'].trust > 0, '关系双向更新：s1 对 s2 trust>0', a && JSON.stringify(a.rel));
  ok(!!b && b.rel['s1'] && b.rel['s1'].trust > 0, '关系双向更新：s2 对 s1 trust>0', b && JSON.stringify(b.rel));
  ok(!!a && a.mood.valence > 0.4, '情绪被聊到（moodA 开心 → valence 升）', a && ('valence=' + a.mood.valence.toFixed(3)));
}

console.log(fails ? '\n✗ ' + fails + ' 条断言失败' : '\n✓ 全部通过');
process.exit(fails ? 1 : 0);
