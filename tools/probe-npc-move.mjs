// 守卫探针：学生 NPC 的**行为**（在 Node 里真跑 server-remote/npcworld.js，不是静态断言）。
// 守的是这几条静默失效：
//   ① 障碍表恒为空 ⇒ 穿墙（老代码读 scene.items / it.rec / w·d·size，三个字段全不存在）
//   ② walk 状态没有超时 ⇒ 目标不可达时永久卡住、人再也不动
//   ③ 没标功能区就整段 return ⇒ 连广播都不发，客户端看到"人都定住了"
//   ④ rot 少了负号 ⇒ 背朝前走（看起来像不会转身）
//   ⑤ place 用"目标区域"而不是"当前坐标所在区域" ⇒ 在教室说自己在图书馆
// 临时数据一律写到项目根之外（E:/_fpm_probe_npc），别在项目里留 tmp/。
import fs from 'node:fs';
import path from 'node:path';
import { createNpcWorld } from '../server-remote/npcworld.js';

const TMP = 'E:/_fpm_probe_npc';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
function ok(cond, name, extra) {
  if (cond) console.log('  ok   ' + name);
  else { console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); fails++; }
}

// ⚠ 日志捕获：这类 bug 的征兆是"零报错但功能没了"（常量打错 ⇒ ReferenceError 被 catch 吞 ⇒ 障碍表恒空）。
//   node --check 抓不到未声明标识符，只能靠"降级日志有没有出现"来守。
const logs = [];
const origWarn = console.warn;
const origInfo = console.info;
function startCapture() {
  logs.length = 0;
  console.warn = (...a) => logs.push(a.join(' '));
  console.info = (...a) => logs.push(a.join(' '));
}
function endCapture() {
  console.warn = origWarn;
  console.info = origInfo;
  return logs.slice();
}

