// 职责：定义玩家的“外观”。

// 模型 = 人物 GLB（girl/boy，原模型自带正确贴图/UV）+ 头顶名牌。GLB 异步加载，加载前先用缩小版占位身体保证即时可见。
// 按包围盒等比缩放到 1.8 并让脚底落在 y=0；朝向由 modelDeg 控制（绕 Y 旋转最终模型，安全、不动骨架）。
// ⚠ 朝向取值（真机反复验证，别再靠头部法线探针猜）：
//   你说 modelDeg=0 偏 90°、modelDeg=180 也偏 90° → 两者都正好差 90°，正确值在正中 = **90**。
//   原版（Mixamo 网格 +X 朝）也是 90，auto-rig 的 boy/girl.glb 朝同一方向，故 90 正对移动方向（-Z）。
//   若真机仍偏，地址栏加 ?modelDeg=N（N 为度数，如 ?modelDeg=0 / 180 / 270）实时拨正，确认后再回填此常量。
//
// 骨骼动画：用的是 `${gender}-rig.glb`（由 tools/auto-rig.mjs 离线生成）——
//   网格沿用带贴图的原 GLB（UV/贴图一个字节没动，二进制手术追加骨骼），骨骼与蒙皮权重
//   基于 AABB 程序化生成，待机/走/跑动画也是同坐标系程序化生成（绕局部 X 摆腿=前后走）。
//   彻底放弃 Mixamo 绑骨 + Soldier 动画重定向（那套跨骨架比例/朝向不匹配导致侧躺/外撇/猎奇）。
//   旧的 AutoRig.js（靠顶点高度硬分区猜骨架）与 bake-player-rig.mjs（Mixamo 路线）均已弃用。
import * as THREE from 'three';
import { instantiate, instantiateRigged } from '../world/AssetLoader.js';
import { Config } from '../config.js';
import { attachFakeShadow } from '../world/FakeShadow.js';

const MODEL_HEIGHT = 1.8;      // 人物目标高度（米），与相机高度 PLAYER_HEIGHT 大致对齐
const NAME_TAG_Y = 2.05;       // 名牌锚点高度（在头顶上方）
const HAND_POS = { x: 0.34, y: 1.05, z: 0.16 }; // 手部锚点（模型局部坐标，原点在脚底）
const HP_W = 0.9;   // 血量条宽度（世界单位）
const HP_H = 0.085; // 血量条高度
const HP_CANVAS_W = 128; // 血量条画布尺寸（横向分辨率足够看清比例即可）
const HP_CANVAS_H = 16;
const DEG = Math.PI / 180;

// 把血量比例画到画布上：底槽 + 左对齐的彩色填充（同一张图，不存在层序问题）
function drawHpBar(ctx, ratio) {
  const r = Math.max(0, Math.min(1, ratio));
  ctx.clearRect(0, 0, HP_CANVAS_W, HP_CANVAS_H);
  ctx.fillStyle = 'rgba(20,26,38,0.85)';
  ctx.beginPath();
  ctx.roundRect(0, 0, HP_CANVAS_W, HP_CANVAS_H, 4);
  ctx.fill();
  const w = r * (HP_CANVAS_W - 2);
  if (w > 1) {
    ctx.fillStyle = r > 0.5 ? '#2ecc71' : (r > 0.2 ? '#f1c40f' : '#e74c3c');
    ctx.beginPath();
    ctx.roundRect(1, 1, w, HP_CANVAS_H - 2, 3);
    ctx.fill();
  }
}

// ---- 运行时朝向校准（?calib 面板可实时拖动并读取度数，校准后回填代码并删除）----
// modelDeg：模型整体视觉朝向，直接绕 Y 旋转最终模型（安全、不动骨架）。
// 真机验证：0 与 180 都偏 90°，正确值 = 90（正对 glTF 前进约定 -Z 的移动方向）。
// skelDeg：仅旋转「骨架(armature)」节点 —— 骨头经蒙皮带动网格形变，是真正的「转骨骼」；
//   ⚠ 旧写法直接转 e.rig.root（=整棵 GLB 根，包含网格），会变成「转骨骼=整个人刚性跟着转」，已废弃。
const cfg = { modelDeg: 90, skelDeg: 0 };
// 运行时 URL 覆盖：?modelDeg=N 临时拨正朝向（校准用，不写盘、不污染），确认后回填上面常量。
try {
  const _md = parseFloat(new URLSearchParams(window.location.search).get('modelDeg'));
  if (Number.isFinite(_md)) cfg.modelDeg = _md;
} catch (e) { /* 忽略 */ }
const models = []; // 已创建模型条目 {group, gender, faceHolder, rig}

