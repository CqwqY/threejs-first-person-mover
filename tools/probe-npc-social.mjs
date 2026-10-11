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
function writeZonesCustom(dir, list) { fs.writeFileSync(path.join(dir, 'zones.json'), JSON.stringify(list)); }
// 放一栋带真实占地的楼（服务端绕障用 fw/fd；rotY 是**弧度**，与 EditorApp 的写法一致）
function writeSceneWithBuilding(dir, x, z, w, d) {
  fs.writeFileSync(path.join(dir, 'editor-scene.json'), JSON.stringify({
    scenery: [],
    placed: [{ id: 'b1', x, y: 0, z, rotY: 0, scale: { x: 1, y: 1, z: 1 }, fw: w, fd: d }],
  }));
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
  // 闲聊现在是**事件驱动**：靠得近就按概率开口（最多 CHAT_NEAR_MAX=4s 必开口），不再等 20s 的定时
  await sleep(7500);
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
  const qlist = questStudents(pos); // s1/s2 相距 2.5m（<3 → 立刻"找到"）
  // ⚠ 本用例只验"委托走位"，必须屏蔽**无关系统**：s1/s2 靠得近会触发 NPC↔NPC 自动闲聊
  //   （chatAt:0 → 冷却已过 ⇒ pickPair 选到它俩 → 冻结走位）⇒ 假性抖动（实测 d 在 3.5~5.4 乱跳）。
  //   把 chatAt 顶到未来 = 闲聊冷却永远没过，走位才可复现。
  for (const s of qlist) s.chatAt = 1e15;
  fs.writeFileSync(path.join(dir, 'students.json'), JSON.stringify(qlist, null, 2));
  writeZones(dir);
  const says = [];
  let reportPos = null; // ⚠ "复命时"的位置：必须在 reportQuest 广播**那一刻**取（见下）
  const w = createNpcWorld({
    dataDir: dir,
    broadcast: (m) => {
      if (m.t !== 'npc_say') return;
      says.push({ id: m.id, say: m.say });
      if (!reportPos && m.id === 's1' && /问到了/.test(String(m.say))) reportPos = w.stateOf('s1');
    },
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
  // ⚠ 走位是 WALK_SPEED=1.25 m/s 的真实速度：s1(0,0)→s2(2.5,0) 已在 3m 内（立刻"找到"）→ 转向玩家(7,0)，约 5.6m≈4.5s。
  await sleep(7000);
  const st = w.stateOf('s1');
  w.dispose();
  ok(mid && mid.x > 0.5, '问完之后**朝玩家那边走**（x 变大，不是原地喊）', 'mid.x=' + (mid && mid.x.toFixed(2)));
  ok(says.some((x) => /等于2/.test(String(x.say))), '把答案说出来复命', JSON.stringify(says));
  // ⚠ 不能拿"固定 sleep 之后"的坐标当"复命位置"：复命后 NPC 进入 act 待机，会做**原地微动作**
  //   （ACT_STEP 随机朝后挪一小步）⇒ 固定时刻取样会抓到一个"已经漂回去"的点（实测 d 在 3.35~4.92 乱跳）。
  //   语义上"复命时"就是 reportQuest 广播那一刻 ⇒ 在 broadcast 回调里就地取样（见 reportPos）。
  ok(reportPos && Math.hypot(reportPos.x - PX, reportPos.z - PZ) < 3.5, '复命时人已经**走到玩家身边**（<3.5m）', reportPos && ('d=' + Math.hypot(reportPos.x - PX, reportPos.z - PZ).toFixed(2)));
  ok(st && st.quest === null, '任务完成并清空', st && JSON.stringify(st.quest));
}

console.log('[12] 站在碰撞体上方：不做二维寻路/脱困（改由客户端三维碰撞裁决）');
{
  const dir = freshDir('elevated');
  // 一栋 8×6 的楼挡在 s1(0,0) → s2(20,0) 的直线之间（中心 10,0）
  writeSceneWithBuilding(dir, 10, 0, 8, 6);
  const pos = [[0, 0], [20, 0], [300, 0], [320, 0], [340, 0], [360, 0], [380, 0], [400, 0]];
  fs.writeFileSync(path.join(dir, 'students.json'), JSON.stringify(questStudents(pos), null, 2));
  writeZones(dir);
  const w = createNpcWorld({
    dataDir: dir, broadcast: () => {}, getDayTime: () => 0.35,
    askStudent: async () => ({ say: '', think: '', mem: '' }),
  });
  w.setPlayerPositions([{ id: 'u1', x: 0, z: 0 }]);
  await sleep(60);
  // 地面上的正常情况：楼挡住直线 → 必须生成绕行路点
  w.debugStartQuest('s1', 's2', '问个事', 'u1');
  await sleep(120);
  const ground = w.stateOf('s1');
  // 客户端回报"人在台面/楼顶之上"（脚底高度 3m）→ 重新指目标
  w.applyClientState([{ id: 's1', y: 3 }]);
  w.debugStartQuest('s1', 's2', '再问一次', 'u1');
  await sleep(120);
  const up0 = w.stateOf('s1');
  const x0 = up0.x;
  await sleep(700);
  const up1 = w.stateOf('s1');
  w.dispose();
  ok(ground && ground.path > 0, '地面上：楼挡直线 → 生成 A* 绕行路点（对照）', 'path=' + (ground && ground.path));
  ok(up0 && up0.y === 3, '服务端已知"人在台面之上"（客户端回报的高度）', 'y=' + (up0 && up0.y));
  ok(up0 && up0.path === 0, '台面之上：**不生成**二维绕行路点（二维障碍表此时不可信）', 'path=' + (up0 && up0.path));
  ok(up1 && up1.x > x0 + 0.2, '朝目标直线前进（没被"脱困"顶回去）', 'x ' + x0.toFixed(2) + ' → ' + (up1 && up1.x.toFixed(2)));
}

console.log('[13] "让他找他自己" → 就地回答，不建任务、不改道、不寻路');
{
  const dir = freshDir('selftarget');
  writeScene(dir);
  fs.writeFileSync(path.join(dir, 'students.json'), JSON.stringify(questStudents([[0, 0], [2.5, 0], [300, 0], [320, 0], [340, 0], [360, 0], [380, 0], [400, 0]]), null, 2));
  writeZones(dir);
  const says = [];
  const w = createNpcWorld({
    dataDir: dir,
    broadcast: (m) => { if (m.t === 'npc_say') says.push({ id: m.id, say: m.say }); },
    getDayTime: () => 0.35,
    askStudent: async (input) => (input.kind === 'talk'
      // 模型把"你自己"当成了要找的人，还顺手给了个改道意图 —— 两样都必须被拦住
      ? { say: '好，我去。', think: '', mem: '', task: { target: '你自己', question: '你叫什么' }, mood: '开心', affinity: 0.5, goalType: 'canteen' }
      : { say: '', think: '', mem: '' }),
  });
  w.setPlayerPositions([{ id: 'u1', x: 0, z: 0 }]);
  await sleep(60);
  await w.talk('s1', '你去找你自己，问问你叫什么', '小明', null, 'p:u1');
  await sleep(300);
  const st = w.stateOf('s1');
  w.dispose();
  ok(st && st.quest === null, '没建委托任务（"你自己" = 本人，不该去建）', JSON.stringify(st && st.quest));
  ok(says.some((x) => /我就是/.test(String(x.say))), '就地回答"我就是X"（不出门）', JSON.stringify(says));
  ok(st && st.path === 0, '没有触发寻路（path=0）', 'path=' + (st && st.path));
  ok(st && st.intent === null, '没被对话里的 goalType 改道（有 task 时走位归任务管）', JSON.stringify(st && st.intent));
}

console.log('[14] plan 的 prompt：公告栏"始终存在" + 玩家在哪（人话）+ 同学名册');
{
  const dir = freshDir('ctx');
  writeScene(dir);
  const blist = questStudents([[0, 0], [8, 0], [16, 0], [24, 0], [32, 0], [40, 0], [48, 0], [56, 0]]);
  for (const s of blist) { s.planAt = 0; s.decideAt = 0; }
  fs.writeFileSync(path.join(dir, 'students.json'), JSON.stringify(blist, null, 2));
  writeZones(dir);
  let cap = null;
  const w = createNpcWorld({
    dataDir: dir, broadcast: () => {}, getDayTime: () => 0.35,
    askStudent: async (input) => { if (input.kind === 'plan') { cap = input.student; return null; } return { say: '', think: '', mem: '' }; },
  });
  w.setPlayerPositions([{ id: 'u1', x: 60, z: 0 }]);
  await sleep(400);
  w.dispose();
  ok(cap && /公告栏/.test(String(cap.boardLine || '')), '**没有公告**也要告诉它"学校有公告栏"', cap && String(cap.boardLine).slice(0, 70));
  ok(cap && String(cap.player || '') !== '', '告诉它玩家在哪（人话，不是坐标）', cap && cap.player);
  ok(cap && /(\d+\s*m|就在|方向)/.test(String(cap.player || '')), '玩家位置带距离/方位', cap && cap.player);
  // ⚠ cap 会被同一拍里的最后一个学生覆盖 ⇒ 断言只能查"不含**它自己**"，不能写死 '学生1号'
  ok(cap && Array.isArray(cap.mates) && cap.mates.length === 7 && cap.mates.indexOf(cap.name) < 0,
    '给出 7 个同学的名字（不含自己）——想找人才填得出有效人名', cap && JSON.stringify(cap.mates));
}

console.log('[15] 听公告：广播提到操场 → 学生真的往操场走（不是只记一条）');
{
  const dir = freshDir('obey');
  writeScene(dir);
  writeZonesCustom(dir, [{ id: 'zp', name: '操场', type: 'playground', minX: 40, maxX: 60, minZ: -10, maxZ: 10 }]);
  const blist = questStudents([[300, 0], [320, 0], [340, 0], [360, 0], [380, 0], [400, 0], [420, 0], [440, 0]]);
  for (const s of blist) { s.planAt = 1e15; s.decideAt = 1e15; s.st = 'idle'; }
  fs.writeFileSync(path.join(dir, 'students.json'), JSON.stringify(blist, null, 2));
  const w = createNpcWorld({ dataDir: dir, broadcast: () => {}, getDayTime: () => 0.35, askStudent: async () => ({ say: '', think: '', mem: '' }) });
  w.setPlayerPositions([]);
  await sleep(60);
  w.announce('注意，操场集合');
  await sleep(4600); // ANNOUNCE_GAP_MS=4000 → 至少一个人"听到"
  let obey = 0, inZone = 0, mem = 0;
  for (const sid of ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']) {
    const st = w.stateOf(sid);
    if (!st) continue;
    if (st.intent && st.intent.goalType === 'playground') { obey++; if (st.tx >= 40 && st.tx <= 60) inZone++; }
    if (st.mem.some((m) => /学校通知/.test(String(m.text)))) mem++;
  }
  w.dispose();
  ok(obey >= 1, '听到通知的学生把目标改成"操场"（真的照做，不只是记一条）', 'obey=' + obey);
  ok(inZone >= 1, '目标点落在操场区域内', 'inZone=' + inZone);
  ok(mem >= 1, '而且写了一条"学校通知…我这就去"的记忆', 'mem=' + mem);
}

console.log('[16] 客户端回报"卡住 + 真实坐标" → 服务端采纳坐标并重算路径');
{
  const dir = freshDir('stuck');
  writeSceneWithBuilding(dir, 10, 0, 8, 6);
  const pos = [[0, 0], [20, 0], [300, 0], [320, 0], [340, 0], [360, 0], [380, 0], [400, 0]];
  fs.writeFileSync(path.join(dir, 'students.json'), JSON.stringify(questStudents(pos), null, 2));
  writeZones(dir);
  const w = createNpcWorld({ dataDir: dir, broadcast: () => {}, getDayTime: () => 0.35, askStudent: async () => ({ say: '', think: '', mem: '' }) });
  w.setPlayerPositions([{ id: 'u1', x: 0, z: 0 }]);
  await sleep(60);
  w.debugStartQuest('s1', 's2', '问事', 'u1');
  await sleep(120);
  const before = w.stateOf('s1');
  w.applyClientState([{ id: 's1', x: 1.5, z: 0.2, y: 0, stuck: 1 }]);
  const after = w.stateOf('s1');
  w.dispose();
  ok(before && before.path > 0, '地面 + 楼挡直线 → 生成了绕行路点（对照）', 'path=' + (before && before.path));
  ok(after && Math.abs(after.x - 1.5) < 0.01 && Math.abs(after.z - 0.2) < 0.01,
    '采纳客户端回报的真实坐标（服务端幽灵对齐现实 → 判距/绕障才准）', after && (after.x + ',' + after.z));
}

console.log('[17] 想去找玩家（plan.seek="玩家"）→ 真的朝玩家走');
{
  const dir = freshDir('seekplayer');
  writeScene(dir);
  const blist = questStudents([[0, 0], [300, 0], [320, 0], [340, 0], [360, 0], [380, 0], [400, 0], [420, 0]]);
  for (const s of blist) { s.planAt = 0; s.decideAt = 0; }
  fs.writeFileSync(path.join(dir, 'students.json'), JSON.stringify(blist, null, 2));
  writeZones(dir);
  const w = createNpcWorld({
    dataDir: dir, broadcast: () => {}, getDayTime: () => 0.35,
    askStudent: async (input) => (input.kind === 'plan'
      ? { goalType: 'rest', goal: '去找玩家说说话', activity: '', plan: '', durationSec: 60, thought: '', seek: '玩家' }
      : { say: '', think: '', mem: '' }),
  });
  w.setPlayerPositions([{ id: 'u1', x: 18, z: 0 }]);
  await sleep(500);
  const st = w.stateOf('s1');
  const x0 = st ? st.x : 0;
  await sleep(800);
  const st2 = w.stateOf('s1');
  w.dispose();
  ok(st && st.intent && st.intent.seekPlayer === true, 'plan 的 seek="玩家" 落地成"去找玩家"', st && JSON.stringify(st.intent));
  ok(st2 && st2.x > x0 + 0.1, '真的朝玩家（x=18）那边走', 'x ' + x0 + ' → ' + (st2 && st2.x));
}

console.log('[18] 反向委托：NPC 主动开口请玩家买东西 → 交付 → 结算；交错东西被拒');
{
  const dir = freshDir('want');
  writeScene(dir);
  const blist = questStudents([[0, 0], [8, 0], [300, 0], [320, 0], [340, 0], [360, 0], [380, 0], [400, 0]]);
  for (const s of blist) { s.planAt = 1e15; s.decideAt = 1e15; s.st = 'idle'; }
  fs.writeFileSync(path.join(dir, 'students.json'), JSON.stringify(blist, null, 2));
  writeZones(dir);
  const says = [];
  const w = createNpcWorld({
    dataDir: dir,
    broadcast: (m) => { if (m.t === 'npc_say') says.push({ id: m.id, say: m.say }); },
    getDayTime: () => 0.35,
    askStudent: async () => ({ say: '', think: '', mem: '' }),
  });
  // 商品目录 = 真实在售（服务端 SHOP 注入的那份）
  w.setShopCatalog([
    { id: 'bk', name: '一摞书', price: 55, kind: 'building' },
    { id: 'tb', name: '玩具熊', price: 22, kind: 'building' },
  ]);
  w.setPlayerPositions([{ id: 'u1', x: 2, z: 0 }]); // 玩家就在 s1 跟前
  await sleep(400);
  const st = w.stateOf('s1');
  ok(st && st.want && st.want.itemName && st.want.reward > 0, 'NPC 主动开口要东西（只能从真实在售里挑）', st && JSON.stringify(st.want));
  ok(says.some((x) => /帮我买/.test(String(x.say))), '开口的话广播出来了（玩家看得见"要什么/多少钱"）', JSON.stringify(says));
  const v0 = st ? st.mood.valence : 0;
  const good = w.deliver('s1', st.want.itemName, '小明', 'p:u1');
  const after = w.stateOf('s1');
  ok(good.ok === true && good.reward > 0, '交付成功并给跑腿费（服务端算额度）', JSON.stringify(good));
  ok(after && after.want === null, '交付后委托清空', JSON.stringify(after && after.want));
  ok(after && after.mood.valence > v0, '收到东西心情变好', 'valence ' + v0 + ' → ' + (after && after.mood.valence));
  ok(after && after.rel['p:u1'] && after.rel['p:u1'].trust > 0, '对玩家的关系提升', JSON.stringify(after && after.rel));
  ok(after && after.mem.some((m) => /帮我买来了/.test(String(m.text))), '记了一条"他帮我买了…"', JSON.stringify(after && after.mem));
  const st2 = w.stateOf('s2');
  const bad = w.deliver('s2', '完全不相关的东西', '小明', 'p:u1');
  ok(st2 && st2.want && bad.ok === false, '**交错东西被拒绝**（服务端不信前端，只认它要的那件）', JSON.stringify(bad));
  w.dispose();
}

console.log('[19] 记忆检索：重要度 + 新近度 + 相关度 三者加权（斯坦福 retrieval）');
{
  const dir = freshDir('mem');
  writeScene(dir);
  const now = Date.now();
  const mk = (kind, text, minutesAgo, imp) => ({ t: now - minutesAgo * 60000, text, kind, imp });
  const list = questStudents([[0, 0], [8, 0], [16, 0], [24, 0], [32, 0], [40, 0], [48, 0], [56, 0]]);
  list[0].mem = [
    mk('obs', '我看见学生2号也在这一带', 0.2),                    // 最近，但最不重要
    mk('obs', '我看见学生3号也在这一带', 0.5),
    mk('obs', '我看见学生4号也在这一带', 1),
    mk('obs', '我看见学生5号也在这一带', 2),
    mk('obs', '我看见学生6号也在这一带', 3),
    mk('trade', '玩家帮我买来了「一摞书」，人挺靠谱', 30, 0.95),   // 30 分钟前，但极重要
    mk('chat', '我和学生7号聊到作业', 40, 0.55),
    mk('say', '老师说要交作业了', 50, 0.55),
  ];
  fs.writeFileSync(path.join(dir, 'students.json'), JSON.stringify(list, null, 2));
  writeZones(dir);
  const w = createNpcWorld({ dataDir: dir, broadcast: () => {}, getDayTime: () => 0.35, askStudent: async () => ({ say: '', think: '', mem: '' }) });
  await sleep(60);
  const picked = w.debugPickMemory('s1', '');
  const texts = (picked || []).map((x) => x.text);
  const impReflect = w.memImportance({ kind: 'reflect' });
  const impObs = w.memImportance({ kind: 'obs' });
  w.dispose();
  ok(picked && picked.length <= 4, '只挑 4 条（MEM_CTX），不是把整串塞过去', JSON.stringify(texts));
  ok(texts.some((t) => /一摞书/.test(t)), '**重要但较旧**的记忆仍被选上（重要度权重起作用）', JSON.stringify(texts));
  ok(texts.some((t) => /也在这一带/.test(t)), '最近的观察也占得上位置（新近度起作用）', JSON.stringify(texts));
  ok(impReflect > impObs, '重要度基线：反思 > 路过的观察', 'reflect=' + impReflect + ' obs=' + impObs);
}

console.log('[20] 反思：把经历想成"认识"（高重要度记忆），且会被限流');
{
  const dir = freshDir('reflect');
  writeScene(dir);
  const list = questStudents([[0, 0], [8, 0], [16, 0], [24, 0], [32, 0], [40, 0], [48, 0], [56, 0]]);
  for (let i = 0; i < 4; i++) list[0].mem.push({ t: Date.now() - i * 60000, text: '学生' + (i + 2) + '号今天又在图书馆待着', kind: 'chat' });
  fs.writeFileSync(path.join(dir, 'students.json'), JSON.stringify(list, null, 2));
  writeZones(dir);
  const kinds = [];
  const w = createNpcWorld({
    dataDir: dir, broadcast: () => {}, getDayTime: () => 0.35,
    askStudent: async (input) => {
      kinds.push(String(input.kind || ''));
      if (input.kind === 'reflect') return { insights: ['我最近好像老在图书馆，其实我更想找人打球'] };
      if (input.kind === 'dayplan') return { plan: '今天随便逛逛' };
      return { say: '', think: '', mem: '' };
    },
  });
  await sleep(60);
  const fired = w.debugReflect('s1'); // debugReflect 是"强制"钩子（会清限流），不能拿它测冷却
  await sleep(200);
  const st = w.stateOf('s1');
  const n1 = kinds.filter((k) => k === 'reflect').length;
  await sleep(700); // 冷却期内：自动路径不该再想
  const n2 = kinds.filter((k) => k === 'reflect').length;
  w.dispose();
  ok(fired === true, '攒够新记忆 → 触发一次反思', '');
  ok(n1 >= 1, '真的调了 reflect', 'kinds=' + kinds.join(','));
  ok(st && st.mem.some((m) => /我更想找人打球/.test(String(m.text))), '洞见写进记忆流（之后的 prompt 会带上它）', JSON.stringify(st && st.mem));
  ok(n2 === n1, '冷却期内**自动**路径不会再想一次（不刷 GLM）', 'reflect 次数 ' + n1 + ' → ' + n2);
}

console.log('[21] 日计划：每游戏日生成一次，并注入之后每次 plan 的 prompt');
{
  const dir = freshDir('dayplan');
  writeScene(dir);
  const blist = questStudents([[0, 0], [8, 0], [16, 0], [24, 0], [32, 0], [40, 0], [48, 0], [56, 0]]);
  for (const s of blist) { s.planAt = 0; s.decideAt = 0; }
  fs.writeFileSync(path.join(dir, 'students.json'), JSON.stringify(blist, null, 2));
  writeZones(dir);
  let planDayPlan = null;
  const w = createNpcWorld({
    dataDir: dir, broadcast: () => {}, getDayTime: () => 0.35,
    askStudent: async (input) => {
      if (input.kind === 'dayplan') return { plan: '今天想把那摞书看完，再去操场跑两圈' };
      if (input.kind === 'plan') { planDayPlan = input.student && input.student.dayPlan; return null; }
      return { say: '', think: '', mem: '' };
    },
  });
  await sleep(700); // 等日计划生成完
  const st = w.stateOf('s1');
  w.debugPlan('s1'); // 再规划一次：这次 prompt 里应该带上刚生成的日计划
  await sleep(250);
  w.dispose();
  ok(st && st.dayPlan && /书/.test(String(st.dayPlan.text)), '生成了"今日打算"', st && JSON.stringify(st.dayPlan));
  ok(String(planDayPlan || '') !== '', 'plan 的 prompt 里带上了【今天你本来打算】', 'dayPlan=' + planDayPlan);
}

console.log('[22] NPC 自己发公告：走到公告栏 → 让 AI 写一条贴出去 → 别的学生看到并照做');
{
  const dir = freshDir('post');
  writeScene(dir);
  writeZonesCustom(dir, [{ id: 'zp', name: '操场', type: 'playground', minX: 40, maxX: 60, minZ: -10, maxZ: 10 }]);
  const blist = questStudents([[300, 0], [320, 0], [340, 0], [360, 0], [380, 0], [400, 0], [420, 0], [440, 0]]);
  for (const s of blist) { s.planAt = 1e15; s.decideAt = 1e15; s.st = 'idle'; }
  fs.writeFileSync(path.join(dir, 'students.json'), JSON.stringify(blist, null, 2));
  const posted = [];
  let w = null;
  w = createNpcWorld({
    dataDir: dir, broadcast: () => {}, getDayTime: () => 0.35,
    askStudent: async (input) => (input.kind === 'post' ? { text: '下午四点半操场打球，想来的喊我' } : { say: '', think: '', mem: '' }),
    // 替身 index.js 的 pushBoard：落盘 + 广播 + **喂回本世界**（其他学生看到并照做）
    onPost: (text, from) => { posted.push({ text, from }); if (w) w.setBoard([text]); },
  });
  await sleep(60);
  ok(w.debugPost('s1', '下午四点半操场打球') === true, '（模拟 plan 里 AI 说"这事要通知全校"）它决定去公告栏贴', '');
  await sleep(400);
  ok(posted.length === 1 && posted[0].from === '学生1号', 'AI 写完定稿并**真的贴出去**（走了 onPost）', JSON.stringify(posted));
  ok(/操场/.test(String(posted[0] && posted[0].text)), '贴的内容是它本来想说的那件事', JSON.stringify(posted));
  const st = w.stateOf('s1');
  ok(st && st.postPending === false, '贴完清掉"要去贴"的状态', String(st && st.postPending));
  ok(st && st.mem.some((m) => /贴了通知/.test(String(m.text))), '它自己记住了"我在公告栏贴了通知"', JSON.stringify(st && st.mem));
  // 闭环：公告回到本世界 → 学生陆续看到 → 照做（往操场走）。
  // ⚠ 广播是**轮流**下发的（announceIdx 从 0 开始）⇒ 第一个"听到"的就是 s1 本人，别把它排除掉。
  let obey = 0;
  for (const sid of ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']) {
    const x = w.stateOf(sid);
    if (x && x.intent && x.intent.goalType === 'playground') obey++;
  }
  w.dispose();
  ok(obey >= 1, '**公告真的起作用**：别的学生把它当通知照做（往操场走）', 'obey=' + obey);
}

console.log('[24] 不再站着发呆：到地方后的停留封顶 + 一结束就立刻重新决策');
{
  const dir = freshDir('nostand');
  writeScene(dir);
  writeZonesCustom(dir, [{ id: 'zc', name: '饭堂', type: 'canteen', minX: 29, maxX: 31, minZ: -1, maxZ: 1 }]);
  const blist = questStudents([[30, 0], [300, 0], [320, 0], [340, 0], [360, 0], [380, 0], [400, 0], [420, 0]]);
  for (const s of blist) { s.planAt = 0; s.decideAt = 0; }
  fs.writeFileSync(path.join(dir, 'students.json'), JSON.stringify(blist, null, 2));
  const w = createNpcWorld({
    dataDir: dir, broadcast: () => {}, getDayTime: () => 0.35,
    // plan 故意要"在饭堂待 300 秒"（最大值）—— 到地方后**不许真站 300 秒**
    askStudent: async (input) => (input.kind === 'plan'
      ? { goalType: 'canteen', goal: '去饭堂吃饭', activity: '吃饭', plan: '', durationSec: 300, thought: '' }
      : { say: '', think: '', mem: '' }),
  });
  await sleep(500);
  const st = w.stateOf('s1');
  const now = Date.now();
  const remainS = st ? Math.round((st.stayUntil - now) / 1000) : -1;
  w.dispose();
  ok(st && st.st === 'act', '到饭堂开始"做活动"（不是一直走/一直站）', st && st.st);
  ok(remainS >= 0 && remainS <= 47, '停留**封顶 45s**（不是按 plan 的 300s 干站）', '剩余 ' + remainS + 's');
  // ⚠ 早先这条断言挂在 planAt 上 —— 那等于"活动一结束就让 LLM 重新规划"，会把调用量从 2 分钟
  //   一次拉到 45 秒一次。正确做法是：**规则大脑**立刻接手，LLM 规划保持自己的节奏。
  ok(st && st.decideAt <= st.stayUntil + 100, '歇够就让规则大脑立刻接手（不再干站着）', 'stayUntil-decideAt=' + (st && (st.stayUntil - st.decideAt)));
  ok(st && st.planAt > st.stayUntil + 1000, 'LLM 规划仍保持 2 分钟节奏（没被拖到 45 秒一次）', 'planAt-stayUntil=' + (st && Math.round((st.planAt - st.stayUntil) / 1000)) + 's');
}

console.log('[25] 多轮上下文：第二句接得上第一句 + 心里话进 prompt');
{
  const dir = freshDir('chatlog');
  writeScene(dir);
  fs.writeFileSync(path.join(dir, 'students.json'), JSON.stringify(questStudents([]), null, 2));
  writeZones(dir);
  const seen = [];
  const w = createNpcWorld({
    dataDir: dir, broadcast: () => {}, getDayTime: () => 0.35,
    askStudent: async (input) => {
      if (input.kind === 'talk') {
        seen.push(input);
        return { say: '语文两页，数学还有一套卷子。', think: '他又在追问作业的事。', mem: '' };
      }
      return null; // 其它 kind 一律不响应（避免噪音）
    },
  });
  w.setPlayerPositions([]);
  await sleep(60);
  await w.talk('s1', '老师今天留了什么作业？', '小明', null, 'p:u1');
  await sleep(90);
  await w.talk('s1', '你刚才说的是哪一科来着？', '小明', null, 'p:u1');
  await sleep(90);
  const second = seen[1];
  w.dispose();
  ok(seen.length >= 2, '两次搭话都调了 AI', 'n=' + seen.length);
  ok(!!(second && Array.isArray(second.chat) && second.chat.length >= 2),
    '第二轮带上了【刚才你和玩家的对话】历史（多轮上下文）', second && JSON.stringify(second.chat));
  const hist = ((second && second.chat) || []).map((m) => String((m && m.text) || '')).join('|');
  ok(/作业/.test(hist), '历史里有第一轮**玩家**说的话（接得上"刚才那事"）', hist);
  ok(/语文两页/.test(hist), '历史里有第一轮**AI 自己**的回答（不是只记玩家的话）', hist);
  const th = ((second && second.thinks) || []).map((x) => String(x)).join('|');
  ok(/追问作业/.test(th), '【你最近心里在想】带上了上一轮的内心活动（内心有连续性）', th);
}

console.log('[26] 广播/公告 → 产生心理活动（think 入库）+ 记下"最近听到的通知"');
{
  const dir = freshDir('notice');
  writeScene(dir);
  writeZonesCustom(dir, [{ id: 'zp', name: '操场', type: 'playground', minX: 40, maxX: 60, minZ: -10, maxZ: 10 }]);
  const blist = questStudents([[300, 0], [320, 0], [340, 0], [360, 0], [380, 0], [400, 0], [420, 0], [440, 0]]);
  for (const s of blist) { s.planAt = 1e15; s.decideAt = 1e15; s.st = 'idle'; s.aiAt = 0; }
  fs.writeFileSync(path.join(dir, 'students.json'), JSON.stringify(blist, null, 2));
  const notices = [];
  const w = createNpcWorld({
    dataDir: dir, broadcast: () => {}, getDayTime: () => 0.35,
    askStudent: async (input) => {
      if (input.kind === 'notice') {
        notices.push(input);
        return { say: '', think: '操场好像有比赛，我有点想去看看。', mem: '' };
      }
      return null;
    },
  });
  w.setPlayerPositions([]);
  await sleep(60);
  w.announce('注意，操场集合，下午四点有篮球赛');
  await sleep(4700); // ANNOUNCE_GAP_MS=4000：至少一个学生"听到"并产生心理活动
  let withThink = 0, withHeard = 0;
  for (const sid of ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']) {
    const st = w.stateOf(sid);
    if (!st) continue;
    if ((st.think || []).some((x) => /操场|比赛/.test(String(x.text)))) withThink++;
    if (st.heard && /操场/.test(String(st.heard.text || ''))) withHeard++;
  }
  const n0 = notices[0];
  w.dispose();
  ok(notices.length >= 1, '听到广播的学生调了一次 AI（kind=notice）——"调用 AI 的事都要有心理活动"', 'n=' + notices.length);
  ok(withThink >= 1, '广播产生了**心理活动**并入库（think 流）', 'think=' + withThink);
  ok(withHeard >= 1, '记下"最近听到的通知"（下一步 prompt 会带上）', 'heard=' + withHeard);
  ok(!!(n0 && String((n0.student && n0.student.heard) || '') !== ''),
    'prompt 里带了【最近的全校广播/公告】', n0 && JSON.stringify(n0.student && n0.student.heard));
}

console.log('[27] 场景识别：附近地标 / 附近的人 / 学校有哪些地方 → 进 prompt 的【你周围的场景】');
{
  const dir = freshDir('scene');
  writeScene(dir);
  // s1 站在"第一食堂"里；操场/图书馆都在 45m 内 ⇒ 应该被算成"你附近的地标"
  writeZonesCustom(dir, [
    { id: 'zc', name: '第一食堂', type: 'canteen', minX: 40, maxX: 60, minZ: 40, maxZ: 60 },
    { id: 'zg', name: '大操场', type: 'playground', minX: 62, maxX: 72, minZ: 45, maxZ: 55 },
    { id: 'zl', name: '图书馆', type: 'library', minX: 74, maxX: 84, minZ: 45, maxZ: 55 },
  ]);
  const list = questStudents([[50, 50], [200, 0], [220, 0], [240, 0], [260, 0], [280, 0], [300, 0], [320, 0]]);
  for (const s of list) { s.planAt = 1e15; s.decideAt = 1e15; s.chatAt = 1e15; }
  list[0].planAt = 0; // 只让 s1 立刻规划一次（拿它的 prompt 来断言）
  fs.writeFileSync(path.join(dir, 'students.json'), JSON.stringify(list, null, 2));
  const plans = [];
  const w = createNpcWorld({
    dataDir: dir, broadcast: () => {}, getDayTime: () => 0.35,
    askStudent: async (input) => { if (input.kind === 'plan') plans.push(input.student); return null; },
  });
  w.setPlayerPositions([{ id: 'u1', x: 52, z: 50 }]); // 玩家 2m 外 ⇒ 应出现在"你身边有人"
  await sleep(200);
  const sc = w.debugScene('s1');
  w.dispose();
  const lm = ((sc && sc.landmarks) || []).map((x) => x.name).join(' | ');
  ok(!!sc && sc.place.indexOf('食堂') >= 0, '知道自己在"第一食堂"里', sc && sc.place);
  ok(/大操场/.test(lm) && /图书馆/.test(lm), '算出了附近的地标（操场/图书馆）', lm);
  ok(!!(sc && sc.people.some((p) => p.name === '玩家')), '算出"玩家就在我旁边"', JSON.stringify((sc && sc.people) || []));
  ok(!!(sc && /还没去过/.test(String(sc.places))), '"学校有哪些地方 + 哪些没去过"给了它', String(sc && sc.places).slice(0, 80));
  const p0 = plans[0];
  ok(!!(p0 && String(p0.scene || '').length), 'plan 的 prompt 带上了【你周围的场景】', p0 && String(p0.scene).slice(0, 60));
  ok(!!(p0 && /还没去过/.test(String(p0.places || ''))), 'plan 的 prompt 带上了【学校有哪些地方】', p0 && String(p0.places).slice(0, 60));
}

console.log('[28] 观察打断计划：玩家走近 → 写进记忆 + 决策点被拉到当下');
{
  const dir = freshDir('observe');
  writeScene(dir);
  writeZonesCustom(dir, [{ id: 'zg', name: '大操场', type: 'playground', minX: -20, maxX: 20, minZ: -20, maxZ: 20 }]);
  const list = questStudents([[0, 0], [200, 0], [220, 0], [240, 0], [260, 0], [280, 0], [300, 0], [320, 0]]);
  const far = Date.now() + 3600e3;
  for (const s of list) { s.planAt = 1e15; s.decideAt = far; s.chatAt = 1e15; }
  fs.writeFileSync(path.join(dir, 'students.json'), JSON.stringify(list, null, 2));
  const w = createNpcWorld({ dataDir: dir, broadcast: () => {}, getDayTime: () => 0.35, askStudent: async () => null });
  w.setPlayerPositions([{ id: 'u1', x: 3, z: 0 }]); // 玩家 3m 内 ⇒ 高重要度观察
  await sleep(60);
  const before = w.stateOf('s1').decideAt;
  w.debugObserve('s1');
  const st = w.stateOf('s1');
  w.dispose();
  ok(st.noticed && /玩家/.test(st.noticed), '【你刚刚注意到】记下了"看见玩家"', st.noticed);
  ok((st.mem || []).some((m) => /玩家/.test(String(m.text))), '观察真的进了记忆流（会被检索、喂进 prompt）', JSON.stringify((st.mem || []).map((m) => m.text)));
  ok(st.decideAt <= Date.now(), '★★ 高重要度观察把决策点拉到当下（缺口 A：看到才会改主意，而不是等计划做完）', 'before=' + before + ' after=' + st.decideAt);
}

console.log('[29] 看看学校：挑一个没去过的区域走过去看 → 到了写观察 + 记下"去过"');
{
  const dir = freshDir('explore');
  writeScene(dir);
  writeZonesCustom(dir, [
    { id: 'zg', name: '大操场', type: 'playground', minX: 4, maxX: 8, minZ: -2, maxZ: 2 },
    { id: 'zl', name: '图书馆', type: 'library', minX: 60, maxX: 70, minZ: -5, maxZ: 5 },
  ]);
  const list = questStudents([[0, 0], [200, 0], [220, 0], [240, 0], [260, 0], [280, 0], [300, 0], [320, 0]]);
  for (const s of list) { s.planAt = 1e15; s.decideAt = 1e15; s.chatAt = 1e15; }
  // ⚠ 让它只有一个"没去过"的地方可挑（图书馆标成已去过）——否则 exploreTarget 会随机挑，
  //   挑到 65m 外的图书馆时 9 秒内走不到，用例就抖了。
  list[0].seenZones = ['zl'];
  fs.writeFileSync(path.join(dir, 'students.json'), JSON.stringify(list, null, 2));
  const w = createNpcWorld({ dataDir: dir, broadcast: () => {}, getDayTime: () => 0.35, askStudent: async () => null });
  await sleep(60);
  w.debugExplore('s1');
  const mid = w.stateOf('s1');
  ok(!!(mid.intent && mid.intent.goalType === 'explore'), '选了 explore（去看看学校某处）', JSON.stringify(mid.intent));
  ok(mid.st === 'walk', '真的动身了（不是嘴上说说）', mid.st);
  ok(/大操场/.test(String((mid.intent || {}).goalText || '')), '优先挑**没去过**的地方（图书馆已去过 → 挑了操场）', (mid.intent || {}).goalText);
  await sleep(9000);
  const st = w.stateOf('s1');
  w.dispose();
  ok((st.mem || []).some((m) => /我特意到/.test(String(m.text))), '到达后写下"我特意到…转了一圈"的观察', JSON.stringify((st.mem || []).map((m) => m.text)));
  ok(Array.isArray(st.seenZones) && st.seenZones.length >= 1, '记下了"去过哪些地方"（下次优先去没去过的）', JSON.stringify(st.seenZones));
  ok((st.think || []).some((x) => /看看/.test(String(x.text))), '还留下一条内心活动', JSON.stringify((st.think || []).map((x) => x.text)));
}

console.log('[30] 四处问人：走到同学跟前打听 → 问句/回答都播出来 + 双方记忆带来源');
{
  const dir = freshDir('inquire');
  writeScene(dir);
  writeZones(dir);
  const list = questStudents([[0, 0], [2.2, 0], [300, 0], [320, 0], [340, 0], [360, 0], [380, 0], [400, 0]]);
  for (const s of list) { s.planAt = 1e15; s.decideAt = 1e15; s.chatAt = 1e15; }
  fs.writeFileSync(path.join(dir, 'students.json'), JSON.stringify(list, null, 2));
  const seen = [];
  const says = [];
  const w = createNpcWorld({
    dataDir: dir, getDayTime: () => 0.35,
    broadcast: (m) => { if (m.t === 'npc_say') says.push(m); },
    askStudent: async (input) => {
      if (input.kind === 'inquire') {
        seen.push(input);
        return { question: '周三是不是有测验？', answer: '嗯，周三上午数学。', think: '记住了，周三得复习。', mem: '顾星桥说周三有测验' };
      }
      return null;
    },
  });
  await sleep(60);
  w.debugInquire('s1', 's2');
  await sleep(1000);
  const a = w.stateOf('s1'), b = w.stateOf('s2');
  w.dispose();
  const inp = seen[0];
  ok(!!inp, '走到跟前就调了一次 AI（kind=inquire）——"四处问人"真会发生', 'n=' + seen.length);
  ok(!!(inp && String((inp.student && inp.student.scene) || '').length), '问人时也带上了场景识别', inp && String((inp.student && inp.student.scene) || '').slice(0, 40));
  ok(!!(inp && inp.other && inp.other.name === '学生2号'), 'prompt 里明确了"要问的人是谁"', inp && JSON.stringify(inp.other));
  ok(says.some((x) => /周三是不是有测验/.test(String(x.say))) && says.some((x) => /周三上午数学/.test(String(x.say))),
    '问句与回答都播了出来（附近玩家能偷听）', JSON.stringify(says));
  ok(!!a && (a.mem || []).some((m) => /学生2号/.test(String(m.text)) && m.src === '学生2号'),
    '问的人记住了"我问了谁什么"，并标了来源（缺口 D）', a && JSON.stringify(a.mem));
  ok(!!b && (b.mem || []).some((m) => /学生1号/.test(String(m.text)) && m.src === '学生1号'),
    '被问的人也留了记忆（含来源标注）', b && JSON.stringify(b.mem));
}

console.log('[31] 玩家说"你去看看学校/四处问问" → 它真的改道去做（applyTalkEffect 收这两个动作）');
{
  const dir = freshDir('talkgoal');
  writeScene(dir);
  writeZones(dir);
  const list = questStudents([[0, 0], [300, 0], [320, 0], [340, 0], [360, 0], [380, 0], [400, 0], [420, 0]]);
  for (const s of list) { s.planAt = 1e15; s.decideAt = 1e15; s.chatAt = 1e15; }
  fs.writeFileSync(path.join(dir, 'students.json'), JSON.stringify(list, null, 2));
  let n = 0;
  const w = createNpcWorld({
    dataDir: dir, broadcast: () => {}, getDayTime: () => 0.35,
    askStudent: async (input) => {
      if (input.kind !== 'talk') return null;
      n++;
      return n === 1 ? { say: '好，我去转转。', goalType: 'explore', mem: '四处看看' } : { say: '行，我去打听打听。', goalType: '打听', mem: '问问同学' };
    },
  });
  await sleep(60);
  await w.talk('s1', '你去看看学校吧', '小明', null, 'p:u1');
  const g1 = w.stateOf('s1').intent && w.stateOf('s1').intent.goalType;
  await w.talk('s1', '再去四处问问同学', '小明', null, 'p:u1');
  const g2 = w.stateOf('s1').intent && w.stateOf('s1').intent.goalType;
  w.dispose();
  ok(g1 === 'explore', '说"去看看学校" → 意图变成 explore（真的改道）', g1);
  ok(g2 === 'inquire', '说"四处问问同学" → 意图变成 inquire', g2);
}

console.log('[32] 公告可剔除：按 id 精确删 + 删完重新喂给 AI（静态断言 index.js）');
{
  const src = fs.readFileSync(new URL('../server-remote/index.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  ok(/function newBoardId\(\)/.test(src), '公告有稳定 id 生成器', '');
  ok(/id: newBoardId\(\)/.test(src), 'pushBoard 给每条公告写 id', '');
  ok(/function removeBoardPost\(id, by\)/.test(src), '有 removeBoardPost（按 id 精确删，不误伤同内容的另一条）', '');
  ok(/req\.method === 'DELETE' && url\.pathname === '\/api\/board'/.test(src), '有 DELETE /api/board 路由', '');
  ok(/for \(const p of list\) if \(p && !p\.id\)/.test(src), '老存档缺 id 会自动补齐（前端撤回按钮才可用）', '');
  const i = src.indexOf('function removeBoardPost');
  const body = src.slice(i, i + 900);
  ok(/setBoard/.test(body), '★★ 删完把最新公告重新喂给 AI ⇒ 删了它就不再照做', '');
  ok(/broadcastAll/.test(body), '删完广播刷新所有客户端的公告栏', '');
}

console.log(fails ? '\n✗ ' + fails + ' 条断言失败' : '\n✓ 全部通过');
process.exit(fails ? 1 : 0);
