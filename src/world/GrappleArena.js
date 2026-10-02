// 职责：为「疯狂抓钩」模式构建独立场景——底部岩浆 + 一片柱子林 + 6 个起始平台。
// 这里只有外观与几何，不含玩法（金币生成/吃金币/岩浆判负在 Game.js 里）。
//
// 两条必须守住的约定：
// 1) 布局必须**确定性**：所有客户端都用同一组坐标（固定种子），否则你勾到的柱子和别人看到的不是同一根，
//    房主广播的金币坐标也会落在别人眼里的空处。因此这里用固定种子的 mulberry32，禁止 Math.random。
// 2) 起始平台坐标写死在 START_PLATFORMS，并与服务端 grappleSpawnForIndex 保持一致（服务端不构建场景，
//    只按同一套坐标发 spawn，所以那几行必须手动同步）。
import * as THREE from 'three';
import { Config } from '../config.js';

// 起始平台：半径 15 的六边形，顶面高度 6m。服务端 arenaSpawn 用的是同一组公式。
export const GRAPPLE_SPAWN_RADIUS = 15;
export const GRAPPLE_SPAWN_TOP_Y = 6;
export const GRAPPLE_SPAWN_COUNT = 6;

// 固定种子随机数（整数运算 → 各端结果完全一致）
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rnd() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 柱子林布局：返回 [{ x, z, topY, half }]，可复用于碰撞体/金币落点
export function buildPillarLayout() {
  const rnd = mulberry32(20261002);
  const half = Config.GRAPPLE_ARENA_HALF;
  const limit = half - 2.5; // 柱子中心的最大范围（留出墙厚）
  const list = [];
  const want = Config.GRAPPLE_PILLAR_COUNT;
  let guard = 0;
  while (list.length < want && guard < 2000) {
    guard++;
    const x = (rnd() * 2 - 1) * limit;
    const z = (rnd() * 2 - 1) * limit;
    const r = Math.hypot(x, z);
    if (r < 4) continue;          // 中心留空，避免挡住视线
    if (r > limit - 1) continue;  // 贴边的不要
    // 和起始平台圆环（半径 15）错开，别把出生点埋在柱子里
    if (Math.abs(r - GRAPPLE_SPAWN_RADIUS) < 3) continue;
    // 柱子之间保持间距，避免连成一堵墙
    let tooClose = false;
    for (const p of list) {
      if (Math.hypot(p.x - x, p.z - z) < 5.2) { tooClose = true; break; }
    }
    if (tooClose) continue;
    const topY = 2.6 + rnd() * 6.8;   // 顶面高度 2.6 ~ 9.4m
    const hs = 0.95 + rnd() * 0.65;   // 顶面半边长
    list.push({ x, z, topY, half: hs });
  }
  return list;
}

