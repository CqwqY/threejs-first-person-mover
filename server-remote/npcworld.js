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
import { loadPolicy, PolicyNet, STATE_KEYS, ACTIONS } from './policy.js';

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
// ⚠ 走路超时（秒）：走这么久还没到就放弃这个目标、重新决策。
//   没有这条，目标点不可达（落在建筑里 / 五个绕行方向全被挡）会**永久卡在 walk**——人再也不动、零报错。
const WALK_TIMEOUT = 45;
// 连续这么多拍（TICK_MS 一拍）几乎没位移 ⇒ 判定卡住，立刻重决策
const STUCK_TICKS = 12;
// 未标注任何功能区时的降级漫步半径（米，围绕出生锚点）——宁可让他溜达，也别杵着不动
const WANDER_RADIUS = 40;
// NPC 体半径（米）：绕障与落点采样留的余量
const NPC_PAD = 0.7;
// 场景项没有记录真实占地（老存档）时，按 scale 乘这个数估算
const BASE_FOOT = 4;
// 单边超过这个尺寸（米）就当地形/道路，不当障碍
const SCENE_MAX_SIDE = 60;
// 障碍表重载间隔（毫秒）：编辑器改完场景不必重启服务端
const OBSTACLE_RELOAD_MS = 60000;
// 模拟步长（毫秒）
const TICK_MS = 200;
// 广播间隔（毫秒）：5Hz
const BROADCAST_MS = 200;
// 记忆上限：超了先压缩最老的几条，压缩失败直接丢弃最老的
const MEM_MAX = 20;
// 一次给 AI 的记忆条数（只给被搭话的那个学生本人的，且按相关性挑，不是把一串全塞进去）
const MEM_CTX = 4;
const MEM_COMPRESS = 5;
// 单条文本长度上限（入库前截断）。think 是**内部**独白（玩家看不到），写宽一点才有内容，
// 它决定这个角色"脑子里在想什么"，进而影响记忆与后续举止。
const LEN_SAY = 60;
const LEN_THINK = 120;
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

  // ---------- 可训练策略网络（阶段1~5 的产物） ----------
  // 守卫式接入：模型不存在 / 损坏 / 契约不一致 → policyReady=false，decide() 自动退回规则大脑，零行为回归风险。
  const policy = loadPolicy(dataDir);
  const policyReady = policy.ready;
  if (policyReady) console.info('[npc] 已加载策略模型 campus_policy.json（' + (policy.meta.phases || []).join('+') + '，训练行 ' + (policy.meta.trainedRows || 0) + '）');
  else console.info('[npc] 无策略模型（' + policy.reason + '）：使用规则大脑 decide()');

  // 玩家坐标（由 index.js 每收到玩家 state 就喂一次），供 playerNear 特征用
  let playerPositions = [];
  function setPlayerPositions(list) { playerPositions = Array.isArray(list) ? list : []; }

  const ZONES_FILE = path.join(dataDir, 'zones.json');
  const STUDENTS_FILE = path.join(dataDir, 'students.json');
  const SCENE_FILE = path.join(dataDir, 'editor-scene.json');
  const BUILD_FILE = path.join(dataDir, 'buildings.json');

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

  // ---------- 障碍（给绕障用） ----------
  // ⚠⚠ 老版本这里是**完全失效**的（学生穿墙的真凶）：它读 `scene.items` 里每个 `it.rec` 的 w/d/size，
  //    而 editor-scene.json 的真实结构是 `{boundary, track, scenery:[], placed:[], lights:[]}`
  //    —— 既没有 items、元素也不带 .rec 包装、尺寸只存在于 `scale:{x,y,z}`
  //    ⇒ 三条全落空、obstacles 恒为空数组 ⇒ 学生直线走、直接穿墙。
  // 现在：placed + scenery（超大项当地形/道路跳过）+ buildings.json 全收，做 OBB（旋转矩形）判定。
  let obstacles = [];
  function reloadObstacles() {
    const list = [];
    let measured = 0; // 带真实 fw/fd 的条数；0 = 老存档，尺寸全靠估
    const add = (cx, cz, w, d, rotRad) => {
      if (!Number.isFinite(cx) || !Number.isFinite(cz)) return;
      if (!(w > 0.4) || !(d > 0.4)) return;
      if (w > SCENE_MAX_SIDE || d > SCENE_MAX_SIDE) return; // 地形/道路：当成障碍会把整片地面堵死
      list.push({
        x: cx, z: cz,
        hw: w / 2, hd: d / 2,                 // 半宽 / 半深
        c: Math.cos(rotRad), s: Math.sin(rotRad), // 旋转到建筑自有坐标用的三角值
        rr: Math.hypot(w, d) / 2 + NPC_PAD,   // 外接圆半径：只用来快速排除，不用来判定
      });
    };
    try {
      const scene = JSON.parse(fs.readFileSync(SCENE_FILE, 'utf8'));
      const arr = [].concat(
        Array.isArray(scene && scene.placed) ? scene.placed : [],
        Array.isArray(scene && scene.scenery) ? scene.scenery : [],
      );
      for (const rec of arr) {
        if (!rec || typeof rec !== 'object') continue;
        if (rec.kind === 'window') continue; // 障眼法窗户是贴在墙上的 quad，不挡路
        const sc = rec.scale && typeof rec.scale === 'object' ? rec.scale : {};
        const sx = Number.isFinite(Number(sc.x)) ? Number(sc.x) : 1;
        const sz = Number.isFinite(Number(sc.z)) ? Number(sc.z) : 1;
        let w = Number(rec.fw);
        let d = Number(rec.fd);
        if (Number.isFinite(w) && Number.isFinite(d)) measured++;
        // 老存档没有 fw/fd：只能按 scale 估（BASE_FOOT = 未缩放时约这么大）
        if (!(w > 0)) w = Math.abs(sx) * BASE_FOOT;
        if (!(d > 0)) d = Math.abs(sz) * BASE_FOOT;
        // ⚠ 单位：editor-scene.json 里普通放置物的 rotY 是**弧度**（EditorApp 直接写 three 的 rotation.y）
        add(Number(rec.x), Number(rec.z), w, d, Number.isFinite(Number(rec.rotY)) ? Number(rec.rotY) : 0);
      }
    } catch {
      console.warn('[npc] 读不到 editor-scene.json：学生只在玩家建造物之间绕障，可能穿墙');
    }
    try {
      const b = JSON.parse(fs.readFileSync(BUILD_FILE, 'utf8'));
      for (const it of Array.isArray(b) ? b : []) {
        const rec = it && it.rec ? it.rec : it;
        if (!rec || typeof rec !== 'object') continue;
        // ⚠ 单位（记忆第 9 条同源）：buildings.json 的 rotY 是**度**，要转弧度；上面场景那份是弧度，别混。
        const deg = Number.isFinite(Number(rec.rotY)) ? Number(rec.rotY) : 0;
        add(Number(rec.x), Number(rec.z), Number(rec.w), Number(rec.d), (deg * Math.PI) / 180);
      }
    } catch {
      /* 没有玩家建造数据：不纳入障碍即可 */
    }
    obstacles = list;
    if (!list.length) console.warn('[npc] 障碍表为空：学生会穿墙（检查 editor-scene.json 是否存在且已保存）');
    else if (!measured) console.info('[npc] 障碍 ' + list.length + ' 个（尺寸为估算，请在编辑器重新保存一次场景以写入真实占地 fw/fd）');
    else console.info('[npc] 障碍 ' + list.length + ' 个，其中 ' + measured + ' 个带真实占地');
  }
  // OBB（旋转矩形）判定：比"外接方形"精确得多，教室/饭堂内部才进得去。
  // 老写法 r = max(w,d)*0.75 对 20×10 的教学楼是 15m 的大方块，整个教室区都算障碍 ⇒ 目标永远不可达。
  // 判定 + 返回命中的障碍（脱困要知道是被哪栋楼压住，才好往外走）
  function blockedBy(x, z) {
    for (const o of obstacles) {
      const dx = x - o.x;
      const dz = z - o.z;
      if (dx * dx + dz * dz > o.rr * o.rr) continue; // 外接圆都够不着，直接排除
      const lx = dx * o.c + dz * o.s;
      const lz = -dx * o.s + dz * o.c;
      if (Math.abs(lx) < o.hw + NPC_PAD && Math.abs(lz) < o.hd + NPC_PAD) return o;
    }
    return null;
  }
  function blocked(x, z) { return !!blockedBy(x, z); }

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
        const px = old && Number.isFinite(Number(old.x)) ? Number(old.x) : rand(-30, 30);
        const pz = old && Number.isFinite(Number(old.z)) ? Number(old.z) : rand(-30, 30);
        return {
          id: 's' + (i + 1),
          name: s.name,
          sex: s.sex,
          cls: s.cls,
          persona: s.persona,
          x: px,
          z: pz,
          hx: px,   // 出生锚点：未标功能区时围绕它漫步，防止越走越远
          hz: pz,
          tx: px,   // 当前目标点（必须初始化：undefined 参与运算会变 NaN）
          tz: pz,
          walkUntil: 0, // 本次行走的放弃时刻（毫秒）
          stuck: 0,     // 连续没位移的拍数（累加型字段，必须有初值）
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
      // 后加的字段：老存档没有 ⇒ 不补就是 undefined 参与运算 → NaN → 人不动/消失（静默失效）
      if (!Number.isFinite(Number(s.hx))) { s.hx = Number(s.x) || 0; dirty = true; }
      if (!Number.isFinite(Number(s.hz))) { s.hz = Number(s.z) || 0; dirty = true; }
      if (!Number.isFinite(Number(s.tx))) { s.tx = Number(s.x) || 0; dirty = true; }
      if (!Number.isFinite(Number(s.tz))) { s.tz = Number(s.z) || 0; dirty = true; }
      if (!Number.isFinite(Number(s.walkUntil))) { s.walkUntil = 0; dirty = true; }
      if (!Number.isFinite(Number(s.stuck))) { s.stuck = 0; dirty = true; }
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
  // 在区域里挑一个**站得住**的落点：区域常与建筑本身重叠（教室区就是教学楼），
  // 直接取中心很可能落在墙里 ⇒ 采样若干次，全站不住就返回 null 让调用方放弃这个目标（别硬走）。
  function pickPointIn(z) {
    for (let i = 0; i < 16; i++) {
      const p = randomPointIn(z);
      if (!blocked(p.x, p.z)) return p;
    }
    const c = zoneCenter(z);
    return blocked(c.x, c.z) ? null : c;
  }
  // 未标功能区时的降级漫步：围绕出生锚点找一个站得住的落点
  function wander(s, now) {
    const hx = Number.isFinite(Number(s.hx)) ? Number(s.hx) : Number(s.x) || 0;
    const hz = Number.isFinite(Number(s.hz)) ? Number(s.hz) : Number(s.z) || 0;
    for (let i = 0; i < 24; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = rand(5, WANDER_RADIUS);
      const x = hx + Math.cos(a) * r;
      const z = hz + Math.sin(a) * r;
      if (blocked(x, z)) continue;
      s.tx = x;
      s.tz = z;
      s.st = 'walk';
      s.walkUntil = now + WALK_TIMEOUT * 1000;
      s.stuck = 0;
      s.decideAt = now + rand(DECIDE_MIN, DECIDE_MAX) * 1000;
      return;
    }
    // 24 次都挑不到（被建筑围死了）：原地发呆 3 秒再试，绝不静默卡住
    s.st = 'idle';
    s.decideAt = now + 3000;
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

  // ⚠ 不要 fallback 成 zones[0]：那会让学生"假装"去一个跟他此刻毫无关系的地方（在教室说自己在图书馆）。
  function zonesOfType(type) {
    return zones.filter((z) => z.type === type);
  }

  // 按**坐标**判定"我现在在哪"。以前用的是目标区域 s.zoneId：走路途中就说自己已经在目的地了，
  // 而且上面那个 fallback 会让他顶着任意第一个区域的名字 ⇒ 站在教学楼里说"我在图书馆"。
  function zoneAt(x, z) {
    for (const zn of zones) {
      if (x >= Math.min(zn.minX, zn.maxX) && x <= Math.max(zn.minX, zn.maxX)
        && z >= Math.min(zn.minZ, zn.maxZ) && z <= Math.max(zn.minZ, zn.maxZ)) return zn;
    }
    return null;
  }
  // 给 AI 的"我在哪"：区域名 + 类型标签。都不在就老实说"校园里"，绝不臆造地点。
  function placeOf(s) {
    const zn = zoneAt(Number(s.x), Number(s.z)) || zoneById(s.zoneId);
    if (!zn) return '校园里';
    const t = ZONE_TYPES.find((x) => x.id === zn.type);
    const label = (t && t.label) || '';
    const nm = String(zn.name || '');
    if (!label) return nm || '校园里';
    if (nm && nm.indexOf(label) >= 0) return nm; // 名字里已经带类型（"图书馆"）就不重复
    return nm ? nm + '（' + label + '）' : label;
  }

  // 选目标：课程表时段优先（70%），否则按需求；都没有区域就原地发呆
  function decide(s, now) {
    if (policyReady) { applyPolicy(s, now); return; }
    const h = hourNow();
    const seg = scheduleType(h);
    let target = null;
    if (seg && Math.random() < 0.7) target = pickOne(zonesOfType(seg.type));
    if (!target) target = pickOne(zonesOfType(needType(s)));
    // 没有对应类型的区域：自由漫步，别硬塞一个无关目的地（那会让角色"不知道自己在哪"）
    if (!target) { wander(s, now); return; }
    goZone(s, now, target);
  }

  // ---------- 策略网络决策 ----------
  // 把学生当前状态拼成 schema 顺序的归一化向量（与 policy.js 的 STATE_KEYS 完全一致）。
  function buildState(s) {
    const n = s.needs || {};
    const h = hourNow();
    const seg = scheduleType(h);
    const myZone = zoneAt(Number(s.x), Number(s.z)) || zoneById(s.zoneId);
    const myType = myZone ? myZone.type : null;
    const v = [
      clamp01(n.hunger), clamp01(n.fatigue), clamp01(n.fun), clamp01(n.study), clamp01(n.social), clamp01(n.bladder),
      clamp01(h / 24),
      0, // isWeekend：当前游戏无周末概念，恒 0
    ];
    for (const z of ZONE_TYPES) v.push(z.id === myType ? 1 : 0);
    v.push(seg && seg.type === 'classroom' ? 1 : 0);
    v.push(s._nearFriend ? 1 : 0);
    v.push(s._playerNear ? 1 : 0);
    return v;
  }
  function nearestPlayer(s) {
    let best = null, bd = Infinity;
    for (const p of playerPositions) {
      const dx = Number(p.x) - Number(s.x), dz = Number(p.z) - Number(s.z);
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }
  // 走到具体区域（规则大脑和策略网络共用同一段落地逻辑）
  function goZone(s, now, target) {
    const p = pickPointIn(target);
    if (!p) { wander(s, now); return; }
    s.zoneId = target.id;
    s.tx = p.x;
    s.tz = p.z;
    s.st = 'walk';
    s.walkUntil = now + WALK_TIMEOUT * 1000;
    s.stuck = 0;
    s.decideAt = now + rand(DECIDE_MIN, DECIDE_MAX) * 1000;
  }
  function applyPolicy(s, now) {
    const a = policy.net.decide(buildState(s));
    if (policy.net.isZone(a)) {
      const target = pickOne(zonesOfType(a));
      if (target) { goZone(s, now, target); return; }
      wander(s, now); return; // 没这种类型的区域：自由漫步兜底
    }
    if (a === 'wander') { wander(s, now); return; }
    if (a === 'rest') { s.st = 'act'; s.stayUntil = now + rand(STAY_MIN, STAY_MAX) * 1000; s.decideAt = now + rand(DECIDE_MIN, DECIDE_MAX) * 1000; return; }
    if (a === 'chat_with') { s.st = 'act'; s.stayUntil = now + rand(20, 50) * 1000; s.decideAt = now + rand(DECIDE_MIN, DECIDE_MAX) * 1000; return; }
    if (a === 'follow_player' || a === 'help_player') {
      const p = nearestPlayer(s);
      if (p) {
        s.zoneId = ''; s.tx = Number(p.x); s.tz = Number(p.z);
        s.st = 'walk'; s.walkUntil = now + WALK_TIMEOUT * 1000; s.stuck = 0;
        s.decideAt = now + rand(DECIDE_MIN, DECIDE_MAX) * 1000; return;
      }
      wander(s, now); return;
    }
    wander(s, now);
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
    // 脱困：如果自己正站在障碍里（初始坐标是随机的，可能正好落进楼里；或场景改动后被压住），
    // 下面五个绕行方向**全都会被判挡住** ⇒ 永远出不来。
    // ⚠ 方向必须朝"背离这栋楼"走，不能朝目标走 —— 朝目标走等于被允许横穿整栋楼（真·穿墙）。
    const hit = blockedBy(Number(s.x), Number(s.z));
    if (hit) {
      let ex = Number(s.x) - hit.x;
      let ez = Number(s.z) - hit.z;
      let el = Math.hypot(ex, ez);
      if (!(el > 1e-3)) { ex = ux; ez = uz; el = 1; } // 正好压在楼中心：退化成朝目标挪
      ex /= el;
      ez /= el;
      s.x = Number(s.x) + ex * stepLen;
      s.z = Number(s.z) + ez * stepLen;
      s.rot = (Math.atan2(-ex, -ez) * 180) / Math.PI;
      return dist < ARRIVE_DIST;
    }
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
        // ⚠ 必须与玩家模型同一套约定（Game.js：fwd = (-sin yaw, ·, -cos yaw) ⇒ yaw = atan2(-dx, -dz)）。
        //   少了这两个负号，走起来就是**背朝前**（看起来像"不会转身、只会平移"）。单位：度。
        s.rot = (Math.atan2(-nx, -nz) * 180) / Math.PI;
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
  // 只挑**这一个学生自己**的记忆里跟当下最相关的几条。
  // ⚠ 不要"把记忆一股脑全给 AI"：条数越多，模型越容易把几条搅在一起、甚至张冠李戴成别人的经历。
  //   这里严格按 s.mem（被搭话者本人）取，再按与"当前地点 + 对方这句话"的字面重合度排序取前 MEM_CTX 条。
  function memKeywords(ctx) {
    const t = String(ctx || '');
    const out = [];
    for (let i = 0; i + 1 < t.length && out.length < 80; i++) {
      const g = t.slice(i, i + 2);
      if (!/[\s，。、！？,.!?；;]/.test(g)) out.push(g); // 中文按 2-gram 切，够用且不引分词库
    }
    return out;
  }
  function pickMemory(s, extra) {
    const all = Array.isArray(s.mem) ? s.mem : [];
    if (all.length <= MEM_CTX) return all.slice();
    const kws = memKeywords(placeOf(s) + ' ' + String((extra && extra.text) || ''));
    const scored = all.map((m, i) => {
      const txt = String((m && m.text) || '');
      let hit = 0;
      for (const k of kws) if (txt.indexOf(k) >= 0) hit++;
      return { m, i, hit };
    });
    // 相关度优先，同分按时间近的优先；选完再按时间顺序排回去（别让记忆乱序，模型会读着别扭）
    scored.sort((a, b) => (b.hit - a.hit) || (b.i - a.i));
    return scored.slice(0, MEM_CTX).sort((a, b) => a.i - b.i).map((x) => x.m);
  }
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
      const out = await askStudent({
        student: {
          name: s.name, cls: s.cls, persona: s.persona, sex: s.sex,
          place: placeOf(s), // 按**坐标**判定，不是按"打算去哪"——以前那样会让他在教室说自己在图书馆
          st: s.st,
          needs: s.needs,
        },
        // ⚠ 只给**这个学生本人**的记忆，而且是挑出来的几条（不是整串）。
        //   混进别人的记忆 = 几个人的经历串台；一次给太多 = 模型自己搅成一团。
        memory: pickMemory(s, extra),
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
  let lastHint = 0;      // 上一次打"没标功能区"提示的时间（累加型字段，必须有初值）
  let lastObstacle = Date.now(); // 上一次重载障碍表的时间
  const timer = setInterval(() => {
    const now = Date.now();
    const dt = Math.min(1.5, (now - lastTick) / 1000);
    lastTick = now;
    const hasZones = zones.length > 0;
    if (!hasZones && now - lastHint > 30000) {
      lastHint = now;
      // 降级要出声（记忆第 4 条）：没区域不再原地杵着，改成绕出生点自由漫步
      console.info('[npc] 还没标注功能区（编辑器「功能区」页签）：学生自由漫步中；标好区域后按课表/需求行动');
    }
    // 障碍表定期重载：编辑器改完场景不必重启服务端
    if (now - lastObstacle > OBSTACLE_RELOAD_MS) {
      lastObstacle = now;
      reloadObstacles();
    }
    // 每拍算"同区有没有同学 / 附近有没有玩家"——策略网络的 nearFriend / playerNear 特征
    const zoneOf = new Map();
    for (const s of students) zoneOf.set(s, zoneAt(Number(s.x), Number(s.z)));
    for (const s of students) {
      const myType = zoneOf.get(s) ? zoneOf.get(s).type : null;
      s._nearFriend = myType && students.some((o) => o !== s && zoneOf.get(o) && zoneOf.get(o).type === myType) ? 1 : 0;
      s._playerNear = playerPositions.some((p) => {
        const dx = Number(p.x) - Number(s.x), dz = Number(p.z) - Number(s.z);
        return dx * dx + dz * dz < 64; // 8m 内算"玩家在附近"
      }) ? 1 : 0;
    }
    for (const s of students) {
      updateNeeds(s, dt, now);
      if (s.st === 'act') {
        if (now >= Number(s.stayUntil || 0)) { s.st = 'idle'; s.decideAt = now; }
      } else if (s.st === 'walk') {
        const bx = Number(s.x);
        const bz = Number(s.z);
        const arrived = stepMove(s, dt);
        if (arrived) {
          s.st = 'act';
          s.stayUntil = now + rand(STAY_MIN, STAY_MAX) * 1000;
          s.stuck = 0;
          // 到达目的地：触发一次内心独白（内部有冷却，绝大多数会被节流掉）
          triggerAI(s, 'arrive');
        } else {
          // ⚠ 没有这两条兜底，目标不可达（点在墙里 / 五个方向全被挡）会**永久卡在 walk**：
          //   永远不会到达、decideAt 也永远不刷新 ⇒ 人再也不动，而且零报错。
          const moved = Math.hypot(Number(s.x) - bx, Number(s.z) - bz);
          s.stuck = moved > 0.02 ? 0 : Number(s.stuck || 0) + 1;
          if (s.stuck >= STUCK_TICKS || now >= Number(s.walkUntil || 0)) {
            s.st = 'idle';
            s.decideAt = now;
            s.stuck = 0;
          }
        }
      } else if (now >= Number(s.decideAt || 0)) {
        if (hasZones) decide(s, now); else wander(s, now);
      }
    }
    // ⚠ 无论有没有区域都要广播：以前没区域时直接 return，客户端连一次更新都收不到（表现为"人都定住了"）
    if (now - lastBroadcast >= BROADCAST_MS) {
      lastBroadcast = now;
      // ⚠ 客户端自己驱动走位：下发「目标点」tx/tz（客户端用 tx/tz 走位）；同时保留 x/z（服务端 ghost
      //   坐标，供 probe-npc-move 等守卫探针观测实际移动/绕障）与 rot（服务端自转朝向，仅做兼容/调试）。
      //   客户端只消费 tx/tz/st，x/z/rot 客户端忽略（缺 tx/tz 时才回退用 x/z）。
      broadcast({ t: 'npc', list: students.map((s) => ({ id: s.id, x: round2(s.x), z: round2(s.z), tx: round2(s.tx), tz: round2(s.tz), rot: round1(s.rot), st: s.st })) });
    }
  }, TICK_MS);
  if (timer.unref) timer.unref();

  function round2(v) { return Math.round(Number(v || 0) * 100) / 100; }
  function round1(v) { return Math.round(Number(v || 0) * 10) / 10; }

  // ---------- 对外接口 ----------
  // 玩家搭话：必触发 AI（不受冷却限制），返回 {say, think} 并广播气泡。
  // ⚠ 两端都不再把 think 发给客户端：心理活动是**内部**的（驱动记忆与行为），玩家不该在对话栏看到它。
  // ⚠ except：发起者自己已经收到 npc_reply，广播要跳过他，否则同一句话出现两遍。
  async function talk(studentId, text, playerName, except) {
    const s = students.find((x) => x.id === String(studentId));
    if (!s) return null;
    const out = await triggerAI(s, 'talk', { text: String(text || '').slice(0, 200), name: playerName || '同学' });
    if (!out) return { say: '', think: '' };
    broadcast({ t: 'npc_say', id: s.id, say: out.say }, except);
    return out;
  }

  // 给新连上的客户端一份完整名单（名字/班级/初始坐标 + 初始目标点）
  function roster() {
    return students.map((s) => ({
      id: s.id, name: s.name, cls: s.cls, sex: s.sex,
      // ⚠ 初始坐标 x/z 给客户端落地 pstate；目标点 tx/tz 给客户端定初始走向（客户端驱动走位）
      x: round2(s.x), z: round2(s.z), tx: round2(s.tx), tz: round2(s.tz), st: s.st,
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

  return { roster, talk, setZones, getZones, dispose, triggerAI, refreshObstacles: reloadObstacles, setPlayerPositions, loadPolicyStatus: () => ({ ready: policyReady, meta: policy.meta || {}, reason: policy.reason }), ZONE_TYPES };
}