function freshDir(name) {
  const d = path.join(TMP, name);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// 一栋 20×10 的教学楼，摆在原点（不旋转）
function writeScene(dir) {
  fs.writeFileSync(path.join(dir, 'editor-scene.json'), JSON.stringify({
    boundary: {},
    scenery: [],
    placed: [{ id: 'b1', kind: 'building', name: '教学楼', x: 0, y: 0, z: 0, rotY: 0, scale: { x: 1, y: 1, z: 1 }, fw: 20, fd: 10 }],
    lights: [],
  }));
}
// 8 名学生，全部站在教室区域里（50,50）
function writeStudents(dir, x, z) {
  const list = [];
  for (let i = 0; i < 8; i++) {
    list.push({
      id: 's' + (i + 1), name: '学生' + (i + 1), sex: i % 2 ? 'f' : 'm', cls: '高二(1)班', persona: '普通学生',
      x: x + i * 0.4, z: z + i * 0.4, hx: x, hz: z, tx: x, tz: z,
      rot: 0, st: 'idle', zoneId: '', stayUntil: 0, decideAt: 0, aiAt: 0, walkUntil: 0, stuck: 0,
      needs: { hunger: 0.4, fatigue: 0.3, fun: 0.4, study: 0.5, social: 0.3, bladder: 0.2 },
      mem: [], think: [],
    });
  }
  fs.writeFileSync(path.join(dir, 'students.json'), JSON.stringify(list, null, 2));
}
// OBB 判定（与 npcworld 同款数学，输入是同一份 placed 数据）
function inBuilding(x, z) {
  return Math.abs(x - 0) < 20 / 2 + 0.7 && Math.abs(z - 0) < 10 / 2 + 0.7;
}

console.log('[1] 没有标注功能区：学生也要在走（自由漫步降级）');
{
  const dir = freshDir('nozones');
  writeScene(dir);
  const frames = [];
  const w = createNpcWorld({
    dataDir: dir,
    broadcast: (m) => { if (m.t === 'npc') frames.push(m.list.map((s) => ({ id: s.id, x: s.x, z: s.z, rot: s.rot }))); },
    getDayTime: () => 0.35,
  });
  await sleep(2600);
  w.dispose();
  ok(frames.length > 5, '广播持续在发（不再 return 掉）', '帧数=' + frames.length);
  const first = frames[0] || [];
  const last = frames[frames.length - 1] || [];
  let moved = 0;
  for (let i = 0; i < first.length; i++) {
    if (Math.hypot(last[i].x - first[i].x, last[i].z - first[i].z) > 0.3) moved++;
  }
  ok(moved >= 6, '至少 6/8 人在 2.6 秒里有位移', '实际 ' + moved + '/8');
}

console.log('[2] 绕障：障碍表真的建起来了，而且不穿墙');
{
  const dir = freshDir('walls');
  // 一栋 8×6 的楼压在原点：学生从东侧(6,0)去西侧(-25,0)，直线必然穿楼
  fs.writeFileSync(path.join(dir, 'editor-scene.json'), JSON.stringify({
    scenery: [],
    placed: [{ id: 'b1', kind: 'building', name: '小楼', x: 0, y: 0, z: 0, rotY: 0, scale: { x: 1, y: 1, z: 1 }, fw: 8, fd: 6 }],
  }));
  writeStudents(dir, 6, 0);
  fs.writeFileSync(path.join(dir, 'zones.json'), JSON.stringify([
    { id: 'z1', name: '西楼', type: 'classroom', minX: -30, maxX: -20, minZ: -5, maxZ: 5 },
  ]));
  const inB = (x, z) => Math.abs(x) < 8 / 2 + 0.7 && Math.abs(z) < 6 / 2 + 0.7;
  let insideHits = 0;
  let samples = 0;
  const bad = [];
  startCapture();
  const w = createNpcWorld({
    dataDir: dir,
    broadcast: (m) => {
      if (m.t !== 'npc') return;
      for (const s of m.list) { samples++; if (inB(s.x, s.z)) { insideHits++; if (bad.length < 5) bad.push(s.id + '@' + s.x.toFixed(2) + ',' + s.z.toFixed(2) + '(' + s.st + ')'); } }
    },
    getDayTime: () => 0.35,
  });
  await sleep(5000);
  w.dispose();
  const lg = endCapture();
  ok(!lg.some((l) => /读不到 editor-scene|障碍表为空/.test(l)),
    '没有报"障碍表为空"（常量打错/字段读错会静默退化成不绕障）', lg.join(' | '));
  ok(lg.some((l) => /带真实占地/.test(l)), '识别到 fw/fd 真实占地', lg.join(' | '));
  ok(samples > 40, '采到足够样本', '样本=' + samples);
  ok(insideHits === 0, '没有任何一帧落在楼内部（不穿墙）', '违规 ' + insideHits + '/' + samples + (bad.length ? ' 例：' + bad.join(' ') : ''));
}

console.log('[2b] 出生点恰好压在楼里：要能走出来（脱困）');
{
  const dir = freshDir('trapped');
  fs.writeFileSync(path.join(dir, 'editor-scene.json'), JSON.stringify({
    scenery: [],
    placed: [{ id: 'b1', kind: 'building', name: '大堂', x: 0, y: 0, z: 0, rotY: 0, scale: { x: 1, y: 1, z: 1 }, fw: 6, fd: 6 }],
  }));
  writeStudents(dir, 0, 0); // 正中心：五个绕行方向全被挡，没有脱困就永远出不来
  fs.writeFileSync(path.join(dir, 'zones.json'), JSON.stringify([
    { id: 'z1', name: '操场', type: 'playground', minX: 40, maxX: 60, minZ: -5, maxZ: 5 },
  ]));
  const inB = (x, z) => Math.abs(x) < 6 / 2 + 0.7 && Math.abs(z) < 6 / 2 + 0.7;
  let escaped = 0;
  let last = [];
  const w = createNpcWorld({
    dataDir: dir,
    broadcast: (m) => { if (m.t === 'npc') last = m.list.map((s) => ({ x: s.x, z: s.z })); },
    getDayTime: () => 0.35,
  });
  await sleep(4200);
  w.dispose();
  for (const s of last) if (!inB(s.x, s.z)) escaped++;
  ok(last.length === 8, '拿到 8 人的最终位置');
  ok(escaped >= 6, '至少 6/8 人走出了楼体（没有困死在里面）', '实际 ' + escaped + '/8');
}

console.log('[3] 朝向：rot 必须与移动方向一致（不是背朝前）');
{
  const dir = freshDir('yaw');
  writeScene(dir);
  writeStudents(dir, 60, 60);
  const frames = [];
  const w = createNpcWorld({
    dataDir: dir,
    broadcast: (m) => { if (m.t === 'npc') frames.push(m.list.map((s) => ({ x: s.x, z: s.z, rot: s.rot }))); },
    getDayTime: () => 0.35,
  });
  await sleep(2600);
  w.dispose();
  // 约定（与 Game.js 的 fwd=(-sin yaw,·,-cos yaw) 同款）：yaw = atan2(-dx, -dz)
  let checked = 0;
  let good = 0;
  for (let f = 1; f < frames.length; f++) {
    for (let i = 0; i < frames[f].length; i++) {
      const a = frames[f - 1][i];
      const b = frames[f][i];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      if (Math.hypot(dx, dz) < 0.05) continue; // 没动就不谈朝向
      const want = (Math.atan2(-dx, -dz) * 180) / Math.PI;
      let d = Math.abs(((b.rot - want + 540) % 360) - 180);
      checked++;
      if (d < 60) good++; // 绕障会偏一点，60° 内算对（背朝前的话会是 ~180°）
    }
  }
  ok(checked > 20, '采到足够的移动样本', '样本=' + checked);
  ok(good / Math.max(1, checked) > 0.9, '朝向与移动方向一致的比例 > 90%', good + '/' + checked);
}

console.log('[4] 知道自己在哪：place 按**当前坐标**判定，不是按"打算去哪"');
{
  const dir = freshDir('place');
  writeScene(dir);
  writeStudents(dir, 50, 50); // 全部站在教室区域里
  fs.writeFileSync(path.join(dir, 'zones.json'), JSON.stringify([
    { id: 'za', name: '第一教学楼', type: 'classroom', minX: 40, maxX: 60, minZ: 40, maxZ: 60 },
    { id: 'zb', name: '市图书馆', type: 'library', minX: -80, maxX: -60, minZ: -80, maxZ: -60 },
  ]));
  const seen = [];
  const w = createNpcWorld({
    dataDir: dir,
    broadcast: () => {},
    getDayTime: () => 0.35,
    askStudent: async (input) => {
      seen.push(String(input.student && input.student.place || ''));
      return { say: '嗯。', think: '', mem: '' };
    },
  });
  await sleep(300);
  const out = await w.talk('s1', '你在哪？', '同学');
  w.dispose();
  ok(seen.length > 0, '搭话确实走到了 AI 调用', '次数=' + seen.length);
  ok(/第一教学楼/.test(seen[0]), '站在教学楼里就说教学楼（不是图书馆）', '实际="' + seen[0] + '"');
  ok(!/图书馆/.test(seen[0]), '不会把教学楼说成图书馆');
  ok(!!out && !!out.say, 'talk 返回了 say');
}

console.log('[5] 心理活动不外泄：talk 的广播里不带 think');
{
  const dir = freshDir('think');
  writeScene(dir);
  writeStudents(dir, 50, 50);
  const msgs = [];
  const w = createNpcWorld({
    dataDir: dir,
    broadcast: (m) => msgs.push(m),
    getDayTime: () => 0.35,
    askStudent: async () => ({ say: '我在看书。', think: '其实我根本没在看。', mem: '' }),
  });
  const fake = { readyState: 1 };
  await w.talk('s2', '干嘛呢', '同学', fake);
  w.dispose();
  const say = msgs.find((m) => m.t === 'npc_say');
  ok(!!say, '广播了 npc_say（旁人能看见）');
  ok(say && say.think === undefined, '广播里没有 think（心理活动是内部的）');
  ok(say && say.say === '我在看书。', '广播只带 say');
}

console.log('[6] 目标不可达也不能卡死：walk 有超时');
{
  const dir = freshDir('stuck');
  writeScene(dir);
  writeStudents(dir, 50, 50);
  // 目标区域被整栋楼压住：落点怎么采都在墙里 ⇒ 必然走不到，靠超时重决策
  fs.writeFileSync(path.join(dir, 'zones.json'), JSON.stringify([
    { id: 'zc', name: '被楼压住的区域', type: 'classroom', minX: -5, maxX: 5, minZ: -2, maxZ: 2 },
  ]));
  const frames = [];
  const w = createNpcWorld({
    dataDir: dir,
    broadcast: (m) => { if (m.t === 'npc') frames.push(m.list.map((s) => ({ x: s.x, z: s.z }))); },
    getDayTime: () => 0.35,
  });
  await sleep(2600);
  w.dispose();
  const first = frames[0] || [];
  const last = frames[frames.length - 1] || [];
  let moved = 0;
  for (let i = 0; i < first.length; i++) {
    if (Math.hypot(last[i].x - first[i].x, last[i].z - first[i].z) > 0.3) moved++;
  }
  ok(moved >= 6, '目标不可达时人仍在动（靠 wander/超时兜底，不会永久卡在 walk）', '实际 ' + moved + '/8');
}

console.log('[7] 只给"被搭话那一个"的记忆，而且不是整串');
{
  const dir = freshDir('mem');
  writeScene(dir);
  const list = [];
  for (let i = 0; i < 8; i++) {
    list.push({
      id: 's' + (i + 1), name: '学生' + (i + 1), sex: 'm', cls: '高二(1)班', persona: '普通学生',
      x: 50, z: 50, hx: 50, hz: 50, tx: 50, tz: 50,
      rot: 0, st: 'idle', zoneId: '', stayUntil: 0, decideAt: 0, aiAt: 0, walkUntil: 0, stuck: 0,
      needs: { hunger: 0.4, fatigue: 0.3, fun: 0.4, study: 0.5, social: 0.3, bladder: 0.2 },
      // 每人 8 条独一无二的记忆：混进任何一条别人的，这里都能抓到
      mem: Array.from({ length: 8 }, (_, k) => ({ t: k, text: 'S' + (i + 1) + '-记忆' + k })),
      think: [],
    });
  }
  fs.writeFileSync(path.join(dir, 'students.json'), JSON.stringify(list, null, 2));
  fs.writeFileSync(path.join(dir, 'zones.json'), JSON.stringify([
    { id: 'za', name: '第一教学楼', type: 'classroom', minX: 40, maxX: 60, minZ: 40, maxZ: 60 },
  ]));
  const seen = [];
  const w = createNpcWorld({
    dataDir: dir,
    broadcast: () => {},
    getDayTime: () => 0.35,
    askStudent: async (input) => {
      seen.push((input.memory || []).map((m) => String(m.text || '')));
      return { say: '记得一点。', think: '', mem: '' };
    },
  });
  await sleep(200);
  await w.talk('s3', '你还记得什么？', '同学');
  w.dispose();
  const got = seen[0] || [];
  ok(got.length > 0 && got.length <= 4, '只挑了少数几条（≤4），不是把整串记忆都塞过去', '条数=' + got.length);
  ok(got.length > 0 && got.every((t) => /^S3-/.test(t)), '全是 s3 自己的记忆，没有别人的（不串台）', got.join(' | '));
}

console.log(fails ? '\n✗ ' + fails + ' 条断言失败' : '\n✓ 全部通过');
process.exit(fails ? 1 : 0);
