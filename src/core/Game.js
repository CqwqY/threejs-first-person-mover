// 职责：游戏主类，负责装配三大件（渲染器/场景/相机）、输入、玩家，并驱动主循环。
import * as THREE from 'three';
import { Config, API_BASE } from '../config.js';
import { buildScenery } from '../world/buildScenery.js';
import { attachSky } from '../world/SkyBox.js';
import { createLights } from '../world/Lights.js';
import { createSettingsPanel, createSettingsButton, loadSettings, computeSunOffset } from '../ui/SettingsPanel.js';
import { createPlayerHUD } from '../ui/PlayerHUD.js';
import { createNpcChat } from '../ui/NpcChat.js';
import { createAiNpc } from '../world/AiNpc.js';
import { buildEditorBuildings, fetchRemoteScene } from '../world/EditorBuildings.js';
import { Input } from '../core/Input.js';
import { PlayerManager } from '../player/PlayerManager.js';
import { PlayerState } from '../player/PlayerState.js';
import { LocalPlayer } from '../player/LocalPlayer.js';
import { setModelScale, setHeldText } from '../player/PlayerModel.js';
import { getBagKey, addToBag, loadBag, removeFromBag } from '../player/Inventory.js';
import { createSkillSlots, SLOT_COUNT } from '../ui/SkillSlots.js';
import { Network } from '../net/Network.js';
import { addDebugRig } from '../debug/SkeletonDebug.js';

// 在线同步辅助：拉取后端最新场景，成功则用其重建场景建筑并写入同一份碰撞体数组。
// target 必须是 LocalPlayer 持有的那条共享数组：buildEditorBuildings 会把同步碰撞体与
// 异步烘焙出的 trimesh 都 push 进这个引用，否则异步结果会落进一个没人读的临时数组。
async function _fetchRemoteScene(scene, roots, target) {
  const data = await fetchRemoteScene();
  if (!data) return; // 拉取失败：保持打包的 editorMapData 兜底
  try {
    target.length = 0;
    buildEditorBuildings(scene, roots, data, target);
  } catch (e) {
    console.warn('[Game] 应用远程场景失败，回退打包数据:', e);
  }
}

export class Game {
  // token：登录会话 token（游客为空串）；profile：登录成功返回的用户资料（点名牌用）
  constructor(token = '', profile = null) {
    this._token = token;
    this._profile = profile;
    this._placed = false; // 是否已用服务端出生点定位过（断线重连不再重定位，避免被拉回出生点）

    // ---- 渲染器 ----
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    document.getElementById('app').appendChild(this.renderer.domElement);

    // ---- 场景与相机 ----
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x87ceeb); // 天空浅蓝（兜底，贴图/天空盒覆盖其上）
    attachSky(this.scene); // 城市天空贴图（优先）→ 程序化天空兜底

    const aspect = window.innerWidth / window.innerHeight;
    this.camera = new THREE.PerspectiveCamera(70, aspect, 0.1, 500);
    this.camera.rotation.order = 'YXZ';

    // ---- 静态世界（地面/道路/墙体 + 道具），返回统一的可编辑根列表 ----
    const roots = buildScenery(this.scene);
    // 灯光单独挂载（不作为可编辑景物）；阴影聚焦目标随玩家移动
    const lights = createLights();
    this.scene.add(lights.group);
    this._sunTarget = lights.sunTarget;
    this._sunOffset = lights.offset;
    this._sun = lights.sun;
    this._ambient = lights.ambient; // 供画面面板绑定；游戏端不透出强度调整
    this._hemi = lights.hemi;

    // 应用编辑器保存的「光照设计」：环境光/半球光/阳光强度、阳光角度，使客户端与编辑器保持一致；
    // 若编辑器从未保存过，则自动落到 DEFAULT_SETTINGS 的默认值。
    const design = loadSettings('scene-settings-v1');
    this._ambient.intensity = design.ambient;
    this._hemi.intensity = design.hemi;
    this._sun.intensity = design.sun;
    const dOff = computeSunOffset(design.sunElev, design.sunAz);
    this._sunOffset.set(dOff.x, dOff.y, dOff.z);

    // ---- 编辑器开发的地图：import src/world/editorMapData.js 渲染保存的建筑 ----
    this.colliders = buildEditorBuildings(this.scene, roots);

    // 在线同步：运行时从后端拉取最新场景（编辑器保存的那份），拉到则替换打包数据重建。
    // 拉取失败会自动回退到上面打包的 editorMapData，保证离线时也有内容。
    // 注意：LocalPlayer 持有 this.colliders 的同一条数组引用，因此原地改写而不是整体替换。
    _fetchRemoteScene(this.scene, roots, this.colliders);

    // ---- 输入 ----
    this.input = new Input();
    this.input.setCanvas(this.renderer.domElement);

    // ---- 玩家管理器：维护所有玩家（本地 + 远程） ----
    // 本地玩家的真实 id 在收到服务器 welcome 时才确定，先前保持 null
    this.playerManager = new PlayerManager(this.scene);

    // 本地玩家的可序列化状态（id 稍后由 welcome 消息填充）
    this.localState = new PlayerState('', 0, Config.PLAYER_HEIGHT, 0);

    // 本地玩家逻辑
    this.localPlayer = new LocalPlayer(this.camera, this.input, this.localState, this.colliders);

    // ---- 网络连接 ----
    this.network = new Network(Config.RELAY_URL, this._token);
    this.network.onMessage((msg) => this._onNetworkMessage(msg));
    this.network.connect();

    // 计时器与 RAF 句柄（便于停止）
    this.clock = new THREE.Clock();
    this._raf = 0;

    // 调试：URL 带 ?rigdebug 时，在场景中放一个可见调试模型并画出骨骼与坐标轴
    this.debugRig = /\brigdebug\b/.test(location.search) ? addDebugRig(this.scene) : null;

    // 第三人称相机（F5 切换，可看到自己的角色）
    this.thirdPerson = false;
    this._tpTime = 0;
    this._tpPrevX = 0;
    this._tpPrevZ = 0;
    window.addEventListener('keydown', (e) => {
      if (e.key === 'F5') {
        e.preventDefault(); // 阻止浏览器默认刷新
        this.toggleThirdPerson();
      }
    });

    // ---- 窗口尺寸自适应 ----
    window.addEventListener('resize', () => this._onResize());