// 把给定模型的朝向同步到当前 cfg 配置
function applyCfg(e) {
  if (e.faceHolder) e.faceHolder.rotation.y = cfg.modelDeg * DEG; // 模型整体朝向（刚性）
  // skelDeg 只转骨架根(armature)：骨头绕自身转 → 蒙皮网格随之形变，不会把整模型当刚体转。
  // 旧实现 e.rig.root.rotation.y 会把 GLB 根连同网格一起转，表现就是「转骨骼整个人跟着转」。
  const arm = e.rig && e.rig.root && e.rig.root.getObjectByName ? e.rig.root.getObjectByName('armature') : null;
  if (arm) arm.rotation.y = cfg.skelDeg * DEG;
}

// ⚠⚠ 换身体必须「先接新的、再摘旧的」——**绝不能先 clear 再加**。
//   只要中间任何一步抛错或异步失败，bodyHolder 就永久空掉：人物只剩头顶名牌与手持物
//   （它们挂在 group 的独立锚点上，跟身体无关）→ 表现为「道具看得到、人看不到」；
//   同时攻击射线在模型里找不到任何网格 → 「朝着人挥也判定不到」。
//   这两条正是线上最难查的一类：不报错、不崩溃，就是人没了。
// 导出是为了自检探针能直接验证「先加后摘」的顺序（tools/probe-player-body.mjs）。
export function swapBody(entry, node) {
  const ud = entry && entry.group && entry.group.userData;
  const bh = ud && ud.bodyHolder;
  if (!bh || !node) return;
  const prev = bh.children.slice(); // 先拷一份：直接遍历 bh.children 一边删一边遍历会漏
  bh.add(node);
  for (const c of prev) bh.remove(c);
}

// 兜底中的兜底：bodyHolder 空了就补回占位人形，保证「人一定看得见」。
function ensureFallbackBody(entry) {
  const bh = entry && entry.group && entry.group.userData.bodyHolder;
  if (!bh || bh.children.length) return;
  swapBody(entry, _createFallbackBody());
  entry.faceHolder = null;
}

// 构建一个模型的“身体”：加载带骨骼的 GLB，接上 AnimationMixer（待机/走/跑），
// 失败则回退为静态等比缩放；朝向统一由 applyCfg/modelDeg 控制。
function buildBody(entry) {
  return instantiateRigged(`/assets/${entry.gender}-rig.glb`)
    .then(({ root, animations }) => {
      entry.rig = null;
      entry.faceHolder = null;

      // 归一化：按包围盒等比缩放到身高、脚底压到 y=0（bind pose 下量，骨骼与网格一起缩放）
      const box = new THREE.Box3();
      root.traverse((o) => {
        if (o.isMesh) {
          o.geometry.computeBoundingBox();
          box.expandByObject(o);
        }
        // 蒙皮网格动画后顶点会跑出静态包围盒，按包围盒做视锥剔除会出现「走到屏幕边缘整个人消失」；
        // 玩家数量有限，直接关掉剔除最省心。
        if (o.isSkinnedMesh) o.frustumCulled = false;
      });
      const sizeY = box.max.y - box.min.y;
      const scale = sizeY > 1e-4 ? MODEL_HEIGHT / sizeY : MODEL_HEIGHT;
      root.scale.setScalar(scale);
      root.position.y = -box.min.y * scale; // 底边压到 y=0

      const holder = new THREE.Group();
      holder.add(root);
      holder.receiveShadow = true;
      attachFakeShadow(holder, { radius: 0.5 }); // 假阴影：关掉真实阴影后给角色落地实感
      swapBody(entry, holder);
      entry.faceHolder = holder;

      entry.rig = createAnimRig(root, animations);
      entry.group.userData.rig = entry.rig;

      applyCfg(entry);
      return true;
    })
    .catch((e) => {
      // 带骨骼的版本加载失败：退回旧的静态模型（至少人还在，不会隐形）
      console.warn('[PlayerModel] 骨骼身体加载失败（' + entry.gender + '），退回静态模型:', e);
      return buildStaticBody(entry);
    });
}

