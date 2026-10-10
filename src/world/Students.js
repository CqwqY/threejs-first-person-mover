// 职责：校园里的学生 NPC。
// - 名单/初始位置由服务端 npc_roster 下发（姓名/班级/性别 + 初始坐标）；移动目标(tx/tz)由 5Hz 的 npc 广播下发。
// - 客户端**自己驱动位移**：每个学生持有一个 PlayerPhysics 实例，吃和玩家**同一份** colliders
//   （含 trimesh 复杂碰撞），所以学生撞的墙、踩的坡、上的台阶都和玩家一致，不再穿墙、也不再只做坐标缓动。
// - 服务端退化为「大脑」：定目标 + 按需求/课表决策去哪 + 触发 LLM 对话；实际走位/碰撞/朝向全在客户端算。
// - 朝向用**真实速度方向**算（修掉早期服务端 rot 让模型"倒走"的 bug）；走路/站立动画按本地速度混合。
// - 头顶名牌显示「姓名 · 班级」，说话/心理活动用气泡显示几秒后自动消失。
//
// ⚠ 单位与协议（与 server-remote/npcworld.js 对齐，改一端必须同步另一端）：
//   坐标米、st 只有 'idle' | 'walk' | 'act' 三种；客户端朝向是弧度（不依赖服务端 rot）。
import * as THREE from 'three';
import { instantiateRigged } from './AssetLoader.js';
import { attachFakeShadow } from './FakeShadow.js';
import { PlayerPhysics } from '../player/PlayerPhysics.js';
import { sphereWorldMTV } from '../world/collision/worldQuery.js';
import { Config } from '../config.js';

// ⚠ 必须用带骨骼的 -rig 版本（tools/auto-rig.mjs 生成）：原版 boy/girl.glb 没有骨骼也没有动画，
//   加载出来是个立牌 —— 表现就是"只会平移、没有走路动作"。
const MODEL = { m: '/assets/boy-rig.glb', f: '/assets/girl-rig.glb' };
// ⚠ 模型正面偏 90°，与 PlayerModel 的 cfg.modelDeg 必须一致（那边真机校准过的值）。
//   少了它，学生会侧着身子走。
const MODEL_DEG = 90;
const ROT_LAMBDA = 8;         // 朝向缓动（仅视觉，物理朝向由真实速度决定）
const TALK_RANGE = 3.2;       // 多近才能搭话（米）
const BUBBLE_SEC = 5;         // 气泡停留时长（秒）
const REF_SPEED = 1.25;       // walk 动画播满速对应的速度（米/秒）

// ⚠ 学生移动改用「跟玩家同一套」PlayerPhysics：吃同一份 colliders（含 trimesh 复杂碰撞），
//   所以学生撞的墙、踩的坡、上的台阶都和玩家完全一致，不再只做坐标缓动（那会穿墙 + 只有平移）。
// 服务端退化为只当「大脑」：定目标(tx/tz) + 触发 AI；实际位移/碰撞全在客户端算。
const STUDENT_RADIUS = Config.PLAYER_RADIUS;   // 碰撞半径 = 玩家
const STUDENT_HEIGHT = Config.PLAYER_HEIGHT;   // 身高 = 玩家
const STUDENT_SPEED = 1.25;                     // 维持原服务端步行速度（米/秒）；speedMult 据此折算
const WALK_PROBE = 0.7;                         // 前进方向探测距离（找一条不被墙挡的路）
const ARRIVE_DIST = 1.6;                        // 到达目标阈值（与服务端一致）
// 本地转向候选偏转（弧度）：0/±26/±51/±82/±127°——逐级加宽到「背对目标」，总能找到可走方向
const STEER_FAN = [0, 0.45, -0.45, 0.9, -0.9, 1.4, -1.4, 2.2, -2.2];

