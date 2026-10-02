// 职责：为一对一/混战模式构建「单独的竞技场」场景。
// 在原点铺一块 32×32 的场地（地贴 + 网格 + 边界警戒环 + 四面墙 + 掩体箱 + 中央高台），
// 返回可整体加入/移除的 group 与适配现有物理的 AABB 碰撞体数组。
// 只处理外观与几何，不含任何玩法逻辑（陨石/胜负结算在 Game.js 里）。
import * as THREE from 'three';
import { Config } from '../config.js';

// 竞技场碰撞体统一为世界空间 AABB：{cx,cy,cz,hx,hy,hz}（与 buildEditorBuildings 的盒格式一致）
export function buildArena(scene) {
  const group = new THREE.Group();
  group.name = 'combat-arena';
  const colliders = [];
  const half = Config.COMBAT_ARENA_HALF;
  const wallH = Config.COMBAT_WALL_HEIGHT;

  // ---- 地面贴片：明亮的蓝灰场地，和主世界的绿色草地区分，一眼看出「这是单独的对战场景」----
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(half * 2, half * 2),
    new THREE.MeshStandardMaterial({ color: 0x55618f, roughness: 0.92, metalness: 0.02 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0.02;
  floor.receiveShadow = true;
  group.add(floor);

  // 网格线：强化「地板」的存在感，也给落点判断提供参照
  const grid = new THREE.GridHelper(half * 2, half, 0x9fb0dd, 0x7686b3);
  grid.position.y = 0.05;
  grid.material.transparent = true;
  grid.material.opacity = 0.38;
  group.add(grid);

  // 场地中心十字标线（视觉参考，方便结算落点）
  const lineMat = new THREE.MeshBasicMaterial({ color: 0xc4d0f0, transparent: true, opacity: 0.6 });
  const lineX = new THREE.Mesh(new THREE.PlaneGeometry(half * 2, 0.3), lineMat);
  lineX.rotation.x = -Math.PI / 2;
  lineX.position.y = 0.08;
  group.add(lineX);
  const lineZ = new THREE.Mesh(new THREE.PlaneGeometry(0.3, half * 2), lineMat);
  lineZ.rotation.x = -Math.PI / 2;
  lineZ.position.y = 0.08;
  group.add(lineZ);

  // 贴地发光边界环：给出清晰的「场地范围」感，也提示玩家不要贴墙
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(half - 0.9, half - 0.15, 72),
    new THREE.MeshBasicMaterial({ color: 0x7fd0ff, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.11;
  group.add(ring);

  // ---- 四面边界墙（AABB + 网格）----
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x7a8bb0, roughness: 0.8, metalness: 0.15 });
  const addWall = (cx, cz, hx, hz) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, wallH, hz * 2), wallMat);
    mesh.position.set(cx, wallH / 2, cz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    colliders.push({ cx, cy: wallH / 2, cz, hx, hy: wallH / 2, hz });
  };
  const t = 1; // 墙厚半值（墙总厚 2m）
  addWall(0, -half, half, t); // 北
  addWall(0, half, half, t);  // 南
  addWall(-half, 0, t, half); // 西
  addWall(half, 0, t, half);  // 东

  // ---- 掩体箱：散落各处，提供遮挡与高低差（中心半径 ≤10m，避免与半径 12m 的出生环重叠）----
  const crateMat = new THREE.MeshStandardMaterial({ color: 0x8a6c3a, roughness: 0.92 });
  // [x, z, 半径x, 半高y, 半径z]
  const crates = [
    [-6, -6, 1.5, 2.0, 1.5], [5, -7, 1.3, 1.5, 1.3], [7, 5, 1.6, 2.6, 1.6],
    [-7, 6, 1.5, 2.2, 1.5], [0, 8, 2.0, 1.1, 2.0], [-5, 2, 1.1, 2.8, 1.1],
    [5, -1, 1.3, 1.6, 1.3], [-2, -8, 1.6, 1.9, 1.6], [8, -3, 1.2, 3.4, 1.2],
    [-8, -2, 1.2, 3.4, 1.2], [3, 6, 1.1, 1.4, 1.1], [-4, -3, 1.1, 1.3, 1.1],
  ];
  for (const [x, z, sx, sy, sz] of crates) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx * 2, sy * 2, sz * 2), crateMat);
    mesh.position.set(x, sy, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    colliders.push({ cx: x, cy: sy, cz: z, hx: sx, hy: sy, hz: sz });
  }

  // ---- 中央高台 + 阶梯：给一点垂直玩法（可跳上台躲避/对射）----
  const platMat = new THREE.MeshStandardMaterial({ color: 0x46527a, roughness: 0.85, metalness: 0.1 });
  const addBox = (x, z, sx, sy, sz) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx * 2, sy * 2, sz * 2), platMat);
    mesh.position.set(x, sy, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    colliders.push({ cx: x, cy: sy, cz: z, hx: sx, hy: sy, hz: sz });
  };
  addBox(0, 0, 3.5, 0.6, 3.5);  // 中心台
  addBox(0, -3, 2.6, 0.4, 1.3); // 通向中心台的台阶
  addBox(0, -5, 2.6, 0.2, 1.3);

  // ---- 关键：把整组加入场景（曾经漏掉，导致场地/地板完全不渲染）----
  scene.add(group);

  return {
    group,
    colliders,
    half,
    // 退出对战时整体移除场景组并释放几何/材质，避免显存泄漏
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
