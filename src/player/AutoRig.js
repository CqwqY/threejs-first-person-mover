// 职责：给单一网格的人物 GLB 自动绑定一套简易人形骨骼并生成蒙皮网格，附带程序化行走/待机动画。
// 说明：原模型无骨骼，这里按顶点位置做启发式蒙皮（把身体各部位分给对应骨骼），效果为卡通级近似，
//       适合让静态角色“动起来”，但不如 Mixamo/Blender 等专业重定向精细。
import * as THREE from 'three';

// 肩部“落臂”静息偏转（弧度）：模型手臂是 T 字横放的，绑定后让肩绕 z 轴把手臂转到自然下垂方向。
// 数值 ≈ 图(0.13 到垂直的加权)，留一点向外余量避免贴死身体。
const ARM_FOLD = 1.3;

// autoRig(scene, height)：把 scene 中最大的网格烘焙到脚踩地(y=0)、身高=height 的坐标系，
// 绑定简易骨骼并返回 rig {group, bones, update(time,speed)}。失败返回 null（由调用方保留静态模型）。
export function autoRig(scene, height) {
  try {
    const { meshes, geom } = bakeAndPickMesh(scene, height);
    if (!geom) return null;

    // 构建骨骼层级（骨骼位于烘焙后的世界坐标：脚 y=0，头顶 y=height）
    const root = new THREE.Bone(); root.position.set(0, 0.95, 0);
    const spine = childOf(root, 0, 0.40, 0);   // y=1.35
    const neck = childOf(spine, 0, 0.20, 0);   // y=1.55
    const head = childOf(neck, 0, 0.15, 0);    // y=1.70

    const shL = childOf(spine, -0.27, -0.02, 0); // 左肩 y≈1.33
    const elbL = childOf(shL, 0, -0.5, 0);
    const handL = childOf(elbL, 0, -0.45, 0);
    const shR = childOf(spine, 0.27, -0.02, 0);  // 右肩
    const elbR = childOf(shR, 0, -0.5, 0);
    const handR = childOf(elbR, 0, -0.45, 0);

    const hipL = childOf(root, -0.13, -0.05, 0); // y=0.90
    const kneeL = childOf(hipL, 0, -0.5, 0);
    const footL = childOf(kneeL, 0, -0.42, 0);
    const hipR = childOf(root, 0.13, -0.05, 0);
    const kneeR = childOf(hipR, 0, -0.5, 0);
    const footR = childOf(kneeR, 0, -0.42, 0);

    // 落臂：把横放的 T 字手臂转到自然下垂，作为绑定姿势（applyPose 只驱动 rotation.x，此 z 偏转保留）
    shL.rotation.z = ARM_FOLD;
    shR.rotation.z = -ARM_FOLD;

    // 骨架骨骼顺序（skinIndex 按此数组下标）
    const bones = [root, spine, neck, head, shL, elbL, handL, shR, elbR, handR, hipL, kneeL, footL, hipR, kneeR, footR];
    const idx = new Map(bones.map((b, i) => [b, i]));

    // 顶点蒙皮权重：按坐标区域把顶点分给相关骨骼（最多 4 组）
    const pos = geom.attributes.position;
    const count = pos.count;
    const skinIndex = new Float32Array(count * 4);
    const skinWeight = new Float32Array(count * 4);
    const tmp = new THREE.Vector3();

    for (let i = 0; i < count; i++) {
      tmp.fromBufferAttribute(pos, i);
      const x = tmp.x, y = tmp.y, ax = Math.abs(x);
      const side = x >= 0 ? 1 : -1; // +x=右
      let list;
      if (y < 0.28) {
        list = ax > 0.13 ? (side >= 0 ? [[footR, 1.0]] : [[footL, 1.0]]) : [[root, 0.7], [footL, 0.15], [footR, 0.15]];
      } else if (y < 0.55) {
        list = ax > 0.12 ? (side >= 0 ? [[kneeR, 0.8], [hipR, 0.2]] : [[kneeL, 0.8], [hipL, 0.2]]) : [[root, 0.6], [hipL, 0.2], [hipR, 0.2]];
      } else if (y < 0.95) {
        if (ax > 0.16) list = side >= 0 ? [[hipR, 0.7], [kneeR, 0.3]] : [[hipL, 0.7], [kneeL, 0.3]];
        else list = [[root, 0.6], [hipL, 0.2], [hipR, 0.2]];
      } else if (y < 1.32) {
        if (ax > 0.22) list = side >= 0 ? [[shR, 0.6], [elbR, 0.4]] : [[shL, 0.6], [elbL, 0.4]];
        else list = [[spine, 0.8], [root, 0.2]];
      } else if (y < 1.5) {
        if (ax > 0.2) list = side >= 0 ? [[shR, 0.7], [elbR, 0.3]] : [[shL, 0.7], [elbL, 0.3]];
        else list = [[spine, 0.75], [neck, 0.25]];
      } else {
        list = ax > 0.18 ? [[neck, 0.5], [spine, 0.5]] : [[head, 0.7], [neck, 0.3]];
      }
      const b = i * 4;
      for (let j = 0; j < 4; j++) skinIndex[b + j] = 0;
      for (let j = 0; j < Math.min(4, list.length); j++) {
        skinIndex[b + j] = idx.get(list[j][0]);
        skinWeight[b + j] = list[j][1];
      }
    }
    geom.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
    geom.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));

    // 组装：蒙皮网格 + 骨骼同处一个组（骨骼需在世界空间，故不缩放父级）
    const group = new THREE.Group();
    group.add(root);
    const mat = meshes[0].material;
    const skinned = new THREE.SkinnedMesh(geom, mat);
    group.add(skinned);

    const skeleton = new THREE.Skeleton(bones);
    group.updateMatrixWorld(true);
    skeleton.calculateInverses();
    skinned.bind(skeleton);

    // 动画状态引用
    const bone = {
      root, spine, hipL, hipR: null, kneeL, kneeR, footL, footR, shL, shR,
    };
    bone.hipR = hipR;

    return {
      group,
      skeleton,
      bones: bone,
      update(time, speed) {
        applyPose(bone, time, speed);
        group.updateMatrixWorld(true);
        skeleton.update();
      },
    };
  } catch (e) {
    console.warn('[AutoRig] rig failed, keep static model:', e);
    return null;
  }
}

