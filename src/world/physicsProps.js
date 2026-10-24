// 物理可交互物（P0）：轻量刚体管理。
//
// 底座 = 项目已有的球体积分器 moveSphereWorld（worldQuery.js:514）：
//   重力 / 恢复系数 / 摩擦 / 子步 / trimesh·盒·凸包全碰撞 / 隐式地面。
// 本项目**没有**物理引擎（deps 只有 three + vhacd-js），也不要引——50ms 帧里 44ms 是像素着色。
//
// 多人模型（沿用 drop / meteor 的既有契约）：
//   服务器不模拟，只把「spawn / hit / state / gone」钳制后转发；
//   初始布局靠「同场景 + 同种子 + 同探测顺序」在两端各自生成完全一致的结果，**不同步初始位置**。
//   ⚠ moveSphereWorld 按 dt 积分 ⇒ 各端帧率不同必然漂移，所以运动中的体要由 owner 以 10Hz 广播 state 校正。
import * as THREE from 'three';
import { Config } from '../config.js';
import { moveSphereWorld, raycastWorld, sphereWorldMTV } from '../world/collision/worldQuery.js';
import { PROP_KINDS, resolveKind } from './props/defs.js';
import { buildSoccerBallGeometry } from './props/soccerBall.js';
import { P0_ZONES, PROP_SEED, mulberry32, trackDistance } from './props/layout.js';

const GRAVITY = -24;

export class PhysicsProps {
  constructor(scene, colliders, net) {
    this.scene = scene;
    this.colliders = colliders;
    this.net = net;
    this.bodies = [];
    this.pads = [];
    this.enabled = true;
    this.spawned = 0;
    this._geo = new Map();   // kind → 共享 geometry
    this._mat = new Map();   // kind → 共享 material
    this._netAcc = 0;
    this._seq = 0;
    this._bounds = null;
    this._zonesStat = [];
    this.localId = '';   // 本地玩家 id（由 Game 在 welcome 后注入）
    this.ridingBall = null; // 本地玩家正「锁在里面」的那颗球（仓鼠球模式）
  }

  setLocalId(id) {
    this.localId = String(id || '');
  }

  // 生成全部 P0 布局。opts: { spawn:{x,z}, track:{checkpoints}, boundary }
  buildLayout(opts) {
    const o = opts || {};
    this._bounds = o.boundary || null;
    const cps = (o.track && o.track.checkpoints) || [];
    const spawn = o.spawn || { x: 0, z: 0 };
    const rnd = mulberry32(PROP_SEED);
    this._zonesStat = [];

    for (const zone of P0_ZONES) {
      for (const item of zone.items) {
        if (!item || !(item.n > 0)) continue;
        const kind = resolveKind(item.kind);
        if (!kind) continue;
        let got = 0;
        if (kind === 'block') {
          got = this._placeRows(zone, kind, item.n, rnd, spawn, cps);
        } else {
          for (let i = 0; i < item.n; i++) {
            const p = this._pickSpot(zone, kind, rnd, spawn, cps);
            if (!p) continue;
            this._create(kind, p.x, p.y, p.z, `${zone.id}-${kind}-${i}`);
            got++;
          }
        }
        this._zonesStat.push({ zone: zone.id, kind, got, want: item.n });
      }
    }
    return this._zonesStat;
  }

  // 积木摆成多米诺：按排切分，每排最多 5 块，间距略大于直径（静止不接触，被撞就连锁）
  _placeRows(zone, kind, total, rnd, spawn, cps) {
    const def = PROP_KINDS[kind];
    const perRow = 5;
    const gap = def.r * 2 + 0.03;
    let placed = 0;
    let guard = 0;
    while (placed < total && guard < 40) {
      guard++;
      // 至少留 2 个空位才开新排
      const rowsLeft = Math.ceil((total - placed) / perRow);
      const p = this._pickSpot(zone, kind, rnd, spawn, cps);
      if (!p) continue;
      const ang = rnd() * Math.PI * 2;
      const dx = Math.cos(ang) * gap;
      const dz = Math.sin(ang) * gap;
      const count = Math.min(perRow, total - placed);
      let rowPlaced = 0;
      for (let i = 0; i < count; i++) {
        const x = p.x + dx * i;
        const z = p.z + dz * i;
        if (!this._spotOk(x, z, def.r, spawn, cps)) break;
        const y = this._floorAt(x, z);
        if (y === null) break;
        this._create(kind, x, y + def.r + 0.02, z, `${zone.id}-${kind}-${placed}`);
        placed++;
        rowPlaced++;
      }
      if (rowPlaced === 0 && rowsLeft >= 0) continue;
    }
    return placed;
  }

