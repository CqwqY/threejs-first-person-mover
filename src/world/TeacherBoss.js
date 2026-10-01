// 职责：位于 (11,142) 的传送门，以及由它召唤出来的「老师」Boss。
// 玩法：靠近传送门点「召唤老师」→ 10 秒倒计时 → 老师出现（1000 血），
//       追着最近的玩家跑，并每隔几秒朝四周环形打出一圈弹幕。
// 联机：召唤者是 owner，负责模拟老师的移动 / 开火 / 命中判定，事件经服务器中继给其他人；
//       非 owner 的老师只按收到的位姿做插值。血量由所有人各自扣同一份增量
//       （每个客户端只上报自己造成的伤害，服务器不回发给发送者，因此不会重复扣）。
import * as THREE from 'three';
import { Config } from '../config.js';
import { instantiate, createFallback } from './AssetLoader.js';
import { projectileHitsWorld } from './collision/projectileHit.js';

// 老师的三种状态：idle（传送门待机）/ countdown（倒计时中）/ alive（已出现）/ dead（刚被击败，稍后重置）
const IDLE = 'idle';
const COUNTDOWN = 'countdown';
const ALIVE = 'alive';
const DEAD = 'dead';

export function createTeacherBoss(scene) {
  const P = Config.PORTAL_POS;

  // ---------- 传送门外观：地面光环 + 立柱光柱 + 悬浮光环，不依赖朝向，四周都能看到 ----------
  const portal = new THREE.Group();
  portal.position.set(P.x, 0, P.z);

  const ringOuter = new THREE.Mesh(
    new THREE.RingGeometry(1.05, 1.6, 40),
    new THREE.MeshBasicMaterial({
      color: 0x9d6bff, transparent: true, opacity: 0.55,
      side: THREE.DoubleSide, depthWrite: false,
    })
  );
  ringOuter.rotation.x = -Math.PI / 2;
  ringOuter.position.y = 0.03;
  portal.add(ringOuter);

  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(1.05, 40),
    new THREE.MeshBasicMaterial({
      color: 0x5a2bd8, transparent: true, opacity: 0.35,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false,
    })
  );
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = 0.05;
  portal.add(disc);

  // 光柱用 BackSide：站在柱子里时只看到远侧一面，不然内外两面叠加会把整个屏幕糊成一片紫色
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.6, 0.9, 4.6, 20, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0x8a5cff, transparent: true, opacity: 0.14,
      side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false,
    })
  );
  beam.position.y = 2.3;
  portal.add(beam);

  const halo = new THREE.Mesh(
    new THREE.TorusGeometry(0.85, 0.055, 10, 36),
    new THREE.MeshBasicMaterial({ color: 0xd9c2ff, transparent: true, opacity: 0.8, depthWrite: false })
  );
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = 1.7;
  portal.add(halo);

  scene.add(portal);

  // ---------- 老师本体 ----------
  const bossGroup = new THREE.Group();
  bossGroup.visible = false;
  scene.add(bossGroup);

  instantiate(Config.BOSS_MODEL)
    .then((model) => {
      const box = new THREE.Box3();
      model.traverse((o) => {
        if (o.isMesh) {
          o.geometry.computeBoundingBox();
          box.expandByObject(o);
        }
      });
      const sizeY = box.max.y - box.min.y;
      const s = sizeY > 1e-4 ? Config.BOSS_HEIGHT / sizeY : 1;
      model.scale.setScalar(s);
      model.position.y = -box.min.y * s; // 底边压到 y=0
      model.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      bossGroup.add(model);
    })
    .catch((e) => {
      // 模型加载失败：用方块兜底，保证 Boss 依然能打
      console.warn('[boss] 老师模型加载失败，改用方块占位:', e);
      bossGroup.add(createFallback({ color: 0xb03a55, width: 0.8, height: Config.BOSS_HEIGHT, depth: 0.5 }));
    });

  // ---------- 弹幕 ----------
  const bulletGeo = new THREE.SphereGeometry(0.16, 10, 8);
  const bulletMat = new THREE.MeshBasicMaterial({ color: 0xffd75e });
  const bullets = [];

  function spawnBullet(x, y, z, dx, dz) {
    const mesh = new THREE.Mesh(bulletGeo, bulletMat);
    mesh.position.set(x, y, z);
    scene.add(mesh);
    bullets.push({
      mesh,
      vx: dx * Config.BOSS_BULLET_SPEED,
      vz: dz * Config.BOSS_BULLET_SPEED,
      life: Config.BOSS_BULLET_LIFE,
    });
  }

  function clearBullets() {
    for (const b of bullets) scene.remove(b.mesh);
    bullets.length = 0;
  }

  // 环形弹幕：一圈均分的水平弹丸
  function fireVolley(x, y, z) {
    const n = Config.BOSS_VOLLEY_COUNT;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      spawnBullet(x, y, z, Math.cos(a), Math.sin(a));
    }
  }

  // ---------- 状态 ----------
  let mode = IDLE;
  let countdown = 0;
  let hp = 0;
  let owner = false;               // 是否由本机负责模拟老师的移动 / 开火 / 命中
  let px = P.x;                    // 当前坐标（地面）
  let pz = P.z;
  let byaw = 0;                    // 当前朝向
  let volleyTimer = 0;
  let resetTimer = 0;
  let netPoseTimer = 0;
  let netX = P.x;                  // 非 owner：收到的目标位姿，做插值
  let netZ = P.z;
  let netYaw = 0;
  let animT = 0;

  let onEvent = null;              // (msg) => void，广播给其他玩家
  let onBulletHit = null;          // (playerId, isLocal, damage) => void
  let onStatus = null;             // () => void，状态变化时刷新 UI

  function emit(msg) {
    if (onEvent) onEvent(msg);
  }

  function setStatus() {
    if (onStatus) onStatus();
  }

  // ---------- 对外操作 ----------

  // 本机玩家点了「召唤老师」：本地立即开始倒计时，并广播给其他人
  function summon() {
    if (mode !== IDLE) return;
    owner = true;
    startCountdown();
    emit({ ev: 'start' });
  }

  function startCountdown() {
    mode = COUNTDOWN;
    countdown = Config.BOSS_SPAWN_DELAY;
    hp = Config.BOSS_HP;
    px = P.x;
    pz = P.z;
    byaw = 0;
    netX = px;
    netZ = pz;
    clearBullets();
    setStatus();
  }

  function spawnNow() {
    mode = ALIVE;
    hp = Config.BOSS_HP;
    volleyTimer = Config.BOSS_VOLLEY_INTERVAL * 0.5; // 出现后先缓一下再开火
    bossGroup.visible = true;
    setStatus();
  }

  function die() {
    if (mode === IDLE || mode === DEAD) return;
    mode = DEAD;
    hp = 0;
    resetTimer = Config.PORTAL_RESET_DELAY;
    bossGroup.visible = false;
    clearBullets();
    setStatus();
  }

  // 本地收到的网络事件（别人的老师动作）
  function netEvent(msg) {
    if (!msg || !msg.ev) return;
    switch (msg.ev) {
      case 'start':
        if (mode === IDLE) { owner = false; startCountdown(); }
        break;
      case 'pose':
        if (mode === IDLE) { mode = ALIVE; bossGroup.visible = true; } // 中途加入：直接按当前状态补齐
        if (mode === ALIVE || mode === COUNTDOWN) {
          if (mode === COUNTDOWN) { mode = ALIVE; bossGroup.visible = true; }
          netX = Number(msg.x) || 0;
          netZ = Number(msg.z) || 0;
          netYaw = Number(msg.yaw) || 0;
          if (Number.isFinite(Number(msg.hp))) hp = Number(msg.hp);
          setStatus();
        }
        break;
      case 'volley':
        if (mode === ALIVE) {
          fireVolley(Number(msg.x) || px, Number(msg.y) || (Config.BOSS_HEIGHT * 0.6), Number(msg.z) || pz);
        }
        break;
      case 'damage':
        hp = Math.max(0, hp - Math.max(0, Number(msg.dmg) || 0));
        if (hp <= 0) die(); else setStatus();
        break;
      case 'dead':
        die();
        break;
      default:
        break;
    }
  }

  // 广播当前状态（owner 在有人中途加入时调用，让新玩家立刻看到老师）
  function broadcastNow() {
    if (!owner || mode === IDLE) return;
    if (mode === COUNTDOWN) { emit({ ev: 'start' }); return; }
    if (mode === ALIVE) emit({ ev: 'pose', x: px, z: pz, yaw: byaw, hp });
  }

  // 玩家投掷物 / 爆炸是否落在老师身上
  function hitsAt(x, y, z, r) {
    if (mode !== ALIVE) return false;
    const dx = x - px;
    const dz = z - pz;
    const rad = Config.BOSS_RADIUS + r;
    if (dx * dx + dz * dz > rad * rad) return false;
    return y > -r && y < Config.BOSS_HEIGHT + r;
  }

  // 本机对老师造成伤害：本地扣血 + 广播（其他客户端各自扣同一份增量）
  function hurtBy(dmg) {
    if (mode !== ALIVE || !(dmg > 0)) return;
    hp = Math.max(0, hp - dmg);
    emit({ ev: 'damage', dmg });
    if (hp <= 0) { die(); emit({ ev: 'dead' }); } else setStatus();
  }

  // ---------- 追击时的移动判定：直接朝目标走，撞到建筑就沿墙滑动 ----------
  function blocked(fx, fz, tx, tz, colliders) {
    if (!colliders || !colliders.length) return false;
    return projectileHitsWorld(colliders, tx, Config.BOSS_HEIGHT * 0.5, tz, Config.BOSS_RADIUS,
      fx, Config.BOSS_HEIGHT * 0.5, fz);
  }

  function chase(dt, target, colliders) {
    const dx = target.x - px;
    const dz = target.z - pz;
    const dist = Math.hypot(dx, dz);
    if (dist < 1e-4) return;
    byaw = Math.atan2(dx, dz);
    if (dist <= Config.BOSS_CHASE_STOP || dist > Config.BOSS_CHASE_RANGE) return;
    const step = Config.BOSS_CHASE_SPEED * dt;
    const nx = px + (dx / dist) * step;
    const nz = pz + (dz / dist) * step;
    if (!blocked(px, pz, nx, nz, colliders)) { px = nx; pz = nz; return; }
    // 撞墙：分轴尝试，沿墙滑动而不是完全卡死
    if (!blocked(px, pz, nx, pz, colliders)) { px = nx; return; }
    if (!blocked(px, pz, px, nz, colliders)) { pz = nz; }
  }

  // ---------- 每帧推进 ----------
  // ctx: { dt 已由外部应用；target: 最近玩家 {x,z} | null；players: [{id,x,y,z,isLocal}]; colliders }
  function update(dt, ctx) {
    animT += dt;

    // 传送门动效
    halo.rotation.z += dt * 0.9;
    halo.position.y = 1.7 + Math.sin(animT * 1.6) * 0.12;
    disc.material.opacity = 0.26 + 0.14 * (0.5 + 0.5 * Math.sin(animT * 2.4));
    beam.material.opacity = 0.12 + 0.08 * (0.5 + 0.5 * Math.sin(animT * 1.1 + 1));
    const portalHot = mode === IDLE; // 可召唤时传送门更亮
    ringOuter.material.opacity = portalHot ? 0.65 : 0.3;

    if (mode === DEAD) {
      resetTimer -= dt;
      if (resetTimer <= 0) { mode = IDLE; hp = 0; setStatus(); }
      return;
    }
    if (mode === COUNTDOWN) {
      countdown -= dt;
      if (countdown <= 0) {
        countdown = 0;
        spawnNow();
        if (owner) emit({ ev: 'pose', x: px, z: pz, yaw: byaw, hp });
      }
      return;
    }
    if (mode !== ALIVE) return;

    // ---- 移动与开火：只有 owner 模拟，其他人按收到的位姿插值 ----
    if (owner) {
      if (ctx.target) chase(dt, ctx.target, ctx.colliders);

      volleyTimer -= dt;
      if (volleyTimer <= 0) {
        volleyTimer = Config.BOSS_VOLLEY_INTERVAL;
        const by = Config.BOSS_HEIGHT * 0.6;
        fireVolley(px, by, pz);
        emit({ ev: 'volley', x: px, y: by, z: pz });
      }

      netPoseTimer -= dt;
      if (netPoseTimer <= 0) {
        netPoseTimer = 1 / Config.BOSS_NET_HZ;
        emit({ ev: 'pose', x: px, z: pz, yaw: byaw, hp });
      }
    } else {
      // 位姿插值：按 10Hz 收到的目标平滑靠近，避免瞬移
      const k = Math.min(1, dt * 8);
      px += (netX - px) * k;
      pz += (netZ - pz) * k;
      byaw += Math.atan2(Math.sin(netYaw - byaw), Math.cos(netYaw - byaw)) * k;
    }

    // ---- 弹幕推进 ----
    if (bullets.length) {
      const players = ctx.players || [];
      for (let i = bullets.length - 1; i >= 0; i--) {
        const b = bullets[i];
        b.mesh.position.x += b.vx * dt;
        b.mesh.position.z += b.vz * dt;
        b.life -= dt;
        b.mesh.rotation.y += dt * 4;

        let dead = b.life <= 0;
        // 只有 owner 做命中判定，避免所有客户端重复扣血；伤害经 hit 中继下发给被命中的玩家
        if (!dead && owner) {
          for (const p of players) {
            const d = Math.hypot(b.mesh.position.x - p.x, b.mesh.position.z - p.z);
            if (d > Config.BOSS_BULLET_HIT_RADIUS) continue;
            const cy = p.y - Config.PLAYER_HEIGHT / 2; // 玩家躯干中心高度
            if (Math.abs(b.mesh.position.y - cy) > 1.1) continue;
            dead = true;
            if (onBulletHit) onBulletHit(p.id, p.isLocal, Config.BOSS_BULLET_DAMAGE);
            break;
          }
        }
        // 飞出场地边界也回收
        if (!dead && (Math.abs(b.mesh.position.x) > 400 || Math.abs(b.mesh.position.z) > 400)) dead = true;
        if (dead) {
          scene.remove(b.mesh);
          bullets.splice(i, 1);
        }
      }
    }

    bossGroup.position.set(px, 0, pz);
    bossGroup.rotation.y = byaw + Config.BOSS_YAW_OFFSET;
  }

  return {
    update,
    summon,
    netEvent,
    broadcastNow,
    hitsAt,
    hurtBy,
    setOnEvent: (fn) => { onEvent = fn; },
    setOnBulletHit: (fn) => { onBulletHit = fn; },
    setOnStatus: (fn) => { onStatus = fn; },
    // 供 UI / 其他模块读取
    get mode() { return mode; },
    get hp() { return hp; },
    get maxHp() { return Config.BOSS_HP; },
    get countdown() { return countdown; },
    get pos() { return { x: px, z: pz }; },
  };
}