// 复用的合成输入：NPC 没有 WASD/相机，每帧只把「forward」置 1、并把相机朝向 yaw 对准要走的路，
// 即可复用 PlayerPhysics 的全部解算（重力/贴地/trimesh 子步进/OBB/凸包）。
const _npcInput = {
  _f: 0,
  forwarded: () => _npcInput._f,
  backwarded: () => 0,
  strafeRight: () => 0,
  strafeLeft: () => 0,
  joyX: 0, joyY: 0, joyMagnitude: () => 0,
  sprinting: () => false,
  consumeJump: () => false,
  isDown: () => false,
};

// 头顶名牌：画到 canvas 再贴成 Sprite（比 TextGeometry 省事，也不用在打包里塞字体）
function makeNameTag(text, sub) {
  const cv = document.createElement('canvas');
  cv.width = 512;
  cv.height = 128;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  g.fillStyle = 'rgba(12,22,36,0.72)';
  const r = 26;
  g.beginPath();
  g.moveTo(r, 6);
  g.arcTo(cv.width - 6, 6, cv.width - 6, cv.height - 6, r);
  g.arcTo(cv.width - 6, cv.height - 6, 6, cv.height - 6, r);
  g.arcTo(6, cv.height - 6, 6, 6, r);
  g.arcTo(6, 6, cv.width - 6, 6, r);
  g.closePath();
  g.fill();
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#ffffff';
  g.font = 'bold 46px "Microsoft YaHei", "PingFang SC", sans-serif';
  g.fillText(text, cv.width / 2, 48);
  g.fillStyle = '#9fb6cc';
  g.font = '30px "Microsoft YaHei", "PingFang SC", sans-serif';
  g.fillText(sub, cv.width / 2, 96);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  spr.scale.set(2.0, 0.5, 1);
  spr.position.y = 2.25;
  spr.renderOrder = 900;
  return spr;
}

// 气泡：说话是白底、心理活动是灰底斜体感（用颜色区分，不引字体）
function makeBubble() {
  const cv = document.createElement('canvas');
  cv.width = 512;
  cv.height = 160;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  spr.scale.set(3.0, 0.94, 1);
  spr.position.y = 3.05;
  spr.renderOrder = 901;
  spr.visible = false;
  return { spr, cv, tex };
}

function drawBubble(cv, text, isThink) {
  const g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  g.fillStyle = isThink ? 'rgba(40,48,60,0.78)' : 'rgba(255,255,255,0.92)';
  const r = 24;
  g.beginPath();
  g.moveTo(r, 8);
  g.arcTo(cv.width - 8, 8, cv.width - 8, cv.height - 8, r);
  g.arcTo(cv.width - 8, cv.height - 8, 8, cv.height - 8, r);
  g.arcTo(8, cv.height - 8, 8, 8, r);
  g.arcTo(8, 8, cv.width - 8, 8, r);
  g.closePath();
  g.fill();
  g.fillStyle = isThink ? '#c8d4e2' : '#16202e';
  g.font = '34px "Microsoft YaHei", "PingFang SC", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  // 长句折行：超过 12 字一行就切两段（气泡宽度有限，写不下就宁可两行）
  const line1 = text.slice(0, 12);
  const line2 = text.slice(12);
  if (line2) {
    g.fillText(line1, cv.width / 2, 62);
    g.fillText(line2.slice(0, 12), cv.width / 2, 104);
  } else {
    g.fillText(line1, cv.width / 2, 80);
  }
}