  // 在区域圆内采样一个合法落点（失败则螺旋偏移重试 8 次）
  _pickSpot(zone, kind, rnd, spawn, cps) {
    const def = PROP_KINDS[kind];
    const R = def.pad ? Math.max(def.size[0], def.size[2]) * 0.5 : def.r;
    for (let attempt = 0; attempt < 9; attempt++) {
      const ang = rnd() * Math.PI * 2;
      const rad = Math.sqrt(rnd()) * zone.r;
      let x = zone.anchor[0] + Math.cos(ang) * rad;
      let z = zone.anchor[1] + Math.sin(ang) * rad;
      if (attempt > 0) {
        const sway = attempt * 0.9;
        x += Math.cos(attempt * 2.399963) * sway;
        z += Math.sin(attempt * 2.399963) * sway;
      }
      if (!this._spotOk(x, z, R, spawn, cps)) continue;
      const floorY = this._floorAt(x, z);
      if (floorY === null) continue;
      return { x, z, y: floorY + R + 0.02 };
    }
    return null;
  }

  // 四道校验：边界 / 赛道 / 出生点 / 与世界碰撞体重叠
  _spotOk(x, z, r, spawn, cps) {
    const b = this._bounds;
    if (b) {
      const m = Config.PROP_EDGE_CLEAR + r;
      if (x < b.minX + m || x > b.maxX - m || z < b.minZ + m || z > b.maxZ - m) return false;
    }
    if (trackDistance(x, z, cps) < Config.PROP_TRACK_CLEAR) return false;
    if (Math.hypot(x - spawn.x, z - spawn.z) < Config.PROP_SPAWN_CLEAR) return false;
    for (const other of this.bodies) {
      if (other.pad) continue;
      const rr = r + other.r + 0.12;
      if (Math.hypot(x - other.x, z - other.z) < rr) return false;
    }
    return true;
  }

  // 向下探测地表高度（这张图地面在 y≈1 的底板上，不能写死 0）
  _floorAt(x, z) {
    const hit = raycastWorld(this.colliders, x, 4, z, 0, -1, 0, 12, { floor: true, floorY: 0 });
    if (!hit) return null;
    return hit.y;
  }

  _mesh(kind) {
    let geo = this._geo.get(kind);
    const def = PROP_KINDS[kind];
    if (!geo) {
      if (def.pad || def.shape === 'box') {
        geo = new THREE.BoxGeometry(def.size[0], def.size[1], def.size[2]);
      } else if (def.shape === 'soccer') {
        geo = buildSoccerBallGeometry(def.size[0] * 0.5);
      } else if (def.shape === 'sphere') {
        geo = new THREE.SphereGeometry(def.size[0] * 0.5, 14, 10);
      } else {
        geo = new THREE.CylinderGeometry(def.size[0] * 0.5, def.size[0] * 0.5, def.size[1], 14);
      }
      this._geo.set(kind, geo);
    }
    let mat = this._mat.get(kind);
    if (!mat) {
      if (def.transparent) {
        // 玻璃质感：低粗糙 + 高环境反射，配顶点色面板（足球气球的「透明」来自这里）
        mat = new THREE.MeshStandardMaterial({
          vertexColors: true,
          transparent: true,
          opacity: def.opacity,
          roughness: 0.16,
          metalness: 0.05,
          envMapIntensity: 1.8,
        });
      } else {
        mat = new THREE.MeshStandardMaterial({
          color: def.color,
          roughness: def.pad ? 0.45 : 0.72,
          metalness: 0.05,
          emissive: def.pad ? new THREE.Color(def.color) : new THREE.Color(0x000000),
          emissiveIntensity: def.pad ? 0.25 : 0,
        });
      }
      this._mat.set(kind, mat);
    }
    return new THREE.Mesh(geo, mat);
  }

