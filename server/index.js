// 职责：WebSocket 中继服务器，负责连接管理、状态转发、出生点分配与周期快照广播，不做物理/碰撞/校验。
import { WebSocketServer } from 'ws';

const PORT = 8080; // 服务监听端口
const SNAPSHOT_INTERVAL = 50; // 快照广播间隔（毫秒），对应 20Hz
const HEARTBEAT_INTERVAL = 30000; // 心跳间隔（毫秒），防止连接被中间层断开
const SPAWN_RADIUS = 4; // 出生点离原点距离（米）
const SPAWN_ANGLE_STEP = Math.PI / 2; // 每个玩家出生点在圆周上的夹角间隔（90°）

const wss = new WebSocketServer({ port: PORT });

// id -> 已上报状态 {num, x, y, z, yaw}
const states = new Map();
// id -> 出生点 {x, z, yaw}
const spawns = new Map();

let nextId = 1;
let numCounter = 0;

// 自增 id，确保同一进程内唯一
function newId() {
  return 'id_' + nextId++;
}

// 根据加入序号计算圆周上散布的出生点，让玩家彼此可见、不重叠在原点
function spawnForNum(num) {
  const angle = (num - 1) * SPAWN_ANGLE_STEP;
  const x = Math.cos(angle) * SPAWN_RADIUS;
  const z = Math.sin(angle) * SPAWN_RADIUS;
  // 让玩家面朝原点（相机前方 = (-sin yaw, -cos yaw) 指向中心）
  const yaw = Math.atan2(x, z);
  return { x, z, yaw };
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
  numCounter++;
  const num = numCounter; // 玩家加入序号（1 开始，用于头顶标记）
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

console.log(`relay server listening on ws://localhost:${PORT}`);