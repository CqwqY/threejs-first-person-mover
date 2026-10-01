// 职责：出生点旁的「AI 商人 NPC」。
// 1. 在配置坐标搭一个简单商人形象 + 名牌；2. 每帧检测玩家距离，靠近显示「按 E 对话」提示；
// 3. 玩家靠近按 E 时触发 onInteract 回调（由 Game 打开对话面板）。不产生物理碰撞体。
import * as THREE from 'three';
import { Config } from '../config.js';
import { instantiate } from './AssetLoader.js';

let styleInjected = false;
function injectStyle() {
  if (styleInjected || typeof document === 'undefined') return;
  styleInjected = true;
  const st = document.createElement('style');
  st.textContent = `
    .npc-hint {
      position: fixed; top: 18%; left: 50%; transform: translateX(-50%); z-index: 9000;
      background: rgba(0,0,0,.7); color: #fff; padding: 7px 14px; border-radius: 20px;
      font: 13px/1.4 system-ui, "Microsoft YaHei", sans-serif; pointer-events: none;
      box-shadow: 0 4px 16px rgba(0,0,0,.3);
    }
    .npc-hint.hidden { display: none; }
    .npc-hint b { color: #ffd479; }
  `;
  document.head.appendChild(st);
}

// 建商人形象：用与玩家同款 boy 模型（静态显示，不绑定骨骼动画），外加上方名牌，出场即吸引注意。
function buildMerchant() {
  const g = new THREE.Group();

  // 名牌：挂在头上方
  const sprite = makeLabel('阿花 · 物品商人', 1.7);
  sprite.position.y = 2.2;
  g.add(sprite);

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
    })
    .catch(() => { /* boy GLB 加载失败：保留名牌即可 */ });

  return g;
}

function makeLabel(text, scale) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 72;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.beginPath();
  ctx.roundRect(8, 8, 240, 56, 16);
  ctx.fill();
  ctx.fillStyle = '#7fd0ff';
  ctx.font = 'bold 34px "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 36 + 2);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(scale * 1.6, scale * 0.45, 1);
  return sp;
}

// AiNpc(api)：注入一个 API 实例以获取目标文件名等；这里保持独立。
export function createAiNpc() {
  injectStyle();

  const pos = Config.NPC_POS;
  const merchant = buildMerchant();
  merchant.position.set(pos.x, 0, pos.z);

  const hint = document.createElement('div');
  hint.className = 'npc-hint hidden';
  hint.innerHTML = '靠近 <b>阿花</b> · 按 <b>E</b> 与她对话';
  document.body.appendChild(hint);

  let inRange = false;
  let onInteract = null;

  function checkRange(px, pz) {
    const d = Math.hypot(px - pos.x, pz - pos.z);
    const wasIn = inRange;
    inRange = d <= Config.NPC_PROXIMITY;
    hint.classList.toggle('hidden', !inRange);
    return !wasIn && inRange;
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
    hint.remove();
  }

  return {
    group: merchant,
    hint,
    update,
    setInteract,
    setVisible(v) { merchant.visible = v; },
    dispose,
  };
}