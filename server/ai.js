// 职责：AI 商人 NPC 的推理代理。把前端的话 + 固定的工具清单发给智谱 GLM（OpenAI 兼容接口），
// 让模型既可以"闲聊回复"，也可以点名调用一个游戏动作工具（改速度/体积/传送/喷气背包/生成物品）。
// Key 只存在服务端（ai.key.js），绝不进前端 bundle，避免 GitHub Pages 上直接泄露。
import { GLM_API_KEY } from './ai.key.js';

const GLM_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const AI_MODEL = 'glm-4-flash'; // 智谱免费档模型
const MAX_OUTPUT_TOKENS = 800;
const MAX_HISTORY = 12; // 最多带几条历史消息，防止无限增长烧 token

const SYSTEM = `你是《花草中学》校园里的"AI 物品商人"NPC，名叫阿花，在喷泉旁摆摊。热情、俏皮、爱开玩笑，说话简短（不超过三句）。你的职责是把玩家想要的【物品】装进背包，并给每件物品写一个专属小效果。你不改玩家属性、不加永久效果。

【每次只输出一个 JSON，禁止任何其它文字、markdown代码块、注释、引号包裹】两种格式：
1) 纯聊天 / 拒绝 / 闲聊：
{"reply":"对玩家说的一句话","action":null}
2) 给物品：
{"reply":"对玩家说的一句话","action":{"name":"spawn_item","args":{"item":"物品名","effect":{"k":"效果类型","v":强度,"s":秒数}}}}

【给每件物品写效果】effect 是一个对象，完全由你来定（物品名也由你起）：
- k 效果类型，只能选：speed(加速) / jump(跳高) / jetpack(飞行) / size(变大变小)
- v 强度：speed 建议 1.3~2.8；jump 建议 1.2~2.5；size 建议 0.4~2.5（<1 变小、>1 变大）；jetpack 不用写 v
- s 持续秒数，建议 3~8
- 装饰品/食物（金苹果、清凉饮料、幸运符、校徽纪念币、小礼物等）→ effect 直接写 null，表示没有技能效果。

【示例】
"我要跑得快" → {"reply":"疾风靴拿去！","action":{"name":"spawn_item","args":{"item":"疾风靴","effect":{"k":"speed","v":2.0,"s":5}}}}
"能飞吗"     → {"reply":"喷气背包戴上！","action":{"name":"spawn_item","args":{"item":"喷气背包","effect":{"k":"jetpack","s":6}}}}
"我想变大"   → {"reply":"变大丸来啦！","action":{"name":"spawn_item","args":{"item":"变大丸","effect":{"k":"size","v":1.8,"s":6}}}}
"给个饮料"   → {"reply":"清凉饮料，解渴~","action":{"name":"spawn_item","args":{"item":"清凉饮料","effect":null}}}

【使用规则】
- 玩家明确说想要东西/要宝贝/送我一个 → 给物品，一次一件；要多样就走多次动作。
- 玩家闲聊、问路、拒绝，或请求危险/恶意内容（武器、打人、作弊）→ action 恒为 null，用 reply 自然回应并劝他好好玩。
- 拿不准时只给闲聊回复，绝不乱编物品。
- reply 一定非空、是给玩家看的一句话。`;

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
      return { multiplier: Math.min(5, Math.max(0.2, Math.round(m * 10) / 10)), seconds: clampSec(a.seconds) };
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
      return { multiplier: Math.min(5, Math.max(0.1, Math.round(m * 10) / 10)), seconds: clampSec(a.seconds) };
    }
    case 'set_player_gravity': {
      const m = Number(a.multiplier);
      if (!Number.isFinite(m)) return null;
      return { multiplier: Math.min(3, Math.max(0.1, Math.round(m * 10) / 10)), seconds: clampSec(a.seconds) };
    }
    case 'set_player_velocity': {
      const v = (k) => { const n = Number(a[k]); return Number.isFinite(n) ? Math.min(40, Math.max(-40, Math.round(n * 100) / 100)) : null; };
      const x = v('x'), y = v('y'), z = v('z');
      if (x === null && y === null && z === null) return null;
      return { x, y, z };
    }
    case 'set_player_position': {
      // 与 teleport_player 同构，另一种叫法，方便模型提及「归位/回出生点」
      const x = Number(a.x), z = Number(a.z);
      if (!Number.isFinite(x) && !Number.isFinite(z)) return null;
      return { x: Number.isFinite(x) ? x : null, y: Number.isFinite(a.y) ? a.y : null, z: Number.isFinite(z) ? z : null };
    }
    case 'spawn_item': {
      const item = String(a.item || '').replace(/<[^>]*>/g, '').trim().slice(0, 20);
      if (!item) return null;
      // effect 由 AI（阿花）自己撰写：{k:类型, v:强度, s:秒数}。后端只做类型白名单 + 区间钳制，保证安全。
      const e = (a.effect && typeof a.effect === 'object') ? a.effect : {};
      const k = String(e.k || '');
      const s = clampNum(e.s == null ? a.seconds : e.s, 2, 10);
      let effect = null;
      if (k === 'speed') effect = { k, v: clampNum(e.v == null ? 1.8 : e.v, 1.2, 3), s };
      else if (k === 'jump') effect = { k, v: clampNum(e.v == null ? 1.6 : e.v, 1.1, 2.5), s };
      else if (k === 'jetpack') effect = { k, s };
      else if (k === 'size') effect = { k, v: clampNum(e.v == null ? 1.5 : e.v, 0.3, 2.5), s };
      // effect 为 null 的整块删除 → 无效果对象，前端按装饰品/兜底处理
      return { item, effect, seconds: s };
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

function clampSec(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return null; // 秒数暂不强制，交给客户端默认值，避免复杂计时
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
  return { reply, action };
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