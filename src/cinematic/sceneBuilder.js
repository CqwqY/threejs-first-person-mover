// 职责：复用游戏里解耦的场景构建原语，构建一个「无玩家、无 WebSocket 联机、无 UI」的
// 纯校园场景，供影片导演模式自由飞 + 逐帧渲染；并像游戏内一样从服务器拉取最新编辑器场景。
//
// 不 import Game：它构造即连 WebSocket，并拉进整套 UI/玩家/战斗系统，与影片无关。
// 这里只串起一组干净的独立导出函数（详见 first-person-mover 调研）。
import * as THREE from 'three';
import { buildScenery } from '../world/buildScenery.js';
import { createTimeSky } from '../world/SkyBox.js';
import { createLights } from '../world/Lights.js';
import {
  buildEditorBuildings,
  buildEditorLights,
  syncFakeWindowEnvs,
  fetchRemoteScene,
  optimizeEditorScene,
} from '../world/EditorBuildings.js';
import { whenIdle, quietFor } from '../world/loadTracker.js';

// 构建校园场景。renderer 需要传入（天空/环境反射用 PMREM 生成）。
// 返回 { roots, lights, timeSky }；timeSky 有 .update(t, camera) 供天色随时间变化（可选）。
export async function buildCampusScene(scene, renderer) {
  const roots = buildScenery(scene);

  const lights = createLights();
  scene.add(lights.group);

  // 天空球壳 + 4 时段环境贴图（异步加载，内部用 track 登记到 loadTracker）
  const timeSky = createTimeSky(scene, renderer, {
    onEnvChange: () => syncFakeWindowEnvs(scene),
  });

  // GLB 建筑 + 编辑器点面光源（先用打包数据，保证离线也有内容）
  buildEditorBuildings(scene, roots);
  buildEditorLights(scene);

  // 在线同步：从服务器拉取最新编辑器场景（与游戏内「保存场景」同一份），
  // 拉到则替换打包数据重建；拉取失败静默回退打包数据（与 Game 行为一致）。
  // ⚠ 不 import Game（其构造即连 WebSocket）；这里只用 EditorBuildings 的独立导出函数。
  //    模型 URL 由 AssetLoader.resolveUrl 自动把 /assets/import-*、/assets/furn_* 改写到
  //    API_BASE（游戏服务器），因此从 Pages 也能正确拉到服务器托管的模型。
  let remote = null;
  try { remote = await fetchRemoteScene(); } catch (e) { remote = null; }
  if (remote) {
    try {
      buildEditorBuildings(scene, roots, remote); // clearHolders 先清掉上一次，安全重跑
      buildEditorLights(scene, remote);
    } catch (e) {
      console.warn('[cinematic] 应用远程场景失败，回退打包数据:', e);
    }
  }

  // 等所有资产（天空贴图 + 建筑 GLB，含远端触发的加载）加载完成：连续安静 400ms 才算完，
  // 解决「分批加载，某瞬间 pending===0 误判已完成」的根因。
  const t0 = performance.now();
  for (;;) {
    if (quietFor(400)) break;
    if (performance.now() - t0 > 30000) break; // 弱网 / 离线兜底放行
    await whenIdle().catch(() => {});
    await new Promise((r) => setTimeout(r, 120));
  }
  // 远端场景替换后，再跑一次跨物件合并 + 距离分级（与 Game 一致，省 draw call）
  if (remote) { try { await optimizeEditorScene(scene); } catch (e) { console.warn('[cinematic] 场景优化失败:', e); } }
  syncFakeWindowEnvs(scene);

  return { roots, lights, timeSky };
}
