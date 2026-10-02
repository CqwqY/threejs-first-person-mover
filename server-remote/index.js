// 职责：
// 1) HTTP：接收「保存地图」请求，把编辑器建筑清单写入 data/ 目录；提供素材库清单 /api/models、
//    模型上传 /api/upload 与静态 /assets/*（上传文件可直接被浏览器加载）。
// 2) WebSocket：中继多人在线（连接管理、状态转发、出生点分配与周期快照广播），不做物理/碰撞/校验。
// 自包含版：所有数据写入与读取均在本文件所在目录下的 data/ 内，可独立部署到任意机器（pm2 常驻）。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { initAuth } from './auth.js';
import { handleAIRoute } from './ai.js';

const PORT = 9000; // 服务监听端口
const SNAPSHOT_INTERVAL = 50; // 快照广播间隔（毫秒），对应 20Hz
const HEARTBEAT_INTERVAL = 30000; // 心跳间隔（毫秒），防止连接被中间层断开
const SPAWN_RADIUS = 4; // 出生点离原点距离（米）
const SPAWN_ANGLE_STEP = Math.PI / 2; // 每个玩家出生点在圆周上的夹角间隔（90°）

// ---- 对战房间 / 匹配队列 ----
// 每个连接都属于一个「房间」：大厅为 null，对战房为 'r_<n>'。
// 所有玩法消息按房间定向广播，使对战玩家只看到同房的人，城市大厅玩家互不干扰。
const rooms = new Map();            // roomId -> { mode, members:Set<ws>, owner, spawns:Map<id,{x,z,yaw}>, createdAt }
let nextRoomId = 1;
const MATCH_MIN = 2;                // 至少几人开战
const MATCH_MAX = 8;                // 单房人数上限
const MATCH_SOLO_TIMEOUT = 12000;   // 单人苦等不到人时，多久放单人也开（毫秒）
const queue = [];                   // 等待匹配的 ws 列表（按入队顺序）

// 返回某房间当前在线的成员连接列表（room=null 视为大厅）
function membersOf(room) {
  if (room == null) {
    return [...wss.clients].filter((c) => c.readyState === WebSocket.OPEN && c.__room == null);
  }
  const r = rooms.get(room);
  if (!r) return [];
  return [...r.members].filter((c) => c.readyState === WebSocket.OPEN);
}

// 向某房间广播一条消息（可排除 exceptWs，比如排除发起者自己）
function roomBroadcast(room, msg, exceptWs) {
  const raw = JSON.stringify(msg);
  for (const c of membersOf(room)) {
    if (c !== exceptWs && c.readyState === WebSocket.OPEN) c.send(raw);
  }
}

// 竞技场出生点：以原点为中心环形分布，面朝中心。
// 相机前方 = (-sin yaw, -cos yaw)，要让它指向中心需 yaw = atan2(x, z)（与大厅 spawnForNum 同一约定）。
function arenaSpawnForIndex(i, total) {
  const r = 12; // 须与客户端 Config.COMBAT_SPAWN_RADIUS / COMBAT_ARENA_HALF(16) 匹配
  const ang = (i / Math.max(1, total)) * Math.PI * 2;
  const x = Math.cos(ang) * r;
  const z = Math.sin(ang) * r;
  const yaw = Math.atan2(x, z); // 看向中心 (0,0)
  return { x, z, yaw };
}

// 把一批已入队的玩家塞进一个新房间，并各自通知 match_found
function createRoom(mode, members) {
  const roomId = 'r_' + (nextRoomId++);
  const room = { mode, members: new Set(members), owner: members[0] || null, spawns: new Map(), createdAt: Date.now() };
  rooms.set(roomId, room);
  const spawns = [];
  for (const ws of members) {
    ws.__room = roomId;
    const sp = arenaSpawnForIndex(room.spawns.size, members.length);
    room.spawns.set(ws.__id, sp);
    const prof = ws.__profile;
    const nick = prof ? (prof.nickname || prof.username || ('玩家' + ws.__num)) : ('玩家' + ws.__num);
    const color = prof ? (prof.nicknameColor || '#ffffff') : '#ffffff';
    spawns.push({ id: ws.__id, num: ws.__num, spawn: sp, nick, color });
    if (states.has(ws.__id)) { const s = states.get(ws.__id); s.room = roomId; }
  }
  const payload = { mode, room: roomId, owner: room.owner ? room.owner.__id : null, members: spawns };
  for (const ws of members) {
    ws.send(JSON.stringify({ t: 'match_found', ...payload, spawn: room.spawns.get(ws.__id) }));
  }
  console.log(`[relay] 房间 ${roomId} 创建（模式 ${mode}，成员 ${members.length}）`);
}

