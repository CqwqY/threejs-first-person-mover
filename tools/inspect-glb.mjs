/**
 * 检查 GLB 的材质导出是否符合 glTF 的 metallic-roughness 约定（Blender 导出的模型能不能被正确读到）。
 *
 * 用法：node tools/inspect-glb.mjs public/models/xxx.glb [more.glb ...]
 *
 * 关注点：
 *   · pbrMetallicRoughness.roughnessFactor / metallicFactor —— Blender 里填的**常量**糙度/金属度
 *   · pbrMetallicRoughness.metallicRoughnessTexture —— 接**贴图**时，糙度在 G 通道、金属度在 B 通道
 *   · extensionsUsed 里有没有 KHR_materials_pbrSpecularGlossiness
 *     → 那是「镜面/光泽度」老流程，Three.js 的 GLTFLoader **默认不认**，糙度会像丢了一样
 *   · images / buffers 是否内嵌（bufferView）还是外部 uri —— 引用外部文件的 .glb/.gltf 在本项目里会 404
 *     （AssetLoader 用 GLTFLoader.parse(buf, '')，base path 为空，解析不到相对路径）
 */
import { readFileSync } from 'node:fs';

const files = process.argv.slice(2);
if (!files.length) {
  console.log('用法：node tools/inspect-glb.mjs <file.glb> [more.glb ...]');
  process.exit(0);
}

function readGLBJson(file) {
  const buf = readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('不是 GLB（魔数不是 glTF）');
  const total = buf.readUInt32LE(8);
  let off = 12, json = null;
  while (off < total) {
    const clen = buf.readUInt32LE(off);
    const ctype = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + clen);
    if (ctype === 0x4e4f534a) { json = JSON.parse(data.toString('utf8')); break; }
    off += 8 + clen;
  }
  if (!json) throw new Error('没找到 JSON chunk');
  return json;
}

for (const f of files) {
  console.log(`\n================ ${f} ================`);
  let j;
  try { j = readGLBJson(f); }
  catch (e) { console.log('  读取失败：' + e.message); continue; }

  const ext = j.extensionsUsed || [];
  const sg = ext.filter((e) => /SpecularGlossiness/i.test(e));
  console.log('extensionsUsed:', ext.length ? ext.join(', ') : '(无)');
  if (sg.length) console.log('  ⚠ 用了 Specular/Glossiness 扩展，Three.js 默认不认 → 糙度会丢失');

  const imgs = j.images || [];
  const extImg = imgs.filter((im) => im.uri && !/^data:/.test(im.uri));
  console.log(`images: ${imgs.length} 张（内嵌 ${imgs.length - extImg.length} / 外部引用 ${extImg.length}）`);
  if (extImg.length) console.log('  ⚠ 有外部图片引用：' + extImg.map((i) => i.uri).slice(0, 4).join(', ') + ' → 本项目 parse(buf,"") 会 404');

  const bufs = j.buffers || [];
  const extBuf = bufs.filter((b) => b.uri && !/^data:/.test(b.uri));
  if (extBuf.length) console.log(`  ⚠ 有外部 buffer 引用：${extBuf.map((b) => b.uri).join(', ')}`);

  const mats = j.materials || [];
  console.log(`materials: ${mats.length} 个`);
  for (const m of mats) {
    const p = m.pbrMetallicRoughness || {};
    const rf = p.roughnessFactor === undefined ? 1 : p.roughnessFactor;
    const mf = p.metallicFactor === undefined ? 1 : p.metallicFactor;
    const hasMRTex = !!p.metallicRoughnessTexture;
    const hasSG = !!(m.extensions && m.extensions.KHR_materials_pbrSpecularGlossiness);
    console.log(
      `  · ${m.name || '(未命名)'}  roughness=${rf.toFixed(3)} metallic=${mf.toFixed(3)}` +
      (hasMRTex ? '  [有 metallicRoughness 贴图 → G=糙度 B=金属度]' : '  [常量值]') +
      (hasSG ? '  ⚠ 该材质用 SpecularGlossiness' : '')
    );
  }

  // ---- 光源（KHR_lights_punctual）----
  // Three.js 的 GLTFLoader **原生支持**这个扩展（会给场景加 PointLight/SpotLight/DirectionalLight），
  // 但前提是：① Blender 导出时勾了「Punctual Lights」② 灯的类型是 Blender 的 Point/Sun/Spot
  //   （Area 面光源**不在** glTF 规范里，导出时会被直接丢掉，也不会报错）。
  // ⚠ 本项目还有额外一层风险：AssetLoader.optimizeLoadedModel 会在加载后合并静态网格，
  //   而 Mesh 合并与光源无关（光源不是 Mesh），所以灯**能活下来**；但灯不参与「同材质合并」。
  const lightsExt = (j.extensions && j.extensions.KHR_lights_punctual) || null;
  const lightDefs = (lightsExt && lightsExt.lights) || [];
  const nodes = j.nodes || [];
  const lightNodes = nodes.filter((n) => n.extensions && n.extensions.KHR_lights_punctual);
  const usedLightIdx = lightNodes.map((n) => n.extensions.KHR_lights_punctual.light);
  console.log(`lights (KHR_lights_punctual): 定义 ${lightDefs.length} 盏 / 场景里挂了 ${lightNodes.length} 盏`);
  if (!lightDefs.length) {
    console.log('  → 模型里**没有**光源。Blender 里放的灯不会被读进来（导出时没勾 Punctual Lights，或用了面光源）。');
  } else {
    for (let i = 0; i < lightDefs.length; i++) {
      const L = lightDefs[i];
      const onNode = usedLightIdx.includes(i);
      const type = L.type || '?'; // point | spot | directional
      const extra = type === 'spot'
        ? `inner=${L.spot && L.spot.innerConeAngle !== undefined ? L.spot.innerConeAngle : '?'} outer=${L.spot && L.spot.outerConeAngle !== undefined ? L.spot.outerConeAngle : '?'}`
        : (type === 'point' ? `range=${L.range !== undefined ? L.range : '(无穷)'}` : '');
      console.log(
        `  · [${i}] ${L.name || '(未命名)'} type=${type} intensity=${L.intensity === undefined ? 1 : L.intensity}` +
        ` color=${L.color ? L.color.map((c) => c.toFixed(2)).join(',') : '(白)'} ${extra}` +
        (onNode ? '' : '  ⚠ 定义了但没有任何 node 引用 → 不会出现在场景里')
      );
    }
    console.log('  ⚠ 注意：Three.js 的 intensity 单位与 Blender 不同（还乘了项目 LIGHT_SCALE），');
    console.log('    导进来往往**比 Blender 里亮/暗一大截** —— 别指望所见即所得。');
    console.log('  ⚠ 面光源（Area）无法导出：glTF 规范里没有 area 类型，Blender 导出时会静默丢弃。');
  }
}
