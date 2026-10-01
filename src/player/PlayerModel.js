// 职责：定义玩家的“外观”。

// 模型 = 人物 GLB（girl/boy，原模型自带正确贴图/UV）+ 头顶名牌。GLB 异步加载，加载前先用缩小版占位身体保证即时可见。
// 按包围盒等比缩放到 1.8 并让脚底落在 y=0；静态模型，不做骨骼动画，朝向由 applyCfg/modelDeg 控制。
import * as THREE from 'three';
import { instantiate } from '../world/AssetLoader.js';
// import { Config } from '../config.js'; // （移动时疯狂旋转功能临时注释，重开时取消这行）

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
// skelDeg ：骨架绕 Y 的走向。骨架是身体形变的来源，直接转它会把身体一起带走；
//            因此用「根骨位置」做支点对蒙皮网格反向补偿：骨架转多少、网格绕同一支点反向转多少，
//            静止时身体纹丝不动，仅走路/摆臂平面随骨架走向变化。
const cfg = { modelDeg: 90, skelDeg: 0 };
const models = []; // 已创建模型条目 {group, gender, faceHolder, root, pivots}

// 把给定模型的朝向同步到当前 cfg 配置
function applyCfg(e) {
  if (e.faceHolder) e.faceHolder.rotation.y = cfg.modelDeg * DEG; // 模型整体朝向
  if (e.root) {
    e.root.rotation.y = cfg.skelDeg * DEG;         // 骨架走向（绕根骨位置）
    for (const p of e.pivots) p.rotation.y = -cfg.skelDeg * DEG; // 蒙皮网格同支点反向补偿
  }
  if (window.__YAW_DEBUG__) {
    console.log(
      '[YAW apply]',
      'model=' + cfg.modelDeg, 'skel=' + cfg.skelDeg,
      'rootY=' + (e.root ? e.root.rotation.y.toFixed(3) : '-'),
      'pivotY=' + (e.pivots.length ? e.pivots[0].rotation.y.toFixed(3) : '-'),
      'pivotCount=' + e.pivots.length,
      'hasMesh=' + !!e.skinnedMesh
    );
  }
}

// 构建一个模型的“身体”：加载 GLB，优先用 AutoRig 绑定骨骼（让角色走/待机），
// 失败则回退为静态等比缩放；朝向统一由 applyCfg/modelDeg 控制。
function buildBody(entry) {
  return instantiate(`/assets/${entry.gender}.glb`)
    .then((model) => {
      entry.root = null;
      entry.pivots = [];
      entry.skinnedMesh = null;
      entry.group.userData.rig = null;
      entry.faceHolder = null;

      const bodyHolder = entry.group.userData.bodyHolder;
      bodyHolder.clear();

      // 静态显示：无骨骼、无动画。按包围盒等比缩放到身高、脚底压到 y=0。
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
      model.position.y = -box.min.y * scale; // 底边压到 y=0
      const holder = new THREE.Group();
      holder.add(model);
      holder.receiveShadow = true;
      bodyHolder.add(holder);
      entry.faceHolder = holder;

      applyCfg(entry);
    })
    .catch(() => {
      // 加载失败：保留占位身体即可
    });
}

// ---- 移动时让模型疯狂旋转【已临时注释，重开时取消注释并恢复 PlayerModel 的 Config 导入】----
// // 移动时让模型疯狂旋转：按移动速度推进自转角（弧度），站着不动就冻结在当前角度。
// // 转过的角度只作为「朝向的临时偏移」叠加，不写回任何状态，所以停下时朝向不会被带偏。
// export function advanceSpin(group, speed, dt) {
//   const u = group.userData;
//   if (speed > Config.MODEL_SPIN_MIN_SPEED) {
//     const k = Math.min(speed / Config.MOVE_SPEED, 2);
//     u.spin = (u.spin || 0) + Config.MODEL_SPIN_SPEED * k * dt;
//   }
//   return u.spin || 0;
// }

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

// 校准调试：逐帧打印关键数值，用来定位「改骨架时模型是否跟着动」。
// 观察：站定时拖 skel，若 meshQ 基本不变且 rootY/pivotY 相加≈0，则补偿生效、身体不动；
//       若 meshQ 随 skel 明显变化，说明补偿没抵消（pivot 没包上/支点不对）。
export function debugCalibFrame() {
  for (const e of models) {
    const q = e.skinnedMesh ? e.skinnedMesh.getWorldQuaternion(new THREE.Quaternion()) : null;
    const rootY = e.root ? e.root.rotation.y.toFixed(3) : '-';
    const pivY = e.pivots.length ? e.pivots[0].rotation.y.toFixed(3) : '-';
    const qs = q ? `[${q.x.toFixed(2)},${q.y.toFixed(2)},${q.z.toFixed(2)},${q.w.toFixed(2)}]` : 'no-mesh';
    console.log(
      '[YAW frame]', 'skel=' + cfg.skelDeg,
      'rootY=' + rootY, 'pivotY=' + pivY,
      'meshQ=' + qs, 'pivotCount=' + e.pivots.length
    );
  }
}

// 创建玩家模型；label 为头顶名牌文字（如"玩家1"），gender 决定使用 girl/boy 素材，color 为名牌文字颜色
export function createPlayerModel(label = '', gender = 'boy', color = '#ffffff') {
  const group = new THREE.Group();

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
  headAnchor.add(hpSprite);
  const hpBar = { sprite: hpSprite, tex: hpTex, ctx: hpCanvas.getContext('2d'), shown: -1 };
  group.userData.hpBar = hpBar;
  drawHpBar(hpBar.ctx, 1); // 初始满血

  // 注册本次模型条目，并立即构建身体
  const entry = { group, gender, faceHolder: null, root: null, pivots: [], skinnedMesh: null };
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

// 设置手持物：一段显示在手上的 3D 文字（别人与第三人称可见）；text 为空则清空手持
export function setHeldText(group, text) {
  const hand = group.userData.handAnchor;
  if (!hand) return;
  const cur = group.userData.heldText || '';
  if (cur === text) return; // 文字没变不重建，避免每帧建画布
  group.userData.heldText = text;
  hand.clear();
  if (!text) return;
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
  hand.add(sp);
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

// 全局开关：是否显示玩家头顶名牌（血量条不受影响）
let nameTagsVisible = true;
export function setNameTagsVisible(v) {
  nameTagsVisible = !!v;
  for (const e of models) {
    const anchor = e.group && e.group.userData.headAnchor;
    if (!anchor) continue;
    for (const child of anchor.children) {
      if (child.isSprite && child.userData.isNameTag) child.visible = nameTagsVisible;
    }
  }
}
export function getNameTagsVisible() {
  return nameTagsVisible;
}

// 就地替换玩家头顶名牌（拿到登录资料后刷新昵称/颜色用）；text 为空则移除名牌
export function updateNameTag(group, text, color = '#ffffff') {
  const anchor = group.userData.headAnchor;
  if (!anchor) return;
  anchor.clear(); // 释放旧名牌子对象
  if (text) anchor.add(createNameTag(text, color));
}