// 职责：用确定性噪声一次性生成主城道路网（一次生成、刷新稳定），并给出“是否在道路上”与“路边路灯点位”，供 Roads.js / Props.js 共用。
const SEED = 20260913;   // 固定种子，保证每次刷新生成相同城市
const HALF = 24;         // 地图半宽（道路网覆盖范围）
const ROAD_WIDTH = 5;    // 道路宽度（跨路方向）
const HALF_W = ROAD_WIDTH / 2;
const AMP = 1.7;         // 道路轨迹噪声扰动幅度，让街道略带起伏而非笔直
const STEP = 2.4;        // 道路折线采样步长
const FREQ = 0.08;       // 噪声横向频率

// 确定性哈希 -> [0,1)，同一坐标永远同值
function hash(x, z) {
  const s = Math.sin(x * 127.1 + z * 311.7 + SEED * 0.013) * 43758.5453123;
  return s - Math.floor(s);
}

// 平滑插值（smoothstep），用于值噪声双线性混合
function fade(t) {
  return t * t * (3 - 2 * t);
}

// 值噪声：对格点哈希做双线性插值，返回 0~1 的平滑值
function noise(x, z) {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const xf = x - xi;
  const zf = z - zi;
  const a = hash(xi, zi);
  const b = hash(xi + 1, zi);
  const c = hash(xi, zi + 1);
  const d = hash(xi + 1, zi + 1);
  const u = fade(xf);
  const v = fade(zf);
  return a + (b - a) * u + (c + (d - c) * u - (a + (b - a) * u)) * v;
}

// 噪声扰动偏移：以 (x,z) 处噪声驱动的位置偏移，用于让道路中心线蜿蜒
function offset(x, z) {
  return (noise(x, z) - 0.5) * 2 * AMP;
}

// 点到线段距离（用于判断坐标是否落在某段道路内）
function segDist(px, pz, ax, az, bx, bz) {
  const abx = bx - ax;
  const abz = bz - az;
  const apx = px - ax;
  const apz = pz - az;
  const len2 = abx * abx + abz * abz;
  let t = len2 > 0 ? (apx * abx + apz * abz) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + abx * t), pz - (az + abz * t));
}

// 纵向大道：中心线 x 随 z 波动
function verticalAvenue(baseX) {
  const pts = [];
  for (let z = -HALF; z <= HALF + 0.001; z += STEP) {
    pts.push({ x: baseX + offset(baseX * FREQ, z * FREQ), z });
  }
  return pts;
}

// 横向大道：中心线 z 随 x 波动
function horizontalAvenue(baseZ) {
  const pts = [];
  for (let x = -HALF; x <= HALF + 0.001; x += STEP) {
    pts.push({ x, z: baseZ + offset(x * FREQ, baseZ * FREQ) });
  }
  return pts;
}

// 主干道基准位置：三条纵向 + 三条横向，十字交叉形成街区
const ROAD_BASES_X = [-14, 0, 14];
const ROAD_BASES_Z = [-14, 0, 14];

let _city = null;

// getCity()：构建并缓存一次城市道路数据（确定性）。多次调用返回同一份。
// 返回 { roads, isOnRoad, lampSpots }
export function getCity() {
  if (_city) return _city;

  // 生成所有纵向 + 横向大道
  const roads = [];
  for (const bx of ROAD_BASES_X) roads.push(verticalAvenue(bx));
  for (const bz of ROAD_BASES_Z) roads.push(horizontalAvenue(bz));

  // 判断坐标是否落在任意道路范围内
  function isOnRoad(x, z) {
    for (const poly of roads) {
      for (let i = 0; i < poly.length - 1; i++) {
        if (segDist(x, z, poly[i].x, poly[i].z, poly[i + 1].x, poly[i + 1].z) <= HALF_W) {
          return true;
        }
      }
    }
    return false;
  }

  // 路边路灯：沿每条大道中心线采样，向路缘外侧偏移到路肩（确保落在陆地而非道路上）
  const lampSpots = [];
  const LAMP_STEP = 8; // 路灯间距
  for (const poly of roads) {
    const stepIdx = Math.max(1, Math.round(LAMP_STEP / STEP));
    for (let i = 0; i < poly.length; i += stepIdx) {
      const p = poly[i];
      let dx, dz;
      if (i < poly.length - 1) {
        dx = poly[i + 1].x - p.x;
        dz = poly[i + 1].z - p.z;
      } else {
        dx = p.x - poly[i - 1].x;
        dz = p.z - poly[i - 1].z;
      }
      const len = Math.hypot(dx, dz) || 1;
      // 法向（垂直道路方向），左右侧由坐标哈希确定性决定
      const nx = -dz / len;
      const nz = dx / len;
      const side = hash(Math.round(p.x * 10), Math.round(p.z * 10)) < 0.5 ? 1 : -1;
      const offsetD = HALF_W + 0.9; // 路缘外侧偏移
      const lx = p.x + nx * offsetD * side;
      const lz = p.z + nz * offsetD * side;
      if (isOnRoad(lx, lz)) continue; // 偏移处仍在道路上则跳过
      if (lampSpots.length >= 22) break; // 限制路灯数量
      lampSpots.push({ x: lx, z: lz });
    }
    if (lampSpots.length >= 22) break;
  }

  _city = { roads, isOnRoad, lampSpots, ROAD_WIDTH };
  return _city;
}