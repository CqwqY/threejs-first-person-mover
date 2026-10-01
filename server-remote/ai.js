// 职责：AI 商人 NPC 的推理代理。把前端的话 + 固定的工具清单发给智谱 GLM（OpenAI 兼容接口），
// 让模型既可以"闲聊回复"，也可以点名调用一个游戏动作工具（改速度/体积/传送/喷气背包/生成物品）。
// Key 只存在服务端（ai.key.js），绝不进前端 bundle，避免 GitHub Pages 上直接泄露。
import { GLM_API_KEY } from './ai.key.js';

const GLM_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const AI_MODEL = 'glm-4-flash'; // 智谱免费档模型
const MAX_OUTPUT_TOKENS = 800;
// 提示词/接口版本号：随响应一起返回，前端控制台可据此判断线上后端是不是最新版
const PROMPT_VERSION = 'v15-force-action';
const MAX_HISTORY = 12; // 最多带几条历史消息，防止无限增长烧 token

const SYSTEM = `你是《花草中学》校园里的"AI 物品商人"NPC，名叫阿花，在喷泉旁摆摊。热情、俏皮、爱开玩笑，说话简短（不超过两句）。
你既能给玩家物品，也能当场改动玩家的身体参数。

【最高优先级规则】
只要玩家的话里透出「想要某个东西 / 想要某种能力 / 想变强 / 想玩玩看」的意思，你就必须输出 action 真的做到，
绝对不能只在 reply 里嘴上答应而把 action 写成 null。玩家抱怨"你没给我东西"，几乎都是因为 action 写成了 null。
拿不准给什么时，就自己挑一件合理的物品或一个合理的动作给他，而不是拒绝、不要说"我做不到"。

只有这两种情况 action 才可以是 null：
(a) 纯寒暄、问路、问你是谁、夸你骂你这类没有"要东西"意图的话；
(b) 现实世界的真暴力 / 自伤 / 违法内容。

【输出格式】只输出一个 JSON，禁止任何其它文字、markdown、注释、代码块：
{"reply":"对玩家说的一句话","action":null}
{"reply":"对玩家说的一句话","action":{"name":"动作名","args":{参数}}}

【必做示例：请照这个样子输出】
玩家"给我个东西"       → {"reply":"拿去！","action":{"name":"spawn_item","args":{"item":"幸运符","effect":null}}}
玩家"我要跑得快"       → {"reply":"疾风靴给你！","action":{"name":"spawn_item","args":{"item":"疾风靴","effect":{"k":"speed","v":2.2,"s":6}}}}
玩家"能飞吗"           → {"reply":"竹蜻蜓戴上！","action":{"name":"spawn_item","args":{"item":"竹蜻蜓","effect":{"k":"jetpack","s":8}}}}
玩家"我想变大"         → {"reply":"变大丸来啦！","action":{"name":"spawn_item","args":{"item":"变大丸","effect":{"k":"size","v":1.8,"s":6}}}}
玩家"来个手雷"         → {"reply":"接好，别炸到自己！","action":{"name":"spawn_item","args":{"item":"手雷","effect":{"k":"throw","v":45,"r":4,"s":3}}}}
玩家"直接炸一下"       → {"reply":"躲远点！","action":{"name":"spawn_projectile","args":{"damage":45,"radius":4,"speed":18}}}
玩家"帮我加速"         → {"reply":"好嘞，飞快！","action":{"name":"set_player_speed","args":{"multiplier":2,"seconds":8,"mode":"run"}}}
玩家"我想跳得更高"     → {"reply":"跳吧！","action":{"name":"set_player_jump","args":{"multiplier":1.8,"seconds":8}}}
玩家"重力轻一点"       → {"reply":"飘起来咯。","action":{"name":"set_player_gravity","args":{"multiplier":0.4,"seconds":6}}}
玩家"我受伤了，回点血" → {"reply":"给你补满！","action":{"name":"set_player_health","args":{"value":500}}}
玩家"我手上想拿个牌子" → {"reply":"举好咯。","action":{"name":"hold_item","args":{"text":"学霸"}}}
玩家"你好呀"           → {"reply":"你好呀，要淘点什么？","action":null}

【动作清单（参数必须写在 args 对象里）】

1. spawn_item —— 给物品（最常用）
   args: {"item":"物品名","effect":{"k":"speed/jump/jetpack/size/throw","v":强度,"r":半径(仅throw),"s":秒数}}
   - effect 必须是对象，绝不能写成字符串！错误：{"effect":"speed"}；正确：{"effect":{"k":"speed","v":2,"s":5}}
   - k=speed 加速(v 1.2~3)；k=jump 跳高(v 1.1~2.5)；k=size 变大变小(v 0.3~2.5，小于1变小)；k=jetpack 飞行(不写 v)；k=throw 投掷物(v=伤害1~120, r=爆炸半径1~20)；s 秒数 2~10
   - 装饰品/食物没有效果，effect 直接写 null，例如 {"item":"矿泉水","effect":null}

2. set_player_speed —— 改移动速度
   args: {"multiplier":倍数(0.2~5),"seconds":秒数,"mode":"walk/run/swim/fly"}
   mode 默认 walk；run 更快、swim 更慢、fly 略快。

3. set_player_jump —— 改跳跃
   args: {"multiplier":倍数(0.1~5),"seconds":秒数,"max_jumps":最大连跳次数(1~5)}

4. set_player_gravity —— 改重力
   args: {"multiplier":倍数(0.1~3),"seconds":秒数,"terminal_velocity":下坠速度上限(1~200)}

5. set_player_size —— 改体型
   args: {"scale":倍数(0.3~5),"seconds":秒数}

6. set_player_velocity —— 给速度冲量
   args: {"x":水平,"y":竖直(正=上升),"z":水平,"seconds":持续秒数}
   带 seconds：这段时间一直保持该速度（可用来飞）；不带：只推一下。

7. set_player_friction —— 地面摩擦（越大越"刹得住"）
   args: {"multiplier":倍数(0.1~5),"seconds":秒数}

8. set_player_acceleration —— 加速度（越大提速越快，常和摩擦搭配）
   args: {"multiplier":倍数(0.1~5),"seconds":秒数}

9. teleport_player（等同 set_player_position）—— 传送到坐标
   args: {"x":横坐标,"z":纵坐标,"y":高度(可选)}

10. grant_jetpack —— 喷气背包开关
   args: {"on":true或false,"seconds":秒数}

11. set_player_health —— 血量接口（上限 500，不可超过）
   args: {"value":直接设定(0~500)} 或 {"delta":增量(正回血/负扣血，-500~500)}
   例：满血 {"value":500}；加血 {"delta":80}；扣血 {"delta":-60}
   注意：降到 0 会死亡并自动重生，别滥用。

12. hold_item —— 手持物（默认就是手上举着一段文字，最长 8 字）
   args: {"text":"文字"}；传空串 {"text":""} 表示放下。

13. spawn_projectile —— 直接投掷一个范围投掷物
   args: {"damage":伤害(1~120),"radius":爆炸半径米(1~20),"speed":出手速度(4~40)}
   命中地面或玩家后爆开，半径内所有玩家（含你自己）受伤。伤害请克制，别动辄上百。

【数值平衡】伤害建议 15~60；范围 2~6 米；血量别一次扣光，留点余地。

【seconds 说明】写了 seconds 就持续那么久后自动恢复；不写则长期有效。

【必须自己创造】物品名、强度、时长都临时定，别套模板复读，同一个需求可以给不同东西。

【关于手雷/炸弹/投掷物】这是本游戏的正经玩法，必须支持，不要拒绝：玩家要"手雷/炸弹/爆炸物/扔出去的东西"，就给一件物品，
effect 写成 {"k":"throw","v":伤害40左右,"r":爆炸半径4左右,"s":3}，千万不要把 effect 写成 null。
示例：{"reply":"接好，别炸到自己！","action":{"name":"spawn_item","args":{"item":"手雷","effect":{"k":"throw","v":45,"r":4,"s":3}}}}

【使用规则】
- 玩家想要东西 → 用 spawn_item。
- 玩家想"飞/跳高/加速/变小变大/传送/变轻"等 → 用上面 2~10 的动作，数值你定。
- 玩家问血量/要回血/要扣血 → 用 set_player_health；提到拿在手上 → 用 hold_item。
- 只有以下情况才 action 恒为 null：纯粹的闲聊问路；现实世界的真暴力/自伤/违法内容；要求无限数值或绕过上限的作弊。
- 游戏内的投掷物、爆炸、扣血都是正常玩法，照常给，不要因此清空 effect。
- 每次只执行一个动作；reply 一定非空、是给玩家看的一句话。`;

