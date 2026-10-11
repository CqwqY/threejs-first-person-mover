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

console.log('[4] 感知：会注意到身边的人（廉价、不进 mem、不触发压缩）');
{
  const dir = freshDir('perceive');
  writeScene(dir);
  // 8m 间距：在感知半径(10m)内、但在闲聊半径(5m)外 → 只感知不聊；planAt/decideAt 拉远 → 站立不动
  const list = [];
  for (let i = 0; i < 8; i++) {
    list.push({
      id: 's' + (i + 1), name: '学生' + (i + 1) + '号', sex: 'm', cls: '高二(1)班', persona: '普通学生',
      x: i * 8, z: 0, hx: i * 8, hz: 0, tx: i * 8, tz: 0, wx: i * 8, wz: 0, path: null, pathIdx: 0, pathTries: 0,
      rot: 0, st: 'idle', zoneId: '', stayUntil: 0, decideAt: 1e15, planAt: 1e15, intent: null, aiAt: 0, walkUntil: 0, stuck: 0, chatAt: 0, talkingUntil: 0, perceiveAt: 0,
      needs: { hunger: 0.4, fatigue: 0.3, fun: 0.4, study: 0.5, social: 0.3, bladder: 0.2 },
      mood: { valence: 0.5, energy: 0.6, focus: 0.5 }, rel: {}, mem: [], think: [], saw: [],
    });
  }
  fs.writeFileSync(path.join(dir, 'students.json'), JSON.stringify(list, null, 2));
  writeZones(dir);
  const w = createNpcWorld({ dataDir: dir, broadcast: () => {}, getDayTime: () => 0.35, askStudent: async () => ({ say: '', think: '', mem: '' }) });
  await sleep(420); // 等首个 tick（TICK_MS=200）
  const st = w.stateOf('s1');
  w.dispose();
  ok(st && Array.isArray(st.mem) && st.mem.length > 0, 's1 注意到了身边的人 → 观察写进 mem', st && JSON.stringify(st.mem));
  ok(st && st.mem.some((m) => /也在这|玩家/.test(String(m.text))), '观察文本确实在 mem 里', st && JSON.stringify(st.mem));
}

console.log('[5] 成本护栏：观察多到超上限时，先丢观察、**不花 LLM 压缩**');
{
  const dir = freshDir('obs-cap');
  writeScene(dir);
  // 一个学生的 mem 塞满 25 条"观察"（kind:'obs'）——超 MEM_MAX(20)
  const list = [];
  for (let i = 0; i < 8; i++) {
    const mem = [];
    if (i === 0) for (let k = 0; k < 25; k++) mem.push({ t: k, text: '我看见某人' + k + '也在这', kind: 'obs', from: 's2' });
    list.push({
      id: 's' + (i + 1), name: '学生' + (i + 1) + '号', sex: 'm', cls: '高二(1)班', persona: '普通学生',
      x: i * 10, z: 0, hx: i * 10, hz: 0, tx: i * 10, tz: 0, wx: i * 10, wz: 0, path: null, pathIdx: 0, pathTries: 0,
      rot: 0, st: 'idle', zoneId: '', stayUntil: 0, decideAt: 1e15, planAt: 1e15, intent: null, aiAt: 0, walkUntil: 0, stuck: 0, chatAt: 0, talkingUntil: 0, perceiveAt: 0,
      needs: { hunger: 0.4, fatigue: 0.3, fun: 0.4, study: 0.5, social: 0.3, bladder: 0.2 },
      mood: { valence: 0.5, energy: 0.6, focus: 0.5 }, rel: {}, mem, think: [],
    });
  }
  fs.writeFileSync(path.join(dir, 'students.json'), JSON.stringify(list, null, 2));
  writeZones(dir);
  const kinds = [];
  const w = createNpcWorld({
    dataDir: dir,
    broadcast: () => {},
    getDayTime: () => 0.35,
    askStudent: async (input) => {
      kinds.push(String(input.kind || ''));
      if (input.kind === 'talk') return { say: '嗯', think: '', mem: '一件正经事', mood: '', affinity: 0, goalType: '' };
      return { say: '', think: '', mem: '' };
    },
  });
  await sleep(60);
  await w.talk('s1', '你好', '小明', null, 'p:u1'); // 触发一次 mem 写入 → 超上限 → trimMemory
  await sleep(120);
  const st = w.stateOf('s1');
  w.dispose();
  ok(!kinds.includes('compress'), '没有调用 LLM 压缩（观察被本地丢弃腾地方）', 'kinds=' + kinds.join(','));
  ok(st && Number(st.memLen) <= 20, 'mem 已回落到上限以内', st && ('len=' + st.memLen));
}

