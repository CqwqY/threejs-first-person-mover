// 职责：出生点旁的电动车（双人载具）。
// 全场只有一辆：没人驾驶时停在 Config.VEHICLE_POS；有人驾驶时整车跟随驾驶员的位置与朝向。
// 后座玩家由各自客户端把自身坐标钉在驾驶位后方，所以这里只负责摆放车体。
import * as THREE from 'three';
import { Config } from '../config.js';
import { instantiate } from './AssetLoader.js';
import { enableDynamicLighting } from './Lights.js';

export function createVehicle(scene) {
  const group = new THREE.Group();
  group.position.set(Config.VEHICLE_POS.x, 0, Config.VEHICLE_POS.z);
  group.rotation.y = Config.VEHICLE_YAW;
  scene.add(group);

  let ready = false;

  instantiate(Config.VEHICLE_MODEL)
    .then((model) => {
      // 按包围盒等比缩放到目标高度，并把轮底压到 y=0
      const box = new THREE.Box3();
      model.traverse((o) => {
        if (o.isMesh) {
          o.geometry.computeBoundingBox();
          box.expandByObject(o);
        }
      });
      const sizeY = box.max.y - box.min.y;
      const s = sizeY > 1e-4 ? Config.VEHICLE_HEIGHT / sizeY : 1;
      model.scale.setScalar(s);
      model.position.y = -box.min.y * s;
      model.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      // 模型自带朝向不一定是"车头朝 -Z"，用 YAW_OFFSET 单独补偿，不动 group 的朝向
      const holder = new THREE.Group();
      holder.rotation.y = Config.VEHICLE_YAW_OFFSET;
      holder.add(model);
      group.add(holder);
      // 载具是动态物体：开第 1 层让太阳实时照它（group 已在 createVehicle 同步开了，
      // 这里给异步加载进来的子模型补一层，确保车体网格也受太阳照）。
      enableDynamicLighting(group);
      ready = true;
    })
    .catch(() => {
      /* 加载失败：保留空车体，不影响上车/下车逻辑 */
    });

  // 有人驾驶时把车摆到驾驶员脚下
  function setPose(x, y, z, yaw) {
    group.position.set(x, y, z);
    group.rotation.y = yaw;
  }

  // 没人驾驶时回到停放点
  function park() {
    group.position.set(Config.VEHICLE_POS.x, 0, Config.VEHICLE_POS.z);
    group.rotation.y = Config.VEHICLE_YAW;
  }

  return { group, setPose, park, isReady: () => ready };
}
