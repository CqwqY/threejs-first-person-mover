// 职责：WebSocket 中继服务器，只负责连接管理、状态存储转发与周期快照广播，不做物理/碰撞/校验。
import { WebSocketServer } from 'ws';

const PORT = 8080; // 服务监听端口
const SNAPSHOT_INTERVAL = 50; // 快照广播间隔（毫秒），对应 20Hz
const HEARTBEAT_INTERVAL = 30000; // 心跳间隔（毫秒），防止连接被中间层断开

const wss = new WebSocketServer({ port: PORT });

// id -> lastState（{x,y,z,yaw}）的玩家表；首次上报前为占位
const players = new Map();

let nextId = 1;
// 自增 id，保证同一进程内唯一
function newId() {
  return 'id_' + nextId++;
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

// 收集所有（id, 非空 state）列表，用于 welcome / snapshot
function worldPlayers() {
  return [...players.entries()]
    .filter(([, st]) => st !== null)
    .map(([pid, st]) => ({ id: pid, ...st }));
}

wss.on('connection', (ws) => {
  const id = newId();
  players.set(id, null); // 先占位，等客户端首次上报状态

  // welcome：告知新客户端自己的 id，以及当前已存在的玩家
  const existing = worldPlayers().filter((p) => p.id !== id);
  ws.send(JSON.stringify({ t: 'welcome', id, players: existing }));

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return; // 非 JSON 忽略
    }
    if (!msg || msg.t !== 'state') return;

    const isFresh = players.get(id) === null; // 是否第一次上报
    players.set(id, { x: msg.x, y: msg.y, z: msg.z, yaw: msg.yaw });

    if (isFresh) {
      // 新玩家首次上报：把 join 广播给其他人
      for (const client of wss.clients) {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ t: 'join', id, state: players.get(id) }));
        }
      }
    }
  });

  ws.on('close', () => {
    players.delete(id);
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