function questStudents(positions) {
  const list = [];
  for (let i = 0; i < 8; i++) {
    const p = positions[i] || [100 + i * 20, 100]; // 默认 20m 间距：够远，不会自动闲聊、也不到"找到"距离
    list.push({
      id: 's' + (i + 1), name: '学生' + (i + 1) + '号', sex: 'm', cls: '高二(1)班', persona: '普通学生',
      x: p[0], z: p[1], hx: p[0], hz: p[1], tx: p[0], tz: p[1], wx: p[0], wz: p[1], path: null, pathIdx: 0, pathTries: 0,
      rot: 0, st: 'idle', zoneId: '', stayUntil: 0, decideAt: 1e15, planAt: 1e15, intent: null, quest: null, aiAt: 0, walkUntil: 0, stuck: 0, chatAt: 0, talkingUntil: 0, perceiveAt: 0,
      needs: { hunger: 0.4, fatigue: 0.3, fun: 0.4, study: 0.5, social: 0.3, bladder: 0.2 },
      mood: { valence: 0.5, energy: 0.6, focus: 0.5 }, rel: {}, mem: [], think: [],
    });
  }
  return list;
}

console.log('[6] 委托任务：解析"去找谁、问什么"→ 建任务并朝目标走');
{
  const dir = freshDir('quest-goto');
  writeScene(dir);
  fs.writeFileSync(path.join(dir, 'students.json'), JSON.stringify(questStudents([]), null, 2));
  writeZones(dir);
  const w = createNpcWorld({
    dataDir: dir, broadcast: () => {}, getDayTime: () => 0.35,
    askStudent: async (input) => (input.kind === 'talk'
      ? { say: '好', think: '', mem: '', task: { target: '学生2号', question: '1+1等于几' } }
      : { say: '', think: '', mem: '' }),
  });
  w.setPlayerPositions([{ id: 'u1', x: -100, z: -100 }]); // 玩家很远 → 先停在 goto
  await sleep(60);
  await w.talk('s1', '帮我找学生2号，问他1+1等于几，回来告诉我', '小明', null, 'p:u1');
  await sleep(420);
  const st = w.stateOf('s1');
  w.dispose();
  ok(st && st.quest && st.quest.targetId === 's2', '任务已创建且把人名解析成目标 id（学生2号→s2）', st && JSON.stringify(st.quest));
  ok(st && st.quest && /1\+1/.test(String(st.quest.question)), '任务带上了要问的问题', st && JSON.stringify(st.quest));
  ok(st && st.st === 'walk', 'NPC 朝目标走动起来了', st && st.st);
}

console.log('[7] 委托任务：找到人 → 问 → 回来复命（全流程，含一次 LLM 提问）');
{
  const dir = freshDir('quest-full');
  writeScene(dir);
  fs.writeFileSync(path.join(dir, 'students.json'), JSON.stringify(questStudents([[0, 0], [0, 2]]), null, 2)); // s1 与 s2 相距 2m（< 3m 就"找到"）
  writeZones(dir);
  const says = [];
  const kinds = [];
  const w = createNpcWorld({
    dataDir: dir,
    broadcast: (m) => { if (m.t === 'npc_say') says.push({ id: m.id, say: m.say }); },
    getDayTime: () => 0.35,
    askStudent: async (input) => {
      kinds.push(String(input.kind || ''));
      if (input.kind === 'talk') return { say: '好，我这就去', think: '', mem: '', task: { target: '学生2号', question: '1+1等于几' } };
      if (input.kind === 'ask') return { say: '等于2', think: '', mem: '' };
      return { say: '', think: '', mem: '' };
    },
  });
  w.setPlayerPositions([{ id: 'u1', x: 0, z: 0 }]); // 玩家就在 s1 身边
  await sleep(60);
  await w.talk('s1', '帮我找学生2号问他1+1等于几再回来', '小明', null, 'p:u1');
  await sleep(900);
  const st = w.stateOf('s1');
  w.dispose();
  ok(kinds.includes('ask'), '真的去"问"了（一次 LLM 提问调用）', 'kinds=' + kinds.join(','));
  ok(says.some((x) => /等于2/.test(String(x.say))), '回来复命：把答案说出来了', JSON.stringify(says));
  ok(st && st.quest === null, '任务完成并清空', st && JSON.stringify(st.quest));
}

