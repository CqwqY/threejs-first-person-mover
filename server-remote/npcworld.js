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
// ---- 记忆检索（Generative Agents 的 retrieval）：相关度 + 新近度 + 重要度 三者加权 ----
const MEM_W_REL = 1.0;    // 相关度权重（与"当前地点 + 对方这句话"的字面重合）
const MEM_W_REC = 1.0;    // 新近度权重（指数衰减）
const MEM_W_IMP = 1.2;    // 重要度权重（略高于其它两项：重要的事不该被冲掉）
const MEM_RECENCY_HL = 25; // 新近度半衰期（分钟）：25 分钟衰减一半
// 记忆重要度基线（0~1）：不额外调 LLM，按**类型 + 文本线索**给分（免费、确定性、可测）
const MEM_BASE_IMP = { reflect: 0.95, quest: 0.8, trade: 0.8, want: 0.7, notice: 0.7, announce: 0.6, chat: 0.55, say: 0.55, act: 0.5, obs: 0.2 };
const MEM_HOT_WORDS = /(玩家|答应|承诺|喜欢|讨厌|吵架|生气|谢谢|帮我|送我|秘密|约定|道歉|一起|别告诉)/;
// ---- 反思（reflection）与日计划（daily plan）----
const REFLECT_MIN_NEW = 4;     // 至少攒了这么多条新记忆才值得想一次（控 LLM 调用）
const REFLECT_CD = 8 * 60000;  // 同一个学生两次反思的最小间隔（8 分钟）
const DAYPLAN_CD = 12 * 60000; // 日计划兜底重生成间隔（跨天时立刻重生成）
const MEM_COMPRESS = 5;
// ---- 结构化自我档案（DeepSeek 架构「自我状态改造」）：固定分层 + 固定顺序 ⇒ 抑制身份漂移 / 状态混乱 ----
const NARRATIVE_MAX = 3;      // 自我叙事层：保留最近几条"我对自己的认识"（反思产物，累积而非覆盖）
const REFLECT_IMP_SUM = 2.2;  // 反思的第二个触发条件：新记忆**重要度累积** ≥ 此值也能触发（关键事件能沉淀）
// 单条文本长度上限（入库前截断）。think 是**内部**独白（玩家看不到），写宽一点才有内容，
// 它决定这个角色"脑子里在想什么"，进而影响记忆与后续举止。
const LEN_SAY = 60;
const LEN_THINK = 120;
const LEN_MEM = 120;
const LEN_PLAN_DAY = 120; // 日计划（一天的主线）长度上限
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
const CHAT_COOLDOWN = 70;      // 同一个学生两次参与闲聊的最小间隔（秒）
const CHAT_INTERVAL = 20;      // 全局两次"新开闲聊"的最小间隔（秒）——控 GLM 调用量（再降一点：用户要"AI 之间有对话的欲望"）
// "做活动"时别站桩：隔一会儿在附近挪两步（减少"我要学习然后就一动不动"的无实物表演）
const ACT_STEP_MIN = 3500;     // 两次"挪步"的最小间隔（毫秒）—— 调密一点，别看着像杵着发呆
const ACT_STEP_MAX = 7000;     // 最大间隔
const ACT_STEP_DIST_MIN = 2.0; // 挪步距离范围（米）
const ACT_STEP_DIST_MAX = 5.0;
// 一件事最多"站"多久（秒）：到点就**立刻重新决策**（事件驱动），绝不站着干等 2 分钟
const ACT_STAY_MAX = 45;
const REST_STAY_MAX = 70;      // "原地歇着"的上限（歇够了也该起来）
const CHAT_LINE_GAP_MS = 1600; // 台词之间的间隔（气泡一句一句冒，像真在对话）
const CHAT_SEEK_RANGE = 45;    // 「想聊天但离得远」时最远会**主动走近**的距离（米）——再远就不追了
const MEET_INTERVAL = 10;      // 全局两次「撮合一对走近」的最小间隔（秒）——别让 8 个人同时乱窜
// ⚠ 闲聊改成**事件驱动**（用户明确要求）：靠得近就按概率开口，而不是"等 CHAT_INTERVAL 时间到"。
//   概率有上界：同一对靠得近最多 CHAT_NEAR_MAX 秒必开口一次（免得纯随机导致偶尔一直不说话）。
const CHAT_NEAR_MAX = 4.0;     // 靠得近的一对，最迟多久开口（秒）
const CHAT_GAP_MS = 25000;     // 全局最小间隔（毫秒）：**纯粹当成本保险**（不是触发条件，触发永远是"靠近+概率"）
// ---------- 多轮持续对话（★ 用户要求："两个人的对话不止可以对话一轮"）----------
// ⚠ 这不是"写死一个连聊 N 轮的功能"：我们只提供两个旋钮 —— ① 把**已经聊过的台词**作为上下文喂回去
//   （LLM 自己决定要不要接着说、说什么）；② 每轮之后看 **LLM 的 continue 字段**决定收不收尾。
//   代码只负责"把上文带回去 / 到顶了就停"，内容全归 LLM（遵循用户铁律）。
const CHAT_ROUNDS_MAX = 4;      // 一段对话最多几轮 LLM 往返（控额度；超了自然散场）
const CHAT_REPLY_GAP_MS = 900;  // 轮与轮之间的停顿（气泡之间别糊成一坨）
const PERSON_SEEK_TIMEOUT_MS = 90000; // 「去找某人」最多找这么久（追不上就回去干自己的事，别永远在外面晃）

// ---------- 「跟着我」（玩家/LLM 自由说出的跟随意图）----------
// ⚠ 这不是"新加一个叫 follow 的功能"：它是**已有原语 `person`（持续朝向某人）的一个参数** keep=true。
//   LLM 自己决定要不要跟、跟谁（代码只提供"朝向某人 + 到跟前是否停"这两个旋钮）。
const FOLLOW_KEEP = 3.5;         // 跟随保持的距离（米）：比这远就追，近了就停（别贴脸推玩家）
const FOLLOW_REPATH_MS = 1200;   // 跟随途中多久重指一次目标**当前位置**（玩家一直在动）
const FOLLOW_GIVEUP = 45;        // 目标离太远（米）就放弃跟随（追不上了，别满校园追）

// ---------- 通用小工具 ----------
// 延时（多轮对话轮之间喘气用）。
// ⚠ 这里**不能** unref：它是被 await 的，一旦 unref 而此刻又没有别的活动句柄，
//   事件循环会因为没有存活句柄而**提前退出**，await 就永远不 settle（Node 报 "unsettled top-level await"）。
function sleep(ms) {
  return new Promise((res) => setTimeout(res, Math.max(0, Number(ms) || 0)));
}

// ---------- P2：感知 ----------
// NPC 会"注意到"身边经过的人/玩家 → 写一条**短观察**进 mem（记忆流，会被检索/喂 prompt）。
// 开销靠"限流 + 超限先丢观察"控制，不靠另开缓冲：观察进 mem 才真的影响它之后的举止与说话。
const PERCEIVE_RANGE = 12;      // 感知半径（米）
const PERCEIVE_CD = 10000;      // 同一个 NPC 两次"观察"的最小间隔（毫秒）
const PERCEIVE_REPEAT_MS = 120000; // 同一个对象 2 分钟内不重复"注意到"（免得盯着一个人反复记）

// ---------- P3：委托任务（"去找谁、问什么、回来复命"）----------
const QUEST_TIMEOUT_MS = 180000; // 任务总超时（3 分钟没办成就放弃并回报，绝不静默卡住）
const QUEST_REPATH_MS = 2500;    // 目标会动：每隔这么久重新指向目标（开销极小：setTarget 有直线预判）
const QUEST_MEET_DIST = 3.0;     // 多近算"找到 TA 了"（米）
const QUEST_CLOSE_ENOUGH = 12;   // "够近了"：复命追太久还贴不到 3m（玩家在楼里/卡住）就到这个距离就地汇报
const QUEST_SOFT_MS = 30000;     // 进入"返回复命"阶段多久后，开始接受"够近就算到"（别让委托永远悬着）

