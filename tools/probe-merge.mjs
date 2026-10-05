// 自检 + 量具：模型内部的「同材质小网格」合并（node tools/probe-merge.mjs [文件.glb ...]）
//
// 为什么要测：用户报「建模里有几百个相同颜色的材质，很卡」。卡顿的真凶通常不是三角形数量，
//   而是 **draw call 次数** —— 每个网格一次提交，开了阴影后主渲染 + 阴影贴图**各来一趟**。
//   合并后网格数掉下来，两趟都省。
//
// 两条必须守住的底线（合并是把几何搬家的操作，搬错了就是"模型少了零件/面翻了"）：
//   ① 三角形总数不变（一个三角形都不能丢）；
//   ② 世界包围盒不变（几何没有被挪位、也没有被镜像翻错）；
//   ③ 带骨骼的模型（boy/girl）必须整个跳过 —— 合并会烘死顶点，清空气节点还会删掉末端骨头。
//
// 不传文件时跑合成用例（盒子阵列），传文件时跑真实 GLB（贴图用 stub，不依赖解码/网络）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeStaticMeshes, countMeshes, flipTriangleWinding } from '../src/world/Merge.js';

globalThis.self = globalThis; // Node 下 GLTFLoader 需要 self 全局

const HERE = path.dirname(fileURLToPath(import.meta.url));
let fails = 0;
function check(name, got, want, eps = 1e-6) {
  const ok = (typeof want === 'number' && typeof got === 'number') ? Math.abs(got - want) <= eps : got === want;
  if (!ok) { fails++; console.log(`  ✗ ${name}\n      期望 ${want}\n      实际 ${got}`); }
  else console.log(`  ok    ${name} = ${typeof got === 'number' ? got.toFixed(4) : got}`);
}

function triCount(root) {
  let t = 0;
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const g = o.geometry;
    t += g.index ? g.index.count / 3 : (g.attributes.position ? g.attributes.position.count / 3 : 0);
  });
  return t;
}
// 世界空间包围盒（合并前后必须一致 —— 几何没丢也没被挪位）
function worldBox(root) {
  root.updateMatrixWorld(true);
  const b = new THREE.Box3();
  root.traverse((o) => { if (o.isMesh && o.geometry) b.expandByObject(o); });
  return b;
}
function boxEq(a, b, eps = 1e-3) {
  return a.min.distanceTo(b.min) <= eps && a.max.distanceTo(b.max) <= eps;
}
function fmtBox(b) {
  const f = (v) => `${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)}`;
  return `[${f(b.min)}] ~ [${f(b.max)}]`;
}

// 「三角形绕向」与「顶点法线」是否一致：对每个三角形用叉积算几何法线，与三个顶点的平均法线点乘。
// 一致率 ≈ 1 说明绕向正确；≈ 0 说明整批三角形被翻过来了（背面剔除会剔错面 → 看到内壁）。
// 这是唯一能真正验证 flipTriangleWinding 的手段 —— 只比对**法线属性**是测不出来的
// （翻绕向只换顶点顺序，一个属性值都不动）。
function windingAgreement(g) {
  const pos = g.attributes.position, nrm = g.attributes.normal;
  if (!pos || !nrm) return 0;
  const idx = g.index;
  const count = idx ? idx.count : pos.count;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3(), vn = new THREE.Vector3();
  const t = new THREE.Vector3();
  let ok = 0, total = 0;
  for (let i = 0; i + 2 < count; i += 3) {
    const i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i + 1) : i + 1, i2 = idx ? idx.getX(i + 2) : i + 2;
    a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2);
    ab.subVectors(b, a); ac.subVectors(c, a); n.crossVectors(ab, ac);
    if (n.lengthSq() < 1e-12) continue;
    n.normalize();
    vn.set(0, 0, 0);
    vn.add(t.fromBufferAttribute(nrm, i0)); vn.add(t.fromBufferAttribute(nrm, i1)); vn.add(t.fromBufferAttribute(nrm, i2));
    if (vn.lengthSq() < 1e-12) continue;
    vn.normalize();
    total++;
    if (n.dot(vn) > 0) ok++;
  }
  return total ? ok / total : 0;
}