// 触发一次匹配尝试：够人直接开；只有一个人且等够了也开（练习场）
function tryMatch() {
  if (queue.length >= MATCH_MIN) {
    const batch = queue.splice(0, Math.min(MATCH_MAX, queue.length));
    createRoom('meteor', batch);
    return;
  }
  if (queue.length === 1) {
    const ws = queue[0];
    const waited = Date.now() - (ws.__matchAt || Date.now());
    if (waited >= MATCH_SOLO_TIMEOUT) {
      queue.shift();
      createRoom('meteor', [ws]); // 单人练习场
    }
  }
}

// 把连接从其所在的对战房移除：通知同房其他人、必要时转移房主或销毁空房，并清掉状态的房间标记。
// 返回旧房 id（本来就不在房里则返回 null）。不含任何「回大厅」的广播，交由调用方决定。
function removeFromRoom(ws) {
  const room = ws.__room;
  if (!room) return null;
  const r = rooms.get(room);
  if (r) {
    r.members.delete(ws);
    roomBroadcast(room, { t: 'leave', id: ws.__id }); // 同房其他人移除该玩家模型
    if (r.owner === ws && r.members.size > 0) {
      r.owner = [...r.members][0];
      roomBroadcast(room, { t: 'room_owner', owner: r.owner.__id });
    }
    if (r.members.size === 0) rooms.delete(room);
  }
  ws.__room = null;
  if (states.has(ws.__id)) { const s = states.get(ws.__id); s.room = null; }
  return room;
}

// 玩家主动退房：回大厅——通知大厅看到他，并让客户端退出对战场景
function leaveRoom(ws) {
  const old = removeFromRoom(ws);
  if (!old) {
    ws.send(JSON.stringify({ t: 'match_left', spawn: spawnForNum(ws.__num) }));
    return;
  }
  const st = states.get(ws.__id);
  roomBroadcast(null, { t: 'join', id: ws.__id, state: st || { num: ws.__num } });
  ws.send(JSON.stringify({ t: 'match_left', spawn: spawnForNum(ws.__num) }));
}

// ---- 数据目录（自包含：相对本文件所在目录） ----
const SERVER_ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(SERVER_ROOT, 'data');
const ASSETS_DIR = path.join(DATA_DIR, 'assets');
const MAP_FILE = path.join(DATA_DIR, 'city-map.json');
const SCENE_FILE = path.join(DATA_DIR, 'editor-scene.json');
fs.mkdirSync(ASSETS_DIR, { recursive: true }); // 启动即确保目录存在

const MAX_UPLOAD = 64 * 1024 * 1024; // 单次上传上限 64MB（导入的 GLB 模型可能较大）

// 文件名消毒：只保留安全字符，避免路径注入
function sanitizeName(name) {
  return (name || 'import.glb').replace(/[^a-zA-Z0-9._-]/g, '_');
}

// 根据扩展名返回 MIME 类型（覆盖 GLB/JSON 等）
function mimeFor(ext) {
  switch (ext.toLowerCase()) {
    case '.glb': return 'model/gltf-binary';
    case '.json': return 'application/json';
    case '.bin': return 'application/octet-stream';
    default: return 'application/octet-stream';
  }
}

// HTTP 服务：承载「保存地图 / 素材清单 / 上传 / 静态资源」接口，并用 upgrade 事件转交给 WebSocket 中继
// 兜底：未捕获异常/未处理的 Promise 拒绝只记录，不让中继进程整体退出
// （否则任何一个畸形请求都可能把服务打崩，踢掉全部在线玩家）
process.on('unhandledRejection', (e) => console.warn('[relay] 未处理的 Promise 拒绝:', e));
process.on('uncaughtException', (e) => console.warn('[relay] 未捕获异常:', e));

