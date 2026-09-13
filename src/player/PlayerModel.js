// 职责：定义玩家的“外观”。

// 模型 = 人物 GLB（girl/boy）+ 头顶名牌。GLB 异步加载，加载前先用缩小版占位身体保证即时可见。
// 人物 GLB 高约 1m 且垂直居中，放大到 1.8（PLAYER_HEIGHT 附近）并上移半个高度，让脚底落在 y=0。
// 名牌挂在头顶锚点，随模型一起被隐藏/移除。
import * as THREE from 'three';
import { instantiate } from '../world/AssetLoader.js';
import { autoRig } from './AutoRig.js';

const MODEL_HEIGHT = 1.8;      // 人物目标高度（米），与相机高度 PLAYER_HEIGHT 大致对齐
const NAME_TAG_Y = 2.05;       // 名牌锚点高度（在头顶上方）
// 模型本征正面沿 -X（脚趾方向实测），而 three 的“前”约定为 -Z；绕 Y 旋转 -90° 把正面转到 -Z，
// 让角色朝向与移动方向、第三人称相机一致。
const MODEL_YAW = -Math.PI / 2;

// 创建玩家模型；label 为头顶名牌文字（如"玩家1"），gender 决定使用 girl/boy 素材，为空则不挂名牌
export function createPlayerModel(label = '', gender = 'boy') {
  const group = new THREE.Group();

  // ---- 占位身体：GLB 加载前的简单人形，避免一开始就“隐形” ----
  const bodyHolder = new THREE.Group();
  const fallbackBody = _createFallbackBody();
  bodyHolder.add(fallbackBody);
  group.add(bodyHolder);

  // ---- 头顶锚点：名牌挂在头顶上方（不随身体替换而移除）----
  const headAnchor = new THREE.Object3D();
  headAnchor.position.y = NAME_TAG_Y;
  group.add(headAnchor);
  group.userData.headAnchor = headAnchor;

  if (label) {
    headAnchor.add(createNameTag(label));
  }

  // ---- 异步加载人物 GLB：成功则尝试自动上骨骼并播放动画，失败则保留占位身体 ----
  instantiate(`/assets/${gender}.glb`)
    .then((model) => {
      const holder = new THREE.Group();
      holder.rotation.y = MODEL_YAW; // 把人物正面转到 three 的“前”(-Z)

      // 自动绑定简易骨骼（把烘焙到脚踩地/身高=MODEL_HEIGHT 的几何蒙皮到骨骼），失败则用静态模型
      const rig = autoRig(model, MODEL_HEIGHT);
      if (rig) {
        holder.add(rig.group);
        holder.userData.rig = rig; // 供每帧按移动速度驱动行走动画
      } else {
        model.scale.setScalar(MODEL_HEIGHT);
        model.position.y = MODEL_HEIGHT / 2;
        holder.add(model);
      }
      bodyHolder.clear();
      holder.receiveShadow = true;
      bodyHolder.add(holder);
      group.userData.rig = holder.userData.rig;
    })
    .catch(() => {
      // 加载失败：保留占位身体即可
    });

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