// 职责：定义本地玩家的“外观”模型（身体 + 头 + 头顶占位）。只负责造型，不做逻辑。
import * as THREE from 'three';

export function createPlayerModel() {
  const group = new THREE.Group();

  // ---- 身体：用一个立方体表示躯干 ----
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x4a7cba });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.9, 0.3), bodyMat);
  body.position.y = 0.55; // 身体中心略高于地面
  group.add(body);

  // ---- 头：用一个球表示头部 ----
  const headMat = new THREE.MeshStandardMaterial({ color: 0xc7a07c });
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 16, 16), headMat);
  head.position.y = 1.25;
  group.add(head);

  // ---- 头顶占位：预留一个空节点，将来可以挂昵称 / 头顶标识 ----
  const headAnchor = new THREE.Object3D();
  headAnchor.position.y = 1.55;
  group.add(headAnchor);
  // 通过 userData 暴露，方便后续 LookAt 或挂 UI
  group.userData.headAnchor = headAnchor;

  return group;
}