const httpServer = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-filename, Authorization');

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // AI 商人 NPC：对话 + 工具调用（改速度/体积/传送/喷气背包/生成物品）
  if (req.method === 'POST' && url.pathname === '/api/ai') {
    await handleAIRoute(req, res, url);
    return;
  }

  // 账号相关接口（注册/登录/资料/登出）：已处理则返回
  if (await auth.handleRequest(req, res, url)) return;

  // 静态资源：/assets/<file> 从 data/assets 返回（含上传的 GLB 模型）
  if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
    const name = decodeURIComponent(url.pathname.slice('/assets/'.length)).replace(/[^a-zA-Z0-9._-]/g, '_');
    const full = path.join(ASSETS_DIR, name);
    try {
      if (!full.startsWith(ASSETS_DIR) || !fs.existsSync(full)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': mimeFor(path.extname(name)) });
      res.end(fs.readFileSync(full));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }

  // 素材库清单：读取 data/assets 下所有 .glb，供编辑器素材库使用
  if (req.method === 'GET' && url.pathname === '/api/models') {
    try {
      const names = fs.readdirSync(ASSETS_DIR).filter((n) => n.toLowerCase().endsWith('.glb')).sort();
      const items = names.map((n) => ({ name: n.replace(/\.glb$/i, ''), url: '/assets/' + n }));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, items }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }

  // 读取当前编辑器场景：供线上游戏/编辑器在运行时同步取数（与 /api/scene 的写共用同一份文件）
  if (req.method === 'GET' && url.pathname === '/api/scene') {
    try {
      if (!fs.existsSync(SCENE_FILE)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'no scene yet' }));
        return;
      }
      let data;
      try {
        data = JSON.parse(fs.readFileSync(SCENE_FILE, 'utf8'));
      } catch {
        data = null;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(data !== null ? data : {}));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
    return;
  }

  if (req.method === 'POST' && (url.pathname === '/api/map' || url.pathname === '/api/scene')) {
    let body = '';
    req.on('data', (chunk) => { if ((body += chunk).length > 8e6) req.destroy(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        // 统一写入 data/ 下 JSON（本后端为跨端共用的场景/地图数据源）
        const target = url.pathname === '/api/scene' ? SCENE_FILE : MAP_FILE;
        fs.writeFileSync(target, JSON.stringify(data, null, 2));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          count: (data && data.placed ? data.placed.length : (Array.isArray(data) ? data.length : 0)),
          file: target,
        }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/upload') {
    const name = sanitizeName(req.headers['x-filename']);
    const saved = 'import-' + Date.now() + '-' + name;
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > MAX_UPLOAD) req.destroy();
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        fs.writeFileSync(path.join(ASSETS_DIR, saved), Buffer.concat(chunks));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, url: '/assets/' + saved }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'not found' }));
});

// noDelay: 关闭 Nagle 算法，小状态包立即发出；否则内核会攒包等 ACK，白加几十毫秒延迟。
const wss = new WebSocketServer({ server: httpServer, noDelay: true });
httpServer.listen(PORT);

// id -> 已上报状态 {num, x, y, z, yaw}
const states = new Map();
// id -> 出生点 {x, z, yaw}
const spawns = new Map();

let nextId = 1;
// 当前在线的玩家编号（用于头顶标记），分配时复用已释放的最小序号，避免数字因重连而无限堆高
const usedNums = new Set();

// 自增 id，确保同一进程内唯一（仅用于连接唯一性，不展示给玩家）
function newId() {
  return 'id_' + nextId++;
}

// 分配一个当前最小的空闲玩家编号：活跃玩家始终紧凑编号 1..N，断线后该编号可被复用
function allocNum() {
  let n = 1;
  while (usedNums.has(n)) n++;
  usedNums.add(n);
  return n;
}

// 释放编号，供后续新连接复用
function freeNum(n) {
  usedNums.delete(n);
}

// 根据加入序号返回出生点。当前固定在地面角落附近 (2, 144)，面朝场景中心
function spawnForNum(num) {
  // 相机前方 = (-sin yaw, -cos yaw)；要让角色看向中心 (0,0~155 范围)，令其指向 -z / 朝中心
  const yaw = Math.atan2(2, 144); // 朝中心方向
  return { x: 2, z: 144, yaw };
}

const AUTH_DB = path.join(DATA_DIR, 'accounts.db');
// 账号系统（SQLite，schema 由 auth.js 启动时自建），不碰地图/素材文件
const auth = initAuth(AUTH_DB);

