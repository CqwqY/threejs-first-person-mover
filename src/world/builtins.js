// 内置（非 GLB）摆件的程序化构建：滑索 + 三维区域。
//
// 为什么走 builtin: URL：编辑器与游戏端都通过 AssetLoader.instantiate(url) 取模型，
// 在这里加一个 builtin 分支，编辑器放置/存档/读档、游戏端重建**全部零改动**复用。
//
// 滑索的几何约定（局部空间）：近端高柱在原点、向 +Z 方向 15m 处一根矮柱，
// 钢索从 (0,9,0) 斜降到 (0,3.6,15)。端点存在 userData.__zipline 里（局部坐标），
// 运行时用 localToWorld 换算成世界坐标；玩家可在索上任意上下移动（见 Game._updateZipline）。
import * as THREE from 'three';

export const ZIPLINE_URL = 'builtin:zipline';

const ZIP_LEN = 15;    // 水平跨距（米）
const ZIP_HI = 9;      // 近端柱高
const ZIP_LO = 2.2;    // 远端柱高（刻意压低：站地上伸手就能抓到低端，再沿索爬上去）

// 已实例化的滑索（每个 Group 一个）。编辑器预览也会进这个表 —— 取出时顺手剪掉
// 已从场景摘掉的（预览小窗来回 hover 会产生大量短命实例）。
const _zips = [];
export function getZiplines() {
  for (let i = _zips.length - 1; i >= 0; i--) {
    if (!_zips[i] || !_zips[i].parent) _zips.splice(i, 1);
  }
  return _zips;
}
export function clearBuiltinInstances() { _zips.length = 0; _zones.length = 0; }

// 两条线段间最近点投影（纯函数，供运行时定位 + 探针单测）。
// 返回 { t: 0..1, x,y,z 投影点, dist: 玩家到线段距离 }
export function projectOnSegment(px, py, pz, ax, ay, az, bx, by, bz) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const len2 = dx * dx + dy * dy + dz * dz;
  let t = len2 > 1e-9 ? ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / len2 : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const x = ax + dx * t, y = ay + dy * t, z = az + dz * t;
  return { t, x, y, z, dist: Math.hypot(px - x, py - y, pz - z) };
}

export function cableLength(ax, ay, az, bx, by, bz) {
  return Math.hypot(bx - ax, by - ay, bz - az);
}

// 沿任意两点生成一根圆柱（钢索/斜撑）
function cylBetween(a, b, r, mat, radial = 8) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const geo = new THREE.CylinderGeometry(r, r, len, radial, 1, false);
  const m = new THREE.Mesh(geo, mat);
  m.position.copy(a).addScaledVector(dir, 0.5);
  // 默认圆柱沿 +Y：把它转到 a→b 方向
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  return m;
}

function buildZipline() {
  const g = new THREE.Group();
  g.name = '滑索';

  const steel = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.55, metalness: 0.6 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2b2f33, roughness: 0.8, metalness: 0.3 });
  const handleMat = new THREE.MeshStandardMaterial({ color: 0xf0c040, roughness: 0.45, metalness: 0.2 });

  const poleR = 0.13;
  // 近端高柱（局部原点）
  const p1 = new THREE.Mesh(new THREE.CylinderGeometry(poleR, poleR * 1.25, ZIP_HI, 10), steel);
  p1.position.set(0, ZIP_HI / 2, 0);
  g.add(p1);
  // 柱顶横臂（伸向索的方向）
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.16, 1.2), steel);
  arm.position.set(0, ZIP_HI - 0.08, 0.5);
  g.add(arm);
  // 远端矮柱
  const p2 = new THREE.Mesh(new THREE.CylinderGeometry(poleR, poleR * 1.25, ZIP_LO, 10), steel);
  p2.position.set(0, ZIP_LO / 2, ZIP_LEN);
  g.add(p2);

  const a = new THREE.Vector3(0, ZIP_HI, 0);
  const b = new THREE.Vector3(0, ZIP_LO, ZIP_LEN);

  // 钢索
  const cable = cylBetween(a, b, 0.05, dark, 6);
  g.add(cable);
  // 中点把手（看得出来是"能挂上去"的东西）
  const mid = a.clone().addScaledVector(new THREE.Vector3().subVectors(b, a), 0.5);
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.06, 6, 12), handleMat);
  handle.position.copy(mid);
  handle.rotation.y = Math.PI / 2;
  g.add(handle);

  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

  // 端点（局部坐标）+ 长度，运行时用 localToWorld 换算
  const len = cableLength(a.x, a.y, a.z, b.x, b.y, b.z);
  g.userData.__zipline = { a: a.clone(), b: b.clone(), len };
  _zips.push(g);
  return g;
}

// 统一入口：kind ∈ {'zipline','zone'}
export function createBuiltin(kind) {
  if (kind === 'zipline') return buildZipline();
  if (kind === 'zone') return buildZone();
  return new THREE.Group();
}

// ---------------------------------------------------------------------------
// 三维区域（builtin:zone）：一个 4x3x4 的半透明体积 + 描边，编辑器用 scale 调大小。
// 可挂「选项卡」（placed 记录的 tab 字段，EditorBuildings 负责画标签 sprite）：
// 玩家站进区域 → 出现交互按钮 → 点一下 = sceneFire(tab.event) → 配了同名事件的
// 运动器开始动作。事件匹配规则见 sceneEvents.js。
//
// 区域判定在 Game 端做：把玩家坐标用 holder.worldToLocal 转进局部系（天然支持
// rotY 旋转与 scale 缩放），再和下面的 UNIT 盒比大小 —— 所以这里固定 4x3x4，别处不再重复写尺寸。
// ---------------------------------------------------------------------------
export const ZONE_URL = 'builtin:zone';
// 局部盒半尺寸/高（米）：worldToLocal 之后的判定范围
export const ZONE_HALF = { x: 2, z: 2, yMin: 0, yMax: 3 };

const _zones = [];
export function getZones() {
  for (let i = _zones.length - 1; i >= 0; i--) {
    if (!_zones[i] || !_zones[i].parent) _zones.splice(i, 1);
  }
  return _zones;
}

function buildZone() {
  const g = new THREE.Group();
  g.name = '三维区域';

  const geo = new THREE.BoxGeometry(ZONE_HALF.x * 2, ZONE_HALF.yMax, ZONE_HALF.z * 2);
  // 半透明淡蓝体积：只是「看得见这是一块区域」，depthWrite 关掉避免透明排序问题
  const fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    color: 0x59c2ff, transparent: true, opacity: 0.10, depthWrite: false,
  }));
  fill.position.y = ZONE_HALF.yMax / 2;
  const edge = new THREE.LineSegments(
    new THREE.EdgesGeometry(geo),
    new THREE.LineBasicMaterial({ color: 0x8fd8ff, transparent: true, opacity: 0.75 }),
  );
  edge.position.y = ZONE_HALF.yMax / 2;
  g.add(fill, edge);
  // 区域本体不做阴影/不做碰撞（纯逻辑体积；挂进场景后 EditorBuildings 不会再给它生成碰撞）

  g.userData.__zone = { w: ZONE_HALF.x * 2, h: ZONE_HALF.yMax, d: ZONE_HALF.z * 2 };
  _zones.push(g);
  return g;
}

// 点是否在 zone 的局部盒内（p 为 worldToLocal 之后的局部坐标；纯函数供探针单测）
export function pointInZoneLocal(px, py, pz) {
  return Math.abs(px) <= ZONE_HALF.x && Math.abs(pz) <= ZONE_HALF.z
    && py >= ZONE_HALF.yMin && py <= ZONE_HALF.yMax;
}
