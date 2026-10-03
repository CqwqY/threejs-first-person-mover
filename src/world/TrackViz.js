// 职责：把赛道「画出来」——贝塞尔立体路面（跟着门的高低上下）+ 中线 + 方向箭头；
// 以及为这条路面**生成碰撞体**（有厚度的板，供物理解算）。
// 编辑器预览与游戏运行时共用这一份（曲线数据全来自 world/Track.js），
// 避免「编辑器里看着对、进游戏差一截」。
//
// 为什么是「带状 mesh」而不是 Line：Line 的线宽在绝大多数平台恒为 1px，
// 手机上根本看不见；沿曲线左右各偏移半个宽度拼出来的路面才是真正看得见的一条赛道。
import * as THREE from 'three';
import { curvePoints, curveArrows, TRACK_ROAD_HALF_W, TRACK_ROAD_LIFT, TRACK_SLAB } from './Track.js';

const UP = new THREE.Vector3(0, 1, 0);

// 默认配色（编辑器与游戏一致）：路面色深、中线与箭头亮
export const TRACK_PATH_COLOR = 0x2f6fbf;
export const TRACK_ARROW_COLOR = 0x8fd0ff;

// 沿曲线取点，并算出每个点的横向单位法线（水平面内）。路面 / 碰撞体共用同一套采样，
// 保证「看得见的」和「踩得到的」完全对齐。
function sampleRibbon(track, per, width) {
  const pts = curvePoints(track, per);
  if (pts.length < 3) return null;
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len; // 左法线
    const nz = dx / len;
    out.push({ x: pts[i].x, y: pts[i].y, z: pts[i].z, nx, nz, half: width });
  }
  return out;
}

// 返回一个 Group（路面 + 中线 + 方向箭头）。轨迹点少于 2 个门时返回空 Group。
// opts.lift：路面顶面相对曲线的抬升（默认 0.06，抬一点免得和地面 z-fighting）
export function buildTrackPath(track, opts = {}) {
  const {
    color = TRACK_PATH_COLOR,
    arrowColor = TRACK_ARROW_COLOR,
    y = TRACK_ROAD_LIFT,
    width = TRACK_ROAD_HALF_W,
    arrowCount = 12,
    opacity = 0.5,
    arrowScale = 1,
  } = opts;

  const group = new THREE.Group();
  group.name = 'track-path';

  const rib = sampleRibbon(track, 16, width);
  if (rib) {
    // ---- 路面：沿曲线左右各偏移半个宽度，拼成带状；y 跟着门的高度走 ----
    const pos = [];
    const idx = [];
    const linePts = [];
    for (const p of rib) {
      const py = p.y + y;
      pos.push(p.x + p.nx * p.half, py, p.z + p.nz * p.half);
      pos.push(p.x - p.nx * p.half, py, p.z - p.nz * p.half);
      linePts.push(new THREE.Vector3(p.x, py + 0.02, p.z));
    }
    for (let i = 0; i < rib.length - 1; i++) {
      const o = i * 2;
      idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    const road = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide,
    }));
    road.renderOrder = 2;
    group.add(road);

    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(linePts),
      new THREE.LineBasicMaterial({ color: arrowColor, transparent: true, opacity: 0.7 })
    );
    line.renderOrder = 3;
    group.add(line);
  }

  // ---- 方向箭头：四棱锥躺平，锥尖朝行进方向 ----
  const arrowGeo = new THREE.ConeGeometry(0.7 * arrowScale, 2 * arrowScale, 4);
  const arrowMat = new THREE.MeshBasicMaterial({
    color: arrowColor, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide,
  });
  for (const a of curveArrows(track, arrowCount)) {
    const m = new THREE.Mesh(arrowGeo, arrowMat);
    m.position.set(a.x, a.y + y + 0.05, a.z);
    m.quaternion.setFromUnitVectors(UP, new THREE.Vector3(a.dx, 0, a.dz).normalize());
    m.renderOrder = 4;
    group.add(m);
  }
  return group;
}

// ---------------------------------------------------------------------------
// 赛道路面的**碰撞体**：与视觉路面同一条曲线、同一个半宽，但**有厚度**（向下挤出 TRACK_SLAB）。
// 为什么要厚度：本项目的角色碰撞走 SAT + MTV，一个零厚度薄片会把玩家「推」到任意一侧、
// 甚至穿过去；给成实体板以后，站上去 / 从下面顶到都稳定。
//
// 返回的 Mesh **顶点已经是世界坐标**（自身不带平移/旋转），调用方直接 bakeTriMesh(mesh) 即可。
// 它不参与渲染（材质 visible:false），烘完就能把几何 dispose 掉。
// ---------------------------------------------------------------------------
export function buildTrackCollision(track, opts = {}) {
  const {
    y = TRACK_ROAD_LIFT,
    width = TRACK_ROAD_HALF_W,
    thickness = TRACK_SLAB,
    per = 16,
  } = opts;

  const rib = sampleRibbon(track, per, width);
  if (!rib) return null;

  const pos = [];
  const idx = [];
  const pushV = (x, vy, z) => { pos.push(x, vy, z); return pos.length / 3 - 1; };
  const topL = [], topR = [], botL = [], botR = [];
  for (const p of rib) {
    const ty = p.y + y;
    const by = ty - thickness;
    const lx = p.x + p.nx * p.half, lz = p.z + p.nz * p.half;
    const rx = p.x - p.nx * p.half, rz = p.z - p.nz * p.half;
    topL.push(pushV(lx, ty, lz));
    topR.push(pushV(rx, ty, rz));
    botL.push(pushV(lx, by, lz));
    botR.push(pushV(rx, by, rz));
  }
  const quad = (a, b, c, d) => { idx.push(a, b, c, a, c, d); };
  for (let i = 0; i < rib.length - 1; i++) {
    quad(topL[i], topR[i], topR[i + 1], topL[i + 1]);      // 顶面
    quad(botL[i + 1], botR[i + 1], botR[i], botL[i]);      // 底面
    quad(botL[i], botL[i + 1], topL[i + 1], topL[i]);      // 左侧
    quad(topR[i], topR[i + 1], botR[i + 1], botR[i]);      // 右侧
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ visible: false }));
  mesh.name = 'track-collision';
  return mesh;
}

// 从场景里移除并回收（几何/材质都显式释放；编辑器会频繁重建它）
export function disposeTrackViz(group) {
  if (!group) return;
  group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  });
  if (group.parent) group.parent.remove(group);
}