// 构建场景：返回 { group, colliders, half, tops, dispose }
export function buildGrappleArena(scene) {
  const group = new THREE.Group();
  group.name = 'grapple-arena';
  const colliders = [];
  const half = Config.GRAPPLE_ARENA_HALF;

  // ---- 底部岩浆：与物理地面同高（踩到地面＝落进岩浆）----
  const magma = new THREE.Mesh(
    new THREE.PlaneGeometry(half * 2, half * 2),
    new THREE.MeshStandardMaterial({
      color: 0xff5a1e, emissive: 0xff3b00, emissiveIntensity: 1.15, roughness: 0.55, metalness: 0.1,
    })
  );
  magma.rotation.x = -Math.PI / 2;
  magma.position.y = 0.03;
  group.add(magma);

  // 岩浆上的亮斑：给一点「翻滚」的层次感（静态贴片，不参与逻辑）
  const spotMat = new THREE.MeshBasicMaterial({ color: 0xffd24a, transparent: true, opacity: 0.5, depthWrite: false });
  const rnd = mulberry32(777);
  for (let i = 0; i < 26; i++) {
    const r = 0.6 + rnd() * 1.7;
    const spot = new THREE.Mesh(new THREE.CircleGeometry(r, 10), spotMat);
    spot.rotation.x = -Math.PI / 2;
    spot.position.set((rnd() * 2 - 1) * (half - 2), 0.06, (rnd() * 2 - 1) * (half - 2));
    group.add(spot);
  }

  // ---- 四面高墙：既是边界，也是抓钩的好靶子 ----
  const wallH = 14;
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x3b4a6b, roughness: 0.85, metalness: 0.12 });
  const t = 1;
  const addWall = (cx, cz, hx, hz) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, wallH, hz * 2), wallMat);
    mesh.position.set(cx, wallH / 2, cz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    colliders.push({ cx, cy: wallH / 2, cz, hx, hy: wallH / 2, hz });
  };
  addWall(0, -half, half, t);
  addWall(0, half, half, t);
  addWall(-half, 0, t, half);
  addWall(half, 0, t, half);

  // ---- 6 个起始平台：半径 15 的六边形，顶面 6m（服务端同公式发 spawn）----
  const platMat = new THREE.MeshStandardMaterial({ color: 0x4d6a9c, roughness: 0.8, metalness: 0.15 });
  const rimMat = new THREE.MeshStandardMaterial({ color: 0x7fd0ff, emissive: 0x2a6f9c, emissiveIntensity: 0.7 });
  for (let k = 0; k < GRAPPLE_SPAWN_COUNT; k++) {
    const ang = (k / GRAPPLE_SPAWN_COUNT) * Math.PI * 2;
    const x = Math.cos(ang) * GRAPPLE_SPAWN_RADIUS;
    const z = Math.sin(ang) * GRAPPLE_SPAWN_RADIUS;
    const s = 3;
    const h = GRAPPLE_SPAWN_TOP_Y;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(s * 2, h, s * 2), platMat);
    mesh.position.set(x, h / 2, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    colliders.push({ cx: x, cy: h / 2, cz: z, hx: s, hy: h / 2, hz: s });
    // 顶面一圈发光边，落下时更清楚站在哪
    const rim = new THREE.Mesh(new THREE.BoxGeometry(s * 2 + 0.3, 0.14, s * 2 + 0.3), rimMat);
    rim.position.set(x, h, z);
    group.add(rim);
  }

  // ---- 柱子林：抓钩的主要落点 ----
  const tops = []; // 供金币生成用：每根柱子的顶面中心
  const pillars = buildPillarLayout();
  const pillarMat = new THREE.MeshStandardMaterial({ color: 0x6b5a86, roughness: 0.88, metalness: 0.08 });
  const topMat = new THREE.MeshStandardMaterial({ color: 0x9a86c4, roughness: 0.7, emissive: 0x2c2340, emissiveIntensity: 0.6 });
  for (const p of pillars) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(p.half * 2, p.topY, p.half * 2), pillarMat);
    mesh.position.set(p.x, p.topY / 2, p.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    colliders.push({ cx: p.x, cy: p.topY / 2, cz: p.z, hx: p.half, hy: p.topY / 2, hz: p.half });
    const cap = new THREE.Mesh(new THREE.BoxGeometry(p.half * 2 + 0.24, 0.16, p.half * 2 + 0.24), topMat);
    cap.position.set(p.x, p.topY, p.z);
    group.add(cap);
    tops.push({ x: p.x, y: p.topY, z: p.z });
  }

  scene.add(group); // 必须真正加入场景，否则地板/柱子都不会渲染

  return {
    group,
    colliders,
    half,
    tops,
    dispose() {
      scene.remove(group);
      group.traverse((o) => {
        if (o.geometry && typeof o.geometry.dispose === 'function') o.geometry.dispose();
        const mat = o.material;
        if (Array.isArray(mat)) mat.forEach((m) => m && typeof m.dispose === 'function' && m.dispose());
        else if (mat && typeof mat.dispose === 'function') mat.dispose();
      });
    },
  };
}