export function createStudents(opts) {
  const scene = opts.scene;
  const onSpeak = opts.onSpeak || (() => {}); // 气泡事件（Game 用它同步到对话栏）
  // 世界碰撞体（与玩家同一份，含 trimesh 复杂碰撞）：Game 传进来的数组引用原地改写，这里直接复用
  const colliders = opts.colliders || null;

  const root = new THREE.Group();
  root.name = 'students';
  scene.add(root);

  const byId = new Map();       // id → 学生运行时对象
  let order = [];               // 名单顺序（roster 下发顺序）
  let disposed = false;

  function ensure(id) {
    let s = byId.get(id);
    if (s) return s;
    s = {
      id,
      name: '',
      cls: '',
      sex: 'm',
      holder: new THREE.Group(),   // 位置/朝向都写在这里
      model: null,
      mixer: null,
      act: null,
      tag: null,
      bubble: null,
      bubbleUntil: 0,
      // 服务端坐标（目标）与本地显示坐标：分开存，才能做缓动
      tx: 0, tz: 0, trot: 0,
      x: 0, z: 0, rot: 0, yaw: 0, // yaw：客户端按真实速度算的朝向（弧度），不依赖服务端 rot
      st: 'idle',
      speed: 0,
      // 每个学生一个独立物理实例（吃同一份 colliders，碰撞与玩家完全一致）
      physics: new PlayerPhysics(),
      pstate: { x: 0, y: STUDENT_HEIGHT, z: 0, onGround: false },
      _arriveSent: 0,
    };
    // 学生不跳：关掉跳跃，速度倍率折算到 STUDENT_SPEED（PlayerPhysics 默认按玩家 MOVE_SPEED 算）
    s.physics.canJump = false;
    s.physics.maxJumps = 0;
    s.physics.jumpMult = 0;
    s.physics.speedMult = STUDENT_SPEED / Config.MOVE_SPEED;
    root.add(s.holder);
    byId.set(id, s);
    return s;
  }

  // 模型：按性别加载 boy/girl；加载失败留一个占位方块（宁可有个方块，也别让人凭空消失）
  function loadModel(s) {
    if (s.model) return;
    const url = MODEL[s.sex] || MODEL.m;
    instantiateRigged(url)
      .then(({ root: model, animations }) => {
        if (disposed || byId.get(s.id) !== s) return;
        // 缩放到 1.75m 身高、脚底贴地（和玩家同款处理）
        const box = new THREE.Box3().setFromObject(model);
        const h = box.max.y - box.min.y;
        const k = h > 1e-4 ? 1.75 / h : 1;
        model.scale.setScalar(k);
        model.position.y = -box.min.y * k;
        model.traverse((o) => { if (o.isMesh) o.castShadow = true; });
        // 朝向修正单独一层：外层 holder 只管"往哪走"，这一层负责把模型正面掰正（跟玩家同款处理）
        const face = new THREE.Group();
        face.rotation.y = (MODEL_DEG * Math.PI) / 180;
        face.add(model);
        s.holder.add(face);
        s.model = model;
        attachFakeShadow(s.holder, { radius: 0.5 });
        if (animations && animations.length) {
          const mixer = new THREE.AnimationMixer(model);
          const pick = (kw) => animations.find((a) => new RegExp(kw, 'i').test(a.name));
          const clips = { idle: pick('idle'), walk: pick('walk') };
          const act = {};
          for (const key of ['idle', 'walk']) {
            if (!clips[key]) continue;
            act[key] = mixer.clipAction(clips[key]);
            act[key].play();
            act[key].setEffectiveWeight(key === 'idle' ? 1 : 0);
          }
          s.mixer = mixer;
          s.act = act;
        }
      })
      .catch(() => {
        if (disposed || byId.get(s.id) !== s) return;
        const m = new THREE.Mesh(
          new THREE.BoxGeometry(0.5, 1.7, 0.3),
          new THREE.MeshStandardMaterial({ color: 0x9c7b5a })
        );
        m.position.y = 0.85;
        // 兜底方块也走同一层朝向修正，免得"真人正确、兜底侧着走"
        const face = new THREE.Group();
        face.rotation.y = (MODEL_DEG * Math.PI) / 180;
        face.add(m);
        s.holder.add(face);
        s.model = m;
      });
    // 名牌/气泡不等模型：先挂上，模型到了再一起显示
    s.tag = makeNameTag(s.name || '同学', s.cls || '');
    s.holder.add(s.tag);
    s.bubble = makeBubble();
    s.holder.add(s.bubble.spr);
  }

  // 名单：服务端下发时才建名牌（名字要显示正确）
  function setRoster(list) {
    if (!Array.isArray(list)) return;
    order = [];
    for (const it of list) {
      const s = ensure(String(it.id));
      s.name = String(it.name || '同学');
      s.cls = String(it.cls || '');
      s.sex = it.sex === 'f' ? 'f' : 'm';
      // ⚠ 协议：优先读 tx/tz（服务端下发的**目标点**）；兼容老协议只发 x/z 时退回用 x/z 当目标。
      const gx = Number.isFinite(Number(it.tx)) ? Number(it.tx) : Number(it.x);
      const gz = Number.isFinite(Number(it.tz)) ? Number(it.tz) : Number(it.z);
      s.tx = Number.isFinite(gx) ? gx : 0;
      s.tz = Number.isFinite(gz) ? gz : 0;
      s.trot = Number(it.rot) || 0;
      if (!s.model) {
        // 初始位置用服务端当前坐标(x/z)落地 pstate（目标已在上面临时设好）
        const ix = Number.isFinite(Number(it.x)) ? Number(it.x) : s.tx;
        const iz = Number.isFinite(Number(it.z)) ? Number(it.z) : s.tz;
        s.pstate.x = ix; s.pstate.z = iz; s.pstate.y = STUDENT_HEIGHT;
        s.x = ix; s.z = iz; s.rot = s.trot;
        s.holder.position.set(ix, 0, iz);
        s.holder.rotation.y = (s.rot * Math.PI) / 180;
        loadModel(s);
      }
      if (s.tag) {
        s.holder.remove(s.tag);
        s.tag = makeNameTag(s.name, s.cls);
        s.holder.add(s.tag);
      }
      order.push(s.id);
    }
  }

  // 位置广播：只更新「目标」，实际位移交给 update 缓动
  function applyList(list) {
    if (!Array.isArray(list)) return;
    for (const it of list) {
      const s = byId.get(String(it.id));
      if (!s) continue;
      // ⚠ 协议：广播的是**目标点** tx/tz（服务端只定目标，客户端走位）；兼容老协议读 x/z。
      const nx = Number.isFinite(Number(it.tx)) ? Number(it.tx) : Number(it.x);
      const nz = Number.isFinite(Number(it.tz)) ? Number(it.tz) : Number(it.z);
      // NaN 防线：服务端坐标一旦是 NaN，整个模型会消失且射线打不到（见项目记忆第 7 条）
      if (!Number.isFinite(nx) || !Number.isFinite(nz)) continue;
      s.tx = nx;
      s.tz = nz;
      s.st = String(it.st || 'idle');
    }
  }

  function showBubble(s, text, isThink, now) {
    if (!s.bubble || !text) return;
    drawBubble(s.bubble.cv, text, !!isThink);
    s.bubble.tex.needsUpdate = true;
    s.bubble.spr.visible = true;
    s.bubbleUntil = now + BUBBLE_SEC;
  }

  // 说话：所有客户端都能看见（服务端广播的）
  function onSay(msg) {
    const s = byId.get(String(msg.id));
    if (!s) return;
    const now = performance.now() / 1000;
    const say = String(msg.say || '');
    // ⚠ 心理活动（think）是**内部**的：服务端根本不再下发，这里也绝不显示 ——
    //   它只留在角色档案里，用来驱动记忆和接下来的举止。
    if (say) showBubble(s, say, false, now);
    onSpeak({ id: s.id, name: s.name, say });
  }

  // 离玩家最近、且在搭话范围内的学生
  function nearest(px, pz) {
    let best = null;
    let bestD = TALK_RANGE;
    for (const s of byId.values()) {
      const d = Math.hypot(s.pstate.x - px, s.pstate.z - pz);
      if (d <= bestD) { bestD = d; best = s; }
    }
    return best;
  }

  // ⚠ 学生走位改由客户端 PlayerPhysics 驱动（吃和玩家同一份 colliders，含 trimesh 复杂碰撞）。
  // 服务端只下发「目标点」(tx/tz) 与状态 st；实际位移/碰撞/朝向都在这里算。
  function update(dt) {
    const now = performance.now() / 1000;
    const cs = colliders; // 同一份世界碰撞体（含 trimesh），与玩家共用
    for (const s of byId.values()) {
      const dx = s.tx - s.pstate.x;
      const dz = s.tz - s.pstate.z;
      const dist = Math.hypot(dx, dz);
      const shouldWalk = s.st === 'walk';
      const moving = shouldWalk && dist > 0.4;

      if (cs) {
        if (moving) {
          // 朝目标的单位方向，再用 STEER_FAN 选一条不被墙挡的路（trimesh/盒都认）
          const ux = dx / dist, uz = dz / dist;
          let nx = ux, nz = uz;
          const probeY = s.pstate.y - STUDENT_HEIGHT * 0.5;
          for (const a of STEER_FAN) {
            const ca = Math.cos(a), sa = Math.sin(a);
            const cx = ux * ca - uz * sa;
            const cz = ux * sa + uz * ca;
            const px = s.pstate.x + cx * WALK_PROBE;
            const pz = s.pstate.z + cz * WALK_PROBE;
            // sphereWorldMTV 复用缓冲：只判 null，不存引用
            if (!sphereWorldMTV(cs, px, probeY, pz, STUDENT_RADIUS)) { nx = cx; nz = cz; break; }
          }
          // cameraYaw 让玩家模型朝 (-sin yaw, -cos yaw)；要朝 (nx,nz) 走 ⇒ yaw = atan2(-nx,-nz)
          const yaw = Math.atan2(-nx, -nz);
          _npcInput._f = 1;
          s.physics.update(dt, _npcInput, yaw, s.pstate, cs);
        } else {
          // 站立：仍跑物理（重力+贴地+碰撞），但不给前进输入（人不会飘、不会穿地）
          _npcInput._f = 0;
          s.physics.update(dt, _npcInput, s.yaw || 0, s.pstate, cs);
        }
      } else {
        // ⚠ 兜底（colliders 没注入时）：退回坐标缓动，免得人定住（无碰撞，会穿墙——只应急）
        const k = 1 - Math.exp(-6 * dt);
        s.pstate.x += dx * k;
        s.pstate.z += dz * k;
        s.pstate.y = STUDENT_HEIGHT;
      }

      // 写回显示：脚底 = 头部高 - 身高（PlayerPhysics 的 state.y 是头部/相机高）
      s.x = s.pstate.x; s.z = s.pstate.z;
      s.holder.position.set(s.pstate.x, s.pstate.y - STUDENT_HEIGHT, s.pstate.z);

      // 朝向：优先用真实速度方向（修"倒走"），站立即无速度时退回朝目标方向；走最短弧平滑
      const vx = s.physics.velocity.x, vz = s.physics.velocity.z;
      const sp = Math.hypot(vx, vz);
      let faceYaw = s.yaw;
      if (sp > 0.05) faceYaw = Math.atan2(-vx, -vz);
      else if (!cs && moving) faceYaw = Math.atan2(-(dx / dist), -(dz / dist));
      let dYaw = ((faceYaw - s.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      s.yaw += dYaw * Math.min(1, dt * ROT_LAMBDA);
      s.holder.rotation.y = s.yaw;

      // 动画：按本地真实水平速度混合 idle/walk
      s.speed = sp;
      if (s.mixer) {
        s.mixer.update(dt);
        if (s.act) {
          const w = Math.max(0, Math.min(1, sp / REF_SPEED));
          if (s.act.idle) s.act.idle.setEffectiveWeight(1 - w);
          if (s.act.walk) s.act.walk.setEffectiveWeight(w);
        }
      }
      if (s.bubble && s.bubble.spr.visible && now > s.bubbleUntil) s.bubble.spr.visible = false;
      if (s.tag) s.tag.position.y = s.bubble && s.bubble.spr.visible ? 2.6 : 2.25;
    }
  }

  function setVisible(v) { root.visible = !!v; }

  function dispose() {
    disposed = true;
    // 逐个摘掉再清容器：先清空会留下「父节点还在、子节点没了」的空窗口（见项目记忆第 8 条）
    for (const s of byId.values()) {
      if (s.holder && s.holder.parent) s.holder.parent.remove(s.holder);
    }
    root.clear();
    if (root.parent) root.parent.remove(root);
    byId.clear();
    order = [];
  }

  return { setRoster, applyList, onSay, nearest, update, setVisible, dispose, TALK_RANGE, get size() { return byId.size; } };
}