// ---------- ① 合成用例：一块材质、300 个小盒子 ----------
console.log('① 合成用例：300 个同材质小盒子应合成 1 个网格：');
{
  const root = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x88aa66 });
  const geo = new THREE.BoxGeometry(0.5, 0.5, 0.5);
  for (let i = 0; i < 300; i++) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set((i % 10) * 1.2, Math.floor(i / 10) % 10 * 1.2, Math.floor(i / 100) * 1.2);
    root.add(m);
  }
  const before = countMeshes(root), tri = triCount(root), box = worldBox(root);
  const st = mergeStaticMeshes(root);
  check('300 → 1 个网格', countMeshes(root), 1);
  check('三角形总数不变', triCount(root), tri);
  check('包围盒不变', boxEq(worldBox(root), box), true);
  check('统计里 mergedGroups = 1', st.mergedGroups, 1);
  void before;
}

// ---------- ② 不同材质不能被并到一起 ----------
console.log('② 三种材质的盒子只能各自合成（3 个网格）：');
{
  const root = new THREE.Group();
  const geo = new THREE.BoxGeometry(0.5, 0.5, 0.5);
  const mats = [0xff0000, 0x00ff00, 0x0000ff].map((c) => new THREE.MeshStandardMaterial({ color: c }));
  for (let i = 0; i < 30; i++) {
    const m = new THREE.Mesh(geo, mats[i % 3]);
    m.position.set(i * 1.1, 0, 0);
    root.add(m);
  }
  const tri = triCount(root), box = worldBox(root);
  mergeStaticMeshes(root);
  check('30 → 3 个网格（按材质各一批）', countMeshes(root), 3);
  check('三角形总数不变', triCount(root), tri);
  check('包围盒不变', boxEq(worldBox(root), box), true);
}

// ---------- ③ 镜像节点（scale.x = -1）：绕向必须翻回来 ----------
console.log('③ 镜像子网格：合并后不能出现内壁（绕向翻转正确）：');
{
  const root = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, side: THREE.FrontSide });
  const geo = new THREE.BoxGeometry(1, 1, 1);
  for (let i = 0; i < 12; i++) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(i * 2, 0, 0);
    m.scale.x = -1; // 镜像
    root.add(m);
  }
  const tri = triCount(root), box = worldBox(root);
  mergeStaticMeshes(root);
  check('12 → 1 个网格', countMeshes(root), 1);
  check('三角形总数不变', triCount(root), tri);
  check('包围盒不变', boxEq(worldBox(root), box), true);
  const g = root.children.find((c) => c.isMesh).geometry;
  const agree = windingAgreement(g);
  check('绕向与法线一致（镜像已翻回，不会看到内壁）', agree > 0.99, true);
  // 反向对照：证明上面这个判据真的能测出"翻错"——再翻一次应当立刻掉到 0 附近
  flipTriangleWinding(g);
  check('反向对照：再翻一次绕向，一致率应塌到 0', windingAgreement(g) < 0.01, true);
  flipTriangleWinding(g); // 还原
  check('还原后一致率回到 1', windingAgreement(g) > 0.99, true);
}

// ---------- ④ 骨骼模型必须整个跳过（清空气节点会删掉末端骨头）----------
console.log('④ 带骨骼/骨头的模型必须整个跳过：');
{
  const root = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial();
  const geo = new THREE.BoxGeometry(1, 1, 1);
  for (let i = 0; i < 20; i++) { const m = new THREE.Mesh(geo, mat); m.position.set(i, 0, 0); root.add(m); }
  const bone = new THREE.Bone(); // 末端骨头：没有子节点，正是「清空气节点」会误删的东西
  root.add(bone);
  const before = countMeshes(root);
  const st = mergeStaticMeshes(root);
  check('跳过合并（网格数不变）', countMeshes(root), before);
  check('骨头还在', root.children.includes(bone), true);
  check('统计标记 skipped=rigged', st.skipped, 'rigged');
  // 合并会清掉「空的中转节点」，但**有名的空节点不能删** —— 模型里常用它当挂点标记（枪口/手把/出生点）
  const marker = new THREE.Object3D(); marker.name = 'muzzle'; marker.position.set(0, 1, 2);
  const root2 = new THREE.Group();
  for (let i = 0; i < 20; i++) { const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()); m.position.set(i, 0, 0); root2.add(m); }
  root2.add(marker);
  root2.add(new THREE.Object3D()); // 无名的空节点：这个可以清掉
  mergeStaticMeshes(root2);
  check('有名的挂点节点保留（muzzle 还在）', !!root2.getObjectByName('muzzle'), true);
  let namelessEmpties = 0;
  root2.traverse((o) => { if (!o.isMesh && !o.children.length && !o.name) namelessEmpties++; });
  check('无名的空中转节点被清掉（有名的 muzzle 不计入）', namelessEmpties, 0);
}