// ---------- 公告/广播"照做"（AI 要真的听）----------
// 通知文本里提到去哪，就把闲着的人派过去 —— 光把通知塞进 prompt 是"知道"，派过去才是"听"。
const OBEY_MAX = 3;              // 同一条通知最多让几个人照做（别全班一窝蜂）
const OBEY_CD = 90000;           // 同一个学生两次"照通知行动"的最小间隔（毫秒）
const NOTICE_ZONE_WORDS = [
  [/操场|球场|跑步|运动|集合|体测|比赛|体育/, 'playground'],
  [/饭堂|食堂|吃饭|午餐|晚餐|开饭|打饭/, 'canteen'],
  [/图书馆|自习|看书|借书|阅览/, 'library'],
  [/教室|上课|早读/, 'classroom'],
  [/宿舍|寝室|睡觉|休息|回屋/, 'dorm'],
  [/小卖部|商店|买东西|超市/, 'shop'],
  [/厕所|洗手间|卫生间/, 'toilet'],
  [/校门|门口|大门|集合出发/, 'gate'],
  [/喷泉/, 'fountain'],
];
function noticeZoneType(text) {
  const t = String(text || '');
  for (const [re, z] of NOTICE_ZONE_WORDS) if (re.test(t)) return z;
  return null;
}
// 方位词（8 向）：+x = 东，-z = 北（与玩家的 fwd = (-sinYaw, -cosYaw) 直觉一致即可）
const DIR8 = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
function bearingName(dx, dz) {
  const a = Math.atan2(dx, -dz);
  return DIR8[Math.round(((a + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8];
}

// ---------- 场景识别（斯坦福的 observation：它得"看得见"周围有什么）----------
// 服务端手上就有 zones（区域名/范围）+ 学生/玩家坐标，所以"看到什么"根本不必问客户端：
// 直接算"我在哪 + 附近有哪些地方 + 附近有谁在做什么" ⇒ 拼成【你周围的场景】喂给模型。
// 没有这一段，模型只知道"我在饭堂"，不知道"饭堂旁边就是操场""公告栏那边有人"，说什么都虚。
const SCENE_RANGE = 45;          // 多远以内的地标算"你附近"（米）
const SCENE_MAX_LANDMARKS = 4;   // prompt 里最多列几个附近地标（别把 prompt 塞满）
const SCENE_MAX_PEOPLE = 3;      // prompt 里最多列几个附近的人
const OBS_CD = 12000;            // 同一个学生两次"注意到点什么"的最小间隔（毫秒）
const OBS_INTERRUPT_CD = 30000;  // 观察触发"打断当前计划"的最小间隔（防抖；斯坦福缺口 A）
const OBS_NOTABLE_DIST = 8;      // 玩家/同学进到这个距离才算"值得抬头看一眼"（米）

// ---------- 四处问人 / 看看学校（自主行为）----------
// 用户实测："我让他四处问人他是不会的，让他看看学校也是不会的" —— 因为原来 goalType 里
// 根本没有这两种"自发的好奇心"。补成两个一等公民动作，LLM 能选、规则大脑能兜底、玩家让它做也真做。
const INQUIRE_CD = 150000;       // 同一个学生两次"主动去问人"的最小间隔（毫秒）
const INQUIRE_NEAR = 3.0;        // 走到多近才算"问上了"（米）
const INQUIRE_TIMEOUT = 60000;   // 去问人的总超时（走不到就作废，绝不悬着）
const EXPLORE_CD = 120000;       // 同一个学生两次"去学校某处看看"的最小间隔（毫秒）
const SEEN_MAX = 24;             // "去过哪些地方"最多记多少个（环形截断，防无限增长）

// ---------- NPC 发布公告：自己走到公告栏，让 AI 写一条通知贴上去 ----------
// 触发是**事件驱动**的：规划时 AI 觉得"这事得告诉全校"，就在 plan 里给 post ⇒ 它走去公告栏贴。
// 贴出去的和玩家贴的完全同路：进公告栏、广播给所有客户端、**其他学生看到并照做**（闭环）。
const POST_NEAR = 2.5;         // 离公告栏多近算"走到板子前了"（米）
const POST_CD = 480000;        // 同一个学生两次贴公告的最小间隔（8 分钟）
const POST_GLOBAL_CD = 150000; // 全局两次 NPC 贴公告的最小间隔（2.5 分钟）——别刷屏
const POST_TIMEOUT = 90000;    // 从"决定去贴"到"贴出去"的总超时（走不到/被挡住就作罢）

// ---------- 反向委托：NPC 请玩家跑腿（去商店买某件东西、带回来交给它）----------
// 「必须是游戏真能做的」：商品目录来自服务端 SHOP（客户端 /api/shop 拿到的同一份），
// 玩家在商店买下 → 进背包 → 走到它面前点「交给 TA」→ 客户端从背包扣除 → 服务端校验并结算奖励。
const WANT_CD = 150000;      // 同一个学生两次开口要东西的最小间隔（毫秒）
const WANT_EXPIRE = 300000;  // 没人理的委托 5 分钟后作废
const WANT_RANGE = 7;        // 玩家多近才算"能当面开口"（米）
const WANT_MAX_PRICE = 130;  // 只要得起这个价位以内的东西（别让 AI 开口要三百块的锤子）
const WANT_REWARD_RATE = 0.35; // 奖励 = 价格 × 这个比例（跑腿费，玩家小赚一点才有动力）

// ---------- "人在台面/楼顶之上" ----------
// 障碍表是**二维**的（只有占地，没有高度），所以它在 2D 里分不清两种完全不同的情况：
//   ① 出生点正好落在楼里 → 真·被困住，要"脱困推出"；
//   ② 人站在**楼顶/台面之上**（合法的）→ 却被当成"困在楼里"，于是每拍把它往外推、
//      下发的绕行点也全在楼里 ⇒ 表现为"在碰撞体上方时寻路有问题 / 站着打转"。
// 客户端每 ~1.5s 回报每个学生的**真实状态**（`applyClientState`：脚底高度 + 实际坐标 + 是否卡住），据此判定属于②：
// 高于一层台阶就认为"在台面之上" ⇒ 关掉二维寻路与脱困，改由客户端真实的三维碰撞决定走位。
const HIGH_LEVEL_CLEAR = 0.6;

// ---------- D/E：校园广播器 + 公告栏 ----------
const BOARD_POS = { x: -22, z: 17 }; // 公告栏世界坐标（与客户端摆的那块板子一致）
const BOARD_READ_RANGE = 6;          // 离公告栏多近算"看见公告"（米）
const BOARD_READ_CD = 300000;        // 同一 NPC 两次读公告的最小间隔（5 分钟）
const ANNOUNCE_GAP_MS = 4000;        // 广播轮流下发给 AI 的间隔（一个个来，不并发打爆 GLM）

// ---------- 对话上下文（多轮）+ 内心活动 ----------
// ⚠ 以前每次搭话都是"全新一次调用"，只带最后一句 ⇒ 它接不上上一句（用户实测"聊天不知道上下文"）。
//   现在按（学生 × 说话人）保留最近几轮原话，拼进 prompt；talk 完把这一轮也写回去。
const CHATLOG_MAX = 8;               // 每人每说话人保留的最近对话条数（4 轮）
const CHATLOG_TTL = 600000;          // 对话历史有效期：10 分钟没继续就不再带（旧话题别一直压着）
const THINK_CTX = 3;                 // prompt 里带几条"最近的心里话"（让内心有连续性）
const NOTICE_HEARD_TTL = 600000;     // "最近听到的广播/公告"有效期（10 分钟）
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
  // 自主好奇心的两个一等公民动作（"四处问人""看看学校"）——认不出就退回 wander，绝不卡死
  if (['explore', 'look', 'visit', 'see', '看看', '看看学校', '逛逛', '参观', '探索', '去转转'].includes(x)) return 'explore';
  if (['inquire', 'ask', 'askaround', 'chat_with', '问人', '打听', '问问', '找人聊', '聊天', '找人说说话'].includes(x)) return 'inquire';
  return 'wander';
}
// 这两个是"抽象动作"（不是具体功能区），走位目标由代码现挑（见 exploreTarget / startInquire）
const ABSTRACT_GOALS = new Set(['wander', 'rest', 'explore', 'inquire']);

// 价值观：同一角色**每次完全一致**（按名字稳定派生、并落盘 s.values）——给行为一个恒定的锚点。
// DeepSeek 架构要求"身份/价值观每次措辞顺序都不变"，所以不是随机、不是每轮重编，而是**认准一个就不改**。
const VALUES_TABLE = [
  '做人讲义气，答应的事一定办到',
  '踏实一点，把该做的事做好比什么都强',
  '开心最重要，别把日子过得太拧巴',
  '待人善良，能帮一把就帮一把',
  '不服输，认定的事就做到最好',
  '安静守规矩，不给别人添麻烦',
];
// 本地"解释器"（DeepSeek「解释器」的落地，**不是编译器**）：把一句自然语言意图里提到的地方读出来。
// 只在 LLM 给的 goalType 认不出（已归一成 wander）时兜底 —— 不额外调 LLM（Flash 是螺丝刀，别当手术刀用）。
const ZONE_WORD_HINTS = {
  canteen: ['食堂', '饭堂', '吃饭', '打饭', '干饭'],
  playground: ['操场', '打球', '跑步', '踢球', '运动', '锻炼', '篮球'],
  library: ['图书馆', '看书', '借书', '自习', '复习'],
  classroom: ['教室', '上课', '写作业', '做题'],
  shop: ['商店', '小卖部', '杂货铺', '买东西', '买点'],
  dorm: ['宿舍', '回宿舍', '睡觉', '午休'],
  toilet: ['厕所', '洗手间', '卫生间'],
  gate: ['校门', '大门', '门口', '出校'],
  fountain: ['喷泉', '水池'],
};
function inferZoneFromText(text) {
  const t = String(text || '');
  if (!t) return null;
  for (const [type, words] of Object.entries(ZONE_WORD_HINTS)) {
    if (words.some((w) => t.indexOf(w) >= 0)) return type;
  }
  return null;
}

export function createNpcWorld(opts) {
  const dataDir = opts.dataDir;
  const broadcast = opts.broadcast || (() => {});
  const getDayTime = opts.getDayTime || (() => 0.35);
  const askStudent = opts.askStudent || (async () => null); // 由 ai-student.js 注入；没配也不影响走路
  // 由 index.js 注入：把一条公告真正发出去（落盘 + 广播给所有客户端 + 喂回本世界让其他学生看到）
  const onPost = opts.onPost || null;

  // ---------- 可训练策略网络（阶段1~5 的产物） ----------
  // 守卫式接入：模型不存在 / 损坏 / 契约不一致 → policyReady=false，decide() 自动退回规则大脑，零行为回归风险。
  const policy = loadPolicy(dataDir);
  const policyReady = policy.ready;
  if (policyReady) console.info('[npc] 已加载策略模型 campus_policy.json（' + (policy.meta.phases || []).join('+') + '，训练行 ' + (policy.meta.trainedRows || 0) + '）');
  else console.info('[npc] 无策略模型（' + policy.reason + '）：使用规则大脑 decide()');

  // 玩家坐标（由 index.js 每收到玩家 state 就喂一次），供 playerNear 特征用
  let playerPositions = [];
  function setPlayerPositions(list) { playerPositions = Array.isArray(list) ? list : []; }
  // 客户端回报的学生**真实状态**（脚底高度 + 实际水平位置 + 是否卡住）。
  // ⚠ 客户端才是真正跑物理的那一端：它的坐标比服务端"幽灵"可信。
  function applyClientState(list) {
    if (!Array.isArray(list)) return;
    const now = Date.now();
    for (const it of list) {
      if (!it) continue;
      const s = students.find((x) => x.id === String(it.id || ''));
      if (!s) continue;
      const y = Number(it.y);
      if (Number.isFinite(y) && y >= -8 && y <= 300) s.y = y;
      // 水平位置：只采纳"相差不大"的修正 —— 万一某个客户端卡顿/不同步，也别把幽灵坐标整块拽飞
      const cx = Number(it.x), cz = Number(it.z);
      if (Number.isFinite(cx) && Number.isFinite(cz) &&
          Math.hypot(cx - Number(s.x), cz - Number(s.z)) < 5) { s.x = cx; s.z = cz; }
      if (it.stuck) reportStuck(s, now); // 客户端说"该走却走不动" → 立刻重算路径
    }
  }
  // 客户端报告"卡住了"（在走却没位移）：这不花 LLM，只是重算一条路，正是治"莫名其妙卡住"的手段。
  function reportStuck(s, now) {
    if (now - Number(s._stuckRep || 0) < 2000) return; // 限流：别每 1.5s 都重算
    s._stuckRep = now;
    s.pathTries = 0;
    if (s.quest) { s.quest.repathAt = 0; s.stuck = 0; return; } // 任务中：下一拍按任务目标重指
    s._stuckN = Number(s._stuckN || 0) + 1;
    if (s._stuckN >= 3) {
      // 同一个地方反复卡（≥3 次 ≈ 6s）：别再死磕这个目标，交给规则大脑重新挑地方
      s._stuckN = 0; s.intent = null; s.stuck = 0; s.st = 'idle'; s.decideAt = now;
      console.info('[npc] ' + s.name + ' 反复卡住，放弃当前目标重新决策');
      return;
    }
    s.stuck = 0;
    setTarget(s, Number(s.tx), Number(s.tz)); // 用**客户端回报的位置**重新算一条路
  }
  // 这个学生是不是"站在台面/楼顶之上"（二维障碍表此时不可信）
  function elevated(s) { return Number(s.y) > HIGH_LEVEL_CLEAR; }

  // ---------- 反向委托：商品目录（由 index.js 把服务端 SHOP 注入进来）----------
  let shopPool = []; // [{ id, name, price, kind }]
  function setShopCatalog(list) {
    shopPool = (Array.isArray(list) ? list : [])
      .filter((x) => x && x.name && Number(x.price) > 0 && Number(x.price) <= WANT_MAX_PRICE)
      .map((x) => ({ id: String(x.id || x.name), name: String(x.name).slice(0, 20), price: Math.round(Number(x.price)), kind: String(x.kind || 'item') }))
      .slice(0, 600);
  }
  // 它想要的东西：优先"能当礼物的小件"（书/笔/熊/垫/花…），没有就随便挑一个买得起的
  const WANT_NICE = /(书|笔|熊|垫|花|画|毯|钟|伞|灯|杯|篮|球|琴|棋|模型|玩具|风筝|球拍|相框)/;
  function wantPickItem() {
    if (!shopPool.length) return null;
    const nice = shopPool.filter((x) => WANT_NICE.test(x.name));
    return pickOne(nice.length ? nice : shopPool);
  }
  // 当着玩家的面开口："能不能帮我买一个X带回来"
  function wantAsk(s, now) {
    const p = nearestPlayer(s);
    if (!p) return false;
    if (Math.hypot(Number(p.x) - Number(s.x), Number(p.z) - Number(s.z)) > WANT_RANGE) return false;
    const it = wantPickItem();
    if (!it) return false;
    s.want = {
      itemId: it.id, itemName: it.name, price: it.price,
      reward: Math.max(8, Math.round(it.price * WANT_REWARD_RATE)),
      createdAt: now, playerId: String(p.id || ''),
    };
    s._wantAt = now;
    broadcast({ t: 'npc_say', id: s.id, say: '能帮我买一个「' + it.name + '」带回来吗？（约 ¥' + it.price + '）' });
    s.mem.push({ t: now, text: '我请玩家帮我买一个「' + it.name + '」', kind: 'want' });
    trimMemory(s);
    console.info('[npc] ' + s.name + ' 请玩家代买「' + it.name + '」（¥' + it.price + '，报酬 ' + s.want.reward + '）');
    return true;
  }
  // 玩家交付：校验物品对得上就结算（奖励由这里给，客户端只负责把背包里那件扣掉）
  function deliver(sId, itemName, playerName, playerId) {
    const s = students.find((x) => x.id === String(sId));
    if (!s) return { ok: false, reason: '找不到这个同学' };
    const w = s.want;
    if (!w) return { ok: false, reason: '我现在没请你带东西呀' };
    const got = String(itemName || '').trim();
    // 名字要对得上（客户端只会在背包里确实有这件东西时才发，但服务端不信前端：对不上就拒绝）
    if (!got || (got !== w.itemName && got.indexOf(w.itemName) < 0 && w.itemName.indexOf(got) < 0)) {
      return { ok: false, reason: '这个不是我要的（我要的是「' + w.itemName + '」）' };
    }
    applyMoodWord(s, '开心');
    // 关系按**稳定键**记（w.playerId 已是完整键：u:/anon:/p:），别再加前缀
    bumpRel(s, playerId || w.playerId || '', 0.7, '帮我买了' + w.itemName);
    s.mem.push({ t: Date.now(), text: (playerName || '玩家') + '帮我买来了「' + w.itemName + '」，人挺靠谱', kind: 'trade', from: playerId || w.playerId || '' });
    trimMemory(s);
    const reward = w.reward;
    s.want = null;
    s._wantAt = Date.now();
    s._stuckN = 0;
    saveStudents(students);
    console.info('[npc] ' + s.name + ' 收到「' + w.itemName + '」（' + (playerName || '玩家') + ' 交付，奖励 ¥' + reward + '）');
    return { ok: true, reward, itemName: w.itemName, say: '谢啦！这个给你当跑腿费，拿去买点别的。' };
  }
  // ---------- 玩家身份键（★ 统一处：别再到处 assume 'p:'）----------
  // 稳定键：u:<userId>（登录）/ anon:<IP>（游客）/ p:<连接id>（旧存档）。重连不变的是前两种。
  // 判定"这是不是玩家"：三种前缀都算（旧存档里还有 p:xxx，必须继续认）。
  function isPlayerKey(k) {
    const v = String(k || '');
    return v.startsWith('p:') || v.startsWith('u:') || v.startsWith('anon:');
  }
  // 按身份键找玩家**当前**坐标：先按稳定键匹配（owner），再回退按连接 id 匹配（兼容旧的 p:<connId>）
  function playerByOwner(key) {
    const k = String(key || '');
    if (!k) return null;
    for (const p of playerPositions) if (isPlayerKey(k) && String(p.owner || '') === k) return p;
    const bare = k.replace(/^(p:|u:|anon:)/, '');
    for (const p of playerPositions) {
      if (String(p.id) === bare || String(p.owner || '') === bare) return p;
    }
    return null;
  }
  // 按 id 找某个玩家的坐标（委托任务"回来复命"要知道是回到**哪个**玩家身边）
  function playerById(id) {
    const key = String(id || '').replace(/^p:/, '');
    if (!key) return null;
    for (const p of playerPositions) if (String(p.id) === key) return p;
    return null;
  }

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
        // 用途/内容：**这是给 AI 看的那个"地名"**（用户可自己写）。名字（name）只给编辑器和玩家看 ——
        // 用户明确要求"不要把名字告诉 AI，容易误解"（如"花草阁"这种自取名会让模型瞎猜功能）。
        desc: clampText(z.desc, 60),
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
  const NAV_CELL = 1.5;     // 格边长（米）：太细则 A* 慢，太粗则贴不进楼间通道、路线也发飘
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
    // ⚡ 直线可达就不寻路：省掉绝大多数 A*（近距离 wander、无遮挡的目标都不用建/跑网格）。
    // ⚠ 但"站在台面/楼顶之上"时二维障碍表不可信（楼顶在表里就是实心）：直线预判会说"穿墙" ⇒
    //   算出来的路点全落在楼里 ⇒ 人原地打转。这种情况**不寻路**，直接走直线，交给客户端三维碰撞。
    s.path = (!elevated(s) && nav && !lineFree(Number(s.x), Number(s.z), x, z)) ? findPath(Number(s.x), Number(s.z), x, z) : null;
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
          y: 0,        // 脚底高度（客户端每 ~1.5s 回报；服务端靠它判断"是否站在台面/楼顶之上"）
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
          // 对话上下文：{ 'p:<玩家id>': [{who:'p'|'n', text, t}] } —— 只保留最近几轮（见 CHATLOG_*）
          chatLog: (old && old.chatLog && typeof old.chatLog === 'object') ? old.chatLog : {},
          heard: (old && old.heard && typeof old.heard === 'object') ? old.heard : null, // 最近听到的广播/公告：{text,from,t}
          perceiveAt: 0, // 上次感知时刻（限流；时间字段，必须有初值）
          quest: null,   // 委托任务：{stage,targetId,targetName,question,fromId,fromName,answer,createdAt,repathAt}
          want: null,    // 反向委托（它请玩家买东西）：{itemId,itemName,price,reward,createdAt,playerId}
          _wantAt: 0,    // 上次开口/结算的时刻（限流；时间字段，必须有初值）
          reflectAt: 0,      // 上次反思的时刻（限流；时间字段，必须有初值）
          _memAtReflect: 0,  // 上次反思时的记忆条数（判断"攒够新记忆"；累加型字段，必须有初值）
          dayPlan: null,     // 今日打算：{text, at}
          dayPlanAt: 0,      // 上次生成日计划的时刻（时间字段，必须有初值）
          dayPlanSeq: -1,    // 生成时所处的"游戏日"序号（跨天要重生成；累加型字段，必须有初值）
          postPending: false, // 是否正要去公告栏贴通知（走位到板子前才真正贴）
          postIdea: '',       // 它想贴的那件事（plan 给的原始想法）
          _postAt: 0,         // 上次"决定去贴 / 真的贴了"的时刻（限流+超时；时间字段，必须有初值）
          actStepAt: 0,  // 下一次"做活动时挪两步"的时刻（时间字段，必须有初值）
          actResume: 0,  // 挪步前记下的停留截止（回来接着做活动；0 = 当前不是挪步）
          // 场景识别 / 自主行为（新增字段一律在这给初值，否则累加/时间字段参与运算变 NaN 静默失效）
          noticed: '',       // 刚刚注意到的场景线索（进 prompt；字符串，必须有初值）
          _obsAt: 0,         // 上次"注意到点什么"的时刻（限流；时间字段，必须有初值）
          _interruptAt: 0,   // 上次被观察打断计划的时刻（防抖；时间字段，必须有初值）
          _inquireAt: 0,     // 上次主动去问人的时刻（限流；时间字段，必须有初值）
          _exploreAt: 0,     // 上次去学校某处看看的时刻（限流；时间字段，必须有初值）
          seenZones: [],     // 去过/看过的区域 id（"看看学校"优先挑没去过的；数组，必须有初值）
          // ---- 结构化自我档案（DeepSeek 架构）----
          values: (old && typeof old.values === 'string') ? old.values : '',        // 价值观（"我是谁"要累积、措辞不变）
          narrative: (old && Array.isArray(old.narrative)) ? old.narrative : [],   // 自我叙事层（反思产物，累积非覆盖）
          _impAtReflect: (old && Number.isFinite(Number(old._impAtReflect))) ? Number(old._impAtReflect) : 0, // 累加型字段，必须有初值
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
      if (!s.chatLog || typeof s.chatLog !== 'object' || Array.isArray(s.chatLog)) { s.chatLog = {}; dirty = true; }
      if (s.heard !== null && typeof s.heard !== 'object') { s.heard = null; dirty = true; }
      if (!Number.isFinite(Number(s.perceiveAt))) { s.perceiveAt = 0; dirty = true; }
      if (s.quest !== null && typeof s.quest !== 'object') { s.quest = null; dirty = true; }
      if (s.want !== null && typeof s.want !== 'object') { s.want = null; dirty = true; }
      if (!Number.isFinite(Number(s._wantAt))) { s._wantAt = 0; dirty = true; }
      if (!Number.isFinite(Number(s.reflectAt))) { s.reflectAt = 0; dirty = true; }
      if (!Number.isFinite(Number(s._memAtReflect))) { s._memAtReflect = 0; dirty = true; }
      if (!Number.isFinite(Number(s.dayPlanAt))) { s.dayPlanAt = 0; dirty = true; }
      if (!Number.isFinite(Number(s.dayPlanSeq))) { s.dayPlanSeq = -1; dirty = true; }
      if (s.dayPlan !== null && typeof s.dayPlan !== 'object') { s.dayPlan = null; dirty = true; }
      if (!Number.isFinite(Number(s._postAt))) { s._postAt = 0; dirty = true; }
      if (typeof s.postPending !== 'boolean') { s.postPending = false; dirty = true; }
      if (typeof s.postIdea !== 'string') { s.postIdea = ''; dirty = true; }
      if (!Number.isFinite(Number(s.actStepAt))) { s.actStepAt = 0; dirty = true; }
      if (!Number.isFinite(Number(s.actResume))) { s.actResume = 0; dirty = true; }
      if (typeof s.noticed !== 'string') { s.noticed = ''; dirty = true; }
      if (!Number.isFinite(Number(s._obsAt))) { s._obsAt = 0; dirty = true; }
      if (!Number.isFinite(Number(s._interruptAt))) { s._interruptAt = 0; dirty = true; }
      if (!Number.isFinite(Number(s._inquireAt))) { s._inquireAt = 0; dirty = true; }
      if (!Number.isFinite(Number(s._exploreAt))) { s._exploreAt = 0; dirty = true; }
      if (!Array.isArray(s.seenZones)) { s.seenZones = []; dirty = true; }
      // 结构化自我档案（老存档没有 ⇒ 不补就是 undefined → 参与运算变 NaN 静默失效）
      if (typeof s.values !== 'string') { s.values = ''; dirty = true; }
      if (!Array.isArray(s.narrative)) { s.narrative = []; dirty = true; }
      if (!Number.isFinite(Number(s._impAtReflect))) { s._impAtReflect = 0; dirty = true; }
      if (!Number.isFinite(Number(s.rot))) { s.rot = 0; dirty = true; }
      if (!Number.isFinite(Number(s.y))) { s.y = 0; dirty = true; }
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
  // 以当前位置为中心、半径 [minD,maxD] 内找一个站得住的点（"做活动时挪两步"用）
  function nearbyPoint(s, minD, maxD) {
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = rand(minD, maxD);
      const x = Number(s.x) + Math.cos(a) * r;
      const z = Number(s.z) + Math.sin(a) * r;
      if (!blocked(x, z)) return { x, z };
    }
    return null;
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
    // 兜底 1：出生点那圈被建筑围死 → 换参考点：从**当前位置**往更大范围试（别因为锚点被堵就永远发呆）
    for (let i = 0; i < 16; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = rand(6, WANDER_RADIUS * 1.6);
      const x = Number(s.x) + Math.cos(a) * r;
      const z = Number(s.z) + Math.sin(a) * r;
      if (blocked(x, z)) continue;
      setTarget(s, x, z);
      s.st = 'walk';
      s.walkUntil = now + WALK_TIMEOUT * 1000;
      s.stuck = 0;
      s.decideAt = now + rand(DECIDE_MIN, DECIDE_MAX) * 1000;
      return;
    }
    // 兜底 2：连远处的点也挑不到（真空里 / 全被围）→ 短等再试，绝不静默卡住
    s.st = 'idle';
    s.decideAt = now + 2500;
  }
  // 挑一个"不是我正待着的"区域：否则站在饭堂里决定"去饭堂" ⇒ 一步不动 ⇒ 看着像发呆
  function pickZoneAway(s, type) {
    const list = zonesOfType(type);
    if (!list.length) return null;
    const here = zoneAt(Number(s.x), Number(s.z));
    const other = here ? list.filter((z) => z.id !== here.id) : list;
    return pickOne(other.length ? other : list);
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
  // AI 眼里的"这是什么地方"：**优先用用户写的用途(desc)，其次才是功能区类型标签**。
  // ⚠ 绝不用区域的名字（name）—— 用户明确要求"不要告诉 AI 名字，容易误解"：
  //   自取的名字（"花草阁""第三院落"）模型只会瞎猜它是干什么的；而"用途"才是它真正需要的信息。
  function zoneAiName(z) {
    if (!z) return '';
    const d = String(z.desc || '').trim();
    if (d) return d;
    const t = ZONE_TYPES.find((x2) => x2.id === z.type);
    return (t && t.label) || '某处';
  }
  // 任意坐标 → 人话地名（"图书馆" / "看书自习的地方" / "校园里"）
  function placeNameAt(x, z, zoneId) {
    const zn = zoneAt(Number(x), Number(z)) || zoneById(zoneId);
    if (!zn) return '校园里';
    return zoneAiName(zn) || '校园里';
  }
  // 本地"解释器"：把一句自然语言里的"要去哪"读出来。先认功能区常识词，再认**用户自己写的用途**（desc）。
  // 用于 act 的 target 认不出、或 LLM goalType 认不出时的兜底 —— 纯本地，不花 LLM 调用。
  function resolvePlaceType(text) {
    const t = String(text || '');
    if (!t) return null;
    const byWord = inferZoneFromText(t);
    if (byWord) return byWord;
    for (const z of zones) {
      const d = String(z.desc || '').trim();
      if (!d) continue;
      if (t.indexOf(d) >= 0) return z.type;
      for (const w of d.split(/[、，,。;；:：\s/|｜]+/)) {
        if (w.length >= 2 && t.indexOf(w) >= 0) return z.type;
      }
    }
    return null;
  }
  // 给 AI 的"我在哪"：用户写的用途 / 类型标签（**不含自取的名字**）。都不在就老实说"校园里"，绝不臆造地点。
  function placeOf(s) { return placeNameAt(s.x, s.z, s.zoneId); }
  // 给 AI 的"玩家在哪"：说人话（距离 + 方位 + 地点）。
  // ⚠ 模型拿不到坐标，不把位置翻译成人话，它就只能瞎猜（用户实测："AI 对玩家位置不清"）。
  function playerWhere(s) {
    const p = nearestPlayer(s);
    if (!p) return '';
    const dx = Number(p.x) - Number(s.x), dz = Number(p.z) - Number(s.z);
    const d = Math.round(Math.hypot(dx, dz));
    const at = placeNameAt(Number(p.x), Number(p.z), '');
    if (d <= 6) return '玩家就在你跟前（约 ' + d + 'm）';
    if (d <= 25) return '玩家在' + at + '那边，离你约 ' + d + 'm（你的' + bearingName(dx, dz) + '方向），走几步就到';
    if (d <= 90) return '玩家离你有点远（约 ' + d + 'm，在你的' + bearingName(dx, dz) + '方向，' + at + '那边）';
    return '玩家离你很远（约 ' + d + 'm）';
  }
  // ---------- 场景识别（斯坦福的 observation）----------
  // 服务端手上就有 zones + 所有人坐标 ⇒ "看得见什么"不用问客户端，直接算。
  // 产出三类线索：① 我在哪个区域 ② 附近有哪些地标（区域名/公告栏 + 方位距离）③ 附近有谁在做什么。
  function doingWord(o) {
    const st = String((o && o.st) || '');
    if (st === 'walk') return '在往别处走';
    if (st === 'act') return '停下来做自己的事';
    return '待在那儿';
  }
  // 附近的人（同学 + 玩家）：按距离排序取前几个
  function peopleNear(s, maxDist, maxN) {
    const out = [];
    for (const o of students) {
      if (o === s) continue;
      const dx = Number(o.x) - Number(s.x), dz = Number(o.z) - Number(s.z);
      const d = Math.hypot(dx, dz);
      if (d <= maxDist) out.push({ id: o.id, name: String(o.name || '同学'), dist: d, dir: bearingName(dx, dz), doing: doingWord(o) });
    }
    for (const p of playerPositions) {
      const dx = Number(p.x) - Number(s.x), dz = Number(p.z) - Number(s.z);
      const d = Math.hypot(dx, dz);
      if (d <= maxDist) out.push({ id: 'player', name: '玩家', dist: d, dir: bearingName(dx, dz), doing: '在附近' });
    }
    out.sort((a, b) => a.dist - b.dist);
    return out.slice(0, maxN);
  }
  // 场景快照：{ place, hereType, landmarks:[{id,name,type,dist,dir,posts}], people:[...] }
  function sceneOf(s) {
    const here = zoneAt(Number(s.x), Number(s.z)) || zoneById(s.zoneId);
    const lm = [];
    for (const z of zones) {
      if (here && z.id === here.id) continue; // 自己正待着的区域不用再列一遍
      const c = zoneCenter(z);
      const dx = c.x - Number(s.x), dz = c.z - Number(s.z);
      const d = Math.hypot(dx, dz);
      if (d > SCENE_RANGE) continue;
      lm.push({ id: z.id, name: placeNameAt(c.x, c.z, z.id), type: z.type, dist: d, dir: bearingName(dx, dz), posts: 0 });
    }
    // 公告栏是"特殊地标"（不在 zones 里，但全校都认它）
    const bx = BOARD_POS.x - Number(s.x), bz = BOARD_POS.z - Number(s.z);
    const bd = Math.hypot(bx, bz);
    if (bd <= SCENE_RANGE) lm.push({ id: '__board', name: '公告栏', type: 'board', dist: bd, dir: bearingName(bx, bz), posts: boardPosts.length });
    lm.sort((a, b) => a.dist - b.dist);
    return {
      place: placeOf(s),
      hereType: here ? here.type : null,
      landmarks: lm.slice(0, SCENE_MAX_LANDMARKS),
      people: peopleNear(s, SCENE_RANGE, SCENE_MAX_PEOPLE),
    };
  }
  // 场景 → 一句人话（进 prompt 的【你周围的场景】）
  function sceneLine(s) {
    const sc = sceneOf(s);
    const parts = [];
    if (sc.landmarks.length) {
      parts.push('能看到：' + sc.landmarks.map((l) => l.name + '（' + l.dir + '约 ' + Math.round(l.dist) + 'm'
        + (l.id === '__board' ? (l.posts ? '，上面有 ' + l.posts + ' 条通知' : '，板子是空的') : '') + '）').join('、'));
    }
    if (sc.people.length) {
      parts.push('你身边有人：' + sc.people.map((p) => p.name + '（' + p.dir + '约 ' + Math.round(p.dist) + 'm，' + p.doing + '）').join('；'));
    }
    return parts.join('　');
  }
  // 全校有哪些地方（"看看学校"得先知道能去哪）+ 哪些已经去过
  function placesLine(s) {
    if (!zones.length) return '';
    const seen = new Set(Array.isArray(s.seenZones) ? s.seenZones : []);
    return zones.slice(0, 12).map((z) => {
      const c = zoneCenter(z);
      return placeNameAt(c.x, c.z, z.id) + (seen.has(z.id) ? '（去过）' : '（还没去过）');
    }).join('、');
  }
  function markSeen(s, id) {
    if (!id || id === '__board') return;
    if (!Array.isArray(s.seenZones)) s.seenZones = [];
    if (s.seenZones.includes(id)) return;
    s.seenZones.push(id);
    if (s.seenZones.length > SEEN_MAX) s.seenZones.splice(0, s.seenZones.length - SEEN_MAX);
  }
  // 观察流：注意到什么 → 进记忆（带来源）+ 必要时**打断当前计划**（斯坦福缺口 A：看到才会改主意）
  function observeScene(s, now) {
    if (now - Number(s._obsAt || 0) < OBS_CD) return;
    if (s.quest || s._chatting || s._inquiring) return; // 办事/聊天中不打扰
    const sc = sceneOf(s);
    const here = zoneAt(Number(s.x), Number(s.z));
    const p = sc.people.find((x) => x.id === 'player' && x.dist <= OBS_NOTABLE_DIST);
    const mate = sc.people.find((x) => x.id !== 'player' && x.dist <= OBS_NOTABLE_DIST);
    const board = sc.landmarks.find((l) => l.id === '__board' && l.posts > 0 && l.dist <= OBS_NOTABLE_DIST);
    // 优先级：玩家 > 新通知 > 第一次到的区域 > 同学
    let text = '';
    let notable = false;
    if (p) { text = '我看见玩家就在我附近（' + p.dir + '约 ' + Math.round(p.dist) + 'm）'; notable = true; }
    else if (board) { text = '我路过公告栏，上面贴着 ' + board.posts + ' 条通知'; notable = true; }
    else if (here && !(Array.isArray(s.seenZones) ? s.seenZones : []).includes(here.id)) {
      text = '我第一次到' + placeOf(s) + (sc.landmarks.length ? ('，旁边就是' + sc.landmarks.slice(0, 2).map((l) => l.name).join('、')) : '');
    } else if (mate) { text = '我看见' + mate.name + mate.doing + '（' + mate.dir + '约 ' + Math.round(mate.dist) + 'm）'; }
    if (!text) return;
    if (String(s._obsSeen || '') === text) return; // 同一条别反复记
    s._obsAt = now;
    s._obsSeen = text;
    s.noticed = text; // 进下一次 prompt 的【你刚刚注意到】
    s.mem.push({ t: now, text, kind: 'obs' });
    if (here) markSeen(s, here.id); // 到过就记下来（"看看学校"优先挑没去过的）
    trimMemory(s);
    // 高重要度观察 → 把决策点拉到当下（下一拍就重新想；限流防抖）
    if (notable && now - Number(s._interruptAt || 0) > OBS_INTERRUPT_CD) {
      s._interruptAt = now;
      s.decideAt = Math.min(Number(s.decideAt || 0) || now, now);
    }
  }
  // ---------- 自主行为①「看看学校」：挑一个**还没去过**的区域走过去看 ----------
  function exploreTarget(s) {
    if (!zones.length) return null;
    const seen = new Set(Array.isArray(s.seenZones) ? s.seenZones : []);
    const here = zoneAt(Number(s.x), Number(s.z));
    const fresh = zones.filter((z) => !seen.has(z.id) && (!here || z.id !== here.id));
    const pool = fresh.length ? fresh : zones.filter((z) => !here || z.id !== here.id);
    return pool.length ? pickOne(pool) : null;
  }
  function startExplore(s, now) {
    const z = exploreTarget(s);
    if (!z) { wander(s, now); return; }
    s._exploreAt = now;
    s.intent = { goalType: 'explore', goalText: '去' + placeNameAt(zoneCenter(z).x, zoneCenter(z).z, z.id) + '看看', activity: '四处看看', plan: '', since: now };
    goZone(s, now, z);
  }
  // ---------- 自主行为②「四处问人」：走到一个同学跟前，问它一件自己好奇的事 ----------
  function inquireTarget(s) {
    let best = null, bd = Infinity;
    for (const o of students) {
      if (o === s) continue;
      if (o.quest || o._chatting || o._inquiring) continue; // 人家正忙，别去烦
      const d = Math.hypot(Number(o.x) - Number(s.x), Number(o.z) - Number(s.z));
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }
  function startInquire(s, now) {
    if (now - Number(s._inquireAt || 0) < INQUIRE_CD) { wander(s, now); return; }
    const t = inquireTarget(s);
    if (!t) { wander(s, now); return; }
    s._inquireAt = now;
    s.intent = { goalType: 'inquire', goalText: '去问问' + t.name, activity: '', plan: '', seekId: t.id, since: now };
    setTarget(s, Number(t.x), Number(t.z));
    s.st = 'walk'; s.walkUntil = now + WALK_TIMEOUT * 1000; s.stuck = 0;
    s.decideAt = now + INQUIRE_TIMEOUT;
    console.info('[npc] ' + s.name + ' 去找 ' + t.name + ' 打听打听');
  }
  // 走到跟前 → 一次 LLM 调用产出「问句 + 对方回答」；双方都写**带来源**的记忆（缺口 D）
  async function inquireWith(s, t, now) {
    if (s._inquiring) return;
    s._inquiring = true;
    s.st = 'act'; s.stayUntil = now + 6000;
    s.tx = Number(s.x); s.tz = Number(s.z); s.wx = s.tx; s.wz = s.tz; s.path = null; s.pathIdx = 0;
    try {
      const out = await askStudent({
        student: {
          name: s.name, cls: s.cls, persona: s.persona, sex: s.sex, place: placeOf(s), st: 'act',
          needs: s.needs, mood: s.mood, rel: topRel(s), player: playerWhere(s),
          boardLine: boardLine(), scene: sceneLine(s), places: placesLine(s), heard: heardLine(s, now), self: selfProfile(s),
        },
        other: { name: t.name, cls: t.cls, persona: t.persona },
        memory: pickMemory(s, null),
        thinks: recentThinks(s),
        kind: 'inquire',
      });
      const q = clampText(out && out.question, 60);
      const a = clampText(out && out.answer, 80);
      if (!q) return; // 没问出东西就不硬编（避免"无实物表演"）
      const ts = Date.now();
      // 台词逐句广播（附近的玩家能偷听到"同学之间在打听事"）
      broadcast({ t: 'npc_say', id: s.id, say: t.name + '，' + q });
      broadcast({ t: 'npc_say', id: t.id, say: a || '（他说不太清楚）' });
      // 记忆归属按**实际台词**拼，并带上"听谁说的"（src）
      s.mem.push({ t: ts, text: '我问' + t.name + '「' + q + '」，' + (a ? ('他说：' + a) : '他也没说清'), kind: 'chat', src: t.name, imp: 0.5 });
      t.mem.push({ t: ts, text: s.name + '来问我「' + q + '」，我说：' + (a || '…'), kind: 'chat', src: s.name, imp: 0.45 });
      bumpRel(s, t.id, 0.12, '');   // 主动找人说话 → 关系近一点
      bumpRel(t, s.id, 0.08, '');
      applyMoodWord(s, '好奇');
      const th = clampText(out && out.think, LEN_THINK) || ('我去问了' + t.name + '关于「' + q + '」');
      s.think.push({ t: ts, text: th });
      if (s.think.length > MEM_MAX) s.think.splice(0, s.think.length - MEM_MAX);
      trimMemory(s); trimMemory(t);
      saveStudents(students);
      console.info('[npc] ' + s.name + ' 问 ' + t.name + '：「' + q + '」→ ' + (a || '…'));
    } catch (e) {
      console.warn('[npc] 四处问人失败 ' + s.id + '：' + ((e && e.message) || e));
    } finally {
      s._inquiring = false;
      s.decideAt = Date.now(); // 问完立刻回到日常（不留悬空意图）
      s.st = 'act';
      s.stayUntil = Math.max(Number(s.stayUntil || 0), Date.now() + 3000);
    }
  }
  // 给 AI 的"公告栏"：**不管有没有内容都要说**（否则它根本不知道学校有这块板子）
  function boardWhere() { return placeNameAt(BOARD_POS.x, BOARD_POS.z, ''); }
  function boardLine() {
    const at = boardWhere();
    const where = (at === '校园里' ? '校园里（' : at + '那一带（') + '坐标 ' + BOARD_POS.x + ',' + BOARD_POS.z + '）';
    if (!boardPosts.length) {
      return '学校在' + where + '立了一块**公告栏**，玩家和学校会往上贴通知；现在上面还没有新通知（你路过那一带可以看看）。';
    }
    return '学校在' + where + '有一块**公告栏**，最近的通知：' + boardPosts.slice(-3).join('；')
      + '。这些是**学校的正式通知**：说到去哪、什么时候，就要**照它调整你接下来的安排**（把通知里那个地方排进你的计划里）。';
  }

  // 选目标：课程表时段优先（70%），否则按需求；都没有区域就原地发呆
  function decide(s, now) {
    if (policyReady) { applyPolicy(s, now); return; }
    const h = hourNow();
    const seg = scheduleType(h);
    // 自主好奇心（用户："AI 能做的自主行为不够"）：偶尔自己去"打听点事 / 到学校某处看看"。
    // ⚠ 只在有区域、非上课时段发作；概率低 + 有个人冷却 ⇒ 不喧宾夺主。
    //   探针若要确定性，把 `_inquireAt`/`_exploreAt` 顶到未来即可屏蔽（同 chatAt 的做法）。
    if (zones.length && !(seg && seg.type === 'classroom')) {
      if (Number((s.needs || {}).social) > 0.55 && now - Number(s._inquireAt || 0) > INQUIRE_CD && Math.random() < 0.25) {
        startInquire(s, now); return;
      }
      if (now - Number(s._exploreAt || 0) > EXPLORE_CD && Math.random() < 0.15) {
        startExplore(s, now); return;
      }
    }
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
    if (seg && Math.random() < 0.7) target = pickZoneAway(s, seg.type);
    if (!target) target = pickZoneAway(s, needType(s));
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
      const target = pickZoneAway(s, a);
      if (target) { goZone(s, now, target); return; }
      wander(s, now); return; // 没这种类型的区域：自由漫步兜底
    }
    if (a === 'wander') { wander(s, now); return; }
    if (a === 'rest') { s.st = 'act'; s.stayUntil = now + Math.min(rand(STAY_MIN, STAY_MAX), ACT_STAY_MAX) * 1000; s.actStepAt = now + rand(ACT_STEP_MIN, ACT_STEP_MAX); s.decideAt = s.stayUntil; return; }
    if (a === 'chat_with') { s.st = 'act'; s.stayUntil = now + Math.min(rand(20, 50), ACT_STAY_MAX) * 1000; s.actStepAt = now + rand(ACT_STEP_MIN, ACT_STEP_MAX); s.decideAt = s.stayUntil; return; }
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
      // inquire/explore 是"LLM 独有"的抽象动作，策略网络的 15 动作 schema 里没有它们
      //   ⇒ 不写进训练集（否则会教出一个永远只会 'other' 的网络）。
      if (goalType === 'inquire' || goalType === 'explore') return;
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

  // ---------- 斯坦福「统一决策入口」act：LLM 自己选 type，服务端只做映射 ----------
  // 论文/DeepSeek 稿的核心：**没有"服务端决定现在该调哪个 kind"这一步**。LLM 输出 action + type + target
  // + params，服务端只负责"这个 type 怎么执行"。行为空间不再被提前枚举 —— "四处看看"不需要一个新 kind，
  // 它自然从 type=explore / type=move+observe 的组合里涌现。
  // 这里把 act 归一成既有的 goalType 意图（走位 / 发帖 / 委托各系统直接复用，零重写）。
  // 兼容：① 模型不听话、直接给了老的 goalType → 原样放行；② type 认不出 → 从 action/target 的文字里读地方。
  //
  // ⚠★ translateIntent 是**纯翻译**（不再有"原样放行"的短路），供 plan/act 与对话改道**共用同一套**。
  //   以前 applyTalkEffect 自己维护一份动作白名单 ⇒ 两处漂移（对话里说得出的动作、规划时说不出）。
  function translateIntent(out) {
    if (!out) return out;
    const type = String(out.type || '').trim().toLowerCase();
    const target = String(out.target || '').trim();
    const action = String(out.action || '').trim();
    const params = (out.params && typeof out.params === 'object') ? out.params : {};
    const r = {
      goalType: 'wander',
      goal: clampText(action || target, 80),
      activity: clampText(action, 120),
      plan: '',
      durationSec: clampInt(params.durationSec != null ? params.durationSec : params.duration, 30, 300, 60),
      thought: clampText(out.think, 120),
      mem: clampText(out.mem, 40),
      seek: '',
      post: '',
      // keep：跟随标记（★ 不新增动作类型，只是给"朝向某人"这个**已有原语**加一个参数）——
      //   普通 seek 到跟前就停（搭话）；keep=true 则保持距离一直跟着。LLM 自己决定要不要 keep。
      keep: false,
    };
    // 「跟着/跟随/跟紧」是不是"持续跟随"的语义（LLM 的自由文字，也可能是 type 名）
    const followish = /跟(着|上|紧|随|我来|我走|着他|着她)|跟随|follow|别走丢|跟上我/.test(type + ' ' + action + ' ' + target);
    const seekByName = (name) => {
      const o = resolveStudentByName(name);
      return o ? o.name : '';
    };
    // ★★ 显式 seek 优先级**最高**（在 goalType 之前判断）：
    //   模型可能同时给了 goalType 和 seek（"goalType=rest, seek=玩家"）⇒ 那是"去找玩家"，
    //   不能被 goalType=rest 提前 return 吞掉（探针 [17] 就是这么挂的）。
    const explicitSeek = String(out.seek || '').trim();
    if (explicitSeek) {
      r.goalType = 'wander';
      r.seek = (/玩家|那个人/.test(explicitSeek)) ? '玩家' : (seekByName(explicitSeek) || explicitSeek);
      r.keep = followish || !!out.keep;
      return r;
    }
    // 老格式：模型/上层直接给了 goalType → 优先按它归一（对话改道走的就是这条路）
    const gRaw = String(out.goalType || '').trim().toLowerCase();
    if (gRaw) {
      if (gRaw === 'wander' || gRaw === 'rest' || gRaw === 'explore' || gRaw === 'inquire') { r.goalType = gRaw; return r; }
      if (ZONE_TYPE_IDS.has(gRaw)) { r.goalType = gRaw; return r; }
      // follow：跟着某人（goalWho 说是谁；没给就当"跟着玩家"，对话里"跟我走"就是这个）
      if (gRaw === 'follow' || gRaw === '跟随' || gRaw === '跟着') {
        r.goalType = 'wander'; r.keep = true;
        const who2 = String(out.goalWho || '').trim();
        r.seek = who2 ? (seekByName(who2) || who2) : '玩家'; // 解析成人名；没说跟谁 ⇒ 默认跟玩家
        return r;
      }
      // wait：原地等（复用 rest，但**不挪窝**、等久一点）
      if (gRaw === 'wait' || gRaw === '等' || gRaw === '等待') {
        r.goalType = 'rest'; r.durationSec = clampInt(out.params && out.params.seconds, 10, 300, 60); return r;
      }
      // goalType 认不出（"打听"/"去吃饭"/"跟/影随"这种自由词）→ 把它**并入文字线索**，
      //   下面按同一套文字判断（顺序：先去处，再自主动作）。这保证"模型自己起的名"也能落地。
      //   ⚠ 不改 r.goalType 的默认值，落到后面统一处理。
    }
    // 显式 seek 已在上面处理，这里不再重复。
    // 文字线索：type + goalType + action + target + goal（顺序无关，谁有信息用谁）
    const hint = [type, gRaw, action, target, String(out.goal || '')].filter(Boolean).join(' ');
    // 想找**人**（含"跟谁"）：人优先于地方（"跟着小明"里也有人名也有"跟着"）
    // ⚠ "玩家"不是学生名，seekByName 认不出 ⇒ 先单独判"玩家/那个人"。
    if (/玩家|那个人/.test(target) || (!target && /玩家/.test(action))) {
      r.goalType = 'wander'; r.seek = '玩家'; r.keep = followish; return r;
    }
    const person = seekByName(target) || seekByName(action) || seekByName(gRaw);
    if (person) { r.goalType = 'wander'; r.seek = person; r.keep = followish; return r; }
    // 文字线索：**类型名**优先（type / goalType），它们是"这是什么动作"的直接声明；
    // ⚠ 不用 goal/action 全文（那是"内容"，容易误判），内容只用于最后兜底找地方。
    const tag = [type, gRaw].filter(Boolean).join(' ');
    const has = (...xs) => xs.some((x) => tag.indexOf(x) >= 0);
    // 纯跟随语义优先于"去某处"（"跟着他别走丢"里的动作词是"跟"，不是"去"；type 里也可能就写 follow）
    if (followish) { r.seek = '玩家'; r.goalType = 'wander'; r.keep = true; return r; }
    // 去某个地方（move/go/goto/去/走到…）：先去人（已在上面处理），再去地方
    if (has('move', 'goto', 'go', 'walkto', 'walk_to', 'go_to', '去', '走到', '前往', '前往到')) {
      const z2 = resolvePlaceType(target || action || String(out.goal || ''));
      r.goalType = z2 || 'wander';
      return r;
    }
    if (has('inquire', 'ask', '打听', '问', '问问')) { r.goalType = 'inquire'; return r; }
    if (has('explore', 'look', 'visit', 'see', '看看', '逛', '逛逛', '参观', '探索', '转转')) { r.goalType = 'explore'; return r; }
    if (has('post', 'announce', '通知', '公告', '贴')) { r.post = clampText(params.text || action || target, 40); return r; }
    if (has('rest', 'stay', 'idle', 'sit', '歇', '休息', '待着', '发呆')) { r.goalType = 'rest'; return r; }
    if (has('wait', '等', '等待', '等一会')) {
      r.goalType = 'rest';
      r.durationSec = clampInt(params.seconds != null ? params.seconds : params.duration, 5, 300, 30);
      return r;
    }
    if (has('observe', 'watch', 'look_at', '看', '观察', '看看他', '看看她')) { r.goalType = 'rest'; return r; }
    if (has('wander', 'roam', 'stroll', 'walk', '溜达', '散步', '走走')) { r.goalType = 'wander'; return r; }
    // 未知 type（它自己起的名）：从 action/target/goal 的文字里读地方；读不出就随便走走
    r.goalType = resolvePlaceType(action + ' ' + target + ' ' + String(out.goal || '')) || 'wander';
    return r;
  }
  // 兼容壳：外部（探针 / 测试 / 老调用）仍按 normalizeAct 用；内部统一走 translateIntent。
  function normalizeAct(out) { return translateIntent(out); }

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
        const raw = await askStudent({
          student: {
            name: s.name, cls: s.cls, persona: s.persona, sex: s.sex,
            place: placeOf(s), self: selfProfile(s), // 结构化自我档案（固定分层，放最前 ⇒ 身份稳、状态准）
            st: s.st, needs: s.needs, mood: s.mood,
            rel: topRel(s), board: boardPosts.slice(-3),
            boardLine: boardLine(),          // ⚠ 没通知也要告诉它"学校有公告栏"（否则它不知道这块板子存在）
            player: playerWhere(s),          // 玩家在哪（距离/方位/地点，说人话）
            dayPlan: s.dayPlan ? String(s.dayPlan.text || '') : '', // 今日主线（让零散决定有连续性）
            mates: students.filter((x) => x !== s).map((x) => x.name), // 班里的同学：给了名字它才"找得到人"
            scene: sceneLine(s),   // 场景识别：附近有什么地标 / 谁在附近（不然它"看不见"学校）
            places: placesLine(s), // 学校有哪些地方、哪些去过（"看看学校"得先知道能去哪）
            noticed: String(s.noticed || ''), // 刚刚注意到的事（观察打断计划后的线索）
          },
          memory: pickMemory(s, null),
          // 斯坦福「统一决策入口」：不再问它"你要填哪个模板"，而是让它自己决定做什么（type 由它选）。
          kind: 'act',
          hour: h,
          schedule: seg ? seg.label : '自由活动',
        });
        // act → 既有 goalType 意图（服务端只做映射）；兼容它直接给 goalType 的老写法
        const out = normalizeAct(raw);
        if (!out || !out.goalType) {
          // GLM 没给有效动作 → 回退规则大脑（保留走位能力，不静默卡死）
          s.intent = null;
          s.decideAt = now;
          decide(s, now);
          return;
        }
        let goalType = resolveGoalType(out.goalType);
        // 本地"解释器"兜底：LLM 给的意图认不出（已归一成 wander）但它其实在话里说了"去哪" ⇒ 从自然语言里读出来。
        // 只在"它给了东西、但代码不认识"这一种情况兜底，且**不调 LLM**（省额度）；仍读不出就放手让它 wander。
        if (goalType === 'wander') {
          const rawGt = String(out.goalType || '').trim().toLowerCase();
          const looksWander = !rawGt || ['wander', 'walk', 'roam', 'stroll', '游荡', '散步', '溜达', '随便走走'].includes(rawGt);
          if (!looksWander) {
            const guess = resolvePlaceType(String(out.goal || '') + ' ' + String(out.activity || ''));
            if (guess) { goalType = guess; console.info('[npc] ' + s.name + ' 意图解释器：从「' + clampText(out.goal, 20) + '」读出去 ' + guess); }
          }
        }
        const durMs = clampInt(out.durationSec, PLAN_DUR_MIN, PLAN_DUR_MAX, 60) * 1000;
        // 事件驱动：AI 觉得"这事得告诉全校"（比如约人去操场、捡到东西找失主）→ 先走去公告栏贴出来。
        // 走位交给 System1；到板子前才真正让 AI 写定稿并发布（见 publishPost）。
        if (out.post && onPost && !s.postPending &&
            now - Number(s._postAt || 0) > POST_CD && now - lastNpcPost > POST_GLOBAL_CD) {
          s.postIdea = clampText(out.post, 40);
          s.postPending = true;
          s._postAt = now;
          s.intent = { goalType: 'board', goalText: '去公告栏贴通知', activity: clampText(s.postIdea, 40), plan: '', since: now };
          setTarget(s, BOARD_POS.x, BOARD_POS.z);
          s.st = 'walk'; s.walkUntil = now + WALK_TIMEOUT * 1000; s.stuck = 0;
          s.planAt = now + PLAN_INTERVAL_MS; s.decideAt = s.planAt;
          console.info('[npc] ' + s.name + ' 要去公告栏贴通知：' + s.postIdea);
          return;
        }
        // 「去找某人 / 跟着某人」：plan/act 给了 seek → 以那人为目标。
        //   keep=true（"跟着/跟随"语义）= 到跟前**不停**，保持距离一直跟；否则到了就交给闲聊系统。
        if (out.seek) {
          const sq = String(out.seek).trim();
          const keep = !!out.keep;
          // 想找**玩家**：走到跟前（keep 时跟住不放）
          if (sq.indexOf('玩家') >= 0 || sq.indexOf('那个人') >= 0) {
            const p = nearestPlayer(s);
            if (p) {
              s.intent = { goalType: 'person', goalText: keep ? '跟着玩家' : '去找玩家', activity: clampText(out.activity || '', 120), plan: clampText(out.plan || '', 200), seekPlayer: true, keep, since: now };
              setTarget(s, Number(p.x), Number(p.z));
              s.st = 'walk'; s.walkUntil = now + WALK_TIMEOUT * 1000; s.stuck = 0;
              s.planAt = now + PLAN_INTERVAL_MS; s.decideAt = s.planAt;
              console.info('[npc] ' + s.name + (keep ? ' 开始跟着玩家走' : ' 打算去找玩家'));
              return;
            }
          }
          const seeker = resolveStudentByName(sq);
          if (seeker && seeker !== s) {
            s.intent = { goalType: 'person', goalText: (keep ? '跟着' : '去找') + seeker.name, activity: clampText(out.activity || '', 120), plan: clampText(out.plan || '', 200), seekId: seeker.id, keep, since: now };
            setTarget(s, Number(seeker.x), Number(seeker.z));
            s.st = 'walk'; s.walkUntil = now + WALK_TIMEOUT * 1000; s.stuck = 0;
            s.planAt = now + PLAN_INTERVAL_MS; s.decideAt = s.planAt;
            console.info('[npc] ' + s.name + (keep ? ' 开始跟着 ' : ' 打算去找 ') + seeker.name);
            return;
          }
        }
        s.intent = {
          goalType,
          goalText: clampText(out.goal || '', 80),
          activity: clampText(out.activity || '', 120),
          plan: clampText(out.plan || '', 200),
          since: now,
        };
        recordPlanFeed(s, goalType); // 慢环：把这次 LLM 决策写成训练标签（SFT + DPO 偏好对）
        // act 自带的内心活动入库（驱动记忆与后续举止）。每一次决策都有心理活动 —— 用户明确要求。
        const thought = clampText(out.thought, LEN_THINK);
        if (thought) {
          s.think.push({ t: now, text: thought });
          if (s.think.length > MEM_MAX) s.think.splice(0, s.think.length - MEM_MAX);
          saveStudents(students);
        }
        // act 认为"值得记住的事"也进记忆流（斯坦福：计划的产物要回写记忆，影响后续行为）
        if (out.mem) {
          s.mem.push({ t: now, text: clampText(out.mem, LEN_MEM), kind: 'act' });
          await trimMemory(s);
        }
        if (goalType === 'rest') {
          s.st = 'act';
          // 歇也有上限：歇够了**立刻**重新决策（别一歇两分钟杵在那儿）
          s.stayUntil = now + Math.min(durMs, REST_STAY_MAX * 1000);
          s.actStepAt = now + rand(ACT_STEP_MIN, ACT_STEP_MAX);
          // ⚠ 只把**规则大脑**的决策点提前（歇够就换事做），LLM 规划仍保持 PLAN_INTERVAL_MS 的节奏
          //   —— 否则"activity 一结束就 plan"会把 GLM 调用量从 2 分钟一次拉到 45 秒一次。
          s.decideAt = s.stayUntil;
          return;
        }
        if (goalType === 'wander') { wander(s, now); s.planAt = now + PLAN_INTERVAL_MS; s.decideAt = s.planAt; return; }
        // 两个"自主好奇心"动作：走位目标由代码现挑（不是具体功能区）
        if (goalType === 'inquire') { s.planAt = now + PLAN_INTERVAL_MS; startInquire(s, now); return; }
        if (goalType === 'explore') { s.planAt = now + PLAN_INTERVAL_MS; startExplore(s, now); return; }
        const target = pickZoneAway(s, goalType);
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
    const wdist0 = Math.hypot(wx - Number(s.x), wz - Number(s.z));
    // 路点已在身后（到最终目标比到该路点更近）⇒ 也当作已过，跳过，避免"回头去够"旧路点
    const behind = fdist < Math.hypot(Number(s.tx) - wx, Number(s.tz) - wz) - 0.3;
    if (wdist0 < Math.max(0.6, stepLen * 1.5) || behind) {
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
    // ⚠ 站在台面/楼顶之上（客户端回报的高度）：二维障碍表不可信 —— 不脱困、不做阻挡判定，
    //   直接朝路点走，能不能走由客户端真实的三维碰撞裁决（否则每拍被"脱困"推出、来回打转）。
    const up = elevated(s);
    const hit = up ? null : blockedBy(Number(s.x), Number(s.z));
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
      if (up || !blocked(px, pz)) {
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

  // P2 感知：注意身边经过的人/玩家 → 写一条短观察（进 s.saw 独立缓冲，不进 mem、不调 LLM）
  function perceive(s, now) {
    if (now - Number(s.perceiveAt || 0) < PERCEIVE_CD) return;
    let best = null, bd = PERCEIVE_RANGE * PERCEIVE_RANGE, isPlayer = false;
    for (const o of students) {
      if (o === s) continue;
      const dx = Number(o.x) - Number(s.x), dz = Number(o.z) - Number(s.z);
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = o; isPlayer = false; }
    }
    for (const p of playerPositions) {
      const dx = Number(p.x) - Number(s.x), dz = Number(p.z) - Number(s.z);
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = p; isPlayer = true; }
    }
    if (!best) return;
    const key = isPlayer ? 'player' : best.id;
    if (!s._seenAt) s._seenAt = {};
    if (now - Number(s._seenAt[key] || 0) < PERCEIVE_REPEAT_MS) return; // 刚注意到过，别重复记
    s.perceiveAt = now;
    s._seenAt[key] = now;
    // ⚠ 观察**写进 mem**（真正的记忆流）：它会被检索、喂给 prompt，真的影响之后的举止与说话。
    const text = isPlayer ? '我看见玩家从我附近过去了' : ('我看见' + String(best.name || '同学') + '也在这一带');
    s.mem.push({ t: now, text, kind: 'obs', from: isPlayer ? '' : best.id, src: isPlayer ? '亲眼看到' : ('亲眼看到' + String(best.name || '')) });
    trimMemory(s); // 超限时先丢观察（不花 LLM），见 trimMemory
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
  // ---------- 结构化自我档案（DeepSeek 架构「自我状态改造」）----------
  // 为什么不是把一堆字段平铺给模型：平铺 = 无优先级、无叙事锚点 ⇒ 身份漂移、状态混乱、记忆断裂。
  // 改成**固定分层 + 固定顺序**的一段：
  //   ① 我是谁（永恒：姓名/性别/性格/价值观）—— 每次完全一致，措辞顺序不变，**永不覆盖**
  //   ② 我的近况（当前：位置/状态/心情/身体/今日主线）—— 每轮**覆盖更新**，并以它为准
  //   ③ 我对自己的认识（自我叙事）—— 反思产物累积，让"自我"能随时间长出来
  // 关系与长期记忆不塞进来（各自有独立段，记忆另有三分检索），避免重复占上下文。
  function ensureValues(s) {
    if (s.values) return s.values;
    let h = 0;
    const nm = String(s.name || s.id || '');
    for (let i = 0; i < nm.length; i++) h = (h * 31 + nm.charCodeAt(i)) >>> 0;
    s.values = VALUES_TABLE[h % VALUES_TABLE.length];
    return s.values;
  }
  function moodBrief(s) {
    const m = s.mood || {};
    const v = Number(m.valence) || 0.5, e = Number(m.energy) || 0.5;
    return (v > 0.65 ? '心情不错' : v < 0.35 ? '心情有点低落' : '心情平平') + (e > 0.65 ? '、挺有精神' : e < 0.35 ? '、没什么力气' : '');
  }
  function needsBrief(s) {
    const n = s.needs || {};
    const items = [['hunger', '有点饿'], ['fatigue', '有点累'], ['fun', '想玩'], ['study', '想学习'], ['social', '想找人说话'], ['bladder', '想去厕所']];
    return items.map(([k, w]) => ({ w, v: Number(n[k]) || 0 })).filter((x) => x.v > 0.6)
      .sort((a, b) => b.v - a.v).slice(0, 2).map((x) => x.w).join('、');
  }
  function selfProfile(s) {
    const sex = s.sex === 'f' ? '女' : s.sex === 'm' ? '男' : '';
    const who = '我叫' + String(s.name || '同学') + (sex ? ('，' + sex + '生') : '')
      + '，' + String(s.cls || '这个班') + '的学生。我的性格是「' + String(s.persona || '普通学生') + '」，'
      + '我最看重的是「' + ensureValues(s) + '」。这是我一直以来的样子，不会变。';
    const nb = needsBrief(s);
    const nowLine = '我此刻在' + placeOf(s) + '，' + (String(s.st) === 'walk' ? '正在往别处走' : '停下来做自己的事')
      + '；' + moodBrief(s) + (nb ? ('；' + nb) : '')
      + (s.dayPlan && s.dayPlan.text ? ('。今天我原本打算' + String(s.dayPlan.text)) : '')
      + '。这是**当下**的我。';
    const nar = (Array.isArray(s.narrative) ? s.narrative : [])
      .map((x) => String((x && x.text) || '').trim()).filter(Boolean);
    const narLine = nar.length
      ? '我最近想明白了几件事：' + nar.slice(-2).join('；') + '。'
      : '（我还没认真想过自己最近的样子。）';
    return '· 我是谁（永不变）：' + who + '\n· 我的近况（会更新，以这里为准）：' + nowLine + '\n· 我对自己的认识：' + narLine;
  }
  // 一条记忆有多重要（0~1）。有 imp 就用它，否则按类型 + 线索词现算（确定性，便于断言）。
  function memImportance(m) {
    if (!m) return 0.3;
    if (Number.isFinite(Number(m.imp))) return clamp01(m.imp);
    let v = MEM_BASE_IMP[m.kind] != null ? MEM_BASE_IMP[m.kind] : 0.4;
    if (MEM_HOT_WORDS.test(String(m.text || ''))) v += 0.15;
    return clamp01(v);
  }
  // 记忆检索（斯坦福 Generative Agents 的 retrieval）：score = 相关度 + 新近度 + 重要度。
  //   relevance：与"当前地点 + 对方这句话"的字面重合（中文 2-gram）
  //   recency  ：指数衰减（半衰期 MEM_RECENCY_HL 分钟）
  //   importance：memImportance()（反思/委托/交付这类"大事"分高，路的观察分低）
  function pickMemory(s, extra) {
    const all = Array.isArray(s.mem) ? s.mem : [];
    if (all.length <= MEM_CTX) return all.slice();
    const now = Date.now();
    // query = 当前情境（我在哪）+ 对方这句话 + **我正打算做什么**（DeepSeek：用"当前情境 + 正在做的事"检索）
    const intentText = s.intent ? (String(s.intent.goalText || '') + ' ' + String(s.intent.activity || '')) : '';
    const kws = memKeywords(placeOf(s) + ' ' + String((extra && extra.text) || '') + ' ' + intentText);
    const scored = all.map((m, i) => {
      const txt = String((m && m.text) || '');
      let hit = 0;
      for (const k of kws) if (txt.indexOf(k) >= 0) hit++;
      const rel = kws.length ? Math.min(1, hit / 6) : 0;
      const ageMin = Math.max(0, (now - Number((m && m.t) || 0)) / 60000);
      const rec = Math.pow(0.5, ageMin / MEM_RECENCY_HL);
      return { m, i, score: MEM_W_REL * rel + MEM_W_REC * rec + MEM_W_IMP * memImportance(m) };
    });
    // 分高优先，同分按时间近的优先；选完再按时间顺序排回去（别让记忆乱序，模型会读着别扭）
    scored.sort((a, b) => (b.score - a.score) || (b.i - a.i));
    return scored.slice(0, MEM_CTX).sort((a, b) => a.i - b.i).map((x) => x.m);
  }
  // ---------- 对话上下文（多轮）----------
  // 每个学生按「说话人」分别留一份最近的对话原话。为什么要按人分：同一个学生可能先跟 A 聊、
  // 再跟 B 聊，混在一起会把两个话题接串（"你刚才说"指的是谁说的都乱了）。
  function chatHistory(s, who, now) {
    const key = String(who || 'p:?');
    const all = (s.chatLog && Array.isArray(s.chatLog[key])) ? s.chatLog[key] : [];
    // 过期的不带（旧话题别一直压着当下）
    const fresh = all.filter((m) => now - Number((m && m.t) || 0) < CHATLOG_TTL);
    return fresh.slice(-CHATLOG_MAX);
  }
  function pushChat(s, who, role, text) {
    const t = String(text || '').trim();
    if (!t) return;
    const key = String(who || 'p:?');
    if (!s.chatLog || typeof s.chatLog !== 'object') s.chatLog = {};
    if (!Array.isArray(s.chatLog[key])) s.chatLog[key] = [];
    s.chatLog[key].push({ who: role === 'p' ? 'p' : 'n', text: clampText(t, 120), t: Date.now() });
    if (s.chatLog[key].length > CHATLOG_MAX * 2) s.chatLog[key].splice(0, s.chatLog[key].length - CHATLOG_MAX * 2);
  }
  // 最近几条"心里话"（think 流）——喂回 prompt，让它的内心有连续性（想的事能接上）
  function recentThinks(s) {
    return (Array.isArray(s.think) ? s.think : []).slice(-THINK_CTX)
      .map((x) => String((x && x.text) || '').trim()).filter(Boolean);
  }
  // "最近听到的广播/公告"：一句话给人话（带来源），过期就不带
  function heardLine(s, now) {
    const h = s.heard;
    if (!h || !h.text) return '';
    if (now - Number(h.t || 0) > NOTICE_HEARD_TTL) return '';
    const from = String(h.from || '学校');
    return '【' + from + '】' + String(h.text);
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
  // ⚠★ 改道走**同一套 normalizeAct 翻译器**（不再自己维护一份动作白名单）：
  //   这样 LLM 在对话里说"跟着我/去操场/问问同学…"（甚至它自起的名）都会经同一个入口落到原语上。
  function applyTalkEffect(s, out, who) {
    if (!out) return;
    applyMoodWord(s, out.mood);
    if (Number.isFinite(Number(out.affinity))) bumpRel(s, who, Number(out.affinity) * 0.6, out.mem);
    // ⚠ 这次是**委托办事**（有 task）⇒ 走位由任务状态机接管，别再用 goalType 改道：
    //   两套走位同时生效时，"让你去找人"会顺带触发一次无关的寻路（用户实测的"也触发寻路了"）。
    if (out.task && out.task.target) return;
    const now = Date.now();
    const note = '（受对话影响）' + clampText(out.mem || out.say || '', 40);

    // ⚠★ 只认**显式的改道信号**：goalType / goalWho / seek。绝不用 say 的自由文字当依据
    //   —— 否则模型随口一句"歇会儿/走走"就会把 NPC 正在做的事（比如刚听到的通知）覆盖掉。
    const raw = String(out.goalType || '').trim().toLowerCase();
    const goalWho = String(out.goalWho || out.seek || '').trim();
    if (!raw && !goalWho) return; // 没给任何改道信号 ⇒ 什么都不动（只改心情/关系）
    // 交给 translateIntent：把"自然语言的意图"统一翻成 {goalType,seek,keep,...}
    //   goal 一起传：goalType 认不出时（如"去吃饭"），靠 goal 的文字读地方。
    const tr = translateIntent({ goalType: raw, goalWho, seek: String(out.seek || ''), goal: String(out.goal || out.mem || ''), type: '', action: '', target: '', params: {} });
    const gt = tr.goalType;

    // 自主动作（两个"好奇"行为）：复用既有实现
    if (gt === 'explore') { startExplore(s, now); if (s.intent) s.intent.goalText = note; return; }
    if (gt === 'inquire') { startInquire(s, now); if (s.intent) s.intent.goalText = note; return; }
    if (gt === 'rest') { s.st = 'act'; s.stayUntil = now + 30000; s.intent = { goalType: 'rest', goalText: note, activity: '', plan: '', since: now }; return; }
    // 「去找某人 / 跟着某人」：复用 person 原语（keep 决定到跟前停不停）
    if (tr.seek) {
      const keep = !!tr.keep;
      if (/玩家/.test(tr.seek)) {
        const p = nearestPlayer(s);
        if (!p) return;
        s.intent = { goalType: 'person', goalText: keep ? '跟着玩家' : '去找玩家', activity: '', plan: '', seekPlayer: true, keep, since: now };
        setTarget(s, Number(p.x), Number(p.z));
        s.st = 'walk'; s.walkUntil = now + WALK_TIMEOUT * 1000; s.stuck = 0;
        console.info('[npc] ' + s.name + (keep ? ' 开始跟着玩家走（对话）' : ' 去找玩家（对话）'));
        return;
      }
      const t = resolveStudentByName(tr.seek);
      if (t && t !== s) {
        s.intent = { goalType: 'person', goalText: (keep ? '跟着' : '去找') + t.name, activity: '', plan: '', seekId: t.id, keep, since: now };
        setTarget(s, Number(t.x), Number(t.z));
        s.st = 'walk'; s.walkUntil = now + WALK_TIMEOUT * 1000; s.stuck = 0;
        return;
      }
    }
    // 其余：合法区域 → 走过去；wander → 随便走走；认不出就**不动**（别臆造去处）
    if (gt === 'wander') { wander(s, now); s.intent = { goalType: 'wander', goalText: note, activity: '', plan: '', since: now }; return; }
    if (ZONE_TYPE_IDS.has(gt)) {
      const z = pickOne(zonesOfType(gt));
      if (!z) return;
      goZone(s, now, z);
      s.intent = { goalType: gt, goalText: note, activity: '', plan: '', since: now };
    }
  }
  // 关系 key（'p:xxx' 玩家 / 学生 id）→ 人话名字。
  // ⚠ 以前直接把 's3' 这种**内部 id** 喂给模型，模型根本不知道那是谁，还容易把自己（s1）和对方搞混
  //   （"模糊自己和对方"就是这么来的）。统一解析成人名再进 prompt。
  function relNameOf(key) {
    const k = String(key || '');
    if (isPlayerKey(k)) return '玩家';
    const o = students.find((x) => x.id === k);
    return o ? o.name : '';
  }
  // 给 LLM 的关系摘要：只挑好感/反感最强的几条（别把整张关系表塞进 prompt），且**一定给人名**
  function topRel(s) {
    const r = s.rel || {};
    return Object.entries(r)
      .map(([k, v]) => ({ name: relNameOf(k), trust: Number(v && v.trust) || 0 }))
      .filter((x) => x.name && Math.abs(x.trust) > 0.05)
      .sort((a, b) => Math.abs(b.trust) - Math.abs(a.trust)).slice(0, 3)
      .map((x) => ({ name: x.name, trust: Math.round(x.trust * 100) / 100 }));
  }

  // ---------- P1：NPC↔NPC 闲聊（同学之间"活起来"）----------
  // 一次 LLM 出一段 2~4 句脚本 → 双方各写记忆（含对方）、改心情、改彼此关系；台词逐句广播（玩家能偷听）。
  // 全局限流（CHAT_INTERVAL）+ 个人冷却（CHAT_COOLDOWN）+ 模板兜底 = 不刷爆 GLM、也绝不静默卡住。
  // 这个学生此刻能不能参与闲聊（"有任务在身 / 正要去见某人 / 刚聊过"都排除）
  function chatIdle(x, now, allowWalk) {
    if (x._chatting || x._inquiring || x.quest) return false;
    // 已经在去见某人/办事的路上，别重复派（含"四处问人"——否则两套系统会抢同一个人）
    if (x.intent && (x.intent.goalType === 'person' || x.intent.goalType === 'quest' || x.intent.goalType === 'inquire')) return false;
    if (now < Number(x.talkingUntil || 0)) return false;
    if (now - Number(x.chatAt || 0) < CHAT_COOLDOWN * 1000) return false;
    if (allowWalk) return true;
    // ⚠ 只认 idle/act 时：学生大部分时间在走位 ⇒ 几乎从不闲聊（用户实测"AI 之间没有对话的欲望"）。
    //   所以"已经凑得很近"时允许边走边停下聊；只有"离得远、要专门绕过去"才要求人闲着。
    return x.st === 'idle' || x.st === 'act';
  }
  // 找一对可以聊的学生（返回 maxRange 米内最近的一对）；allowWalk=允许正在走位的人也停下来聊
  function pickPair(now, maxRange, allowWalk) {
    let best = null, bd = maxRange * maxRange;
    for (let i = 0; i < students.length; i++) {
      const a = students[i];
      if (!chatIdle(a, now, allowWalk)) continue;
      for (let j = i + 1; j < students.length; j++) {
        const b = students[j];
        if (!chatIdle(b, now, allowWalk)) continue;
        const dx = Number(a.x) - Number(b.x), dz = Number(a.z) - Number(b.z);
        const d = dx * dx + dz * dz;
        if (d < bd) { bd = d; best = [a, b]; }
      }
    }
    return best;
  }
  // "靠得近就该开口"：随机但**有上界** —— 同一对靠得近最多 CHAT_NEAR_MAX 秒一定会聊起来。
  // 每拍的成功率取 dt/剩余时间：既有人味（随机几拍之后才开口），又不会出现"两人站一起半天不说话"。
  function chatRoll(a, b, now, dt) {
    if (!(a._nearWith === b.id && b._nearWith === a.id)) {
      a._nearWith = b.id; b._nearWith = a.id; a._nearSince = now;
    }
    const el = Math.max(0, (now - Number(a._nearSince || now)) / 1000);
    const remain = Math.max(0.2, CHAT_NEAR_MAX - el);
    return el >= CHAT_NEAR_MAX || Math.random() < dt / remain;
  }
  // 想聊但离得远 → 两人**相向走近**（纯走位、不花 LLM）；靠近后由 pickPair(CHAT_RANGE) 接手开聊。
  // 这一步治"AI 之间各站各的、永远凑不到一起"。
  function startMeet(a, b, now) {
    a.intent = { goalType: 'person', goalText: '去找' + b.name + '聊聊', activity: '', plan: '', seekId: b.id, since: now };
    b.intent = { goalType: 'person', goalText: '去找' + a.name + '聊聊', activity: '', plan: '', seekId: a.id, since: now };
    setTarget(a, Number(b.x), Number(b.z)); a.st = 'walk'; a.walkUntil = now + WALK_TIMEOUT * 1000; a.stuck = 0;
    setTarget(b, Number(a.x), Number(a.z)); b.st = 'walk'; b.walkUntil = now + WALK_TIMEOUT * 1000; b.stuck = 0;
    console.info('[npc] ' + a.name + ' ↔ ' + b.name + ' 想聊两句，正相向走近');
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
    a.mem.push({ t: t0, text: '我和' + b.name + '聊了两句：' + tpl[0], kind: 'chat', from: b.id, src: b.name });
    b.mem.push({ t: t0, text: '我和' + a.name + '聊了两句：' + tpl[1], kind: 'chat', from: a.id, src: a.name });
  }
  let chatBusy = false; // 同一时刻只跑一段闲聊（控并发 / 额度）
  // 一段完整闲聊：**多轮往返** + 知识分享。
  // ⚠ 为什么拆成循环而不是"一次出一整段脚本"：一次 LLM 出的脚本是**单轮快照**，说完就散；
  //   用户要的是"能持续聊下去"。做法是把上一轮真实台词（`chat` 上下文）**回灌**进下一轮 prompt，
  //   让 LLM 接着往下说（拼上下文的活交给 ai-student.js 的 prompt 组装，这里只负责把 transcript 传过去）。
  //   要不要继续由 **LLM 的 continue 字段**决定（代码只提供旋钮，不写死对话内容）。
  async function converse(a, b) {
    if (chatBusy || !a || !b || a === b) return;
    chatBusy = true;
    a._chatting = true; b._chatting = true;
    const t0 = Date.now();
    a.chatAt = t0; b.chatAt = t0;
    a.talkingUntil = t0 + 20000; b.talkingUntil = t0 + 20000; // 期间别再开聊、先站住
    // 本次对话的完整台词流水（供多轮上下文 + 结尾的记忆归属），两人看到的是同一份
    const transcript = [];
    let topicAll = '';
    let replied = false; // 是否至少聊过一轮（决定要不要写"聊了两句"的兜底记忆）
    try {
      for (let round = 1; round <= CHAT_ROUNDS_MAX; round++) {
        // ⚠ 每轮都重新取记忆：上一轮刚写进去的"他告诉我…"要能被下一轮看见（知识真的在流动）
        const bond = Number((a.rel[b.id] && a.rel[b.id].trust) || 0);
        const out = await askStudent({
          student: {
            name: a.name, cls: a.cls, persona: a.persona, sex: a.sex, place: placeOf(a), st: a.st,
            needs: a.needs, mood: a.mood, rel: topRel(a), player: playerWhere(a),
            boardLine: boardLine(), self: selfProfile(a),
            // 场景/通知：让他讲的是"我这儿的实况"，不是空话
            scene: sceneLine(a), heard: heardLine(a, t0),
          },
          partner: { name: b.name, cls: b.cls, persona: b.persona, sex: b.sex },
          // ★ 知识分享的关键：**两边各自**的记忆 + 见闻都喂进去，LLM 自然会把"我知道的事"讲出来。
          memory: pickMemory(a, null),
          partnerMemory: pickMemory(b, null),   // 对方知道的（问它"你知道吗"时能对得上）
          partnerHeard: heardLine(b, t0),        // 对方最近听到的通知
          // 已经聊过的上文（旧→新）——第二轮起才有，这就是"接着聊"的依据
          chat: transcript.slice(),
          kind: 'chat',
          bond,
          topic: topicAll,     // 已经聊的主题（让 LLM 别跑题）
        });
        // 兜底：LLM 挂了/空脚本 → 用模板寒暄收场（零成本，别僵住）
        const lines = (out && Array.isArray(out.lines)) ? out.lines.slice(0, 4) : [];
        if (!lines.length) {
          if (!replied) { templateChat(a, b); return; }
          break; // 已经聊过 ≥1 轮，这轮没接上就自然收尾
        }
        replied = true;
        const rt = Date.now();
        // 逐句广播（复用 npc_say → 客户端气泡；玩家能偷听到他们的对话）
        lines.forEach((ln, i) => {
          const who = ln.who === 'b' ? b : a;
          const say = clampText(ln.text, LEN_SAY);
          if (!say) return;
          transcript.push({ speaker: who.name, who: ln.who === 'b' ? 'b' : 'a', text: say });
          const delay = i * CHAT_LINE_GAP_MS;
          if (delay === 0) broadcast({ t: 'npc_say', id: who.id, say });
          else { const tm = setTimeout(() => broadcast({ t: 'npc_say', id: who.id, say }), delay); if (tm.unref) tm.unref(); }
        });
        // 站着聊：把停留时间顺延到这段说完之后（别聊到一半人走了）
        a.st = 'act'; b.st = 'act';
        const chatEnd = rt + lines.length * CHAT_LINE_GAP_MS + 1500;
        a.stayUntil = Math.max(Number(a.stayUntil || 0), chatEnd);
        b.stayUntil = Math.max(Number(b.stayUntil || 0), chatEnd);
        // ⚠ 多轮会把占用时间拉长（可能 >20s）⇒ talkingUntil 也要跟着顺延，否则别处的限流会以为
        //   他们"已经聊完了"，中途把两个人又派走去干别的（把人从对话里拽走）。
        a.talkingUntil = Math.max(Number(a.talkingUntil || 0), chatEnd + 1000);
        b.talkingUntil = Math.max(Number(b.talkingUntil || 0), chatEnd + 1000);
        if (round === 1) {
          topicAll = clampText(out.topic, 12);
        } else if (out.topic) {
          topicAll = clampText(out.topic, 12) || topicAll;
        }
        // 记忆（各自记）：**按实际台词结构化归属** —— 谁说的就是谁说的。
        // ⚠ 以前直接信模型给的 memA/memB：一次调用同时写两个人的记忆，模型很容易把"我说/他说"写反、
        //   或者把对方的经历写进自己的记忆（"记忆也不对"就是这儿）。这里用真实台词兜底，保证归属正确。
        const aSaid = lines.filter((l) => l.who === 'a').map((l) => clampText(l.text, 20)).filter(Boolean);
        const bSaid = lines.filter((l) => l.who === 'b').map((l) => clampText(l.text, 20)).filter(Boolean);
        const headA = '我和' + b.name + (topicAll ? '聊到' + topicAll : '聊了两句');
        const headB = '我和' + a.name + (topicAll ? '聊到' + topicAll : '聊了两句');
        const tailA = aSaid.length ? ('：我说「' + aSaid[0] + '」，' + b.name + '说「' + (bSaid[0] || '') + '」') : '';
        const tailB = bSaid.length ? ('：' + a.name + '说「' + (aSaid[0] || '') + '」，我说「' + bSaid[0] + '」') : '';
        a.mem.push({ t: rt, text: clampText(headA + tailA, LEN_MEM), kind: 'chat', from: b.id, src: b.name });
        b.mem.push({ t: rt, text: clampText(headB + tailB, LEN_MEM), kind: 'chat', from: a.id, src: a.name });
        // ★ 知识分享的落地：如果这一轮里某方**讲了一件"事情"**（share 字段：谁把什么告诉了谁），
        //   就把它结构化成一条带来源的记忆写进**听者**那边 —— "（X 告诉我）…" 的传播链就是这么建起来的。
        //   注意：只记 LLM 明确标出的"分享"（不是每句话都当知识），免得把寒暄也记成见闻。
        const sh = out && out.share;
        if (sh && sh.what) {
          const what = clampText(sh.what, 40);
          const dir = String(sh.from || '').trim(); // 'a'=a 讲给 b 听，'b'=b 讲给 a 听
          const speaker = (dir === 'b') ? b : a;
          const listener = (dir === 'b') ? a : b;
          if (what && speaker !== listener) {
            listener.mem.push({ t: rt, text: clampText('（' + speaker.name + '告诉我）' + what, LEN_MEM), kind: 'chat', src: speaker.name, from: speaker.id, imp: 0.55 });
            speaker.mem.push({ t: rt, text: clampText('我把「' + what + '」告诉了' + listener.name, LEN_MEM), kind: 'chat', src: listener.name, from: listener.id });
            bumpRel(listener, speaker.id, 0.06, ''); // 有人告诉我点事 → 亲近一点
          }
        }
        // 模型给的"聊完记住的点"只进内心活动（不进记忆流，避免它把归属写乱）
        if (out.memA) a.think.push({ t: rt, text: clampText(out.memA, LEN_THINK) });
        if (out.memB) b.think.push({ t: rt, text: clampText(out.memB, LEN_THINK) });
        for (const x of [a, b]) if (x.think.length > MEM_MAX) x.think.splice(0, x.think.length - MEM_MAX);
        applyMoodWord(a, out.moodA);
        applyMoodWord(b, out.moodB);
        if (Number.isFinite(Number(out.bond))) { bumpRel(a, b.id, Number(out.bond) * 0.5); bumpRel(b, a.id, Number(out.bond) * 0.5); }
        await trimMemory(a); await trimMemory(b);
        saveStudents(students);
        const roundTopic = clampText(out.topic, 16) || topicAll;
        console.info('[npc] ' + a.name + ' ↔ ' + b.name + ' 闲聊 第' + round + '轮：' + roundTopic);
        // ---- 要不要**接着聊**：由 **LLM 的 continue 决定**（它想收尾就停），
        //   概率只作为"还能再多聊一轮"的**成本保险**（不是决定性的抛硬币 —— 否则会随机砍掉正常对话）。
        //   轮次上限 CHAT_ROUNDS_MAX 兜住总额度。----
        if (out.continue === false) break;      // LLM 明确收尾
        if (round >= CHAT_ROUNDS_MAX) break;    // 到轮次上限
        await sleep(CHAT_REPLY_GAP_MS);         // 轮之间喘口气，像真在对话
      }
    } catch (e) {
      console.warn('[npc] 闲聊失败 ' + a.id + '↔' + b.id + '：' + ((e && e.message) || e));
      if (!replied) { try { templateChat(a, b); } catch { /* 兜底也失败就算了 */ } }
    } finally {
      a._chatting = false; b._chatting = false;
      const until = Date.now() + CHAT_COOLDOWN * 1000;
      a.talkingUntil = until; b.talkingUntil = until;
      // 见完面了：清掉"去找某人"的意图（否则会一直占着，导致他俩再也不能被撮合）
      for (const x of [a, b]) if (x.intent && x.intent.goalType === 'person') x.intent = null;
      chatBusy = false;
    }
  }

  // ---------- P3：委托任务 ----------
  // 玩家让 NPC「去找 X 问 Y，回来告诉我」→ s.quest 驱动状态机：
  //   goto(走向目标，目标会动→定期重指) → ask(问，一次 LLM) → return(走回玩家) → report(复命)。
  // 全程超时兜底；找不到人/找不到玩家/提问失败一律**出声**回报，绝不静默卡住。
  function resolveStudentByName(name) {
    const q = String(name || '').trim();
    if (!q) return null;
    return students.find((x) => x.name === q)
      || students.find((x) => x.name && (x.name.indexOf(q) >= 0 || q.indexOf(x.name) >= 0))
      || null;
  }
  // "找你自己 / 找你 / 找自己" 这类说法指的是**被搭话的那个学生本人**：
  // ⚠ 不能让它去建任务、更不能因此触发寻路（用户实测："我让他找他自己也触发寻路了"）。
  const SELF_WORDS = /^(你|你自己|您|您自己|自己|我|我自己|本人|你本人|你自己本人|你的名字|你自己吧)$/;
  function startQuest(s, targetName, question, fromId, fromName) {
    const raw = String(targetName || '').trim();
    if (SELF_WORDS.test(raw)) {
      broadcast({ t: 'npc_say', id: s.id, say: '我就是' + s.name + '呀，你要问什么直接问我就行。' });
      return;
    }
    const t = resolveStudentByName(raw);
    if (!t) {
      broadcast({ t: 'npc_say', id: s.id, say: '你说的「' + raw.slice(0, 8) + '」，我这儿对不上人呀。' });
      return;
    }
    if (t === s) {
      // 名字解析出来就是它自己（"去找顾星桥"而它就叫顾星桥）——同一个道理：就地回答，别跑。
      broadcast({ t: 'npc_say', id: s.id, say: '嗨，我就是' + s.name + '呀，你直接问我就行。' });
      return;
    }
    const now = Date.now();
    s.quest = {
      stage: 'goto', targetId: t.id, targetName: t.name,
      question: clampText(question, 80) || '（没说要问啥）',
      fromId: String(fromId || ''), fromName: String(fromName || '玩家'),
      answer: '', createdAt: now, repathAt: 0,
    };
    s.intent = { goalType: 'quest', goalText: '去找' + t.name, activity: '', plan: '', since: now };
    // 立刻起步（不等下一拍），真的朝目标人走过去
    setTarget(s, Number(t.x), Number(t.z));
    s.st = 'walk'; s.walkUntil = now + WALK_TIMEOUT * 1000; s.stuck = 0;
    broadcast({ t: 'npc_say', id: s.id, say: '好，我去找' + t.name + '问问。' });
    console.info('[npc] ' + s.name + ' 接下委托：找 ' + t.name + ' 问「' + s.quest.question + '」');
  }
  function failQuest(s, why) {
    const had = !!s.quest;
    s.quest = null;
    s.intent = null;
    if (had) broadcast({ t: 'npc_say', id: s.id, say: '（' + String(why || '这事没办成') + '，回头再跟你说）' });
    console.warn('[npc] ' + s.id + ' 任务中断：' + why);
  }
  // 任务当前该走向哪：goto → 目标同学；return → **委托你的那个玩家**（找不到就退回"最近的玩家"，
  // 免得玩家中途重连换了连接 id 就让 NPC 举着委托原地发呆）。
  function questGoalPoint(s, q) {
    if (!q) return null;
    if (q.stage === 'goto') {
      const t = students.find((x) => x.id === q.targetId);
      return t ? { x: Number(t.x), z: Number(t.z) } : null;
    }
    if (q.stage === 'return') {
      // ⚠ 用 stabil 键找人（q.fromId 是稳定键）⇒ 玩家刷新/重连后仍认得回去找谁；
      //   认不出再退回"身边最近的玩家"（兜底，别让委托因为一次重连就失败）。
      const p = playerByOwner(q.fromId) || playerById(q.fromId) || nearestPlayer(s);
      return p ? { x: Number(p.x), z: Number(p.z) } : null;
    }
    return null;
  }
  function updateQuest(s, now) {
    const q = s.quest;
    if (!q) return;
    if (now - Number(q.createdAt || 0) > QUEST_TIMEOUT_MS) { failQuest(s, '时间太久'); return; }
    if (q.stage === 'asking') return; // 等 LLM 回话
    const goal = questGoalPoint(s, q);
    if (!goal) { failQuest(s, q.stage === 'goto' ? ('找不到' + q.targetName) : '找不到你了'); return; }
    const d = Math.hypot(goal.x - Number(s.x), goal.z - Number(s.z));
    if (d < QUEST_MEET_DIST) {
      if (q.stage === 'goto') {
        const t = students.find((x) => x.id === q.targetId);
        if (!t) { failQuest(s, '找不到' + q.targetName); return; }
        askQuest(s, t);
      } else reportQuest(s);
      return;
    }
    // 追了很久还贴不到 3m（玩家在楼里/被挡住）→ 够近(12m)就**就地汇报**，别让委托永远悬着
    if (q.stage === 'return' && d < QUEST_CLOSE_ENOUGH && now - Number(q.returnAt || 0) > QUEST_SOFT_MS) { reportQuest(s); return; }
    if (now - Number(q.repathAt || 0) > QUEST_REPATH_MS) { // 目标会动 → 定期重指
      q.repathAt = now; setTarget(s, goal.x, goal.z);
      s.st = 'walk'; s.walkUntil = now + WALK_TIMEOUT * 1000; s.stuck = 0;
    }
  }
  async function askQuest(s, t) {
    const q = s.quest;
    if (!q) return;
    q.stage = 'asking';
    s.st = 'act'; s.stayUntil = Date.now() + 6000;
    broadcast({ t: 'npc_say', id: s.id, say: t.name + '，' + String(q.question).slice(0, 30) + '？' });
    try {
      const ans = await askStudent({
        student: { name: t.name, cls: t.cls, persona: t.persona, sex: t.sex, place: placeOf(t), st: t.st, needs: t.needs, mood: t.mood, rel: topRel(t), player: playerWhere(t), boardLine: boardLine() },
        memory: pickMemory(t, null),
        kind: 'ask',
        question: q.question,
        askerName: s.name,
      });
      q.answer = clampText(ans && ans.say, LEN_SAY) || '（他说不知道）';
      const ts = Date.now();
      // ⚠ 被问的同学也要留下**心理活动**（"每一次 AI 调用都产生心理活动"）：
      //   以前这里只用了 say，它"心里怎么想"被直接丢了。
      const tth = clampText(ans && ans.think, LEN_THINK);
      if (tth) {
        t.think.push({ t: ts, text: tth });
        if (t.think.length > MEM_MAX) t.think.splice(0, t.think.length - MEM_MAX);
      }
      s.mem.push({ t: ts, text: '我问' + t.name + '「' + q.question + '」，他答：' + q.answer, kind: 'quest', from: t.id, src: t.name });
      t.mem.push({ t: ts, text: s.name + '问我「' + q.question + '」', kind: 'quest', from: s.id, src: s.name });
      broadcast({ t: 'npc_say', id: t.id, say: q.answer });
      trimMemory(s); trimMemory(t); saveStudents(students);
      // 问到了 → 立刻掉头**走向委托你的玩家**复命（不是"附近有人就算到"）
      q.stage = 'return'; q.repathAt = 0; q.returnAt = Date.now();
      const back = playerByOwner(q.fromId) || playerById(q.fromId) || nearestPlayer(s);
      if (back) { setTarget(s, Number(back.x), Number(back.z)); s.st = 'walk'; s.walkUntil = Date.now() + WALK_TIMEOUT * 1000; s.stuck = 0; }
    } catch (e) {
      console.warn('[npc] 任务提问失败：' + ((e && e.message) || e));
      failQuest(s, '话没问成');
    }
  }
  function reportQuest(s) {
    const q = s.quest;
    if (!q) return;
    const line = q.targetName + '说：' + q.answer;
    broadcast({ t: 'npc_say', id: s.id, say: '问到了 —— ' + line });
    s.st = 'act'; s.stayUntil = Date.now() + 5000;
    s.mem.push({ t: Date.now(), text: '我把' + q.targetName + '的话回报给了玩家', kind: 'quest' });
    console.info('[npc] ' + s.name + ' 完成委托：' + line);
    s.quest = null;
    s.intent = null;
  }

  // 产出 {say, think, mem} 后清洗入库；think 广播给附近玩家看，say 走对话或气泡。
  // ⚠ 冷却：同一个学生 AI_COOLDOWN 秒内只调一次（免费档有限流，8 个学生不能一起刷）。
  let aiBusy = new Set();
  async function triggerAI(s, kind, extra) {
    const now = Date.now();
    if (aiBusy.has(s.id)) return null;
    // notice（听到广播/公告）与 talk 一样属**事件驱动**：广播本身已被玩家侧 60s 限流 + 轮流 4s 一个个下发，
    // 不再叠 AI_COOLDOWN —— 否则 8 个学生轮流一圈 32s < 45s，会有学生"听到了却没有心理活动"。
    if (kind !== 'talk' && kind !== 'notice' && now - Number(s.aiAt || 0) < AI_COOLDOWN * 1000) return null;
    s.aiAt = now;
    aiBusy.add(s.id);
    try {
      const out = await askStudent({
        student: {
          name: s.name, cls: s.cls, persona: s.persona, sex: s.sex,
          place: placeOf(s), // 按**坐标**判定，不是按"打算去哪"——以前那样会让他在教室说自己在图书馆
          self: selfProfile(s), // 结构化自我档案（固定分层，放最前 ⇒ 身份稳、状态准）
          st: s.st,
          needs: s.needs,
          mood: s.mood,      // 心情（被对话改）→ 这次说话/行动带着情绪
          rel: topRel(s),    // 关系摘要（被对话改）→ 记得跟谁亲、跟谁不对付
          player: playerWhere(s), // 玩家在哪（说人话）→ 别一问"你在哪/玩家在哪"就瞎编
          boardLine: boardLine(),
          // 最近听到的广播/公告（说人话）→ 它得**照通知调整计划**，不能听过就忘
          heard: heardLine(s, now),
          // 场景识别（我周围有什么 / 学校有哪些地方 / 刚注意到什么）→ 说话才有"现场感"
          scene: sceneLine(s), places: placesLine(s), noticed: String(s.noticed || ''),
          // 商店在售：它"反过来请玩家代买"时，只能点**真实在售**的东西（不然会开口要一件买不到的）
          shop: kind === 'talk' ? shopPool.slice(0, 40).map((x) => x.name) : undefined,
        },
        // ⚠ 只给**这个学生本人**的记忆，而且是挑出来的几条（不是整串）。
        //   混进别人的记忆 = 几个人的经历串台；一次给太多 = 模型自己搅成一团。
        memory: pickMemory(s, extra),
        // 最近的心里话（think 流）→ 让内心有连续性：它上一刻在想的事，这一刻还接得上
        thinks: recentThinks(s),
        // 对话上下文：这一轮**之前**的最近几轮原话（带顺序），否则它接不上上一句
        chat: kind === 'talk' ? chatHistory(s, extra && extra.who, now) : undefined,
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
        // 归属：这条记忆是"谁带来的"（玩家= p:<id>，或同学 id）——存档里带上，别再让记忆悬空。
        // src = 人话来源（"听谁说的"）⇒ 检索输出成"（顾星桥告诉我）…"（斯坦福缺口 D：记忆有传播链）。
        const srcName = (kind === 'talk' || kind === 'notice') ? String((extra && extra.name) || '') : '';
        s.mem.push({ t: now, text: mem, kind: kind === 'talk' ? 'say' : '', from: (extra && extra.who) || '', src: srcName });
        await trimMemory(s);
      }
      // ★ 玩家对话的记忆**必须忠实**：模型自由发挥的 mem 经常篡改（实测：你问"食堂有什么好吃的"，
      //   它记成"食堂今天推出了红烧肉"；你让它"站住等我"，它记成"周野似乎有事找我"）。
      //   ⇒ talk 时**以玩家原话为准**生成一条结构化记忆（原话 + 我怎么回应的），
      //     模型自己的 insights 挪去 think（内心活动），不再污染记忆流。
      if (kind === 'talk' && extra && extra.text) {
        const said = clampText(String(extra.text).replace(/\s+/g, ' ').trim(), 40);
        const myReply = clampText(String(say || '').replace(/\s+/g, ' ').trim(), 30);
        const who2 = String(extra.name || '玩家');
        const text2 = '「' + who2 + '」对我说：「' + said + '」' + (myReply ? '，我回：「' + myReply + '」' : '');
        s.mem.push({ t: now, text: clampText(text2, LEN_MEM), kind: 'say', from: String(extra.who || ''), src: who2 });
        await trimMemory(s);
      }
      // 对话/通知的"影响"：改心情 / 改关系 / 必要时改道（notice 也走这条 ⇒ 听到通知真的会改主意去）
      if (kind === 'talk' || kind === 'chat' || kind === 'notice') {
        try { applyTalkEffect(s, out, extra && extra.who); }
        catch (e) { console.warn('[npc] 对话影响应用失败 ' + s.id + '：' + ((e && e.message) || e)); }
      }
      // 反向委托：对话里它**反过来请玩家帮忙**买件东西（LLM 给的 item 必须在商店目录里才对得上，
      // 认不出就忽略 —— 绝不让它开口要一个游戏里买不到的东西）
      if (kind === 'talk' && out.request && out.request.item && !s.want && (now - Number(s._wantAt || 0) > WANT_CD)) {
        const q = String(out.request.item).trim();
        const it = shopPool.find((x) => x.name === q) || shopPool.find((x) => q && x.name.indexOf(q) >= 0);
        if (it) {
          s.want = {
            itemId: it.id, itemName: it.name, price: it.price,
            reward: Math.max(8, Math.round(it.price * WANT_REWARD_RATE)),
            reason: clampText(out.request.reason || '', 40),
            createdAt: now,
            // ⚠ 存**完整稳定键**（u:/anon:/p:），别剥前缀：交付时玩家可能已重连，
            //   靠稳定键才能认出"还是同一个人"，否则跨重连认不出来。
            playerId: String((extra && extra.who) || ''),
          };
          s._wantAt = now;
          // say 里没说清楚就把请求补一句（玩家得看得懂"要什么"才能去买）
          if (String(say).indexOf(it.name) < 0) {
            broadcast({ t: 'npc_say', id: s.id, say: '顺便——能帮我买一个「' + it.name + '」带回来吗？（约 ¥' + it.price + '）' });
          }
          console.info('[npc] ' + s.name + ' 请玩家代买「' + it.name + '」（对话触发）');
        }
      }
      // 委托任务：玩家让 NPC 去找人/问事 → 建任务（真的会去办）
      if (kind === 'talk' && out.task && out.task.target) {
        try { startQuest(s, out.task.target, out.task.question, extra && extra.who, extra && extra.name); }
        catch (e) { console.warn('[npc] 任务创建失败 ' + s.id + '：' + ((e && e.message) || e)); }
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
    // ⚡ 先丢"感知类"低价值记忆腾地方（纯本地、**不花 LLM**）：观察量大、价值低，正好先淘汰它。
    //   只有连观察都丢光了还超限（说明是正经记忆太多）才让 AI 压缩最老的几条。
    while (s.mem.length > MEM_MAX) {
      const i = s.mem.findIndex((m) => m && m.kind === 'obs');
      if (i < 0) break;
      s.mem.splice(i, 1);
    }
    if (s.mem.length <= MEM_MAX) return;
    try {
      // 压缩最老的几条，但**别把"反思"压掉**（那是它自己的认识，最该留）——优先挑最老的非反思记忆
      const idx = [];
      for (let i = 0; i < s.mem.length && idx.length < MEM_COMPRESS; i++) if (s.mem[i] && s.mem[i].kind !== 'reflect') idx.push(i);
      for (let i = 0; i < s.mem.length && idx.length < MEM_COMPRESS; i++) if (idx.indexOf(i) < 0) idx.push(i);
      idx.sort((a, b) => b - a);
      const picked = [];
      for (const i of idx) picked.push(s.mem.splice(i, 1)[0]);
      picked.reverse();
      const oldest = picked.map((m) => String((m && m.text) || ''));
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

  // ---------- 反思（reflection）：把近期经历压成"更高层的认识" ----------
  // 斯坦福那套的关键一环：不只是记流水账，还会**回头想**。洞见进记忆流（重要度最高）⇒
  // 被检索到 ⇒ 影响之后的说话与决定 ⇒ 角色越活越有"自己的想法"。
  // 控成本：同一个学生 8 分钟最多想一次、且至少攒够 REFLECT_MIN_NEW 条新记忆；全局同一时刻只跑一个。
  let reflectBusy = false;
  function maybeReflect(s, now) {
    if (reflectBusy || s._reflecting) return false;
    if (now - Number(s.reflectAt || 0) < REFLECT_CD) return false;
    // 触发条件（DeepSeek：重要的经历会把"想"顶起来）：攒够**条数** 或 攒够**重要度累加** —— 二者其一即可。
    //   关键事件能沉淀 = 哪怕只发生一两件大事（重要度高），也值得停下来想一想；
    //   反之天天一堆琐碎观察（重要度低）不该老触发（条数够才触发）。
    const newCount = (s.mem || []).length - Number(s._memAtReflect || 0);
    const curImp = (s.mem || []).reduce((acc, m) => acc + memImportance(m), 0);
    const newImp = curImp - Number(s._impAtReflect || 0);
    if (newCount < REFLECT_MIN_NEW && newImp < REFLECT_IMP_SUM) return false;
    s._reflecting = true; reflectBusy = true;
    s.reflectAt = now;
    s._memAtReflect = (s.mem || []).length;
    s._impAtReflect = curImp;
    (async () => {
      try {
        // 喂"最近 + 最重要"的几条：让它想值得想的事，而不是刚路过的观察
        const recent = (s.mem || []).slice(-10)
          .slice().sort((a, b) => memImportance(b) - memImportance(a)).slice(0, 6);
        const out = await askStudent({
          student: { name: s.name, cls: s.cls, persona: s.persona, sex: s.sex, place: placeOf(s), st: s.st, needs: s.needs, mood: s.mood, rel: topRel(s), player: playerWhere(s), self: selfProfile(s) },
          memory: recent,
          kind: 'reflect',
        });
        const list = (out && Array.isArray(out.insights)) ? out.insights.slice(0, 3) : [];
        let n = 0;
        for (const t of list) {
          const txt = clampText(t, LEN_MEM);
          if (!txt) continue;
          s.mem.push({ t: now, text: txt, kind: 'reflect', imp: 0.95 }); // 重要度拉满：反思最该被记住
          // 同时写进**自我叙事层**（累积）：它让"我是谁"随时间长出来，喂回 prompt 的最前面。
          if (!Array.isArray(s.narrative)) s.narrative = [];
          if (!s.narrative.some((x) => x && x.text === txt)) {
            s.narrative.push({ t: now, text: txt });
            if (s.narrative.length > NARRATIVE_MAX) s.narrative.splice(0, s.narrative.length - NARRATIVE_MAX);
          }
          n++;
        }
        if (n) { await trimMemory(s); saveStudents(students); console.info('[npc] ' + s.name + ' 反思：' + clampText(list[0], 40)); }
      } catch (e) {
        console.warn('[npc] 反思失败 ' + s.id + '：' + ((e && e.message) || e));
      } finally {
        s._reflecting = false; reflectBusy = false;
      }
    })();
    return true;
  }

  // ---------- 日计划（daily plan）：一天的主线 ----------
  // 每"游戏日"给每个学生生成一次"今天大概想干什么"，注入到之后每次 plan 的 prompt 里 ⇒
  // 零散的两分钟决定有了主线（斯坦福的分层规划：日计划 → 具体活动）。
  let daySeq = 0;
  let lastHourSeen = null;
  function tickDay() {
    const h = hourNow();
    if (lastHourSeen === null) { lastHourSeen = h; return; }
    // 世界时刻是 0~1 循环的：小时数从深夜往前跳到清晨/更早 = 跨了一天
    if (lastHourSeen - h > 12) daySeq++;
    lastHourSeen = h;
  }
  let dayPlanBusy = false;
  function maybeDayPlan(s, now) {
    if (dayPlanBusy || s._dayPlanning) return false;
    if (s.dayPlan && Number(s.dayPlanSeq) === daySeq && now - Number(s.dayPlanAt || 0) < DAYPLAN_CD) return false;
    s._dayPlanning = true; dayPlanBusy = true;
    s.dayPlanAt = now; s.dayPlanSeq = daySeq;
    (async () => {
      try {
        const h = hourNow();
        const seg = scheduleType(h);
        const out = await askStudent({
          student: {
            name: s.name, cls: s.cls, persona: s.persona, sex: s.sex, place: placeOf(s), st: s.st,
            needs: s.needs, mood: s.mood, rel: topRel(s), player: playerWhere(s),
            boardLine: boardLine(), mates: students.filter((x) => x !== s).map((x) => x.name),
          },
          memory: pickMemory(s, null),
          kind: 'dayplan',
          hour: h,
          schedule: seg ? seg.label : '自由活动',
        });
        const txt = clampText(out && out.plan, LEN_PLAN_DAY);
        if (txt) { s.dayPlan = { text: txt, at: now }; saveStudents(students); console.info('[npc] ' + s.name + ' 今日打算：' + txt); }
      } catch (e) {
        console.warn('[npc] 日计划失败 ' + s.id + '：' + ((e && e.message) || e));
      } finally {
        s._dayPlanning = false; dayPlanBusy = false;
      }
    })();
    return true;
  }

  // ---------- 主循环 ----------
  let lastTick = Date.now();
  let lastBroadcast = 0;
  let lastHint = 0;      // 上一次打"没标功能区"提示的时间（累加型字段，必须有初值）
  let lastObstacle = Date.now(); // 上一次重载障碍表的时间
  let lastChatStart = 0;         // 上一次"新开闲聊"的时刻（累加型字段，必须有初值）
  let lastMeetStart = 0;         // 上一次"撮合一对相向走近"的时刻（累加型字段，必须有初值）
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
      perceive(s, now); // P2：看身边的人（廉价，限流）
      observeScene(s, now); // 场景识别：附近有谁/有什么地标 → 进记忆；要紧的会打断当前计划
      // 公告栏：路过就"看一眼"（限流）→ 记进记忆；**并且照做**（通知说了去哪就真去）
      if (!s.quest && now >= Number(s._boardAt || 0) &&
          Math.hypot(Number(s.x) - BOARD_POS.x, Number(s.z) - BOARD_POS.z) < BOARD_READ_RANGE) {
        s._boardAt = now + BOARD_READ_CD;
        const last = boardPosts.length ? boardPosts[boardPosts.length - 1] : '';
        s.mem.push({
          t: now,
          text: last ? ('我在公告栏看到：' + last) : '我去公告栏看了一眼，上面还没有新通知',
          kind: 'obs',
          src: last ? '公告栏' : '',
        });
        trimMemory(s);
        if (last) obeyNotice([s], last, now); // 看懂了就去做
      }
      // 反向委托：玩家走到跟前时主动开口请它帮忙买东西（限流 + 有委托在身就免开尊口）
      if (!s.quest && !s.want && !s._chatting && (s.st === 'idle' || s.st === 'act') &&
          now - Number(s._wantAt || 0) > WANT_CD) {
        s._wantAt = now; // 先占住冷却，避免误判/重入时连环开口
        wantAsk(s, now);
      }
      // 委托过期作废（没人理就算了，别一直挂在身上）
      if (s.want && now - Number(s.want.createdAt || 0) > WANT_EXPIRE) { s.want = null; s._wantAt = now; }
      // 去公告栏贴通知：走到板子前 → 让 AI 写一条贴出去；走不到（超时）就作罢，不静默挂着
      if (s.postPending) {
        if (now - Number(s._postAt || 0) > POST_TIMEOUT) { s.postPending = false; s._postAt = now; }
        else if (!s._posting && Math.hypot(Number(s.x) - BOARD_POS.x, Number(s.z) - BOARD_POS.z) < POST_NEAR) publishPost(s, now);
      }
      // 斯坦福那套的两层"想"：先有今日主线（日计划），再回头把经历想成认识（反思）。
      // 都只在人闲/做着事时进行，且全局每类同时只跑一个（不花走位时间、不刷爆额度）。
      if (!s.quest && (s.st === 'idle' || s.st === 'act')) {
        maybeDayPlan(s, now);
        maybeReflect(s, now);
      }
      if (s.quest) updateQuest(s, now); // P3：有委托任务就先办任务（驱动走位/问话/复命）
      // 「去找某人 / 去找玩家 / 跟着某人」：定期朝目标**当前位置**重指（两边都在动 → 会在中间碰头）。
      //   ⚠ keep=true（跟随）：**到了也不停**，保持 FOLLOW_KEEP 距离一直跟；玩家走远过头就放弃。
      //   keep=false（找人搭话）：到 CHAT_RANGE 内站住，交给闲聊系统（以前只在清意图后继续走 ⇒ 擦肩而过）。
      if (!s.quest && s.intent && s.intent.goalType === 'person' && (s.intent.seekId || s.intent.seekPlayer)) {
        let tp = null;
        if (s.intent.seekPlayer) { const p = nearestPlayer(s); if (p) tp = { x: Number(p.x), z: Number(p.z) }; }
        else { const t = students.find((x) => x.id === s.intent.seekId); if (t) tp = { x: Number(t.x), z: Number(t.z) }; }
        const tooLong = now - Number(s.intent.since || 0) > PERSON_SEEK_TIMEOUT_MS;
        const d = tp ? Math.hypot(tp.x - Number(s.x), tp.z - Number(s.z)) : Infinity;
        if (!tp || tooLong) {
          s.intent = null;
          s.decideAt = now; // 找不到人 / 追太久：立刻回日常规划，别在外面永远晃
        } else if (s.intent.keep) {
          // ---- 跟随：跟近到 FOLLOW_KEEP 就停下等；远了就继续追；玩家跑太远就放弃 ----
          if (d > FOLLOW_GIVEUP) {
            s.intent = null; s.decideAt = now;
            console.info('[npc] ' + s.name + ' 跟丢了，回日常');
          } else if (d <= FOLLOW_KEEP) {
            s.tx = Number(s.x); s.tz = Number(s.z); s.wx = s.tx; s.wz = s.tz; s.path = null; s.pathIdx = 0;
            s.st = 'act'; s.stayUntil = now + 1500; s.actStepAt = s.stayUntil; // 站住等玩家再走
          } else if (now - Number(s._seekAt || 0) > FOLLOW_REPATH_MS) {
            s._seekAt = now; setTarget(s, tp.x, tp.z);
            s.st = 'walk'; s.walkUntil = now + WALK_TIMEOUT * 1000; s.stuck = 0;
          }
        } else if (d < CHAT_RANGE) {
          s.intent = null;
          s.tx = Number(s.x); s.tz = Number(s.z); s.wx = s.tx; s.wz = s.tz; s.path = null; s.pathIdx = 0;
          s.st = 'act';
          s.stayUntil = Math.max(Number(s.stayUntil || 0), now + (CHAT_INTERVAL + 15) * 1000);
          s.actStepAt = Number(s.stayUntil); // 等对方开口的这段时间别乱挪步
        } else if (now - Number(s._seekAt || 0) > 2500) {
          s._seekAt = now; setTarget(s, tp.x, tp.z);
          s.st = 'walk'; s.walkUntil = now + WALK_TIMEOUT * 1000; s.stuck = 0;
        }
      }
      // 「四处问人」：朝目标同学走，走到跟前就开口打听（一次 LLM 调出"问句 + 对方回答"）
      if (!s.quest && s.intent && s.intent.goalType === 'inquire' && s.intent.seekId && !s._inquiring) {
        const t = students.find((x) => x.id === s.intent.seekId);
        const tooLong = now - Number(s.intent.since || 0) > INQUIRE_TIMEOUT;
        const d = t ? Math.hypot(Number(t.x) - Number(s.x), Number(t.z) - Number(s.z)) : Infinity;
        if (!t || tooLong) { s.intent = null; s.decideAt = now; } // 找不到人 / 走太久：作罢，回日常
        else if (d < INQUIRE_NEAR) { s.intent = null; inquireWith(s, t, now); }
        else if (now - Number(s._seekAt || 0) > 2500) {
          s._seekAt = now; setTarget(s, Number(t.x), Number(t.z));
          s.st = 'walk'; s.walkUntil = now + WALK_TIMEOUT * 1000; s.stuck = 0;
        }
      }
      if (s.st === 'act') {
        if (now >= Number(s.stayUntil || 0)) {
          if (Number(s.actResume || 0) > now) s.stayUntil = s.actResume; // 挪步中（保险）
          else {
            // 事做完了 → 立刻 idle，让**规则大脑**下一拍就接手（LLM 规划仍按 PLAN_INTERVAL_MS 来）
            s.st = 'idle';
            s.decideAt = Math.min(Number(s.decideAt || 0) || now, now);
          }
        } else if (!s.quest && Number(s.actResume || 0) === 0 && now >= Number(s.actStepAt || 0)) {
          // 停着"做活动"：隔一会儿在附近挪两步 —— 别一动不动（治"我要学习然后就不动了"的无实物表演）
          const p = nearbyPoint(s, ACT_STEP_DIST_MIN, ACT_STEP_DIST_MAX);
          if (p) { s.actResume = Number(s.stayUntil || 0); setTarget(s, p.x, p.z); s.st = 'walk'; s.walkUntil = now + 5000; s.stuck = 0; }
          else s.actStepAt = now + 8000;
        }
      } else if (s.st === 'walk') {
        const bx = Number(s.x);
        const bz = Number(s.z);
        const arrived = stepMove(s, dt);
        if (arrived) {
          if (Number(s.actResume || 0) > now) {
            // 挪步结束：回到"做活动"，恢复原来的停留截止
            s.st = 'act'; s.stayUntil = s.actResume; s.actResume = 0; s.actStepAt = now + rand(ACT_STEP_MIN, ACT_STEP_MAX);
          } else {
            s.st = 'act';
            // 按 plan 的时长停留（决策一次、干一会活），但**封顶 ACT_STAY_MAX**：
            // ⚠ 以前是 max(now+时长, planAt)，而 planAt 最远 2 分钟 ⇒ 一到地方就站 2 分钟不动（"老发呆"的真凶）。
            const stayMs = Number.isFinite(Number(s._stayMs)) ? Number(s._stayMs) : rand(STAY_MIN, STAY_MAX) * 1000;
            s.stayUntil = now + Math.min(stayMs, ACT_STAY_MAX * 1000);
            s._stayMs = undefined;
            // 活动一结束就立刻让**规则大脑**接手（事件驱动，不再干站着）；LLM 规划保持自己的节奏
            s.decideAt = s.stayUntil;
            s.stuck = 0;
            s.actStepAt = now + rand(ACT_STEP_MIN, ACT_STEP_MAX);
            // 「看看学校」到达：真"看了一眼"——把眼前的场景写成记忆 + 一条内心活动（场景识别落地到行为）
            if (s.intent && s.intent.goalType === 'explore') {
              const zn = zoneAt(Number(s.x), Number(s.z));
              markSeen(s, zn ? zn.id : '');
              const sc = sceneOf(s);
              const lm = sc.landmarks.length ? ('这边还有' + sc.landmarks.map((l) => l.name).join('、')) : '这边没什么特别的';
              s.mem.push({ t: now, text: '我特意到' + placeOf(s) + '转了一圈，' + lm, kind: 'obs', imp: 0.45 });
              s.think.push({ t: now, text: '我过来看看' + placeOf(s) + '这边是什么样。' });
              if (s.think.length > MEM_MAX) s.think.splice(0, s.think.length - MEM_MAX);
              trimMemory(s);
              s.noticed = '我刚到' + placeOf(s) + '，' + lm;
            }
            // 斯坦福：**到达是"感知"的一部分，不再单独调一次 LLM** —— 写进【你刚刚注意到】，
            // 由下一次 act 一起想（这正是"arrive 从独立调用降级为 act 的输入"，也省一次调用）。
            {
              const scA = sceneOf(s);
              s.noticed = '我刚走到' + placeOf(s)
                + (scA.landmarks.length ? ('，旁边是' + scA.landmarks.slice(0, 2).map((l) => l.name).join('、')) : '') + '。';
            }
          }
        } else {
          // ⚠ 没有这两条兜底，目标不可达（点在墙里 / 五个方向全被挡）会**永久卡在 walk**：
          //   永远不会到达、decideAt 也永远不刷新 ⇒ 人再也不动，而且零报错。
          const moved = Math.hypot(Number(s.x) - bx, Number(s.z) - bz);
          s.stuck = moved > 0.02 ? 0 : Number(s.stuck || 0) + 1;
          if (s.stuck >= STUCK_TICKS || now >= Number(s.walkUntil || 0)) {
            // 先重算路径（局部最小 / 障碍刚变）；试过还是卡才放弃，且**绝不重置 planAt**
            // ⚠ 曾经这里设 planAt = now + 8000：一卡就每 8s 重调一次 GLM，8 个 NPC 频繁卡会把
            //   调用量刷到设计值（4 次/分）的十几倍 ⇒ 服务端/额度开销飙升。规则大脑兜底足够，且不花 LLM。
            if (Number(s.actResume || 0) > now) {
              s.st = 'act'; s.stayUntil = s.actResume; s.actResume = 0; s.actStepAt = now + rand(ACT_STEP_MIN, ACT_STEP_MAX); s.stuck = 0;
            } else if (s.quest) {
              // 有委托在身：**绝不放弃**（目标会动：玩家在走 / 同学在走）。
              //   把 repathAt 清零 → 下一拍 updateQuest 立刻按任务目标重新指路，不会"走一半就杵住"。
              s.st = 'walk'; s.stuck = 0; s.walkUntil = now + WALK_TIMEOUT * 1000; s.quest.repathAt = 0;
            } else if (Number(s.pathTries || 0) < 2 && nav) {
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
      } else if (!s.quest && now >= Number(s.planAt || 0) && !s._planning) {
        planNext(s, now); // System2：低频 LLM 规划（失败自动回退规则大脑）
      } else if (!s.quest && now >= Number(s.decideAt || 0)) {
        // 仅在首次 LLM 规划之前用规则大脑 / 漫步保活，避免开局集体杵着不动
        if (hasZones) decide(s, now); else wander(s, now);
      }
    }
    tickDay(); // 跨天检测（日计划的序号靠它推进）
    pumpAnnounce(now); // 广播器：轮流让一个学生"听到"（一个个来，不并发打爆 GLM）
    // NPC↔NPC 社交：① 已经凑得近 → 直接开聊；② 离得远 → 撮合一对**相向走近**（纯走位、不花 LLM），
    //   走到一起了下一拍就走 ① 开聊。以前只认"已经凑到 5m 内"，而他们各忙各的很少凑近 ⇒ 几乎从不说话。
    // ⚠ 改**事件驱动**（用户明确要求）：靠得近就按概率开口，而不是"等 CHAT_INTERVAL 时间到"。
    if (!chatBusy) {
      // ①"已经凑得近"：允许正在走位的人也停下来聊（人味）
      const near = pickPair(now, CHAT_RANGE, true);
      if (near) {
        if (now - lastChatStart > CHAT_GAP_MS && chatRoll(near[0], near[1], now, dt)) {
          lastChatStart = now;
          converse(near[0], near[1]);
        }
      } else if (now - lastMeetStart > MEET_INTERVAL * 1000) {
        // ②离得远：撮合一对相向走近（纯走位、不花 LLM），走近了自然走 ①
        const far = pickPair(now, CHAT_SEEK_RANGE, false);
        if (far) { lastMeetStart = now; startMeet(far[0], far[1], now); }
      }
    }
    // ⚠ 无论有没有区域都要广播：以前没区域时直接 return，客户端连一次更新都收不到（表现为"人都定住了"）
    if (now - lastBroadcast >= BROADCAST_MS) {
      lastBroadcast = now;
      // ⚠ 客户端自己驱动走位：下发 wx/wz（**当前路点**，A* 给的绕行点）让客户端照它走；tx/tz 仍是
      //   **最终目标**（到达判定/probes 观测用）。x/z/rot 是服务端 ghost（供 probe 观测，客户端忽略）。
      //   老客户端不认 wx/wz 就退回用 tx/tz（= 直走，行为不回归）。
      // want：它正请你代买的商品名（客户端据此在搭话按钮旁显示「交给 TA」）——空字符串表示没有
      broadcast({ t: 'npc', list: students.map((s) => ({ id: s.id, x: round2(s.x), z: round2(s.z), tx: round2(s.tx), tz: round2(s.tz), wx: round2(s.wx), wz: round2(s.wz), rot: round1(s.rot), st: s.st, goal: s.intent ? (s.intent.goalType || '') : '', want: s.want ? s.want.itemName : '' })) });
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
    // whoId：说话人的稳定标识（如 'p:<玩家id>'）→ 关系按人记、对话历史也按人分，换个玩家是另一段交情
    const who = whoId ? String(whoId).slice(0, 40) : '';
    const out = await triggerAI(s, 'talk', { text: String(text || '').slice(0, 200), name: playerName || '同学', who });
    // ⚠ 无论成功与否，都把这轮**玩家说的话**记进对话历史 —— 下一句它才接得上（"我刚才说的那事…"）
    pushChat(s, who, 'p', text);
    if (!out) return { say: '', think: '' };
    if (out.say) pushChat(s, who, 'n', out.say);
    saveStudents(students);
    broadcast({ t: 'npc_say', id: s.id, say: out.say }, except);
    return out;
  }
  // 调试/探针用：读某个学生的内在状态（心情/关系/意图）
  function stateOf(id) {
    const s = students.find((x) => x.id === String(id));
    if (!s) return null;
    return { mood: { ...s.mood }, rel: { ...(s.rel || {}) }, intent: s.intent ? { ...s.intent } : null, quest: s.quest ? { ...s.quest } : null, want: s.want ? { ...s.want } : null, dayPlan: s.dayPlan || null, postPending: !!s.postPending, postIdea: s.postIdea || '', mem: (s.mem || []).slice(-3), memLen: (s.mem || []).length, think: (s.think || []).slice(-3), heard: s.heard ? { ...s.heard } : null, noticed: String(s.noticed || ''), seenZones: (s.seenZones || []).slice(), narrative: (s.narrative || []).slice(), values: String(s.values || ''), st: s.st, x: s.x, y: s.y, z: s.z, tx: s.tx, tz: s.tz, path: Array.isArray(s.path) ? s.path.length : 0, stayUntil: Number(s.stayUntil || 0), decideAt: Number(s.decideAt || 0), planAt: Number(s.planAt || 0) };
  }
  // ---------- 公告栏 + 广播器 ----------
  let boardPosts = []; // 最近几条公告文本（AI 决策时会"看到"）
  function setBoard(list) {
    const next = Array.isArray(list) ? list.map((x) => String(x).slice(0, 120)).filter(Boolean).slice(-6) : [];
    const prevLast = boardPosts.length ? boardPosts[boardPosts.length - 1] : '';
    const nextLast = next.length ? next[next.length - 1] : '';
    boardPosts = next;
    // 新贴的公告 → 让通知**传开**（轮流一个个知道 → 各自照做）。
    // 走的是广播队列而不是立刻"全班一窝蜂"，既不刷爆 GLM，也不会把已经排好的计划整块冲掉。
    if (nextLast && nextLast !== prevLast) announceQueue.push({ text: '公告栏新贴了通知：' + nextLast, from: '公告栏' });
  }
  // 通知"照做"：文本里提到去哪，就把这几个闲着的人真的派过去（最多 OBEY_MAX 个）。
  // ⚠ 只把通知塞进 prompt 是"知道"，派过去才算"听"（用户实测："AI 不听公告的"）。
  function obeyNotice(cands, text, now) {
    const zt = noticeZoneType(text);
    if (!zt) return 0;
    const zone = pickOne(zonesOfType(zt));
    if (!zone) return 0;
    const label = (ZONE_TYPES.find((x) => x.id === zt) || {}).label || zt;
    let n = 0;
    for (const s of cands) {
      if (n >= OBEY_MAX) break;
      if (!s || s.quest || s._chatting) continue;
      if (now - Number(s._obeyAt || 0) < OBEY_CD) continue; // 同一个学生别被通知连着牵着走
      s._obeyAt = now;
      goZone(s, now, zone); // 真的走过去（走位/绕障/碰撞还是本地那套）
      s.intent = { goalType: zt, goalText: '照通知去' + label, activity: '去看看通知说的事', plan: '', since: now, notice: true };
      s.mem.push({ t: now, text: '学校通知「' + String(text).slice(0, 40) + '」，我这就去' + label, kind: 'notice' });
      trimMemory(s);
      n++;
    }
    return n;
  }
  let announceQueue = []; // 待下发的广播
  let announceIdx = 0;    // 轮流游标：下一个该"听到"广播的学生
  let announceAt = 0;     // 下次下发的时刻（时间字段，必须有初值）
  function announce(text, from) {
    const t = String(text || '').trim().slice(0, 120);
    if (t) announceQueue.push({ text: t, from: String(from || '广播').slice(0, 16) });
  }
  // 主循环每拍调：每隔 ANNOUNCE_GAP_MS 让**一个**学生"听到"广播（轮流，不并发）
  function pumpAnnounce(now) {
    if (!announceQueue.length || !students.length || now < announceAt) return;
    announceAt = now + ANNOUNCE_GAP_MS;
    const s = students[announceIdx % students.length];
    announceIdx++;
    const a = announceQueue[0];
    s.mem.push({ t: now, text: '全校广播：「' + a.text + '」', kind: 'announce', src: String(a.from || '学校') });
    // ⚠ 记住"最近听到的通知"：prompt 里的【最近的全校广播/公告】用它 —— 它得**照通知调整计划**，不能听过就忘
    s.heard = { text: String(a.text).slice(0, 120), from: String(a.from || '学校').slice(0, 16), t: now };
    trimMemory(s);
    obeyNotice([s], a.text, now); // 听到了就**照做**（通知说了去哪就真去）
    // ⚠ 听到通知要有**心理活动**：调一次 AI 产出 think（"无论发生什么调用 AI 的事都要产生心理活动"）。
    //   不 await（别拖慢广播轮询）；失败时 triggerAI 自己会 console.warn，这里只兜住 Promise。
    triggerAI(s, 'notice', { text: a.text, name: a.from })
      .catch((e) => console.warn('[npc] 广播心理活动失败 ' + s.id + '：' + ((e && e.message) || e)));
    if (announceIdx % students.length === 0) announceQueue.shift(); // 一轮走完才轮到下一条
  }

  // 「校卡」：给玩家看的角色资料（性格 + 心情 + 当前目标 + 关系 + 近期记忆）
  function card(id) {
    const s = students.find((x) => x.id === String(id));
    if (!s) return null;
    return {
      id: s.id, name: s.name, cls: s.cls, sex: s.sex, persona: s.persona,
      place: placeOf(s),
      mood: { ...s.mood },
      goal: s.intent ? { type: s.intent.goalType, text: s.intent.goalText || '', activity: s.intent.activity || '' } : null,
      quest: s.quest ? { stage: s.quest.stage, targetName: s.quest.targetName, question: s.quest.question } : null,
      // 关系：把人名解析出来给玩家看（玩家键 → 玩家；s2 → 该学生姓名）
      rel: Object.entries(s.rel || {}).map(([k, v]) => ({
        who: isPlayerKey(k) ? '玩家' : ((students.find((x) => x.id === k) || {}).name || k),
        trust: Math.round((Number(v && v.trust) || 0) * 100) / 100,
      })).filter((x) => Math.abs(x.trust) > 0.05).sort((a, b) => Math.abs(b.trust) - Math.abs(a.trust)).slice(0, 5),
      needs: { ...s.needs },
      mem: (s.mem || []).slice(-8).map((m) => ({ t: m.t, text: m.text, kind: m.kind || '' })),
    };
  }
  // 调试/探针用：直接派一个任务（跳过 LLM 解析）
  function debugStartQuest(sId, targetIdOrName, question, fromId) {
    const s = students.find((x) => x.id === String(sId));
    if (!s) return null;
    const t = students.find((x) => x.id === String(targetIdOrName)) || resolveStudentByName(targetIdOrName);
    if (!t) return null;
    startQuest(s, t.name, question, fromId || '', '玩家');
    return { targetId: t.id, targetName: t.name };
  }
  // ---------- 走到公告栏 → 让 AI 写一条通知贴出去 ----------
  let postBusy = false;      // 全局同一时刻只写一条（控并发/额度）
  let lastNpcPost = 0;       // 上一次 NPC 贴公告的时刻（全局节流；累加型字段，必须有初值）
  async function publishPost(s, now) {
    if (postBusy || s._posting) return false;
    s._posting = true; postBusy = true;
    s.postPending = false;
    s._postAt = now;
    try {
      const out = await askStudent({
        student: {
          name: s.name, cls: s.cls, persona: s.persona, sex: s.sex, place: placeOf(s), st: s.st,
          needs: s.needs, mood: s.mood, rel: topRel(s), player: playerWhere(s), boardLine: boardLine(),
          mates: students.filter((x) => x !== s).map((x) => x.name),
        },
        memory: pickMemory(s, null),
        kind: 'post',
        hour: hourNow(),
        idea: String(s.postIdea || ''), // 它在规划时想说的那件事
      });
      const txt = clampText(out && out.text, 40);
      if (txt && onPost) {
        onPost(txt, s.name); // → index.js pushBoard：落盘 + 广播所有客户端 + 喂回本世界（其他学生会看到并照做）
        lastNpcPost = now;
        s.mem.push({ t: now, text: '我在公告栏贴了通知：「' + txt + '」', kind: 'post', imp: 0.85 });
        // ⚠ 贴通知也是一次 AI 调用 → 要有心理活动（进 think 流，之后 prompt 会带上）
        const pth = clampText(out && out.think, LEN_THINK);
        if (pth) {
          s.think.push({ t: now, text: pth });
          if (s.think.length > MEM_MAX) s.think.splice(0, s.think.length - MEM_MAX);
        }
        trimMemory(s);
        applyMoodWord(s, '开心');
        broadcast({ t: 'npc_say', id: s.id, say: '贴好啦，大家看公告栏。' });
        console.info('[npc] ' + s.name + ' 在公告栏贴了通知：' + txt);
        return true;
      }
      return false;
    } catch (e) {
      console.warn('[npc] 贴公告失败 ' + s.id + '：' + ((e && e.message) || e));
      return false;
    } finally {
      s._posting = false; postBusy = false;
    }
  }
  // 调试/探针用：强制去贴一张（跳过 plan 的"AI 想不想贴"）
  function debugPost(id, idea) {
    const s = students.find((x) => x.id === String(id));
    if (!s) return false;
    s.postIdea = clampText(idea || '操场集合', 40);
    s.postPending = true;
    s._postAt = Date.now();
    // 直接摆到公告栏跟前，便于探针立刻验证"到了就贴"
    s.x = BOARD_POS.x + 1; s.z = BOARD_POS.z;
    s.tx = s.x; s.tz = s.z; s.wx = s.x; s.wz = s.z; s.path = null; s.pathIdx = 0;
    s.st = 'act'; s.stayUntil = Date.now() + 5000;
    return true;
  }

  // 调试/探针用：强制想一次（清掉限流）
  function debugReflect(id) {
    const s = students.find((x) => x.id === String(id));
    if (!s) return false;
    s.reflectAt = 0; s._memAtReflect = 0;
    return maybeReflect(s, Date.now());
  }
  function debugDayPlan(id) {
    const s = students.find((x) => x.id === String(id));
    if (!s) return false;
    s.dayPlan = null;
    return maybeDayPlan(s, Date.now());
  }
  // 调试/探针用：看"这次会挑哪几条记忆喂给模型"（检索公式的可见化）
  function debugPickMemory(id, text) {
    const s = students.find((x) => x.id === String(id));
    if (!s) return null;
    return pickMemory(s, { text: String(text || '') }).map((m) => ({ text: String((m && m.text) || ''), kind: (m && m.kind) || '', imp: memImportance(m) }));
  }
  // 调试/探针用：强制立刻规划一次
  function debugPlan(id) {
    const s = students.find((x) => x.id === String(id));
    if (!s) return false;
    s._planning = false; s.planAt = 0;
    planNext(s, Date.now());
    return true;
  }
  // 调试/探针用：结构化自我档案（固定分层，放 prompt 最前 —— 身份稳 / 状态准）
  function debugSelf(id) {
    const s = students.find((x) => x.id === String(id));
    if (!s) return null;
    return { self: selfProfile(s), values: ensureValues(s), narrative: (s.narrative || []).slice() };
  }
  // 调试/探针用：场景识别（附近地标/人 + 学校有哪些地方）的可见化
  function debugScene(id) {
    const s = students.find((x) => x.id === String(id));
    if (!s) return null;
    return { ...sceneOf(s), line: sceneLine(s), places: placesLine(s) };
  }
  // 调试/探针用：强制"去看看学校"（清冷却）
  function debugExplore(id) {
    const s = students.find((x) => x.id === String(id));
    if (!s) return false;
    s._exploreAt = 0;
    startExplore(s, Date.now());
    return true;
  }
  // 调试/探针用：强制"四处问人"（可选指定目标，便于确定性断言）
  function debugInquire(id, targetId) {
    const s = students.find((x) => x.id === String(id));
    if (!s) return false;
    s._inquireAt = 0;
    if (targetId) {
      const t = students.find((x) => x.id === String(targetId));
      if (!t || t === s) return false;
      s.intent = { goalType: 'inquire', goalText: '去问问' + t.name, activity: '', plan: '', seekId: t.id, since: Date.now() };
      setTarget(s, Number(t.x), Number(t.z));
      s.st = 'walk'; s.walkUntil = Date.now() + WALK_TIMEOUT * 1000; s.stuck = 0;
      s.decideAt = Date.now() + INQUIRE_TIMEOUT;
      return true;
    }
    startInquire(s, Date.now());
    return true;
  }
  // 调试/探针用：强制"观察一次"（清限流）
  function debugObserve(id) {
    const s = students.find((x) => x.id === String(id));
    if (!s) return false;
    s._obsAt = 0; s._obsSeen = '';
    observeScene(s, Date.now());
    s._obsSeen = ''; // 允许探针反复观察同一现场
    return true;
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
      want: s.want ? s.want.itemName : '',
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

  return { roster, talk, setZones, getZones, dispose, triggerAI, stateOf, card, setBoard, announce, forceChat, debugStartQuest, refreshObstacles: reloadObstacles, setPlayerPositions, applyClientState, setShopCatalog, deliver, debugReflect, debugDayPlan, debugPickMemory, debugPlan, debugPost, debugScene, debugExplore, debugInquire, debugObserve, boardPosts: () => boardPosts.slice(), memImportance, debugSelf, inferZone: inferZoneFromText, normalizeAct, zoneAiName, resolvePlaceType, loadPolicyStatus: () => ({ ready: policyReady, meta: policy.meta || {}, reason: policy.reason }), feedStats: () => ({ sft: feedSftRows, pref: feedPrefRows, dir: FEED_DIR }), ZONE_TYPES };
}
