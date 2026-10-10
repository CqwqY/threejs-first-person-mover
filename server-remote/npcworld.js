// 职责：学生 NPC 的「世界」（服务端权威）。
// 1. 功能区标注 zones.json：编辑器画矩形并标类型，NPC 靠它决定去哪（饭堂/教室/操场…）；
// 2. 角色档案 students.json：8 名学生的姓名/班级/人设/需求/记忆/心理活动；
// 3. 行为模拟：需求驱动的效用调度（不是真神经网络 —— 可解释、可调参、零推理成本），
//    叠加一张按世界时刻走的课程表，看起来像"他自己决定去哪干什么"；
// 4. 行走：朝目标区推进，遇建筑 AABB 就绕（读 editor-scene.json 里的建筑占地）；
// 5. 广播：5Hz 把 {id,x,z,rot,st} 发给所有客户端，客户端插值 + 走/停动画；
// 6. AI 触发：玩家搭话必触发；到达目的地 / 需求触底 等事件节流触发，产出 say/think/mem 入库。
//
// ⚠ 两条硬约束（写死在这里，别在别处另写一套）：
//   - 记忆/独白的长度：入库前一律 clampText，超长直接截断；记忆条数超过上限先让 AI 压缩、失败再丢弃最老的。
//   - 单位：坐标是米、角度是**度**（rotY 与建筑那套一致，见 src/world/BuildingTool.js 的 normalizeDeg）。
import fs from 'node:fs';
import path from 'node:path';

// 功能区类型：NPC 的行为目的地的语义来源。color 只给编辑器可视化用。
export const ZONE_TYPES = [
  { id: 'classroom', label: '教室', color: 0x4aa3ff, needs: { study: 1 } },
  { id: 'canteen', label: '饭堂', color: 0xffb347, needs: { hunger: 1 } },
  { id: 'playground', label: '操场', color: 0x5ed46a, needs: { fun: 1 } },
  { id: 'library', label: '图书馆', color: 0xa58bff, needs: { study: 0.6, fun: 0.4 } },
  { id: 'shop', label: '小卖部', color: 0xff7f9e, needs: { hunger: 0.7, fun: 0.3 } },
  { id: 'dorm', label: '宿舍', color: 0x8fd3ff, needs: { fatigue: 1 } },
  { id: 'toilet', label: '厕所', color: 0xbfc9d4, needs: { bladder: 1 } },
  { id: 'gate', label: '校门', color: 0xf2f2f2, needs: {} },
  { id: 'fountain', label: '喷泉', color: 0x59d6e8, needs: { fun: 0.5, social: 0.5 } },
  { id: 'other', label: '其它', color: 0x9aa4b1, needs: {} },
];
const ZONE_TYPE_IDS = new Set(ZONE_TYPES.map((z) => z.id));

// 走路速度（米/秒）：比玩家跑慢，比散步快
const WALK_SPEED = 1.25;
// 到达判定（米）
const ARRIVE_DIST = 1.6;
// 决策间隔（秒）：到点或超时才重新想"去哪"
const DECIDE_MIN = 8;
const DECIDE_MAX = 20;
// 停留时长（秒）
const STAY_MIN = 20;
const STAY_MAX = 70;
// 模拟步长（毫秒）
const TICK_MS = 200;
// 广播间隔（毫秒）：5Hz
const BROADCAST_MS = 200;
// 记忆上限：超了先压缩最老的几条，压缩失败直接丢弃最老的
const MEM_MAX = 20;
const MEM_COMPRESS = 5;
// 单条文本长度上限（入库前截断）
const LEN_SAY = 60;
const LEN_THINK = 80;
const LEN_MEM = 120;
// 同一个学生两次 AI 之间的最小间隔（秒）：防刷爆免费档
const AI_COOLDOWN = 45;

