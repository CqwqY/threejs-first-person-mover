// 守卫探针：学生 NPC（服务端权威）+ 功能区标注 + 阿花下架。
// 项目惯例：静态断言只能证明「实现没写错」，证明不了「它是瓶颈」——这里守的是契约与静默失效。
// ⚠ 断言里写多行字面量必须先 CRLF→LF 归一化（Windows 检出是 CRLF，否则必然失败）。
import fs from 'node:fs';

const R = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const SRC = {
  world: R('server-remote/npcworld.js'),
  ai: R('server-remote/ai-student.js'),
  index: R('server-remote/index.js'),
  students: R('src/world/Students.js'),
  game: R('src/core/Game.js'),
  net: R('src/net/Network.js'),
  chat: R('src/ui/NpcChat.js'),
  editor: R('src/editor/EditorApp.js'),
  html: R('editor.html'),
  shop: R('src/player/Shop.js'),
};

let fails = 0;
function ok(cond, name) {
  if (cond) console.log('  ok   ' + name);
  else { console.log('  FAIL ' + name); fails++; }
}

// 花括号配对抽函数体：避免 src.slice(indexOf(...)) 扫到文件末尾把后面函数也断言进去
function blockAt(src, head) {
  const i = src.indexOf(head);
  if (i < 0) return '';
  const b = src.indexOf('{', i);
  let d = 0;
  for (let p = b; p < src.length; p++) {
    if (src[p] === '{') d++;
    else if (src[p] === '}') { d--; if (d === 0) return src.slice(b, p + 1); }
  }
  return '';
}

console.log('[1] 阿花已整体下架');
ok(!/阿花/.test(SRC.game), 'Game.js 里再没有「阿花」');
ok(!/createAiNpc|AiNpc/.test(SRC.game), '不再引用 AiNpc');
ok(!fs.existsSync('src/world/AiNpc.js'), 'src/world/AiNpc.js 已删除');
ok(!/handleAIRoute|from '\.\/ai\.js'/.test(SRC.index), '服务端不再挂 /api/ai（商人 AI 已下架）');
ok(!/api\/ai/.test(SRC.game), '前端不再请求 /api/ai');
ok(/createStudents/.test(SRC.game), '改为 createStudents');

