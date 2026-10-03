// 职责：调试用 —— 在场景里放一个可绕视角观察的人物，画出它的骨骼（SkeletonHelper，绿色线）
//       以及骨骼根部的参考轴箭头（红=+X、绿=+Y、蓝=+Z），用于直观判断骨骼相对模型是否偏移（如歪 90°）。
// 用法：网址带 ?rigdebug 打开。走路动画由主循环的 tickPlayerModels 统一驱动，这里只负责画辅助线。
import * as THREE from 'three';
import { createPlayerModel } from '../player/PlayerModel.js';

// addDebugRig(scene)：在地图前方放置一个可见的调试模型，加载完成绑定后展示骨架与坐标轴。
// 返回 { update() }：模型是异步加载的，所以每帧都要试着挂一次辅助线，挂上后就不再重复。
export function addDebugRig(scene) {
  const holder = createPlayerModel('', 'boy'); // 无名牌（label=''）
  holder.position.set(0, 0, 6);
  scene.add(holder);

  const dbg = { holder, _rigged: false };

  dbg.update = () => {
    const rig = holder.userData.rig;
    if (!rig || dbg._rigged) return;
    dbg._rigged = true;

    // 骨架线条（绿色），随骨骼自动更新
    const skeletonHelper = new THREE.SkeletonHelper(rig.root);
    skeletonHelper.material = new THREE.LineBasicMaterial({ color: 0x00ff00 });
    scene.add(skeletonHelper);

    // 取骨骼根（层级最上面那根 Bone），在它身上挂参考轴
    let skinned = null;
    rig.root.traverse((o) => { if (o.isSkinnedMesh) skinned = o; });
    const bones = skinned ? skinned.skeleton.bones : [];
    const rootBone = bones.find((b) => !(b.parent && b.parent.isBone)) || bones[0];
    if (!rootBone) return;
    rig.root.updateMatrixWorld(true);
    const origin = rootBone.getWorldPosition(new THREE.Vector3());
    const m = rootBone.matrixWorld;
    const axis = [
      { dir: new THREE.Vector3(1, 0, 0), color: 0xff0000, len: 0.7 }, // +X
      { dir: new THREE.Vector3(0, 1, 0), color: 0x00ff00, len: 0.7 }, // +Y
      { dir: new THREE.Vector3(0, 0, 1), color: 0x0000ff, len: 1.0 }, // +Z
    ];
    for (const a of axis) {
      const dir = a.dir.clone().transformDirection(m); // 骨骼局部轴 -> 世界朝向
      const arrow = new THREE.ArrowHelper(dir, origin, a.len, a.color, 0.18, 0.12);
      scene.add(arrow);
    }
  };

  return dbg;
}