// 体型倍率白名单钳制：只接受 0.3~2.5 的有限数值，其它一律按 1（正常）处理，避免脏值影响其他客户端渲染
function clampSize(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.min(2.5, Math.max(0.3, n));
}

// 血量钳制：0~500，非法按满血处理
function clampHealth(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 500;
  return Math.min(500, Math.max(0, Math.round(n)));
}

// 单次伤害钳制：1~120，防止一击秒杀；非法返回 0（视为无效命中）
function clampDamage(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(120, Math.max(1, Math.round(n)));
}

// 手持物文字：去标签、限长 8 字，防注入
function clampHold(v) {
  return String(v || '').replace(/<[^>]*>/g, '').trim().slice(0, 8);
}

// 手持武器：白名单，只接受 '' / 'club' / 'gatling' / 'ctrlgun'，其余一律按空处理
function clampWep(v) {
  const s = String(v || '');
  return (s === 'club' || s === 'gatling' || s === 'ctrlgun') ? s : '';
}

// 载具座位：只接受 0/1/2，其余一律按"没骑"处理
function clampRide(v) {
  const n = Number(v);
  return (n === 1 || n === 2) ? n : 0;
}

// 范围效果白名单钳制（投掷物附带增益）：只允许治疗/加速/跳高/飞行/体型，参数一律夹到安全区间
function cleanFx(v) {
  if (!v || typeof v !== 'object') return null;
  const k = String(v.k || '');
  const s = Number(v.s);
  const secs = Number.isFinite(s) && s > 0 ? Math.min(20, Math.max(2, Math.round(s))) : 5;
  const num = (d, lo, hi) => { const n = Number(v.v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  if (k === 'speed') return { k, v: num(1.8, 1.2, 3), s: secs };
  if (k === 'jump') return { k, v: num(1.6, 1.1, 2.5), s: secs };
  if (k === 'jetpack') return { k, s: secs };
  if (k === 'size') return { k, v: num(1.5, 0.3, 2.5), s: secs };
  if (k === 'heal') return { k, v: num(100, 1, 500) };
  return null;
}

// 收集所有（id, 已上报状态）列表，用于 welcome / snapshot
function worldPlayers() {
  return [...states.entries()].map(([pid, st]) => ({
    id: pid,
    num: st.num,
    x: st.x,
    y: st.y,
    z: st.z,
    yaw: st.yaw,
    size: st.size,
    health: st.health,
    hold: st.hold,
    wep: st.wep,
    ride: st.ride,
    veh: st.veh,
    nick: st.nick || ('玩家' + st.num),
    color: st.color || '#ffffff',
    room: st.room || null,
  }));
}

wss.on('connection', (ws) => {
  const id = newId();
  ws.__id = id; // 记在连接上，便于 hit 广播时按 id 找到目标客户端
  const num = allocNum(); // 复用最小空闲编号，避免重连把数字推到几十
  const spawn = spawnForNum(num);
  spawns.set(id, spawn);
  ws.__room = null;   // 当前所在房间：大厅为 null，对战房为 'r_<n>'
  ws.__num = num;     // 玩家序号（房间内出生点/名牌用）
  ws.__matchAt = 0;   // 进入匹配队列的时间戳（单人超时判定用）

  // welcome：告知新客户端自己的 id/序号/出生点，以及当前已有玩家（只列同房间/大厅的人）
  const existing = worldPlayers().filter((p) => p.id !== id && !p.room);
  ws.send(JSON.stringify({ t: 'welcome', id, num, spawn, players: existing }));

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return; // 非 JSON 忽略
    }
    if (!msg) return;

    // 登录：客户端连上后携带 token 鉴权，成功则把昵称/颜色挂到本连接，供名牌展示
    if (msg.t === 'auth') {
      let pub = null;
      try {
        pub = auth.getPublicByToken(msg.token);
      } catch (e) {
        console.warn('[relay] 鉴权异常（按游客处理）:', e); // 单条消息出错不能拖垮整个中继进程
      }
      ws.__profile = pub;
      ws.send(JSON.stringify({ t: 'auth', ok: !!pub, profile: pub }));
      // 若此前已上报过自身状态，立即用登录资料刷新并广播给他人
      if (pub && states.has(id)) {
        const cur = states.get(id);
        states.set(id, { ...cur, nick: pub.nickname || pub.username || ('玩家' + cur.num), color: pub.nicknameColor || '#ffffff' });
        roomBroadcast(ws.__room, { t: 'join', id, state: states.get(id) }, ws); // 只通知同房间的人
      }
      return;
    }

    // 匹配：请求进入对战房间（mode 指定玩法，当前只支持 'meteor' 躲避陨石混战）
    if (msg.t === 'match') {
      const mode = String(msg.mode || 'meteor');
      if (mode !== 'meteor') return;       // 暂只支持陨石混战
      if (ws.__room) return;               // 已在房间内，忽略
      if (queue.includes(ws)) return;      // 已在队列，忽略重复
      ws.__matchAt = Date.now();
      ws.__matchMode = mode;
      queue.push(ws);
      ws.send(JSON.stringify({ t: 'match_queued' }));
      tryMatch();
      return;
    }

    // 取消匹配：还在队列里时退出
    if (msg.t === 'cancel_match') {
      const i = queue.indexOf(ws);
      if (i >= 0) queue.splice(i, 1);
      ws.send(JSON.stringify({ t: 'match_canceled' }));
      return;
    }

    // 退出对战房间：回到大厅
    if (msg.t === 'leave_room') {
      leaveRoom(ws);
      return;
    }

    // 命中广播：投掷物的伤害由发起方计算，这里只做区间钳制后转发给被命中的玩家。
    // 客户端收到后自行扣血（信任模型：校园内小游戏，不做服务器权威战斗）。
    if (msg.t === 'hit') {
      const dmg = clampDamage(msg.damage);
      const target = String(msg.target || '');
      if (!target || dmg <= 0 || target === id) return;
      for (const client of wss.clients) {
        if (client.__id === target && client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ t: 'hit', from: id, damage: dmg }));
          break;
        }
      }
      return;
    }

    // 击飞广播：棍子扫到人时，把冲量转发给被扫到的玩家，由他自己的客户端施加
    if (msg.t === 'knock') {
      const target = String(msg.target || '');
      if (!target || target === id) return;
      const num = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.min(40, Math.max(-40, n)) : 0; };
      const out = { t: 'knock', from: id, kx: num(msg.kx), ky: num(msg.ky), kz: num(msg.kz) };
      const raw = JSON.stringify(out);
      for (const client of wss.clients) {
        if (client.__id === target && client.readyState === WebSocket.OPEN) { client.send(raw); break; }
      }
      return;
    }

    // 控制枪：控制器把「吊住点」同步给被控者（或单方面宣布松开）；被控者挣脱时用同一条消息回报。
    // 服务器不做判定，只钳制数值后转发给目标客户端，附带 from 让双方知道对方是谁。
    if (msg.t === 'ctrl') {
      const target = String(msg.target || '');
      if (!target || target === id) return;
      const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
      const out = {
        t: 'ctrl', from: id, on: msg.on ? 1 : 0,
        x: num(msg.x, 0, -1000, 1000),
        y: num(msg.y, 0, -100, 500),
        z: num(msg.z, 0, -1000, 1000),
      };
      const raw = JSON.stringify(out);
      for (const client of wss.clients) {
        if (client.__id === target && client.readyState === WebSocket.OPEN) { client.send(raw); break; }
      }
      return;
    }

    // 范围效果广播：投掷物附带的增益，钳制后转发给被覆盖的玩家
    if (msg.t === 'fx') {
      const eff = cleanFx(msg.effect);
      const target = String(msg.target || '');
      if (!eff || !target || target === id) return;
      for (const client of wss.clients) {
        if (client.__id === target && client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ t: 'fx', from: id, effect: eff }));
          break;
        }
      }
      return;
    }

    // 投掷物出手 / 爆炸：广播给其他玩家播特效（服务器不做命中判定，只钳制数值）
    if (msg.t === 'proj' || msg.t === 'boom') {
      const pid = String(msg.id || '').slice(0, 24);
      if (!pid) return;
      const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
      const out = { t: msg.t, id: pid };
      out.x = num(msg.x, 0, -1000, 1000);
      out.y = num(msg.y, 0, -100, 500);
      out.z = num(msg.z, 0, -1000, 1000);
      if (msg.t === 'proj') {
        out.vx = num(msg.vx, 0, -80, 80);
        out.vy = num(msg.vy, 0, -80, 80);
        out.vz = num(msg.vz, 0, -80, 80);
        out.g = num(msg.g, 1, 0, 1); // 重力系数（粉笔头近乎直线，取很小值）
      } else {
        out.radius = num(msg.radius, 3, 1, 20);
        out.damage = num(msg.damage, 0, 0, 120);
      }
      roomBroadcast(ws.__room, out, ws);
      return;
    }

    // Boss（老师）事件：召唤 / 位姿 / 弹幕 / 伤害 / 死亡。
    // 服务器不模拟 Boss，只做数值钳制后转发给其他玩家；Boss 由召唤者（owner）在客户端模拟。
    if (msg.t === 'boss') {
      const ev = String(msg.ev || '');
      if (ev !== 'start' && ev !== 'pose' && ev !== 'volley' && ev !== 'damage' && ev !== 'shift' && ev !== 'phase' && ev !== 'dead' && ev !== 'bolt' && ev !== 'wall') return;
      const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
      const out = { t: 'boss', ev };
      if (ev === 'pose') {
        out.x = num(msg.x, 0, -1000, 1000);
        out.z = num(msg.z, 0, -1000, 1000);
        out.yaw = num(msg.yaw, 0, -20, 20);
        out.hp = num(msg.hp, 1000, 0, 100000);
        out.ph = Math.round(num(msg.ph, 1, 1, 3));   // 当前阶段
        out.la = num(msg.la, 0, -1000, 1000);        // 激光旋转角
        out.lv = Math.round(num(msg.lv, 1, 0, 1));   // 激光是否处于开启窗口
      } else if (ev === 'volley') {
        out.x = num(msg.x, 0, -1000, 1000);
        out.y = num(msg.y, 0, -100, 500);
        out.z = num(msg.z, 0, -1000, 1000);
      } else if (ev === 'bolt') {
        out.x = num(msg.x, 0, -1000, 1000);
        out.z = num(msg.z, 0, -1000, 1000);
      } else if (ev === 'wall') {
        out.x = num(msg.x, 0, -1000, 1000);
        out.z = num(msg.z, 0, -1000, 1000);
        out.yaw = num(msg.yaw, 0, -20, 20);
      } else if (ev === 'damage') {
        out.dmg = num(msg.dmg, 0, 1, 1000); // 上限放宽到 1000：追踪导弹一次 300
        if (out.dmg <= 0) return;
      } else if (ev === 'shift' || ev === 'phase') {
        out.ph = Math.round(num(msg.ph, 2, 1, 3));
      }
      roomBroadcast(ws.__room, out, ws);
      return;
    }

    // 黑洞：投掷者已把飞行模拟完，这里只把落点转发给其他人
    if (msg.t === 'bh') {
      const num = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.min(1000, Math.max(-1000, n)) : 0; };
      roomBroadcast(ws.__room, { t: 'bh', x: num(msg.x), z: num(msg.z) }, ws);
      return;
    }

    // 捉迷藏：开始 / 方向提示 / 结束，广播给所有人（只有相关的人会响应）
    if (msg.t === 'hide') {
      const ev = String(msg.ev || '');
      if (ev !== 'start' && ev !== 'hint' && ev !== 'end') return;
      const out = { t: 'hide', ev };
      out.hider = String(msg.hider || '').slice(0, 24);
      if (ev === 'hint') {
        const n = Number(msg.deg);
        out.deg = Number.isFinite(n) ? n : 0;
      } else {
        out.seeker = String(msg.seeker || '').slice(0, 24);
        // 颜色只留合法的十六进制位，长度固定 7
        const c = String(msg.color || '').replace(/[^#0-9a-fA-F]/g, '').slice(0, 7);
        out.color = /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#cccccc';
      }
      roomBroadcast(ws.__room, out, ws);
      return;
    }

    // 陨石生成（躲避陨石混战）：房主发出，转发给同房其他人复刻同一颗。
    // 服务器不模拟陨石，只钳制数值后转发，保证全场落点一致。
    if (msg.t === 'meteor') {
      const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
      const out = {
        t: 'meteor',
        x: num(msg.x, 0, -1000, 1000),
        z: num(msg.z, 0, -1000, 1000),
        vy: num(msg.vy, -20, -80, -1),
        r: num(msg.r, 1.5, 0.5, 6),
      };
      roomBroadcast(ws.__room, out, ws);
      return;
    }

    // 驾驶员代报后座乘客：把乘客钉到驾驶位后方。乘客自己不再单独上报，
    // 用驾驶员的权威坐标统一校准，避免双方各自插值导致乘客相对车身乱抖。
    if (msg.t === 'veh') {
      const pax = String(msg.pax || '');
      if (!pax || pax === id) return;
      const cur = states.get(pax);
      if (!cur) return; // 乘客尚未上过线（还没首次上报过），忽略
      const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
      cur.x = num(msg.x, cur.x, -1000, 1000);
      cur.y = num(msg.y, cur.y, -500, 500);
      cur.z = num(msg.z, cur.z, -1000, 1000);
      cur.yaw = num(msg.yaw, cur.yaw, -20, 20);
      cur.ride = 2; // 被代报期间恒为后座
      cur.veh = cur.veh || String(msg.veh || '').slice(0, 16);
      states.set(pax, cur);
      return;
    }

    if (msg.t !== 'state') return;

    const isFresh = !states.has(id); // 是否第一次上报（用于 join 广播）
    const pub = ws.__profile;
    states.set(id, {
      num,
      x: msg.x, y: msg.y, z: msg.z, yaw: msg.yaw,
      size: clampSize(msg.size),
      health: clampHealth(msg.health),
      hold: clampHold(msg.hold),
      wep: clampWep(msg.wep),
      ride: clampRide(msg.ride),
      veh: String(msg.veh || '').slice(0, 16),
      room: ws.__room, // 当前所在房间（大厅为 null），快照按房间分组用
      nick: pub ? (pub.nickname || pub.username || ('玩家' + num)) : ('玩家' + num),
      color: pub ? (pub.nicknameColor || '#ffffff') : '#ffffff',
    });

    if (isFresh) {
      // 新玩家首次上报：把 join（含序号与状态）广播给同房间其他人
      roomBroadcast(ws.__room, { t: 'join', id, state: states.get(id) }, ws);
    }
  });

  ws.on('close', () => {
    const i = queue.indexOf(ws);
    if (i >= 0) queue.splice(i, 1); // 若还在匹配队列，移除
    if (ws.__room) {
      removeFromRoom(ws); // 对战中掉线：通知同房其他人（不往大厅广播 join）
    } else {
      roomBroadcast(null, { t: 'leave', id }); // 大厅掉线：通知大厅其他人移除该模型
    }
    states.delete(id);
    spawns.delete(id);
    freeNum(num); // 释放编号，供后续玩家复用
  });

  // 心跳：标记存活，等待 pong 回应
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
});

