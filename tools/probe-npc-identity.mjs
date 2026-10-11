// 守卫探针：AI prompt 里的「身份 / 记忆归属 / 关系命名」。
// 守的是这几个真出过的问题：
//   ① prompt 只写"这是你的名字，别人叫你时才用" ⇒ 模型把自己和别的同学搞混
//      （别人问"你和玩家在聊什么"，它认不出那个名字说的就是自己）；
//   ② 关系摘要直接喂 's3' 这种**内部 id**，模型不知道那是谁，更容易张冠李戴；
//   ③ 双人闲聊要把"谁是 a / 谁是 b"钉死，否则台词和记忆会写反。
// 做法：桩掉 global.fetch，直接抓 askStudent 真正发出去的 messages（不起网络）。
import { askStudent } from '../server-remote/ai-student.js';

let fails = 0;
function ok(cond, name, extra) {
  if (cond) console.log('  ok   ' + name);
  else { console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); fails++; }
}

const captured = [];
globalThis.fetch = async (url, opts) => {
  captured.push(JSON.parse(opts.body));
  return { ok: true, json: async () => ({ choices: [{ message: { content: '{"goalType":"rest","say":"嗯"}' } }] }) };
};
const userTextOf = (i) => String((captured[i].messages[1] && captured[i].messages[1].content) || '');
const systemTextOf = (i) => String((captured[i].messages[0] && captured[i].messages[0].content) || '');

const base = {
  name: '顾星桥', cls: '高二(3)班', sex: 'm', persona: '话痨，什么都懂一点，喜欢给同学起外号',
  place: '操场', st: 'idle', mood: { valence: 0.6, energy: 0.6, focus: 0.5 },
  needs: { hunger: 0.3, fatigue: 0.2, fun: 0.4, study: 0.5, social: 0.3, bladder: 0.2 },
};

console.log('[1] plan：身份钉死 + 关系给人名');
{
  await askStudent({
    student: { ...base, rel: [{ name: '陈亦然', trust: 0.5 }, { name: '玩家', trust: 0.4 }] },
    memory: [{ text: '我和陈亦然聊过天' }],
    kind: 'plan', hour: 10, schedule: '上课',
  });
  const p = userTextOf(0);
  ok(/【你本人】/.test(p), 'plan prompt 有【你本人】身份段', p.slice(0, 80));
  ok(p.includes('顾星桥'), 'plan prompt 带上自己的名字');
  ok(/说的就是\*\*你自己\*\*/.test(p), 'plan prompt 明确"提到这个名字 = 说的就是你"');
  ok(p.includes('陈亦然') && p.includes('玩家'), '关系摘要给人名', p);
  ok(!/：[-\d]/.test(p) && !/\bs\d\b/.test(p), '关系摘要里**没有** s3 这种内部 id', p.slice(p.indexOf('关系'), p.indexOf('关系') + 40));
}

console.log('[2] ask：被问的人知道"问的就是我"');
{
  await askStudent({
    student: { ...base }, memory: [], kind: 'ask',
    question: '顾星桥和玩家在聊什么？', askerName: '苏晓棠',
  });
  const p = userTextOf(1);
  ok(p.includes('你是「顾星桥」'), 'ask prompt 写明"你是顾星桥"', p);
  ok(p.includes('苏晓棠'), 'ask prompt 标出问话人（另一位同学）', p);
  ok(/说的就是\*\*你本人\*\*/.test(p), 'ask prompt 提示"提到你名字 = 你本人，照实回答"');
}

console.log('[3] chat：双方身份与 a/b 归属钉死');
{
  await askStudent({
    student: { ...base }, memory: [], kind: 'chat', bond: 0.2,
    partner: { name: '白露', cls: '高一(4)班', persona: '说话慢条斯理' },
  });
  const p = userTextOf(2);
  ok(p.includes('你是「顾星桥」') && p.includes('白露'), 'chat prompt 明确双方是谁', p.slice(0, 120));
  ok(/who="a"/.test(p) && /你（顾星桥）说的/.test(p), 'chat prompt 钉死 a=我 / b=对方');
  ok(/【对方】白露/.test(p), 'chat prompt 有【对方】人设段');
}

console.log('[4] 玩家话里出现"我自己的名字" → 必须给**确定性**提示（不指望模型自己反应过来）');
{
  await askStudent({
    student: { ...base }, memory: [], kind: 'talk', playerName: '小明',
    playerText: '顾星桥，你去找顾星桥问问他在干嘛',
  });
  const p = userTextOf(3);
  ok(/就是你本人/.test(p), 'talk prompt：命中的名字被说死"就是你本人"', p.slice(-200));
  ok(/绝对不要.*填 task|不要.*填 task/.test(p), 'talk prompt：明确"这种情况不要填 task"（别跑去找自己）', '');
  ok(/不要改道/.test(p), 'talk prompt：明确"不要改道去别的地方"（别触发寻路）', '');
}