// 兜底：静态等比缩放的旧模型（无骨骼无动画）
function buildStaticBody(entry) {
  return instantiate(`/assets/${entry.gender}.glb`).then((model) => {
    const box = new THREE.Box3();
    model.traverse((o) => {
      if (o.isMesh) {
        o.geometry.computeBoundingBox();
        box.expandByObject(o);
      }
    });
    const sizeY = box.max.y - box.min.y;
    const scale = sizeY > 1e-4 ? MODEL_HEIGHT / sizeY : MODEL_HEIGHT;
    model.scale.setScalar(scale);
    model.position.y = -box.min.y * scale;
      const holder = new THREE.Group();
      holder.add(model);
      holder.receiveShadow = true;
      attachFakeShadow(holder, { radius: 0.5 }); // 假阴影：关掉真实阴影后给角色落地实感
    swapBody(entry, holder);
    entry.faceHolder = holder;
    applyCfg(entry);
    return false;
  }).catch((e) => {
    // 两条路都断了：把占位人形放回去，别让人凭空消失（宁可是个蓝方块，也不能没人）
    console.error('[PlayerModel] 人物模型彻底加载失败（' + entry.gender + '），已恢复占位人形:', e);
    ensureFallbackBody(entry);
    return false;
  });
}

// ---- 骨骼动画驱动 ----
// 三段动画同时播放，用权重混合（待机 ↔ 走 ↔ 跑），并用 timeScale 把步频挂到实际速度上。
// 权重混合比 crossFade 更适合这里：速度是连续量、每帧都在变，crossFade 会在反复起停时抖动。
function createAnimRig(root, animations) {
  if (!animations || animations.length === 0) return null;
  const mixer = new THREE.AnimationMixer(root);
  const pick = (kw) => animations.find((a) => new RegExp(kw, 'i').test(a.name));
  const clips = { idle: pick('idle'), walk: pick('walk'), run: pick('run') };
  if (!clips.walk && !clips.idle) return null;

  const act = {};
  for (const k of ['idle', 'walk', 'run']) {
    if (!clips[k]) continue;
    act[k] = mixer.clipAction(clips[k]);
    act[k].setLoop(THREE.LoopRepeat, Infinity);
    act[k].enabled = true;
    act[k].play();
    act[k].setEffectiveWeight(k === 'idle' ? 1 : 0);
  }

  return {
    root,
    mixer,
    actions: act,
    // dt：本帧时长（秒）；speed：本帧水平速度（米/秒）
    update(dt, speed) {
      const s = Number.isFinite(speed) ? Math.max(0, speed) : 0;
      const wWalk = clamp01((s - Config.ANIM_IDLE_MAX) / Math.max(0.1, Config.ANIM_WALK_FULL - Config.ANIM_IDLE_MAX));
      const wRun = clamp01((s - Config.ANIM_RUN_START) / Math.max(0.1, Config.ANIM_RUN_FULL - Config.ANIM_RUN_START));
      if (act.idle) act.idle.setEffectiveWeight(1 - wWalk);
      if (act.walk) {
        act.walk.setEffectiveWeight(wWalk * (1 - wRun));
        act.walk.setEffectiveTimeScale(clamp(s / Config.ANIM_WALK_REF, Config.ANIM_TIMESCALE_MIN, Config.ANIM_TIMESCALE_MAX));
      }
      if (act.run) {
        act.run.setEffectiveWeight(wRun);
        act.run.setEffectiveTimeScale(clamp(s / Config.ANIM_RUN_REF, Config.ANIM_TIMESCALE_MIN, Config.ANIM_TIMESCALE_MAX));
      }
      mixer.update(dt);
    },
  };
}

function clamp(v, a, b) {
  return v < a ? a : (v > b ? b : v);
}
function clamp01(v) {
  return clamp(v, 0, 1);
}

