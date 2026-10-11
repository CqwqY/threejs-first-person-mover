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

console.log(fails ? '\n✗ ' + fails + ' 条断言失败' : '\n✓ 全部通过');
process.exit(fails ? 1 : 0);