  _create(kind, x, y, z, id) {
    if (!this.enabled) return null;
    const def = PROP_KINDS[kind];
    if (!def) return null;
    if (this.bodies.length >= Config.PROP_MAX) return null;

    const mesh = this._mesh(kind);
    mesh.castShadow = !!def.shadow;
    mesh.receiveShadow = false;

    if (def.pad) {
      // 静态触发器：不参与刚体积分，只记 AABB 供踩踏判定
      mesh.position.set(x, y - def.size[1] * 0.5, z);
      this.scene.add(mesh);
      const pad = {
        kind, pad: true, x, z, id,
        hx: def.size[0] * 0.5, hz: def.size[2] * 0.5,
        top: y, mesh,
      };
      this.pads.push(pad);
      this.bodies.push(pad);
      return pad;
    }

    // 视觉盒底对齐碰撞球底：mesh 中心比物理球心高 (h/2 - r)
    const yOff = def.shape === 'box' ? def.size[1] * 0.5 - def.r : 0;
    mesh.position.set(x, y + yOff, z);
    this.scene.add(mesh);

    const body = {
      id: id || `p${++this._seq}`,
      kind, r: def.r, mass: def.mass,
      x, y, z, vx: 0, vy: 0, vz: 0,
      resting: false, mesh, yOff,
      ownerId: '', lastNet: 0,
      tx: 0, ty: 0, tz: 0, lerp: 0,
    };
    this.bodies.push(body);
    this.spawned++;
    return body;
  }

  // 每帧推进。player = { x,y,z, vx,vy,vz, radius, launch(vy) }
  update(dt, player) {
    if (!this.enabled || !this.bodies.length) return;
    const now = performance.now() / 1000;

    for (const b of this.bodies) {
      if (b.pad) continue;
      if (b.ridden) {
        // 仓鼠球：位置完全由玩家驱动（球粘在玩家脚下跟着滚），不做积分/网络校正
        this._followPlayer(b, player);
      } else if (!b.resting) {
        this._integrate(b, dt);
      }
      if (!b.ridden && b.lerp > 0) {
        // 网络校正：平滑靠近目标位置，不硬 set（硬 set 会抖）
        b.lerp = Math.max(0, b.lerp - dt * 4);
        b.x += (b.tx - b.x) * Math.min(1, dt * 8);
        b.y += (b.ty - b.y) * Math.min(1, dt * 8);
        b.z += (b.tz - b.z) * Math.min(1, dt * 8);
      }
      b.mesh.position.set(b.x, b.y + b.yOff, b.z);
      if (!b.resting) {
        const sp = Math.hypot(b.vx, b.vz);
        b.mesh.rotation.x += sp * dt * 0.7;
        b.mesh.rotation.z += sp * dt * 0.5;
      }
    }

    this._resolvePairs();
    if (player) {
      this._pushByPlayer(player);
      this._checkPads(player);
    }

    // owner 以 PROP_NET_HZ 广播运动中的体（静止不广播）
    if (this.net && this.localId) {
      this._netAcc += dt;
      const period = 1 / Math.max(1, Config.PROP_NET_HZ);
      if (this._netAcc >= period) {
        this._netAcc = 0;
        for (const b of this.bodies) {
          if (b.pad) continue;
          if (b.ownerId !== this.localId) continue;
          const sp = Math.hypot(b.vx, b.vy, b.vz);
          if (sp < 0.6) continue;
          if (now - b.lastNet < period * 0.9) continue;
          b.lastNet = now;
          this.net.sendProp('state', {
            id: b.id, x: b.x, y: b.y, z: b.z, vx: b.vx, vy: b.vy, vz: b.vz,
          });
        }
      }
    }
  }

  // 仓鼠球：被骑乘的球每帧贴到玩家脚下（球底贴地），速度取玩家速度 ——
  // 这样网格滚动动画与 10Hz 的 owner state 广播都自然成立（远端看到球包着人滚）。
  _followPlayer(b, player) {
    if (!player) return;
    b.x = player.x;
    b.z = player.z;
    b.y = player.y - (player.height || Config.PLAYER_HEIGHT) + b.r; // player.y 是头顶
    b.vx = player.vx || 0;
    b.vy = 0;
    b.vz = player.vz || 0;
    b.resting = false;
  }