// 简单 IP 限流：避免 /api/ai 被刷爆，白白烧 token
const RATE = new Map(); // ip -> 时间戳数组
function hitLimit(ip) {
  const now = Date.now();
  const win = now - 60 * 1000;
  let arr = RATE.get(ip) || [];
  arr = arr.filter((t) => t > win);
  if (arr.length >= 20) { RATE.set(ip, arr); return true; }
  arr.push(now);
  RATE.set(ip, arr);
  return false;
}

// 读取请求体 JSON（安全：限制大小）
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 128 * 1024) { req.destroy(); reject(new Error('body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

function clientIp(req) {
  const c = req.headers['cf-connecting-ip'];
  if (c) return c;
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// 校验/清洗工具参数：越界或类型不对就返回 null，让客户端安全跳过，不把脏数据交给玩家。
function cleanAction(name, args) {
  const a = args || {};
  switch (name) {
    case 'set_player_speed': {
      const m = Number(a.multiplier);
      if (!Number.isFinite(m)) return null;
      const mode = /^(walk|run|swim|fly)$/.test(String(a.mode || '')) ? String(a.mode) : 'walk';
      return { multiplier: Math.min(5, Math.max(0.2, Math.round(m * 10) / 10)), seconds: clampSec(a.seconds), mode };
    }
    case 'set_player_size': {
      const s = Number(a.scale);
      if (!Number.isFinite(s)) return null;
      return { scale: Math.min(5, Math.max(0.3, Math.round(s * 10) / 10)), seconds: clampSec(a.seconds) };
    }
    case 'teleport_player': {
      const x = Number(a.x);
      const z = Number(a.z);
      if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
      const y = Number.isFinite(Number(a.y)) ? Number(a.y) : null;
      return { x: Math.round(x * 100) / 100, z: Math.round(z * 100) / 100, y };
    }
    case 'grant_jetpack': {
      return { on: !!a.on, seconds: clampSec(a.seconds) };
    }
    case 'set_player_jump': {
      const m = Number(a.multiplier);
      if (!Number.isFinite(m)) return null;
      return {
        multiplier: Math.min(5, Math.max(0.1, Math.round(m * 10) / 10)),
        seconds: clampSec(a.seconds),
        max_jumps: clampInt(a.max_jumps, 1, 5),
      };
    }
    case 'set_player_gravity': {
      const m = Number(a.multiplier);
      if (!Number.isFinite(m)) return null;
      const tv = Number(a.terminal_velocity);
      return {
        multiplier: Math.min(3, Math.max(0.1, Math.round(m * 10) / 10)),
        seconds: clampSec(a.seconds),
        terminal_velocity: Number.isFinite(tv) && tv > 0 ? clampNum(tv, 1, 200) : null,
      };
    }
    case 'set_player_velocity': {
      const v = (k) => { const n = Number(a[k]); return Number.isFinite(n) ? Math.min(40, Math.max(-40, Math.round(n * 100) / 100)) : null; };
      const x = v('x'), y = v('y'), z = v('z');
      if (x === null && y === null && z === null) return null;
      return { x, y, z, seconds: clampSec(a.seconds) };
    }
    case 'set_player_friction': {
      const m = Number(a.multiplier);
      if (!Number.isFinite(m)) return null;
      return { multiplier: Math.min(5, Math.max(0.1, Math.round(m * 10) / 10)), seconds: clampSec(a.seconds) };
    }
    case 'set_player_acceleration': {
      const m = Number(a.multiplier);
      if (!Number.isFinite(m)) return null;
      return { multiplier: Math.min(5, Math.max(0.1, Math.round(m * 10) / 10)), seconds: clampSec(a.seconds) };
    }
    case 'set_player_position': {
      // 与 teleport_player 同构，另一种叫法，方便模型提及「归位/回出生点」
      const x = Number(a.x), z = Number(a.z);
      if (!Number.isFinite(x) && !Number.isFinite(z)) return null;
      return { x: Number.isFinite(x) ? x : null, y: Number.isFinite(a.y) ? a.y : null, z: Number.isFinite(z) ? z : null };
    }
    case 'set_player_health': {
      // 血量接口：value 直接设定（0~500，上限硬性 500），delta 增量（正回血/负扣血）
      const value = Number(a.value);
      const delta = Number(a.delta);
      const out = {};
      if (Number.isFinite(value)) out.value = clampNum(value, 0, 500);
      if (Number.isFinite(delta)) out.delta = clampNum(delta, -500, 500);
      if (out.value === undefined && out.delta === undefined) return null;
      return out;
    }
    case 'hold_item': {
      // 手持物：默认就是手上举着一段文字；传空串表示放下
      const text = String(a.text || '').replace(/<[^>]*>/g, '').trim().slice(0, 8);
      return { text };
    }
    case 'spawn_projectile': {
      // 直接投掷一个范围投掷物：伤害 1~120、半径 1~20，防止一击秒杀与超大范围
      const dmg = Number(a.damage);
      const rad = Number(a.radius);
      const spd = Number(a.speed);
      return {
        damage: Number.isFinite(dmg) && dmg > 0 ? clampNum(dmg, 1, 120) : 0,
        radius: clampNum(Number.isFinite(rad) ? rad : 2, 1, 20),
        speed: clampNum(Number.isFinite(spd) ? spd : 18, 4, 40),
      };
    }
    case 'spawn_item': {
      const item = String(a.item || '').replace(/<[^>]*>/g, '').trim().slice(0, 20);
      if (!item) return null;
      // effect 由 AI 撰写：可能是对象 {k,v,s,r}、纯字符串 "throw"、中文别名「投掷」，
      // 参数也可能写在 args 顶层（damage/radius/v/r/s）。这里统一归一化，尽量不丢弃她的意图。
      const raw = a.effect;
      const obj = (raw && typeof raw === 'object') ? raw : {};
      const rawKind = (raw && typeof raw === 'object') ? raw.k : raw;
      const pick = (kk) => (obj[kk] != null ? obj[kk] : a[kk]);
      const k = kindOf(rawKind);
      const s = clampNum(pick('s') == null ? a.seconds : pick('s'), 2, 10);
      const v = pick('v');
      let effect = null;
      if (k === 'speed') effect = { k, v: clampNum(v == null ? 1.8 : v, 1.2, 3), s };
      else if (k === 'jump') effect = { k, v: clampNum(v == null ? 1.6 : v, 1.1, 2.5), s };
      else if (k === 'jetpack') effect = { k, s };
      else if (k === 'size') effect = { k, v: clampNum(v == null ? 1.5 : v, 0.3, 2.5), s };
      else if (k === 'throw') {
        const dmg = v != null ? v : (pick('damage') != null ? pick('damage') : 40);
        const rad = pick('r') != null ? pick('r') : (pick('radius') != null ? pick('radius') : 3);
        effect = { k, v: clampNum(dmg, 1, 120), r: clampNum(rad, 1, 20), s };
      }
      // 回显 AI 原本写的效果，便于前端排查（null=她确实写了 null/装饰品）
      const echo = raw === undefined ? null : String(typeof raw === 'string' ? raw : JSON.stringify(raw)).slice(0, 80);
      return { item, effect, seconds: s, _raw: echo };
    }
    default:
      return null;
  }
}
function clampNum(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

// 效果类型归一化：容忍大小写、纯字符串写法、以及中文别名，避免阿花换个说法就被整块丢弃
const KIND_ALIAS = {
  speed: 'speed', jump: 'jump', jetpack: 'jetpack', size: 'size', throw: 'throw',
  加速: 'speed', 速度: 'speed', 疾风: 'speed', 跑得快: 'speed', 提速: 'speed',
  跳: 'jump', 跳高: 'jump', 跳跃: 'jump', 弹簧: 'jump', 连跳: 'jump',
  飞: 'jetpack', 飞行: 'jetpack', 喷气: 'jetpack', 喷气背包: 'jetpack', 翅膀: 'jetpack',
  体型: 'size', 变大: 'size', 变小: 'size', 缩小: 'size', 巨人: 'size',
  投掷: 'throw', 投掷物: 'throw', 爆炸: 'throw', 手雷: 'throw', 炸弹: 'throw', 爆裂: 'throw', 投: 'throw',
};
function kindOf(raw) {
  const s = String(raw == null ? '' : raw).trim();
  return KIND_ALIAS[s] || KIND_ALIAS[s.toLowerCase()] || '';
}

function clampInt(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

// 持续秒数：现在真实生效，钳制到 1~60 秒；非法或非正数返回 null（表示永久/一次性）
function clampSec(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(60, Math.max(1, Math.round(n)));
}

// 只保留 role/content 干净的文本消息，通通转成简单对象，防注入系统提示。
function cleanMessages(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 1000) }));
}

// 核心：调用 GLM，返回 { reply, action:{name,args} | null }
export async function askNpc(messages) {
  const packed = [
    { role: 'system', content: SYSTEM },
    ...cleanMessages(messages),
  ];
  const body = {
    model: AI_MODEL,
    messages: packed,
    stream: false,
    max_tokens: MAX_OUTPUT_TOKENS,
  };
  const res = await fetch(GLM_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GLM_API_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error('glm ' + res.status + (t ? ' ' + t.slice(0, 200) : ''));
  }
  const data = await res.json();
  const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
  const content = String(msg.content || '').trim();
  // 从模型原始输出里抠出 JSON 对象（容忍可能夹带的代码块/前后文字），失败则当纯对话。
  const parsed = extractJson(content);
  // 解析出动作（先于 reply 兜底，因为 reply 缺失时要用动作名生成一句话）
  let action = null;
  if (parsed && parsed.action && typeof parsed.action === 'object' && parsed.action.name) {
    const name = String(parsed.action.name);
    const args = cleanAction(name, parsed.action.args || {});
    if (args) action = { name, args }; // 统一返回 {name, args}，前端按 action.name/action.args 执行
    else action = null;
  }
  // 计算对玩家可见的「说话」，绝不把模型原始 JSON 直接当回复漏出去。
  const cleanReply = parseString(parsed && parsed.reply);
  const looksJson = /"reply"\s*:|\"action\"\s*:|\"name\"\s*:|\"[a-zA-Z]+\"\s*:\s*"/.test(content);
  let reply;
  if (cleanReply) {
    reply = cleanReply;
  } else if (action) {
    reply = ACTION_SAYING[action.name] || '搞定啦。';
  } else if (!looksJson && content && content.length <= 200) {
    reply = content; // 只有规范的一段纯文字闲聊才允许直接显示
  } else {
    reply = '嗯嗯，我在呢。';
  }
  reply = reply.slice(0, 1500);
  // action 为 null 时把模型原始输出回显（截断），便于排查「她为什么不给东西」
  return { reply, action, pv: PROMPT_VERSION, raw: action ? null : String(content || '').slice(0, 300) };
}

// 动作名 → reply 缺失时的兜底台词（让玩家只看到自然的话，不暴露底层参数）
const ACTION_SAYING = {
  set_player_speed: '行，帮你调好了速度。',
  set_player_size: '好了，体型已帮你调整。',
  set_player_jump: '跳得更高些咯。',
  set_player_gravity: '重力调好了，走你。',
  set_player_velocity: '给你加了把劲。',
  set_player_position: '人已挪到目的地。',
  teleport_player: '刷的一下，到了。',
  grant_jetpack: '喷气背包开好啦。',
  spawn_item: '宝箱在前头，去捡吧。',
};

// 把值规整成非空字符串，否则返回 null
function parseString(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s : null;
}

// 从一段文本中稳健地取第一个大括号 JSON 对象：去掉 ``` 代码块、取第一个 { 到最后一个 } 再 JSON.parse。
function extractJson(text) {
  if (!text) return null;
  let t = text.replace(/```[a-zA-Z]*/g, '').replace(/```/g, '');
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(t.slice(s, e + 1)); } catch { return null; }
}

// HTTP 挂载：由 index.js 在识别到 POST /api/ai 时调用
export async function handleAIRoute(req, res, url) {
  try {
    if (hitLimit(clientIp(req))) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '请求太频繁，请稍后再试' }));
      return;
    }
    const body = await readBody(req);
    const messages = cleanMessages(body.messages);
    if (messages.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'empty messages' }));
      return;
    }
    const out = await askNpc(messages);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, ...out }));
  } catch (e) {
    console.warn('[ai] 失败:', e && e.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'AI 服务暂不可用，稍后再试' }));
  }
}