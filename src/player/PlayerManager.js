// 职责：管理所有玩家（本地 + 远程）的注册、快照同步与插值更新，作为联机的玩家中心枢纽。
import { RemotePlayer } from './RemotePlayer.js';
import { enableDynamicLighting } from '../world/Lights.js';

export class PlayerManager {
  constructor(scene) {
    this.scene = scene;
    this.players = new Map(); // id -> RemotePlayer（本地玩家也在其中，但模型隐藏）
    this.localId = null;
    // 快照缺席计数：id -> 连续多少帧没出现在快照里（够数才真删，见 applySnapshot）
    this.miss = new Map();
    // 玩家增删流水（最新在前，最多 8 条）：?pdbg 浮层直接显示，专治「人出现一下就没了」
    //   —— 只看画面分不清是"没加进来"还是"加进来又被删了"，流水一眼定性。
    this.churn = [];
  }

  // 记一条增删流水。kind: 'add' | 'remove'
  _note(kind, id, why) {
    this.churn.unshift({ at: Date.now(), kind, id: String(id), why: why || '' });
    if (this.churn.length > 8) this.churn.length = 8;
    if (kind === 'remove') {
      // 删除必须出声：静默删人正是「人没了还查不到原因」的根源
      console.warn('[PlayerManager] 移除玩家', String(id), '—', why || '（未注明原因）');
    }
  }

  // 记录本地玩家的 id
  setLocal(id) {
    this.localId = id;
  }

  // 新增/获取一个玩家：创建 RemotePlayer 并把模型加入场景
  // name 用于头顶名牌文字；color 为名牌文字颜色；缺省时由 RemotePlayer 按状态里的 num 推导
  // gender：可选，显式指定人物素材（本地玩家用自己选的性别）；不传则由 RemotePlayer 按序号奇偶兜底
  // src：可选，来路标记（welcome/join/snapshot），只用于增删流水，方便排查
  addPlayer(id, stateData, name, color, gender, src) {
    // 已存在则直接返回
    if (this.players.has(id)) {
      return this.players.get(id);
    }

    const remote = new RemotePlayer(id, stateData, name, color, gender);
    this.scene.add(remote.model);
    this.miss.delete(id); // 重新出现：清掉缺席计数
    this._note('add', id, src || '');
    // 远程玩家是动态角色：开第 1 层让太阳实时照它（否则只剩环境光、发灰）。
    enableDynamicLighting(remote.model);
    // ⚠ 这里**不要**调用 applyBackfaceCulling：人物身体是带骨骼的 SkinnedMesh，
    //   骨骼矩阵可能带镜像（负行列式）把三角形绕向翻掉，而 three 只看 matrixWorld ⇒
    //   收敛成单面会让整个人消失（名牌/手持物还在，身体没了）。人物模型自带 noCull 标记，
    //   optimizeEditorScene 的整场景遍历也会跳过它。人物占屏像素少，这点收益不值得冒这个险。

    // 本地玩家第一人称看不到自己，模型设为不可见
    if (id === this.localId) {
      remote.model.visible = false;
    }

    this.players.set(id, remote);
    return remote;
  }

  // 把玩家集合收敛到给定 id 集合：不在集合内的远程玩家立刻移除模型与名牌。
  // 用于 welcome 阶段去重（清除上一会话遗留、或连接上但从未真正加入的僵尸模型）。
  pruneTo(validIds, keepLocal = true) {
    const keep = new Set(validIds);
    if (keepLocal && this.localId != null) keep.add(this.localId);
    for (const id of [...this.players.keys()]) {
      if (keep.has(id)) continue;
      this.removePlayer(id, 'welcome 在线列表里没有他（pruneTo）');
    }
  }

  // 从场景移除一个玩家并释放资源。why 只用于流水/日志，方便事后定位「人为什么没了」
  removePlayer(id, why) {
    const remote = this.players.get(id);
    if (!remote) return;

    this._note('remove', id, why);
    this.miss.delete(id);
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

  // 显示/隐藏本地玩家模型（第一人称隐藏自己，第三人称 F5 显示自己）
  setLocalVisible(v) {
    const local = this.players.get(this.localId);
    if (local) local.model.visible = v;
  }

  // 收到服务端玩家快照列表时调用：新增/更新远程玩家，并删除已不在列表中的远程玩家。
// 本地玩家会被跳过：本地位置由本地物理预测驱动，绝不能用服务器状态覆盖，否则会抖回原位。
// players：形如 [{id, x, y, z, yaw, pitch, onGround}, ...] 的数组
//
// ⚠⚠ 「不在这一帧快照里」≠「他退出了」。曾有这条实现成"单帧缺席就删"：
//   join 让模型出现，下一帧（50ms 后）快照没带上他，人就整个被删了 —— 表现为
//   「玩家加进来的一瞬间模型出来了，然后立即消失」，且零报错。
//   会造成单帧缺席的正常情况不少：丢包、服务端列表抖动、join 与快照的先后空窗、
//   玩家刚换房（换房本来就该由 leave/match 消息负责通知）。
//   ⇒ 删除只认两个权威来源：**leave 消息**与 **welcome 的在线列表**（pruneTo，立即生效）；
//     快照缺席只做兜底，且必须**连续缺席约 2 秒**才动手。
  applySnapshot(players) {
    // 畸形包（players 不是数组）直接忽略：绝不能把「没拿到数据」当成「人都走光了」
    if (!Array.isArray(players)) return;
    const seen = new Set();
    // 快照是 20Hz（50ms/帧）：40 帧 ≈ 2 秒。兜底删除要远慢于任何正常抖动。
    const MISS_LIMIT = 40;

    for (const data of players) {
      // 跳过本地玩家，避免服务器状态覆盖本地预测位置
      if (data.id === this.localId) continue;

      seen.add(data.id);
      this.miss.delete(data.id); // 这帧见到了：清零缺席计数
      const remote = this.players.get(data.id);
      if (remote) {
        // 已有玩家：仅更新目标状态，由 RemotePlayer 插值逼近
        remote.applyState(data);
      } else {
        // 新玩家：第一次出现时创建模型并注册（名牌用服务端下发的昵称/颜色）
        this.addPlayer(data.id, data, data.nick, data.color, undefined, 'snapshot');
      }
    }

    // 兜底清理：连续 MISS_LIMIT 帧都不在快照里才删（正常离开走 leave，这里只兜异常）
    for (const id of [...this.players.keys()]) {
      if (id === this.localId || seen.has(id)) continue;
      const n = (this.miss.get(id) || 0) + 1;
      this.miss.set(id, n);
      if (n >= MISS_LIMIT) {
        this.removePlayer(id, '连续 ' + n + ' 帧不在快照里（约 ' + Math.round(n * 50 / 100) / 10 + ' 秒）');
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