// 职责：出生点旁的「AI 商人 NPC」。
// 1. 在配置坐标搭一个商人形象；2. 每帧检测玩家距离，靠近时通过 onRange 通知 Game 显隐对话选项卡；
// 3. 玩家靠近按 F 时触发 onInteract 回调（由 Game 打开对话面板）。不产生物理碰撞体。
import * as THREE from 'three';
import { Config } from '../config.js';
import { instantiate } from './AssetLoader.js';
import { attachFakeShadow } from '../world/FakeShadow.js';



// 建商人形象：用与玩家同款 boy 模型（静态显示，不绑定骨骼动画），出场即吸引注意。
// 名牌已按要求移除，识别靠屏幕右侧的「按 F 与她对话」选项卡。
function buildMerchant() {
  const g = new THREE.Group();

  // 玩家同款 boy 模型：按包围盒等比缩放到 NPC 身高、脚底 y=0，静态展示
  instantiate('/assets/boy.glb')
    .then((model) => {
      const box = new THREE.Box3();
      model.traverse((o) => {
        if (o.isMesh) {
          o.geometry.computeBoundingBox();
          box.expandByObject(o);
        }
      });
      const sizeY = box.max.y - box.min.y;
      const s = sizeY > 1e-4 ? 1.8 / sizeY : 1.8;
      model.scale.setScalar(s);
      model.position.y = -box.min.y * s; // 底边压到 y=0
      model.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      g.add(model);
      attachFakeShadow(g, { radius: 0.5 }); // 假阴影
    })
    .catch(() => { /* boy GLB 加载失败：模型留白即可 */ });

  return g;
}

// AiNpc(api)：注入一个 API 实例以获取目标文件名等；这里保持独立。
export function createAiNpc() {
  const pos = Config.NPC_POS;
  const merchant = buildMerchant();
  merchant.position.set(pos.x, 0, pos.z);

  let inRange = false;
  let onInteract = null;
  let onRange = null; // 进出范围回调：(inRange:boolean)=>void，由 Game 用来显隐「与阿花对话」选项卡

  function checkRange(px, pz) {
    const d = Math.hypot(px - pos.x, pz - pos.z);
    const now = d <= Config.NPC_PROXIMITY;
    if (now !== inRange) {
      inRange = now;
      if (onRange) onRange(now);
    }
    return now;
  }

  const keyHandler = (e) => {
    if (e.code !== Config.NPC_KEY) return;
    // 有输入框在打字或已开面板时不重复触发，交给面板自身管理
    if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) return;
    if (inRange && onInteract) onInteract();
  };
  window.addEventListener('keydown', keyHandler);

  function setInteract(fn) { onInteract = fn; }

  function update(dt, px, pz) {
    checkRange(px, pz);
    merchant.rotation.y += dt * 0.6; // 缓慢自转吸引注意力（仅视觉）
  }

  function dispose() {
    window.removeEventListener('keydown', keyHandler);
  }

  return {
    group: merchant,
    update,
    setInteract,
    onRange: (fn) => { onRange = fn; },
    setVisible(v) { merchant.visible = v; },
    dispose,
  };
}