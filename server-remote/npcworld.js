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

// ---------- System2（LLM「灵魂」）规划层 ----------
// 低频定意图 + 计划，错峰轮询，避免 8 个 NPC 同时打 GLM 被限流/烧钱。
// 角色分工：LLM 决定"接下来去哪、干什么、干多久"（意图），本地代码（System1）每帧高频执行
// 走位/绕障/碰撞/动画 —— 即"决策一次、干一会活"。
const PLAN_INTERVAL_MS = 120000; // 每个 NPC 两次规划之间至少 2 分钟
const PLAN_STAGGER_MS = 15000;   // 8 个 NPC 依次错开 15s（总跨度 120s ≈ 一轮），不会同时打 GLM
const PLAN_DUR_MIN = 30;         // 单次活动最短时长（秒）
const PLAN_DUR_MAX = 300;        // 单次活动最长时长（秒）

// ---------- P1：NPC↔NPC 闲聊 ----------
const CHAT_RANGE = 5.0;        // 多近算"凑到一起聊天"（米）
const CHAT_COOLDOWN = 90;      // 同一个学生两次参与闲聊的最小间隔（秒）
const CHAT_INTERVAL = 45;      // 全局两次"新开闲聊"的最小间隔（秒）——控 GLM 调用量
const CHAT_LINE_GAP_MS = 1600; // 台词之间的间隔（气泡一句一句冒，像真在对话）
const CHAT_TEMPLATES = [       // GLM 失败/超预算时的兜底寒暄（零成本，别让"人"僵住）
  ['你今天也在这儿啊？', '嗯，随便转转。'],
  ['刚才那节好困啊。', '可不是嘛，我差点睡着。'],
  ['去食堂吗？', '等我一下，马上。'],
  ['你看见我的笔了吗？', '没注意，问问别人吧。'],
];

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
function clampInt(v, lo, hi, d) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return d;
  return Math.max(lo, Math.min(hi, n));
}
// 心情词 → 三维目标（valence 愉快 / energy 精力 / focus 专注）。模型只会给词，数值由这张表落地。
const MOOD_TABLE = {
  '开心': { v: 0.85, e: 0.65, f: 0.55 },
  '兴奋': { v: 0.9, e: 0.9, f: 0.6 },
  '平静': { v: 0.6, e: 0.5, f: 0.55 },
  '好奇': { v: 0.65, e: 0.6, f: 0.7 },
  '紧张': { v: 0.4, e: 0.55, f: 0.7 },
  '低落': { v: 0.2, e: 0.35, f: 0.4 },
  '烦躁': { v: 0.25, e: 0.5, f: 0.35 },
  '疲惫': { v: 0.4, e: 0.15, f: 0.35 },
};
// 把 LLM 给的 goalType 归一化到已知区域类型 / wander / rest；认不出就当 wander（随便走走），绝不静默卡死
function resolveGoalType(g) {
  const x = String(g || '').trim().toLowerCase();
  if (ZONE_TYPE_IDS.has(x)) return x;
  if (['wander', 'walk', 'roam', 'stroll', '游荡', '散步', '溜达', '随便走走'].includes(x)) return 'wander';
  if (['rest', 'stay', 'idle', 'sit', '休息', '待着', '歇着', '发呆'].includes(x)) return 'rest';
  return 'wander';
}

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
  // LLM → 训练数据（慢环）：列格式与 tools/npc-policy 的 gen_synthetic.py / template.csv 逐字一致，
  // train.py 直接 `--data data/feed` 就能把 LLM 的决策蒸馏进策略网络。
  const FEED_DIR = path.join(dataDir, 'feed');
  const FEED_SFT = path.join(FEED_DIR, 'llm_plan.csv');   // LLM 示范行（状态 → 动作）
  const FEED_PREF = path.join(FEED_DIR, 'llm_pref.csv');  // 偏好行（chosen=LLM 选择 > rejected=规则大脑备选）
  const FEED_MAX_BYTES = 4 * 1024 * 1024;                 // 单文件上限，防无限膨胀
  let feedSftRows = 0;   // 本进程已写入行数（累加型字段，必须有初值，否则 NaN 静默）
  let feedPrefRows = 0;
  let feedLogged = false;

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
        // ⚠ 外接圆半径：只用来快速排除，**必须包住"加了 NPC_PAD 之后"的矩形**，否则四角会漏判。
        //   旧写法 hypot(w,d)/2+PAD = 5.7 < 矩形角 hypot(w/2+PAD, d/2+PAD) = 5.98
        //   ⇒ 矩形的四个角落在剔除圆之外 ⇒ blockedBy 判"没挡"，学生会走进建筑的**贴边角**（探针 [2] 抓到过）。
        rr: Math.hypot(w / 2 + NPC_PAD, d / 2 + NPC_PAD),
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
    buildNavGrid(); // 障碍变了：重建导航网格（A* 用）
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

  // ---------- 寻路（导航网格 A*）----------
  // 为什么要它：局部转向（5 方向扇区）撞到建筑**正面**时转不出 90° 去贴墙滑行 ⇒ 卡死（局部最小）。
  // 做法：由障碍表生成规则网格（判据与 blockedBy 同源），A* 出折线并拉直；服务端沿折线推进，
  // 把**当前路点**作为 wx/wz 下发（客户端照它走位），最终目标仍是 tx/tz（到达判定不变）。
  const NAV_CELL = 2.0;     // 格边长（米）：太细则 A* 慢，太粗则贴不进楼间通道
  const NAV_MARGIN = 12;    // 包围盒外扩（米）
  const NAV_MAX_COLS = 512; // 单边格子上限：超过就不建（防内存爆炸）
  let nav = null;           // { minX, minZ, cols, rows, blocked: Uint8Array }
  function buildNavGrid() {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    const acc = (x, z, r) => { if (!Number.isFinite(x) || !Number.isFinite(z)) return; minX = Math.min(minX, x - r); minZ = Math.min(minZ, z - r); maxX = Math.max(maxX, x + r); maxZ = Math.max(maxZ, z + r); };
    for (const o of obstacles) acc(o.x, o.z, Math.max(o.hw, o.hd) + 1);
    for (const z of zones) { acc(z.minX, z.minZ, 0); acc(z.maxX, z.maxZ, 0); }
    for (const s of students) acc(Number(s.x), Number(s.z), 0);
    if (!Number.isFinite(minX)) { nav = null; return; }
    minX -= NAV_MARGIN; minZ -= NAV_MARGIN; maxX += NAV_MARGIN; maxZ += NAV_MARGIN;
    const cols = Math.min(NAV_MAX_COLS, Math.ceil((maxX - minX) / NAV_CELL) + 1);
    const rows = Math.min(NAV_MAX_COLS, Math.ceil((maxZ - minZ) / NAV_CELL) + 1);
    const blockedGrid = new Uint8Array(cols * rows);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) blockedGrid[j * cols + i] = blockedBy(minX + (i + 0.5) * NAV_CELL, minZ + (j + 0.5) * NAV_CELL) ? 1 : 0;
    }
    nav = { minX, minZ, cols, rows, blocked: blockedGrid };
  }
  function cellI(x) { return Math.floor((x - nav.minX) / NAV_CELL); }
  function cellJ(z) { return Math.floor((z - nav.minZ) / NAV_CELL); }
  function cellCX(i) { return nav.minX + (i + 0.5) * NAV_CELL; }
  function cellCZ(j) { return nav.minZ + (j + 0.5) * NAV_CELL; }
  function navBlocked(i, j) { return (i < 0 || j < 0 || i >= nav.cols || j >= nav.rows) ? true : nav.blocked[j * nav.cols + i] === 1; }
  // 起点/终点落在障碍里时，找最近的可通行格
  function nearestFreeCell(i, j) {
    if (!navBlocked(i, j)) return [i, j];
    for (let r = 1; r <= 8; r++) {
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          if (!navBlocked(i + di, j + dj)) return [i + di, j + dj];
        }
      }
    }
    return null;
  }
  // 两点连线是否不穿障碍（用于把折线拉直）
  function lineFree(x0, z0, x1, z1) {
    const d = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.max(1, Math.ceil(d / (NAV_CELL * 0.5)));
    for (let k = 1; k < n; k++) { const t = k / n; if (blockedBy(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t)) return false; }
    return true;
  }
  const NAV_DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.4142], [1, -1, 1.4142], [-1, 1, 1.4142], [-1, -1, 1.4142]];
  // A*：返回世界坐标折线（含终点、不含起点格），失败返回 null
  function findPath(sx, sz, tx, tz) {
    if (!nav) return null;
    const a = nearestFreeCell(cellI(sx), cellJ(sz));
    const b = nearestFreeCell(cellI(tx), cellJ(tz));
    if (!a || !b) return null;
    const ai = a[0], aj = a[1], bi = b[0], bj = b[1];
    if (ai === bi && aj === bj) return null; // 同一格：直走即可
    const cols = nav.cols, N = cols * nav.rows;
    const start = aj * cols + ai, goal = bj * cols + bi;
    const g = new Float64Array(N).fill(Infinity);
    const came = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const hf = (i, j) => { const dx = Math.abs(i - bi), dz = Math.abs(j - bj); return (dx + dz) + (1.4142 - 2) * Math.min(dx, dz); };
    // 简易二叉最小堆
    const heap = []; const hkey = [];
    const push = (k, f) => {
      heap.push(k); hkey.push(f); let c = heap.length - 1;
      while (c > 0) { const p = (c - 1) >> 1; if (hkey[p] <= hkey[c]) break; const tk = heap[p], tf = hkey[p]; heap[p] = heap[c]; hkey[p] = hkey[c]; heap[c] = tk; hkey[c] = tf; c = p; }
    };
    const pop = () => {
      const top = heap[0]; const lk = heap.pop(), lf = hkey.pop();
      if (heap.length) {
        heap[0] = lk; hkey[0] = lf; let p = 0;
        for (;;) { const l = p * 2 + 1, r = l + 1; let m = p; if (l < heap.length && hkey[l] < hkey[m]) m = l; if (r < heap.length && hkey[r] < hkey[m]) m = r; if (m === p) break; const tk = heap[p], tf = hkey[p]; heap[p] = heap[m]; hkey[p] = hkey[m]; heap[m] = tk; hkey[m] = tf; p = m; }
      }
      return top;
    };
    g[start] = 0; push(start, hf(ai, aj));
    while (heap.length) {
      const cur = pop();
      if (cur === goal) break;
      if (closed[cur]) continue;
      closed[cur] = 1;
      const ci = cur % cols, cj = (cur - ci) / cols;
      for (const dir of NAV_DIRS) {
        const ni = ci + dir[0], nj = cj + dir[1];
        if (navBlocked(ni, nj)) continue;
        if (dir[0] !== 0 && dir[1] !== 0 && (navBlocked(ci + dir[0], cj) || navBlocked(ci, cj + dir[1]))) continue; // 不切角
        const nk = nj * cols + ni;
        if (closed[nk]) continue;
        const ng = g[cur] + dir[2];
        if (ng < g[nk]) { g[nk] = ng; came[nk] = cur; push(nk, ng + hf(ni, nj)); }
      }
    }
    if (came[goal] === -1) return null; // 不连通
    const cells = [];
    let k = goal;
    while (k !== start && k !== -1) { const i = k % cols; cells.push(cellCX(i), cellCZ((k - i) / cols)); k = came[k]; }
    if (k === -1) return null;
    cells.push(cellCX(ai), cellCZ(aj));
    cells.reverse(); // [x0,z0, x1,z1, ...] 起点在前
    // 拉直：从当前位置贪心跳过中间点（直线可达就跳），并把最终目标接上
    const pts = [];
    let cx = sx, cz = sz, idx = 2; // 跳过起点格
    while (idx < cells.length) {
      let best = idx;
      for (let m = cells.length - 2; m >= idx; m -= 2) { if (lineFree(cx, cz, cells[m], cells[m + 1])) { best = m; break; } }
      pts.push({ x: cells[best], z: cells[best + 1] });
      cx = cells[best]; cz = cells[best + 1];
      if (best + 2 <= idx) break; // 防死循环
      idx = best + 2;
    }
    if (!pts.length) return null;
    if (lineFree(cx, cz, tx, tz)) pts.push({ x: tx, z: tz });
    return pts;
  }
  // 设目标 + 立刻算一条路径；wx/wz = 当前路点（没路径就直奔目标）
  function setTarget(s, x, z) {
    s.tx = x; s.tz = z; s.pathTries = 0;
    s.path = nav ? findPath(Number(s.x), Number(s.z), x, z) : null;
    s.pathIdx = 0;
    if (s.path && s.path.length) { s.wx = s.path[0].x; s.wz = s.path[0].z; }
    else { s.wx = x; s.wz = z; }
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
          wx: px,   // 当前路点（A* 绕行点；没路径时 = 目标点）；客户端照它走位
          wz: pz,
          path: null,    // A* 折线 [{x,z},...]；null = 直走
          pathIdx: 0,
          pathTries: 0,  // 卡住后重算路径的次数（累加型字段，必须有初值）
          chatAt: 0,        // 上次参与闲聊的时刻（限流用；累加/时间型字段，必须有初值）
          talkingUntil: 0,  // 闲聊占用到的时刻（这段时间内别再开聊、先站住）
          walkUntil: 0, // 本次行走的放弃时刻（毫秒）
          stuck: 0,     // 连续没位移的拍数（累加型字段，必须有初值）
          rot: 0,
          st: 'idle',
          zoneId: '',
          stayUntil: 0,
          decideAt: 0,
          planAt: Date.now() + i * PLAN_STAGGER_MS, // 错峰：第 i 个学生延后 i*15s 才首次规划（避免 8 个同时打 GLM）
          intent: null,  // System2 规划出的意图：{goalType,goalText,activity,plan,since}
          aiAt: 0,
          needs: (old && old.needs) || { hunger: rand(0, 0.5), fun: rand(0, 0.5), study: rand(0, 0.5), fatigue: rand(0, 0.3), social: rand(0, 0.5), bladder: rand(0, 0.3) },
          // 心情（会被对话改）+ 关系（对某人/某玩家的好感）——「像真人」的两个内在状态
          mood: (old && old.mood) || { valence: rand(0.4, 0.6), energy: rand(0.5, 0.7), focus: rand(0.4, 0.6) },
          rel: (old && old.rel && typeof old.rel === 'object') ? old.rel : {},
          mem: Array.isArray(old && old.mem) ? old.mem : [],
          think: Array.isArray(old && old.think) ? old.think : [],
        };
      });
      dirty = true;
    }
    // 补齐后加的字段（避免老存档缺字段导致 undefined 参与运算 → NaN 静默失效）
    for (const s of list) {
      if (!s.needs || typeof s.needs !== 'object') { s.needs = { hunger: 0.3, fun: 0.3, study: 0.3, fatigue: 0.2, social: 0.3, bladder: 0.2 }; dirty = true; }
      if (!s.mood || typeof s.mood !== 'object') { s.mood = { valence: 0.5, energy: 0.6, focus: 0.5 }; dirty = true; }
      if (!s.rel || typeof s.rel !== 'object') { s.rel = {}; dirty = true; }
      if (!Array.isArray(s.mem)) { s.mem = []; dirty = true; }
      if (!Array.isArray(s.think)) { s.think = []; dirty = true; }
      if (!Number.isFinite(Number(s.rot))) { s.rot = 0; dirty = true; }
      if (!Number.isFinite(Number(s.stayUntil))) { s.stayUntil = 0; dirty = true; }
      if (!Number.isFinite(Number(s.decideAt))) { s.decideAt = 0; dirty = true; }
      if (!Number.isFinite(Number(s.planAt))) { s.planAt = 0; dirty = true; }
      if (s.intent !== null && typeof s.intent !== 'object') { s.intent = null; dirty = true; }
      if (!Number.isFinite(Number(s.aiAt))) { s.aiAt = 0; dirty = true; }
      // 后加的字段：老存档没有 ⇒ 不补就是 undefined 参与运算 → NaN → 人不动/消失（静默失效）
      if (!Number.isFinite(Number(s.hx))) { s.hx = Number(s.x) || 0; dirty = true; }
      if (!Number.isFinite(Number(s.hz))) { s.hz = Number(s.z) || 0; dirty = true; }
      if (!Number.isFinite(Number(s.tx))) { s.tx = Number(s.x) || 0; dirty = true; }
      if (!Number.isFinite(Number(s.tz))) { s.tz = Number(s.z) || 0; dirty = true; }
      if (!Number.isFinite(Number(s.wx))) { s.wx = Number(s.tx) || 0; dirty = true; }
      if (!Number.isFinite(Number(s.wz))) { s.wz = Number(s.tz) || 0; dirty = true; }
      if (s.path !== null && !Array.isArray(s.path)) { s.path = null; dirty = true; }
      if (!Number.isFinite(Number(s.pathIdx))) { s.pathIdx = 0; dirty = true; }
      if (!Number.isFinite(Number(s.pathTries))) { s.pathTries = 0; dirty = true; }
      if (!Number.isFinite(Number(s.chatAt))) { s.chatAt = 0; dirty = true; }
      if (!Number.isFinite(Number(s.talkingUntil))) { s.talkingUntil = 0; dirty = true; }
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
      setTarget(s, x, z);
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
    // 心情偏置：心情差 / 没力气又不上课 → 更想回去歇；心情好又有精力 → 更想去活动（"对话改变它"落到行为）
    const mood = s.mood || { valence: 0.5, energy: 0.6 };
    if (!(seg && seg.type === 'classroom')) {
      if (Number(mood.energy) < 0.35 && Math.random() < 0.5) { const d = pickOne(zonesOfType('dorm')); if (d) { goZone(s, now, d); return; } }
      if (Number(mood.valence) > 0.72 && Number(mood.energy) > 0.68 && Math.random() < 0.35) {
        const p = pickOne(zonesOfType('playground')) || pickOne(zonesOfType('fountain'));
        if (p) { goZone(s, now, p); return; }
      }
    }
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
    setTarget(s, p.x, p.z); // 设目标 + A* 算路（wx/wz = 首路点）
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
        s.zoneId = ''; setTarget(s, Number(p.x), Number(p.z));
        s.st = 'walk'; s.walkUntil = now + WALK_TIMEOUT * 1000; s.stuck = 0;
        s.decideAt = now + rand(DECIDE_MIN, DECIDE_MAX) * 1000; return;
      }
      wander(s, now); return;
    }
    wander(s, now);
  }

  // ---------- LLM → 训练数据（"用 LLM 训练神经网络"的闭环 / 慢环） ----------
  // 每次 LLM 规划成功，就把「状态向量 → 它选的动作」追加进 data/feed/：
  //   SFT 行（llm_plan.csv）：教策略网络（System1）模仿 LLM 的选择（蒸馏 / 行为克隆）；
  //   偏好行（llm_pref.csv）：chosen=LLM 的选择、rejected=规则大脑的备选 → 给 train.py 的 DPO 阶段。
  // 于是 System1 越训越像 LLM ⇒ LLM 可以调得越稀疏（System2 只在关键时刻出场）。
  function feedFull(file) { try { return fs.statSync(file).size > FEED_MAX_BYTES; } catch { return false; } }
  function ensureHeader(file, header) { try { if (!fs.existsSync(file)) fs.writeFileSync(file, header + '\n'); } catch { /* 写不了就算了 */ } }
  // 状态 → CSV 单元格（STATE_KEYS 顺序）。用 buildState()（与推理端同一段逻辑），只把 hour 还原成原始小时。
  function stateCells(s) {
    const v = buildState(s);
    const cells = [];
    for (let i = 0; i < STATE_KEYS.length; i++) {
      // ⚠ hour 列必须是**原始小时**（0~24）：train.py 的 build_x 会再 /24；若写归一化值会被二次除。
      const val = STATE_KEYS[i] === 'hour' ? hourNow() : v[i];
      cells.push(Math.round(Number(val) * 10000) / 10000);
    }
    return cells;
  }
  function actionOfGoal(g) { return (g === 'wander' || g === 'rest') ? g : (ACTIONS.includes(g) ? g : 'other'); }
  // 规则大脑会选的备选动作（作为 DPO 的 rejected）：课程表时段优先，否则按最迫切需求
  function ruleAltAction(s) { const seg = scheduleType(hourNow()); return seg ? seg.type : needType(s); }
  function recordPlanFeed(s, goalType) {
    try {
      const action = actionOfGoal(goalType);
      if (!ACTIONS.includes(action)) return;
      fs.mkdirSync(FEED_DIR, { recursive: true });
      const cells = stateCells(s);
      if (!feedFull(FEED_SFT)) {
        ensureHeader(FEED_SFT, STATE_KEYS.join(',') + ',action,weight');
        fs.appendFileSync(FEED_SFT, cells.join(',') + ',' + action + ',1\n');
        feedSftRows++;
      }
      const alt = ruleAltAction(s);
      if (alt && alt !== action && ACTIONS.includes(alt) && !feedFull(FEED_PREF)) {
        ensureHeader(FEED_PREF, STATE_KEYS.join(',') + ',chosen,rejected');
        fs.appendFileSync(FEED_PREF, cells.join(',') + ',' + action + ',' + alt + '\n');
        feedPrefRows++;
      }
      if (!feedLogged) {
        feedLogged = true;
        console.info('[npc] LLM 决策开始回写训练集 ' + FEED_DIR + '/llm_plan.csv（train.py --data data/feed 即可蒸馏）');
      }
    } catch (e) {
      /* 采集失败绝不影响行为（静默降级） */
    }
  }

  // ---------- System2：LLM 低频规划（"灵魂"） ----------
  // 每个 NPC 每隔 PLAN_INTERVAL_MS 让 GLM 想一次"接下来去哪、干什么、干多久"，落地成 s.intent；
  // 本地代码（System1）每帧按 intent 走位/绕障/碰撞/动画（决策一次、干一会活）。
  // 失败 / 超时 / 没配 GLM → 回退 decide()（规则大脑 / 策略网络），零行为回归风险。
  function planNext(s, now) {
    if (s._planning) return;
    s._planning = true;
    s.planAt = now + PLAN_INTERVAL_MS; // 先占住下一个 slot，避免 await 期间被主循环重复触发
    (async () => {
      try {
        const h = hourNow();
        const seg = scheduleType(h);
        const out = await askStudent({
          student: { name: s.name, cls: s.cls, persona: s.persona, sex: s.sex, place: placeOf(s), st: s.st, needs: s.needs, mood: s.mood, rel: topRel(s) },
          memory: pickMemory(s, null),
          kind: 'plan',
          hour: h,
          schedule: seg ? seg.label : '自由活动',
        });
        if (!out || !out.goalType) {
          // GLM 没给有效意图 → 回退规则大脑（保留走位能力，不静默卡死）
          s.intent = null;
          s.decideAt = now;
          decide(s, now);
          return;
        }
        const goalType = resolveGoalType(out.goalType);
        const durMs = clampInt(out.durationSec, PLAN_DUR_MIN, PLAN_DUR_MAX, 60) * 1000;
        s.intent = {
          goalType,
          goalText: clampText(out.goal || '', 80),
          activity: clampText(out.activity || '', 120),
          plan: clampText(out.plan || '', 200),
          since: now,
        };
        recordPlanFeed(s, goalType); // 慢环：把这次 LLM 决策写成训练标签（SFT + DPO 偏好对）
        // plan 自带的内心考量入库（驱动记忆与后续举止）
        const thought = clampText(out.thought, LEN_THINK);
        if (thought) {
          s.think.push({ t: now, text: thought });
          if (s.think.length > MEM_MAX) s.think.splice(0, s.think.length - MEM_MAX);
          saveStudents(students);
        }
        if (goalType === 'rest') {
          s.st = 'act';
          s.stayUntil = Math.max(now + durMs, now + PLAN_INTERVAL_MS);
          s.planAt = now + PLAN_INTERVAL_MS;
          s.decideAt = s.planAt;
          return;
        }
        if (goalType === 'wander') { wander(s, now); s.planAt = now + PLAN_INTERVAL_MS; s.decideAt = s.planAt; return; }
        const target = pickOne(zonesOfType(goalType));
        if (!target) { wander(s, now); s.planAt = now + PLAN_INTERVAL_MS; s.decideAt = s.planAt; return; } // 没这种区域：自由漫步兜底
        goZone(s, now, target);          // 落地走位目标
        s._stayMs = durMs;               // 到达后按 plan 的时长停留（决策一次、干一会活）
        s.planAt = now + PLAN_INTERVAL_MS;
        s.decideAt = s.planAt;            // 首轮之后不再走规则大脑分支，直到下一个规划点
        console.info('[npc] ' + s.name + ' 规划→ ' + goalType + '：' + (s.intent.goalText || '') + '（停留 ' + Math.round(durMs / 1000) + 's）');
      } catch (e) {
        // 任何异常都降级，绝不静默卡死
        s.intent = null;
        s.decideAt = now;
        try { decide(s, now); } catch { s.st = 'idle'; s.planAt = now + PLAN_INTERVAL_MS; }
      } finally {
        s._planning = false;
      }
    })();
  }

  // 朝当前**路点**走一步（路点由 A* 给出，绕开建筑）；到达**最终目标**(tx/tz)才算到。
  // 被建筑挡住就左右试探绕行（最多 5 个方向，全挡住就原地等下一拍/重算路径）。
  function stepMove(s, dt) {
    const fdx = Number(s.tx) - Number(s.x);
    const fdz = Number(s.tz) - Number(s.z);
    const fdist = Math.hypot(fdx, fdz);
    if (!Number.isFinite(fdist) || fdist < ARRIVE_DIST) return true; // 到了最终目标
    const stepLen = WALK_SPEED * dt;
    // 取当前路点；到路点就推进（并用视线拉直，跳过直线可达的更远点）
    let wx = Number(s.wx), wz = Number(s.wz);
    if (!Number.isFinite(wx) || !Number.isFinite(wz)) { wx = Number(s.tx); wz = Number(s.tz); }
    if (Math.hypot(wx - Number(s.x), wz - Number(s.z)) < Math.max(0.6, stepLen * 1.5)) {
      if (Array.isArray(s.path) && Number(s.pathIdx) < s.path.length - 1) {
        let k = Number(s.pathIdx) + 1;
        while (k + 1 < s.path.length && lineFree(Number(s.x), Number(s.z), s.path[k + 1].x, s.path[k + 1].z)) k++;
        s.pathIdx = k; s.wx = s.path[k].x; s.wz = s.path[k].z;
      } else {
        s.path = null; s.pathIdx = 0; s.wx = Number(s.tx); s.wz = Number(s.tz);
      }
      wx = Number(s.wx); wz = Number(s.wz);
    }
    let dx = wx - Number(s.x), dz = wz - Number(s.z);
    let dist = Math.hypot(dx, dz);
    if (!Number.isFinite(dist) || dist < 1e-6) { dx = fdx; dz = fdz; dist = fdist; } // 退化：直奔最终目标
    const ux = dx / dist;
    const uz = dz / dist;
    // 脱困：正站在障碍里（出生点落楼里 / 场景改动被压住）→ 朝"背离这栋楼"的方向挪到出楼为止。
    // ⚠ 方向必须背离楼心，不能朝目标走（朝目标走 = 允许横穿整栋楼，真·穿墙）。
    const hit = blockedBy(Number(s.x), Number(s.z));
    if (hit) {
      let ex = Number(s.x) - hit.x;
      let ez = Number(s.z) - hit.z;
      let el = Math.hypot(ex, ez);
      if (!(el > 1e-3)) { ex = ux; ez = uz; el = 1; } // 正好压在楼中心：退化成朝路点挪
      ex /= el;
      ez /= el;
      // 向外挪一步**还站在楼里**（贴边/贴角时径向出楼要走好几步）就继续挪到出楼为止（带上限防死循环）。
      let nx = Number(s.x) + ex * stepLen;
      let nz = Number(s.z) + ez * stepLen;
      for (let i = 0; i < 24 && blocked(nx, nz); i++) { nx += ex * stepLen; nz += ez * stepLen; }
      s.x = nx;
      s.z = nz;
      s.rot = (Math.atan2(-ex, -ez) * 180) / Math.PI;
      return false;
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
    return false; // 全被挡：这一拍不动（下一拍重算路径再试）
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
    // 心情缓慢回归基线（没有新刺激就淡下去；对话/事件把它拉高或拉低）
    if (s.mood) {
      const k = dt * 0.01;
      s.mood.valence = clamp01(Number(s.mood.valence) + (0.5 - Number(s.mood.valence)) * k);
      s.mood.energy = clamp01(Number(s.mood.energy) + (0.5 - Number(s.mood.energy)) * k);
      s.mood.focus = clamp01(Number(s.mood.focus) + (0.5 - Number(s.mood.focus)) * k);
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
  // 心情词 → 落地成数值（0.5 权重混合，避免一次对话把情绪拉爆）
  function applyMoodWord(s, word) {
    const m = MOOD_TABLE[String(word || '').replace(/\s/g, '')];
    if (!m) return;
    const old = s.mood || { valence: 0.5, energy: 0.6, focus: 0.5 };
    s.mood = {
      valence: clamp01(Number(old.valence) * 0.5 + m.v * 0.5),
      energy: clamp01(Number(old.energy) * 0.5 + m.e * 0.5),
      focus: clamp01(Number(old.focus) * 0.5 + m.f * 0.5),
    };
  }
  // 关系增量（s 对 who 的信任/好感）
  function bumpRel(s, who, delta, note) {
    if (!who || !Number.isFinite(Number(delta))) return;
    const cur = (s.rel[who] && typeof s.rel[who] === 'object') ? s.rel[who] : { trust: 0 };
    cur.trust = Math.max(-1, Math.min(1, (Number(cur.trust) || 0) + Number(delta)));
    cur.last = Date.now();
    if (note) cur.note = clampText(note, LEN_MEM);
    s.rel[who] = cur;
  }
  // 对话"影响"落地：改心情、改对说话人的关系、必要时**直接改道**（这是"对话能改变它"的核心）。
  function applyTalkEffect(s, out, who) {
    if (!out) return;
    applyMoodWord(s, out.mood);
    if (Number.isFinite(Number(out.affinity))) bumpRel(s, who, Number(out.affinity) * 0.6, out.mem);
    // 因对话改道：只接受合法目标（已知区域 / wander / rest），其余忽略（不臆造去处）
    const raw = String(out.goalType || '').trim().toLowerCase();
    const gt = (raw === 'wander' || raw === 'rest') ? raw : (ZONE_TYPE_IDS.has(raw) ? raw : null);
    if (!gt) return;
    const note = '（受对话影响）' + clampText(out.mem || out.say || '', 40);
    if (gt === 'rest') {
      s.st = 'act'; s.stayUntil = Date.now() + 30000;
      s.intent = { goalType: 'rest', goalText: note, activity: '', plan: '', since: Date.now() };
      return;
    }
    if (gt === 'wander') { wander(s, Date.now()); }
    else { const z = pickOne(zonesOfType(gt)); if (!z) return; goZone(s, Date.now(), z); }
    s.intent = { goalType: gt, goalText: note, activity: '', plan: '', since: Date.now() };
  }
  // 给 LLM 的关系摘要：只挑好感/反感最强的几条（别把整张关系表塞进 prompt）
  function topRel(s) {
    const r = s.rel || {};
    const items = Object.entries(r).map(([k, v]) => ({ k, t: Number(v && v.trust) || 0 }))
      .filter((x) => Math.abs(x.t) > 0.05).sort((a, b) => Math.abs(b.t) - Math.abs(a.t)).slice(0, 3);
    const out = {};
    for (const it of items) out[it.k] = Math.round(it.t * 100) / 100;
    return out;
  }

  // ---------- P1：NPC↔NPC 闲聊（同学之间"活起来"）----------
  // 一次 LLM 出一段 2~4 句脚本 → 双方各写记忆（含对方）、改心情、改彼此关系；台词逐句广播（玩家能偷听）。
  // 全局限流（CHAT_INTERVAL）+ 个人冷却（CHAT_COOLDOWN）+ 模板兜底 = 不刷爆 GLM、也绝不静默卡住。
  function pickChatPair(now) {
    let best = null, bd = CHAT_RANGE * CHAT_RANGE;
    for (let i = 0; i < students.length; i++) {
      const a = students[i];
      if (a._chatting || now < Number(a.talkingUntil || 0) || now - Number(a.chatAt || 0) < CHAT_COOLDOWN * 1000) continue;
      if (a.st !== 'idle' && a.st !== 'act') continue;
      for (let j = i + 1; j < students.length; j++) {
        const b = students[j];
        if (b._chatting || now < Number(b.talkingUntil || 0) || now - Number(b.chatAt || 0) < CHAT_COOLDOWN * 1000) continue;
        if (b.st !== 'idle' && b.st !== 'act') continue;
        const dx = Number(a.x) - Number(b.x), dz = Number(a.z) - Number(b.z);
        const d = dx * dx + dz * dz;
        if (d < bd) { bd = d; best = [a, b]; }
      }
    }
    return best;
  }
  // GLM 失败/空脚本时的兜底寒暄（零成本，别让"人"僵住）
  function templateChat(a, b) {
    const tpl = CHAT_TEMPLATES[Math.floor(Math.random() * CHAT_TEMPLATES.length)];
    const t0 = Date.now();
    a.st = 'act'; b.st = 'act';
    a.stayUntil = Math.max(Number(a.stayUntil || 0), t0 + 5000);
    b.stayUntil = Math.max(Number(b.stayUntil || 0), t0 + 5000);
    broadcast({ t: 'npc_say', id: a.id, say: tpl[0] });
    const tm = setTimeout(() => broadcast({ t: 'npc_say', id: b.id, say: tpl[1] }), CHAT_LINE_GAP_MS);
    if (tm.unref) tm.unref();
    a.mem.push({ t: t0, text: '我和' + b.name + '聊了两句：' + tpl[0], kind: 'chat', from: b.id });
    b.mem.push({ t: t0, text: '我和' + a.name + '聊了两句：' + tpl[1], kind: 'chat', from: a.id });
  }
  let chatBusy = false; // 同一时刻只跑一段闲聊（控并发 / 额度）
  async function converse(a, b) {
    if (chatBusy || !a || !b || a === b) return;
    chatBusy = true;
    a._chatting = true; b._chatting = true;
    const t0 = Date.now();
    a.chatAt = t0; b.chatAt = t0;
    a.talkingUntil = t0 + 20000; b.talkingUntil = t0 + 20000; // 期间别再开聊、先站住
    try {
      const bond = Number((a.rel[b.id] && a.rel[b.id].trust) || 0);
      const out = await askStudent({
        student: { name: a.name, cls: a.cls, persona: a.persona, sex: a.sex, place: placeOf(a), st: a.st, needs: a.needs, mood: a.mood, rel: topRel(a) },
        partner: { name: b.name, cls: b.cls, persona: b.persona, sex: b.sex },
        memory: pickMemory(a, null),
        kind: 'chat',
        bond,
      });
      const lines = (out && Array.isArray(out.lines)) ? out.lines.slice(0, 4) : [];
      if (!lines.length) { templateChat(a, b); return; }
      // 逐句广播（复用 npc_say → 客户端气泡；玩家能偷听到他们的对话）
      lines.forEach((ln, i) => {
        const who = ln.who === 'b' ? b : a;
        const say = clampText(ln.text, LEN_SAY);
        if (!say) return;
        const delay = i * CHAT_LINE_GAP_MS;
        if (delay === 0) broadcast({ t: 'npc_say', id: who.id, say });
        else { const tm = setTimeout(() => broadcast({ t: 'npc_say', id: who.id, say }), delay); if (tm.unref) tm.unref(); }
      });
      a.st = 'act'; b.st = 'act';
      const chatEnd = t0 + lines.length * CHAT_LINE_GAP_MS + 1500;
      a.stayUntil = Math.max(Number(a.stayUntil || 0), chatEnd);
      b.stayUntil = Math.max(Number(b.stayUntil || 0), chatEnd);
      // 记忆（各自记）+ 心情 + 彼此关系（双向）
      if (out.memA) a.mem.push({ t: t0, text: clampText(out.memA, LEN_MEM), kind: 'chat', from: b.id });
      if (out.memB) b.mem.push({ t: t0, text: clampText(out.memB, LEN_MEM), kind: 'chat', from: a.id });
      applyMoodWord(a, out.moodA);
      applyMoodWord(b, out.moodB);
      if (Number.isFinite(Number(out.bond))) { bumpRel(a, b.id, Number(out.bond) * 0.5); bumpRel(b, a.id, Number(out.bond) * 0.5); }
      await trimMemory(a); await trimMemory(b);
      saveStudents(students);
      console.info('[npc] ' + a.name + ' ↔ ' + b.name + ' 闲聊：' + (clampText(out.topic, 16) || ''));
    } catch (e) {
      console.warn('[npc] 闲聊失败 ' + a.id + '↔' + b.id + '：' + ((e && e.message) || e));
      try { templateChat(a, b); } catch { /* 兜底也失败就算了 */ }
    } finally {
      a._chatting = false; b._chatting = false;
      const until = Date.now() + CHAT_COOLDOWN * 1000;
      a.talkingUntil = until; b.talkingUntil = until;
      chatBusy = false;
    }
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
          mood: s.mood,      // 心情（被对话改）→ 这次说话/行动带着情绪
          rel: topRel(s),    // 关系摘要（被对话改）→ 记得跟谁亲、跟谁不对付
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
      // 对话的"影响"：改心情 / 改关系 / 必要时改道（只对 talk/chat 生效）
      if (kind === 'talk' || kind === 'chat') {
        try { applyTalkEffect(s, out, extra && extra.who); }
        catch (e) { console.warn('[npc] 对话影响应用失败 ' + s.id + '：' + ((e && e.message) || e)); }
      }
      saveStudents(students);
      return { say, think };
    } catch (e) {
      // ⚠ 绝不静默吞异常：AI 挂了必须能在 relay 日志里看见，否则只表现为"他没理我/没气泡"
      console.warn('[npc] AI 调用失败 ' + s.id + '（' + kind + '）：' + ((e && e.message) || e));
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
  let lastChatStart = 0;         // 上一次"新开闲聊"的时刻（累加型字段，必须有初值）
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
    const typeCount = new Map(); // 每区域类型有几个人：一次 O(n) 统计，别用 some 扫成 O(n²)
    for (const s of students) {
      const zn = zoneAt(Number(s.x), Number(s.z));
      zoneOf.set(s, zn);
      const t = zn ? zn.type : '\u0000none';
      typeCount.set(t, (typeCount.get(t) || 0) + 1);
    }
    for (const s of students) {
      const zn = zoneOf.get(s);
      const myType = zn ? zn.type : '\u0000none';
      s._nearFriend = (myType !== '\u0000none' && typeCount.get(myType) > 1) ? 1 : 0;
      s._playerNear = playerPositions.some((p) => {
        const dx = Number(p.x) - Number(s.x), dz = Number(p.z) - Number(s.z);
        return dx * dx + dz * dz < 64; // 8m 内算"玩家在附近"
      }) ? 1 : 0;
    }
    for (const s of students) {
      updateNeeds(s, dt, now);
      if (s.st === 'act') {
        if (now >= Number(s.stayUntil || 0)) { s.st = 'idle'; }
      } else if (s.st === 'walk') {
        const bx = Number(s.x);
        const bz = Number(s.z);
        const arrived = stepMove(s, dt);
        if (arrived) {
          s.st = 'act';
          // 按 plan 的时长停留（决策一次、干一会活）；至少覆盖到下一次规划点，活动短也不至于杵着发呆
          const stayMs = Number.isFinite(Number(s._stayMs)) ? Number(s._stayMs) : rand(STAY_MIN, STAY_MAX) * 1000;
          s.stayUntil = Math.max(now + stayMs, Number(s.planAt || 0));
          s._stayMs = undefined;
          s.stuck = 0;
          // 到达目的地：触发一次内心独白（内部有冷却，绝大多数会被节流掉）
          triggerAI(s, 'arrive');
        } else {
          // ⚠ 没有这两条兜底，目标不可达（点在墙里 / 五个方向全被挡）会**永久卡在 walk**：
          //   永远不会到达、decideAt 也永远不刷新 ⇒ 人再也不动，而且零报错。
          const moved = Math.hypot(Number(s.x) - bx, Number(s.z) - bz);
          s.stuck = moved > 0.02 ? 0 : Number(s.stuck || 0) + 1;
          if (s.stuck >= STUCK_TICKS || now >= Number(s.walkUntil || 0)) {
            // 先重算路径（局部最小 / 障碍刚变）；试过还是卡才放弃，且**绝不重置 planAt**
            // ⚠ 曾经这里设 planAt = now + 8000：一卡就每 8s 重调一次 GLM，8 个 NPC 频繁卡会把
            //   调用量刷到设计值（4 次/分）的十几倍 ⇒ 服务端/额度开销飙升。规则大脑兜底足够，且不花 LLM。
            if (Number(s.pathTries || 0) < 2 && nav) {
              s.pathTries = Number(s.pathTries || 0) + 1;
              setTarget(s, Number(s.tx), Number(s.tz));
              s.stuck = 0;
            } else {
              s.st = 'idle';
              s.decideAt = now; // 只走规则大脑兜底；planAt 保持原 2 分钟节奏（不额外调 LLM）
              s.stuck = 0;
            }
          }
        }
      } else if (now >= Number(s.planAt || 0) && !s._planning) {
        planNext(s, now); // System2：低频 LLM 规划（失败自动回退规则大脑）
      } else if (now >= Number(s.decideAt || 0)) {
        // 仅在首次 LLM 规划之前用规则大脑 / 漫步保活，避免开局集体杵着不动
        if (hasZones) decide(s, now); else wander(s, now);
      }
    }
    // NPC↔NPC 闲聊：凑近 + 都闲着 → 开一段短对话（全局 CHAT_INTERVAL 限流，防刷 GLM）
    if (!chatBusy && now - lastChatStart > CHAT_INTERVAL * 1000) {
      const pair = pickChatPair(now);
      if (pair) { lastChatStart = now; converse(pair[0], pair[1]); }
    }
    // ⚠ 无论有没有区域都要广播：以前没区域时直接 return，客户端连一次更新都收不到（表现为"人都定住了"）
    if (now - lastBroadcast >= BROADCAST_MS) {
      lastBroadcast = now;
      // ⚠ 客户端自己驱动走位：下发 wx/wz（**当前路点**，A* 给的绕行点）让客户端照它走；tx/tz 仍是
      //   **最终目标**（到达判定/probes 观测用）。x/z/rot 是服务端 ghost（供 probe 观测，客户端忽略）。
      //   老客户端不认 wx/wz 就退回用 tx/tz（= 直走，行为不回归）。
      broadcast({ t: 'npc', list: students.map((s) => ({ id: s.id, x: round2(s.x), z: round2(s.z), tx: round2(s.tx), tz: round2(s.tz), wx: round2(s.wx), wz: round2(s.wz), rot: round1(s.rot), st: s.st, goal: s.intent ? (s.intent.goalType || '') : '' })) });
    }
  }, TICK_MS);
  if (timer.unref) timer.unref();

  function round2(v) { return Math.round(Number(v || 0) * 100) / 100; }
  function round1(v) { return Math.round(Number(v || 0) * 10) / 10; }

  // ---------- 对外接口 ----------
  // 玩家搭话：必触发 AI（不受冷却限制），返回 {say, think} 并广播气泡。
  // ⚠ 两端都不再把 think 发给客户端：心理活动是**内部**的（驱动记忆与行为），玩家不该在对话栏看到它。
  // ⚠ except：发起者自己已经收到 npc_reply，广播要跳过他，否则同一句话出现两遍。
  async function talk(studentId, text, playerName, except, whoId) {
    const s = students.find((x) => x.id === String(studentId));
    if (!s) return null;
    // whoId：说话人的稳定标识（如 'p:<玩家id>'）→ 关系按人记，换个玩家是另一段交情
    const out = await triggerAI(s, 'talk', { text: String(text || '').slice(0, 200), name: playerName || '同学', who: whoId ? String(whoId).slice(0, 40) : '' });
    if (!out) return { say: '', think: '' };
    broadcast({ t: 'npc_say', id: s.id, say: out.say }, except);
    return out;
  }
  // 调试/探针用：读某个学生的内在状态（心情/关系/意图）
  function stateOf(id) {
    const s = students.find((x) => x.id === String(id));
    if (!s) return null;
    return { mood: { ...s.mood }, rel: { ...(s.rel || {}) }, intent: s.intent ? { ...s.intent } : null, mem: (s.mem || []).slice(-3), st: s.st, x: s.x, z: s.z, tx: s.tx, tz: s.tz };
  }
  // 调试/探针用：手动撮合一段闲聊
  function forceChat(aId, bId) {
    const a = students.find((x) => x.id === String(aId));
    const b = students.find((x) => x.id === String(bId));
    if (!a || !b) return null;
    return converse(a, b);
  }

  // 给新连上的客户端一份完整名单（名字/班级/初始坐标 + 初始目标点）
  function roster() {
    return students.map((s) => ({
      id: s.id, name: s.name, cls: s.cls, sex: s.sex,
      // ⚠ 初始坐标 x/z 给客户端落地 pstate；目标点 tx/tz 给客户端定初始走向（客户端驱动走位）
      x: round2(s.x), z: round2(s.z), tx: round2(s.tx), tz: round2(s.tz), wx: round2(s.wx), wz: round2(s.wz), st: s.st, goal: s.intent ? (s.intent.goalType || '') : '',
    }));
  }

  function setZones(next) {
    zones = sanitizeZones(next);
    saveZones(zones);
    // 换了区域：所有学生立刻重新决策，免得还朝着已经删掉的旧目标走
    const now = Date.now();
    for (const s of students) { s.decideAt = now; s.planAt = now; s.intent = null; s.st = 'idle'; }
    return zones;
  }
  function getZones() { return zones; }

  function dispose() { clearInterval(timer); }

  return { roster, talk, setZones, getZones, dispose, triggerAI, stateOf, forceChat, refreshObstacles: reloadObstacles, setPlayerPositions, loadPolicyStatus: () => ({ ready: policyReady, meta: policy.meta || {}, reason: policy.reason }), feedStats: () => ({ sft: feedSftRows, pref: feedPrefRows, dir: FEED_DIR }), ZONE_TYPES };
}