console.log('[2] 学生档案与记忆（长度与条数硬约束）');
ok(/const SEEDS = \[/.test(SRC.world) && (SRC.world.match(/name: '/g) || []).length >= 8, '至少 8 名学生种子档案');
ok(/const MEM_MAX = 20/.test(SRC.world), '记忆条数上限');
ok(/const LEN_SAY = 60/.test(SRC.world), 'say 长度上限');
ok(/const LEN_THINK = 120/.test(SRC.world), 'think 长度上限（内部独白，写宽一点才有内容）');
ok(/const LEN_MEM = 120/.test(SRC.world), 'mem 长度上限');
ok(/function clampText/.test(SRC.world) && /clampText\(out\.say/.test(SRC.world), '入库前一律截断（超了直接砍）');
const trim = blockAt(SRC.world, 'async function trimMemory');
ok(/askStudent\(/.test(trim), '记忆超限先让 AI 压缩');
ok(/while \(s\.mem\.length > MEM_MAX\) s\.mem\.shift\(\)/.test(trim), '压缩失败/仍超就直接丢最老的（粗暴兜底，不会无限膨胀）');

console.log('[3] 行为：需求驱动的效用调度 + 课程表（不是随机游走）');
ok(/const SCHEDULE = \[/.test(SRC.world), '有课程表（按时段决定去哪）');
ok(/function needType/.test(SRC.world) && /function decide/.test(SRC.world), '需求 → 目标区的选择逻辑');
ok(/Math\.random\(\) < 0\.7/.test(SRC.world), '课程表优先级 70%，其余按需求（有随机但不乱走）');
ok(/function updateNeeds/.test(SRC.world), '需求随时间推进、在对应区域回落');
ok(/function blocked/.test(SRC.world) && /function stepMove/.test(SRC.world), '行走带建筑绕障（不是直线穿墙）');
ok(/function wander/.test(SRC.world) && /if \(hasZones\) decide\(s, now\); else wander\(s, now\)/.test(SRC.world),
  '没标注功能区时自由漫步（不再原地杵着，也不再连广播都不发）');

console.log('[4] 服务端权威 + 广播协议');
ok(/const BROADCAST_MS = 200/.test(SRC.world), '5Hz 广播位置');
ok(/t: 'npc_roster'/.test(SRC.index), '新连接下发名单');
ok(/msg\.t === 'npc_talk'/.test(SRC.index), '服务端收玩家搭话');
ok(/t: 'npc_reply'/.test(SRC.index), '回话只给发起者');
ok(/t: 'npc_say'/.test(SRC.world), '说话/心理活动广播给所有人');
ok(/sendStudentTalk/.test(SRC.net), '前端有发送接口');
ok(/Number\.isFinite\(nx\)/.test(blockAt(SRC.students, 'function applyList')), '客户端有 NaN 防线（坐标 NaN 会让人消失且打不到）');

console.log('[5] 角色数据库与 AI 触发时机');
ok(/STUDENTS_FILE/.test(SRC.world) && /function ensureStudents/.test(SRC.world), '角色档案落盘 students.json');
ok(/const AI_COOLDOWN = 45/.test(SRC.world), '同一学生 AI 冷却（防刷爆免费档）');
ok(/kind !== 'talk'/.test(SRC.world), '玩家搭话不受冷却限制');
ok(/triggerAI\(s, 'arrive'\)/.test(SRC.world), '到达目的地触发一次内心独白');
ok(/KIND_HINT/.test(SRC.ai) && /talk:|arrive:|event:|compress:/.test(SRC.ai), 'AI 区分 对话/到达/事件/压缩 四种任务');
ok(/getDayTime/.test(SRC.index), '课程表跟服务端世界时刻走');

console.log('[6] 前端渲染与交互');
ok(/instantiateRigged/.test(SRC.students), '用 SkeletonUtils 克隆（共享骨架会一起动甚至形变错乱）');
ok(/AnimationMixer/.test(SRC.students), '走/停动画混合');
ok(/TALK_RANGE/.test(SRC.students) && /function nearest/.test(SRC.students), '靠近才能搭话');
ok(/setTitle/.test(SRC.chat) && /addThink/.test(SRC.chat), '对话面板支持换对象 + 心理活动');
ok(/_talkToNearest/.test(SRC.game) && /Config\.NPC_KEY/.test(SRC.game), 'F 键找最近的学生开聊');
ok(/_updateTalkTab/.test(SRC.game), '选项卡显示当前能搭话的人名');
ok(/_sayTimer/.test(SRC.game), 'AI 超时兜底（不会一直挂着「正在想…」）');

console.log('[7] 编辑器「功能区」页签');
ok(/id="tZones"/.test(SRC.html) && /id="zonesPanel"/.test(SRC.html), 'HTML 有区域模式按钮与面板');
ok(/zones: StepUI\.btnZones/.test(SRC.editor), '模式映射已注册');
ok(/'window', 'zones'/.test(SRC.editor), '模式列表包含 zones');
ok(/api\/zones/.test(SRC.editor), '编辑器读写 /api/zones');
ok(/function drawZoneViz/.test(SRC.editor) && /zoneVizGroup\.visible = isZones/.test(SRC.editor), '地面可视化且仅在区域模式显示');
ok(/zonesFromSel/.test(SRC.editor), '支持「用选中建筑生成」');
ok(/pathname === '\/api\/zones'/.test(SRC.index), '服务端有 /api/zones');
ok(/SHOP_ADMIN_TOKEN/.test(blockAt(SRC.index, "url.pathname === '/api/zones'")), '写区域要管理员密钥');

console.log('[8] 商店补齐阿花的能力道具');
for (const id of ['boots_speed', 'boots_jump', 'pill_size', 'jetpack', 'medkit', 'feather']) {
  ok(SRC.shop.includes("id: '" + id + "'"), '商店有 ' + id);
}
ok(/case 'gravity'/.test(SRC.game) && /case 'heal'/.test(SRC.game), '重力/治疗效果已受支持（否则买了没反应 = 静默失效）');

console.log('[9] 走路/朝向/地点的契约（这几条错了都是"零报错但看着不对"）');
{
  const obstacleBlock = blockAt(SRC.world, 'function reloadObstacles()');
  ok(/scene\.placed/.test(obstacleBlock) && /scene\.scenery/.test(obstacleBlock),
    '障碍表读 placed/scenery（不是根本不存在的 scene.items / it.rec）');
  ok(/rec\.fw/.test(obstacleBlock) && /rec\.fd/.test(obstacleBlock), '优先用真实占地 fw/fd');
  ok(!/scene\.items/.test(obstacleBlock), '不再遍历根本不存在的 scene.items（老 bug：障碍表恒空→穿墙）');
  ok(/it && it\.rec \? it\.rec : it/.test(obstacleBlock), 'buildings.json 的 .rec 包装仍正确处理（与 editor-scene 结构不同）');
  ok(/SCENE_MAX_SIDE/.test(obstacleBlock), '超大项（地形/道路）被排除，不会把整片地面堵死');
  const step = blockAt(SRC.world, 'function stepMove(');
  ok(/atan2\(-nx, -nz\)/.test(step),
    'rot 用 atan2(-dx,-dz)，与玩家 yaw 约定一致（少负号 = 背朝前走）');
  ok(/blockedBy/.test(step) && /s\.x\) - hit\.x/.test(step),
    '压在楼里时朝"背离障碍中心"脱困（朝目标走 = 被允许横穿整栋楼）');
  ok(/WALK_TIMEOUT/.test(SRC.world) && /STUCK_TICKS/.test(SRC.world),
    'walk 有超时 + 卡住计数（否则目标不可达会永久卡死、人再也不动）');
  ok(/function zoneAt/.test(SRC.world) && /placeOf\(s\)/.test(SRC.world),
    '"我在哪"按当前坐标判定（不是按打算去哪 ⇒ 不会再在教室说自己在图书馆）');
  ok(!/zones\.slice\(0, 1\)/.test(SRC.world),
    '区域匹配不到时不再 fallback 成第一个区域（那是"认错地方"的根源）');
}

console.log('[10] 心理活动不外泄 + 对话不重复');
ok(/t: 'npc_say', id: s\.id, say: out\.say \}/.test(SRC.world), '广播的 npc_say 只有 say、不带 think');
ok(!/think: out\.think/.test(SRC.world), 'talk 不再把 think 广播出去');
ok(/, ws\)/.test(SRC.index) || /talk\(sid, text, String\(nick\)\.slice\(0, 16\), ws\)/.test(SRC.index),
  '搭话时把发起者传进去，广播跳过他（否则同一句话出现两遍）');
ok(/if \(c === except\) continue/.test(SRC.index), 'broadcastAll 支持排除一个连接');
ok(!/addThink/.test(SRC.game), '对话栏不再显示心理活动');
ok(/_awaitReplyId/.test(SRC.game), '客户端还有一层去重（等回复期间跳过广播那一份）');
ok(/fw: \(footprintOf\(rec\.obj\)/.test(SRC.editor), '编辑器存档写入真实占地 fw/fd（服务端才有得算）');

console.log('[11] 学生模型：带骨骼 + 朝向修正');
ok(/boy-rig\.glb/.test(SRC.students) && /girl-rig\.glb/.test(SRC.students),
  '用带骨骼的 -rig 模型（原版没有动画，会变成"平移的立牌"）');
ok(/const MODEL_DEG = 90/.test(SRC.students), '模型朝向修正 90°（与 PlayerModel 的 modelDeg 一致）');
ok(/face\.rotation\.y/.test(SRC.students), '朝向修正挂在独立一层，不污染外层位移');

console.log(fails ? '\n' + fails + ' 条失败' : '\n全部通过');
process.exit(fails ? 1 : 0);
