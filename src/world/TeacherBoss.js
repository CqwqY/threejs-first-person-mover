// 职责：位于 (11,142) 的传送门，以及由它召唤出来的「老师」三阶段 Boss。
//
// 一阶段：追着最近的玩家跑（碰到谁谁就挂），每 2.6 秒朝四周打一圈弹幕；打空 1000 血进入二阶段。
// 切换演出：老师发白光一闪 → 世界变红。
// 二阶段：开始绕自身旋转的红色激光，激光很矮，跳起来就能躲开；打空 1000 血进入三阶段。
// 三阶段：激光变成跳不过去的高墙，玩家可以按 Q（手机点「护盾」按钮）手动开护盾，
//         护盾挡下激光时老师掉 100 血，打空 1000 血即获胜。
//
// 联机：召唤者是 owner，负责模拟老师的移动 / 开火 / 激光角度 / 阶段推进，事件经服务器中继；
//       非 owner 的老师只按收到的位姿与角度插值。伤害结算全部「各人判自己」：
//       每个客户端只检测自己有没有被弹幕/激光扫到、有没有被碰到，因此不需要服务器判定。
import * as THREE from 'three';
import { Config } from '../config.js';
import { instantiate, createFallback } from './AssetLoader.js';
import { projectileHitsWorld } from './collision/projectileHit.js';