// 取 scene 中面数最多的网格，并把它的几何烘焙到世界坐标（含父级变换 + 身高归一化）
function bakeAndPickMesh(scene, height) {
  const meshes = [];
  scene.traverse((o) => {
    if (o.isMesh) meshes.push(o);
  });
  if (meshes.length === 0) return { meshes: [], geom: null };

  const pick = meshes.reduce((a, b) => (vcount(b.geometry) > vcount(a.geometry) ? b : a));
  const geom = pick.geometry.clone(); // 独立副本，避免污染共享缓存
  scene.updateMatrixWorld(true);
  geom.applyMatrix4(pick.matrixWorld); // 烘焙父级变换到几何顶点

  // 归一化：脚底 y=0，身高=height
  geom.computeBoundingBox();
  const size = geom.boundingBox.getSize(new THREE.Vector3());
  if (size.y < 1e-4) return { meshes, geom: null };
  const scale = height / size.y;
  geom.scale(scale, scale, scale);
  geom.translate(0, -geom.boundingBox.min.y, 0);

  pick.visible = false; // 隐藏原网格，由蒙皮网格接管渲染
  return { meshes, geom };
}

function vcount(g) {
  const b = g.attributes.position;
  return b ? b.count : 0;
}

// 新建子骨骼（父 + 相对偏移）
function childOf(parent, x, y, z) {
  const b = new THREE.Bone();
  b.position.set(x, y, z);
  parent.add(b);
  return b;
}

// 程序化姿态：行走时摆动手臂/腿并上下起伏，静止时轻微呼吸
function applyPose(bone, t, speed) {
  const walking = speed > 0.2;
  const amp = walking ? Math.min(0.65, 0.18 + speed * 0.28) : 0.0;
  const ph = t * (walking ? 6.0 : 1.4);

  const swing = amp * Math.sin(ph);
  bone.hipL.rotation.x = swing;
  bone.hipR.rotation.x = -swing;
  bone.kneeL.rotation.x = Math.max(0, -swing * 0.5);
  bone.kneeR.rotation.x = Math.max(0, swing * 0.5);

  bone.shL.rotation.x = -swing * 0.7;
  bone.shR.rotation.x = swing * 0.7;

  // 上下起伏与呼吸
  bone.root.position.y = 0.95 + Math.abs(Math.cos(ph)) * amp * 0.12;
  bone.spine.rotation.z = Math.sin(t * 1.6) * 0.02;
  bone.spine.position.y = 0.40 + Math.sin(t * 1.6) * 0.008;
}

