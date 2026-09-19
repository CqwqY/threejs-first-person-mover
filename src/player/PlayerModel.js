// 职责：定义玩家的“外观”。

// 模型 = 人物 GLB（girl/boy，原模型自带正确贴图/UV）+ 头顶名牌。GLB 异步加载，加载前先用缩小版占位身体保证即时可见。
// 按包围盒等比缩放到 1.8 并让脚底落在 y=0；静态模型，不做骨骼动画，朝向由 applyCfg/modelDeg 控制。
import * as THREE from 'three';
import { instantiate } from '../world/AssetLoader.js';

const MODEL_HEIGHT = 1.8;      // 人物目标高度（米），与相机高度 PLAYER_HEIGHT 大致对齐
const NAME_TAG_Y = 2.05;       // 名牌锚点高度（在头顶上方）
const DEG = Math.PI / 180;

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

// 构建一个模型的“身体”：加载 GLB（原模型自带正确贴图/UV），按包围盒等比缩放到 MODEL_HEIGHT、脚底落在 y=0。
// 静态模型，不做骨骼动画；朝向由 applyCfg/modelDeg 控制。
function buildBody(entry) {
  return instantiate(`/assets/${entry.gender}.glb`)
    .then((model) => {
      // 按世界坐标包围盒等比缩放，让身高=MODEL_HEIGHT、脚底 y=0
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

      entry.root = null;
      entry.pivots = [];
      entry.skinnedMesh = null;

      const holder = new THREE.Group();
      holder.add(model);
      holder.receiveShadow = true;

      const bodyHolder = entry.group.userData.bodyHolder;
      bodyHolder.clear();
      bodyHolder.add(holder);
      entry.group.userData.rig = null;
      entry.faceHolder = holder;
      applyCfg(entry);
    })
    .catch(() => {
      // 加载失败：保留占位身体即可
    });
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

// 创建玩家模型；label 为头顶名牌文字（如"玩家1"），gender 决定使用 girl/boy 素材，为空则不挂名牌
export function createPlayerModel(label = '', gender = 'boy') {
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

  if (label) {
    headAnchor.add(createNameTag(label));
  }

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

// 生成一个始终面向相机的文字名牌 Sprite（Canvas 文本贴图）
export function createNameTag(text) {
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
  // 白色文字
  ctx.fillStyle = '#ffffff';
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
  });

  const sprite = new THREE.Sprite(material);
  sprite.scale.set(1.6, 0.45, 1);
  return sprite;
}