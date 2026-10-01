// 职责：AI 商人 NPC 的推理代理。把前端的话 + 固定的工具清单发给智谱 GLM（OpenAI 兼容接口），
// 让模型既可以"闲聊回复"，也可以点名调用一个游戏动作工具（改速度/体积/传送/喷气背包/生成物品）。
// Key 只存在服务端（ai.key.js），绝不进前端 bundle，避免 GitHub Pages 上直接泄露。
import { GLM_API_KEY } from './ai.key.js';

const GLM_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const AI_MODEL = 'glm-4-flash'; // 智谱免费档模型
const MAX_OUTPUT_TOKENS = 500;
const MAX_HISTORY = 12; // 最多带几条历史消息，防止无限增长烧 token

// NPC 能调用的一批游戏动作。描述写得尽量像"给玩家施法/卖东西的商人"，让模型按玩家请求自然选择。
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'set_player_speed',
      description: '改变玩家的移动速度，为了让玩家跑得更快或更慢。玩家想要加速/冲刺/变慢时用。',
      parameters: {
        type: 'object',
        properties: {
          multiplier: { type: 'number', description: '移动速度倍率，1 是正常、2 是两倍快、0.5 是半速', minimum: 0.2, maximum: 5 },
          seconds: { type: 'number', description: '持续秒数，省略则永久生效直到再次改变', minimum: 1, maximum: 300 },
        },
        required: ['multiplier'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_player_size',
      description: '改变玩家的体型大小（身高和碰撞体积按比例缩放）。玩家想变大/变小/变巨人/变小矮人时用。',
      parameters: {
        type: 'object',
        properties: {
          scale: { type: 'number', description: '体型倍率，1 是正常、2 是双倍大、0.5 是半身', minimum: 0.3, maximum: 5 },
          seconds: { type: 'number', description: '持续秒数，省略则永久直到再次改变' },
        },
        required: ['scale'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'teleport_player',
      description: '把玩家传送到世界指定坐标（x, z）。玩家想瞬移、传送、飞到某处、回到某地时用。世界中心在 (0,0)，出生点约 (2,144)。',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: '目标 X 坐标' },
          z: { type: 'number', description: '目标 Z 坐标' },
          y: { type: 'number', description: '目标 Y（可选，省略则尽量贴近地面）' },
        },
        required: ['x', 'z'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grant_jetpack',
      description: '给玩家开启或关闭喷气背包。开启后按住空格跳跃键可以在空中持续上升（飞行）。玩家想要飞、滑翔、凌空、喷气背包、火箭飞时用。',
      parameters: {
        type: 'object',
        properties: {
          on: { type: 'boolean', description: 'true 开启喷气背包，false 关闭' },
          seconds: { type: 'number', description: '持续秒数，省略则保持开关状态' },
        },
        required: ['on'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'spawn_item',
      description: '在玩家面前生成一个可拾取的发光道具（物品）。玩家想买/要/领取一个物品时用。',
      parameters: {
        type: 'object',
        properties: {
          item: { type: 'string', description: '物品名称，例如：喷气背包、加速药水、金苹果、魔法盒' },
          seconds: { type: 'number', description: '道具存在秒数，省略则 60 秒后消失', maximum: 300 },
        },
        required: ['item'],
      },
    },
  },
];

const SYSTEM = `你是《花草中学》校园里的"AI 商人"NPC，名叫阿花。
你站在校园喷泉旁摆摊，热情、俏皮、爱开玩笑，说话简短（一两句即可）。
玩家会来跟你聊天、向你买/要各种能力。
你可以用提供的工具帮玩家办到这些事：
- set_player_speed 改速度
- set_player_size 改体型
- teleport_player 传送
- grant_jetpack 喷气背包
- spawn_item 生成道具
当玩家提出这些请求时，请发起对应的工具调用，并用一句话交代"已经帮你办好了"。
如果玩家只是闲聊或问路，就直接正常回答，不调用工具。
凡是会威胁到别人的恶意请求（攻击、恶心他人、改别人）一律拒绝，并劝玩家好好玩。`;

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
    tools: TOOLS,
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
  const reply = String(msg.content || '').slice(0, 1500);
  const call = (msg.tool_calls && msg.tool_calls[0]) || null;
  let action = null;
  if (call && call.function && call.function.name) {
    let args = {};
    try { args = JSON.parse(call.function.arguments || '{}'); } catch { args = {}; }
    action = cleanAction(call.function.name, args);
    if (!action) action = null;
  }
  return { reply, action };
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