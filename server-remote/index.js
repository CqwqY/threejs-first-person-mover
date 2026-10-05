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

// 疯狂抓钩的出生点：6 个起始平台（半径 15 的六边形，顶面 6m），多个玩家同台错开。
// 这几个数字必须与客户端 src/world/GrappleArena.js 的 GRAPPLE_SPAWN_* 保持一致（那边建场景，
// 服务端只发坐标，没有共享模块，只能靠注释对齐）。
function grappleSpawnForIndex(i) {
  const k = i % 6;
  const ang = (k / 6) * Math.PI * 2;
  const x = Math.cos(ang) * 15;
  const z = Math.sin(ang) * 15;
  return { x, z, y: 6, yaw: Math.atan2(x, z) }; // 面朝中心（与大厅同一约定）
}

// 按模式取出生点
function spawnForMode(mode, i, total) {
  return mode === 'grapple' ? grappleSpawnForIndex(i) : arenaSpawnForIndex(i, total);
}

// 把一批已入队的玩家塞进一个新房间，并各自通知 match_found
function createRoom(mode, members) {
  const roomId = 'r_' + (nextRoomId++);
  const room = { mode, members: new Set(members), owner: members[0] || null, spawns: new Map(), createdAt: Date.now() };
  rooms.set(roomId, room);
  const spawns = [];
  for (const ws of members) {
    ws.__room = roomId;
    const sp = spawnForMode(mode, room.spawns.size, members.length);
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

// 触发一次匹配尝试：按模式分别凑人（陨石与抓钩不混房）；够人直接开；独苗等够时间也开练习场
const SUPPORTED_MODES = new Set(['meteor', 'grapple']);
function tryMatch() {
  for (const mode of SUPPORTED_MODES) {
    const waiting = queue.filter((ws) => (ws.__matchMode || 'meteor') === mode);
    if (waiting.length >= MATCH_MIN) {
      const batch = waiting.slice(0, MATCH_MAX);
      for (const ws of batch) { const i = queue.indexOf(ws); if (i >= 0) queue.splice(i, 1); }
      createRoom(mode, batch);
      return;
    }
    if (waiting.length === 1) {
      const ws = waiting[0];
      const waited = Date.now() - (ws.__matchAt || Date.now());
      if (waited >= MATCH_SOLO_TIMEOUT) {
        const i = queue.indexOf(ws);
        if (i >= 0) queue.splice(i, 1);
        createRoom(mode, [ws]); // 单人练习场
        return;
      }
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

// ---- 商店目录 + 玩家建造（联机共享） ----
// 商店目录：玩家 GET /api/shop 公开读；管理员 POST /api/shop 带密钥改（导入模型 + 改价格）。
// 玩家建造：买来的家具（kind:'building'，先用占位方块）才能摆，摆放持久化到 data/buildings.json 并广播给所有人。
const SHOP_FILE = path.join(DATA_DIR, 'shop.json');
const BUILD_FILE = path.join(DATA_DIR, 'buildings.json');
const AREAS_FILE = path.join(DATA_DIR, 'buildareas.json');
const SHOP_ADMIN_TOKEN = process.env.SHOP_ADMIN_TOKEN || 'fpm-shop-admin'; // 改价格用管理员密钥；生产请用 env 覆盖

// 建造限流（防爆服务器）：个人上限 / 全局上限 / 放置冷却 / 缩放封顶 / 坐标钳制
const BUILD_PER_PLAYER = 5;
const BUILD_GLOBAL = 50;
const BUILD_COOLDOWN = 3000;
const BUILD_SCALE_MAX = 3;
const BUILD_SCALE_MIN = 0.1;
// 注：早期坐标用固定 ±24 钳制（那时地面半径才 25）。建造范围改成两栋楼实占后已废弃，
// 现统一走 clampBuildXZ()（跟随建造范围）。保留此行仅为标明历史，勿再使用。
const BUILD_CLAMP = 24;

// 启动种子：现有在售道具 + 两栋教学楼。首次启动写一份，之后以文件为准（编辑器在线改）
function seedShop() {
  return [
    { id: 'club', name: '棍子', price: 100, desc: '挥动横扫，被扫到的玩家会被撞飞出去。', kind: 'item', effect: { k: 'club' } },
    { id: 'blackhole', name: '黑洞', price: 150, desc: '扔出去后会不断变大，10 秒后把范围内的人吸过去。', kind: 'item', effect: { k: 'blackhole' } },
    { id: 'hide', name: '捉迷藏玩具', price: 80, desc: '变成任意颜色的方块。', kind: 'item', effect: { k: 'hide' } },
    { id: 'gatling', name: '加特林', price: 200, desc: '按住左键持续扫射，单发 30 点伤害。', kind: 'item', effect: { k: 'gatling' } },
    { id: 'ctrlgun', name: '控制枪', price: 180, desc: '激光抓住别人，移动视角拖着走；对方按空格挣脱。', kind: 'item', effect: { k: 'control' } },
    { id: 'grapple', name: '抓钩', price: 160, desc: '朝准星方向甩出钩爪，勾到墙/箱/柱子就把自己拽过去。', kind: 'item', effect: { k: 'grapple' } },
    { id: 'hammer', name: '建造锤', price: 300, desc: '装备到技能槽，按对应数字键（手机点技能键）进入建造模式：攻击键变放置，血条变家具条。', kind: 'item', effect: { k: 'hammer' } },
    { id: 'furn_chair', name: '木椅', url: 'placeholder', price: 80, desc: '占位家具（先用方块）。可在编辑器导入真实模型替换。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.5, 0.9, 0.5] },
    { id: 'furn_table', name: '木桌', url: 'placeholder', price: 120, desc: '占位家具（先用方块）。可在编辑器导入真实模型替换。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.2, 0.8, 0.8] },
    { id: 'furn_sofa', name: '布艺沙发', url: 'placeholder', price: 200, desc: '占位家具（先用方块）。可在编辑器导入真实模型替换。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.8, 0.8, 0.9] },
  ];
}
let SHOP = (() => {
  try {
    if (!fs.existsSync(SHOP_FILE)) {
      const seed = seedShop();
      fs.writeFileSync(SHOP_FILE, JSON.stringify(seed, null, 2));
      return seed;
    }
    return JSON.parse(fs.readFileSync(SHOP_FILE, 'utf8'));
  } catch (e) {
    console.warn('[relay] 商店目录读取失败，用种子:', e);
    return seedShop();
  }
})();
// 重做迁移：旧「教学楼」(build_*) 种子不要了，换成占位家具。
// 仅当还存在旧教学楼种子、或完全没有可摆放商品时触发一次；之后以文件为准。
(function migrateShop() {
  const hadOld = SHOP.some((x) => x.id === 'build_junzhong' || x.id === 'build_xingzheng');
  const hasFurn = SHOP.some((x) => x.kind === 'building');
  if (!hadOld && hasFurn) return; // 已经是家具了，不动
  SHOP = SHOP.filter((x) => x.kind !== 'building'); // 清掉所有旧教学楼
  for (const f of seedShop().filter((x) => x.kind === 'building')) {
    if (!SHOP.find((x) => x.id === f.id)) SHOP.push(f);
  }
  saveShop(SHOP);
  try {
    const bs = loadBuildings().filter((x) => !String(x.itemId || '').startsWith('build_'));
    saveBuildings(bs);
  } catch (e) { /* ignore */ }
})();
// 确保「建造锤」在售（老 shop.json 已存在时不会自动带上新种子）
(function ensureHammer() {
  if (SHOP.some((x) => x.effect && x.effect.k === 'hammer')) return;
  const h = seedShop().find((x) => x.id === 'hammer');
  if (h) { SHOP.push(h); saveShop(SHOP); }
})();
// 组合家具的部件 / 灯光消毒：只放行已知字段并逐项钳制（防脏数据 / 超大对象）
function sanitizeCombo(c) {
  const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const hex = (v) => (/^#[0-9a-fA-F]{3,8}$/.test(String(v || '')) ? String(v) : '#ffffff');
  const out = { parts: [], lights: [] };
  if (!c || typeof c !== 'object') return out;
  if (Array.isArray(c.parts)) {
    for (const p of c.parts.slice(0, 40)) {
      if (!p || typeof p !== 'object') continue;
      const u = String(p.url || '');
      if (!/^\/(assets|models)\//.test(u)) continue;
      const s = p.scale;
      const sc = (s && typeof s === 'object')
        ? { x: num(s.x, 1, 0.01, 20), y: num(s.y, 1, 0.01, 20), z: num(s.z, 1, 0.01, 20) }
        : { x: num(s, 1, 0.01, 20), y: num(s, 1, 0.01, 20), z: num(s, 1, 0.01, 20) };
      out.parts.push({
        url: u,
        x: num(p.x, 0, -400, 400), y: num(p.y, 0, -100, 300), z: num(p.z, 0, -400, 400),
        rotY: num(p.rotY, 0, -Math.PI * 4, Math.PI * 4),
        scale: sc,
      });
    }
  }
  if (Array.isArray(c.lights)) {
    for (const l of c.lights.slice(0, 20)) {
      if (!l || typeof l !== 'object') continue;
      const type = l.type === 'area' ? 'area' : 'point';
      const o = {
        type,
        x: num(l.x, 0, -400, 400), y: num(l.y, 3, -100, 300), z: num(l.z, 0, -400, 400),
        color: hex(l.color), intensity: num(l.intensity, 1, 0, 300),
      };
      if (type === 'area') {
        o.width = num(l.width, 4, 0.1, 80); o.height = num(l.height, 3, 0.1, 80);
        o.rotY = num(l.rotY, 0, -Math.PI * 4, Math.PI * 4); o.rotX = num(l.rotX, 0, -Math.PI * 2, Math.PI * 2);
      } else {
        o.distance = num(l.distance, 12, 0, 400); o.decay = num(l.decay, 2, 0, 10);
      }
      out.lights.push(o);
    }
  }
  return out;
}
function saveShop(items) { fs.writeFileSync(SHOP_FILE, JSON.stringify(items, null, 2)); }
function loadBuildings() {
  try { return JSON.parse(fs.readFileSync(BUILD_FILE, 'utf8')); } catch { return []; }
}
function saveBuildings(list) { fs.writeFileSync(BUILD_FILE, JSON.stringify(list, null, 2)); }

// ---- 建造范围（可摆家具的矩形区域，AABB）：编辑器可改，全服即时生效 ----
// ⚠ 这两组是**实机校准**的值（在编辑器「家具」页对着场景调好后保存），**不是**按 collider 半宽算的
//   —— 早期用「物件位置 + collider 半宽高按 rotY=-90° 换算」，Z 对得上但 X 整体偏了 ~26 米。
//   这里只在 data/buildareas.json 不存在/为空时兜底，正常以文件里的值为准。改这里记得和 src/config.js 对齐。
const DEFAULT_AREAS = [
  { name: '教学楼111', minX: -116, maxX: -8, minZ: 56, maxZ: 136 },
  { name: '行政楼', minX: 21, maxX: 91, minZ: 51, maxZ: 139 },
];
function sanitizeAreas(list) {
  const out = [];
  for (const a of (Array.isArray(list) ? list : []).slice(0, 20)) {
    if (!a) continue;
    const n = (v, d) => { const x = Number(v); return Number.isFinite(x) ? x : d; };
    const minX = n(a.minX, NaN), maxX = n(a.maxX, NaN), minZ = n(a.minZ, NaN), maxZ = n(a.maxZ, NaN);
    if (![minX, maxX, minZ, maxZ].every(Number.isFinite)) continue;
    out.push({
      name: String(a.name || '').slice(0, 24),
      minX: Math.min(minX, maxX), maxX: Math.max(minX, maxX),
      minZ: Math.min(minZ, maxZ), maxZ: Math.max(minZ, maxZ),
    });
  }
  return out;
}
function loadAreas() {
  try {
    const a = JSON.parse(fs.readFileSync(AREAS_FILE, 'utf8'));
    if (Array.isArray(a) && a.length) return a;
  } catch (e) { /* 没配过 → 用默认 */ }
  return DEFAULT_AREAS.map((x) => ({ ...x }));
}
function saveAreas(list) { fs.writeFileSync(AREAS_FILE, JSON.stringify(list, null, 2)); }

// 把建造坐标钳进「建造范围」：落在任一矩形内原样返回，否则吸附到最近矩形的边。
// ⚠ 以前这里是 ±24 的固定钳制（那是地面半径 25 时代的兜底），但建造范围改成两栋楼的实占
// （X -63.2~59.1 / Z 44.8~131.8）后，±24 会把楼里的正常坐标压到角落 —— 必须跟着范围走。
function clampBuildXZ(x, z) {
  const areas = loadAreas();
  if (Array.isArray(areas) && areas.length) {
    for (const a of areas) if (x >= a.minX && x <= a.maxX && z >= a.minZ && z <= a.maxZ) return { x, z };
    let best = null, bd = Infinity;
    for (const a of areas) {
      const cx = Math.min(Math.max(x, a.minX), a.maxX);
      const cz = Math.min(Math.max(z, a.minZ), a.maxZ);
      const d = (cx - x) * (cx - x) + (cz - z) * (cz - z);
      if (d < bd) { bd = d; best = { x: cx, z: cz }; }
    }
    if (best) return best;
  }
  const C = 200; // 没有任何范围配置时的宽兜底（旧行为是 24，太窄）
  return { x: Math.min(C, Math.max(-C, x)), z: Math.min(C, Math.max(-C, z)) };
}
// 取真实客户端 IP：中继跑在反向代理后面，socket.remoteAddress 永远是 127.0.0.1。
// 不读转发头的话，**所有游客的 owner 键会撞成同一个**（互相能删对方家具、共享摆放上限）。
function clientIpOf(req) {
  try {
    const h = (req && req.headers) || {};
    const xf = String(h['x-forwarded-for'] || '').split(',')[0].trim();
    if (xf) return xf;
    if (h['x-real-ip']) return String(h['x-real-ip']).trim();
    return (req && req.socket && req.socket.remoteAddress) || '';
  } catch (e) { return ''; }
}
// 归属键：登录账号用 userId；游客用真实 IP（同机重连仍算同一人，避免刷上限）
function ownerKeyOf(ws) {
  if (ws.__profile && ws.__profile.userId) return 'u:' + ws.__profile.userId;
  const rip = ws.__ip || (ws._socket && ws._socket.remoteAddress) || ws.remoteAddress || ws.__id;
  return 'anon:' + rip;
}
// 向所有在线客户端广播（建造是全局的，不分房间）
function broadcastAll(msg) {
  const raw = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(raw);
}

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

  // 商店目录：公开只读（玩家商店/建造工具都从这里取最新商品与价格）
  if (req.method === 'GET' && url.pathname === '/api/shop') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, items: SHOP }));
    return;
  }

  // 商店目录：管理员带密钥改（导入模型 + 改价格）。token 不符直接 403。
  if (req.method === 'POST' && url.pathname === '/api/shop') {
    let body = '';
    req.on('data', (chunk) => { if ((body += chunk).length > 1e6) req.destroy(); });
    req.on('end', () => {
      const bad = (m, code = 400) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: m }));
      };
      try {
        const data = JSON.parse(body);
        if (String(data.token || '') !== SHOP_ADMIN_TOKEN) return bad('管理员密钥错误', 403);
        const op = String(data.op || '');
        if (op === 'add' || op === 'update') {
          const it = data.item || {};
          const id = String(it.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
          if (!id) return bad('id 非法');
          if (op === 'add' && SHOP.find((x) => x.id === id)) return bad('id 已存在');
          const price = Math.max(0, Math.min(100000, Math.floor(Number(it.price) || 0)));
          const kind = it.kind === 'building' ? 'building' : 'item';
          const u = String(it.url || '');
          // 组合家具：kind=building + url='combo'（或直接带 combo 字段），部件/灯光单独消毒
          const comboWanted = kind === 'building' && (u === 'combo' || (it.combo && typeof it.combo === 'object'));
          if (!comboWanted && u && !/^\/(assets|models)\//.test(u) && u !== 'placeholder') return bad('url 必须是 /assets/ 或 /models/ 下的模型，或 placeholder / combo');
          const name = String(it.name || id).slice(0, 40);
          const desc = String(it.desc || '').slice(0, 200);
          const existing = SHOP.find((x) => x.id === id);
          const rec = existing ? { ...existing } : { id, kind };
          rec.name = name; rec.price = price; rec.desc = desc;
          if (comboWanted) { rec.url = 'combo'; rec.combo = sanitizeCombo(it.combo); }
          else { rec.url = (kind === 'building' && !u) ? 'placeholder' : u; rec.combo = null; }
          if (kind === 'item') rec.effect = (it.effect && typeof it.effect === 'object') ? it.effect : null;
          if (op === 'add') SHOP.push(rec);
          else SHOP = SHOP.map((x) => (x.id === id ? rec : x));
          saveShop(SHOP);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, items: SHOP }));
        } else if (op === 'del') {
          const id = String(data.id || '');
          SHOP = SHOP.filter((x) => x.id !== id);
          saveShop(SHOP);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, items: SHOP }));
        } else {
          bad('未知 op');
        }
      } catch (e) {
        bad(String(e));
      }
    });
    return;
  }

  // 玩家建造（教学楼）只读列表：所有人进游戏先拉一次，渲染全服已摆的楼
  if (req.method === 'GET' && url.pathname === '/api/build') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, items: loadBuildings() }));
    return;
  }

  // 玩家建造：管理员维护（需要密钥）。op:'clear' 清空全部摆放；op:'del' + id 删单条。
  if (req.method === 'POST' && url.pathname === '/api/build') {
    let body = '';
    req.on('data', (chunk) => { if ((body += chunk).length > 1e5) req.destroy(); });
    req.on('end', () => {
      const bad = (m, code = 400) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: m }));
      };
      let data;
      try { data = JSON.parse(body || '{}'); } catch (e) { return bad('bad json'); }
      if (String(data.token || '') !== SHOP_ADMIN_TOKEN) return bad('管理员密钥错误', 403);
      const op = String(data.op || '');
      let list = loadBuildings();
      if (op === 'clear') {
        list = [];
      } else if (op === 'del') {
        const id = String(data.id || '');
        if (!id) return bad('缺少 id');
        list = list.filter((b) => b.id !== id);
      } else {
        return bad('未知操作');
      }
      saveBuildings(list);
      broadcastAll({ t: 'build', ev: 'reload' }); // 让所有在线客户端重新拉取（清掉场上的旧家具）
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, count: list.length }));
    });
    return;
  }

  // 建造范围：公开读（客户端进游戏时拉取，覆盖本地 Config.BUILD_AREAS）
  if (req.method === 'GET' && url.pathname === '/api/buildareas') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, areas: loadAreas() }));
    return;
  }

  // 建造范围：管理员改（需要密钥）
  if (req.method === 'POST' && url.pathname === '/api/buildareas') {
    let body = '';
    req.on('data', (chunk) => { if ((body += chunk).length > 1e5) req.destroy(); });
    req.on('end', () => {
      const bad = (m, code = 400) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: m }));
      };
      let data;
      try { data = JSON.parse(body || '{}'); } catch (e) { return bad('bad json'); }
      if (String(data.token || '') !== SHOP_ADMIN_TOKEN) return bad('管理员密钥错误', 403);
      const areas = sanitizeAreas(data.areas);
      if (!areas.length) return bad('至少保留一个有效范围');
      saveAreas(areas);
      broadcastAll({ t: 'build', ev: 'areas', areas }); // 在线客户端即时更新建造范围
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, areas }));
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