console.log('[8] 校卡：card() 返回性格/心情/目标/关系（人名）/记忆');
{
  const dir = freshDir('card');
  writeScene(dir);
  fs.writeFileSync(path.join(dir, 'students.json'), JSON.stringify(questStudents([[0, 0]]), null, 2));
  writeZones(dir);
  const w = createNpcWorld({
    dataDir: dir, broadcast: () => {}, getDayTime: () => 0.35,
    askStudent: async (input) => (input.kind === 'talk'
      ? { say: '嗯', think: '', mem: '玩家跟我打了招呼', mood: '开心', affinity: 0.5, goalType: '' }
      : { say: '', think: '', mem: '' }),
  });
  await sleep(60);
  await w.talk('s1', '你好', '小明', null, 'p:u1');
  await sleep(120);
  const c = w.card('s1');
  w.dispose();
  ok(c && c.name && c.cls && c.persona, 'card 有基本资料（姓名/班级/性格）', c && JSON.stringify({ name: c.name, cls: c.cls }));
  ok(c && c.mood && typeof c.mood.valence === 'number', 'card 带心情', c && JSON.stringify(c.mood));
  ok(c && Array.isArray(c.mem) && c.mem.length > 0, 'card 带近期记忆', c && ('memLen=' + (c.mem || []).length));
  ok(c && Array.isArray(c.rel) && c.rel.some((r) => r.who === '玩家'), '关系已解析成人名（玩家）', c && JSON.stringify(c.rel));
}

console.log('[9] 公告栏 → AI 规划时带上公告；广播器 → 轮流写进学生记忆');
{
  const dir = freshDir('board');
  writeScene(dir);
  const blist = questStudents([]);
  for (const s of blist) { s.planAt = 0; s.decideAt = 0; } // 要让首个 tick 真的触发一次 plan
  fs.writeFileSync(path.join(dir, 'students.json'), JSON.stringify(blist, null, 2));
  writeZones(dir);
  let planBoard = null;
  const w = createNpcWorld({
    dataDir: dir, broadcast: () => {}, getDayTime: () => 0.35,
    askStudent: async (input) => { if (input.kind === 'plan') { planBoard = input.student && input.student.board; return null; } return { say: '', think: '', mem: '' }; },
  });
  w.setBoard(['操场下午有活动']);
  await sleep(400);
  w.announce('注意，操场集合');
  await sleep(4600); // 等广播轮流下发（ANNOUNCE_GAP_MS=4000）
  const got = [];
  for (const sid of ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']) {
    const st = w.stateOf(sid);
    if (st && st.mem && st.mem.some((m) => /全校广播/.test(String(m.text)))) got.push(sid);
  }
  w.dispose();
  ok(planBoard && JSON.stringify(planBoard).includes('操场下午有活动'), 'plan 的 prompt 带上了公告栏内容（AI 决策时会看公告）', JSON.stringify(planBoard));
  ok(got.length >= 1, '广播已**轮流**写进学生记忆（≥1 人听到）', 'got=' + got.join(','));
}

function distW(w, a, b) {
  const x = w.stateOf(a), y = w.stateOf(b);
  if (!x || !y) return NaN;
  return Math.hypot(x.x - y.x, x.z - y.z);
}

