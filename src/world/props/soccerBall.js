// 足球气球几何：截角二十面体（truncated icosahedron）。
// 这是足球的真实面板结构：12 块五边形（深色）+ 20 块六边形（浅色），
// 用顶点色区分面板。配透明材质就是「透明足球气球」。
//
// 为什么程序化生成而不是找 GLB：足球是数学上完全确定的均匀多面体，60 行代码
// 生成的是**真**足球形状，零下载、零依赖、零加载等待；外部模型反而不透明、还要调材质。
// （找模型的路都试过：raw.githubusercontent / api.github.com 被墙，jsDelivr 大仓库超限，
//   唯一找到的现成货是 FBX 还要转格式。）
import * as THREE from 'three';

const PHI = (1 + Math.sqrt(5)) / 2;

function norm(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function mul(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

// 把多边形顶点绕「中心 + 法线」按角度排序，并保证逆时针（法线朝外）
function sortRing(points, normal) {
  const n = norm(normal);
  let t1 = cross(n, Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]);
  t1 = norm(t1);
  const t2 = norm(cross(n, t1));
  const c = [0, 0, 0];
  for (const p of points) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
  const cx = mul(c, 1 / points.length);
  const sorted = points
    .map((p) => ({ p, a: Math.atan2(dot(sub(p, cx), t2), dot(sub(p, cx), t1)) }))
    .sort((u, v) => u.a - v.a)
    .map((o) => o.p);
  return sorted;
}

export function buildSoccerBallGeometry(radius = 1) {
  // ---- 1) 正二十面体的 12 个顶点 ----
  const raw = [];
  const cyc = (x, y, z) => {
    raw.push([x, y, z], [z, x, y], [y, z, x]);
  };
  cyc(0, 1, PHI);
  cyc(0, 1, -PHI);
  cyc(0, -1, PHI);
  cyc(0, -1, -PHI);
  const V = raw.map(norm);

  // ---- 2) 邻接（最短边相连）----
  let edge = Infinity;
  for (let i = 0; i < 12; i++) {
    for (let j = i + 1; j < 12; j++) {
      const d = Math.hypot(...sub(V[i], V[j]));
      if (d < edge) edge = d;
    }
  }
  const adj = Array.from({ length: 12 }, () => []);
  for (let i = 0; i < 12; i++) {
    for (let j = i + 1; j < 12; j++) {
      if (Math.abs(Math.hypot(...sub(V[i], V[j])) - edge) < 1e-6) {
        adj[i].push(j);
        adj[j].push(i);
      }
    }
  }

  // ---- 3) 每条边的 1/3、2/3 分点：截角后的新顶点 ----
  // near[i][j] = 靠近 i 的那个分点
  const near = Array.from({ length: 12 }, () => ({}));
  for (let i = 0; i < 12; i++) {
    for (const j of adj[i]) {
      if (near[i][j]) continue;
      const pa = norm(add(mul(V[i], 2 / 3), mul(V[j], 1 / 3))); // 靠 i
      const pb = norm(add(mul(V[i], 1 / 3), mul(V[j], 2 / 3))); // 靠 j
      near[i][j] = pa;
      near[j][i] = pb;
    }
  }

  const polys = []; // { pts:[...], dark:boolean }

  // ---- 4) 12 个五边形：原顶点周围的那圈分点 ----
  for (let i = 0; i < 12; i++) {
    const ring = adj[i].map((j) => near[i][j]);
    polys.push({ pts: sortRing(ring, V[i]), dark: true });
  }

  // ---- 5) 20 个六边形：原三角形面的三条边各贡献 2 个分点 ----
  for (let i = 0; i < 12; i++) {
    for (const j of adj[i]) {
      if (j <= i) continue;
      for (const k of adj[j]) {
        if (k <= j || !adj[i].includes(k)) continue;
        const ring = [
          near[i][j], near[j][i],
          near[j][k], near[k][j],
          near[k][i], near[i][k],
        ];
        const c = [0, 0, 0];
        for (const p of ring) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
        polys.push({ pts: sortRing(ring, norm(c)), dark: false });
      }
    }
  }

  // ---- 6) 三角化 + 顶点色（非索引 ⇒ computeVertexNormals 得到面板小平面的棱面感）----
  const pos = [];
  const col = [];
  const darkC = [0.10, 0.11, 0.14];
  const liteC = [0.95, 0.97, 1.0];
  for (const poly of polys) {
    const pts = poly.pts.map((p) => mul(p, radius));
    const c = poly.dark ? darkC : liteC;
    for (let i = 1; i < pts.length - 1; i++) {
      pos.push(...pts[0], ...pts[i], ...pts[i + 1]);
      col.push(...c, ...c, ...c);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  return geo;
}
