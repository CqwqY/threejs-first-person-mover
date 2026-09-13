// 职责：游戏主类，负责装配三大件（渲染器/场景/相机）、输入、玩家，并驱动主循环。
import * as THREE from 'three';
import { Config } from '../config.js';
import { createWorld } from '../world/World.js';
import { createProps } from '../world/Props.js';
import { Input } from '../core/Input.js';
import { PlayerManager } from '../player/PlayerManager.js';
import { PlayerState } from '../player/PlayerState.js';
import { LocalPlayer } from '../player/LocalPlayer.js';
import { Network } from '../net/Network.js';

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

    // ---- 场景道具（树/建筑/喷泉/路灯/长椅），接入世界 ----
    createProps(this.scene);

    // ---- 输入 ----
    this.input = new Input();
    this.input.setCanvas(this.renderer.domElement);

    // ---- 玩家管理器：维护所有玩家（本地 + 远程） ----
    // 本地玩家的真实 id 在收到服务器 welcome 时才确定，先前保持 null
    this.playerManager = new PlayerManager(this.scene);

    // 本地玩家的可序列化状态（id 稍后由 welcome 消息填充）
    this.localState = new PlayerState('', 0, Config.PLAYER_HEIGHT, 0);

    // 本地玩家逻辑
    this.localPlayer = new LocalPlayer(this.camera, this.input, this.localState);

    // ---- 网络连接 ----
    this.network = new Network('ws://localhost:8080');
    this.network.onMessage((msg) => this._onNetworkMessage(msg));
    this.network.connect();

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

  // 处理服务器发来的消息（中继协议）
  _onNetworkMessage(msg) {
    switch (msg.t) {
      case 'welcome': {
        // 确定本地 id，注册自己（模型隐藏），并加入服务器已存在的玩家
        this.localState.id = msg.id;
        // 用服务端分配的出生点初始化本地位置/朝向，避免都堆在原点
        this.localState.x = msg.spawn.x;
        this.localState.z = msg.spawn.z;
        this.localState.yaw = msg.spawn.yaw;
        this.playerManager.setLocal(msg.id);
        this.playerManager.addPlayer(msg.id, this.localState, `玩家${msg.num}`);
        for (const p of msg.players) {
          this.playerManager.addPlayer(p.id, p, `玩家${p.num}`);
        }
        break;
      }
      case 'join': {
        // 有新玩家加入：注册并显示模型（名牌按加入序号）
        this.playerManager.addPlayer(msg.id, msg.state, `玩家${msg.state.num}`);
        break;
      }
      case 'leave': {
        // 玩家断开：移除模型
        this.playerManager.removePlayer(msg.id);
        break;
      }
      case 'snapshot': {
        // 周期快照：同步远程玩家（本地由 applySnapshot 内部跳过）
        this.playerManager.applySnapshot(msg.players);
        break;
      }
      default:
        break;
    }
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

    // 上报本地状态（内部按 20Hz 节流）
    this.network.sendState(this.localState.toJSON());

    // 渲染当前帧
    this.renderer.render(this.scene, this.camera);
  }
}