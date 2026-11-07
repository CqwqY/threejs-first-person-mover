// 探针：片元 mediump 注入（src/world/FragmentPrecision.js）
//
// 验证点（静态，不依赖 WebGL 上下文）：
//   【1】注入标记与声明存在：fragmentShader 主体最前面是 `FRAG_DECL`
//   【2】injectFragmentPrecision 幂等：连调两次只插一次
//   【3】applyFragmentPrecision 跳过 ShaderMaterial / 深度材质：不误伤障眼法窗户、阴影深度变体
//   【4】canDowngrade 正确放行普通材质（MeshStandardMaterial）
//   【5】覆盖语义：拼接后的「prefix(highp) + 主体(mediump)」里 mediump 出现在 highp 之后
//        —— 即 GLSL 的 later-statement 覆盖（规范层验证，见 Khronos GLSL ES 4.5.4）
//   【6】Game.js 接线：_precompileShaders 里在 compile 之前调用了 applyFragmentPrecisionToScene + 标 needsUpdate
//   【7】@web 之外的边界：depthWrite:false 的透明材质不在本探针范围（那是 overdraw 任务）

import { readFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, resolve } from 'path';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok   ', name); } else { fail++; console.error('  FAIL ', name); } };

// 在 Node 里加载 three（用 ESM 的 import 会触发 vite，这里用 require 走 node_modules 的 cjs）
let THREE;
try { THREE = await import('three'); THREE = THREE.default || THREE; }
catch (e) { console.error('无法加载 three:', e.message); process.exit(1); }

// 直接 import 真实模块（FragmentPrecision.js 是纯 ESM，不依赖 vite 特有 API，可被 node 直接加载）
const FragPrec = await import(pathToFileURL(resolve(root, 'src/world/FragmentPrecision.js')).href);
const { injectFragmentPrecision, canDowngrade, applyFragmentPrecisionToScene, fragmentPrecisionCount } = FragPrec;

console.log('【1】注入标记与声明（插在 main 之前，不是主体开头）');
{
  const shader = { fragmentShader: 'uniform vec3 c;\nvoid main(){ gl_FragColor=vec4(c,1.0); }' };
  const r = injectFragmentPrecision(shader);
  ok('注入返回 true', r === true);
  const iDecl = shader.fragmentShader.indexOf('uniform vec3 c;');
  const iMed = shader.fragmentShader.indexOf('/* fpm-mediump */precision mediump float;');
  const iMain = shader.fragmentShader.indexOf('void main()');
  ok('全局 uniform 声明在精度声明之前（保持 highp，与 VS 一致）', iDecl >= 0 && iDecl < iMed);
  ok('mediump 声明插在 void main 所在行之前', iMed >= 0 && iMed < iMain);
  ok('主体不再以 FRAG_MARK 开头（旧写法会毁掉 uniform 精度一致性）', !shader.fragmentShader.startsWith('/* fpm-mediump */'));
  ok('原内容完整保留', shader.fragmentShader.includes('gl_FragColor=vec4(c,1.0);'));
}

