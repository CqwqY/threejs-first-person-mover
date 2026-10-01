// 职责：站在 (-12,144) 的商人「小满」。用女生模型（girl.glb）。
// 玩家靠近时通过 onRange 通知 Game 显示「找小满买东西」按钮，点击即可打开商店。
// 纯展示，不产生物理碰撞体，也不主动发起交互（交互入口统一在屏幕上的按钮）。
import * as THREE from 'three';
import { Config } from '../config.js';
import { instantiate } from './AssetLoader.js';

export function createMerchant() {
  const pos = Config.MERCHANT_POS;
  const group = new THREE.Group();
  group.position.set(pos.x, 0, pos.z);
  group.rotation.y = Config.MERCHANT_YAW;

  instantiate(Config.MERCHANT_MODEL)
    .then((model) => {
      // 按包围盒等比缩放到设定身高、脚底压到 y=0，静态展示（不绑骨骼动画）
      const box = new THREE.Box3();
      model.traverse((o) => {
        if (o.isMesh) {
          o.geometry.computeBoundingBox();
          box.expandByObject(o);
        }
      });
      const sizeY = box.max.y - box.min.y;
      const s = sizeY > 1e-4 ? Config.MERCHANT_HEIGHT / sizeY : Config.MERCHANT_HEIGHT;
      model.scale.setScalar(s);
      model.position.y = -box.min.y * s;
      model.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      group.add(model);
    })
    .catch((e) => {
      console.warn('[merchant] 商人模型加载失败:', e);
    });

  let inRange = false;
  let onRange = null;
  let t = 0;

  function checkRange(px, pz) {
    const now = Math.hypot(px - pos.x, pz - pos.z) <= Config.MERCHANT_PROXIMITY;
    if (now !== inRange) {
      inRange = now;
      if (onRange) onRange(now);
    }
  }

  function update(dt, px, pz) {
    checkRange(px, pz);
    t += dt;
    group.rotation.y = Config.MERCHANT_YAW + Math.sin(t * 0.55) * 0.25; // 轻微左右张望
  }

  return {
    group,
    update,
    onRange: (fn) => { onRange = fn; },
  };
}
