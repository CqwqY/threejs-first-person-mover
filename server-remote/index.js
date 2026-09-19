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

const PORT = 9000; // 服务监听端口
const SNAPSHOT_INTERVAL = 50; // 快照广播间隔（毫秒），对应 20Hz
const HEARTBEAT_INTERVAL = 30000; // 心跳间隔（毫秒），防止连接被中间层断开
const SPAWN_RADIUS = 4; // 出生点离原点距离（米）
const SPAWN_ANGLE_STEP = Math.PI / 2; // 每个玩家出生点在圆周上的夹角间隔（90°）

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
const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-filename');

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

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

const wss = new WebSocketServer({ server: httpServer });
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

// 向所有已连接客户端广播一条 JSON 消息
function broadcast(msg) {
  const raw = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(raw);
    }
  }
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
  }));
}

wss.on('connection', (ws) => {
  const id = newId();
  const num = allocNum(); // 复用最小空闲编号，避免重连把数字推到几十
  const spawn = spawnForNum(num);
  spawns.set(id, spawn);

  // welcome：告知新客户端自己的 id/序号/出生点，以及当前已有玩家
  const existing = worldPlayers().filter((p) => p.id !== id);
  ws.send(JSON.stringify({ t: 'welcome', id, num, spawn, players: existing }));

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return; // 非 JSON 忽略
    }
    if (!msg || msg.t !== 'state') return;

    const isFresh = !states.has(id); // 是否第一次上报（用于 join 广播）
    states.set(id, { num, x: msg.x, y: msg.y, z: msg.z, yaw: msg.yaw });

    if (isFresh) {
      // 新玩家首次上报：把 join（含序号与状态）广播给其他人
      for (const client of wss.clients) {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ t: 'join', id, state: states.get(id) }));
        }
      }
    }
  });

  ws.on('close', () => {
    states.delete(id);
    spawns.delete(id);
    freeNum(num); // 释放编号，供后续玩家复用
    // 通知所有人该玩家离开
    broadcast({ t: 'leave', id });
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

// 周期广播所有玩家状态（20Hz）
setInterval(() => {
  const list = worldPlayers();
  if (list.length > 0) {
    broadcast({ t: 'snapshot', players: list });
  }
}, SNAPSHOT_INTERVAL);

console.log(`relay server listening at http://0.0.0.0:${PORT} (ws://<ip>:${PORT}), data dir: ${DATA_DIR}`);