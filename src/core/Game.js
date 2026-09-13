// 职责：游戏主类，负责装配三大件（渲染器/场景/相机）、输入、玩家，并驱动主循环。
import * as THREE from 'three';
import { Config } from '../config.js';
import { createWorld } from '../world/World.js';
import { Input } from '../core/Input.js';
import { PlayerManager } from '../player/PlayerManager.js';
import { LocalPlayer } from '../player/LocalPlayer.js';

export class Game {
  constructor() {
    // ---- 渲染器 ----
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    document.getElementById('app').appendChild(this.renderer.domElement);

    // ---- 场景与相机 ----
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x87ceeb); // 天空浅蓝

    const aspect = window.innerWidth / window.innerHeight;
    this.camera = new THREE.PerspectiveCamera(70, aspect, 0.1, 500);
    this.camera.rotation.order = 'YXZ';

    // ---- 静态世界 ----
    createWorld(this.scene);

    // ---- 输入 ----
    this.input = new Input();
    this.input.setCanvas(this.renderer.domElement);

    // ---- 玩家管理器：维护所有玩家（本地 + 远程） ----
    this.playerManager = new PlayerManager(this.scene);
    // 暂时给本地玩家一个假的 id（联机时替换为真实身份）
    this.playerManager.setLocal('local');

    // 注入本地玩家的可序列化状态（由 PlayerManager 建好模型并隐藏外观）
    const localSeed = { id: 'local', x: 0, y: Config.PLAYER_HEIGHT, z: 0 };
    this.playerManager.addPlayer('local', localSeed);
    const localState = this.playerManager.getLocalPlayer().state;

    // 本地玩家逻辑
    this.localPlayer = new LocalPlayer(this.camera, this.input, localState);

    // 计时器与 RAF 句柄（便于停止）
    this.clock = new THREE.Clock();
    this._raf = 0;

    // ---- 窗口尺寸自适应 ----
    window.addEventListener('resize', () => this._onResize());
  }

  // 窗口尺寸变化时更新相机纵横比和渲染器尺寸
  _onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  // 启动主循环
  start() {
    this.clock.start();
    this._loop();
  }

  // 主循环：计算 dt -> 更新玩家 -> 渲染
  _loop() {
    this._raf = requestAnimationFrame(() => this._loop());

    // 计算本帧时间间隔；clamp 到 MAX_DELTA_TIME，防止切后台恢复时瞬间跳帧导致角色瞬移
    const dt = Math.min(this.clock.getDelta(), Config.MAX_DELTA_TIME);

    // 更新玩家逻辑（本地玩家 + 远程玩家插值）
    this.localPlayer.update(dt);
    this.playerManager.update(dt);

    // 渲染当前帧
    this.renderer.render(this.scene, this.camera);
  }
}