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
import { createNpcWorld } from './npcworld.js';
import { askStudent } from './ai-student.js';

const PORT = 9000; // 服务监听端口
// 学生 NPC 世界（服务端权威：位置/需求/记忆都在这里跑，客户端只负责插值显示）。
// 在文件末尾初始化（要用到 dayTime 等后面才声明的量），这里先声明占位。
let npcWorld = null;
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
const CODES_FILE = path.join(DATA_DIR, 'redeem-codes.json');
const REDEEM_LOG_FILE = path.join(DATA_DIR, 'redeems.json');
// 数据采集上报：按行追加的 JSONL（每行一条）。首次写入即创建。
const TELEMETRY_FILE = path.join(DATA_DIR, 'telemetry.jsonl');
// 上报限流表：真实 IP -> 上次上报毫秒时间戳（同 IP 30 秒 1 条）。
const TELEMETRY_LAST = new Map();
// 管理员密钥（改商店 / 家具 / 建造范围 / 兑换码、进编辑器都用它）。
// 解析顺序：环境变量 SHOP_ADMIN_TOKEN > data/admin-token.txt（服务器本地文件）> 默认值并落一份该文件。
// ⚠ 绝不写进前端：editor.html 是公网静态页，写在那里等于把后台钥匙贴在门上。
const ADMIN_TOKEN_FILE = path.join(DATA_DIR, 'admin-token.txt');
const SHOP_ADMIN_TOKEN = (() => {
  const env = String(process.env.SHOP_ADMIN_TOKEN || '').trim();
  if (env) return env;
  try {
    const t = fs.readFileSync(ADMIN_TOKEN_FILE, 'utf8').trim();
    if (t) return t;
  } catch (e) { /* 首次启动还没有 → 下面落一份 */ }
  const def = 'Caiyizun1';
  try { fs.writeFileSync(ADMIN_TOKEN_FILE, def + '\n', { mode: 0o600 }); } catch (e) { /* ignore */ }
  return def;
})();

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
    { id: 'invitetp', name: '邀请传送', price: 200, desc: '选一名在线玩家发出邀请；对方同意后会传送到你身边。适合把朋友叫过来一起玩。', kind: 'item', effect: { k: 'invitetp' } },
    // ---- 家具（可摆放）· Kenney Furniture Kit 2.0（CC0），价格一律 ≤100 ----
    { id: 'furn_bathroom_cabinet', name: '浴室柜', url: 'placeholder', price: 65, desc: '浴室柜（卫浴）。模型原尺寸 0.23×0.39×0.13 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.46, 0.78, 0.26] },
    { id: 'furn_bathroom_cabinet_drawer', name: '浴室抽屉柜', url: 'placeholder', price: 65, desc: '浴室抽屉柜（卫浴）。模型原尺寸 0.43×0.47×0.32 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.86, 0.94, 0.64] },
    { id: 'furn_bathroom_mirror', name: '浴室镜', url: 'placeholder', price: 65, desc: '浴室镜（卫浴）。模型原尺寸 0.30×0.43×0.14 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.6, 0.87, 0.29] },
    { id: 'furn_bathroom_sink', name: '洗手池', url: 'placeholder', price: 80, desc: '洗手池（卫浴）。模型原尺寸 0.34×0.56×0.29 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.68, 1.12, 0.58] },
    { id: 'furn_bathroom_sink_square', name: '方形洗手池', url: 'placeholder', price: 80, desc: '方形洗手池（卫浴）。模型原尺寸 0.43×0.58×0.30 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.86, 1.16, 0.6] },
    { id: 'furn_bathtub', name: '浴缸', url: 'placeholder', price: 95, desc: '浴缸（卫浴）。模型原尺寸 1.19×0.42×0.56 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [2.38, 0.84, 1.12] },
    { id: 'furn_bear', name: '玩具熊', url: 'placeholder', price: 22, desc: '玩具熊（绿植/软装）。模型原尺寸 0.39×0.45×0.25 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.78, 0.9, 0.49] },
    { id: 'furn_bed_bunk', name: '双层床', url: 'placeholder', price: 100, desc: '双层床（卧室）。模型原尺寸 0.57×0.85×1.09 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.14, 1.7, 2.19] },
    { id: 'furn_bed_double', name: '双人床', url: 'placeholder', price: 100, desc: '双人床（卧室）。模型原尺寸 0.96×0.38×1.12 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.91, 0.75, 2.25] },
    { id: 'furn_bed_single', name: '单人床', url: 'placeholder', price: 100, desc: '单人床（卧室）。模型原尺寸 0.57×0.38×1.12 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.14, 0.75, 2.25] },
    { id: 'furn_bench', name: '长凳', url: 'placeholder', price: 40, desc: '长凳（坐具/沙发）。模型原尺寸 0.40×0.47×0.20 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.8, 0.94, 0.4] },
    { id: 'furn_bench_cushion', name: '软垫长凳', url: 'placeholder', price: 40, desc: '软垫长凳（坐具/沙发）。模型原尺寸 0.40×0.46×0.20 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.8, 0.92, 0.4] },
    { id: 'furn_bench_cushion_low', name: '矮软垫长凳', url: 'placeholder', price: 40, desc: '矮软垫长凳（坐具/沙发）。模型原尺寸 0.42×0.20×0.22 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.84, 0.4, 0.44] },
    { id: 'furn_bookcase_closed', name: '封闭书架', url: 'placeholder', price: 70, desc: '封闭书架（柜架/收纳）。模型原尺寸 0.40×0.85×0.25 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.8, 1.7, 0.5] },
    { id: 'furn_bookcase_closed_doors', name: '带门书架', url: 'placeholder', price: 70, desc: '带门书架（柜架/收纳）。模型原尺寸 0.40×0.85×0.25 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.8, 1.7, 0.5] },
    { id: 'furn_bookcase_closed_wide', name: '宽封闭书架', url: 'placeholder', price: 70, desc: '宽封闭书架（柜架/收纳）。模型原尺寸 0.80×0.79×0.25 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.6, 1.58, 0.5] },
    { id: 'furn_bookcase_open', name: '开放书架', url: 'placeholder', price: 70, desc: '开放书架（柜架/收纳）。模型原尺寸 0.40×0.88×0.25 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.8, 1.76, 0.5] },
    { id: 'furn_bookcase_open_low', name: '矮开放书架', url: 'placeholder', price: 55, desc: '矮开放书架（柜架/收纳）。模型原尺寸 0.40×0.40×0.25 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.8, 0.8, 0.5] },
    { id: 'furn_books', name: '一摞书', url: 'placeholder', price: 55, desc: '一摞书（柜架/收纳）。模型原尺寸 0.15×0.10×0.10 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.3, 0.21, 0.19] },
    { id: 'furn_cabinet_bed', name: '床柜', url: 'placeholder', price: 75, desc: '床柜（卧室）。模型原尺寸 0.27×0.23×0.21 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.53, 0.47, 0.43] },
    { id: 'furn_cabinet_bed_drawer', name: '床柜(带抽屉)', url: 'placeholder', price: 75, desc: '床柜(带抽屉)（卧室）。模型原尺寸 0.27×0.26×0.22 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.53, 0.53, 0.43] },
    { id: 'furn_cabinet_bed_drawer_table', name: '床柜桌', url: 'placeholder', price: 75, desc: '床柜桌（卧室）。模型原尺寸 0.27×0.26×0.22 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.53, 0.53, 0.43] },
    { id: 'furn_cabinet_television', name: '电视柜', url: 'placeholder', price: 70, desc: '电视柜（柜架/收纳）。模型原尺寸 0.80×0.31×0.25 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.6, 0.62, 0.5] },
    { id: 'furn_cabinet_television_doors', name: '带门电视柜', url: 'placeholder', price: 70, desc: '带门电视柜（柜架/收纳）。模型原尺寸 0.80×0.31×0.26 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.6, 0.62, 0.52] },
    { id: 'furn_cardboard_box_closed', name: '纸箱(封)', url: 'placeholder', price: 55, desc: '纸箱(封)（柜架/收纳）。模型原尺寸 0.21×0.28×0.21 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.42, 0.56, 0.42] },
    { id: 'furn_cardboard_box_open', name: '纸箱(开)', url: 'placeholder', price: 55, desc: '纸箱(开)（柜架/收纳）。模型原尺寸 0.37×0.28×0.21 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.74, 0.56, 0.42] },
    { id: 'furn_ceiling_fan', name: '吊扇', url: 'placeholder', price: 45, desc: '吊扇（照明）。模型原尺寸 0.46×0.13×0.53 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.91, 0.27, 1.05] },
    { id: 'furn_chair', name: '木椅', url: 'placeholder', price: 40, desc: '木椅（坐具/沙发）。模型原尺寸 0.20×0.47×0.20 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.4, 0.94, 0.4] },
    { id: 'furn_chair_cushion', name: '软垫椅', url: 'placeholder', price: 40, desc: '软垫椅（坐具/沙发）。模型原尺寸 0.20×0.46×0.20 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.4, 0.92, 0.4] },
    { id: 'furn_chair_desk', name: '办公椅', url: 'placeholder', price: 55, desc: '办公椅（坐具/沙发）。模型原尺寸 0.34×0.61×0.31 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.67, 1.22, 0.63] },
    { id: 'furn_chair_modern_cushion', name: '现代软垫椅', url: 'placeholder', price: 40, desc: '现代软垫椅（坐具/沙发）。模型原尺寸 0.20×0.46×0.20 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.4, 0.92, 0.4] },
    { id: 'furn_chair_modern_frame_cushion', name: '现代框软垫椅', url: 'placeholder', price: 40, desc: '现代框软垫椅（坐具/沙发）。模型原尺寸 0.20×0.46×0.20 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.4, 0.92, 0.4] },
    { id: 'furn_chair_rounded', name: '圆角椅', url: 'placeholder', price: 40, desc: '圆角椅（坐具/沙发）。模型原尺寸 0.20×0.46×0.20 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.4, 0.91, 0.4] },
    { id: 'furn_coat_rack', name: '挂衣架', url: 'placeholder', price: 55, desc: '挂衣架（柜架/收纳）。模型原尺寸 0.45×0.28×0.13 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.9, 0.56, 0.27] },
    { id: 'furn_coat_rack_standing', name: '落地衣帽架', url: 'placeholder', price: 70, desc: '落地衣帽架（柜架/收纳）。模型原尺寸 0.27×0.77×0.27 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.55, 1.54, 0.55] },
    { id: 'furn_computer_keyboard', name: '键盘', url: 'placeholder', price: 40, desc: '键盘（电子）。模型原尺寸 0.28×0.03×0.12 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.56, 0.06, 0.24] },
    { id: 'furn_computer_mouse', name: '鼠标', url: 'placeholder', price: 40, desc: '鼠标（电子）。模型原尺寸 0.05×0.02×0.09 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.1, 0.05, 0.17] },
    { id: 'furn_computer_screen', name: '显示器', url: 'placeholder', price: 40, desc: '显示器（电子）。模型原尺寸 0.39×0.29×0.10 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.79, 0.59, 0.21] },
    { id: 'furn_desk', name: '书桌', url: 'placeholder', price: 60, desc: '书桌（桌台）。模型原尺寸 0.73×0.38×0.39 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.47, 0.77, 0.78] },
    { id: 'furn_desk_corner', name: '转角书桌', url: 'placeholder', price: 60, desc: '转角书桌（桌台）。模型原尺寸 0.97×0.38×0.97 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.95, 0.77, 1.95] },
    { id: 'furn_doorway', name: '门框', url: 'placeholder', price: 48, desc: '门框（建筑构件）。模型原尺寸 0.49×1.01×0.11 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.97, 2.02, 0.23] },
    { id: 'furn_doorway_front', name: '门框(正面)', url: 'placeholder', price: 48, desc: '门框(正面)（建筑构件）。模型原尺寸 0.49×1.01×0.11 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.97, 2.02, 0.23] },
    { id: 'furn_doorway_open', name: '门框(敞开)', url: 'placeholder', price: 48, desc: '门框(敞开)（建筑构件）。模型原尺寸 0.49×1.01×0.09 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.97, 2.02, 0.18] },
    { id: 'furn_dryer', name: '烘干机', url: 'placeholder', price: 85, desc: '烘干机（洗衣）。模型原尺寸 0.39×0.47×0.38 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.78, 0.94, 0.76] },
    { id: 'furn_floor_corner', name: '地板(角)', url: 'placeholder', price: 33, desc: '地板(角)（建筑构件）。模型原尺寸 0.55×0.05×0.55 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.1, 0.1, 1.1] },
    { id: 'furn_floor_corner_round', name: '地板(圆角)', url: 'placeholder', price: 33, desc: '地板(圆角)（建筑构件）。模型原尺寸 0.55×0.05×0.55 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.1, 0.1, 1.1] },
    { id: 'furn_floor_full', name: '地板(整块)', url: 'placeholder', price: 33, desc: '地板(整块)（建筑构件）。模型原尺寸 1.00×0.05×1.00 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [2, 0.1, 2] },
    { id: 'furn_floor_half', name: '地板(半块)', url: 'placeholder', price: 33, desc: '地板(半块)（建筑构件）。模型原尺寸 0.50×0.05×1.00 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.0, 0.1, 2] },
    { id: 'furn_hood_large', name: '抽油烟机(大)', url: 'placeholder', price: 60, desc: '抽油烟机(大)（厨房）。模型原尺寸 0.43×0.37×0.28 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.86, 0.74, 0.57] },
    { id: 'furn_hood_modern', name: '抽油烟机(现代)', url: 'placeholder', price: 60, desc: '抽油烟机(现代)（厨房）。模型原尺寸 0.43×0.40×0.28 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.86, 0.8, 0.57] },
    { id: 'furn_kitchen_bar', name: '吧台', url: 'placeholder', price: 60, desc: '吧台（厨房）。模型原尺寸 0.43×0.42×0.21 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.86, 0.84, 0.42] },
    { id: 'furn_kitchen_bar_end', name: '吧台端', url: 'placeholder', price: 60, desc: '吧台端（厨房）。模型原尺寸 0.10×0.42×0.21 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.2, 0.84, 0.42] },
    { id: 'furn_kitchen_blender', name: '搅拌机', url: 'placeholder', price: 60, desc: '搅拌机（厨房）。模型原尺寸 0.14×0.23×0.11 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.27, 0.46, 0.22] },
    { id: 'furn_kitchen_cabinet', name: '厨柜', url: 'placeholder', price: 60, desc: '厨柜（厨房）。模型原尺寸 0.43×0.45×0.45 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.86, 0.9, 0.9] },
    { id: 'furn_kitchen_cabinet_corner_inner', name: '厨柜(内角)', url: 'placeholder', price: 60, desc: '厨柜(内角)（厨房）。模型原尺寸 0.46×0.45×0.46 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.92, 0.9, 0.92] },
    { id: 'furn_kitchen_cabinet_corner_round', name: '厨柜(圆角)', url: 'placeholder', price: 60, desc: '厨柜(圆角)（厨房）。模型原尺寸 0.45×0.45×0.45 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.9, 0.9, 0.9] },
    { id: 'furn_kitchen_cabinet_drawer', name: '厨柜(抽屉)', url: 'placeholder', price: 60, desc: '厨柜(抽屉)（厨房）。模型原尺寸 0.43×0.45×0.45 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.86, 0.9, 0.9] },
    { id: 'furn_kitchen_cabinet_upper', name: '吊柜', url: 'placeholder', price: 60, desc: '吊柜（厨房）。模型原尺寸 0.43×0.39×0.22 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.86, 0.78, 0.44] },
    { id: 'furn_kitchen_cabinet_upper_corner', name: '吊柜(角)', url: 'placeholder', price: 60, desc: '吊柜(角)（厨房）。模型原尺寸 0.21×0.39×0.21 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.43, 0.78, 0.42] },
    { id: 'furn_kitchen_cabinet_upper_double', name: '吊柜(双)', url: 'placeholder', price: 60, desc: '吊柜(双)（厨房）。模型原尺寸 0.43×0.39×0.22 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.86, 0.78, 0.44] },
    { id: 'furn_kitchen_cabinet_upper_low', name: '吊柜(矮)', url: 'placeholder', price: 60, desc: '吊柜(矮)（厨房）。模型原尺寸 0.43×0.20×0.22 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.86, 0.39, 0.44] },
    { id: 'furn_kitchen_coffee_machine', name: '咖啡机', url: 'placeholder', price: 60, desc: '咖啡机（厨房）。模型原尺寸 0.19×0.18×0.24 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.38, 0.35, 0.48] },
    { id: 'furn_kitchen_fridge', name: '冰箱', url: 'placeholder', price: 75, desc: '冰箱（厨房）。模型原尺寸 0.43×0.92×0.29 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.86, 1.84, 0.58] },
    { id: 'furn_kitchen_fridge_built_in', name: '嵌入式冰箱', url: 'placeholder', price: 75, desc: '嵌入式冰箱（厨房）。模型原尺寸 0.43×0.87×0.45 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.86, 1.74, 0.9] },
    { id: 'furn_kitchen_fridge_large', name: '大冰箱', url: 'placeholder', price: 75, desc: '大冰箱（厨房）。模型原尺寸 0.52×0.92×0.41 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.04, 1.84, 0.81] },
    { id: 'furn_kitchen_fridge_small', name: '小冰箱', url: 'placeholder', price: 75, desc: '小冰箱（厨房）。模型原尺寸 0.43×0.60×0.29 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.86, 1.2, 0.58] },
    { id: 'furn_kitchen_microwave', name: '微波炉', url: 'placeholder', price: 60, desc: '微波炉（厨房）。模型原尺寸 0.29×0.18×0.23 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.58, 0.36, 0.46] },
    { id: 'furn_kitchen_sink', name: '厨房水槽', url: 'placeholder', price: 60, desc: '厨房水槽（厨房）。模型原尺寸 0.43×0.49×0.45 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.86, 0.98, 0.9] },
    { id: 'furn_kitchen_stove', name: '燃气灶', url: 'placeholder', price: 60, desc: '燃气灶（厨房）。模型原尺寸 0.43×0.45×0.45 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.86, 0.9, 0.9] },
    { id: 'furn_kitchen_stove_electric', name: '电磁灶', url: 'placeholder', price: 60, desc: '电磁灶（厨房）。模型原尺寸 0.43×0.45×0.45 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.86, 0.9, 0.9] },
    { id: 'furn_lamp_round_floor', name: '圆落地灯', url: 'placeholder', price: 45, desc: '圆落地灯（照明）。模型原尺寸 0.15×0.86×0.18 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.3, 1.72, 0.35] },
    { id: 'furn_lamp_round_table', name: '圆台灯', url: 'placeholder', price: 45, desc: '圆台灯（桌台）。模型原尺寸 0.15×0.31×0.18 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.3, 0.63, 0.35] },
    { id: 'furn_lamp_square_ceiling', name: '方吸顶灯', url: 'placeholder', price: 30, desc: '方吸顶灯（照明）。模型原尺寸 0.12×0.23×0.12 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.24, 0.46, 0.24] },
    { id: 'furn_lamp_square_floor', name: '方落地灯', url: 'placeholder', price: 45, desc: '方落地灯（照明）。模型原尺寸 0.12×0.86×0.12 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.24, 1.72, 0.24] },
    { id: 'furn_lamp_square_table', name: '方台灯', url: 'placeholder', price: 45, desc: '方台灯（桌台）。模型原尺寸 0.12×0.29×0.12 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.24, 0.58, 0.24] },
    { id: 'furn_lamp_wall', name: '壁灯', url: 'placeholder', price: 30, desc: '壁灯（照明）。模型原尺寸 0.23×0.09×0.15 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.45, 0.19, 0.3] },
    { id: 'furn_laptop', name: '笔记本电脑', url: 'placeholder', price: 40, desc: '笔记本电脑（电子）。模型原尺寸 0.26×0.16×0.24 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.53, 0.32, 0.48] },
    { id: 'furn_lounge_chair', name: '休闲椅', url: 'placeholder', price: 40, desc: '休闲椅（坐具/沙发）。模型原尺寸 0.49×0.46×0.41 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.98, 0.92, 0.82] },
    { id: 'furn_lounge_chair_relax', name: '躺椅', url: 'placeholder', price: 55, desc: '躺椅（坐具/沙发）。模型原尺寸 0.49×0.63×0.68 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.98, 1.26, 1.35] },
    { id: 'furn_lounge_design_chair', name: '设计休闲椅', url: 'placeholder', price: 55, desc: '设计休闲椅（坐具/沙发）。模型原尺寸 0.73×0.40×0.41 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.46, 0.8, 0.82] },
    { id: 'furn_lounge_design_sofa', name: '设计沙发', url: 'placeholder', price: 70, desc: '设计沙发（坐具/沙发）。模型原尺寸 1.12×0.40×0.41 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [2.24, 0.8, 0.82] },
    { id: 'furn_lounge_design_sofa_corner', name: '设计转角沙发', url: 'placeholder', price: 70, desc: '设计转角沙发（坐具/沙发）。模型原尺寸 1.35×0.40×1.35 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [2.7, 0.8, 2.7] },
    { id: 'furn_sofa', name: '布艺沙发', url: 'placeholder', price: 55, desc: '布艺沙发（坐具/沙发）。模型原尺寸 0.98×0.46×0.41 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.96, 0.92, 0.82] },
    { id: 'furn_lounge_sofa_corner', name: '转角沙发', url: 'placeholder', price: 55, desc: '转角沙发（坐具/沙发）。模型原尺寸 0.98×0.46×0.98 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.96, 0.92, 1.96] },
    { id: 'furn_lounge_sofa_long', name: '长沙发', url: 'placeholder', price: 55, desc: '长沙发（坐具/沙发）。模型原尺寸 0.98×0.46×0.82 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.96, 0.92, 1.64] },
    { id: 'furn_lounge_sofa_ottoman', name: '沙发脚凳', url: 'placeholder', price: 40, desc: '沙发脚凳（坐具/沙发）。模型原尺寸 0.44×0.23×0.45 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.88, 0.46, 0.9] },
    { id: 'furn_paneling', name: '墙板', url: 'placeholder', price: 33, desc: '墙板（建筑构件）。模型原尺寸 0.50×0.59×0.03 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.0, 1.19, 0.06] },
    { id: 'furn_pillow', name: '抱枕', url: 'placeholder', price: 75, desc: '抱枕（卧室）。模型原尺寸 0.23×0.22×0.09 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.46, 0.44, 0.18] },
    { id: 'furn_pillow_blue', name: '蓝抱枕', url: 'placeholder', price: 75, desc: '蓝抱枕（卧室）。模型原尺寸 0.23×0.13×0.06 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.46, 0.26, 0.13] },
    { id: 'furn_pillow_blue_long', name: '蓝长抱枕', url: 'placeholder', price: 90, desc: '蓝长抱枕（卧室）。模型原尺寸 0.52×0.22×0.09 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.03, 0.44, 0.18] },
    { id: 'furn_pillow_long', name: '长抱枕', url: 'placeholder', price: 75, desc: '长抱枕（卧室）。模型原尺寸 0.39×0.22×0.09 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.77, 0.44, 0.18] },
    { id: 'furn_plant_small1', name: '小盆栽1', url: 'placeholder', price: 22, desc: '小盆栽1（绿植/软装）。模型原尺寸 0.10×0.14×0.10 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.19, 0.28, 0.19] },
    { id: 'furn_plant_small2', name: '小盆栽2', url: 'placeholder', price: 22, desc: '小盆栽2（绿植/软装）。模型原尺寸 0.10×0.14×0.10 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.19, 0.28, 0.19] },
    { id: 'furn_plant_small3', name: '小盆栽3', url: 'placeholder', price: 22, desc: '小盆栽3（绿植/软装）。模型原尺寸 0.10×0.14×0.09 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.2, 0.29, 0.17] },
    { id: 'furn_potted_plant', name: '盆栽', url: 'placeholder', price: 37, desc: '盆栽（绿植/软装）。模型原尺寸 0.21×0.65×0.24 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.42, 1.31, 0.48] },
    { id: 'furn_radio', name: '收音机', url: 'placeholder', price: 40, desc: '收音机（电子）。模型原尺寸 0.32×0.23×0.10 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.63, 0.46, 0.2] },
    { id: 'furn_rug_doormat', name: '门口地垫', url: 'placeholder', price: 22, desc: '门口地垫（绿植/软装）。模型原尺寸 0.43×0.01×0.24 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.86, 0.02, 0.47] },
    { id: 'furn_rug_rectangle', name: '长方形地毯', url: 'placeholder', price: 52, desc: '长方形地毯（绿植/软装）。模型原尺寸 1.57×0.01×0.92 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [3.14, 0.02, 1.84] },
    { id: 'furn_rug_round', name: '圆形地毯', url: 'placeholder', price: 37, desc: '圆形地毯（绿植/软装）。模型原尺寸 0.92×0.01×0.92 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.84, 0.02, 1.84] },
    { id: 'furn_rug_rounded', name: '圆角地毯', url: 'placeholder', price: 52, desc: '圆角地毯（绿植/软装）。模型原尺寸 1.57×0.01×0.92 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [3.14, 0.02, 1.84] },
    { id: 'furn_rug_square', name: '方形地毯', url: 'placeholder', price: 37, desc: '方形地毯（绿植/软装）。模型原尺寸 0.90×0.01×0.92 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.81, 0.02, 1.84] },
    { id: 'furn_shower', name: '淋浴', url: 'placeholder', price: 95, desc: '淋浴（卫浴）。模型原尺寸 0.56×1.09×0.58 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.12, 2.19, 1.16] },
    { id: 'furn_shower_round', name: '圆淋浴', url: 'placeholder', price: 95, desc: '圆淋浴（卫浴）。模型原尺寸 0.56×1.09×0.56 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.12, 2.19, 1.12] },
    { id: 'furn_side_table', name: '边桌', url: 'placeholder', price: 60, desc: '边桌（桌台）。模型原尺寸 0.53×0.38×0.22 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.07, 0.77, 0.44] },
    { id: 'furn_side_table_drawers', name: '抽屉边桌', url: 'placeholder', price: 60, desc: '抽屉边桌（桌台）。模型原尺寸 0.53×0.38×0.22 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.07, 0.77, 0.44] },
    { id: 'furn_speaker', name: '音箱', url: 'placeholder', price: 55, desc: '音箱（电子）。模型原尺寸 0.15×0.64×0.15 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.3, 1.27, 0.3] },
    { id: 'furn_speaker_small', name: '小音箱', url: 'placeholder', price: 40, desc: '小音箱（电子）。模型原尺寸 0.15×0.30×0.13 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.3, 0.6, 0.27] },
    { id: 'furn_stairs', name: '楼梯', url: 'placeholder', price: 48, desc: '楼梯（建筑构件）。模型原尺寸 1.82×1.34×0.79 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [3.65, 2.68, 1.58] },
    { id: 'furn_stairs_corner', name: '转角楼梯', url: 'placeholder', price: 48, desc: '转角楼梯（建筑构件）。模型原尺寸 1.77×1.34×1.43 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [3.55, 2.68, 2.85] },
    { id: 'furn_stairs_open', name: '开放式楼梯', url: 'placeholder', price: 48, desc: '开放式楼梯（建筑构件）。模型原尺寸 1.82×1.34×0.79 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [3.65, 2.68, 1.58] },
    { id: 'furn_stairs_open_single', name: '单跑开楼梯', url: 'placeholder', price: 48, desc: '单跑开楼梯（建筑构件）。模型原尺寸 1.82×1.34×0.79 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [3.65, 2.68, 1.58] },
    { id: 'furn_stool_bar', name: '吧凳', url: 'placeholder', price: 40, desc: '吧凳（坐具/沙发）。模型原尺寸 0.27×0.43×0.23 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.53, 0.87, 0.46] },
    { id: 'furn_stool_bar_square', name: '方吧凳', url: 'placeholder', price: 40, desc: '方吧凳（坐具/沙发）。模型原尺寸 0.15×0.41×0.15 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.31, 0.81, 0.3] },
    { id: 'furn_table', name: '木桌', url: 'placeholder', price: 60, desc: '木桌（桌台）。模型原尺寸 0.84×0.33×0.45 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.68, 0.65, 0.89] },
    { id: 'furn_table_cloth', name: '铺布桌', url: 'placeholder', price: 60, desc: '铺布桌（桌台）。模型原尺寸 0.84×0.33×0.45 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.68, 0.65, 0.89] },
    { id: 'furn_table_coffee', name: '茶几', url: 'placeholder', price: 60, desc: '茶几（桌台）。模型原尺寸 0.66×0.23×0.40 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.32, 0.46, 0.8] },
    { id: 'furn_table_coffee_glass', name: '玻璃茶几', url: 'placeholder', price: 60, desc: '玻璃茶几（桌台）。模型原尺寸 0.66×0.23×0.40 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.32, 0.46, 0.8] },
    { id: 'furn_table_coffee_glass_square', name: '方玻璃茶几', url: 'placeholder', price: 45, desc: '方玻璃茶几（桌台）。模型原尺寸 0.40×0.23×0.40 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.8, 0.46, 0.8] },
    { id: 'furn_table_coffee_square', name: '方茶几', url: 'placeholder', price: 45, desc: '方茶几（桌台）。模型原尺寸 0.40×0.23×0.40 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.8, 0.46, 0.8] },
    { id: 'furn_table_cross', name: '交叉腿桌', url: 'placeholder', price: 60, desc: '交叉腿桌（桌台）。模型原尺寸 0.85×0.35×0.45 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.7, 0.69, 0.89] },
    { id: 'furn_table_cross_cloth', name: '交叉腿布桌', url: 'placeholder', price: 60, desc: '交叉腿布桌（桌台）。模型原尺寸 0.85×0.35×0.45 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.7, 0.69, 0.89] },
    { id: 'furn_table_glass', name: '玻璃桌', url: 'placeholder', price: 60, desc: '玻璃桌（桌台）。模型原尺寸 0.84×0.33×0.45 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.68, 0.65, 0.89] },
    { id: 'furn_table_round', name: '圆桌', url: 'placeholder', price: 60, desc: '圆桌（桌台）。模型原尺寸 0.69×0.37×0.80 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.39, 0.73, 1.6] },
    { id: 'furn_television_antenna', name: '天线电视', url: 'placeholder', price: 40, desc: '天线电视（电子）。模型原尺寸 0.27×0.10×0.08 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.53, 0.21, 0.16] },
    { id: 'furn_television_modern', name: '现代电视', url: 'placeholder', price: 55, desc: '现代电视（电子）。模型原尺寸 0.69×0.46×0.13 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.37, 0.91, 0.26] },
    { id: 'furn_television_vintage', name: '复古电视', url: 'placeholder', price: 40, desc: '复古电视（电子）。模型原尺寸 0.41×0.27×0.27 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.82, 0.54, 0.54] },
    { id: 'furn_toaster', name: '烤面包机', url: 'placeholder', price: 60, desc: '烤面包机（厨房）。模型原尺寸 0.19×0.13×0.10 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.38, 0.26, 0.2] },
    { id: 'furn_toilet', name: '马桶', url: 'placeholder', price: 65, desc: '马桶（卫浴）。模型原尺寸 0.31×0.45×0.48 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.63, 0.9, 0.95] },
    { id: 'furn_toilet_square', name: '方马桶', url: 'placeholder', price: 65, desc: '方马桶（卫浴）。模型原尺寸 0.30×0.45×0.39 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.61, 0.9, 0.77] },
    { id: 'furn_trashcan', name: '垃圾桶', url: 'placeholder', price: 55, desc: '垃圾桶（柜架/收纳）。模型原尺寸 0.21×0.43×0.23 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.42, 0.86, 0.47] },
    { id: 'furn_wall', name: '墙', url: 'placeholder', price: 48, desc: '墙（建筑构件）。模型原尺寸 1.00×1.29×0.05 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [2, 2.58, 0.1] },
    { id: 'furn_wall_corner', name: '墙角', url: 'placeholder', price: 48, desc: '墙角（建筑构件）。模型原尺寸 0.55×1.29×0.55 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.1, 2.58, 1.1] },
    { id: 'furn_wall_corner_rond', name: '圆角墙角', url: 'placeholder', price: 48, desc: '圆角墙角（建筑构件）。模型原尺寸 0.55×1.29×0.55 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.1, 2.58, 1.1] },
    { id: 'furn_wall_doorway', name: '墙(门洞)', url: 'placeholder', price: 48, desc: '墙(门洞)（建筑构件）。模型原尺寸 1.00×1.29×0.09 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [2, 2.58, 0.18] },
    { id: 'furn_wall_doorway_wide', name: '墙(宽门洞)', url: 'placeholder', price: 48, desc: '墙(宽门洞)（建筑构件）。模型原尺寸 1.00×1.29×0.09 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [2, 2.58, 0.18] },
    { id: 'furn_wall_half', name: '半墙', url: 'placeholder', price: 48, desc: '半墙（建筑构件）。模型原尺寸 0.50×1.29×0.05 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [1.0, 2.58, 0.1] },
    { id: 'furn_wall_window', name: '墙(窗)', url: 'placeholder', price: 48, desc: '墙(窗)（建筑构件）。模型原尺寸 1.00×1.29×0.09 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [2, 2.58, 0.18] },
    { id: 'furn_wall_window_slide', name: '墙(推拉窗)', url: 'placeholder', price: 48, desc: '墙(推拉窗)（建筑构件）。模型原尺寸 1.00×1.29×0.09 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [2, 2.58, 0.18] },
    { id: 'furn_washer', name: '洗衣机', url: 'placeholder', price: 85, desc: '洗衣机（洗衣）。模型原尺寸 0.39×0.47×0.39 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.78, 0.94, 0.78] },
    { id: 'furn_washer_dryer_stacked', name: '洗烘一体', url: 'placeholder', price: 100, desc: '洗烘一体（洗衣）。模型原尺寸 0.39×0.94×0.39 m，摆放时建议缩放 ×2。买 1 件得 1 个摆放额度。', kind: 'building', size: [0.78, 1.88, 0.78] },
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
// 一次性修复老数据：把「被弧度范围钳坏」的面光源俯仰角还原。
// 背景：sanitizeCombo 曾把 rotX 按弧度钳到 ±2π（≈±6.283），而客户端单位是**度** ——
//   编辑器存的 -90（朝下）被夹成 -6.283 度，摆出来就几乎水平（"面光源在家具里横转 90°"）。
// 判定必须极严格：只在数值**等于** ±2π 时动手（用户经 UI 设不出这种小数），且**保留正负号**
//   （+2π 说明原本是朝上的大角度 → 还原成 +90），其余一律不碰。跑一次打个 warn 日志。
(function repairClampedAreaPitch() {
  const EPS = 1e-6;
  let fixed = 0;
  for (const it of SHOP) {
    const ls = it && it.combo && Array.isArray(it.combo.lights) ? it.combo.lights : null;
    if (!ls) continue;
    for (const l of ls) {
      if (!l || l.type !== 'area') continue;
      const v = Number(l.rotX);
      if (!Number.isFinite(v)) continue;
      if (Math.abs(Math.abs(v) - Math.PI * 2) < EPS) { l.rotX = v < 0 ? -90 : 90; fixed++; }
    }
  }
  if (fixed) { saveShop(SHOP); console.warn('[relay] 修复了 ' + fixed + ' 个被弧度钳坏的面光源角度（rotX ±6.283° → ±90°）'); }
})();
// 确保「建造锤」在售（老 shop.json 已存在时不会自动带上新种子）
(function ensureHammer() {
  if (SHOP.some((x) => x.effect && x.effect.k === 'hammer')) return;
  const h = seedShop().find((x) => x.id === 'hammer');
  if (h) { SHOP.push(h); saveShop(SHOP); }
})();
// 已下架商品 id：老 shop.json 里仍留着它们（文件不会自己删条目），启动时剔掉并落盘。
// ⚠ 客户端 Shop.js 里有一份**同样**的 RETIRED_IDS 过滤 —— 两边都要有：服务端这份等 scp 才生效，
//   在那之前靠客户端那份先把已下架商品从店里藏掉。
const RETIRED_IDS = new Set(['flashlight']); // 手电筒：2026-10-07 按用户要求下架
(function retireShopItems() {
  const before = SHOP.length;
  SHOP = SHOP.filter((x) => x && !RETIRED_IDS.has(String(x.id)));
  if (SHOP.length !== before) saveShop(SHOP);
})();
// 确保「邀请传送」在售（老 shop.json 已存在时不会自动带上新种子）
(function ensureInviteTp() {
  if (SHOP.some((x) => x.id === 'invitetp')) return;
  const it = seedShop().find((x) => x.id === 'invitetp');
  if (it) { SHOP.push(it); saveShop(SHOP); }
})();
// 确保家具在售：老 shop.json 是文件为准的，新种子不会自动出现 —— 这里按 id 补齐缺失的。
(function ensureFurniture() {
  const seed = seedShop().filter((x) => x.kind === 'building');
  let added = 0, fixed = 0;
  for (const f of seed) {
    const cur = SHOP.find((x) => x.id === f.id);
    if (!cur) { SHOP.push({ ...f }); added++; continue; }
    let changed = false;
    // 价格上限：老占位家具曾定到 120/200，把它们拉回种子价（一律 ≤100）。
    // 只动超标的那条 —— 编辑器里手工改过的正常价格不该被每次启动冲掉。
    if (Number(cur.price) > 100) { cur.price = f.price; changed = true; }
    // 还是老「占位家具」文案的，顺手刷成真家具的名称/描述/尺寸。
    // 「建议缩放」也算陈旧：家具已改成统一基座 ×3 渲染（客户端 FURN_BASE_SCALE），
    //   描述里再写「摆放时建议缩放 ×2」会误导玩家去编辑里再调一次（变 6 倍），故一并刷新。
    if (String(cur.desc || '').includes('占位') || String(cur.desc || '').includes('建议缩放')) {
      cur.name = f.name; cur.desc = f.desc; cur.size = f.size; changed = true;
    }
    if (changed) fixed++;
  }
  if (added || fixed) { saveShop(SHOP); console.info('[relay] 家具上架：新增 ' + added + ' 件、校准 ' + fixed + ' 件'); }
})();
// 家具 url 自动对位：编辑器上传后的资源叫 import-<时间戳>-<原文件名>，
// 这里按「以 <id>.glb 结尾」在 assets 里找，把商品 url 指过去；没上传就保持 placeholder（显示占位方块）。
// 这样上传完重启一次服务端，家具就自动换上真模型，不用手改 140 条 url。
(function repairFurnitureUrls() {
  let fixed = 0;
  try {
    const files = fs.readdirSync(ASSETS_DIR);
    for (const it of SHOP) {
      if (!it || it.kind !== 'building') continue;
      if (!/^furn_/.test(String(it.id))) continue;
      const want = it.id + '.glb';
      const hit = files.find((f) => f === want || f.endsWith('-' + want));
      if (!hit) continue;
      const url = '/assets/' + hit;
      if (it.url !== url) { it.url = url; fixed++; }
    }
  } catch (e) { /* assets 目录还不存在：一件都没上传过，保持 placeholder */ }
  if (fixed) { saveShop(SHOP); console.info('[relay] 家具 url 对位：' + fixed + ' 件指向已上传模型'); }
})();
// 老数据的 rotY 修一次：build_add/build_move 曾把「度」按 ±4π（≈±12.566）的**弧度**范围钳制，
// 所以任何大于 12.566 度的角度都被夹成正好 4π —— 客户端读回去除以 DEG 就是「720°」。
// 这里只认「恰好等于 ±4π」这个钳制边界值（正常玩家几乎不可能转出这么整的数），归零即可。
(function repairBuildRot() {
  let fixed = 0;
  try {
    const list = loadBuildings();
    for (const b of list) {
      if (!b) continue;
      const n = Number(b.rotY);
      if (!Number.isFinite(n)) continue;
      if (Math.abs(Math.abs(n) - Math.PI * 4) < 1e-6) { b.rotY = 0; fixed++; }
      else if (n < 0 || n >= 360) { b.rotY = ((n % 360) + 360) % 360; fixed++; }
    }
    if (fixed) { saveBuildings(list); console.info('[relay] 摆放角度修复：' + fixed + ' 条（旧的 ±4π 弧度钳制残留）'); }
  } catch (e) { /* 没数据文件就算了 */ }
})();
// 组合家具的部件 / 灯光消毒：只放行已知字段并逐项钳制（防脏数据 / 超大对象）
// ⚠⚠ 单位：客户端的 rotY/rotX 一律是**度**（不是弧度）—— 早先这里按弧度写了钳制范围
//   （±2π ≈ ±6.28），结果编辑器存进去的 rotX = -90（朝下照）被夹成 **-6.28 度**，
//   读回来几乎水平 —— 这就是「面光源在家具里横着转了 90°」。同理 rotY 只能转 ±12.6°。
//   现在统一按度钳制到 ±360（允许多圈，负数合法）。
const DEG_LO = -360;
const DEG_HI = 360;
// 摆放物件的 rotY：**度**，归一化到 [0,360) 后落盘。
// ⚠ 这里原来写成按弧度钳到 ±4π（≈±12.57），于是玩家转个 90° 存进去被夹成 12.57°，
//   客户端一读就是「角度跳到 720°」（12.566 / (π/180) = 720），且再也转不动。
function normDeg(v, d) {
  const n = Number(v);
  if (!Number.isFinite(n)) return d;
  return ((n % 360) + 360) % 360;
}
const AREA_ROTX_DEFAULT = -90; // 与前端 Lights.AREA_LIGHT_DEFAULTS.rotX 保持一致
const AREA_DISTANCE_DEFAULT = 14; // 与前端 AREA_SHADOW_DISTANCE 保持一致
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
        // 部件的 rotY 也是度（前端 buildComboProto: m.rotation.y = rotY * DEG）
        rotY: num(p.rotY, 0, DEG_LO, DEG_HI),
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
        // 朝向是度：rotX 负值朝下，缺省 -90（吸顶灯）。⚠ 绝不能用弧度范围钳制（会把 -90 夹成 -6.28）
        o.rotY = num(l.rotY, 0, DEG_LO, DEG_HI);
        o.rotX = num(l.rotX, AREA_ROTX_DEFAULT, DEG_LO, DEG_HI);
        // 面光源自己没有 distance，这个只作用于阴影代理（照射范围 + 阴影贴图 far）。
        // ⚠ 早期这里**根本没放行 distance** —— 编辑器里调好存上去，服务端一消毒就丢了，
        //   家具摆出来永远是默认 14 米（等于白调）。
        o.distance = num(l.distance, AREA_DISTANCE_DEFAULT, 0, 400);
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

// ---- 兑换码（服务端权威）----
// 为什么搬到这里：以前码表写死在客户端 Config.REDEEM_CODES 里 —— 谁都能从 JS 里翻出来，
// 而且「兑换过没有」只存在玩家自己的 localStorage，清一次缓存就能重复领。
// 现在：码表在 data/redeem-codes.json（编辑器在线改），兑换记录在 data/redeems.json（按身份记账），
// 客户端只拿到「这次该发多少学币」，码表本身不再下发。
//
// redeem-codes.json: [{ code, value, note, limit, disabled }]
//   code    —— 小写字母/数字/_/-，比较时统一小写去空格
//   value   —— 兑换成功发放的学币
//   limit   —— 总使用次数上限（0 = 不限）
//   disabled—— 停用（保留记录但不可兑换）
// redeems.json: { "<ownerKey>": ["code", ...] }（ownerKey 与建造归属同一套：登录 u:<id> / 游客 anon:<ip>）
const DEFAULT_CODES = [
  { code: 'huacaozhongxue', value: 4000, note: '花草中学（默认种子）', limit: 0, disabled: false },
];
function normalizeCode(c) { return String(c || '').trim().toLowerCase().replace(/\s+/g, ''); }
function sanitizeCodeRec(c) {
  if (!c) return null;
  const code = normalizeCode(c.code);
  if (!/^[a-z0-9_-]{1,32}$/.test(code)) return null; // 非法码直接丢弃（防脏数据）
  return {
    code,
    value: Math.max(0, Math.min(1000000, Math.floor(Number(c.value) || 0))),
    note: String(c.note || '').slice(0, 60),
    limit: Math.max(0, Math.min(100000, Math.floor(Number(c.limit) || 0))),
    disabled: !!c.disabled,
  };
}
function loadCodes() {
  try {
    const a = JSON.parse(fs.readFileSync(CODES_FILE, 'utf8'));
    if (Array.isArray(a)) {
      const list = a.map(sanitizeCodeRec).filter(Boolean);
      if (list.length) return list;
    }
  } catch (e) { /* 没配过 → 用默认种子 */ }
  // 首次启动：落一份种子文件，之后以文件为准
  const seed = DEFAULT_CODES.map((x) => ({ ...x }));
  try { fs.writeFileSync(CODES_FILE, JSON.stringify(seed, null, 2)); } catch (e) { /* ignore */ }
  return seed;
}
function saveCodes(list) { fs.writeFileSync(CODES_FILE, JSON.stringify(list, null, 2)); }
function loadRedeemLog() {
  try {
    const o = JSON.parse(fs.readFileSync(REDEEM_LOG_FILE, 'utf8'));
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  } catch (e) { return {}; }
}
function saveRedeemLog(log) { fs.writeFileSync(REDEEM_LOG_FILE, JSON.stringify(log, null, 2)); }

let CODES = loadCodes();

// 码表 + 每个码已被多少人兑换（编辑器列表要显示用量，方便判断限量码还剩多少）
function codesPayload() {
  const uses = Object.create(null);
  for (const arr of Object.values(loadRedeemLog())) {
    if (!Array.isArray(arr)) continue;
    for (const c of arr) uses[c] = (uses[c] || 0) + 1;
  }
  return CODES.map((c) => ({ ...c, uses: uses[c.code] || 0 }));
}

// 兑换核心：校验码表 → 查该身份是否兑过 / 是否超总上限 → 记账。返回 {ok:true,value} 或 {ok:false,error}
function doRedeem(ownerKey, rawCode) {
  const code = normalizeCode(rawCode);
  if (!code) return { ok: false, error: '请输入兑换码' };
  const rec = CODES.find((c) => c.code === code);
  if (!rec) return { ok: false, error: '兑换码无效' };
  if (rec.disabled) return { ok: false, error: '这个兑换码已停用' };
  const log = loadRedeemLog();
  const mine = Array.isArray(log[ownerKey]) ? log[ownerKey] : [];
  if (mine.includes(code)) return { ok: false, error: '这个兑换码已经兑换过了' };
  if (rec.limit > 0) {
    let used = 0;
    for (const arr of Object.values(log)) if (Array.isArray(arr) && arr.includes(code)) used++;
    if (used >= rec.limit) return { ok: false, error: '这个兑换码已经被领完了' };
  }
  mine.push(code);
  log[ownerKey] = mine;
  saveRedeemLog(log);
  return { ok: true, value: rec.value, code };
}

// HTTP 侧的归属键：登录 token → u:<userId>；否则游客 anon:<真实 IP>（与 WS 的 ownerKeyOf 同规则）
function ownerKeyOfReq(req) {
  let pub = null;
  try {
    const h = req.headers.authorization || '';
    const tok = typeof h === 'string' && h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    if (tok) pub = auth.getPublicByToken(tok);
  } catch (e) { /* 鉴权异常按游客处理 */ }
  if (pub && pub.userId) return 'u:' + pub.userId;
  return 'anon:' + (clientIpOf(req) || 'unknown');
}

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
// 数据采集上报清洗：客户端提交的字段逐项钳制，遏制脏数据/超大对象。
// ⚠ 客户端是公开静态页、可被伪造，所以这里**白名单 + 限长 + 数值钳制**，不信任任何字段。
function sanitizeTelemetry(raw, ip) {
  const n = (v, lo, hi) => {
    const x = Number(v);
    return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : null;
  };
  const str = (v, max) => String(v == null ? '' : v).slice(0, max);
  const r = raw.render && typeof raw.render === 'object' ? raw.render : {};
  const d = raw.device && typeof raw.device === 'object' ? raw.device : {};
  const ph = raw.phases && typeof raw.phases === 'object' ? raw.phases : {};
  const phases = {};
  // 加载阶段：只放行已知键，值钳到 [0, 600000] ms
  for (const k of ['boot', 'authDone', 'gameStart', 'waitStart', 'sceneReady', 'welcomeReady', 'assetsDone', 'assetsSkipped', 'assetsTimeout', 'enter']) {
    if (ph[k] != null) phases[k] = n(ph[k], 0, 600000);
  }
  return {
    id: 't_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
    serverTs: Date.now(),
    ip: str(ip, 64),                    // 真实 IP（走反代取 XFF），仅用于粗分设备来源
    kind: str(raw.kind || 'perf', 16),
    v: n(raw.v, 0, 99),
    phases,
    render: {
      frames: n(r.frames, 0, 1e7),
      avgFps: n(r.avgFps, 0, 1000),
      low1Fps: n(r.low1Fps, 0, 1000),
      p50Ms: n(r.p50Ms, 0, 60000),
      p95Ms: n(r.p95Ms, 0, 60000),
      maxMs: n(r.maxMs, 0, 60000),
      jankPct: n(r.jankPct, 0, 100),
      avgCalls: n(r.avgCalls, 0, 1e6),
      avgTris: n(r.avgTris, 0, 1e9),
      avgScale: n(r.avgScale, 0, 4),
    },
    device: {
      ua: str(d.ua, 300),
      platform: str(d.platform, 48),
      lang: str(d.lang, 24),
      cores: n(d.cores, 0, 256),
      memGB: n(d.memGB, 0, 1024),
      dpr: n(d.dpr, 0, 16),
      screen: str(d.screen, 24),
      msaa: !!d.msaa,
    },
    ctx: {
      renderScale: n(raw.renderScale, 0, 4),
      shadow: !!raw.shadow,
      quality: str(raw.quality, 16),
      gpu: str(raw.gpu, 160),
      colliders: n(raw.colliders, 0, 1e6),
      players: n(raw.players, 0, 1024),
      msaa: !!raw.msaa,
    },
  };
}

// 向所有在线客户端广播（建造是全局的，不分房间）
// except：要跳过的一个连接（同一个学生的话，发起者自己已经收到 npc_reply 了，
// 再广播一次 npc_say 会让他看到**两遍**同样的内容）。
function broadcastAll(msg, except) {
  const raw = JSON.stringify(msg);
  for (const c of wss.clients) {
    if (c === except) continue;
    if (c.readyState === WebSocket.OPEN) c.send(raw);
  }
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

  // 学生 NPC 的功能区标注：读公开（客户端要知道去哪找人），写需要管理员密钥
  if (url.pathname === '/api/zones') {
    if (req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, zones: npcWorld ? npcWorld.getZones() : [] }));
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { if ((body += chunk).length > 1e5) req.destroy(); });
      req.on('end', () => {
        const deny = (m, code = 400) => {
          res.writeHead(code, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: m }));
        };
        let data;
        try { data = JSON.parse(body || '{}'); } catch (e) { return deny('bad json'); }
        // 写接口一律要密钥：和 /api/scene、/api/buildareas 同一套路
        if (String(data.token || '') !== SHOP_ADMIN_TOKEN) return deny('管理员密钥错误', 403);
        const zones = npcWorld ? npcWorld.setZones(data.zones) : [];
        broadcastAll({ t: 'npc_zones', zones }); // 在线客户端即时换目标
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, zones }));
      });
      return;
    }
  }

  // ---- 学生策略网络：投喂接口（阶段2~5 的人投喂数据 + 训练好的模型上传）----
  // 投喂数据：把 CSV/JSON 落到 data/feed/（训练在本地跑 train.py，不需要服务器有 Python）。
  if (req.method === 'POST' && url.pathname === '/api/npc/feed') {
    let body = '';
    req.on('data', (chunk) => { if ((body += chunk).length > 2e6) req.destroy(); });
    req.on('end', () => {
      const deny = (m, code = 400) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: m })); };
      let data;
      try { data = JSON.parse(body || '{}'); } catch (e) { return deny('bad json'); }
      if (String(data.token || '') !== SHOP_ADMIN_TOKEN) return deny('管理员密钥错误', 403);
      const name = String(data.name || 'feed.csv').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40);
      const text = String(data.text || '');
      if (!text) return deny('empty');
      try {
        fs.mkdirSync(path.join(DATA_DIR, 'feed'), { recursive: true });
        fs.writeFileSync(path.join(DATA_DIR, 'feed', name), text);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, saved: name }));
      } catch (e) { deny(String(e && e.message || e), 500); }
    });
    return;
  }
  // 上传训练好的模型（本地 train.py 产出的 campus_policy.json）；也可直接 scp 到 data/。
  if (req.method === 'POST' && url.pathname === '/api/npc/policy') {
    let body = '';
    req.on('data', (chunk) => { if ((body += chunk).length > 5e6) req.destroy(); });
    req.on('end', () => {
      const deny = (m, code = 400) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: m })); };
      try {
        const json = JSON.parse(body || '{}');
        if (!json || !Array.isArray(json.weights) || !Array.isArray(json.actions)) return deny('bad model');
        fs.writeFileSync(path.join(DATA_DIR, 'campus_policy.json'), JSON.stringify(json));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, meta: json.meta || {} }));
      } catch (e) { deny(String(e && e.message || e), 500); }
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/npc/policy') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, status: npcWorld ? npcWorld.loadPolicyStatus() : { ready: false } }));
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
    // 鉴权：**写**场景/地图必须带管理员密钥（读 /api/scene 仍公开 —— 游戏客户端要拉场景）。
    // 之前这里是裸的：进门密码门只是个 UI 遮罩，删掉遮罩就能直接 POST 覆盖整个场景（"删了就露馅"）。
    if (String(req.headers['x-shop-token'] || '') !== SHOP_ADMIN_TOKEN) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '管理员密钥错误' }));
      req.resume(); // 排空请求体，否则连接可能被 reset，客户端就读不到 403 了
      return;
    }
    let body = '';
    req.on('data', (chunk) => { if ((body += chunk).length > 8e6) req.destroy(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        // 统一写入 data/ 下 JSON（本后端为跨端共用的场景/地图数据源）
        const target = url.pathname === '/api/scene' ? SCENE_FILE : MAP_FILE;
        fs.writeFileSync(target, JSON.stringify(data, null, 2));
        // 场景刚落盘：立刻重读障碍表，学生的绕障不用等下一轮定时（也不用重启）
        if (npcWorld && target === SCENE_FILE) npcWorld.refreshObstacles();

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
    // 上传也是写接口：同样要管理员密钥，否则任何人都能往 assets 里塞文件。
    if (String(req.headers['x-shop-token'] || '') !== SHOP_ADMIN_TOKEN) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '管理员密钥错误' }));
      req.resume();
      return;
    }
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

  // 兑换码：管理员读/改（需密钥）。op: list（默认）| set | del | reset
  // 返回的都是「码表 + 每个码已兑换人数」，编辑器据此渲染列表。
  if (req.method === 'POST' && url.pathname === '/api/codes') {
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
      const op = String(data.op || 'list');
      if (op === 'set') {
        const rec = sanitizeCodeRec(data);
        if (!rec) return bad('兑换码只能用字母/数字/_/-（≤32 位）');
        const i = CODES.findIndex((c) => c.code === rec.code);
        if (i >= 0) CODES[i] = rec; else CODES.push(rec);
        saveCodes(CODES);
      } else if (op === 'del') {
        const code = normalizeCode(data.code);
        if (!code) return bad('缺少 code');
        CODES = CODES.filter((c) => c.code !== code);
        saveCodes(CODES);
      } else if (op === 'reset') {
        CODES = DEFAULT_CODES.map((x) => ({ ...x }));
        saveCodes(CODES);
      } else if (op !== 'list') {
        return bad('未知 op');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, codes: codesPayload() }));
    });
    return;
  }

  // 管理员密钥校验（编辑器「进门密码」用）。只回 ok，不泄露密钥本身。
  if (req.method === 'POST' && url.pathname === '/api/admin/verify') {
    let body = '';
    req.on('data', (chunk) => { if ((body += chunk).length > 1e4) req.destroy(); });
    req.on('end', () => {
      let data = {};
      try { data = JSON.parse(body || '{}'); } catch (e) { data = {}; }
      const ok = !!data.token && String(data.token) === SHOP_ADMIN_TOKEN;
      res.writeHead(ok ? 200 : 403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok }));
    });
    return;
  }

  // 兑换码：玩家兑换（公开）。服务端校验 + 记账（防清本地缓存重复领 / 防限量码超发），
  // 只回「该发多少学币」，学币由客户端入账并随账号存档上云。
  if (req.method === 'POST' && url.pathname === '/api/redeem') {
    let body = '';
    req.on('data', (chunk) => { if ((body += chunk).length > 1e4) req.destroy(); });
    req.on('end', () => {
      let data = {};
      try { data = JSON.parse(body || '{}'); } catch (e) { data = {}; }
      const r = doRedeem(ownerKeyOfReq(req), data.code);
      res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r.ok ? { ok: true, value: r.value } : { ok: false, error: r.error }));
    });
    return;
  }

  // 数据采集上报（公开）：客户端测完帧率把「加载耗时 + 渲染指标 + 设备信息」POST 上来，
  // 服务端清洗 + 限量 + 按行追加到 data/telemetry.jsonl（每行一条 JSON，便于后续 grep/分析）。
  // 设计：
  //   · 只收少量聚合字段，逐项钳制数值范围、字符串限长 —— 客户端是公开静态页，不可信；
  //   · 体积硬上限（16KB）防超大包；每真实 IP 30 秒最多 1 条，防刷；
  //   · 用真实 IP（clientIpOf，走反向代理的 X-Forwarded-For），不用 socket.remoteAddress。
  if (req.method === 'POST' && url.pathname === '/api/telemetry') {
    let body = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 16 * 1024) { tooBig = true; req.destroy(); }
    });
    req.on('end', () => {
      if (tooBig) return;
      const ip = clientIpOf(req);
      const now = Date.now();
      // 限流：同 IP 30 秒 1 条（内存表，够用；进程重启即清空）
      const last = TELEMETRY_LAST.get(ip) || 0;
      if (now - last < 30000) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '上报太频繁，请稍后再试' }));
        return;
      }
      let data = null;
      try { data = JSON.parse(body || '{}'); } catch (e) { data = null; }
      if (!data || typeof data !== 'object') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'bad json' }));
        return;
      }
      TELEMETRY_LAST.set(ip, now);
      const rec = sanitizeTelemetry(data, ip);
      try {
        fs.appendFileSync(TELEMETRY_FILE, JSON.stringify(rec) + '\n');
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id: rec.id }));
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
  // 学生 NPC 名单：名字/班级/当前位置。位置之后由 5Hz 的 npc 广播持续更新。
  if (npcWorld) ws.send(JSON.stringify({ t: 'npc_roster', list: npcWorld.roster() }));
  // 建造归属键：客户端据此判断「这条家具是不是我摆的」（跨设备/清缓存也准，比本地记录可靠）
  ws.send(JSON.stringify({ t: 'build', ev: 'owner', key: ownerKeyOf(ws) }));
  // 有人刚进来 → 丢掉快照 delta 缓存，让下一帧对所有人发一次全量。
  // 否则新玩家在两次"兜底全量"之间看到的老玩家可能缺 nick/color 这类静态字段。
  invalidateSnapshotDelta();

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

    // 和学生说话：服务端带人设/记忆调 GLM，回话同时广播给所有人（旁边的人也能听见）
    if (msg.t === 'npc_talk') {
      if (!npcWorld) return;
      const sid = String(msg.id || '');
      const text = String(msg.text || '').slice(0, 200);
      if (!sid || !text) return;
      const nick = (ws.__profile && (ws.__profile.nickname || ws.__profile.username)) || (states.get(id) && states.get(id).nick) || '同学';
      // 同一个学生同时只处理一句（AI 有冷却，并发多了会撞免费档限流）
      npcWorld.talk(sid, text, String(nick).slice(0, 16), ws)
        .then((out) => {
          // ⚠ 只回发起者（其他人由 npcWorld 里的 npc_say 广播拿到），否则发起者会看到两遍
          if (!out || !out.say) return;
          ws.send(JSON.stringify({ t: 'npc_reply', id: sid, say: out.say }));
        })
        .catch((e) => {
          // 绝不静默吞掉（记忆第 1 条）：AI 挂了要能在日志里看见，否则只表现为"他没理我"
          console.warn('[npc] 搭话失败 ' + sid + '：' + (e && e.message ? e.message : e));
        });
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

    // 邀请传送：把邀请转发给**目标玩家**（带上邀请者的坐标，钳制后转发）。
    // 与 ctrl 同一套目标定向转发：服务端只做白名单中继，不校验玩法规则；
    // 真正「传送到哪」由接受方的客户端自己执行（位置由各客户端自己拥有）。
    if (msg.t === 'tp_invite') {
      const target = String(msg.target || '');
      if (!target || target === id) return;
      const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
      const out = {
        t: 'tp_invite', from: id,
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

    // 邀请传送的回复（接受/拒绝）：转发回发起邀请的那个人，让他知道对方点没点同意
    if (msg.t === 'tp_reply') {
      const target = String(msg.target || '');
      if (!target || target === id) return;
      const raw = JSON.stringify({ t: 'tp_reply', from: id, ok: msg.ok ? 1 : 0 });
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
        rotY: normDeg(msg.rotY, 0),
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
      rec.rotY = normDeg(msg.rotY, rec.rotY);
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

    // 把当前所有玩家的坐标喂给 NPC 世界（playerNear 特征用；没有 NPC 世界时跳过）
    if (npcWorld && npcWorld.setPlayerPositions) {
      const arr = [];
      for (const s of states.values()) {
        if (Number.isFinite(Number(s.x)) && Number.isFinite(Number(s.z))) arr.push({ x: Number(s.x), z: Number(s.z) });
      }
      npcWorld.setPlayerPositions(arr);
    }

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
// 一昼夜对应的真实秒数（10 分钟）。**这里是权威**：快照把这个时刻发给所有客户端，
// 客户端只做帧间外推。⚠ 必须与客户端 src/core/Game.js 的 Game.SYNC_DAY_SECONDS 一致 ——
// 两边不一致时，客户端每收到一次快照就会被拉回去，表现为世界时间忽快忽慢地"抖"。
const DAY_SECONDS = 600;

// ===========================================================================
// 快照增量压缩（delta）—— 只发**变了的字段**
// ---------------------------------------------------------------------------
// 背景（实测）：8 人快照 1406 字节，其中
//   · nick / color / room / num 占 31%，这些字段**一辈子都不变**，每帧重发纯属浪费
//   · hold / wep / veh 常态是 null，每帧再占约 20%
// 20Hz 下这是每人 549KB/20 秒的下行。手机上行下行都贵，弱网更明显。
//
// 为什么**不用改客户端、不用版本协商**：客户端 PlayerState.fromJSON 的写法是
//   `if (data.x !== undefined) this.x = data.x;`  —— 缺字段 = 保持旧值。
//   所以"省略没变的字段"对**旧客户端天然安全**，服务端单方面上就够了。
//
// 两条兜底：
//   ① 每 FULL_SNAPSHOT_EVERY 帧发一次全量（防长期省略后客户端状态漂移）；
//   ② 有新连接进来时清掉缓存 → 下一帧所有人全量一次，保证新玩家立刻拿到 nick/color。
// ===========================================================================
const FULL_SNAPSHOT_EVERY = 40;          // 40 帧 = 2 秒兜底全量一次
const _lastSent = new Map();             // 玩家 id → 上一帧发出去的那份字段对象
let _snapSeq = 0;

// 把本帧的完整玩家列表压成"只含变化字段"的列表。
// 自检 tools/probe-snapshot-delta.mjs 用**锚点抽取**在 Node 里跑它 —— 不 import 本文件
// （import 会真的 bind 端口起服务），也**不复制一份逻辑**（复制品必然漂移）。
function diffSnapshotPlayers(list, forceFull) {
  _snapSeq++;
  const full = !!forceFull || (_snapSeq % FULL_SNAPSHOT_EVERY) === 0;
  const out = [];
  for (const p of list) {
    const prev = _lastSent.get(p.id);
    const o = { id: p.id }; // id 必须每帧都发：客户端靠它认人
    if (full || !prev) {
      for (const k in p) if (k !== 'id') o[k] = p[k];
    } else {
      for (const k in p) {
        if (k === 'id') continue;
        if (prev[k] !== p[k]) o[k] = p[k];
      }
    }
    _lastSent.set(p.id, p);
    out.push(o);
  }
  // 清掉已离线玩家的缓存，避免 Map 随"来过的人"无限增长
  if (_lastSent.size > list.length) {
    const alive = new Set();
    for (const p of list) alive.add(p.id);
    for (const k of _lastSent.keys()) if (!alive.has(k)) _lastSent.delete(k);
  }
  return out;
}

// 新连接进来 / 玩家换房时调用：丢掉缓存，让下一帧全量一次。
function invalidateSnapshotDelta() { _lastSent.clear(); }

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
  // 全量/增量是**整帧**的决定（不能按房间各自算，否则 same 玩家在不同房间里字段会互相矛盾）
  const forceFull = (_snapSeq + 1) % FULL_SNAPSHOT_EVERY === 0;
  const slim = diffSnapshotPlayers(list, forceFull);
  const byId = new Map();
  for (const p of slim) byId.set(p.id, p);
  // 时间戳量化到 6 位小数：dayTime 是长浮点，全精度要 18 字节，这里砍掉一半
  const t = Math.round(dayTime * 1e6) / 1e6;
  for (const [r, players] of byRoom) {
    const out = players.map((p) => byId.get(p.id) || { id: p.id });
    roomBroadcast(r, { t: 'snapshot', players: out, time: t });
  }
}, SNAPSHOT_INTERVAL);

// 匹配轮询：单人苦等超时也放单人也开（练习场），避免永远卡在队列里
setInterval(tryMatch, 1000);

// ---- 学生 NPC 世界：在这里初始化（上面的 dayTime 已声明，getDayTime 才能安全取值）----
// 没标注功能区时学生原地待命（不会乱走穿墙），编辑器「区域」页签标好即自动开跑。
npcWorld = createNpcWorld({
  dataDir: DATA_DIR,
  broadcast: broadcastAll,
  getDayTime: () => (typeof dayTime === 'number' ? dayTime : 0.35), // 课程表跟世界时刻走
  askStudent,
});
console.info('[relay] 学生 NPC：' + npcWorld.roster().length + ' 名，功能区 ' + npcWorld.getZones().length + ' 个');

console.log(`relay server listening at http://0.0.0.0:${PORT} (ws://<ip>:${PORT}), data dir: ${DATA_DIR}`);