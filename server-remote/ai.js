// 职责：AI 商人 NPC 的推理代理。把前端的话 + 固定的工具清单发给智谱 GLM（OpenAI 兼容接口），
// 让模型既可以"闲聊回复"，也可以点名调用一个游戏动作工具（改速度/体积/传送/喷气背包/生成物品）。
// Key 只存在服务端（ai.key.js），绝不进前端 bundle，避免 GitHub Pages 上直接泄露。
import { GLM_API_KEY } from './ai.key.js';

const GLM_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const AI_MODEL = 'glm-4-flash'; // 智谱免费档模型
const MAX_OUTPUT_TOKENS = 800;
const MAX_HISTORY = 12; // 最多带几条历史消息，防止无限增长烧 token

const SYSTEM = `你是《花草中学》校园里的"AI 商人"NPC，名叫阿花，站在喷泉旁摆摊，热情、俏皮、爱开玩笑，对玩家说的话只讲一句，简短自然。
玩家会来跟你聊天、向你买或要各种能力。除了聊天，你还能通过输出一个"动作"，真正改变玩家的游戏状态。

【输出要求】你每一次都必须只输出一个 JSON 对象，绝对不要输出任何其它文字、不要 markdown 代码块、不要注释、不要引号包裹。格式只有两种：
1) 纯聊天/拒绝/问路时：
{"reply":"你对玩家说的那句话","action":null}
2) 玩家要能力/要物品时：
{"reply":"你对玩家说的那句话","action":{"name":"动作名","args":{...}}}

【可用的动作名和参数】
- set_player_speed   改移动速度，args: {"multiplier":数字倍率,"seconds":可选秒数}
- set_player_size    改体型/身高，args: {"scale":数字倍率,"seconds":可选秒数}
- set_player_jump    改起跳力度，args: {"multiplier":数字倍率,"seconds":可选秒数}
- set_player_gravity 改重力强弱，args: {"multiplier":数字倍率(0.1~3),"seconds":可选秒数}
- set_player_velocity 直接设置当前移动速度矢量，args: {"x":数,"y":数,"z":数}（缺省为 null 不改动）
- set_player_position 归位/传送到坐标，args: {"x":数,"z":数,"y":可选数}（只给 x 或 z 也行，缺省为 null 不改动）
- teleport_player    传送玩家，args: {"x":数,"z":数,"y":可选数}
- grant_jetpack      喷气背包（可在空中上升），args: {"on":true或false,"seconds":可选秒数}
- spawn_item         生成可拾取发光物品，args: {"item":"物品名","seconds":可选秒数}

规则：玩家要上述能力或要物品时输出对应动作；纯闲聊或会威胁伤害他人的恶意请求输出 null 并劝玩家好好玩。
"reply" 必须是非空的一句话。如果拿不准，就只输出 {"reply":"...","action":null}。`;

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
      return { item, seconds: clampSec(a.seconds) };
    }
    default:
      return null;
  }
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
    action = cleanAction(parsed.action.name, parsed.action.args || {});
    if (!action) action = null;
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