// 课程表（世界时刻的小时 → 该时段最该去的区域类型；null = 自由活动看需求）
const SCHEDULE = [
  { from: 0, to: 6.5, type: 'dorm', label: '睡觉' },
  { from: 6.5, to: 7.5, type: 'canteen', label: '早饭' },
  { from: 7.5, to: 11.6, type: 'classroom', label: '上课' },
  { from: 11.6, to: 12.6, type: 'canteen', label: '午饭' },
  { from: 12.6, to: 13.4, type: 'dorm', label: '午休' },
  { from: 13.4, to: 17, type: 'classroom', label: '上课' },
  { from: 17, to: 18, type: 'playground', label: '放学活动' },
  { from: 18, to: 18.8, type: 'canteen', label: '晚饭' },
  { from: 18.8, to: 21, type: 'library', label: '晚自习' },
  { from: 21, to: 24, type: 'dorm', label: '回宿舍' },
];

// 8 名学生的种子档案：只在文件不存在时写入一次，之后的记忆/位置增量都存在文件里。
// 人设写得具体一点，AI 回答才有辨识度（"不知名同学"问十次都是同一套腔调）。
const SEEDS = [
  { name: '陈亦然', sex: 'm', cls: '高二(1)班', persona: '理科尖子，话少但一针见血。喜欢在天台看云，兜里总揣着一本错题本。' },
  { name: '苏晓棠', sex: 'f', cls: '高二(1)班', persona: '爱画画，书包里永远有速写本。观察力强，会记住别人的小动作。' },
  { name: '周野', sex: 'm', cls: '高二(2)班', persona: '篮球校队前锋，饭量是别人的两倍，上课容易睡着，脾气直但讲义气。' },
  { name: '林知夏', sex: 'f', cls: '高二(2)班', persona: '图书管理员助理，安静，说话带点毒舌，其实很热心。' },
  { name: '顾星桥', sex: 'm', cls: '高二(3)班', persona: '话痨，什么都懂一点，喜欢给同学起外号，自称校园百事通。' },
  { name: '江晚吟', sex: 'f', cls: '高二(3)班', persona: '合唱团成员，怕黑，晚上一定要有人陪着回宿舍。' },
  { name: '沈明澈', sex: 'm', cls: '高一(4)班', persona: '转学生，路痴，经常在教学楼里迷路，随身带着手绘地图。' },
  { name: '白露', sex: 'f', cls: '高一(4)班', persona: '生物社成员，养了一盒子蚕，饭堂只吃素，说话慢条斯理。' },
];

function clampText(v, n) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return '';
  return s.length > n ? s.slice(0, n) : s;
}
function num(v, d, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return d;
  return Math.max(lo, Math.min(hi, n));
}
function clamp01(v) { return Math.max(0, Math.min(1, Number(v) || 0)); }
function rand(a, b) { return a + Math.random() * (b - a); }
function pickOne(arr) { return arr.length ? arr[Math.floor(Math.random() * arr.length)] : null; }

