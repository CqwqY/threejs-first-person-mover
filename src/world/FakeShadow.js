// 假阴影（blob / contact shadow）
// ---------------------------------------------------------------------------
// 项目阴影总开关默认关（真实阴影贴图是像素着色瓶颈之一，且手机端尤甚）。
// 关掉真实阴影后角色/载具会「悬空」，这里用一个贴地的暗斑 quad 给它们落地实感——
// 不依赖阴影贴图、不增加任何阴影趟，每个动态体只多 1 个 draw call。
//
// 用法：attachFakeShadow(parent, { radius, y, opacity }) —— 把暗斑作为 parent 的子节点挂上，
// 跟随 parent 的变换（含位置/缩放），父节点被隐藏时暗斑一起不渲染。
import * as THREE from 'three';

let _blobTex = null;
function blobTexture() {
  if (_blobTex) return _blobTex;
  const s = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0.0, 'rgba(0,0,0,0.55)');
  g.addColorStop(0.55, 'rgba(0,0,0,0.28)');
  g.addColorStop(1.0, 'rgba(0,0,0,0.0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  _blobTex = new THREE.CanvasTexture(cv);
  _blobTex.colorSpace = THREE.SRGBColorSpace;
  _blobTex.needsUpdate = true;
  return _blobTex;
}

let _blobMat = null;
function blobMaterial() {
  if (_blobMat) return _blobMat;
  _blobMat = new THREE.MeshBasicMaterial({
    map: blobTexture(),
    transparent: true,
    depthWrite: false,
    opacity: 0.85,
    color: 0x000000,
    side: THREE.DoubleSide,
  });
  return _blobMat;
}

/**
 * 给 parent 挂一个贴地假阴影（暗斑）。
 * @param {THREE.Object3D} parent 跟随的父节点（角色/载具的容器）
 * @param {object} [opts]
 * @param {number} [opts.radius=0.5] 暗斑半径（米）
 * @param {number} [opts.y=0.02] 离地高度（避免与地面 z-fighting）
 * @param {number} [opts.opacity=0.85] 不透明度
 * @returns {THREE.Mesh|null} 暗斑 mesh（便于后续移除）
 */
export function attachFakeShadow(parent, opts = {}) {
  if (!parent) return null;
  const r = opts.radius != null ? opts.radius : 0.5;
  const y = opts.y != null ? opts.y : 0.02;
  const geo = new THREE.PlaneGeometry(r * 2, r * 2);
  const mat = blobMaterial();
  if (opts.opacity != null) mat = mat.clone(), (mat.opacity = opts.opacity);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2; // 平铺到地面
  mesh.position.y = y;
  mesh.renderOrder = -1; // 先画，避免盖在地面上引起深度闪烁
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false; // 作为子节点跟随父变换，关闭自身视锥剔除避免被误剔
  mesh.userData.fakeShadow = true;
  parent.add(mesh);
  return mesh;
}