// ---------- ⑥ 加载期自动合并（AssetLoader.optimizeLoadedModel）的三条守门规则 ----------
console.log('⑥ 加载期自动合并：该合的合、动画/骨骼的一律不动：');
{
  const { optimizeLoadedModel } = await import('../src/world/AssetLoader.js');
  const mat = new THREE.MeshStandardMaterial({ color: 0x99ccff });
  const geo = new THREE.BoxGeometry(0.4, 0.4, 0.4);
  const build = (n) => {
    const scene = new THREE.Group();
    for (let i = 0; i < n; i++) { const m = new THREE.Mesh(geo, mat); m.position.set(i * 0.9, 0, 0); scene.add(m); }
    return scene;
  };
  // 普通静态模型：合并
  {
    const gltf = { scene: build(300), animations: [] };
    optimizeLoadedModel(gltf, 'test.glb');
    check('300 → 1（普通静态模型）', countMeshes(gltf.scene), 1);
  }
  // 有动画：必须跳过（合并会把顶点烘死，节点动画失效）
  {
    const gltf = { scene: build(300), animations: [{ name: 'spin' }] };
    optimizeLoadedModel(gltf, 'anim.glb');
    check('有动画 → 不合并', countMeshes(gltf.scene), 300);
  }
  // 有骨骼：必须跳过（清空气节点会删掉末端骨头）
  {
    const scene = build(300);
    scene.add(new THREE.Bone());
    const gltf = { scene, animations: [] };
    const st = optimizeLoadedModel(gltf, 'rig.glb');
    check('有骨骼 → 不合并', countMeshes(gltf.scene), 300);
    check('有骨骼 → 标记 skipped=rigged', st && st.skipped, 'rigged');
  }
  // 网格太少：不做无用功
  {
    const gltf = { scene: build(5), animations: [] };
    const st = optimizeLoadedModel(gltf, 'small.glb');
    check('网格 < 8 → 直接返回 null', st, null);
    check('网格 < 8 → 网格数不变', countMeshes(gltf.scene), 5);
  }
}