console.log('[10] NPC 之间离得远 → 主动**相向走近**，凑近了自动开聊');
{
  const dir = freshDir('meet');
  writeScene(dir);
  const list = [];
  for (let i = 0; i < 8; i++) {
    const x = i === 0 ? 0 : (i === 1 ? 9 : 300 + i * 30); // 只有 s1/s2 离得"有点远但可及"
    list.push({
      id: 's' + (i + 1), name: '学生' + (i + 1) + '号', sex: 'm', cls: '高二(1)班', persona: '普通学生',
      x, z: 0, hx: x, hz: 0, tx: x, tz: 0, wx: x, wz: 0, path: null, pathIdx: 0, pathTries: 0,
      rot: 0, st: 'idle', zoneId: '', stayUntil: 0, decideAt: 1e15, planAt: 1e15, intent: null, aiAt: 0, walkUntil: 0, stuck: 0, chatAt: 0, talkingUntil: 0, perceiveAt: 0,
      needs: { hunger: 0.4, fatigue: 0.3, fun: 0.4, study: 0.5, social: 0.3, bladder: 0.2 },
      mood: { valence: 0.5, energy: 0.6, focus: 0.5 }, rel: {}, mem: [], think: [],
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
      if (input.kind === 'chat') return { lines: [{ who: 'a', text: '哎，你也在这儿啊' }, { who: 'b', text: '嗯，刚过来' }], topic: '碰面', memA: '', memB: '', moodA: '开心', moodB: '平静', bond: 0.3 };
      return { say: '', think: '', mem: '' };
    },
  });
  const d0 = distW(w, 's1', 's2');
  await sleep(4200);
  const d1 = distW(w, 's1', 's2');
  const a = w.stateOf('s1'), b = w.stateOf('s2');
  w.dispose();
  ok(d0 > 6, '一开始两人离得远（>6m）', 'd0=' + d0.toFixed(2));
  ok(d1 < d0 - 2, '两人**主动相向走近**了（距离明显缩小）', 'd0=' + d0.toFixed(2) + ' → d1=' + d1.toFixed(2));
  ok(d1 < 6, '走近到"能聊天"的范围', 'd1=' + d1.toFixed(2));
  ok(says.length >= 2 && says.some((s) => s.id === 's1') && says.some((s) => s.id === 's2'), '凑近后自动开聊（两人台词都广播出来）', JSON.stringify(says));
  // 记忆归属：按**实际台词**记，谁说的就是谁说的
  ok(!!a && a.mem.some((m) => /我说「哎，你也在这儿啊」/.test(String(m.text))), 's1 的记忆是自己的台词（归属正确）', a && JSON.stringify(a.mem));
  ok(!!b && b.mem.some((m) => /我说「嗯，刚过来」/.test(String(m.text))), 's2 的记忆是对方那句 + 自己那句（归属正确）', b && JSON.stringify(b.mem));
}

console.log('[11] 委托：真的走到**远处的玩家**身边复命');
{
  const dir = freshDir('quest-return');
  writeScene(dir);
  const pos = [[0, 0], [2.5, 0], [300, 0], [320, 0], [340, 0], [360, 0], [380, 0], [400, 0]];
  fs.writeFileSync(path.join(dir, 'students.json'), JSON.stringify(questStudents(pos), null, 2)); // s1/s2 相距 2.5m（<3 → 立刻"找到"）
  writeZones(dir);
  const says = [];
  const w = createNpcWorld({
    dataDir: dir,
    broadcast: (m) => { if (m.t === 'npc_say') says.push({ id: m.id, say: m.say }); },
    getDayTime: () => 0.35,
    askStudent: async (input) => {
      if (input.kind === 'talk') return { say: '好，我这就去', think: '', mem: '', task: { target: '学生2号', question: '1+1等于几' } };
      if (input.kind === 'ask') return { say: '等于2', think: '', mem: '' };
      return { say: '', think: '', mem: '' };
    },
  });
  const PX = 7, PZ = 0; // 玩家在 7m 外：NPC 必须走过去才算复命
  w.setPlayerPositions([{ id: 'u1', x: PX, z: PZ }]);
  await sleep(60);
  await w.talk('s1', '帮我找学生2号问他1+1等于几再回来', '小明', null, 'p:u1');
  await sleep(1500);
  const mid = w.stateOf('s1');
  await sleep(4200);
  const st = w.stateOf('s1');
  w.dispose();
  ok(mid && mid.x > 0.5, '问完之后**朝玩家那边走**（x 变大，不是原地喊）', 'mid.x=' + (mid && mid.x.toFixed(2)));
  ok(says.some((x) => /等于2/.test(String(x.say))), '把答案说出来复命', JSON.stringify(says));
  ok(st && Math.hypot(st.x - PX, st.z - PZ) < 3.5, '复命时人已经**走到玩家身边**（<3.5m）', st && ('d=' + Math.hypot(st.x - PX, st.z - PZ).toFixed(2)));
  ok(st && st.quest === null, '任务完成并清空', st && JSON.stringify(st.quest));
}

console.log(fails ? '\n✗ ' + fails + ' 条断言失败' : '\n✓ 全部通过');
process.exit(fails ? 1 : 0);
