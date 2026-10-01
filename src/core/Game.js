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
import { getBagKey, addToBag } from '../player/Inventory.js';
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

    // ---- AI 商人 NPC：出生点旁喷泉处的阿花，靠近按 F 或点右侧选项卡打开对话栏 ----
    this.aiChat = createNpcChat();
    this.aiChat.setOnSend((text) => this._npcSend(text));
    this.aiChat.setOnOpen(() => { this._setChatLock(true); });
    this.aiChat.setOnClose(() => { this._setChatLock(false); });
    this.aiNpc = createAiNpc();
    this.aiNpc.setInteract(() => this._openChat());
    this.scene.add(this.aiNpc.group);
    // 屏幕中心右侧的「与阿花对话」选项卡：点击开/关对话栏
    this._createChatTab();
    // 本地可拾取的「生成物品」发光道具
    this._pickups = [];
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

  // 屏幕中心右侧的「与阿花对话」选项卡：点击开/关底部对话栏
  _createChatTab() {
    const el = document.createElement('div');
    el.textContent = '与阿花对话';
    el.style.cssText =
      'position:fixed;right:16px;top:50%;transform:translateY(-50%);z-index:9500;cursor:pointer;' +
      'background:linear-gradient(150deg,#3b7ddd,#1e55a8);color:#fff;padding:12px 14px;border-radius:14px;' +
      'box-shadow:0 6px 20px rgba(0,0,0,.3);user-select:none;' +
      'font:13px/1.4 system-ui,"Microsoft YaHei",sans-serif;text-align:center;';
    el.addEventListener('click', () => { this.aiChat.toggle(); });
    document.body.appendChild(el);
    this._chatTab = el;
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

  // 执行 GLM 点名的工具动作。所有参数已经过后端清洗，这里只做贴上玩家。
  // 阿花是物品商人：只允许 spawn_item（物品进背包），其余效果/移动动作一概忽略，不再改变玩家属性。
  _executeNpcAction(action) {
    if (!action || action.name !== 'spawn_item') return;
    const state = this.localState;
    const phys = this.localPlayer.physics;
    switch (action.name) {
      case 'set_player_speed': {
        phys.speedMult = action.args.multiplier;
        this._toast('速度已变为 ' + action.args.multiplier + ' 倍');
        if (action.args.seconds && action.args.seconds > 0) {
          const t = action.args.seconds;
          setTimeout(() => { if (phys.speedMult === action.args.multiplier) phys.speedMult = 1; }, t * 1000);
        }
        break;
      }
      case 'set_player_size': {
        phys.sizeScale = action.args.scale;
        this._toast('体型已变为 ' + action.args.scale + ' 倍');
        if (action.args.seconds && action.args.seconds > 0) {
          const t = action.args.seconds;
          setTimeout(() => { if (phys.sizeScale === action.args.scale) phys.sizeScale = 1; }, t * 1000);
        }
        break;
      }
      case 'teleport_player':
      case 'set_player_position': {
        const x = action.args.x;
        const z = action.args.z;
        if (Number.isFinite(x)) state.x = THREE.MathUtils.clamp(x, -Config.GROUND_WIDTH / 2, Config.GROUND_WIDTH / 2);
        if (Number.isFinite(z)) state.z = THREE.MathUtils.clamp(z, -Config.GROUND_DEPTH / 2, Config.GROUND_DEPTH / 2);
        if (Number.isFinite(action.args.y)) state.y = action.args.y;
        else state.y = Config.PLAYER_HEIGHT * phys.sizeScale;
        this._toast('已移动');
        break;
      }
      case 'set_player_jump': {
        phys.jumpMult = action.args.multiplier;
        this._toast('起跳力度已变为 ' + action.args.multiplier + ' 倍');
        if (action.args.seconds && action.args.seconds > 0) {
          const t = action.args.seconds;
          setTimeout(() => { if (phys.jumpMult === action.args.multiplier) phys.jumpMult = 1; }, t * 1000);
        }
        break;
      }
      case 'set_player_gravity': {
        phys.gravityMult = action.args.multiplier;
        this._toast('重力已变为 ' + action.args.multiplier + ' 倍');
        if (action.args.seconds && action.args.seconds > 0) {
          const t = action.args.seconds;
          setTimeout(() => { if (phys.gravityMult === action.args.multiplier) phys.gravityMult = 1; }, t * 1000);
        }
        break;
      }
      case 'set_player_velocity': {
        const a = action.args;
        if (Number.isFinite(a.x)) phys.velocity.x = a.x * phys.speedMult * 5;
        if (Number.isFinite(a.y)) phys.velocity.y = a.y;
        if (Number.isFinite(a.z)) phys.velocity.z = a.z * phys.speedMult * 5;
        this._toast('已施加移动速度');
        break;
      }
      case 'grant_jetpack': {
        phys.jetpack = !!action.args.on;
        this._toast(phys.jetpack ? '喷气背包已开启，空中按住空格上升' : '喷气背包已关闭');
        if (action.args.seconds && action.args.seconds > 0) {
          const t = action.args.seconds;
          setTimeout(() => { phys.jetpack = false; }, t * 1000);
        }
        break;
      }
      case 'spawn_item': {
        // 阿花把物品放进玩家背包（不是丢到地上给效果）
        const item = action.args.item || '神秘物品';
        const key = getBagKey(this._profile);
        const n = addToBag(key, item, 1);
        this._toast('阿花把「' + item + '」放进你的背包（累计 ' + n + ' 件）');
        break;
      }
      default:
        break;
    }
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
    local.model.position.set(s.x, s.y - Config.PLAYER_HEIGHT, s.z);

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

    // 上报本地状态（内部按 20Hz 节流）
    this.network.sendState(this.localState.toJSON());

    // 渲染当前帧
    this.renderer.render(this.scene, this.camera);
  }
}