// 统一驱动所有玩家模型的骨骼动画：
// 每个模型自己按「位置帧间位移」算速度（低通滤波平滑），调用方不必逐个传速度，
// 于是第一人称（本机）/ 第三人称 / 远端玩家三条路径都只需要主循环里这一处调用。
export function tickPlayerModels(dt) {
  if (!(dt > 0)) return;
  for (let i = models.length - 1; i >= 0; i--) {
    const e = models[i];
    const g = e.group;
    // 已经被移出场景（玩家退房）：从列表里剔掉，否则列表会一直变长、每帧白跑一遍。
    // 用 _hadParent 区分「还没加进场景」和「已经移出场景」，避免刚创建就被误删。
    if (g.parent) e._hadParent = true;
    else if (e._hadParent) { models.splice(i, 1); continue; }
    const rig = e.rig;
    if (!rig || !g.visible) continue; // 没骨骼 / 不可见（第一人称隐藏自身）不浪费 CPU
    if (!e._lastPos) e._lastPos = new THREE.Vector3().copy(g.position);
    const dx = g.position.x - e._lastPos.x;
    const dz = g.position.z - e._lastPos.z;
    e._lastPos.copy(g.position);
    const raw = Math.hypot(dx, dz) / dt;
    // 低通：网络插值抖动/瞬移修正不该传到腿上
    e._speed = (e._speed || 0) + (raw - (e._speed || 0)) * Math.min(1, dt * 8);
    rig.update(dt, e._speed);
  }
}

// 供 ?calib 校准面板调用：实时调整所有玩家模型的朝向与骨架走向（后加载模型同样生效）
export function setDebugYaw(modelDeg, skelDeg) {
  cfg.modelDeg = modelDeg;
  cfg.skelDeg = skelDeg;
  for (const e of models) applyCfg(e);
}

// 读取当前朝向度数，供校准面板显示
export function getDebugYaw() {
  return { modelDeg: cfg.modelDeg, skelDeg: cfg.skelDeg };
}

// 体检：把每个玩家模型的「身体在不在 / 材质朝向 / 坐标」摊开，专治「看得见道具看不见人」。
//   bodyChildren=0        → 身体根本没挂上（GLB 两条路都失败过，或换身体的瞬间被清空）
//   visibleChain=false    → 某一级父节点 visible=false（本地玩家第一人称是故意的）
//   sides 里 0=FrontSide / 1=BackSide / 2=DoubleSide；蒙皮身体本该全是 2
//   pos 与 state 差太多    → 插值/同步把人放到了别处（不是渲染问题）
export function debugPlayerBodies(pm) {
  const rows = [];
  if (!pm || !pm.players) return rows;
  for (const [id, p] of pm.players) {
    const m = p.model;
    if (!m) { rows.push({ id: String(id).slice(0, 8), err: 'no model' }); continue; }
    const bh = m.userData.bodyHolder;
    let meshes = 0; let skinned = 0; let hidden = 0;
    const sides = {};
    m.traverse((o) => {
      if (!o.isMesh) return;
      meshes++;
      if (o.isSkinnedMesh) skinned++;
      if (o.visible === false) hidden++;
      const mm = Array.isArray(o.material) ? o.material[0] : o.material;
      if (mm) sides[mm.side] = (sides[mm.side] || 0) + 1;
    });
    let chain = true;
    for (let o = m; o; o = o.parent) if (o.visible === false) { chain = false; break; }
    const f = (v) => (Number.isFinite(v) ? +v.toFixed(1) : NaN);
    rows.push({
      id: String(id).slice(0, 8),
      local: id === pm.localId,
      vis: chain,
      inScene: !!m.parent,
      pos: [f(m.position.x), f(m.position.y), f(m.position.z)],
      st: [f(p.state.x), f(p.state.y), f(p.state.z)],
      size: p.state.size === undefined ? 1 : p.state.size,
      body: bh ? bh.children.length : -1,
      meshes, skinned, hidden, sides,
      miss: pm.miss ? (pm.miss.get(id) || 0) : 0,
    });
  }
  return rows;
}

// 校准调试：逐帧打印朝向数值（骨架已在烘焙阶段对齐网格，这里只需要看模型整体朝向）
export function debugCalibFrame() {
  for (const e of models) {
    const q = e.faceHolder ? e.faceHolder.rotation.y.toFixed(3) : '-';
    console.log('[YAW frame]', 'model=' + cfg.modelDeg, 'skel=' + cfg.skelDeg, 'holderY=' + q, 'hasRig=' + !!e.rig);
  }
}

