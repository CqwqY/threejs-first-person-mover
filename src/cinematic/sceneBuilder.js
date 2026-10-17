// 职责：复用游戏里解耦的场景构建原语，构建一个「无玩家、无联机、无 UI」的纯校园场景，
// 供影片导演模式自由飞 + 逐帧渲染。
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

  // GLB 建筑 + 编辑器点面光源（走本地 public/models；缺失的中文名模型会退化为占位方块）
  buildEditorBuildings(scene, roots);
  buildEditorLights(scene);

  // 等所有资产（天空贴图 + 建筑 GLB）加载完成：连续安静 400ms 才算完，
  // 解决「分批加载，某瞬间 pending===0 误判已完成」的根因。
  const t0 = performance.now();
  for (;;) {
    if (quietFor(400)) break;
    if (performance.now() - t0 > 30000) break; // 弱网 / 离线兜底放行
    await whenIdle().catch(() => {});
    await new Promise((r) => setTimeout(r, 120));
  }
  syncFakeWindowEnvs(scene);

  return { roots, lights, timeSky };
}
