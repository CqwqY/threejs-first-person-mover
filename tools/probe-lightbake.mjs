// 静态自检：光照烘焙（编辑器烘焙 → 存档 → 运行时分层防重光）的实现正确性。
// 不执行运行时，只扫源码断言关键接线都在。
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dir, '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');

const files = {
  baker: read('src/world/LightBaker.js'),
  lights: read('src/world/Lights.js'),
  eb: read('src/world/EditorBuildings.js'),
  editor: read('src/editor/EditorApp.js'),
  game: read('src/core/Game.js'),
  pm: read('src/player/PlayerManager.js'),
  veh: read('src/world/Vehicle.js'),
  html: read('editor.html'),
};

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}

console.log('[LightBaker] 模块齐备');
ok(files.baker.includes('export function genLightmapUV'), 'genLightmapUV 导出');
ok(files.baker.includes('export async function bakeMeshLightmaps'), 'bakeMeshLightmaps 导出');
ok(files.baker.includes('export function applyBakedLightmap'), 'applyBakedLightmap 导出');
ok(files.baker.includes('export async function applyBakedLightmapsToMeshes'), 'applyBakedLightmapsToMeshes 导出');
ok(files.baker.includes('export function collectBakeableMeshes'), 'collectBakeableMeshes 导出');
ok(files.baker.includes('export function markBakedLayers'), 'markBakedLayers 抽到 LightBaker 共享');
ok(files.baker.includes("import { LAYER_DYNAMIC } from './Lights.js'"), 'LightBaker 引入 LAYER_DYNAMIC（无循环依赖）');

console.log('[LightBaker] 烘焙 RT 不被天空/辅助物污染');
ok(files.baker.includes('scene.background = null'), '烘焙时清空 scene.background（防天蓝污染 lightMap）');
ok(files.baker.includes('scene.background = prevBg'), '烘焙后还原 scene.background');
ok(files.baker.includes('o.isLine') && files.baker.includes('o.isLineSegments') && files.baker.includes('o.isPoints'),
  'colorWrite 关闭覆盖线/点类辅助物（网格线/坐标轴/灯光助手）');
ok(files.baker.includes('m.colorWrite = false'), '烘焙期其它网格 colorWrite=false（只投阴影不污染 RT）');

console.log('[LightBaker] 烘焙体收实时太阳、仍投影');
ok(files.baker.includes('mesh.receiveShadow = false'), 'applyBakedLightmap 关 receiveShadow（静态体不再实时收太阳阴影→填充率红利）');
ok(files.baker.includes('mesh.castShadow = true'), 'applyBakedLightmap 保留 castShadow（静态体仍把影投到地面/动态体）');
ok(files.baker.includes('o.layers.disable(LAYER_DYNAMIC)') && files.baker.includes('o.layers.enable(LAYER_DYNAMIC)'),
  'markBakedLayers 按是否 lightMap 关/开第 1 层');

console.log('[Lights] 分层与 kill-switch');
ok(files.lights.includes('export const LAYER_DYNAMIC = 1'), 'LAYER_DYNAMIC=1');
ok(files.lights.includes('export function enableDynamicLighting'), 'enableDynamicLighting 导出');
ok(files.lights.includes('export function bakeFeatureEnabled'), 'bakeFeatureEnabled 导出');
ok(files.lights.includes('export function setBakeFeatureEnabled'), 'setBakeFeatureEnabled 导出（供单测注入）');
ok(files.lights.includes('if (bakeFeatureEnabled()) directional.layers.set(LAYER_DYNAMIC)') &&
  files.lights.includes('else directional.layers.enable(LAYER_DYNAMIC)'),
  '太阳层按 kill-switch：开→只照第1层；关(?bake=0)→第0+1层全照');
ok(files.lights.includes("location.search.includes('bake=0')"), 'kill-switch 读 ?bake=0');

console.log('[EditorApp] 编辑器接线');
ok(files.editor.includes("id=\"btnBake\"") || (files.html.includes('id="btnBake"')), '烘焙按钮存在');
ok(files.editor.includes("import {\n  bakeMeshLightmaps, collectBakeableMeshes, applyBakedLightmapsToMeshes, markBakedLayers,\n} from '../world/LightBaker.js'"),
  'EditorApp 从 LightBaker 引入 markBakedLayers（不再本地定义）');
ok(!files.editor.includes('function markBakedLayers(obj) {'), 'EditorApp 已删除本地 markBakedLayers 定义');
ok(files.editor.includes('enableDynamicLighting(scene)'), 'adoptGameScenery 后整场开第 1 层');
ok(files.editor.includes('enableDynamicLighting(rec.obj)'), 'restore 每个摆放体开第 1 层');
ok(files.editor.includes('StepUI.btnBake.onclick = bakeLights'), '烘焙按钮绑定 bakeLights');
ok(files.editor.includes('rec.lightmaps = arr && arr.length ? arr : null'), '烘焙结果写回 rec.lightmaps');
ok(files.editor.includes('lightmaps: (Array.isArray(rec.lightmaps)'), 'restore 读取 it.lightmaps 进 rec');
ok(files.editor.includes('lightmaps: (Array.isArray(rec.lightmaps)') && files.editor.includes('serialize'), 'serialize 写出 lightmaps 进存档');

console.log('[EditorBuildings] 运行时应用 + 分层');
ok(files.eb.includes('import {\n  markBakedLayers, collectBakeableMeshes, applyBakedLightmapsToMeshes,\n} from \'./LightBaker.js\''), 'EditorBuildings 引入烘焙助手');
ok(files.eb.includes('enableDynamicLighting, bakeFeatureEnabled') || files.eb.includes('enableDynamicLighting, bakeFeatureEnabled,'), 'EditorBuildings 引入 enableDynamicLighting/bakeFeatureEnabled');
ok(files.eb.includes('const doMerge = !lightmaps'), '有烘焙结果时跳过跨子网格合并（保网格名对 key）');
ok(files.eb.includes('enableDynamicLighting(holder)'), 'setupModel 默认开第 1 层');
ok(files.eb.includes('applyBakedLightmapsToMeshes(collectBakeableMeshes(holder), lightmaps)'), '运行时按名套回 lightMap');
ok(files.eb.includes('markBakedLayers(holder)'), '运行时 markBakedLayers 关烘焙体第 1 层');
ok(files.eb.includes('bakeFeatureEnabled() && lightmaps'), 'kill-switch 关闭时不套 lightMap');

console.log('[Game] 动态体 + 静态世界分层');
ok(files.game.includes('enableDynamicLighting(this.scene)'), 'buildScenery 后整场开第 1 层');
ok(files.game.includes('enableDynamicLighting(this.vehicle.group)'), '载具开第 1 层');
ok(files.game.includes('enableDynamicLighting(m)') && files.game.includes('enableDynamicLighting(nm)'), '投掷物开第 1 层');
ok(files.game.includes("from '../world/Lights.js'") && files.game.includes('enableDynamicLighting'), 'Game 引入 enableDynamicLighting');

console.log('[PlayerManager / Vehicle] 动态角色分层');
ok(files.pm.includes("import { enableDynamicLighting } from '../world/Lights.js'"), 'PlayerManager 引入 enableDynamicLighting');
ok(files.pm.includes('enableDynamicLighting(remote.model)'), '远程玩家模型开第 1 层');
ok(files.veh.includes("import { enableDynamicLighting } from './Lights.js'"), 'Vehicle 引入 enableDynamicLighting');
ok(files.veh.includes('enableDynamicLighting(group)'), '载具异步模型开第 1 层');

console.log('');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