  // 准星是否对着一颗可交互的大球（供「进入」判定与按钮显隐用）。
  // 只认 ball 且未被骑乘；命中条件与 kick 同构：射线到球心的垂距 ≤ 球面附近。
  aimBall(ox, oy, oz, dx, dy, dz) {
    let best = null;
    let bestT = Infinity;
    for (const b of this.bodies) {
      if (b.pad || b.kind !== 'ball' || b.ridden) continue;
      const cx = b.x - ox, cy = b.y - oy, cz = b.z - oz;
      const t = cx * dx + cy * dy + cz * dz;
      if (t <= 0 || t > Config.BALL_ENTER_RANGE + b.r) continue;
      const px = ox + dx * t, py = oy + dy * t, pz = oz + dz * t;
      if (Math.hypot(px - b.x, py - b.y, pz - b.z) > b.r * 0.9 + 0.5) continue;
      if (t < bestT) { best = b; bestT = t; }
    }
    return best;
  }

  // 进入：把自己锁进球里（同一时刻只能骑一颗，换球先下旧球）
  enterBall(b) {
    if (!b || b.pad || b.ridden) return false;
    this.exitBall();
    b.ridden = true;
    b.resting = false;
    b.ownerId = this.localId || '';
    this.ridingBall = b;
    return true;
  }

  // 出来：球停在原地
  exitBall() {
    const b = this.ridingBall;
    if (!b) return false;
    b.ridden = false;
    b.vx = 0;
    b.vy = 0;
    b.vz = 0;
    this.ridingBall = null;
    return true;
  }

  _integrate(b, dt) {
    const def = PROP_KINDS[b.kind];
    moveSphereWorld(this.colliders, b, dt, b.r, {
      gravity: GRAVITY,
      restitution: def.rest,
      friction: def.fric,
      floorY: 0,
    });
    // 世界边界回弹（四边独立，与掉落物一致）
    const bd = this._bounds;
    if (bd) {
      if (b.x > bd.maxX - b.r) { b.x = bd.maxX - b.r; b.vx = -Math.abs(b.vx) * 0.4; }
      else if (b.x < bd.minX + b.r) { b.x = bd.minX + b.r; b.vx = Math.abs(b.vx) * 0.4; }
      if (b.z > bd.maxZ - b.r) { b.z = bd.maxZ - b.r; b.vz = -Math.abs(b.vz) * 0.4; }
      else if (b.z < bd.minZ + b.r) { b.z = bd.minZ + b.r; b.vz = Math.abs(b.vz) * 0.4; }
    }
    // 静止判定：着地（vy≈0）+ 水平几乎不动
    if (b.vy === 0 && Math.abs(b.vx) < Config.PROP_REST_SPEED && Math.abs(b.vz) < Config.PROP_REST_SPEED) {
      b.vx = 0;
      b.vz = 0;
      b.resting = true;
    }
  }