// 创建玩家模型；label 为头顶名牌文字（如"玩家1"），gender 决定使用 girl/boy 素材，color 为名牌文字颜色
export function createPlayerModel(label = '', gender = 'boy', color = '#ffffff') {
  const group = new THREE.Group();
  // ⚠ 人物整组不参与「背面剔除收敛」：身体是 SkinnedMesh，骨骼矩阵可能带镜像（负行列式）
  //   把三角形绕向翻掉，而 three 只看 object.matrixWorld 的行列式 ⇒ 收敛成单面后身体会整只消失
  //   （头顶名牌/手持物是独立对象，照样显示 —— 表现为"人在但模型没了"）。
  //   人物占屏像素本来就少，这点填充率收益不值得冒这个险。
  group.userData.noCull = true;

  // ---- 占位身体：GLB 加载前的简单人形，避免一开始就“隐形” ----
  const bodyHolder = new THREE.Group();
  const fallbackBody = _createFallbackBody();
  bodyHolder.add(fallbackBody);
  group.add(bodyHolder);
  group.userData.bodyHolder = bodyHolder;

  // ---- 头顶锚点：名牌挂在头顶上方（不随身体替换而移除）----
  const headAnchor = new THREE.Object3D();
  headAnchor.position.y = NAME_TAG_Y;
  group.add(headAnchor);
  group.userData.headAnchor = headAnchor;

  // ---- 手部锚点：手持物（3D 文字）挂在这里 ----
  const handAnchor = new THREE.Object3D();
  handAnchor.position.set(HAND_POS.x, HAND_POS.y, HAND_POS.z);
  group.add(handAnchor);
  group.userData.handAnchor = handAnchor;

  if (label) {
    headAnchor.add(createNameTag(label, color));
  }

  // ---- 血量条：名牌下方一条 ----
  // 用「一张画布同时画底槽 + 填充」的单 Sprite，而不是底/填充两个 Sprite：
  // 两个 depthTest:false 的透明 Sprite 只能按距离排序，必然互相穿插闪烁。
  // 层级用 renderOrder 固定（名牌 10 → 血条 11 → 手持物 13），并关掉 depthWrite。
  const hpCanvas = document.createElement('canvas');
  hpCanvas.width = HP_CANVAS_W;
  hpCanvas.height = HP_CANVAS_H;
  const hpTex = new THREE.CanvasTexture(hpCanvas);
  hpTex.minFilter = THREE.LinearFilter;
  const hpSprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: hpTex, transparent: true, depthTest: false, depthWrite: false,
  }));
  hpSprite.scale.set(HP_W, HP_H, 1);
  hpSprite.position.y = -0.26;
  hpSprite.renderOrder = 11;
  hpSprite.userData.isHpBar = true; // 供「显示名牌与血条」开关统一隐藏
  hpSprite.visible = healthBarsVisible;
  headAnchor.add(hpSprite);
  const hpBar = { sprite: hpSprite, tex: hpTex, ctx: hpCanvas.getContext('2d'), shown: -1 };
  group.userData.hpBar = hpBar;
  drawHpBar(hpBar.ctx, 1); // 初始满血

  // 注册本次模型条目，并立即构建身体
  const entry = { group, gender, faceHolder: null, rig: null };
  models.push(entry);
  buildBody(entry);

  return group;
}

// 占位人形：身躯 + 头，作为 GLB 加载完成前的兜底，保证玩家一开始可见
function _createFallbackBody() {
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x4a7cba });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.7, 0.3), bodyMat);
  body.position.y = 1.0;

  const headMat = new THREE.MeshStandardMaterial({ color: 0xc7a07c });
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 16), headMat);
  head.position.y = 1.6;

  const holder = new THREE.Group();
  holder.add(body);
  holder.add(head);
  return holder;
}

// 设置玩家模型的体型倍率：只缩放身体（名牌/手持物不跟着放大），并把锚点抬到新的高度
export function setModelScale(group, s) {
  const scale = s > 0 ? s : 1;
  const bh = group.userData.bodyHolder;
  if (bh) bh.scale.setScalar(scale);
  const ha = group.userData.headAnchor;
  if (ha) ha.position.y = NAME_TAG_Y * scale;
  const hand = group.userData.handAnchor;
  if (hand) hand.position.set(HAND_POS.x * scale, HAND_POS.y * scale, HAND_POS.z * scale);
}

