// 职责：校园里的学生 NPC（服务端权威，客户端只负责插值显示）。
// - 名单由服务端 npc_roster 下发（姓名/班级/性别），位置由 5Hz 的 npc 广播持续更新；
// - 客户端做的是「平滑跟随」：本地位置向服务端坐标缓动，避免 200ms 一跳的顿挫感；
// - 走路/站立动画按本地实际位移速度混合（不需要服务端发动状态）；
// - 头顶名牌显示「姓名 · 班级」，说话/心理活动用气泡显示几秒后自动消失。
//
// ⚠ 单位与协议（与 server-remote/npcworld.js 对齐，改一端必须同步另一端）：
//   坐标米、rot 是**度**、st 只有 'idle' | 'walk' | 'act' 三种。
import * as THREE from 'three';
import { instantiateRigged } from './AssetLoader.js';
import { attachFakeShadow } from './FakeShadow.js';

// ⚠ 必须用带骨骼的 -rig 版本（tools/auto-rig.mjs 生成）：原版 boy/girl.glb 没有骨骼也没有动画，
//   加载出来是个立牌 —— 表现就是"只会平移、没有走路动作"。
const MODEL = { m: '/assets/boy-rig.glb', f: '/assets/girl-rig.glb' };
// ⚠ 模型正面偏 90°，与 PlayerModel 的 cfg.modelDeg 必须一致（那边真机校准过的值）。
//   少了它，学生会侧着身子走。
const MODEL_DEG = 90;
const FOLLOW_LAMBDA = 6;      // 位置缓动系数：越大越贴服务端（太大会抖，太小会拖影）
const ROT_LAMBDA = 8;         // 朝向缓动
const TALK_RANGE = 3.2;       // 多近才能搭话（米）
const BUBBLE_SEC = 5;         // 气泡停留时长（秒）
const REF_SPEED = 1.25;       // walk 动画播满速对应的速度（与服务端 WALK_SPEED 一致）

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
      x: 0, z: 0, rot: 0,
      st: 'idle',
      speed: 0,
    };
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
      s.tx = Number(it.x) || 0;
      s.tz = Number(it.z) || 0;
      s.trot = Number(it.rot) || 0;
      if (!s.model) {
        s.x = s.tx; s.z = s.tz; s.rot = s.trot;
        s.holder.position.set(s.x, 0, s.z);
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
      const nx = Number(it.x);
      const nz = Number(it.z);
      // NaN 防线：服务端坐标一旦是 NaN，整个模型会消失且射线打不到（见项目记忆第 7 条）
      if (!Number.isFinite(nx) || !Number.isFinite(nz)) continue;
      s.tx = nx;
      s.tz = nz;
      s.trot = Number(it.rot) || 0;
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
      const d = Math.hypot(s.x - px, s.z - pz);
      if (d <= bestD) { bestD = d; best = s; }
    }
    return best;
  }

  function update(dt) {
    const now = performance.now() / 1000;
    const kp = 1 - Math.exp(-FOLLOW_LAMBDA * dt);
    const kr = 1 - Math.exp(-ROT_LAMBDA * dt);
    for (const s of byId.values()) {
      const dx = s.tx - s.x;
      const dz = s.tz - s.z;
      const stepX = dx * kp;
      const stepZ = dz * kp;
      s.x += stepX;
      s.z += stepZ;
      // 朝向：走最短弧（避免 350° → 10° 时整只转一大圈）
      let dr = ((s.trot - s.rot + 540) % 360) - 180;
      s.rot += dr * kr;
      s.holder.position.set(s.x, 0, s.z);
      s.holder.rotation.y = (s.rot * Math.PI) / 180;
      // 动画：按本地实际速度混合 idle/walk
      const speed = dt > 0 ? Math.hypot(stepX, stepZ) / dt : 0;
      s.speed = speed;
      if (s.mixer) {
        s.mixer.update(dt);
        if (s.act) {
          const w = Math.max(0, Math.min(1, speed / REF_SPEED));
          if (s.act.idle) s.act.idle.setEffectiveWeight(1 - w);
          if (s.act.walk) s.act.walk.setEffectiveWeight(w);
        }
      }
      if (s.bubble && s.bubble.spr.visible && now > s.bubbleUntil) s.bubble.spr.visible = false;
      // 名牌始终面向相机由 Sprite 自动保证；走动时略微下压名牌避免和气泡叠在一起
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
