// 职责：定义玩家的“外观”模型（身体 + 头 + 头顶名牌）。只负责造型，不做逻辑。
// 模型原点定在“脚底”，身体与头部向上生长，总高度约 1.8 米，与相机（PLAYER_HEIGHT=1.7）大致对齐。
import * as THREE from 'three';

// 创建玩家模型；label 为头顶名牌文字（如"玩家1"），为空则不加名牌
export function createPlayerModel(label = '') {
  const group = new THREE.Group();

  // ---- 身体：立方体躯干，从腰到肩 ----
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x4a7cba });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.7, 0.3), bodyMat);
  body.position.y = 1.0; // 躯干范围约 0.65~1.35（脚底在 0）
  group.add(body);

  // ---- 头：球，中心约在眼睛高度，不再高出相机 ----
  const headMat = new THREE.MeshStandardMaterial({ color: 0xc7a07c });
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 16), headMat);
  head.position.y = 1.6; // 头范围 1.44~1.76，略高于躯干
  group.add(head);

  // ---- 头顶锚点：名牌挂在头顶上方 ----
  const headAnchor = new THREE.Object3D();
  headAnchor.position.y = 2.0;
  group.add(headAnchor);
  group.userData.headAnchor = headAnchor;

  // 需要名牌时挂在锚点上
  if (label) {
    headAnchor.add(createNameTag(label));
  }

  return group;
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