// 职责：供各 prop 复用的助手 —— 把 GLB 模型挂到 holder（先放占位，加载后替换）与基于位置的稳定随机朝向。
import { instantiate, createFallback } from '../AssetLoader.js';

// 将某个 GLB 挂到 holder：立即放入一个占位方块，模型加载成功后替换并套用修正（scale / y / rotation）。
// 加载失败时保留占位方块，保证场景不崩、不空缺。
export function loadAndAttach(
  holder,
  url,
  { scale = 1, y = 0, rotX = 0, rotY = 0, rotZ = 0, color = 0x888888, size = { w: 1, h: 1, d: 1 } } = {}
) {
  holder.add(createFallback({ color, width: size.w, height: size.h, depth: size.d }));

  instantiate(url)
    .then((model) => {
      model.scale.setScalar(scale);
      model.position.y = y;
      if (rotX) model.rotation.x = rotX;
      if (rotY) model.rotation.y = rotY;
      if (rotZ) model.rotation.z = rotZ;
      holder.clear();
      holder.add(model);
    })
    .catch(() => {
      // 失败：保持占位方块即可
    });
}

// 基于坐标生成确定性伪随机朝向（弧度），保证每次刷新同一位置朝向稳定。
export function randYaw(x, z) {
  const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return (s - Math.floor(s)) * Math.PI * 2;
}