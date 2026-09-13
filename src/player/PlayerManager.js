// 职责：管理所有玩家（本地 + 远程）的注册、快照同步与插值更新，作为联机的玩家中心枢纽。
import { RemotePlayer } from './RemotePlayer.js';

export class PlayerManager {
  constructor(scene) {
    this.scene = scene;
    this.players = new Map(); // id -> RemotePlayer（本地玩家也在其中，但模型隐藏）
    this.localId = null;
  }

  // 记录本地玩家的 id
  setLocal(id) {
    this.localId = id;
  }

  // 新增/获取一个玩家：创建 RemotePlayer 并把模型加入场景
  addPlayer(id, stateData) {
    // 已存在则直接返回
    if (this.players.has(id)) {
      return this.players.get(id);
    }

    const remote = new RemotePlayer(id, stateData);
    this.scene.add(remote.model);

    // 本地玩家第一人称看不到自己，模型设为不可见
    if (id === this.localId) {
      remote.model.visible = false;
    }

    this.players.set(id, remote);
    return remote;
  }

  // 从场景移除一个玩家并释放资源
  removePlayer(id) {
    const remote = this.players.get(id);
    if (!remote) return;

    this.scene.remove(remote.model);
    // 释放几何体与材质，避免显存泄漏
    remote.model.traverse((child) => {
      if (child.isMesh) {
        child.geometry?.dispose();
        if (Array.isArray(child.material)) {
          child.material.forEach((m) => m.dispose());
        } else {
          child.material?.dispose();
        }
      }
    });

    this.players.delete(id);
  }

  // 按 id 查找任意玩家
  getPlayer(id) {
    return this.players.get(id);
  }

  // 获取本地玩家
  getLocalPlayer() {
    return this.players.get(this.localId);
  }

  // 收到服务端玩家快照列表时调用：新增/更新远程玩家，并删除已不在列表中的远程玩家。
// 本地玩家会被跳过：本地位置由本地物理预测驱动，绝不能用服务器状态覆盖，否则会抖回原位。
// players：形如 [{id, x, y, z, yaw, pitch, onGround}, ...] 的数组
  applySnapshot(players) {
    const seen = new Set();

    for (const data of players) {
      // 跳过本地玩家，避免服务器状态覆盖本地预测位置
      if (data.id === this.localId) continue;

      seen.add(data.id);
      const remote = this.players.get(data.id);
      if (remote) {
        // 已有玩家：仅更新目标状态，由 RemotePlayer 插值逼近
        remote.applyState(data);
      } else {
        // 新玩家：第一次出现时创建模型并注册
        this.addPlayer(data.id, data);
      }
    }

    // 移除本次快照中不存在的远程玩家（本地玩家始终保留）
    for (const id of [...this.players.keys()]) {
      if (id !== this.localId && !seen.has(id)) {
        this.removePlayer(id);
      }
    }
  }

  // 每帧更新所有远程玩家的插值（本地玩家由 LocalPlayer 直接驱动，跳过）
  update(dt) {
    for (const [id, remote] of this.players) {
      if (id === this.localId) continue;
      remote.update(dt);
    }
  }
}