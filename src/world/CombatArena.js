// 职责：为一对一/混战模式构建「单独的竞技场」场景。
// 在原点铺一块 60×60 的场地（彩色地贴 + 四面边界墙 + 掩体箱 + 中央高台），
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

  // ---- 地面贴片：深色场地，和主世界的绿色草地区分开，一眼看出「这是单独的对战场景」----
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(half * 2, half * 2),
    new THREE.MeshStandardMaterial({ color: 0x2b3550, roughness: 0.96, metalness: 0.0 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0.02;
  floor.receiveShadow = true;
  group.add(floor);

  // 场地中心十字标线（视觉参考，方便结算落点）
  const lineMat = new THREE.MeshBasicMaterial({ color: 0x5b6b93, transparent: true, opacity: 0.55 });
  const lineX = new THREE.Mesh(new THREE.PlaneGeometry(half * 2, 0.25), lineMat);
  lineX.rotation.x = -Math.PI / 2;
  lineX.position.y = 0.03;
  group.add(lineX);
  const lineZ = new THREE.Mesh(new THREE.PlaneGeometry(0.25, half * 2), lineMat);
  lineZ.rotation.x = -Math.PI / 2;
  lineZ.position.y = 0.03;
  group.add(lineZ);

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

  // ---- 掩体箱：散落各处，提供遮挡与高低差（都在出生环 24m 以内侧，避免和出生点重叠）----
  const crateMat = new THREE.MeshStandardMaterial({ color: 0x7d6234, roughness: 0.92 });
  // [x, z, 半径x, 半高y, 半径z]
  const crates = [
    [-12, -10, 2.0, 2.2, 2.0], [10, -12, 1.6, 1.6, 1.6], [14, 8, 2.4, 3.0, 2.4],
    [-14, 9, 2.0, 2.5, 2.0], [0, 16, 3.0, 1.2, 3.0], [-8, 4, 1.4, 3.2, 1.4],
    [8, -2, 1.8, 1.8, 1.8], [-3, -16, 2.2, 2.2, 2.2], [18, -4, 1.6, 4.0, 1.6],
    [-18, -2, 1.6, 4.0, 1.6], [4, 10, 1.5, 1.5, 1.5], [-6, -4, 1.5, 1.5, 1.5],
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
  addBox(0, 0, 4, 0.6, 4);    // 中心台
  addBox(0, -3.5, 3, 0.4, 1.5); // 通向中心台的台阶
  addBox(0, -6, 3, 0.2, 1.5);

  return {
    group,
    colliders,
    half,
    // 退出对战时整体移除场景组并释放几何/材质，避免显存泄漏
    dispose() {
      scene.remove(group);
      group.traverse((o) => {
        if (!o.isMesh) return;
        if (o.geometry) o.geometry.dispose();
        const mat = o.material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else if (mat) mat.dispose();
      });
    },
  };
}