console.log('[5] 同学问的问题里出现"我自己的名字" → 也要提示"问的就是你"');
{
  await askStudent({
    student: { ...base }, memory: [], kind: 'ask', askerName: '苏晓棠',
    question: '顾星桥刚才在和谁聊天？',
  });
  const p = userTextOf(4);
  ok(/就是你本人/.test(p), 'ask prompt：问到你名字时明确"就是你本人"', p.slice(-160));
}

console.log('[6] SYSTEM（talk）：开篇钉死"你是谁"+ 第一人称 + 公告与广播段');
{
  await askStudent({ student: { ...base }, memory: [], kind: 'talk', playerName: '小明', playerText: '你好' });
  const sys = systemTextOf(5);
  ok(/【你是谁】/.test(sys), 'SYSTEM 开篇有【你是谁】身份段', sys.slice(0, 60));
  ok(/不是旁观者|不是第三者/.test(sys), 'SYSTEM 明确"你不是旁观者/第三者"', '');
  ok(/第一人称/.test(sys), 'SYSTEM 要求"一律用第一人称我"（不许第三人称说自己）', '');
  ok(/【公告与广播】/.test(sys), 'SYSTEM 有【公告与广播】段（要照通知调整行动）', '');
  ok(/【刚才的对话】/.test(sys), 'SYSTEM 说明"刚才的对话"是多轮原文（要接着聊）', '');
  ok(/【最近心里在想】|你最近心里在想/.test(sys), 'SYSTEM 说明心里话是自己刚才的内心活动', '');
}

console.log('[7] talk 多轮：按顺序带上"刚才的对话" + 最近的心里话');
{
  await askStudent({
    student: { ...base }, memory: [], kind: 'talk', playerName: '小明',
    playerText: '你刚才说的是哪一科来着？',
    chat: [
      { who: 'p', text: '老师今天留了什么作业？', t: 1 },
      { who: 'n', text: '语文两页，数学还有一套卷子。', t: 2 },
    ],
    thinks: ['他又在追问作业的事。'],
  });
  const p = userTextOf(6);
  ok(/【刚才你和小明对话|【刚才你和.*的对话/.test(p), 'prompt 有【刚才你和玩家的对话】段', p.slice(-320));
  ok(/小明：老师今天留了什么作业？/.test(p), '历史里玩家的话带说话人标签', '');
  ok(/你：语文两页/.test(p), '历史里 AI 自己的话也带标签（分得清谁说）', '');
  const iQ = p.indexOf('老师今天留了什么作业？');
  const iA = p.indexOf('语文两页');
  ok(iQ >= 0 && iA > iQ, '历史是**按时间顺序**（旧→新），不是倒着堆', 'iQ=' + iQ + ' iA=' + iA);
  ok(/【你最近心里在想】/.test(p) && /他又在追问作业的事/.test(p), 'prompt 带上【你最近心里在想】（内心连续性）', '');
}

console.log('[8] notice：听到广播 → 有心理活动 + 明确"必须照通知决策"');
{
  await askStudent({
    student: { ...base, heard: '【广播】注意，操场集合，下午四点有篮球赛' },
    memory: [], kind: 'notice', playerName: '广播',
  });
  const p = userTextOf(7);
  const sys = systemTextOf(7);
  ok(p.indexOf('【最近的全校广播') >= 0, 'prompt 有【最近的全校广播/公告】段', p.slice(0, 200));
  ok(/操场集合/.test(p), '通知内容真的进了 prompt', '');
  ok(/正式通知/.test(p) && /照它调整/.test(p), 'prompt 明确"这是正式通知，要照它调整行动"', '');
  ok(/think/.test(sys) && /心理活动/.test(sys), 'SYSTEM_NOTICE 要求输出 think 心理活动', sys.slice(0, 80));
  ok(/必须照通知决策/.test(sys), 'SYSTEM_NOTICE 有"必须照通知决策"硬约束', '');
  ok(/第一人称/.test(sys), 'SYSTEM_NOTICE 要求第一人称', '');
}

