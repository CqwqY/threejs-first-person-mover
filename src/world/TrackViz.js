// 职责：把赛道「画出来」——贝塞尔地面路面 + 中线 + 方向箭头。
// 编辑器预览与游戏运行时共用这一份（曲线数据全来自 world/Track.js），
// 避免「编辑器里看着对、进游戏差一截」。
//
// 为什么是「带状 mesh」而不是 Line：Line 的线宽在绝大多数平台恒为 1px，
// 手机上根本看不见；沿曲线左右各偏移半个宽度拼出来的路面才是真正看得见的一条赛道。
import * as THREE from 'three';
import { curvePoints, curveArrows } from './Track.js';

const UP = new THREE.Vector3(0, 1, 0);

// 默认配色（编辑器与游戏一致）：路面色深、中线与箭头亮
export const TRACK_PATH_COLOR = 0x2f6fbf;
export const TRACK_ARROW_COLOR = 0x8fd0ff;

// 返回一个 Group（路面 + 中线 + 方向箭头）。轨迹点少于 2 个门时返回空 Group。
export function buildTrackPath(track, opts = {}) {
  const {
    color = TRACK_PATH_COLOR,
    arrowColor = TRACK_ARROW_COLOR,
    y = 0.06,          // 贴地高度（抬一点，免得和地面 z-fighting）
    width = 3.2,       // 路面半宽（米）
    arrowCount = 12,
    opacity = 0.5,
    arrowScale = 1,
  } = opts;

  const group = new THREE.Group();
  group.name = 'track-path';

  const pts = curvePoints(track, 16);
  if (pts.length >= 3) {
    // ---- 路面：沿曲线左右各偏移半个宽度，拼成带状 ----
    const pos = [];
    const idx = [];
    const linePts = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz) || 1;
      const nx = -dz / len; // 左法线
      const nz = dx / len;
      pos.push(pts[i].x + nx * width, y, pts[i].z + nz * width);
      pos.push(pts[i].x - nx * width, y, pts[i].z - nz * width);
      linePts.push(new THREE.Vector3(pts[i].x, y + 0.02, pts[i].z));
    }
    for (let i = 0; i < pts.length - 1; i++) {
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
    m.position.set(a.x, y + 0.05, a.z);
    m.quaternion.setFromUnitVectors(UP, new THREE.Vector3(a.dx, 0, a.dz).normalize());
    m.renderOrder = 4;
    group.add(m);
  }
  return group;
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