// 周期心跳：隔段时间 ping；未 pong 的连接判定失效并断开
setInterval(() => {
  for (const client of wss.clients) {
    if (client.isAlive === false) {
      client.terminate();
      continue;
    }
    client.isAlive = false;
    client.ping();
  }
}, HEARTBEAT_INTERVAL);

// 世界时刻（昼夜循环）：0 = 午夜，0.5 = 正午。
// 只在有玩家在线时推进——没人在线就完全不计算，避免空跑消耗性能。
let dayTime = 0.35;
const DAY_SECONDS = 240; // 一昼夜对应的真实秒数（与客户端默认值一致，便于帧间外推）

// 周期广播所有玩家状态（20Hz）：按房间分组，使对战玩家只收到同房的快照
setInterval(() => {
  const list = worldPlayers();
  if (list.length === 0) return; // 没人在线：跳过时间推进与广播
  dayTime = (dayTime + SNAPSHOT_INTERVAL / 1000 / DAY_SECONDS) % 1;
  // 按 room 分桶（null = 大厅）
  const byRoom = new Map();
  for (const p of list) {
    const r = p.room || null;
    if (!byRoom.has(r)) byRoom.set(r, []);
    byRoom.get(r).push(p);
  }
  for (const [r, players] of byRoom) {
    roomBroadcast(r, { t: 'snapshot', players, time: dayTime });
  }
}, SNAPSHOT_INTERVAL);

// 匹配轮询：单人苦等超时也放单人也开（练习场），避免永远卡在队列里
setInterval(tryMatch, 1000);

console.log(`relay server listening at http://0.0.0.0:${PORT} (ws://<ip>:${PORT}), data dir: ${DATA_DIR}`);