    // ---- 画面设置面板（游戏端）：只开放视距 + 阴影等图形项，不开放光照强度 ----
    this.settingsPanel = createSettingsPanel(
      {
        viewFar: (v) => {
          this.camera.far = v;
          this.camera.updateProjectionMatrix();
        },
        shadowR: (v) => {
          const cam = this._sun.shadow.camera;
          cam.left = -v;
          cam.right = v;
          cam.top = v;
          cam.bottom = -v;
          cam.updateProjectionMatrix();
        },
        shadowSize: (v) => {
          this._sun.shadow.mapSize.set(v, v);
          if (this._sun.shadow.map) {
            this._sun.shadow.map.dispose();
            this._sun.shadow.map = null;
          }
        },
        castShadow: (v) => {
          this.renderer.shadowMap.enabled = !!v;
          this._sun.castShadow = !!v;
        },
      },
      {
        fields: ['viewFar', 'shadowR', 'shadowSize', 'castShadow'],
        storeKey: 'scene-settings-game-v1',
      }
    );
    // 设置入口：停靠在屏幕右侧中部，齿轮图标
    createSettingsButton({
      panel: this.settingsPanel,
      icon: true,
      position: { right: 18, top: '50%', centerY: true },
    });

    // 顶部校卡：显示当前账号名字，点击展开查看详情，并可在卡内退出登录
    this.playerHUD = createPlayerHUD(this._profile, !!this._token);
    // 顶部校卡两侧：左侧「背包」、右侧「设置」
    this._createTopButtons();

    // ---- AI 商人 NPC：出生点旁喷泉处的阿花，靠近按 F 或点右侧选项卡打开对话栏 ----
    this.aiChat = createNpcChat();
    this.aiChat.setOnSend((text) => this._npcSend(text));
    this.aiChat.setOnOpen(() => { this._setChatLock(true); });
    this.aiChat.setOnClose(() => { this._setChatLock(false); });
    this.aiNpc = createAiNpc();
    this.aiNpc.setInteract(() => this._openChat());
    this.scene.add(this.aiNpc.group);
    // 屏幕中心右侧的「与阿花对话」选项卡：仅在靠近阿花时显示，点击开/关对话栏
    this._createChatTab();
    this.aiNpc.onRange((r) => { this._chatTab.style.display = r ? '' : 'none'; });

    // 技能槽：阿花给的物品在此变为可点/可按数字键触发的技能；恢复上次指定的槽位
    this.skillSlots = createSkillSlots();
    this._skillMap = this._loadSkillSlots();
    this._restoreSkills();

    // 本地可拾取的「生成物品」发光道具
    this._pickups = [];