// 老师的状态：idle（传送门待机）/ countdown（倒计时中）/ alive（战斗中）/
// shift（刚被打空血，白光+世界变红的过场中）/ dead（已击败，稍后重置）
const IDLE = 'idle';
const COUNTDOWN = 'countdown';
const ALIVE = 'alive';
const SHIFT = 'shift';
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

  // ---------- 一阶段：环形弹幕 ----------
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

  // ---------- 二/三阶段：绕老师旋转的红色激光 ----------
  const laserGroup = new THREE.Group();
  laserGroup.visible = false;
  scene.add(laserGroup);

  const laserMat = new THREE.MeshBasicMaterial({
    color: 0xff2a2a, transparent: true, opacity: 0.6,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  const laserBoxGeo = new THREE.BoxGeometry(1, 1, 1);

  // 每根激光放在一个只绕 Y 旋转的支点上，支点角度固定（一圈均分），
  // 整体再靠 laserGroup.rotation.y 统一旋转，因此世界角度 = laserAngle + i * 2π/N。
  const laserBlades = [];
  for (let i = 0; i < Config.BOSS_LASER_COUNT; i++) {
    const pivot = new THREE.Group();
    pivot.rotation.y = (i / Config.BOSS_LASER_COUNT) * Math.PI * 2;
    laserGroup.add(pivot);
    const mesh = new THREE.Mesh(laserBoxGeo, laserMat);
    pivot.add(mesh);
    laserBlades.push({ mesh });
  }

  // 按当前阶段设置激光的高度：二阶段很矮（跳得过去），三阶段是一堵高墙（跳不过去）
  function updateLaserGeometry() {
    const low = Config.BOSS_LASER_LOW;
    const high = phase >= 3 ? Config.BOSS_LASER_HIGH_3 : Config.BOSS_LASER_HIGH_2;
    const h = Math.max(0.05, high - low);
    for (const b of laserBlades) {
      b.mesh.scale.set(Config.BOSS_LASER_THICK, h, Config.BOSS_LASER_LEN);
      b.mesh.position.set(0, low + h / 2, -Config.BOSS_LASER_LEN / 2);
    }
  }

  // ---------- 落雷：先在随机落点画地面警示圈，预警结束后天降落雷 ----------
  const bolts = [];
  const boltWarnGeo = new THREE.RingGeometry(0.62, 1, 36);
  const boltStrikeGeo = new THREE.CylinderGeometry(0.5, 0.5, 12, 14, 1, true);

  function spawnBolt(x, z) {
    // 每个落雷各自持有材质：它们会同时改透明度，共享材质会互相串味
    const warn = new THREE.Mesh(boltWarnGeo, new THREE.MeshBasicMaterial({
      color: 0xff5544, transparent: true, opacity: 0.4,
      side: THREE.DoubleSide, depthWrite: false,
    }));
    warn.rotation.x = -Math.PI / 2;
    warn.position.set(x, 0.06, z);
    warn.scale.setScalar(Config.BOSS_BOLT_RADIUS);
    scene.add(warn);

    const strike = new THREE.Mesh(boltStrikeGeo, new THREE.MeshBasicMaterial({
      color: 0xdff0ff, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }));
    strike.position.set(x, 6, z);
    strike.scale.set(Config.BOSS_BOLT_RADIUS, 1, Config.BOSS_BOLT_RADIUS);
    strike.visible = false;
    scene.add(strike);

    bolts.push({ x, z, warn, strike, t: 0, struck: false, life: 0 });
  }

  function clearBolts() {
    for (const b of bolts) {
      scene.remove(b.warn); b.warn.material.dispose();
      scene.remove(b.strike); b.strike.material.dispose();
    }
    bolts.length = 0;
  }

  // 落雷推进：预警圈由大缩到落点大小，砸下来时对本地玩家结算一次伤害
  function updateBolts(dt, local) {
    for (let i = bolts.length - 1; i >= 0; i--) {
      const b = bolts[i];
      b.t += dt;
      if (!b.struck) {
        const k = Math.min(1, b.t / Config.BOSS_BOLT_WARN);
        b.warn.scale.setScalar(Config.BOSS_BOLT_RADIUS * (1.45 - 0.45 * k));
        b.warn.material.opacity = 0.3 + 0.5 * k;
        if (b.t >= Config.BOSS_BOLT_WARN) {
          b.struck = true;
          b.warn.visible = false;
          b.strike.visible = true;
          if (local && !local.shield && Math.hypot(local.x - b.x, local.z - b.z) <= Config.BOSS_BOLT_RADIUS) {
            if (onLocalDamage) onLocalDamage(Config.BOSS_BOLT_DAMAGE);
          }
        }
      } else {
        b.life += dt;
        b.strike.material.opacity = 0.85 * Math.max(0, 1 - b.life / 0.35);
        const s = Config.BOSS_BOLT_RADIUS * (1 + b.life * 1.6);
        b.strike.scale.set(s, 1, s);
        if (b.life >= 0.35) {
          scene.remove(b.warn); b.warn.material.dispose();
          scene.remove(b.strike); b.strike.material.dispose();
          bolts.splice(i, 1);
        }
      }
    }
  }

  // ---------- 状态 ----------
  let mode = IDLE;
  let phase = 1;                   // 1 / 2 / 3
  let nextPhase = 2;
  let countdown = 0;
  let hp = 0;
  let owner = false;               // 是否由本机负责模拟老师的移动 / 开火 / 阶段推进
  let px = P.x;                    // 当前坐标（地面）
  let pz = P.z;
  let byaw = 0;                    // 当前朝向
  let laserAngle = 0;              // 激光当前旋转角
  let laserOn = true;              // 激光是否处于「开启」的 10 秒窗口（关闭 5 秒时完全消失）
  let laserTimer = 0;              // 当前开/关窗口的剩余时间
  let boltTimer = 0;               // 下一次落雷的倒计时
  let volleyTimer = 0;
  let shiftTimer = 0;              // 阶段切换过场的剩余时间
  let resetTimer = 0;              // 被击败后传送门恢复的剩余时间
  let laserHitCd = 0;              // 本地玩家被激光命中的冷却
  let shieldBlockCd = 0;           // 护盾挡下激光的冷却（防止一次开盾刷多次伤害）
  let netPoseTimer = 0;
  let netX = P.x;                  // 非 owner：收到的目标位姿，做插值
  let netZ = P.z;
  let netYaw = 0;
  let netLaser = 0;
  let animT = 0;

  let onEvent = null;              // (msg) => void，广播给其他玩家
  let onLocalDamage = null;        // (damage) => void，本机玩家受伤
  let onLocalKill = null;          // () => void，本机玩家被老师碰到（秒杀）
  let onPhase = null;              // (kind, phase) => void，kind: 'shift' | 'enter' | 'dead'
  let onStatus = null;             // () => void，状态变化时刷新 UI

  function emit(msg) {
    if (onEvent) onEvent(msg);
  }

  function setStatus() {
    if (onStatus) onStatus();
  }

  function laserHeight() {
    return phase >= 3 ? Config.BOSS_LASER_HIGH_3 : Config.BOSS_LASER_HIGH_2;
  }

  // ---------- 阶段流程 ----------

  function startCountdown() {
    mode = COUNTDOWN;
    phase = 1;
    countdown = Config.BOSS_SPAWN_DELAY;
    hp = Config.BOSS_HP;
    px = P.x;
    pz = P.z;
    byaw = 0;
    laserAngle = 0;
    netX = px;
    netZ = pz;
    netLaser = 0;
    laserOn = false;
    laserGroup.visible = false;
    clearBullets();
    clearBolts();
    setStatus();
  }

  function spawnNow() {
    mode = ALIVE;
    phase = 1;
    hp = Config.BOSS_HP;
    volleyTimer = Config.BOSS_VOLLEY_INTERVAL * 0.5; // 出现后先缓一下再开火
    boltTimer = Config.BOSS_BOLT_INTERVAL;
    bossGroup.visible = true;
    laserGroup.visible = false;
    setStatus();
  }

  // 进入某个阶段：血量重置、切到该阶段的攻击方式
  function enterPhase(n) {
    phase = n;
    hp = Config.BOSS_HP;
    mode = ALIVE;
    volleyTimer = Config.BOSS_VOLLEY_INTERVAL * 0.6;
    boltTimer = Config.BOSS_BOLT_INTERVAL;
    laserAngle = 0;
    laserOn = n >= 2;
    laserTimer = Config.BOSS_LASER_ON;
    clearBullets();
    clearBolts();
    updateLaserGeometry();
    laserGroup.visible = n >= 2;
    if (onPhase) onPhase('enter', n);
    setStatus();
  }

  // 血量打空：先播「白光 + 世界变红」的过场，再进入下一阶段（只有 owner 推进流程）
  function startShift(next) {
    mode = SHIFT;
    nextPhase = next;
    shiftTimer = Config.BOSS_PHASE_SHIFT;
    hp = 0;
    clearBullets();
    clearBolts();
    laserGroup.visible = false;
    emit({ ev: 'shift', ph: next });
    if (onPhase) onPhase('shift', next);
    setStatus();
  }

  function endFight() {
    mode = DEAD;
    hp = 0;
    resetTimer = Config.PORTAL_RESET_DELAY;
    bossGroup.visible = false;
    laserGroup.visible = false;
    clearBullets();
    clearBolts();
    emit({ ev: 'dead' });
    if (onPhase) onPhase('dead', phase);
    setStatus();
  }

  // 老师掉血：先本地扣，再广播给别人各扣同一份增量
  function hurtBy(dmg) {
    if (mode !== ALIVE || !(dmg > 0)) return;
    hp = Math.max(0, hp - dmg);
    emit({ ev: 'damage', dmg });
    afterHpChange();
  }

  // 血量变化后的收尾：打空则由 owner 推进阶段，其他人等 owner 的 shift 事件
  function afterHpChange() {
    if (hp > 0 || !owner) { setStatus(); return; }
    if (phase < 3) startShift(phase + 1);
    else endFight();
  }

  // ---------- 对外操作 ----------

  // 本机玩家点了「召唤老师」：本地立即开始倒计时，并广播给其他人
  function summon() {
    if (mode !== IDLE) return;
    owner = true;
    startCountdown();
    emit({ ev: 'start' });
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
        if (mode === COUNTDOWN) { mode = ALIVE; bossGroup.visible = true; }
        if (mode === ALIVE) {
          netX = Number(msg.x) || 0;
          netZ = Number(msg.z) || 0;
          netYaw = Number(msg.yaw) || 0;
          netLaser = Number(msg.la) || 0;
          if (Number.isFinite(Number(msg.ph))) phase = Number(msg.ph);
          if (Number.isFinite(Number(msg.hp))) hp = Number(msg.hp);
          // 激光的开/关窗口也随位姿下发，避免各端各自计时后错开
          if (msg.lv !== undefined) laserOn = !!Number(msg.lv);
          updateLaserGeometry();
          laserGroup.visible = phase >= 2 && laserOn;
          setStatus();
        }
        break;
      case 'volley':
        if (mode === ALIVE && phase === 1) {
          fireVolley(Number(msg.x) || px, Number(msg.y) || (Config.BOSS_HEIGHT * 0.6), Number(msg.z) || pz);
        }
        break;
      case 'bolt': {
        const bx = Number(msg.x);
        const bz = Number(msg.z);
        if (Number.isFinite(bx) && Number.isFinite(bz)) spawnBolt(bx, bz);
        break;
      }
      case 'shift':
        if (mode === ALIVE || mode === SHIFT) {
          mode = SHIFT;
          nextPhase = Number(msg.ph) || (phase + 1);
          shiftTimer = Config.BOSS_PHASE_SHIFT;
          hp = 0;
          clearBullets();
          laserGroup.visible = false;
          if (onPhase) onPhase('shift', nextPhase);
          setStatus();
        }
        break;
      case 'phase':
        enterPhase(Number(msg.ph) || 2);
        break;
      case 'damage':
        if (mode === ALIVE) {
          hp = Math.max(0, hp - Math.max(0, Number(msg.dmg) || 0));
          afterHpChange();
        }
        break;
      case 'dead':
        if (mode !== IDLE) endFight();
        break;
      default:
        break;
    }
  }

  // 广播当前状态（owner 在有人中途加入时调用，让新玩家立刻看到老师）
  function broadcastNow() {
    if (!owner || mode === IDLE) return;
    if (mode === COUNTDOWN) { emit({ ev: 'start' }); return; }
    if (mode === ALIVE) emit({ ev: 'pose', x: px, z: pz, yaw: byaw, hp, ph: phase, la: laserAngle, lv: laserOn ? 1 : 0 });
    else if (mode === SHIFT) emit({ ev: 'shift', ph: nextPhase });
  }

  // 玩家投掷物 / 爆炸是否落在老师身上（过场中无敌）
  function hitsAt(x, y, z, r) {
    if (mode !== ALIVE) return false;
    const dx = x - px;
    const dz = z - pz;
    const rad = Config.BOSS_RADIUS + r;
    if (dx * dx + dz * dz > rad * rad) return false;
    return y > -r && y < Config.BOSS_HEIGHT + r;
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
    const step = Math.min(Config.BOSS_CHASE_SPEED * dt, dist);
    const nx = px + (dx / dist) * step;
    const nz = pz + (dz / dist) * step;
    if (!blocked(px, pz, nx, nz, colliders)) { px = nx; pz = nz; return; }
    // 撞墙：分轴尝试，沿墙滑动而不是完全卡死
    if (!blocked(px, pz, nx, pz, colliders)) { px = nx; return; }
    if (!blocked(px, pz, px, nz, colliders)) { pz = nz; }
  }

  // ---------- 打本地玩家：碰到秒杀（护盾期间免疫） ----------
  function checkContact(local) {
    if (!local || local.shield) return;
    const reach = Config.BOSS_RADIUS + Config.PLAYER_RADIUS + Config.BOSS_CONTACT_PAD;
    if (Math.hypot(local.x - px, local.z - pz) > reach) return;
    // 竖直方向也要有重叠（站在楼顶/高空时碰不到）：老师占 [0, BOSS_HEIGHT]，玩家占 [y-身高, y]
    const feet = local.y - Config.PLAYER_HEIGHT;
    if (feet >= Config.BOSS_HEIGHT || local.y <= 0) return;
    if (onLocalKill) onLocalKill();
  }

  // ---------- 激光命中判定：都只判「本地玩家自己」，所以不需要 owner 代判 ----------
  function checkLasers(local, dt) {
    laserHitCd = Math.max(0, laserHitCd - dt);
    shieldBlockCd = Math.max(0, shieldBlockCd - dt);
    if (!laserOn || !local) return;  // 激光处于 5 秒消失窗口时不结算
    if (laserHitCd > 0) return;

    const low = Config.BOSS_LASER_LOW;
    const high = laserHeight();
    // 玩家躯干（脚底 y-PLAYER_HEIGHT ~ 头顶 y）与激光高度区间没有交集就安全（跳起来躲开）
    const feet = local.y - Config.PLAYER_HEIGHT;
    if (feet >= high || local.y <= low) return;

    const dx = local.x - px;
    const dz = local.z - pz;
    const reach = Config.BOSS_LASER_THICK / 2 + Config.PLAYER_RADIUS;

    for (let i = 0; i < laserBlades.length; i++) {
      const a = laserAngle + (i / laserBlades.length) * Math.PI * 2;
      const sx = -Math.sin(a);
      const sz = -Math.cos(a);
      const along = dx * sx + dz * sz;
      if (along < 0 || along > Config.BOSS_LASER_LEN) continue;
      const perp = Math.abs(dz * sx - dx * sz);
      if (perp > reach) continue;

      laserHitCd = Config.BOSS_LASER_HIT_COOLDOWN;
      if (local.shield) {
        // 护盾成功挡下：老师掉血（同一面盾只结算一次）
        if (shieldBlockCd <= 0) {
          shieldBlockCd = Config.BOSS_SHIELD_DURATION;
          hurtBy(Config.BOSS_SHIELD_DAMAGE);
        }
      } else if (onLocalDamage) {
        onLocalDamage(Config.BOSS_LASER_DAMAGE);
      }
      return;
    }
  }

  // ---------- 每帧推进 ----------
  // ctx: { target: 最近玩家 {x,z} | null; local: {x,y,z,shield} 本地玩家; colliders }
  function update(dt, ctx) {
    animT += dt;

    // 传送门动效
    halo.rotation.z += dt * 0.9;
    halo.position.y = 1.7 + Math.sin(animT * 1.6) * 0.12;
    disc.material.opacity = 0.26 + 0.14 * (0.5 + 0.5 * Math.sin(animT * 2.4));
    beam.material.opacity = 0.12 + 0.08 * (0.5 + 0.5 * Math.sin(animT * 1.1 + 1));
    ringOuter.material.opacity = mode === IDLE ? 0.65 : 0.3;

    if (mode === DEAD) {
      resetTimer -= dt;
      if (resetTimer <= 0) { mode = IDLE; phase = 1; hp = 0; setStatus(); }
      return;
    }
    if (mode === COUNTDOWN) {
      countdown -= dt;
      if (countdown <= 0) {
        countdown = 0;
        spawnNow();
        if (owner) emit({ ev: 'pose', x: px, z: pz, yaw: byaw, hp, ph: 1, la: laserAngle });
      }
      return;
    }
    if (mode === SHIFT) {
      // 只有 owner 计时，其他人等 owner 的 phase 事件，避免两端各进一次阶段
      if (!owner) return;
      shiftTimer -= dt;
      if (shiftTimer <= 0) {
        enterPhase(nextPhase);
        emit({ ev: 'phase', ph: nextPhase });
      }
      return;
    }
    if (mode !== ALIVE) return;

    // ---- 移动 / 攻击：只有 owner 模拟，其他人按收到的位姿插值 ----
    if (owner) {
      if (ctx.target) chase(dt, ctx.target, ctx.colliders);

      if (phase === 1) {
        volleyTimer -= dt;
        if (volleyTimer <= 0) {
          volleyTimer = Config.BOSS_VOLLEY_INTERVAL;
          const by = Config.BOSS_HEIGHT * 0.6;
          fireVolley(px, by, pz);
          emit({ ev: 'volley', x: px, y: by, z: pz });
        }
      } else {
        // 激光开 10 秒、关 5 秒：关闭窗口整组隐藏，给玩家一段纯输出时间
        laserTimer -= dt;
        if (laserTimer <= 0) {
          laserOn = !laserOn;
          laserTimer = laserOn ? Config.BOSS_LASER_ON : Config.BOSS_LASER_OFF;
          laserGroup.visible = laserOn;
        }
        if (laserOn) laserAngle += (phase >= 3 ? Config.BOSS_LASER_SPIN_3 : Config.BOSS_LASER_SPIN_2) * dt;
      }

      // 落雷：每隔一段时间在老师附近的随机落点砸一道，先给地面警示圈
      boltTimer -= dt;
      if (boltTimer <= 0) {
        boltTimer = Config.BOSS_BOLT_INTERVAL;
        const a = Math.random() * Math.PI * 2;
        const r = Config.BOSS_BOLT_SPREAD_MIN
          + Math.random() * (Config.BOSS_BOLT_SPREAD_MAX - Config.BOSS_BOLT_SPREAD_MIN);
        const bx = px + Math.cos(a) * r;
        const bz = pz + Math.sin(a) * r;
        spawnBolt(bx, bz);
        emit({ ev: 'bolt', x: bx, z: bz });
      }

      netPoseTimer -= dt;
      if (netPoseTimer <= 0) {
        netPoseTimer = 1 / Config.BOSS_NET_HZ;
        emit({ ev: 'pose', x: px, z: pz, yaw: byaw, hp, ph: phase, la: laserAngle, lv: laserOn ? 1 : 0 });
      }
    } else {
      // 位姿插值：按 10Hz 收到的目标平滑靠近，避免瞬移
      const k = Math.min(1, dt * 8);
      px += (netX - px) * k;
      pz += (netZ - pz) * k;
      byaw += Math.atan2(Math.sin(netYaw - byaw), Math.cos(netYaw - byaw)) * k;
      laserAngle += Math.atan2(Math.sin(netLaser - laserAngle), Math.cos(netLaser - laserAngle)) * k;
    }

    // ---- 场地效果：落雷 + 接触秒杀 + 激光 / 弹幕命中（都只判本地玩家） ----
    const local = ctx.local;
    updateBolts(dt, local);
    if (local) {
      checkContact(local);
      if (phase >= 2) checkLasers(local, dt);

      if (bullets.length) {
        for (let i = bullets.length - 1; i >= 0; i--) {
          const b = bullets[i];
          b.mesh.position.x += b.vx * dt;
          b.mesh.position.z += b.vz * dt;
          b.life -= dt;
          b.mesh.rotation.y += dt * 4;

          let dead = b.life <= 0;
          if (!dead && !local.shield) {
            const d = Math.hypot(b.mesh.position.x - local.x, b.mesh.position.z - local.z);
            const cy = local.y - Config.PLAYER_HEIGHT / 2; // 玩家躯干中心高度
            if (d <= Config.BOSS_BULLET_HIT_RADIUS && Math.abs(b.mesh.position.y - cy) <= 1.1) {
              dead = true;
              if (onLocalDamage) onLocalDamage(Config.BOSS_BULLET_DAMAGE);
            }
          }
          if (!dead && (Math.abs(b.mesh.position.x) > 400 || Math.abs(b.mesh.position.z) > 400)) dead = true;
          if (dead) {
            scene.remove(b.mesh);
            bullets.splice(i, 1);
          }
        }
      }
    }

    bossGroup.position.set(px, 0, pz);
    bossGroup.rotation.y = byaw + Config.BOSS_YAW_OFFSET;
    laserGroup.position.set(px, 0, pz);
    laserGroup.rotation.y = laserAngle;
  }

  return {
    update,
    summon,
    netEvent,
    broadcastNow,
    hitsAt,
    hurtBy,
    setOnEvent: (fn) => { onEvent = fn; },
    setOnLocalDamage: (fn) => { onLocalDamage = fn; },
    setOnLocalKill: (fn) => { onLocalKill = fn; },
    setOnPhase: (fn) => { onPhase = fn; },
    setOnStatus: (fn) => { onStatus = fn; },
    // 供 UI / 其他模块读取
    get mode() { return mode; },
    get phase() { return phase; },
    get hp() { return hp; },
    get maxHp() { return Config.BOSS_HP; },
    get countdown() { return countdown; },
    get pos() { return { x: px, z: pz }; },
  };
}