// 刷新玩家头顶血量条：比例没变就不重绘（血量只在受伤/回血时变，开销可忽略）
export function setHealthBar(group, hp, max) {
  const bar = group.userData.hpBar;
  if (!bar) return;
  const ratio = max > 0 ? Math.max(0, Math.min(1, hp / max)) : 0;
  const q = Math.round(ratio * 100);
  if (bar.shown === q) return;
  bar.shown = q;
  drawHpBar(bar.ctx, ratio);
  bar.tex.needsUpdate = true;
}

// 统一的「手持物」入口：手部锚点上一次只挂一样东西。
// - wep 非空（'club' / 'gatling' / 'ctrlgun'）时优先挂对应武器模型；
// - wep 为空时才按 text 挂一段文字 Sprite（老逻辑）。
// 用 heldKey 缓存键避免每帧重建；只在 wep / text 变化时重建。
export function setHeldItem(group, wep, text) {
  const hand = group.userData.handAnchor;
  if (!hand) return;
  const w = (wep === 'club' || wep === 'gatling' || wep === 'ctrlgun') ? wep : '';
  group.userData.heldWep = w; // 记下当前武器，供 setHeldText 内部转调时复用
  const key = w ? ('wep:' + w) : ('text:' + (text || ''));
  if (group.userData.heldKey === key) return; // 没变不重建，避免每帧建模型/画布
  group.userData.heldKey = key;
  hand.clear();
  if (w) {
    hand.add(createHeldWeapon(w));
    return;
  }
  if (!text) return;
  hand.add(_createHeldTextSprite(text));
}

// 手持物文字：一段显示在手上的 3D 文字 Sprite（别人与第三人称可见）
function _createHeldTextSprite(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(20,26,38,0.82)';
  ctx.beginPath();
  ctx.roundRect(4, 12, 120, 40, 10);
  ctx.fill();
  ctx.fillStyle = '#ffe08a';
  ctx.font = 'bold 32px "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 64, 33);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthTest: false, depthWrite: false,
  }));
  sp.scale.set(0.6, 0.3, 1);
  sp.renderOrder = 13; // 手持物压在最上层，不与名牌/血条互相穿插
  return sp;
}

// 按种类生成一个握在手上的小武器模型（挂到手部锚点，朝模型正前方 -Z 伸出）
export function createHeldWeapon(kind) {
  const rig = new THREE.Group();
  if (kind === 'club') {
    // 棍子：细长木棍 + 深色头部
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.035, 0.04, 0.75, 8),
      new THREE.MeshStandardMaterial({ color: 0x8b5a2b, roughness: 0.85 })
    );
    shaft.rotation.x = Math.PI / 2; // 圆柱默认沿 Y，转到沿 Z（朝前伸出）
    shaft.position.z = -0.36;
    rig.add(shaft);
    const head = new THREE.Mesh(
      new THREE.BoxGeometry(0.11, 0.11, 0.24),
      new THREE.MeshStandardMaterial({ color: 0x4a4a52, roughness: 0.55 })
    );
    head.position.z = -0.78;
    rig.add(head);
  } else if (kind === 'gatling') {
    // 加特林：枪身 + 握把 + 一圈枪管
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x3c424c, roughness: 0.6, metalness: 0.35 });
    const tubeMat = new THREE.MeshStandardMaterial({ color: 0x22262c, roughness: 0.45, metalness: 0.5 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.13, 0.26), bodyMat);
    body.position.z = -0.14;
    rig.add(body);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.12, 0.06), bodyMat);
    grip.position.set(0, -0.12, 0);
    rig.add(grip);
    const barrels = new THREE.Group();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.34, 8), tubeMat);
      tube.rotation.x = Math.PI / 2; // 圆柱默认沿 Y，转到沿 Z
      tube.position.set(Math.cos(a) * 0.034, Math.sin(a) * 0.034, -0.42);
      barrels.add(tube);
    }
    rig.add(barrels);
    rig.userData.barrels = barrels; // 供 spinHeldBarrels 转枪管（远端玩家开火时由 Game 驱动）
  } else if (kind === 'ctrlgun') {
    // 控制枪：科幻手枪/发射器（枪身 + 较长细枪管 + 前端发光环），青蓝色调
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x31506b, roughness: 0.5, metalness: 0.45 });
    const gripMat = new THREE.MeshStandardMaterial({ color: 0x22303f, roughness: 0.7 });
    const glowMat = new THREE.MeshStandardMaterial({
      color: 0x36d6ff, emissive: 0x36d6ff, emissiveIntensity: 1.2, roughness: 0.3, metalness: 0.2,
    });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.11, 0.2), bodyMat);
    body.position.z = -0.12;
    rig.add(body);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.13, 0.05), gripMat);
    grip.position.set(0, -0.11, -0.02);
    rig.add(grip);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.4, 10), bodyMat);
    barrel.rotation.x = Math.PI / 2; // 圆柱默认沿 Y，转到沿 Z（朝前伸出）
    barrel.position.z = -0.4;
    rig.add(barrel);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.013, 10, 20), glowMat);
    ring.position.z = -0.58; // 前端发光环
    rig.add(ring);
  }
  return rig;
}