    // 血量与战斗：血量存在 localState 里（会随状态同步给其他玩家）
    this.localState.health = Config.HEALTH_MAX;
    this._dead = false;
    this._createHealthBar();
    this._projectiles = []; // 在飞的投掷物
  }

  // 左下角血量条：数值 + 横条，满血绿色、越低越红
  _createHealthBar() {
    const box = document.createElement('div');
    box.style.cssText =
      'position:fixed;left:18px;bottom:22px;z-index:53;width:min(240px,42vw);' +
      'font:12px/1.3 system-ui,"Microsoft YaHei",sans-serif;color:#fff;user-select:none;pointer-events:none;';
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;justify-content:space-between;margin-bottom:4px;text-shadow:0 1px 3px rgba(0,0,0,.6);';
    const label = document.createElement('span');
    label.textContent = '生命';
    const num = document.createElement('span');
    num.textContent = Config.HEALTH_MAX + ' / ' + Config.HEALTH_MAX;
    row.appendChild(label);
    row.appendChild(num);
    const track = document.createElement('div');
    track.style.cssText =
      'height:10px;border-radius:6px;background:rgba(10,16,26,.65);border:1px solid rgba(255,255,255,.28);overflow:hidden;';
    const fill = document.createElement('div');
    fill.style.cssText = 'height:100%;width:100%;background:#2ecc71;transition:width .18s ease,background .18s ease;';
    track.appendChild(fill);
    box.appendChild(row);
    box.appendChild(track);
    document.body.appendChild(box);
    this._hpNum = num;
    this._hpFill = fill;
  }

  // 刷新血量条显示
  _updateHealthBar() {
    if (!this._hpFill) return;
    const max = Config.HEALTH_MAX;
    const hp = Math.max(0, Math.min(max, Math.round(this.localState.health)));
    const ratio = hp / max;
    this._hpFill.style.width = (ratio * 100).toFixed(1) + '%';
    this._hpFill.style.background = ratio > 0.5 ? '#2ecc71' : (ratio > 0.2 ? '#f1c40f' : '#e74c3c');
    this._hpNum.textContent = hp + ' / ' + max;
  }

  // 扣血/回血（正数回血、负数扣血）；到 0 触发死亡重生
  _changeHealth(delta) {
    const max = Config.HEALTH_MAX;
    const next = Math.max(0, Math.min(max, this.localState.health + delta));
    this.localState.health = next;
    this._updateHealthBar();
    if (next <= 0 && !this._dead) this._die();
  }

  // 死亡：锁住操控，短暂延迟后满血重生到出生点
  _die() {
    this._dead = true;
    this._setChatLock(true);
    this._toast('你被击倒了，即将在出生点重生');
    setTimeout(() => this._respawn(), Config.RESPAWN_DELAY * 1000);
  }

  // 重生：满血、清速度，回到服务器分配的出生点
  _respawn() {
    const sp = this._spawn || { x: 0, z: 0, yaw: 0 };
    this.localState.health = Config.HEALTH_MAX;
    this.localState.x = sp.x;
    this.localState.z = sp.z;
    this.localState.yaw = sp.yaw || 0;
    this.localState.y = Config.PLAYER_HEIGHT * this.localPlayer.physics.sizeScale;
    this.localPlayer.physics.velocity.set(0, 0, 0);
    this._dead = false;
    this._setChatLock(false);
    this._updateHealthBar();
    this._toast('已在出生点重生');
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
      case 'auth': {
        // 服务端确认登录结果：刷新本地资料（昵称/颜色用于 HUD 与自己的名牌）
        if (msg.ok && msg.profile) {
          this._profile = msg.profile;
          this.playerHUD.setProfile(msg.profile);
          this._refreshLocalLabel();
        } else if (!msg.ok) {
          // 令牌失效：清掉本地会话，退回游客态（下次进入会重新弹登录）
          localStorage.removeItem('fp_token');
          this._profile = null;
          this.playerHUD.setProfile(null, false);
          this._refreshLocalLabel();
        }
        break;
      }
      case 'welcome': {
        // 确定本地 id，注册自己（模型隐藏），并加入服务器已存在的玩家
        const firstPlace = !this._placed; // 仅首次进入才用出生点；重连保留当前位置
        this.localState.id = msg.id;
        // 用服务端分配的出生点初始化本地位置/朝向，避免都堆在原点
        if (firstPlace) {
          this.localState.x = msg.spawn.x;
          this.localState.z = msg.spawn.z;
          this.localState.yaw = msg.spawn.yaw;
          this._placed = true;
        }
        this._spawn = msg.spawn; // 记住出生点，死亡重生时用
        this.localState.num = msg.num; // 本地也要知道自己序号，保证第三人称看到的男女与别人看到的一致
        this.playerManager.setLocal(msg.id);
        // 本地名牌：登录了用昵称，否则游客样式
        const myNick = this._profile ? (this._profile.nickname || this._profile.username || `玩家${msg.num}`) : `玩家${msg.num}`;
        const myColor = this._profile ? (this._profile.nicknameColor || '#ffffff') : '#ffffff';
        this.playerManager.addPlayer(msg.id, this.localState, myNick, myColor);
        for (const p of msg.players) {
          this.playerManager.addPlayer(p.id, p, p.nick || `玩家${p.num}`, p.color || '#ffffff');
        }
        // 服务器为准：移除不在当前在线列表中的远程模型/名牌（清除未加入或已断开连接的残留）
        this.playerManager.pruneTo(msg.players.map((p) => p.id));
        break;
      }
      case 'join': {
        // 有新玩家加入：注册并显示模型（名牌用服务端下发的昵称/颜色）
        this.playerManager.addPlayer(msg.id, msg.state, msg.state.nick || `玩家${msg.state.num}`, msg.state.color || '#ffffff');
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
      case 'hit': {
        // 别人用投掷物打中了我：扣血（伤害已由服务端钳制）
        const dmg = Number(msg.damage) || 0;
        if (dmg > 0 && !this._dead) {
          this._changeHealth(-dmg);
          this._toast('受到 ' + dmg + ' 点伤害');
        }
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

  // F5 切换第一/第三人称视角；第三人称时显示自己的模型
  toggleThirdPerson() {
    this.thirdPerson = !this.thirdPerson;
    this.playerManager.setLocalVisible(this.thirdPerson);
  }

  // 刷新本地玩家头顶名牌（登录资料晚于 welcome 到达时调用；第三人称可见）
  _refreshLocalLabel() {
    const local = this.playerManager.getLocalPlayer();
    if (!local) return;
    if (this._profile) {
      local.setLabel(
        this._profile.nickname || this._profile.username || '',
        this._profile.nicknameColor || '#ffffff'
      );
    } else {
      local.setLabel(`玩家${this.localState.num}`);
    }
  }

  // 打开对话栏：退出指针锁定并锁定操控（对话期间移动键不响应）
  _openChat() {
    if (this.aiChat.isOpen()) return;
    document.exitPointerLock && document.exitPointerLock();
    this.aiChat.open();
  }
  _setChatLock(locked) {
    if (this.localPlayer && this.localPlayer.physics) this.localPlayer.physics.controlLock = !!locked;
  }

  // 屏幕中心右侧的「按 F 与她对话」选项卡：仅靠近阿花显示，点击开/关底部对话栏；位置略往中间收
  _createChatTab() {
    const el = document.createElement('div');
    el.textContent = '按 F 与她对话';
    el.style.cssText =
      'position:fixed;right:26%;top:50%;transform:translateY(-50%);z-index:9500;cursor:pointer;display:none;' +
      'background:linear-gradient(150deg,#3b7ddd,#1e55a8);color:#fff;padding:12px 14px;border-radius:14px;' +
      'box-shadow:0 6px 20px rgba(0,0,0,.3);user-select:none;' +
      'font:13px/1.4 system-ui,"Microsoft YaHei",sans-serif;text-align:center;';
    el.addEventListener('click', () => { this.aiChat.toggle(); });
    document.body.appendChild(el);
    this._chatTab = el;
  }

  // 顶部校卡两侧按钮：左侧「背包」、右侧「设置」+ 一个展示物品的背包浮层
  _createTopButtons() {
    const mkBtn = (text, posCss, onClick) => {
      const b = document.createElement('div');
      b.textContent = text;
      b.style.cssText =
        'position:fixed;z-index:9500;cursor:pointer;user-select:none;' +
        'background:linear-gradient(150deg,#3b7ddd,#1e55a8);color:#fff;padding:10px 13px;border-radius:12px;' +
        'box-shadow:0 6px 18px rgba(0,0,0,.25);font:13px system-ui,"Microsoft YaHei",sans-serif;' + posCss;
      b.addEventListener('click', onClick);
      document.body.appendChild(b);
      return b;
    };
    // 校卡在 top 14px 居中(宽最大224)，按钮让它贴着卡左右两侧
    this._btnBag = mkBtn('背包', 'right:calc(50% + 122px);top:14px;', () => this._toggleBag());
    this._btnSettings = mkBtn('设置', 'left:calc(50% + 122px);top:14px;', () => this.settingsPanel.toggle());
    this._buildBag();
  }

  _buildBag() {
    const ov = document.createElement('div');
    ov.style.cssText =
      'position:fixed;z-index:9700;top:0;left:0;width:100vw;height:100vh;overflow:auto;' +
      'background:rgba(255,255,255,.96);' +
      'box-sizing:border-box;padding:70px 24px 40px;display:none;' +
      'font:14px/1.5 system-ui,"Microsoft YaHei",sans-serif;color:#1f2933;';
    ov.innerHTML =
      '<div style="position:fixed;top:0;left:0;right:0;z-index:1;display:flex;justify-content:space-between;align-items:center;' +
      'background:linear-gradient(150deg,#3b7ddd,#1e55a8);color:#fff;padding:14px 18px;box-sizing:border-box;">' +
      '<h2 style="margin:0;font-size:17px;font-weight:700;">我的背包</h2>' +
      '<button type="button" style="border:0;background:rgba(255,255,255,.2);color:#fff;cursor:pointer;' +
      'font-size:16px;width:34px;height:34px;border-radius:8px;">×</button></div>' +
      '<div class="bag-grid"></div>';
    document.body.appendChild(ov);
    ov.querySelector('button').addEventListener('click', () => { ov.style.display = 'none'; });
    this._bagOv = ov;
    this._bagList = ov.querySelector('.bag-grid');
  }

  _toggleBag() {
    this._renderBag();
    this._bagOv.style.display = this._bagOv.style.display === 'none' ? 'block' : 'none';
  }

  _renderBag() {
    const bag = loadBag(getBagKey(this._profile));
    const entries = Object.entries(bag).filter(([, v]) => v > 0);
    const grid = this._bagList;
    grid.innerHTML = '';
    if (!entries.length) {
      grid.style.cssText = 'text-align:center;color:#7b8794;padding:40px 0;';
      grid.textContent = '背包空空如也，去喷泉边找阿花要宝贝吧。';
      return;
    }
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:14px;padding-top:6px;';
    for (const [name, count] of entries) {
      const eff = this._effectForItem(name);
      const card = document.createElement('div');
      card.style.cssText =
        'display:flex;flex-direction:column;align-items:center;gap:8px;padding:16px 12px;' +
        'border:1px solid #e2e8f0;border-radius:14px;background:#fff;box-shadow:0 4px 14px rgba(0,0,0,.06);';
      // 图标：带颜色的圆角方块，里面放物品名的首字（阿花挑的图标以物品名首个字符为代表）
      const icon = document.createElement('div');
      icon.textContent = name.charAt(0) || '?';
      icon.style.cssText =
        'width:46px;height:46px;border-radius:12px;display:flex;align-items:center;justify-content:center;' +
        'background:' + this._itemColor(name) + ';color:#fff;font-weight:700;font-size:20px;';
      const meta = document.createElement('div');
      meta.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:2px;text-align:center;';
      const nameEl = document.createElement('div');
      nameEl.textContent = name;
      nameEl.style.cssText = 'font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:120px;';
      const countEl = document.createElement('div');
      countEl.textContent = '× ' + count + '   ·' + eff.label;
      countEl.style.cssText = 'font-size:12px;color:#7b8794;';
      const useBtn = document.createElement('button');
      useBtn.type = 'button';
      useBtn.textContent = '使用';
      useBtn.style.cssText =
        'border:0;cursor:pointer;border-radius:8px;padding:6px 18px;color:#fff;font-weight:600;' +
        'background:linear-gradient(150deg,#3b7ddd,#1e55a8);';
      // 槽位选择：选「直接使用」则只触发效果；选具体槽位则把该物品指定到该技能键后再触发
      const slotSel = document.createElement('select');
      slotSel.style.cssText =
        'font:12px/1.4 system-ui,"Microsoft YaHei",sans-serif;color:#1f2933;border:1px solid #cbd5e1;' +
        'border-radius:8px;padding:4px 6px;background:#fff;cursor:pointer;max-width:130px;';
      const optNone = document.createElement('option');
      optNone.value = '';
      optNone.textContent = '直接使用';
      slotSel.appendChild(optNone);
      for (let i = 0; i < SLOT_COUNT; i++) {
        const o = document.createElement('option');
        o.value = String(i);
        o.textContent = '装备到 ' + (i + 1) + ' 号槽';
        slotSel.appendChild(o);
      }
      // 已经指定到某槽时，默认选中该槽，方便看出当前归属
      const cur = Object.keys(this._skillMap).find((k) => this._skillMap[k] === name);
      if (cur != null) slotSel.value = String(cur);
      useBtn.addEventListener('click', () => {
        const v = slotSel.value;
        this._useItem(name, v === '' ? null : Number(v));
        this._renderBag();
      });
      // 销毁：把该物品从背包里丢掉（每次减 1，减到 0 整条移除）
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.textContent = '销毁';
      delBtn.style.cssText =
        'border:1px solid #e0b4b4;cursor:pointer;border-radius:8px;padding:5px 14px;color:#b03030;font-weight:600;background:#fff;';
      delBtn.addEventListener('click', () => {
        removeFromBag(getBagKey(this._profile), name, 1);
        this._renderBag();
      });
      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;flex-direction:column;gap:6px;align-items:center;width:100%;';
      btnRow.appendChild(slotSel);
      btnRow.appendChild(useBtn);
      btnRow.appendChild(delBtn);
      meta.appendChild(nameEl);
      meta.appendChild(countEl);
      card.appendChild(icon);
      card.appendChild(meta);
      card.appendChild(btnRow);
      grid.appendChild(card);
    }
  }

  // 把玩家一句话发给后端 GLM 代理，拿到 {reply, action} 后：展示回复并执行工具动作。
  async _npcSend(text) {
    const aichat = this.aiChat;
    aichat.addMsg('busy', '阿花正在想…');
    const msgs = this._npcHistory || [];
    msgs.push({ role: 'user', content: text });
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 20000) : null;
    try {
      const res = await fetch(API_BASE + '/api/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: msgs }),
        signal: ctrl ? ctrl.signal : undefined,
      });
      if (timer) clearTimeout(timer);
      const data = await res.json();
      if (!data || !data.ok) throw new Error((data && data.error) || ('http ' + res.status));
      const reply = data.reply || '…';
      msgs.push({ role: 'assistant', content: reply });
      // 只保留最近若干条，避免历史无限膨胀
      this._npcHistory = msgs.slice(-12);
      aichat.addMsg('npc', reply);
      if (data.action) this._executeNpcAction(data.action);
    } catch (e) {
      aichat.addMsg('npc', '阿花好像卡住了，请稍后再试。');
    }
  }

  // 执行 GLM 点名的工具动作。所有参数已经过后端清洗（越界值被钳制或整条丢弃），这里只做贴上玩家。
  _executeNpcAction(action) {
    if (!action || !action.name) return;
    const state = this.localState;
    const phys = this.localPlayer.physics;
    const a = action.args || {};
    // 带 seconds 的动作：到点自动恢复默认值（只在该值没被后续动作覆盖时还原）
    const after = (secs, fn) => { if (secs && secs > 0) setTimeout(fn, secs * 1000); };
    switch (action.name) {
      case 'set_player_speed': {
        const m = a.multiplier;
        phys.speedMult = m;
        if (a.mode) phys.speedMode = a.mode;
        this._toast('速度 ×' + m + (a.mode && a.mode !== 'walk' ? '（' + a.mode + '）' : ''));
        after(a.seconds, () => { if (phys.speedMult === m) { phys.speedMult = 1; phys.speedMode = 'walk'; } });
        break;
      }
      case 'set_player_size': {
        const s = a.scale;
        phys.sizeTarget = s;
        this._toast('体型已变为 ' + s + ' 倍');
        after(a.seconds, () => { if (phys.sizeTarget === s) phys.sizeTarget = 1; });
        break;
      }
      case 'teleport_player':
      case 'set_player_position': {
        const x = a.x;
        const z = a.z;
        if (Number.isFinite(x)) state.x = THREE.MathUtils.clamp(x, -Config.GROUND_WIDTH / 2, Config.GROUND_WIDTH / 2);
        if (Number.isFinite(z)) state.z = THREE.MathUtils.clamp(z, -Config.GROUND_DEPTH / 2, Config.GROUND_DEPTH / 2);
        if (Number.isFinite(a.y)) state.y = a.y;
        else state.y = Config.PLAYER_HEIGHT * phys.sizeScale;
        this._toast('已移动');
        break;
      }
      case 'set_player_jump': {
        const m = a.multiplier;
        phys.jumpMult = m;
        if (a.max_jumps) phys.maxJumps = a.max_jumps;
        this._toast('起跳力度 ×' + m + (a.max_jumps ? '，最多连跳 ' + a.max_jumps + ' 次' : ''));
        after(a.seconds, () => {
          if (phys.jumpMult === m) phys.jumpMult = 1;
          if (a.max_jumps) phys.maxJumps = 1;
        });
        break;
      }
      case 'set_player_gravity': {
        const m = a.multiplier;
        phys.gravityMult = m;
        if (a.terminal_velocity) phys.terminalVelocity = a.terminal_velocity;
        this._toast('重力 ×' + m + (a.terminal_velocity ? '，终端速度 ' + a.terminal_velocity : ''));
        after(a.seconds, () => {
          if (phys.gravityMult === m) phys.gravityMult = 1;
          if (a.terminal_velocity) phys.terminalVelocity = null;
        });
        break;
      }
      case 'set_player_velocity': {
        // 有 seconds：这段时间内每帧强制该速度；无 seconds：只给一次瞬时冲量
        if (a.seconds && a.seconds > 0) {
          phys.velocityHold = { x: a.x, y: a.y, z: a.z, t: a.seconds };
        } else {
          if (Number.isFinite(a.x)) phys.velocity.x = a.x;
          if (Number.isFinite(a.y)) phys.velocity.y = a.y;
          if (Number.isFinite(a.z)) phys.velocity.z = a.z;
        }
        this._toast('已施加速度' + (a.seconds ? '（持续 ' + a.seconds + ' 秒）' : ''));
        break;
      }
      case 'set_player_friction': {
        const m = a.multiplier;
        phys.frictionMult = m;
        this._toast('地面摩擦 ×' + m);
        after(a.seconds, () => { if (phys.frictionMult === m) phys.frictionMult = 1; });
        break;
      }
      case 'set_player_acceleration': {
        const m = a.multiplier;
        phys.accelMult = m;
        this._toast('加速度 ×' + m);
        after(a.seconds, () => { if (phys.accelMult === m) phys.accelMult = 1; });
        break;
      }
      case 'grant_jetpack': {
        phys.jetpack = !!a.on;
        this._toast(phys.jetpack ? '喷气背包已开启，空中按住空格上升' : '喷气背包已关闭');
        after(a.seconds, () => { phys.jetpack = false; });
        break;
      }
      case 'set_player_health': {
        if (Number.isFinite(a.value)) {
          const target = Math.max(0, Math.min(Config.HEALTH_MAX, a.value));
          this.localState.health = target;
          this._updateHealthBar();
          if (target <= 0 && !this._dead) this._die();
        } else if (Number.isFinite(a.delta)) {
          this._changeHealth(a.delta);
        }
        this._toast('血量：' + Math.round(this.localState.health) + ' / ' + Config.HEALTH_MAX);
        break;
      }
      case 'hold_item': {
        // 手持物：默认就是手上举着一段文字（第三人称与他人可见）
        const text = a.text || '';
        this.localState.hold = text;
        this._toast(text ? '手持：' + text : '已放下手持物');
        break;
      }
      case 'spawn_projectile': {
        // 直接投掷：伤害/范围由阿花指定，后端已钳制
        const dmg = Number(a.damage) || 0;
        this._throwProjectile({
          damage: dmg,
          radius: Number(a.radius) || 2,
          speed: Number(a.speed) || Config.PROJECTILE_SPEED,
          color: dmg > 0 ? 0xff6a3c : 0x4cd97b,
        });
        this._toast(dmg > 0 ? '投掷物已出手（伤害 ' + dmg + '）' : '投掷物已出手');
        break;
      }
      case 'spawn_item': {
        // 阿花把物品放进玩家背包，并记住她给的效果（{k,v,s} 或 null）
        const item = a.item || '神秘物品';
        const effKey = a.effect || null;
        const key = getBagKey(this._profile);
        const n = addToBag(key, item, 1);
        this._storeItemEffect(item, effKey);
        // 诊断用：把阿花返回的原始动作打到控制台，便于确认她到底写了什么效果
        console.log('[阿花 action]', JSON.stringify(action));
        this._toast('阿花把「' + item + '」放进背包 · 效果：' + this._describeEffect(effKey));
        this._equipItemSkill(item);
        break;
      }
      default:
        break;
    }
  }

  // 投掷物：沿视线方向抛出一个小球，飞行中受重力，撞地或撞到玩家后爆开结算范围效果
  _throwProjectile(spec) {
    const s = this.localState;
    const cosP = Math.cos(s.pitch);
    const sinP = Math.sin(s.pitch);
    const dir = new THREE.Vector3(-Math.sin(s.yaw) * cosP, sinP, -Math.cos(s.yaw) * cosP);
    const start = new THREE.Vector3(s.x, s.y, s.z).addScaledVector(dir, 0.8);
    const color = spec.color || 0xff6a3c;
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 12, 12),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.1 })
    );
    mesh.position.copy(start);
    this.scene.add(mesh);
    this._projectiles.push({
      mesh,
      vel: dir.clone().multiplyScalar(spec.speed || Config.PROJECTILE_SPEED),
      life: 4,
      damage: spec.damage || 0,
      radius: spec.radius || 2,
    });
  }

  // 每帧推进所有投掷物：受重力、撞地/命中玩家即爆开
  _updateProjectiles(dt) {
    if (!this._projectiles.length) return;
    for (let i = this._projectiles.length - 1; i >= 0; i--) {
      const p = this._projectiles[i];
      p.vel.y += Config.GRAVITY * dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      p.life -= dt;
      const pos = p.mesh.position;
      let hit = p.life <= 0 || pos.y <= 0.12;
      if (!hit) {
        // 竖直圆柱近似：水平 0.8 米内、高度区间内视为命中其他玩家
        for (const [id, rp] of this.playerManager.players) {
          if (id === this.localState.id) continue;
          const st = rp.state;
          const d = Math.hypot(pos.x - st.x, pos.z - st.z);
          if (d < 0.8 && Math.abs(pos.y - (st.y - Config.PLAYER_HEIGHT / 2)) < 1.2) { hit = true; break; }
        }
      }
      if (!hit) continue;
      this._explode(p);
      this.scene.remove(p.mesh);
      p.mesh.geometry.dispose();
      p.mesh.material.dispose();
      this._projectiles.splice(i, 1);
    }
  }

  // 爆开：范围内玩家受伤（自己也在范围内就一起结算），并画一圈扩散光环
  _explode(p) {
    const c = p.mesh.position;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(Math.max(0.2, p.radius * 0.45), p.radius, 32),
      new THREE.MeshBasicMaterial({
        color: p.damage > 0 ? 0xff5a3c : 0x4cd97b,
        transparent: true, opacity: 0.55, side: THREE.DoubleSide,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(c.x, 0.06, c.z);
    this.scene.add(ring);
    setTimeout(() => { this.scene.remove(ring); ring.geometry.dispose(); ring.material.dispose(); }, 450);

    if (!p.damage) return;
    if (Math.hypot(this.localState.x - c.x, this.localState.z - c.z) <= p.radius) {
      this._changeHealth(-p.damage);
    }
    // 其他玩家：伤害交给服务器转发（服务端会再钳制一次）
    for (const [id, rp] of this.playerManager.players) {
      if (id === this.localState.id) continue;
      const st = rp.state;
      if (Math.hypot(st.x - c.x, st.z - c.z) <= p.radius) this.network.sendHit(id, p.damage);
    }
  }

  // 物品效果存储键：与背包一样按账号隔离
  _itemEffectStoreKey() {
    const id = this._profile ? (this._profile.username || this._profile.nickname || '') : '';
    return 'fp_item_effect__' + (id || 'guest');
  }

  // 记住阿花给某件物品的效果（speed/jump/jetpack/size；null 视为装饰品）
  _storeItemEffect(item, effect) {
    if (!effect) return;
    try {
      const m = JSON.parse(localStorage.getItem(this._itemEffectStoreKey()) || '{}');
      m[item] = effect;
      localStorage.setItem(this._itemEffectStoreKey(), JSON.stringify(m));
    } catch (e) { /* 存储不可用：本次会话内技能槽仍能用 */ }
  }

  _loadItemEffect(item) {
    try {
      const m = JSON.parse(localStorage.getItem(this._itemEffectStoreKey()) || '{}');
      return m[item] || null;
    } catch (e) { return null; }
  }

  // 根据阿花写的效果对象 {k,v,s}（或旧的字符串兼容）生成 { label, run }。力度 v、时长 s 都由阿花定。
  _effectForItem(item) {
    const phys = this.localPlayer.physics;
    const raw = this._loadItemEffect(item);
    const eff = raw && typeof raw === 'object' ? raw : { k: String(raw || '') };
    const k = eff.k || '';
    const v = Number.isFinite(Number(eff.v)) ? Number(eff.v) : null;
    const secs = Number.isFinite(Number(eff.s)) && Number(eff.s) > 0 ? Number(eff.s) : 5;
    switch (k) {
      case 'speed': {
        const m = (v && v > 0) ? v : 1.8;
        return {
          label: '疾风',
          run: () => {
            phys.speedMult = m;
            this._toast('疾风：速度提升至 ' + m + ' 倍，持续 ' + secs + ' 秒');
            setTimeout(() => { if (phys.speedMult === m) phys.speedMult = 1; }, secs * 1000);
          },
        };
      }
      case 'jump': {
        const m = (v && v > 0) ? v : 1.6;
        return {
          label: '跃升',
          run: () => {
            phys.jumpMult = m;
            this._toast('跃升：起跳力度提升至 ' + m + ' 倍，持续 ' + secs + ' 秒');
            setTimeout(() => { if (phys.jumpMult === m) phys.jumpMult = 1; }, secs * 1000);
          },
        };
      }
      case 'jetpack':
        return {
          label: '喷气',
          run: () => {
            phys.jetpack = true;
            this._toast('喷气背包：空中按住空格上升，持续 ' + secs + ' 秒');
            setTimeout(() => { phys.jetpack = false; }, secs * 1000);
          },
        };
      case 'size': {
        const s = (v && v > 0) ? v : 1.6;
        return {
          label: '体型',
          run: () => {
            phys.sizeTarget = s; // 平滑过渡到目标体型
            this._toast('体型变化：变为 ' + s + ' 倍，持续 ' + secs + ' 秒');
            setTimeout(() => { if (phys.sizeTarget === s) phys.sizeTarget = 1; }, secs * 1000);
          },
        };
      }
      case 'throw': {
        // 投掷物：v = 伤害，r = 爆炸半径（都由阿花指定，后端已钳制）
        const dmg = (v && v > 0) ? v : 40;
        const rad = Number.isFinite(Number(eff.r)) && Number(eff.r) > 0 ? Number(eff.r) : 3;
        return {
          label: '投掷',
          run: () => {
            this._throwProjectile({ damage: dmg, radius: rad, color: 0xff6a3c });
            this._toast('投掷：' + rad + ' 米内造成 ' + dmg + ' 点伤害');
          },
        };
      }
      default:
        // 兜底：没拿到有效效果（旧背包物品 / 后端未放行）时给个温和加速，
        // 但标签与提示都写明「未识别」，避免把兜底误当成物品本身的真实效果。
        return {
          label: '未识别',
          run: () => {
            const m = 1.8;
            phys.speedMult = m;
            this._toast('「' + item + '」没有有效效果（旧物品或后端未放行），暂按加速兜底');
            setTimeout(() => { if (phys.speedMult === m) phys.speedMult = 1; }, 4000);
          },
        };
    }
  }

  // 把阿花写的效果对象翻译成中文短语，用于提示/排查（后端会把非法效果整块删掉 → null）
  _describeEffect(e) {
    if (e == null) return '无（装饰品 / 或后端未放行该效果）';
    if (typeof e !== 'object') return '格式错误（' + String(e) + '，应为对象）';
    const k = e.k || '';
    if (k === 'throw') return '投掷 伤害' + (e.v == null ? '?' : e.v) + ' 半径' + (e.r == null ? '?' : e.r);
    if (k === 'jetpack') return '飞行 ' + (e.s == null ? '?' : e.s) + ' 秒';
    const names = { speed: '加速', jump: '跳高', size: '体型' };
    if (names[k]) return names[k] + ' ×' + (e.v == null ? '?' : e.v) + ' 持续 ' + (e.s == null ? '?' : e.s) + ' 秒';
    return '未知类型(' + k + ')';
  }

  // 把阿花给的物品挂到技能槽：用阿花选定的效果。触发方式：点击槽位（手机）或按对应数字键（PC）。
  _equipItemSkill(item) {
    // 已装备则刷新该槽；否则找第一个空槽
    let idx = Object.keys(this._skillMap).find((k) => this._skillMap[k] === item);
    if (idx == null) {
      for (let i = 0; i < SLOT_COUNT; i++) { if (!(i in this._skillMap)) { idx = String(i); break; } }
    }
    if (idx == null) {
      this._toast('技能槽已满，请在背包里把「' + item + '」指定到某个槽位');
      return;
    }
    this._setSlot(Number(idx), item);
    this._toast('「' + item + '」已装备到 ' + (Number(idx) + 1) + ' 号技能槽（按 ' + (Number(idx) + 1) + ' 触发）');
  }

  // 把物品装备到指定槽位（0 起），并持久化
  _setSlot(index, item) {
    const eff = this._effectForItem(item);
    this.skillSlots.assign(index, { label: eff.label, onActivate: eff.run });
    this._skillMap[index] = item;
    this._saveSkillSlots(this._skillMap);
  }

  // 清空指定槽位
  _clearSlot(index) {
    this.skillSlots.clearSlot(index);
    delete this._skillMap[index];
    this._saveSkillSlots(this._skillMap);
  }

  // 启动时把上次保存的槽位指定恢复出来
  _restoreSkills() {
    for (const key of Object.keys(this._skillMap)) {
      const idx = Number(key);
      const item = this._skillMap[key];
      if (idx >= 0 && idx < SLOT_COUNT && item) {
        const eff = this._effectForItem(item);
        this.skillSlots.assign(idx, { label: eff.label, onActivate: eff.run });
      } else {
        delete this._skillMap[key];
      }
    }
  }

  // 技能槽存储键：与背包一样按账号隔离
  _skillStoreKey() {
    const id = this._profile ? (this._profile.username || this._profile.nickname || '') : '';
    return 'fp_skill_slots__' + (id || 'guest');
  }
  _loadSkillSlots() {
    try { return JSON.parse(localStorage.getItem(this._skillStoreKey()) || '{}') || {}; }
    catch (e) { return {}; }
  }
  _saveSkillSlots(map) {
    try { localStorage.setItem(this._skillStoreKey(), JSON.stringify(map)); } catch (e) { /* 忽略 */ }
  }

  // 背包「使用」：指定槽位则先装备到该槽，再触发效果（与技能槽同源）。
  _useItem(item, slotIndex) {
    if (slotIndex != null && slotIndex >= 0) this._setSlot(slotIndex, item);
    const eff = this._effectForItem(item);
    eff.run();
  }

  // 给物品挑一个图标色：按名字散列到一个固定色板，保证同名拿到同色。
  _itemColor(name) {
    const palette = ['#e74c3c', '#e67e22', '#f1c40f', '#27ae60', '#16a085', '#3498db', '#9b59b6', '#e84393', '#2c3e50'];
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return palette[h % palette.length];
  }

  // spawn_item：在玩家正前方生成一个发光可拾取道具，走过去触碰即可拾取。
  _spawnPickup(name, ttl) {
    const state = this.localState;
    const rad = 1.6;
    const px = state.x + -Math.sin(state.yaw) * rad;
    const pz = state.z + -Math.cos(state.yaw) * rad;
    const geo = new THREE.OctahedronGeometry(0.28);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffd24a, emissive: 0xffa726, emissiveIntensity: 1.4,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(px, 1.0, pz);
    mesh.castShadow = true;
    this.scene.add(mesh);

    const life = Math.max(5, Math.min(ttl || 60, 300));
    const p = { mesh, x: px, z: pz, ttl: life, buff: (Math.random() * 0.5 + 0.75) };
    this._pickups.push(p);
    mesh.userData.pickup = p;

    this._toast('阿花送了你一个：' + name + '，走过去碰到它就有小惊喜');
  }

  // 顶部消息气泡提醒（不带 emoji）
  _toast(text) {
    let el = this._toastEl;
    if (!el) {
      el = document.createElement('div');
      el.className = 'npc-toast';
      el.style.cssText =
        'position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:9800;' +
        'background:rgba(30,40,60,.88);color:#fff;padding:8px 16px;border-radius:18px;' +
        'font:14px/1.4 system-ui,"Microsoft YaHei",sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.3);pointer-events:none;' +
        'opacity:0;transition:opacity .25s;';
      document.body.appendChild(el);
      this._toastEl = el;
    }
    el.textContent = text;
    el.style.opacity = '1';
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 3200);
  }

  // 每帧推进拾取道具：旋转跳动、倒计时消失、靠近自动拾取并给个随机小 buff
  _updatePickups(dt) {
    if (!this._pickups.length) return;
    const state = this.localState;
    const phys = this.localPlayer.physics;
    const myX = state.x, myZ = state.z;

    for (let i = this._pickups.length - 1; i >= 0; i--) {
      const p = this._pickups[i];
      p.ttl -= dt;
      p.mesh.rotation.y += dt * 2.5;
      p.mesh.position.y = 1.0 + Math.abs(Math.sin(performance.now() / 350)) * 0.25;

      const d = Math.hypot(myX - p.x, myZ - p.z);
      if (d < 1.0) {
        // 拾取：随机加速一点点，算作「小惊喜」
        phys.speedMult = Math.min(phys.speedMult * (1 + p.buff * 0.15), 5);
        this._toast('你捡到了宝贝，速度 +' + Math.round(p.buff * 15) + '%');
        this.scene.remove(p.mesh);
        p.mesh.geometry.dispose();
        p.mesh.material.dispose();
        this._pickups.splice(i, 1);
      } else if (p.ttl <= 0) {
        this.scene.remove(p.mesh);
        p.mesh.geometry.dispose();
        p.mesh.material.dispose();
        this._pickups.splice(i, 1);
      }
    }
  }

  // 第三人称：本地模型跟随自身位置朝向并播放行走动画，相机位于玩家后上方看向角色
  _thirdPerson(dt) {
    const local = this.playerManager.getLocalPlayer();
    if (!local) return;

    // 本地玩家不走网络插值（物理直接写 this.localState），模型须从这里取位置/朝向，
    // 否则会一直停在出生点，切第三人称也看不到自己。
    const s = this.localState;
    const size = this.localPlayer.physics.sizeScale;
    local.model.position.set(s.x, s.y - Config.PLAYER_HEIGHT * size, s.z);
    setModelScale(local.model, size);
    setHeldText(local.model, s.hold || '');

    // 本帧实际移动速度：让骨头动画知道走得多快（「移动时疯狂旋转」已临时注释）
    const dx = s.x - this._tpPrevX;
    const dz = s.z - this._tpPrevZ;
    const speed = dt > 0 ? Math.hypot(dx, dz) / dt : 0;
    this._tpPrevX = s.x;
    this._tpPrevZ = s.z;

    local.model.rotation.set(0, s.yaw, 0);

    const rig = local.model.userData.rig;
    if (rig) {
      this._tpTime += dt;
      rig.update(this._tpTime, speed);
    }

    // 相机：眼睛后上方、朝向玩家头部附近（经典第三人称跟随）
    // 俯仰（pitch）必须参与：否则鼠标上下拖动在第三人称下毫无反应。
    // 做法：把 pitch 合进「视线方向」，相机沿视线反方向后退，再按视线方向瞄准。
    const eye = new THREE.Vector3(this.localState.x, this.localState.y, this.localState.z);
    const yaw = this.localState.yaw;
    const cosP = Math.cos(this.localState.pitch);
    const sinP = Math.sin(this.localState.pitch);
    // 含俯仰的视线单位方向（与第一人称一致：yaw 水平转向 + pitch 俯仰）
    const viewDir = new THREE.Vector3(-Math.sin(yaw) * cosP, sinP, -Math.cos(yaw) * cosP);
    const DIST = 4.0;
    const LIFT = 1.0; // 相机相对眼睛再抬高一点，形成略微俯视的肩后视角
    const camPos = eye.clone().addScaledVector(viewDir, -DIST).add(new THREE.Vector3(0, LIFT, 0));
    if (camPos.y < 0.4) camPos.y = 0.4; // 抬头时相机可能钻到地面以下，夹住下限
    this.camera.position.copy(camPos);
    // 直接用与第一人称相同的欧拉角（pitch, yaw）来定朝向，俯仰一定跟着鼠标走，
    // 不依赖 lookAt 的推算，避免「第三人称锁俯仰」。
    this.camera.rotation.set(this.localState.pitch, this.localState.yaw, 0);
  }

  // 主循环：计算 dt -> 更新玩家 -> 渲染
  _loop() {
    this._raf = requestAnimationFrame(() => this._loop());

    // 计算本帧时间间隔；clamp 到 MAX_DELTA_TIME，防止切后台恢复时瞬间跳帧导致角色瞬移
    const dt = Math.min(this.clock.getDelta(), Config.MAX_DELTA_TIME);

    // 更新玩家逻辑（本地玩家 + 远程玩家插值）
    this.localPlayer.update(dt);
    this.playerManager.update(dt);

    // AI 商人 NPC：靠近提示 + 可拾取道具的推进
    this.aiNpc.update(dt, this.localState.x, this.localState.z);
    this._updatePickups(dt);

    // 投掷物：推进飞行、命中/落地后结算范围伤害
    this._updateProjectiles(dt);

    // 调试骨骼可视化：驱动待机姿态并绘制骨架/坐标轴
    if (this.debugRig) this.debugRig.update(this.clock.elapsedTime);

    // 第三人称：第一人称时保证本地隐藏；第三人称时显示自己并让相机跟随
    if (this.thirdPerson) {
      this.playerManager.setLocalVisible(true);
      this.localPlayer.bobEnabled = false; // 第三人称不做头部晃动
      this._thirdPerson(dt);
    } else {
      this.playerManager.setLocalVisible(false);
      this.localPlayer.bobEnabled = true; // 第一人称开启走路晃动
    }

    // ---- 5.2 阴影跟随玩家：把阴影焦点按「像素世界尺寸」取整到网格再贴，阳光随相对偏移平移，光向不变 ----
    // 直接每帧亚像素级移动焦点会让阴影贴图来回平移，投影出现「泳动/抖动」；
    // 取整到整 texel 让贴图每次只整体移一格，画面稳定不抖。
    const st = this._sunTarget;
    const sc = this._sun.shadow.camera;
    const R = (sc.right - sc.left) / 2;
    const texel = (R * 2) / this._sun.shadow.mapSize.x; // 单个阴影 texel 对应的世界尺寸
    st.position.set(
      Math.round(this.localState.x / texel) * texel,
      0,
      Math.round(this.localState.z / texel) * texel
    );
    this._sun.position.copy(st.position).add(this._sunOffset);
    st.updateMatrixWorld();

    // 上报本地状态（内部按 20Hz 节流）；带上当前体型倍率，供其他玩家看到放大/缩小
    this.localState.size = this.localPlayer.physics.sizeScale;
    this.network.sendState(this.localState.toJSON());

    // 渲染当前帧
    this.renderer.render(this.scene, this.camera);
  }
}