console.log('【2】injectFragmentPrecision 幂等');
{
  const injectFragmentPrecision = FragPrec.injectFragmentPrecision;
  const shader = { fragmentShader: 'void main(){}' };
  injectFragmentPrecision(shader);
  const r2 = injectFragmentPrecision(shader); // 第二次
  ok('第二次返回 false', r2 === false);
  ok('没有重复插入（只出现一次 FRAG_MARK）', (shader.fragmentShader.match(/\/\* fpm-mediump \*\//g) || []).length === 1);
}

console.log('【3】applyFragmentPrecision 跳过 ShaderMaterial / 深度材质');
{
  const canDowngrade = FragPrec.canDowngrade;
  const shaderMat = new THREE.ShaderMaterial({ vertexShader: 'void main(){}', fragmentShader: 'void main(){}' });
  ok('ShaderMaterial 被排除', canDowngrade(shaderMat) === false);
  const depthMat = new THREE.MeshDepthMaterial();
  ok('MeshDepthMaterial 被排除', canDowngrade(depthMat) === false);
  const stdMat = new THREE.MeshStandardMaterial();
  ok('MeshStandardMaterial 被放行', canDowngrade(stdMat) === true);
  // RawShaderMaterial 可能没有 onBeforeCompile（看 three 版本）—— 走 isRawShaderMaterial 排除
  const rawMat = new THREE.RawShaderMaterial({ vertexShader: 'void main(){}', fragmentShader: 'void main(){}' });
  ok('RawShaderMaterial 被排除', canDowngrade(rawMat) === false);
}

console.log('【4】覆盖语义：prefix(highp) + 主体(mediump) 拼接顺序');
{
  // 模拟 three 的拼装：prefixFragment 含 generatePrecision(highp)，再拼主体
  const prefix = 'precision highp float;\nprecision highp int;\n';
  const injectFragmentPrecision = FragPrec.injectFragmentPrecision;
  const shader = { fragmentShader: 'uniform vec3 c;\nvoid main(){ gl_FragColor=vec4(c,1.0); }' };
  injectFragmentPrecision(shader);
  const full = prefix + shader.fragmentShader;
  const iHigh = full.indexOf('precision highp float;');
  const iMed = full.indexOf('precision mediump float;');
  ok('highp 在前（prefix）', iHigh >= 0 && iHigh < iMed);
  ok('mediump 在后（主体，覆盖生效）', iMed > iHigh);
  const iUni = full.indexOf('uniform vec3 c;');
  const iMain = full.indexOf('void main()');
  ok('uniform 在 mediump 之前 → 仍是 highp（VS/FS 一致）', iHigh < iUni && iUni < iMed);
  ok('mediump 在 main 之前 → main 内局部计算吃到 mediump', iMed < iMain);
}

console.log('【5】applyFragmentPrecisionToScene 遍历场景 + 幂等');
{
  const applyFragmentPrecisionToScene = FragPrec.applyFragmentPrecisionToScene;
  const fragPrecisionCount = FragPrec.fragmentPrecisionCount;
  const scene = new THREE.Scene();
  const a = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  const b = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  scene.add(a, b);
  const n1 = applyFragmentPrecisionToScene(scene);
  ok('首次扫到 2 个材质', n1 === 2);
  const n2 = applyFragmentPrecisionToScene(scene); // 重复扫
  ok('重复扫不重复包装', n2 === 0);
  ok('记录数 = 2', fragPrecisionCount() === 2);
  // 数组材质
  const multi = new THREE.Mesh(new THREE.BoxGeometry(), [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()]);
  scene.add(multi);
  const n3 = applyFragmentPrecisionToScene(scene);
  ok('数组材质被遍历', n3 === 2);
}

console.log('【6】Game.js 接线：编译前调用 + 标 needsUpdate');
{
  const game = readFileSync(resolve(root, 'src/core/Game.js'), 'utf8');
  ok('_precompileShaders 里 import 了 FragmentPrecision', game.includes("from '../world/FragmentPrecision.js'"));
  ok('调用了 applyFragmentPrecisionToScene', game.includes('applyFragmentPrecisionToScene(this.scene)'));
  ok('编译前标 needsUpdate 触发重编', game.includes('m.needsUpdate = true') && game.indexOf('applyFragmentPrecisionToScene') < game.indexOf('_scanLodCandidates') ? game.indexOf('applyFragmentPrecisionToScene') < game.indexOf('r.compile') : true);
  ok('注入在 r.compile 之前（顺序正确）', game.indexOf('applyFragmentPrecisionToScene(this.scene)') < game.indexOf('if (typeof r.compile ===') || game.indexOf('applyFragmentPrecisionToScene(this.scene)') < game.indexOf('r.compile(this.scene'));
}

console.log('\n【7】回归：uniform 精度冲突（VALIDATE_STATUS false）');
{
  // 复刻 three 的 resolveIncludes：把片元主体里的 #include 展开成真实声明，
  // 才能验证 mediump 到底落在 uniform 声明之前还是之后。
  const expand = (src) => src.replace(/^[ \t]*#include +<([\w\d./]+)>/gm, (m, name) => {
    const chunk = THREE.ShaderChunk[name];
    return chunk === undefined ? m : expand(chunk);
  });
  const physF = expand(THREE.ShaderLib.physical.fragmentShader);
  const physV = expand(THREE.ShaderLib.physical.vertexShader);
  const sh = { fragmentShader: physF };
  ok('真实展开后的 physical 片元能注入', injectFragmentPrecision(sh) === true);
  const iShadow = sh.fragmentShader.indexOf('uniform DirectionalLightShadow directionalLightShadows');
  const iMed = sh.fragmentShader.indexOf('/* fpm-mediump */');
  ok('片元展开后确实含 directionalLightShadows uniform', iShadow >= 0);
  ok('顶点展开后也声明同一个 uniform（所以两边精度必须一致）',
    physV.indexOf('uniform DirectionalLightShadow directionalLightShadows') >= 0);
  ok('该 uniform 声明在 mediump 之前 → 仍是 highp，link 通过', iShadow >= 0 && iShadow < iMed);
  ok('顶点着色器完全没被注入（只改片元）', physV.indexOf('fpm-mediump') === -1);
}

console.log('\n【8】precisionInjectionPoint 与失败降级');
{
  const pip = FragPrec.precisionInjectionPoint;
  ok('返回 main 所在行的行首', pip('uniform vec3 c;\nvoid main() { }') === 'uniform vec3 c;\n'.length);
  ok('兼容 void main(void) 与换行大括号', pip('void  main ( void )\n{\n}') === 0);
  ok('没有 main 返回 -1', pip('uniform vec3 c;') === -1);
  const noMain = { fragmentShader: 'uniform vec3 c;\n' };
  const origWarn = console.warn;
  let warned = 0;
  console.warn = () => { warned++; };
  const r = injectFragmentPrecision(noMain);
  console.warn = origWarn;
  ok('找不到 main 时不注入且出声 warn（不静默）', r === false && warned === 1);
  ok('失败时 shader 一字未改', noMain.fragmentShader === 'uniform vec3 c;\n');
  const names = Object.keys(THREE.ShaderLib).filter((k) => typeof THREE.ShaderLib[k].fragmentShader === 'string');
  ok('three 全部 ShaderLib 片元都能找到插入点（' + names.length + ' 个）',
    names.length > 0 && names.every((k) => pip(THREE.ShaderLib[k].fragmentShader) >= 0));
}

console.log(`\n${fail === 0 ? '✓ 片元精度探针全部通过' : '✗ 有 ' + fail + ' 项失败'}（${pass} ok / ${fail} fail）`);
process.exit(fail === 0 ? 0 : 1);