// 兼容旧入口：设置手持物文字（内部转调 setHeldItem，武器优先于文字）
export function setHeldText(group, text) {
  setHeldItem(group, group.userData.heldWep || '', text);
}

// 远端玩家开火期间把他手里加特林的枪管转起来。
// 本地那把由 Game._updateGatling 直接驱动（它握在第一人称 rig 上），这里只服务「别人手里的枪」——
// 远端模型没有逐帧动画来源，只能靠收到的开火消息推一小段。
export function spinHeldBarrels(group, dt) {
  const hand = group && group.userData ? group.userData.handAnchor : null;
  const rig = hand && hand.children.length ? hand.children[0] : null;
  const barrels = rig && rig.userData ? rig.userData.barrels : null;
  if (barrels) barrels.rotation.z += dt * 22; // 与本地枪管同一个转速常量
}

// 生成一个始终面向相机的文字名牌 Sprite（Canvas 文本贴图）；color 控制昵称文字颜色（默认白）
export function createNameTag(text, color = '#ffffff') {
  const canvas = document.createElement('canvas');
  const w = 256;
  const h = 72;
  canvas.width = w;
  canvas.height = h;

  const ctx = canvas.getContext('2d');
  // 半透明深色圆角背景，衬托文字
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.beginPath();
  ctx.roundRect(8, 8, w - 16, h - 16, 16);
  ctx.fill();
  // 昵称颜色（默认白）
  ctx.fillStyle = color;
  ctx.font = 'bold 44px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2 + 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false, // 名牌始终可见，不被遮挡
    depthWrite: false, // 不写深度，避免与血量条等其它 Sprite 互相穿插
  });

  const sprite = new THREE.Sprite(material);
  sprite.scale.set(1.6, 0.45, 1);
  sprite.renderOrder = 10; // 名牌在最底层，血量条压在其上
  sprite.userData.isNameTag = true; // 供「显示名牌」开关统一隐藏
  sprite.visible = nameTagsVisible;
  return sprite;
}

// 全局开关：是否显示玩家头顶的名牌与血量条
let nameTagsVisible = true;
let healthBarsVisible = true;

function applyHeadVisibility(group) {
  const anchor = group && group.userData && group.userData.headAnchor;
  if (!anchor) return;
  for (const child of anchor.children) {
    if (child.isSprite && child.userData.isNameTag) child.visible = nameTagsVisible;
    if (child.userData.isHpBar) child.visible = healthBarsVisible;
  }
}

export function setNameTagsVisible(v) {
  nameTagsVisible = !!v;
  for (const e of models) applyHeadVisibility(e.group);
}

export function setHealthBarsVisible(v) {
  healthBarsVisible = !!v;
  for (const e of models) applyHeadVisibility(e.group);
}

export function getNameTagsVisible() {
  return nameTagsVisible;
}

// 就地替换玩家头顶名牌（拿到登录资料后刷新昵称/颜色用）；text 为空则移除名牌
export function updateNameTag(group, text, color = '#ffffff') {
  const anchor = group.userData.headAnchor;
  if (!anchor) return;
  // 只移除旧名牌：不能 anchor.clear()，否则会把同挂在头顶锚点下的血量条一起清掉
  for (const child of [...anchor.children]) {
    if (child.userData && child.userData.isNameTag) anchor.remove(child);
  }
  if (text) anchor.add(createNameTag(text, color));
}