export function createNpcWorld(opts) {
  const dataDir = opts.dataDir;
  const broadcast = opts.broadcast || (() => {});
  const getDayTime = opts.getDayTime || (() => 0.35);
  const askStudent = opts.askStudent || (async () => null); // 由 ai-student.js 注入；没配也不影响走路

  const ZONES_FILE = path.join(dataDir, 'zones.json');
  const STUDENTS_FILE = path.join(dataDir, 'students.json');
  const SCENE_FILE = path.join(dataDir, 'editor-scene.json');

  // ---------- 功能区 ----------
  function loadZones() {
    try {
      const a = JSON.parse(fs.readFileSync(ZONES_FILE, 'utf8'));
      return Array.isArray(a) ? a : [];
    } catch {
      return [];
    }
  }
  function saveZones(list) {
    fs.writeFileSync(ZONES_FILE, JSON.stringify(list, null, 2));
  }
  // 消毒：只留已知字段并逐项钳制（和 sanitizeAreas 同一套路，防脏数据/超大对象）
  function sanitizeZones(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const z of raw.slice(0, 60)) {
      if (!z || typeof z !== 'object') continue;
      const minX = num(z.minX, 0, -4000, 4000);
      const maxX = num(z.maxX, 0, -4000, 4000);
      const minZ = num(z.minZ, 0, -4000, 4000);
      const maxZ = num(z.maxZ, 0, -4000, 4000);
      out.push({
        id: String(z.id || ('z' + (out.length + 1))).slice(0, 24),
        name: clampText(z.name, 16) || '未命名区域',
        type: ZONE_TYPE_IDS.has(String(z.type)) ? String(z.type) : 'other',
        minX: Math.min(minX, maxX),
        maxX: Math.max(minX, maxX),
        minZ: Math.min(minZ, maxZ),
        maxZ: Math.max(minZ, maxZ),
      });
    }
    return out;
  }

  // ---------- 建筑障碍（给绕障用） ----------
  // editor-scene.json 里的建筑是带旋转的长方体，服务端没有 three，按"外接方形"保守外扩，
  // 宁可让 NPC 绕远一点，也别穿墙。拿不到场景就退化成直线走（不至于不能跑）。
  let obstacles = [];
  function reloadObstacles() {
    const list = [];
    try {
      const scene = JSON.parse(fs.readFileSync(SCENE_FILE, 'utf8'));
      const arr = Array.isArray(scene && scene.items) ? scene.items : (Array.isArray(scene) ? scene : []);
      for (const it of arr) {
        const rec = it && it.rec;
        if (!rec) continue;
        const cx = Number(rec.x), cz = Number(rec.z);
        if (!Number.isFinite(cx) || !Number.isFinite(cz)) continue;
        let w = Number(rec.w), d = Number(rec.d);
        if (!Number.isFinite(w) || !Number.isFinite(d)) {
          const s = Array.isArray(rec.size) ? rec.size : null;
          w = s ? Number(s[0]) : 0;
          d = s ? Number(s[2]) : 0;
        }
        if (!(w > 0.5) || !(d > 0.5)) continue;
        // 旋转后的外接方：用对角线的一半做保守半径
        const r = Math.max(w, d) * 0.75;
        list.push({ x: cx, z: cz, r });
      }
    } catch {
      /* 场景读不到就不做绕障 */
    }
    obstacles = list;
  }
  function blocked(x, z) {
    for (const o of obstacles) {
      if (Math.abs(x - o.x) < o.r && Math.abs(z - o.z) < o.r) return true;
    }
    return false;
  }

  // ---------- 角色档案 ----------
  function loadStudents() {
    try {
      const a = JSON.parse(fs.readFileSync(STUDENTS_FILE, 'utf8'));
      return Array.isArray(a) ? a : [];
    } catch {
      return [];
    }
  }
  function saveStudents(list) {
    fs.writeFileSync(STUDENTS_FILE, JSON.stringify(list, null, 2));
  }
  // 首次启动造 8 个学生；之后只补齐缺失字段（老存档不会被冲掉）
  function ensureStudents() {
    let list = loadStudents();
    let dirty = false;
    if (list.length !== SEEDS.length) {
      list = SEEDS.map((s, i) => {
        const old = list[i] && typeof list[i] === 'object' ? list[i] : null;
        return {
          id: 's' + (i + 1),
          name: s.name,
          sex: s.sex,
          cls: s.cls,
          persona: s.persona,
          x: old && Number.isFinite(Number(old.x)) ? Number(old.x) : rand(-30, 30),
          z: old && Number.isFinite(Number(old.z)) ? Number(old.z) : rand(-30, 30),
          rot: 0,
          st: 'idle',
          zoneId: '',
          stayUntil: 0,
          decideAt: 0,
          aiAt: 0,
          needs: (old && old.needs) || { hunger: rand(0, 0.5), fun: rand(0, 0.5), study: rand(0, 0.5), fatigue: rand(0, 0.3), social: rand(0, 0.5), bladder: rand(0, 0.3) },
          mem: Array.isArray(old && old.mem) ? old.mem : [],
          think: Array.isArray(old && old.think) ? old.think : [],
        };
      });
      dirty = true;
    }
    // 补齐后加的字段（避免老存档缺字段导致 undefined 参与运算 → NaN 静默失效）
    for (const s of list) {
      if (!s.needs || typeof s.needs !== 'object') { s.needs = { hunger: 0.3, fun: 0.3, study: 0.3, fatigue: 0.2, social: 0.3, bladder: 0.2 }; dirty = true; }
      if (!Array.isArray(s.mem)) { s.mem = []; dirty = true; }
      if (!Array.isArray(s.think)) { s.think = []; dirty = true; }
      if (!Number.isFinite(Number(s.rot))) { s.rot = 0; dirty = true; }
      if (!Number.isFinite(Number(s.stayUntil))) { s.stayUntil = 0; dirty = true; }
      if (!Number.isFinite(Number(s.decideAt))) { s.decideAt = 0; dirty = true; }
      if (!Number.isFinite(Number(s.aiAt))) { s.aiAt = 0; dirty = true; }
    }
    if (dirty) saveStudents(list);
    return list;
  }

  let students = ensureStudents();
  let zones = loadZones();
  reloadObstacles();

  function zoneById(id) { return zones.find((z) => z.id === id) || null; }
  function zoneCenter(z) { return { x: (z.minX + z.maxX) / 2, z: (z.minZ + z.maxZ) / 2 }; }
  function randomPointIn(z) {
    return { x: rand(Math.min(z.minX, z.maxX), Math.max(z.minX, z.maxX)), z: rand(Math.min(z.minZ, z.maxZ), Math.max(z.minZ, z.maxZ)) };
  }

  // 当前世界时刻（小时）：0 = 00:00
  function hourNow() {
    const t = Number(getDayTime()) || 0;
    return (((t % 1) + 1) % 1) * 24;
  }
  function scheduleType(h) {
    for (const seg of SCHEDULE) if (h >= seg.from && h < seg.to) return seg;
    return null;
  }

  // 需求 → 想去的区域类型（取"需求值 × 该类型满足度"最高的那条）
  function needType(s) {
    let best = null;
    let bestScore = -1;
    for (const [k, v] of Object.entries(s.needs)) {
      const score = clamp01(v) + Math.random() * 0.15; // 随机扰动：同样的需求值不会每次都挑同一个地方
      if (score > bestScore) {
        bestScore = score;
        best = k;
      }
    }
    // 需求 → 类型（没有对应区域就退化成"随便走走"）
    const map = { hunger: 'canteen', fatigue: 'dorm', fun: 'playground', study: 'library', social: 'fountain', bladder: 'toilet' };
    return map[best] || 'other';
  }

  function zonesOfType(type) {
    const hit = zones.filter((z) => z.type === type);
    return hit.length ? hit : zones.slice(0, 1);
  }

  // 选目标：课程表时段优先（70%），否则按需求；都没有区域就原地发呆
  function decide(s, now) {
    const h = hourNow();
    const seg = scheduleType(h);
    let target = null;
    if (seg && Math.random() < 0.7) target = pickOne(zonesOfType(seg.type));
    if (!target) target = pickOne(zonesOfType(needType(s)));
    if (!target) { s.st = 'idle'; s.decideAt = now + rand(DECIDE_MIN, DECIDE_MAX); return; }
    s.zoneId = target.id;
    const p = randomPointIn(target);
    s.tx = p.x;
    s.tz = p.z;
    s.st = 'walk';
    s.decideAt = now + rand(DECIDE_MIN, DECIDE_MAX);
  }

  // 朝目标走一步：被建筑挡住就左右试探绕行（最多 5 个方向，全挡住就原地等下一拍）
  function stepMove(s, dt) {
    const dx = Number(s.tx) - Number(s.x);
    const dz = Number(s.tz) - Number(s.z);
    const dist = Math.hypot(dx, dz);
    if (!Number.isFinite(dist) || dist < ARRIVE_DIST) return true; // 到了
    const stepLen = WALK_SPEED * dt;
    const ux = dx / dist;
    const uz = dz / dist;
    const angles = [0, 0.6, -0.6, 1.2, -1.2];
    for (const a of angles) {
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const nx = ux * ca - uz * sa;
      const nz = ux * sa + uz * ca;
      const px = Number(s.x) + nx * stepLen;
      const pz = Number(s.z) + nz * stepLen;
      if (!blocked(px, pz)) {
        s.x = px;
        s.z = pz;
        s.rot = (Math.atan2(nx, nz) * 180) / Math.PI; // 度，与建筑那套一致
        return false;
      }
    }
    return false; // 全被挡：这一拍不动（下一拍继续试，不会卡死）
  }

  // 需求随真实时间推进；在对应类型的区域里"被满足"而回落
  function updateNeeds(s, dt, now) {
    const perSec = 1 / 900; // 约 15 分钟从 0 涨到 1
    const n = s.needs;
    n.hunger = clamp01(n.hunger + dt * perSec * 1.2);
    n.fatigue = clamp01(n.fatigue + dt * perSec * 0.8);
    n.bladder = clamp01(n.bladder + dt * perSec * 1.0);
    n.fun = clamp01(n.fun + dt * perSec * 0.6);
    n.social = clamp01(n.social + dt * perSec * 0.5);
    n.study = clamp01(n.study + dt * perSec * 0.4);
    const z = zoneById(s.zoneId);
    if (z && s.st === 'act') {
      const t = ZONE_TYPES.find((x) => x.id === z.type);
      const gains = (t && t.needs) || {};
      for (const [k, w] of Object.entries(gains)) {
        if (k in n) n[k] = clamp01(n[k] - dt * 0.02 * w);
      }
    }
  }

  // ---------- AI 触发 ----------
  // 产出 {say, think, mem} 后清洗入库；think 广播给附近玩家看，say 走对话或气泡。
  // ⚠ 冷却：同一个学生 AI_COOLDOWN 秒内只调一次（免费档有限流，8 个学生不能一起刷）。
  let aiBusy = new Set();
  async function triggerAI(s, kind, extra) {
    const now = Date.now();
    if (aiBusy.has(s.id)) return null;
    if (kind !== 'talk' && now - Number(s.aiAt || 0) < AI_COOLDOWN * 1000) return null;
    s.aiAt = now;
    aiBusy.add(s.id);
    try {
      const zone = zoneById(s.zoneId);
      const out = await askStudent({
        student: {
          name: s.name, cls: s.cls, persona: s.persona, sex: s.sex,
          place: zone ? zone.name : '校园里',
          st: s.st,
          needs: s.needs,
        },
        memory: s.mem.slice(-6),
        kind,
        playerText: extra && extra.text ? String(extra.text) : '',
        playerName: extra && extra.name ? String(extra.name) : '同学',
      });
      if (!out) return null;
      const say = clampText(out.say, LEN_SAY);
      const think = clampText(out.think, LEN_THINK);
      const mem = clampText(out.mem, LEN_MEM);
      if (think) {
        s.think.push({ t: now, text: think });
        if (s.think.length > MEM_MAX) s.think.splice(0, s.think.length - MEM_MAX);
      }
      if (mem) {
        s.mem.push({ t: now, text: mem });
        await trimMemory(s);
      }
      saveStudents(students);
      return { say, think };
    } catch (e) {
      return null;
    } finally {
      aiBusy.delete(s.id);
    }
  }

  // 记忆超上限：先让 AI 把最老的几条压成一条摘要，失败/仍超就直接丢最老的（粗暴但不会无限膨胀）
  async function trimMemory(s) {
    if (s.mem.length <= MEM_MAX) return;
    try {
      const oldest = s.mem.splice(0, MEM_COMPRESS).map((m) => String(m.text || ''));
      const out = await askStudent({
        student: { name: s.name, cls: s.cls, persona: s.persona, sex: s.sex, place: '校园里', st: s.st, needs: s.needs },
        memory: [],
        kind: 'compress',
        playerText: oldest.join(' / '),
        playerName: '同学',
      });
      const summary = clampText(out && out.mem, LEN_MEM);
      if (summary) s.mem.unshift({ t: Date.now(), text: summary });
    } catch {
      /* 压缩失败就算了：上面已经 splice 掉最老的了 */
    }
    while (s.mem.length > MEM_MAX) s.mem.shift();
  }

  // ---------- 主循环 ----------
  let lastTick = Date.now();
  let lastBroadcast = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    const dt = Math.min(1.5, (now - lastTick) / 1000);
    lastTick = now;
    if (!zones.length) {
      // 没有标注任何功能区：学生原地待着（比乱走穿墙好），并提示一次
      if (now - lastBroadcast > 5000) {
        lastBroadcast = now;
        console.info('[npc] 还没有标注功能区（编辑器「区域」页签），学生原地待命');
      }
      return;
    }
    let changed = false;
    for (const s of students) {
      updateNeeds(s, dt, now);
      if (s.st === 'act') {
        if (now >= Number(s.stayUntil || 0)) { s.st = 'idle'; s.decideAt = now; }
      } else if (s.st === 'walk') {
        const arrived = stepMove(s, dt);
        if (arrived) {
          s.st = 'act';
          s.stayUntil = now + rand(STAY_MIN, STAY_MAX) * 1000;
          // 到达目的地：触发一次内心独白（内部有冷却，绝大多数会被节流掉）
          triggerAI(s, 'arrive');
        }
      } else if (now >= Number(s.decideAt || 0)) {
        decide(s, now);
      }
      changed = true;
    }
    if (changed && now - lastBroadcast >= BROADCAST_MS) {
      lastBroadcast = now;
      broadcast({ t: 'npc', list: students.map((s) => ({ id: s.id, x: round2(s.x), z: round2(s.z), rot: round1(s.rot), st: s.st })) });
    }
  }, TICK_MS);
  if (timer.unref) timer.unref();

  function round2(v) { return Math.round(Number(v || 0) * 100) / 100; }
  function round1(v) { return Math.round(Number(v || 0) * 10) / 10; }

  // ---------- 对外接口 ----------
  // 玩家搭话：必触发 AI（不受冷却限制），返回 {say, think} 并广播气泡
  async function talk(studentId, text, playerName) {
    const s = students.find((x) => x.id === String(studentId));
    if (!s) return null;
    const out = await triggerAI(s, 'talk', { text: String(text || '').slice(0, 200), name: playerName || '同学' });
    if (!out) return { say: '', think: '' };
    broadcast({ t: 'npc_say', id: s.id, say: out.say, think: out.think });
    return out;
  }

  // 给新连上的客户端一份完整名单（名字/班级/当前大致位置）
  function roster() {
    return students.map((s) => ({
      id: s.id, name: s.name, cls: s.cls, sex: s.sex,
      x: round2(s.x), z: round2(s.z), rot: round1(s.rot), st: s.st,
      think: s.think.length ? String(s.think[s.think.length - 1].text || '') : '',
    }));
  }

  function setZones(next) {
    zones = sanitizeZones(next);
    saveZones(zones);
    // 换了区域：所有学生立刻重新决策，免得还朝着已经删掉的旧目标走
    const now = Date.now();
    for (const s of students) { s.decideAt = now; s.st = 'idle'; }
    return zones;
  }
  function getZones() { return zones; }

  function dispose() { clearInterval(timer); }

  return { roster, talk, setZones, getZones, dispose, triggerAI, ZONE_TYPES };
}