console.log('[9] 场景识别 / 记忆来源 / 四处问人：都进了 prompt');
{
  const lastUser = () => String((captured[captured.length - 1].messages[1] && captured[captured.length - 1].messages[1].content) || '');
  const lastSys = () => String((captured[captured.length - 1].messages[0] && captured[captured.length - 1].messages[0].content) || '');

  // plan：场景识别三段（附近有什么 / 有哪些地方 / 刚注意到什么）
  await askStudent({
    student: { ...base, scene: '能看到：大操场（东约 20m）', places: '大操场（还没去过）、图书馆（去过）', noticed: '我看见玩家就在我附近' },
    memory: [], kind: 'plan', hour: 14, schedule: '自由活动',
  });
  const p = lastUser();
  ok(/【你周围的场景】/.test(p) && /大操场/.test(p), 'plan prompt 有【你周围的场景】', p.slice(0, 140));
  ok(/【学校有哪些地方】/.test(p) && /还没去过/.test(p), 'plan prompt 有【学校有哪些地方】', '');
  ok(/【你刚刚注意到】/.test(p), 'plan prompt 有【你刚刚注意到】（观察进 prompt）', '');

  // 记忆带传播来源（缺口 D）→ 渲染成"（顾星桥告诉我）"
  await askStudent({
    student: { ...base }, memory: [{ t: Date.now(), text: '周三有测验', kind: 'chat', src: '顾星桥' }],
    kind: 'talk', playerName: '小明', playerText: '最近有啥事吗',
  });
  const p2 = lastUser();
  ok(/顾星桥告诉我/.test(p2), '★★ 记忆带来源：渲染成"（顾星桥告诉我）"', p2.slice(-220));

  // 四处问人：SYSTEM_INQUIRE + 明确"你要问的人是谁"
  await askStudent({
    student: { ...base }, other: { name: '陈屿', cls: '高二(3)班', persona: '安静，话不多' },
    memory: [], kind: 'inquire',
  });
  const p3 = lastUser();
  const sys3 = lastSys();
  ok(/【你要问的人】/.test(p3) && /陈屿/.test(p3), 'inquire prompt 指明"你要问的人"', p3.slice(-180));
  ok(/answer/.test(sys3) && /对方/.test(sys3), 'SYSTEM_INQUIRE 要求给出"以对方口吻"的回答', sys3.slice(0, 90));
  ok(/第一人称/.test(sys3), 'SYSTEM_INQUIRE 要求第一人称（不许把自己写成第三人称）', '');
}

console.log('[10] 结构化自我档案：固定分层（我是谁/我的近况/我对自己的认识）且放最前');
{
  await askStudent({
    student: {
      ...base,
      self: '· 我是谁（永不变）：我叫顾星桥，男生，高二(3)班的学生。我的性格是「话痨…」，我最看重的是「待人善良…」。\n'
        + '· 我的近况（会更新，以这里为准）：我此刻在操场，停下来做自己的事；心情平平。\n'
        + '· 我对自己的认识：我最近想明白了几件事：我更想找人打球。',
    },
    memory: [], kind: 'talk', playerName: '小明', playerText: '你好',
  });
  const p = userTextOf(captured.length - 1);
  ok(/【你的自我档案】/.test(p), 'talk prompt 有【你的自我档案】段', p.slice(0, 80));
  ok(/我是谁（永不变）/.test(p) && /我的近况/.test(p) && /我对自己的认识/.test(p),
    '自我档案三层齐全（身份 / 近况 / 叙事）', '');
  const iSelf = p.indexOf('【你的自我档案】');
  const iPersona = p.indexOf('【你的人设】');
  ok(iSelf >= 0 && iPersona > iSelf, '自我档案排在【你的人设】之前（身份/叙事在前 ⇒ 当锚点）', 'self=' + iSelf + ' persona=' + iPersona);
}

console.log('[11] 冲突裁决规则：行为与性格冲突→按性格；记忆与当下冲突→以当下为准');
{
  await askStudent({ student: { ...base }, memory: [], kind: 'talk', playerName: '小明', playerText: '你好' });
  const sys = systemTextOf(captured.length - 1);
  ok(/按性格来/.test(sys), 'SYSTEM：一时冲动与性格冲突 → 按性格来', '');
  ok(/以当下为准/.test(sys), 'SYSTEM：记忆/旧印象与当下冲突 → 以当下为准', '');
  await askStudent({ student: { ...base }, memory: [], kind: 'plan', hour: 10, schedule: '上课' });
  const sysP = systemTextOf(captured.length - 1);
  ok(/按性格来/.test(sysP) && /以当下为准/.test(sysP), 'SYSTEM_PLAN 同样有这两条裁决规则', '');
}

console.log(fails ? '\n✗ ' + fails + ' 条断言失败' : '\n✓ 全部通过');
process.exit(fails ? 1 : 0);