// ---- 聊天 ----
const CHAT_MAX_LEN = 80;     // 单条发言硬上限（客户端另有更短的 60 字限制）
const CHAT_BURST = 5;        // 滑动窗口内最多放行几条
const CHAT_WINDOW = 2000;    // 窗口长度（毫秒）

// 聊天文本清洗：剥 HTML 标签与控制字符、把换行/连续空白压成单个空格、限长。
// 客户端用 textContent 渲染，这里再做一遍是为了不让脏数据进日志/快照。
function cleanChat(v) {
  return String(v || '')
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CHAT_MAX_LEN);
}

// 简易限流：2 秒内最多 5 条（够连续聊几句，又不至于被刷屏）。
// 不做「单条最小间隔」——那样会让连发时第二条被静默丢掉，发起者自己看到了、别人没看到。
function chatAllowed(ws) {
  const now = Date.now();
  if (!ws.__chatWin || now - ws.__chatWin > CHAT_WINDOW) {
    ws.__chatWin = now;
    ws.__chatHits = 0;
  }
  ws.__chatHits = (ws.__chatHits || 0) + 1;
  return ws.__chatHits <= CHAT_BURST;
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

wss.on('connection', (ws, req) => {
  const id = newId();
  ws.__id = id; // 记在连接上，便于 hit 广播时按 id 找到目标客户端
  ws.__ip = clientIpOf(req); // 真实 IP（代理后面 socket.remoteAddress 不可用）
  const num = allocNum(); // 复用最小空闲编号，避免重连把数字推到几十
  const spawn = spawnForNum(num);
  spawns.set(id, spawn);
  ws.__room = null;   // 当前所在房间：大厅为 null，对战房为 'r_<n>'
  ws.__num = num;     // 玩家序号（房间内出生点/名牌用）
  ws.__matchAt = 0;   // 进入匹配队列的时间戳（单人超时判定用）

  // welcome：告知新客户端自己的 id/序号/出生点，以及当前已有玩家（只列同房间/大厅的人）
  const existing = worldPlayers().filter((p) => p.id !== id && !p.room);
  ws.send(JSON.stringify({ t: 'welcome', id, num, spawn, players: existing }));
  // 建造归属键：客户端据此判断「这条家具是不是我摆的」（跨设备/清缓存也准，比本地记录可靠）
  ws.send(JSON.stringify({ t: 'build', ev: 'owner', key: ownerKeyOf(ws) }));

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
      ws.send(JSON.stringify({ t: 'build', ev: 'owner', key: ownerKeyOf(ws) })); // 登录后归属键从 anon:<ip> 变成 u:<id>，重发一次
      // 若此前已上报过自身状态，立即用登录资料刷新并广播给他人
      if (pub && states.has(id)) {
        const cur = states.get(id);
        states.set(id, { ...cur, nick: pub.nickname || pub.username || ('玩家' + cur.num), color: pub.nicknameColor || '#ffffff' });
        roomBroadcast(ws.__room, { t: 'join', id, state: states.get(id) }, ws); // 只通知同房间的人
      }
      return;
    }

    // 匹配：请求进入对战房间（mode 指定玩法：'meteor' 躲避陨石混战 / 'grapple' 疯狂抓钩）
    if (msg.t === 'match') {
      const mode = String(msg.mode || 'meteor');
      if (!SUPPORTED_MODES.has(mode)) return; // 未支持的玩法直接忽略
      if (ws.__room) return;               // 已在房间内，忽略
      if (queue.includes(ws)) return;      // 已在队列，忽略重复
      ws.__matchAt = Date.now();
      ws.__matchMode = mode;
      queue.push(ws);
      ws.send(JSON.stringify({ t: 'match_queued' }));
      tryMatch();
      return;
    }

    // 训练场：单人立刻开一个独立房间——不排队、不等别人，但**照样走房间**。
    // 为什么不干脆在本机离线开：进房后 __room 才有值，快照才会按房间隔离。
    // 否则训练场的玩家坐标会被广播进大厅（大厅里的人看到你在竞技场里飘），反之亦然。
    if (msg.t === 'train') {
      const mode = String(msg.mode || 'meteor');
      if (!SUPPORTED_MODES.has(mode)) return; // 未支持的玩法直接忽略
      const qi = queue.indexOf(ws);
      if (qi >= 0) queue.splice(qi, 1);       // 若还在匹配队列，先退出
      if (ws.__room) removeFromRoom(ws);      // 若还在别的房里，先干净退出
      ws.__matchMode = mode;
      createRoom(mode, [ws]);                 // 单人房：房主就是自己
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

    // 聊天：把发言转发给「同房间 / 同大厅」的其他人（房间隔离，对战里的人聊不到大厅）。
    // 昵称与颜色一律取服务器自己记的 profile，客户端无法伪造身份；发起者不在广播范围内，
    // 他自己那条由本地立即回显，省一个来回。
    if (msg.t === 'chat') {
      const text = cleanChat(msg.text);
      if (!text) return;
      if (!chatAllowed(ws)) return; // 刷屏限流
      const pub = ws.__profile;
      const st = states.get(id);
      const nick = pub
        ? (pub.nickname || pub.username || ('玩家' + num))
        : ((st && st.nick) || ('玩家' + num));
      const color = pub ? (pub.nicknameColor || '#ffffff') : ((st && st.color) || '#ffffff');
      roomBroadcast(ws.__room, { t: 'chat', id, nick, color, text }, ws);
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

    // 加特林开火：每一发广播一次「起点 + 方向 + 飞多远」，别人据此复刻同一颗子弹。
    // 服务器不做命中判定（伤害是开火者本地算的），也不做限流：射速由客户端的 GATLING_INTERVAL 决定（10 发/秒）。
    if (msg.t === 'shot') {
      const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
      roomBroadcast(ws.__room, {
        t: 'shot',
        from: id,
        x: num(msg.x, 0, -1000, 1000),
        y: num(msg.y, 0, -100, 500),
        z: num(msg.z, 0, -1000, 1000),
        // 方向分量只允许 [-1,1]：客户端发的是单位向量，这里只是防越界
        dx: num(msg.dx, 0, -1, 1),
        dy: num(msg.dy, 0, -1, 1),
        dz: num(msg.dz, 0, -1, 1),
        d: num(msg.d, 0, 0, 120), // 飞行距离上限略大于 GATLING_RANGE(60)，留点余量
      }, ws);
      return;
    }

    // 抓钩：ev='on' 甩出（锚点 + 出手点 + 时长）/ 'off' 收回。
    // 服务器不模拟绳索，只转发：各端按自己的玩家位置自己画绳子。
    if (msg.t === 'grapple') {
      const ev = msg.ev === 'off' ? 'off' : 'on';
      const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
      const out = { t: 'grapple', from: id, ev };
      if (ev === 'on') {
        out.x = num(msg.x, 0, -1000, 1000);
        out.y = num(msg.y, 0, -100, 500);
        out.z = num(msg.z, 0, -1000, 1000);
        out.ox = num(msg.ox, 0, -1000, 1000);
        out.oy = num(msg.oy, 0, -100, 500);
        out.oz = num(msg.oz, 0, -1000, 1000);
        out.dur = num(msg.dur, 1, 0.2, 8); // 抓钩最长 8 秒足够（距离 92m 也够飞+拉）
      }
      roomBroadcast(ws.__room, out, ws);
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

    // 丢弃物品：把物品以初始位置+初速度抛向前方，转发给同场其他人。
    // 服务器不模拟，各端本地用同一套物理（重力/弹跳/摩擦）复现，因此落点一致。
    if (msg.t === 'drop') {
      const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
      const item = String(msg.item || '').slice(0, 24);
      if (!item) return;
      const out = {
        t: 'drop',
        id: String(msg.id || '').slice(0, 40),
        item,
        x: num(msg.x, 0, -1000, 1000),
        y: num(msg.y, 0, -100, 300),
        z: num(msg.z, 0, -1000, 1000),
        vx: num(msg.vx, 0, -80, 80),
        vy: num(msg.vy, 0, -80, 80),
        vz: num(msg.vz, 0, -80, 80),
      };
      roomBroadcast(ws.__room, out, ws);
      return;
    }

    // 拾取：某件掉落物被捡走后，通知同场其他人把它从地上移除。
    // 服务器不校验归属，只做房间内转发（id 是丢弃者生成的全场唯一串）。
    if (msg.t === 'pickup') {
      const id = String(msg.id || '').slice(0, 40);
      if (!id) return;
      roomBroadcast(ws.__room, { t: 'pickup', id }, ws);
      return;
    }

    // 金币生成（疯狂抓钩）：房主发出，转发给同房其他人用同一坐标复现同一枚
    if (msg.t === 'coin_spawn') {
      const id = String(msg.id || '').slice(0, 40);
      if (!id) return;
      const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
      roomBroadcast(ws.__room, {
        t: 'coin_spawn',
        id,
        x: num(msg.x, 0, -1000, 1000),
        y: num(msg.y, 0, -50, 300),
        z: num(msg.z, 0, -1000, 1000),
      }, ws);
      return;
    }

    // 金币被吃掉：通知同房其他人移除同一枚。
    // 必须带上 from —— 抓钩模式的胜负是「谁吃到的金币最多」，而各客户端只有自己的计数，
    // 少了 from 就没法在结算里排出别人的名次（各端只能按 id 猜，或用位置距离去猜，都不靠谱）。
    if (msg.t === 'coin') {
      const id = String(msg.id || '').slice(0, 40);
      if (!id) return;
      roomBroadcast(ws.__room, { t: 'coin', id, from: ws.__id }, ws);
      return;
    }

    // 阵亡广播：由**阵亡者自己的客户端**上报（他知道最后一击是谁给的），服务器只转发给同房其他人。
    // 用途是击杀统计：谁的客户端都不掌握「我这一下把对方打死了」，只有阵亡这一侧知道。
    if (msg.t === 'die') {
      // by 允许为空（陨石/岩浆等环境伤害没有击杀者）
      const by = String(msg.by || '').slice(0, 64);
      roomBroadcast(ws.__room, { t: 'died', id: ws.__id, by }, ws);
      return;
    }

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

    // 玩家建造（教学楼）：买来的楼才能摆，服务端校验 + 限流后存储并广播。
    // 房间隔离：在大厅摆的楼只广播给大厅；对战里建造工具本就不可用。
    if (msg.t === 'build_add') {
      const owner = ownerKeyOf(ws);
      const item = SHOP.find((x) => x.id === String(msg.itemId || '') && x.kind === 'building');
      if (!item) { ws.send(JSON.stringify({ t: 'build', ev: 'rejected', reason: '这件不是可摆放的家具' })); return; }
      const now = Date.now();
      if (now - (ws.__lastBuild || 0) < BUILD_COOLDOWN) {
        ws.send(JSON.stringify({ t: 'build', ev: 'rejected', reason: '放置太快，稍等几秒' })); return;
      }
      const list = loadBuildings();
      const mine = list.filter((b) => b.owner === owner).length;
      if (mine >= BUILD_PER_PLAYER) { ws.send(JSON.stringify({ t: 'build', ev: 'rejected', reason: '已达个人摆放上限(' + BUILD_PER_PLAYER + ')' })); return; }
      if (list.length >= BUILD_GLOBAL) { ws.send(JSON.stringify({ t: 'build', ev: 'rejected', reason: '全服摆放已达上限(' + BUILD_GLOBAL + ')' })); return; }
      const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
      const xz = clampBuildXZ(num(msg.x, 0, -1e6, 1e6), num(msg.z, 0, -1e6, 1e6));
      const rec = {
        id: 'b_' + now + '_' + Math.random().toString(36).slice(2, 8),
        owner, itemId: item.id, url: item.url,
        x: xz.x,
        y: num(msg.y, 0, -2, 10),
        z: xz.z,
        rotY: num(msg.rotY, 0, -Math.PI * 4, Math.PI * 4),
        scale: num(msg.scale, 1, BUILD_SCALE_MIN, BUILD_SCALE_MAX),
        ts: now,
      };
      list.push(rec);
      saveBuildings(list);
      ws.__lastBuild = now;
      const out = { t: 'build', ev: 'add', id: rec.id, owner, itemId: rec.itemId, url: rec.url, x: rec.x, y: rec.y, z: rec.z, rotY: rec.rotY, scale: rec.scale };
      roomBroadcast(ws.__room, out, ws);              // 通知别人
      ws.send(JSON.stringify({ ...out, ev: 'added' })); // 通知自己：展开后再覆盖 ev='added'（否则被 out.ev='add' 盖掉 → 客户端当成「别人摆的」，不消耗也不可编辑）
      return;
    }

    if (msg.t === 'build_del') {
      const owner = ownerKeyOf(ws);
      const id = String(msg.id || '').slice(0, 48);
      if (!id) return;
      const list = loadBuildings();
      const idx = list.findIndex((b) => b.id === id);
      if (idx < 0) return;
      if (list[idx].owner !== owner) { ws.send(JSON.stringify({ t: 'build', ev: 'rejected', reason: '只能移除自己摆的家具' })); return; }
      list.splice(idx, 1);
      saveBuildings(list);
      broadcastAll({ t: 'build', ev: 'del', id });
      return;
    }

    // 移动/旋转自己摆的家具：原地改坐标，不新增也不消耗摆放额度
    if (msg.t === 'build_move') {
      const owner = ownerKeyOf(ws);
      const id = String(msg.id || '').slice(0, 48);
      if (!id) return;
      const list = loadBuildings();
      const rec = list.find((b) => b.id === id);
      if (!rec) return;
      if (rec.owner !== owner) { ws.send(JSON.stringify({ t: 'build', ev: 'rejected', reason: '只能编辑自己摆的家具' })); return; }
      const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
      const mXZ = clampBuildXZ(num(msg.x, rec.x, -1e6, 1e6), num(msg.z, rec.z, -1e6, 1e6));
      rec.x = mXZ.x;
      rec.y = num(msg.y, rec.y, -2, 10);
      rec.z = mXZ.z;
      rec.rotY = num(msg.rotY, rec.rotY, -Math.PI * 4, Math.PI * 4);
      rec.scale = num(msg.scale, rec.scale, BUILD_SCALE_MIN, BUILD_SCALE_MAX);
      saveBuildings(list);
      const out = { t: 'build', ev: 'move', id: rec.id, x: rec.x, y: rec.y, z: rec.z, rotY: rec.rotY, scale: rec.scale };
      roomBroadcast(ws.__room, out, ws);   // 通知别人
      ws.send(JSON.stringify(out));        // 回执自己
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
      gender: String(msg.gender || '').slice(0, 8), // 玩家自己选的男/女（客户端在本地状态里带，转发给同房其他人）
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