// ---------------------------------------------------------------------------
// 原生骨骼驱动：当 GLB 自带真实骨骼（SkinnedMesh + skeleton）时，优先驱动这套
// 骨骼来做走/待机动画，而不是用 autoRig 重建的启发式骨架。这样动作贴合模型
// 自带的绑骨，四肢/躯干的朝向和粗细都正确。
// 返回与 autoRig 同构的 { group, bones, update }，交给 PlayerModel 复用同一套接线。
// 若模型没有可用骨骼则返回 null，调用方再回退到 autoRig。
// ---------------------------------------------------------------------------
export function useNativeSkeleton(scene, height) {
  try {
    let skinned = null;
    scene.traverse((o) => { if (o.isSkinnedMesh) skinned = o; });
    if (!skinned || !skinned.skeleton || !skinned.skeleton.bones || skinned.skeleton.bones.length === 0) return null;

    // 归一化身高（脚底 y=0，身高=height）。因为改的是整个场景根节点（骨骼 + 蒙皮一起缩放），
    // 用 calculateInverses + bind 重算绑定，避免「骨骼与网格各缩放一次」造成的双重放大。
    const box = new THREE.Box3().setFromObject(scene);
    const sizeY = box.max.y - box.min.y;
    const s = sizeY > 1e-4 ? height / sizeY : height;
    scene.scale.set(s, s, s);
    scene.position.y = -box.min.y * s;
    scene.updateMatrixWorld(true);
    skinned.skeleton.calculateInverses();
    skinned.bind(skinned.skeleton);

    // 按名取真实骨骼（少数模型用别名，找不到对应骨则退回启发式 AutoRig）
    const B = (n) => skinned.skeleton.getBoneByName(n);
    const ulL = B('upperleg.L'), ulR = B('upperleg.R');
    if (!ulL || !ulR) return null; // 无腿骨不硬撑，交给 autoRig
    const root = B('root') || skinned.skeleton.bones[0];
    const spine = B('spine') || root;
    const bones = {
      root,
      spine,
      head: B('head'),
      ulL, llL: B('lowerleg.L'), ulR, llR: B('lowerleg.R'),
      uaL: B('upperarm.L'), laL: B('lowerarm.L'),
      uaR: B('upperarm.R'), laR: B('lowerarm.R'),
      _rootY0: root.position.y,
    };

    return {
      group: scene,
      skeleton: skinned.skeleton,
      native: true,
      bones,
      update(time, speed) {
        applyNativePose(bones, time, speed);
        scene.updateMatrixWorld(true);
        skinned.skeleton.update();
      },
    };
  } catch (e) {
    console.warn('[NativeRig] 失败，回退启发式:', e);
    return null;
  }
}

// 程序化走/待机姿态，作用在模型真实骨骼上（命名：upperlimb/lowerlimb + .L/.R）
function applyNativePose(b, t, speed) {
  const walking = speed > 0.2;
  const amp = walking ? Math.min(0.65, 0.18 + speed * 0.28) : 0.0;
  const ph = t * (walking ? 6.0 : 1.4);

  // 腿：与 autoRig 相同的交替摆动 + 膝盖弯曲
  const swing = amp * Math.sin(ph);
  b.ulL.rotation.x = swing;
  b.ulR.rotation.x = -swing;
  if (b.llL) b.llL.rotation.x = Math.max(0, -swing * 0.5);
  if (b.llR) b.llR.rotation.x = Math.max(0, swing * 0.5);

  // 手臂：上臂反向摆动，小臂微曲
  if (b.uaL) b.uaL.rotation.x = -swing * 0.7;
  if (b.uaR) b.uaR.rotation.x = swing * 0.7;
  if (b.laL) b.laL.rotation.x = Math.max(0, swing * 0.3);
  if (b.laR) b.laR.rotation.x = Math.max(0, -swing * 0.3);

  // 躯干：root 起伏（记录初始 y 为基准）+ 脊柱轻微左右摆
  b.root.position.y = b._rootY0 + Math.abs(Math.cos(ph)) * amp * 0.12;
  b.spine.rotation.z = Math.sin(t * 1.6) * 0.02;
}