  // 道具之间做球-球分离（moveSphereWorld 只认世界几何，不含其它道具）。
  // 这是多米诺连锁与纸箱堆叠能成立的前提。
  _resolvePairs() {
    const arr = this.bodies;
    for (let i = 0; i < arr.length; i++) {
      const a = arr[i];
      if (a.pad || a.ridden) continue; // 被骑乘的球位置由玩家驱动，不参与分离
      for (let j = i + 1; j < arr.length; j++) {
        const b = arr[j];
        if (b.pad || b.ridden) continue;
        if (a.resting && b.resting) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dz = b.z - a.z;
        const sum = a.r + b.r;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > sum * sum || d2 < 1e-8) continue;
        const d = Math.sqrt(d2);
        const nx = dx / d, ny = dy / d, nz = dz / d;
        const pen = sum - d;
        const ma = a.mass, mb = b.mass, mt = ma + mb;
        // 按质量反比分开
        a.x -= nx * pen * (mb / mt);
        a.y -= ny * pen * (mb / mt);
        a.z -= nz * pen * (mb / mt);
        b.x += nx * pen * (ma / mt);
        b.y += ny * pen * (ma / mt);
        b.z += nz * pen * (ma / mt);
        // 沿法线交换速度（恢复系数取两者平均的一半，避免乱弹）
        const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny + (b.vz - a.vz) * nz;
        if (rel < 0) {
          const jimp = -(1.15) * rel / (1 / ma + 1 / mb);
          a.vx -= jimp * nx / ma;
          a.vy -= jimp * ny / ma;
          a.vz -= jimp * nz / ma;
          b.vx += jimp * nx / mb;
          b.vy += jimp * ny / mb;
          b.vz += jimp * nz / mb;
          a.resting = false;
          b.resting = false;
        }
      }
    }
  }

  // 贴身推动：玩家走进去就把道具顶开（重物顶不动 = 手感上的「重量」）
  _pushByPlayer(p) {
    const sp = Math.hypot(p.vx || 0, p.vz || 0);
    if (sp < Config.PROP_PUSH_MIN_SPEED) return;
    for (const b of this.bodies) {
      if (b.pad || b.ridden) continue; // 人已经「在球里」了，贴身推挤会跟骑乘驱动打架
      const dx = b.x - p.x;
      const dz = b.z - p.z;
      const d = Math.hypot(dx, dz);
      const sum = b.r + (p.radius || Config.PLAYER_RADIUS);
      if (d > sum || d < 1e-4) continue;
      // 高度要重叠（道具中心与玩家躯干相近）
      const dy = Math.abs(b.y - (p.y - Config.PLAYER_HEIGHT * 0.5));
      if (dy > Config.PLAYER_HEIGHT * 0.75 + b.r) continue;
      const nx = dx / d, nz = dz / d;
      // 冲量 ÷ sqrt(mass/3)：3kg 纸箱一撞就飞，18kg 课桌只能慢慢挪
      const push = (sp * Config.PROP_PUSH_RATIO) / Math.sqrt(Math.max(0.5, b.mass / 3));
      b.vx = nx * push + (p.vx || 0) * 0.15;
      b.vz = nz * push + (p.vz || 0) * 0.15;
      b.resting = false;
      b.ownerId = this.localId || '';
      // 顶开穿透
      const pen = sum - d;
      b.x += nx * pen * 0.6;
      b.z += nz * pen * 0.6;
    }
  }

  // 蹦床：脚落在踏板范围内且在下落 → 按落速弹起
  _checkPads(p) {
    if (!p.launch) return;
    for (const pad of this.pads) {
      if (Math.abs(p.x - pad.x) > pad.hx + 0.35) continue;
      if (Math.abs(p.z - pad.z) > pad.hz + 0.35) continue;
      const feet = p.y - (p.height || Config.PLAYER_HEIGHT); // PlayerState.y 是头顶
      if (feet > pad.top + 0.55 || feet < pad.top - 0.9) continue;
      const vy = p.vy || 0;
      if (vy > -0.5) continue;
      const boost = Math.min(
        Config.PROP_TRAMP_MAX,
        Math.max(Config.PROP_TRAMP_MIN, Math.abs(vy) * Config.PROP_TRAMP_BOOST)
      );
      p.launch(boost);
    }
  }

  // 踢：射线命中最近的道具，给一个按质量衰减的冲量。
  // 射程按「球面」算（PROP_KICK_RANGE + 半径）：不然巨型足球（r=2.6）站在它旁边
  // 球心就有 ~3.1m 远，永远够不着。
  kick(ox, oy, oz, dx, dy, dz) {
    if (!this.enabled) return false;
    let best = null;
    let bestT = Infinity;
    const cosArc = Math.cos((Config.PROP_KICK_ARC * Math.PI) / 180);
    for (const b of this.bodies) {
      if (b.pad || b.ridden) continue; // 球里有人的时候不许踢（位置由骑手驱动，踢了也会被覆盖）
      const cx = b.x - ox, cy = b.y - oy, cz = b.z - oz;
      const t = cx * dx + cy * dy + cz * dz;
      if (t <= 0 || t > Config.PROP_KICK_RANGE + b.r) continue;
      const px = ox + dx * t, py = oy + dy * t, pz = oz + dz * t;
      const perp = Math.hypot(px - b.x, py - b.y, pz - b.z);
      if (perp > b.r + 0.25) continue;
      // 张角：命中方向与视线夹角（远距离时半径小，靠距离判就够了；这里再加一道保险）
      const dot = (cx * dx + cy * dy + cz * dz) / (Math.hypot(cx, cy, cz) || 1);
      if (dot < cosArc) continue;
      best = b;
      bestT = t;
    }
    if (!best) return false;

    const def = PROP_KINDS[best.kind];
    const s = Math.min(14, Math.max(2.4, Config.PROP_KICK_SPEED * Math.sqrt(6 / Math.max(1, def.mass))));
    let hx = dx, hz = dz;
    const hl = Math.hypot(hx, hz);
    if (hl < 1e-4) { hx = 0; hz = -1; } else { hx /= hl; hz /= hl; }
    best.vx = hx * s;
    best.vz = hz * s;
    best.vy = Math.min(8, s * 0.5) + Config.PROP_KICK_UP * Math.sqrt(6 / Math.max(1, def.mass));
    best.resting = false;
    best.ownerId = this.localId || '';
    if (this.net) {
      this.net.sendProp('hit', {
        id: best.id, x: best.x, y: best.y, z: best.z,
        vx: best.vx, vy: best.vy, vz: best.vz,
      });
    }
    return true;
  }

  // 商店「充气足球」：在指定位置生成一颗球，本地立即可见 + 广播 spawn 给同房间的其他人。
  // 世界上限 Config.PROP_BALL_MAX 颗（超了摘掉最早生成的那颗并广播 gone），防止刷屏。
  spawnBall(x, y, z) {
    const spawned = this.bodies.filter((b) => !b.pad && String(b.id).startsWith('pb'));
    if (spawned.length >= Config.PROP_BALL_MAX) {
      const oldest = spawned[0];
      if (this.net) {
        this.net.sendProp('gone', { id: oldest.id, x: oldest.x, y: oldest.y, z: oldest.z });
      }
      this._remove(oldest);
    }
    // id 前缀 pb + 时间戳：全房间唯一（两端同刻生成也几乎不可能撞）
    const id = `pb${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
    const b = this._create('ball', x, y, z, id);
    if (!b) return null;
    b.ownerId = this.localId || '';
    if (this.net) {
      this.net.sendProp('spawn', { id, kind: 'ball', x, y, z, vx: 0, vy: 0, vz: 0 });
    }
    return b;
  }

  // 网络事件（服务端原样转发别人的动作）
  applyRemote(ev, msg) {
    if (!this.enabled || !msg) return;
    const id = String(msg.id || '');
    const body = this.bodies.find((b) => b.id === id);
    if (ev === 'hit') {
      if (!body || body.pad) return;
      body.vx = Number(msg.vx) || 0;
      body.vy = Number(msg.vy) || 0;
      body.vz = Number(msg.vz) || 0;
      body.resting = false;
      body.ownerId = '';
      return;
    }
    if (ev === 'state') {
      if (!body || body.pad) return;
      body.tx = Number(msg.x) || body.x;
      body.ty = Number(msg.y) || body.y;
      body.tz = Number(msg.z) || body.z;
      body.lerp = 1;
      // 速度也跟上，避免校正后又立刻漂走
      body.vx = Number(msg.vx) || 0;
      body.vy = Number(msg.vy) || 0;
      body.vz = Number(msg.vz) || 0;
      body.resting = false;
      return;
    }
    if (ev === 'spawn') {
      if (body) return;
      const kind = resolveKind(msg.kind);
      if (!kind) return;
      this._create(kind, Number(msg.x) || 0, Number(msg.y) || 0, Number(msg.z) || 0, id);
      return;
    }
    if (ev === 'gone') {
      if (!body) return;
      this._remove(body);
    }
  }

  _remove(body) {
    if (this.ridingBall === body) this.ridingBall = null; // 骑的球没了（gone），状态一起清
    if (body.mesh) this.scene.remove(body.mesh);
    const i = this.bodies.indexOf(body);
    if (i >= 0) this.bodies.splice(i, 1);
    const j = this.pads.indexOf(body);
    if (j >= 0) this.pads.splice(j, 1);
  }

  // 布局指纹：两端必须一致（不一致 = 确定性被破坏）
  hash() {
    let h = 0x811c9dc5;
    for (const b of this.bodies) {
      if (b.pad) continue;
      const s = `${b.kind}|${b.x.toFixed(2)}|${b.z.toFixed(2)}`;
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
      }
    }
    return (h >>> 0).toString(16);
  }

  get count() {
    return this.bodies.length;
  }
}