// ---------- ⑦ 属性归一化：部分网格多带 uv1 时不该把批次打碎 ----------
console.log('⑦ 属性归一化（部分网格多带 uv1）：');
{
  const mkGeo = (withUv1) => {
    const g = new THREE.BoxGeometry(0.4, 0.4, 0.4);
    if (withUv1) {
      const n = g.attributes.position.count;
      g.setAttribute('uv1', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    }
    return g;
  };
  const build = (nPlain, nExtra, material) => {
    const root = new THREE.Group();
    const gPlain = mkGeo(false), gExtra = mkGeo(true);
    for (let i = 0; i < nPlain; i++) { const m = new THREE.Mesh(gPlain, material); m.position.set(i * 0.8, 0, 0); root.add(m); }
    for (let i = 0; i < nExtra; i++) { const m = new THREE.Mesh(gExtra, material); m.position.set(i * 0.8, 3, 0); root.add(m); }
    return root;
  };
  // (a) 材质用不上 uv1（没有 aoMap/lightMap）→ 250 个应合成 1 个
  {
    const mat = new THREE.MeshStandardMaterial({ color: 0xcc9966 });
    const root = build(200, 50, mat);
    const st = mergeStaticMeshes(root);
    check('250 → 1（uv1 被判为可丢弃并归一）', countMeshes(root), 1);
    check('只出 1 批', st.mergedGroups, 1);
  }
  // (b) 材质用得上 uv1（aoMap.channel = 1）→ 一个字节都不许删，只能各自成批
  {
    const ao = new THREE.Texture(); ao.channel = 1;
    const mat = new THREE.MeshStandardMaterial({ color: 0xcc9966, aoMap: ao });
    const root = build(200, 50, mat);
    mergeStaticMeshes(root);
    check('aoMap 用着 uv1 → 保住 uv1，分成 2 批', countMeshes(root), 2);
  }
}

// ---------- ⑤ 真实 GLB ----------
const files = process.argv.slice(2);
if (!files.length) {
  const dirs = ['public/assets', 'public/models'];
  for (const d of dirs) {
    const abs = path.join(HERE, '..', d);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs)) if (f.endsWith('.glb') && !f.includes('-rig')) files.push(path.join(d, f));
  }
}
if (files.length) {
  console.log('⑤ 真实模型：');
  for (const f of files) {
    const abs = path.isAbsolute(f) ? f : path.join(HERE, '..', f);
    if (!fs.existsSync(abs)) { console.log(`  - ${f}（不存在，跳过）`); continue; }
    const buf = fs.readFileSync(abs);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const mgr = new THREE.LoadingManager();
    // 贴图一律 stub：GLB 里的图是 blob:nodedata:<uuid> 这种**没有扩展名**的 URL，
    // 按扩展名注册 handler 匹配不上 → 走真加载器 → Node 里解不了码，parse 的回调永远不会来
    // （表现是「unsettled top-level await」，不是报错）。所以这里用**通配** handler。
    // ⚠ 贴图 stub 必须真的调用 onLoad，否则 GLTFLoader 会一直等这个贴图、parse 永不回调
    //   （外链贴图的模型就会表现为「解析超时」）。返回 Texture 后立刻 onLoad 即可。
    mgr.addHandler(/.*/, { load: (url, onLoad) => { onLoad(new THREE.Texture()); } });
    // ⚠ 外链贴图的模型（如 building-garage.glb 引用 Textures/colormap.png）在 Node 里永远等不到
    //   回调（没有 XHR/fetch 到相对路径），会变成 unsettled await 把整个进程挂住 → 加超时兜底。
    const gltf = await Promise.race([
      new Promise((res, rej) => new GLTFLoader(mgr).parse(ab, '', res, rej)),
      new Promise((res) => setTimeout(() => res(null), 8000)),
    ]);
    if (!gltf) { console.log(`  ${path.basename(f)}: 解析超时（多半是外链贴图，跳过）`); continue; }
    const scene = gltf.scene;
    const before = countMeshes(scene), tri = triCount(scene), box = worldBox(scene);
    let mats = new Set();
    scene.traverse((o) => { if (o.isMesh) mats.add(Array.isArray(o.material) ? 'arr' : (o.material && o.material.uuid)); });
    const st = mergeStaticMeshes(scene);
    const after = countMeshes(scene);
    const okTri = Math.abs(triCount(scene) - tri) < 1e-6;
    const okBox = boxEq(worldBox(scene), box);
    const tag = st.skipped ? `(跳过: ${st.skipped})` : (after < before ? `${before} → ${after}（${st.mergedGroups} 批）` : '无可合并');
    console.log(`  ${path.basename(f)}: 网格 ${tag}，材质 ${mats.size} 种，三角形 ${tri.toFixed(0)}` +
      `${okTri ? '' : '  ✗ 三角形数变了!'}${okBox ? '' : `  ✗ 包围盒变了! ${fmtBox(box)} → ${fmtBox(worldBox(scene))}`}`);
    if (!okTri || !okBox) fails++;
    // ⚠ 有动画的模型不能在加载期合并（合并会把顶点烘死，节点动画就失效了）—— 这里只报告
    if ((gltf.animations || []).length && before >= 8) console.log(`      ⚠ 含 ${gltf.animations.length} 条动画：加载期不合并`);
  }
}

console.log(fails ? `\n✗ ${fails} 项不通过` : '\n✓ 全部通过');
process.exit(fails ? 1 : 0);
