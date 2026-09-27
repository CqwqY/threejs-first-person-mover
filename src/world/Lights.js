// 职责：创建场景光照（环境光 + 方向光）。
// 返回 { group, sun, sunTarget }：sun 为投射阴影的方向光，sunTarget 为阴影聚焦目标，
// 调用方可每帧把 sunTarget 挪到玩家/相机附近，实现「阴影跟随、近处清晰」的效果。
import * as THREE from 'three';
import { DEFAULT_SETTINGS } from '../ui/SettingsPanel.js';

export function createLights() {
  const group = new THREE.Group();

  // 环境光：提供全局均匀的底色照明（偏暗以拉开明暗对比），可在「画面」面板调整
  const ambient = new THREE.AmbientLight(0xffffff, DEFAULT_SETTINGS.ambient);
  group.add(ambient);

  // 半球光：按法线方向给天空色/地面色，模拟间接/弹射光的明暗层次。
  // 朝上的面（地板/桌面）更亮，朝下的面（天花板/底面）更暗——解决室内被主阴影统一盖暗后失去区别的问题。
  const hemi = new THREE.HemisphereLight(0xffffff, 0x222230, DEFAULT_SETTINGS.hemi);
  group.add(hemi);

  // 阳光聚焦目标：shadow 相机以它为中心，跟随玩家移动
  const sunTarget = new THREE.Object3D();
  group.add(sunTarget);

  // 方向光：模拟太阳，带明显明暗对比；同时投影阴影（近处跟随清晰）
  const offset = new THREE.Vector3(30, 40, 20); // 阳光相对 target 的固定偏移，保持整体光向不变
  const directional = new THREE.DirectionalLight(0xffffff, DEFAULT_SETTINGS.sun);
  directional.castShadow = true;
  directional.shadow.mapSize.set(DEFAULT_SETTINGS.shadowSize, DEFAULT_SETTINGS.shadowSize);
  // 阴影痤疮修复：bias 轻微下压深度，normalBias 沿法线推开采样点，消除平面上的「一条一条」条纹
  directional.shadow.bias = -0.0004;
  directional.shadow.normalBias = 1.0;
  const R = DEFAULT_SETTINGS.shadowR; // 阴影覆盖半宽（以 sunTarget 为中心）
  directional.shadow.camera.left = -R;
  directional.shadow.camera.right = R;
  directional.shadow.camera.top = R;
  directional.shadow.camera.bottom = -R;
  directional.shadow.camera.near = 0.5;
  directional.shadow.camera.far = 120;
  directional.target = sunTarget;
  directional.position.copy(sunTarget.position).add(offset);
  group.add(directional);

  return { group, sun: directional, sunTarget, offset, ambient, hemi };
}