# first-person-mover 全链路性能审计报告

- **审计日期**：2026-10-05
- **审计对象**：`E:/玩法/first-person-mover`（Vite + 原生 ESM + Three.js 0.170，无框架）
- **触发问题描述**：「现状：十分卡顿，分辨率已经最低了，请你进行全面分析并给出执行方案」
- **本轮性质**：**只诊断，不改源码**。唯一写入的文件是本报告。
- **审计方法**：全量静态代码走查 + 线上权威场景数据拉取 + Node 离线场景普查（复用项目自身的 `mergeStaticMeshes` 真实执行）。**未启动 dev server / 浏览器**（避免软渲染吃满用户 CPU）。

---

## 0. 审计方法与数据来源

| 数据 | 来源 | 说明 |
|---|---|---|
| 线上实际场景 | `GET https://game666.lshserver.dpdns.org/api/scene`（200，23706 B） | **这才是用户看到的场景**，不是仓库里打包的 `editorMapData.js`（那份只有 4 个摆放物，已过期） |
| 场景规模普查 | `_perftmp/census.mjs`（本项目 `Merge.js` 真实执行，非估算） | 逐个 GLB 走完 `mergeStaticMeshes` 后 × 摆放次数求和 |
| 三角面统计 | `_perftmp/glbstat.cjs`（自写 GLB chunk 解析） | 直读 GLB JSON chunk 的 accessors，不依赖 three |
| 渲染/阴影/昼夜/碰撞/网络/UI 管线 | 逐文件精读（见附录 B 行号索引） | 全部结论带 `文件:行号` |

> 说明：`_perftmp/` 下的脚本是审计临时产物，不属于源码，可随时删除。

---

## 1. 结论摘要：卡顿的前 5 个根因（按影响排序）

### 核心判断

**用户把 renderScale 拉到最低仍然卡 —— 这件事本身就是最强的诊断信号。** 它证明瓶颈不在「主色彩 pass 的像素填充率」，而落在**一堆完全不受 renderScale 影响的固定开销**上。本项目恰好有两项这样的开销，且量级巨大。

---

### 根因 1（最高）｜点光源立方阴影的有效半径被拉到 100 米，等于「整场景每 2 帧投影 24 次」

**这是本次审计最硬的发现，也是直接解释"降分辨率无效"的那一项。**

证据链：

1. 线上场景里 6 盏点光源**全部 `distance: 100`**（`_tmp_remote_scene.json`，id 130/133/134/135/136/137）：
   ```json
   { "id": 130, "type": "point", "x": -93.37, "y": 14.48, "z": 10.70, "intensity": 40, "distance": 100, "decay": 1 }
   ```
2. `src/world/EditorBuildings.js:517-522` 把这个 `distance` 原样喂给 `THREE.PointLight`：
   ```js
   const light = new THREE.PointLight(
     color,
     intensity * LIGHT_SCALE,
     finiteOr(it.distance, LIGHT_DEFAULTS.distance),   // ← 线上 = 100
     finiteOr(it.decay, LIGHT_DEFAULTS.decay)
   );
   ```
3. `src/world/Lights.js:100-105` 的 30 米兜底**只对没有 distance 的灯生效**：
   ```js
   if (!light.isSpotLight && !light.distance) { sh.camera.far = 30; sh.camera.updateProjectionMatrix(); }
   ```
   线上灯有 `distance=100` → **这行不执行** → three.js `PointLightShadow.updateMatrices()` 取 `light.distance` 当 `camera.far` → **每面 far = 100 米**。
4. `src/world/Lights.js:20` `MAX_POINT_SHADOW = 4` → `src/world/Lights.js:273` 恒定挑出 4 盏令其 `castShadow = true`。
5. `src/core/Game.js:6962-6963` 每 2 帧置一次 `shadowMap.needsUpdate` → 约 **30 Hz** 重建全部阴影贴图。

**后果**：点光源阴影是 **cube shadow（6 面）**。地图尺寸 `boundary = X[-115,117] / Z[-155,175]`（232 × 330 米），而单个 100 米半径的阴影球几乎覆盖全图内容。于是一个阴影帧里：

| 光源 | 数量 | 每盏→投影趟数 | 小计 |
|---|---|---|---|
| PointLight（含影） | 4 | 6 面 | **24** |
| SpotLight 代理（面光源） | 2 | 1 | 2 |
| DirectionalLight（太阳） | 1 | 1 | 1 |
| **合计 shadow 投影趟数 / 阴影帧** |  |  | **27** |
| 主渲染 pass | 1 | 1 | **1** |

场景普查出来的可见网格只有 **65 个**（见 §2），所以每个阴影帧要为点光源阴影提交 **约 24 × 50~65 ≈ 1200~1500 次 draw call**，每 2 帧重复一次 ≈ **每秒 3.6 万~4.5 万次 draw call 纯粹为了阴影**。

**为什么降分辨率救不了**：`Lights.js:22` `SHADOW_MAP = 512` 写死，`Game.js:1211` 太阳阴影 `shadowSize` 由画质档钉死，**都跟 renderScale 一点关系没有**。用户把主 pass 压到 0.4× 之后，剩下没被压掉的就是这块 —— 它就是新的地板。

---

### 根因 2（次高）｜每个受光片元同时采样 7 张阴影贴图（含 4 张 cube），PCFSoft

- 同一个起因：`Game.js:169-170` `shadowMap.enabled = true` + `type = THREE.PCFSoftShadowMap`（高品质档）；`Lights.js:20-21` 允许 4+2 盏带影，再加太阳 → **单个材质里同时挂着 7 个 shadow sampler**。
- `MeshStandardMaterial` 的片元着色器对每个受光片元要遍历 6 个点光源 + 2 个聚光 + 1 个平行光，其中 7 个要做阴影采样（cube shadow 还需透视除法寻址）。这是所有不透明几何上的**每像素成本**。
- 这一项的**绝对值会随 renderScale 下降而下降**，但因为根因 1 的存在，降到某个点就遇到地板了 —— 所以它是「慢」的放大器，不是「降不下去」的原因。

---

### 根因 3｜用户以为降了分辨率，其实还有一整套原生分辨率的固定开销没被降掉

走**超分路径**时（`Game.js:820-938`）：

| 位置 | 事实 | 是否被 renderScale 降低 |
|---|---|---|
| `Game.js:822` `setPixelRatio(base * (up ? 1 : this._dynScale))` | 走超分时**画布 drawingBuffer 保持原生** | ❌ 不降 |
| `Game.js:938` + `Game.js:850-871` | 全屏 5 抽样 unsharp-mask 合成 pass，**跑在原生画布分辨率** | ❌ 不降 |
| `Game.js:896-905` RT = `HalfFloatType` + `samples: this._aaOn ? 4 : 0` | MSAA 解析带宽随 samples 线性增长（tile-based 移动 GPU 尤其贵） | 部分（RT 变小），但 **samples 不会自动跟着降** |
| `Game.js:6962-63` 全部阴影 | 见根因 1 | ❌ 完全不降 |

讽刺点：**`_useUpscale()`（`Game.js:834-836`）的成立条件是 `_dynScale < 0.98` —— 也就是说用户"把分辨率拉到最低"这个动作，会把自己送进这条多一层原生全屏合成的路径。** 他的杠杆能砍掉的部分，比他以为的少。

---

### 根因 4｜主循环每帧串行的 CPU 面宽：25+ 个 update + 天空球壳 / 昼夜写灯

`Game.js:6827-6892`，每帧无条件（或近无条件）调用：

```
_updateDayNight · _updateCtrl · localPlayer.update · playerManager.update · _buildTool.update
· tickPlayerModels · _updateVehicle · _updateRace · aiNpc.update · _updatePickups
· _updateMerchant · _updateBoss · _updateMissiles · _updateMeteorMode · _updateClub
· _updateHoles · _updateGatling · _updateMorphs · _updateHideReport · _updateProjectiles
· _updateDrops · _updatePickupHint · _updateBeacons · _updateAimUI · _updateGrapple
· _updateRemoteGrapples · _spinRemoteGuns · _updateCoinMode · _updateFX
```

其中确认每帧真实干活的几笔：

| 位置 | 每帧动作 | 风险 |
|---|---|---|
| `SkyBox.js:406-423` | 遍历 4 个时段球壳，每个都写 `material.opacity` / `renderOrder` / `visible`，可见的再写 `scale.setScalar(camera.far * 0.92)`（=460）与 `position.copy(camera.position)` | 1~2 个球壳可见 = **1~2 个全屏半透明叠加**（过渡期 2 个），且 `renderOrder` 每帧写会触发透明队列重排 |
| `Game.js:1176-1191` | 每帧循环 9 盏编辑器灯；面光源走 `setAreaBaseIntensity` → `Lights.js:158-174 syncAreaShadow` → 每盏每帧重算亮度拆分 + `updateProjectionMatrix()` | 3 盏面光源 × 每帧 |
| `Game.js:916` | `updateShadowBudgets` 每帧执行（`Lights.js:241-257` 里全量拉 `getWorldPosition` + 排序） | 9 盏灯，成本低但每帧做 |
| `PlayerPhysics.js:69-79` | 每帧 new 3 个 `THREE.Vector3` | GC 压力源 |
| `PlayerPhysics.js:147-154` | 每帧清空并重建 trimesh / simple 分桶 | 29 个碰撞体，成本低但每帧做 |

---

### 根因 5｜物理：6 个 trimesh（约 8.7 万面）+ `characterSolver` 的组合复杂度

- `characterSolver.js` 的 `resolvePenetration`：`Config.TRIMESH_CONTACT_ITERATIONS = 6` 次迭代 × trimeshes × 候选三角 × **13 根 SAT 轴**。
- `resolveMove` 子步数 `n = ceil(dist / 0.15)`，上限 96；每子步撞到台阶还会**重试一次**（工作量翻倍）。高速状态（载具 16 m/s、抓钩 25 m/s）下 `n` 明显上升。
- 6 个 trimesh 的三角面实测：`111.glb 32,842` / `___.glb 50,724` / `school-hall 3,452` / `floor 36`（floor 摆了 **3 份且 scale.y 各不相同** → bakeKey 不同 → **烘焙 3 次**）。

> ⚠ 这一项静态估算无法定论，标注为 **待测量**。它依赖"玩家的 AABB 在每个 broadphase cell（2 米）里实际命中多少候选三角"。盲目优化这里很容易做无用功，务必先按 §3 实测。

---

### 📌 一个重要的**负面结论**（避免团队做无用功）

**draw call 数量本身不是瓶颈。** 走完项目自己的 `mergeStaticMeshes` 后，整个线上场景只有：

```
场景图节点 208    网格 65    三角形 133,228
```

65 个网格在现代 GPU 上属于极轻量。→ **因此 `ENABLE_BATCH_MERGE`（`EditorBuildings.js:373`，当前关闭）在这个场景里几乎不可能带来收益，而它是全项目唯一"移动 mesh"的改动，风险最高。** 详见 §5。

---

## 2. 现状盘点表

| 环节 | 现状（证据） | 成本估算 | 是否受 renderScale 影响 | 风险等级 | 结论标签 |
|---|---|---|---|---|---|
| **点光源立方阴影** | 4 盏 × 6 面，`far = distance = 100m`（`Lights.js:20/103`、`EditorBuildings.js:520`） | 约 1200~1500 draw call / 阴影帧 | ❌ 完全不受 | 🔴 高 | **已确认 · 主因** |
| **阴影总趟数** | 27 投影趟 / 阴影帧（约 30Hz，`Game.js:6962-63`） | 主 pass 的 27 倍 | ❌ 几乎不受 | 🔴 高 | **已确认 · 主因** |
| **分片元 7 路阴影采样** | 4 cube + 2 spot + 1 dir，PCFSoft（`Game.js:170`） | 每受光片元 7 次 SM 采样 | ✅ 受影响 | 🟠 中高 | 已确认 |
| **超分合成 + HalfFloat/MSAA RT** | `Game.js:822/896-905/938` | 1 趟原生全屏 + MSAA resolve | ❌ 合成不受 | 🟠 中 | 已确认 |
| **主渲染 draw call** | **65 网格 / 133,228 三角**（census 实测） | 极轻 | ✅ 受影响 | 🟢 低 | **已确认 · 非瓶颈** |
| **几何合并收益空间** | mergeStaticMeshes 已在加载期生效（`AssetLoader.js`、`EditorBuildings.js:setupModel`） | 已消化 | — | 🟢 低 | **无风险 · 不建议再加** |
| **PMREM 环境贴图** | 加载期生成一次/时段，`update()` 只换引用（`SkyBox.js:340-370`，含 355 行"不再逐档重建"注释） | 0（帧内） | — | 🟢 低 | **无风险** |
| **历史坑：帧内重建资源** | 未发现帧循环内 Build PMREM / Shader / 合并 | 0 | — | 🟢 低 | **无风险** |
| **历史坑：阴影灯数量抖动** | `rebalance` 恒定保持 `min(max, len)` 盏castShadow（`Lights.js:252-256`）；线上候选数 6 ≥ 4、3 ≥ 2 → **恒定** | 0 | — | 🟢 低 | **无风险（铁律成立）** |
| **天空球壳** | 4 个永久球壳，每帧写 opacity/renderOrder/scale/position；可见 1~2 个 = 全屏半透明（`SkyBox.js:406-423`） | 1~2 全屏 blend | ✅ 受影响 | 🟡 中 | 待测量（数量级小） |
| **昼夜写灯** | 每帧 9 盏，面光源每帧 `syncAreaShadow` + `updateProjectionMatrix`（`Game.js:1176-1191`、`Lights.js:158-174`） | CPU 微量 | ❌ 不受 | 🟡 中 | 待测量 |
| **`_loop` 串行面宽** | 25+ 个 update（`Game.js:6827-6892`） | CPU | ❌ 不受 | 🟡 中 | 待测量 |
| **物理 · trimesh** | 6 trimesh / ~87k 面；6 迭代 × 13 轴 × 子步（`characterSolver.js`） | — | ❌ 不受 | 🟠 中高 | **待测量** |
| **物理 · simple** | 23 个（含 `zhaji.glb` 的 16 个 convexParts） | O(n) 每帧 | ❌ 不受 | 🟡 中 | 待测量 |
| **每帧对象分配 / GC** | `PlayerPhysics.js:69-79` 3×Vector3/帧；`SnapshotBuffer.js:34/103` 每快照 clone + 每帧外推 `{...d}` | 小~中 | ❌ 不受 | 🟡 中 | 待测量 |
| **网络 · 上行** | 20Hz `setInterval` + 变化阈值（位移>2cm/朝向>1°），静止降 5Hz（`Network.js:295/301-341/352`） | 极小 | — | 🟢 低 | **无风险** |
| **网络 · 下行插值** | 20Hz 快照；每玩家每帧线性扫 ≤48 条（`SnapshotBuffer.sample`）；`suggestDelayMs` 每秒才 sort 一次（`:46-56`） | 极小 | ❌ 不受 | 🟢 低 | **无风险** |
| **UI DOM 每帧写** | `_updateAimUI`（`1927/1934`）与 `_updatePickupHint`（`2034/2038`）已做「**只在状态翻转时写**」✅ | ~0 | — | 🟢 低 | **无风险** |
| **UI 强制重排** | `Game.js:2202 void el.offsetWidth`（刻意的一次 animations reflow）；其余 `getBoundingClientRect` 都在交互/Resize 路径（`layout.js`、`MobileControls.js`、`MobileLayout.js`、`SkillSlots.js`） | 非每帧 | — | 🟢 低 | **无风险** |
| **性能 HUD 自身** | 每 0.25s 刷新，且读的是缓存好的 `c.triCount / c.meshCount`（`Game.js:964/976-982`），不遍历三角 | ~0 | — | 🟢 低 | **无风险** |
| **LOD** | 300ms 节流；`ENABLE_LOD_HIDE = false`，只做「远处不投影」（`Lod.js:17/25/71/77`） | 小 | — | 🟡 中 | 已确认（远剔除基本无效，见注） |
| **编辑器建筑合批** | `ENABLE_BATCH_MERGE = false`（`EditorBuildings.js:373`） | — | — | 🔴 高（若误开） | **已确认 · 不建议开** |

> **LOD 注**：`Lod.js:51-52` 的判定是 `shadowDist = 90 + min(r*2,160)`、`hideDist = 240 + min(r*3,360)`。地图对角线约 400 米，绝大多数摆放物算上半径放宽后仍在 hideDist 内 → **即使打开 `ENABLE_LOD_HIDE`，在这张图上几乎剔不掉东西**，收益接近 0，风险却不小。

---

## 3. 测量方案（最小侵入埋点 + 判定阈值）

> **强烈建议：先跑完这一节再动手改。** 现有代码已经很方便——`main.js:92` 暴露了 `window.__game`，且 `Game.js:74` 的 `perfEnabled()` 支持 **`URL 带 `perf` 字样（含 hash）就打开性能 HUD`**。所以 **第一步完全不用改代码**：给用户一个带 `?perf` 的链接即可。

### 3.0 零改动基线（今天就能做）

让用户打开游戏时地址带 **`?perf`**（例：`https://……/?perf`），HUD 会显示（`Game.js:983-998`）：

```
FPS xxx   CPU xx.x ms
物理 x.xx ms   渲染 x.xx ms   其他 x.xx ms
碰撞体 盒xx 凸包xx trimeshxx   三角形 x,xxx
绘制 xxxx 次   三角面 xxx,xxx
缓冲 1920×1080   内部 0.60×  超分锐化0.5
GPU XXX
```

**关键校正**：`Game.js:990` 的「绘制 xxxx 次」是 `renderer.info.render.calls`，**它已经包含阴影 pass 的 draw call**（`WebGLRenderer.render()` 内部的 `info.reset()` 发生在 `shadowMap.render()` 之前）。所以它是「主 pass + 27 趟阴影」的总和 —— 这正是我们要的那把尺子。

### 3.1 四个一次性对比实验（每条都可在控制台临改，或临时改一行再改回）

| 实验 | 临时改动位置 | 观察量 | 判定阈值 |
|---|---|---|---|
| **E1 关阴影** | `Game.js:169` `shadowMap.enabled = true` → `false`（或在控制台 `__game.renderer.shadowMap.enabled=false`） | HUD「绘制」次数、FPS | **绘制次数跌 ≥60% 且 FPS 明显回升** → 根因 1/2 成立，**直接执行 P0-1**；否则转向 E3 |
| **E2 点光源阴影归零** | `Lights.js:20` `MAX_POINT_SHADOW = 4` → `0`（保持 area/sun 不变，**注意：常量恒定的规则仍然成立，只是预算变0**） | 同 E1 | 若 E1 大跌而 E2 跌幅占其中 ≥70% → **代价就是那 4 盏点光源**，锁定 P0-1 的具体数值 |
| **E3 关超分/合成** | `Game.js:166` `this._sharpen = 0.5` → `0`（走直渲分支，`Game.js:921-926`） | 同上 | FPS 在最低 renderScale 下仍回升 → 根因 3 成立 → P0-2 |
| **E4 物理隔离** | 控制台 `__game.colliders.length = 0`（或在 `localPlayer.update` 前临时传空数组） | HUD「物理 ms」 | **物理 ms > 4.0 ms** → 物理是主因之一 → 先做 P2-1/P2-2；< 1.5 ms → 物理清白 |

### 3.2 建议补的常驻探针（P0-0，全部挂在已有的 `this._perf` 之后，关掉时零开销）

`Game.js` 的 `_pt0/_pt1/_pt2/_pt3` 只切了「前 / 物理 / 渲染 / 尾」四段，**缺三个最关键的缝**，建议补：

| 探针 | 埋点位置 | 目的 |
|---|---|---|
| **A. 阴影分段** | `Game.js:6934-6944` 之后、`_renderFrame()` 内 `this.renderer.render(this.scene, this.camera)` 前后各取一次 `renderer.info.render.calls`，差值即**主 pass draw call**；与总数之差即**阴影趟数的贡献** | 把「主 vs 阴影」彻底拆开，是 P0-1 的验收指标 |
| **B. 合成分段** | `Game.js:938` `this.renderer.render(this._upScene, this._upCam)` 前后计时 | 量化那趟原生全屏合成，是 P0-2 的验收指标 |
| **C. programs 计数** | `this.renderer.info.programs.length` 每 0.25s 记一次，HUD 显示**增量** | 铁律哨兵：若 programs 无端增长 → 说明有地方让「阴影灯数量」抖动了 → 立刻停手排查（见 §5-4） |
| **D. 帧内卡顿尖峰** | `_loop` 首尾记录最大 `dt`，每 0.25s 输出 `maxFrame` | 区分「持续低帧」与「周期性尖峰」（后者通常=编译/分配，不是负载） |

**门槛共识（建议团队采纳）：**

```
渲染 ms > 8ms  且 主pass draw call < 150      → 瓶颈在阴影 / 片元着色，不是几何
总 draw call > 1500（每阴影帧）               → P0-1 必须做
主 pass draw call < 200                       → 禁止引入任何合批/合并改动（§5-1）
物理 ms > 4ms                                 → 物理先于合批
其他 ms > 6ms                                 → 查 _loop 串行面宽（§4-P1-2）
programs 每 0.25s 有增长                      → 立即回滚，铁律被破
```

### 3.3 如何复现「最卡」的场景

1. 主世界大厅（非 combat）——`Game.js:6845` 的整段城市系统（`_updateVehicle`/`_updateRace`/`aiNpc`/`_updateBoss`…）只在非战斗时跑，面宽最大。
2. 站位选在 **`x≈-78, z≈10`** 附近：线上 6 盏点光源有 5 盏集中在 `x[-93,-58] / z[-29, 11]`（id 130/133/134/135/136），站这里会同时拉近多盏 → `rebalance`（`Lights.js:251`）会不断重排各自的 4 盏名额，且都是 100 米半径。
3. 打开昼夜（`Game.js:218` 默认开），让 `Game.js:1159` 的 `SkyBox.update` 每帧跑起来。
4. 保持在 `id 137` 那盏（x2.56, z77.16）与各「TODO 并排」的城市灯之间的开阔地：视野内 Most Complex GLB（111 / ___）都在 100m 阴影球内，是阴影提交量的最大值区域。

---

## 4. 执行方案

> 优先级说明：**P0 = 高收益低风险且与已确认的主因直接对应**；P1 = 收益中等或需先有数据；P2 = 收益不确定 / 风险较高，必须先有 P0-0 的数据。

### P0

| ID | 任务 | 改哪个文件 / 怎么改 | 预期收益 | 风险与副作用 | 依赖 |
|---|---|---|---|---|---|
| **P0-0** | 补齐 §3.2 的探针 A/B/C/D | `src/core/Game.js`（`_loop` 6934-6982 段、`_renderFrame` 913-939 段、`_updatePerfHud` 959-999 段）；`src/world/Lights.js`（无改动，只被读） | 本身不提速，但**是所有其它任务的唯一决策依据** | 无：全部代码挂在 `this._perf` 之后，关掉即零开销 | 无 |
| **P0-1** ⭐ | **点光源阴影预算与范围双重收紧** | ① `src/world/Lights.js:20` `MAX_POINT_SHADOW` 由常量改为运行时可调：`setShadowBudget({point, area})`，并在 `_applyQuality`（`Game.js:1208-1229`）里联动：`high=2 / mid=1 / low=0`；<br>② `src/world/Lights.js:100-105` `configureShadow` 增加**阴影专用 far 上限**（建议 `Math.min(far, 18~25)`，与灯的照明距离解耦）——照明继续用 100m，**投影只允许近场**；<br>③ `mapSize` 随画质档 512→256（low） | **高**。阴影帧投影趟数 27 → 约 9（point 4→1）：**-67%**；再叠加 far 从 100m 收到 25m，每面命中网格数从「几乎全场景」降到「几个」→ 点光源阴影的 draw call 有望降 **一个数量级** | **低，且不碰任何铁律**：<br>· 不碰碰撞/可见性（只动 `castShadow` 与 `shadow.camera.far`）<br>· 「投影灯数量恒定」铁律：只需保证**候选数 ≥ budget**。`Lights.js:252` 的 `want = Math.min(max, list.length)` 天然保证；线上候选 6 盏、budget ≤2，**永远恒定**<br>· 视觉副作用：远处点光源不再挡光（例如 100m 外的路灯不再被建筑遮挡），需在设置项说明里写明并让用户知晓<br>· **不可**用「按 intensity 开关 castShadow」实现（见 §5-4） | P0-0（要用探针 A 验收） |
| **P0-2** | **超分路径按 renderScale 自适应降级** | `Game.js:896-905`：`samples` 改为 `_dynScale < 0.7 ? 0 : (_aaOn ? 2 : 0)`（低分辨率时本就不需要 4×MSAA）；<br>`Game.js:834-836`：`_dynScale < 0.55`（画面已极糊）时**直接放弃超分**，退回 `Game.js:921-926` 的直渲分支 | **中~高**。省掉一趟原生全屏合成 + MSAA 解析；tile-based 移动 GPU 上尤其明显 | **低**。纯视觉：低分辨率下锯齿略增、略糊（本就已经在最低分辨率，用户已接受）<br>不动碰撞烘焙链、不动天空/背景的混合方式 | 无（可与 P0-1 并行） |
| **P0-3** | **性能 HUD 增加三个字段**：主 pass draw call、programs 增量、近 0.25s 最大帧 | `Game.js:959-999`（在既有 txt 上追加 3 行） | 无直接收益，是 P1/P2 的验收工具 | 无（已 gated 于 `?perf`） | P0-0 |

### P1

| ID | 任务 | 改哪个文件 / 怎么改 | 预期收益 | 风险与副作用 | 依赖 |
|---|---|---|---|---|---|
| **P1-1** | **给 `configureShadow` 加受 doğrulama：显式 clamp `shadow.camera.far`** | `src/world/Lights.js:93-106` —— 这是 P0-1 ② 的**稳健版**，不只是调参，而是堵住"编辑器/服务端下发 `distance: 100` → 阴影球失控"这个**数据驱动型**根因。建议：`const SHADOW_FAR_MAX = 25;` 一律 `far = Math.min(far来自 light.distance, SHADOW_FAR_MAX)` | **高**（与 P0-1 重叠，但是根治手段） | 低。注意 `Lights.js:104` 里 spotlight 走的是 `farOverride` 分支，面光源代理 `AREA_SHADOW_DISTANCE=14` 不受影响（已经很小） | P0-1 之后落地（先验证收益方向正确） |
| **P1-2** | **主循环系统更新：非必要系统挂到低频节拍** | `Game.js:6845-6892`：把 `_updateRace` / `_updatePickups` / `_updateMerchant` / `_updateBeacons` / `_updateHideReport` / `_updateCoinMode` 等内部已有守卫的系统，统一走一层 `this._tickEvery(n)`；或按 `_combat` / 距离阈值早退 | **中**。直接砍掉每帧几十次「调用 + 内部早退」的固定 CPU 面宽 | **中**。部分系统（拾取提示、准星热态）对 1 帧延迟敏感；必须逐个确认其内部有"状态守卫"后再降频，否则会出现提示慢半拍 | P0-0 的「其他 ms」数据（>6ms 才值得做） |
| **P1-3** | **天空球壳去掉无效每帧写入** | `SkyBox.js:406-423`：opacity / renderOrder 只在**值变化**时写；`scale.setScalar(camera.far*0.92)` 与 `position.copy(camera.position)` 改为仅在 `camera.far` 或相机位置**变化超过阈值**时写 | **低~中**（CPU 微量 + 避免透明队列重排） | **低**。需保留 `mesh.visible = opacity > 0.001` 的现有逻辑（它已经只让 1~2 个球壳可见，这点是对的） | 无 |
| **P1-4** | **昼夜写灯降频 + 面光源 `syncAreaShadow` 去抖** | `Game.js:1170`：`_applyEditorLightDayState` 改为每 200~300ms 一次（昼夜周期 600s，肉眼无差）；<br>`Lights.js:158-174`：`syncAreaShadow` 内对 `base / area.width / area.height / color` 做脏检查，未变则跳过 `updateProjectionMatrix()` | **低**。省掉每帧 9 盏灯的循环 + 3 盏面光源的投影矩阵重算 | **低**。注意 `Game.js:1188` 写 `light.intensity` 的路径要保持（它是 off-hours 开关）；**同时顺手补一个修复**：若 `intensity` 被置 0，仍然 `castShadow` → 白付阴影代价（见下方"潜在缺陷"） | 无 |
| **P1-5** | **碰撞: `floor.glb` 摆了 3 份且 scale.y 不同 → 烘焙了 3 次** | `EditorBuildings.js` 的 `bakeKey` 生成处（配合 `trimesh.js:34-50 bakeByKey`）：对同一 url 的不同摆放，**若仅有微小缩放差异，允许复用同一份 BVH，运行时按 holder scale 缩放查询**（或干脆在编辑器侧统一 scale） | **中**（加载期 & 内存），运行期影响待测量 | **中**。改 bakeKey 会影响 `trimesh.js` 的缓存正确性与 for the `collider-vis` subtree 的处理，需要回归测试 | P2-1 的碰撞归一化一起评估 |

### P2

| ID | 任务 | 改哪个文件 / 怎么改 | 预期收益 | 风险与副作用 | 依赖 |
|---|---|---|---|---|---|
| **P2-1** | **`PlayerPhysics` 去每帧分配与分桶重建** | `PlayerPhysics.js:69-79`：3 个 `Vector3` 提到模块级临时变量（像 `Lights.js` 的 `_tmpV`、`Game.js` 的 `_gDir` 那样）；<br>`PlayerPhysics.js:147-154`：`_trimeshes/_simples` 改为**脏标记**驱动，只在 `colliders` 数组内容变化（版本号/长度）时重建 | **低~中**（降 GC 抖动，平抑卡顿尖峰） | **低**。但 `_trimeshes` 数组是持有引用的，改成缓存时必须保证 `Game.js` 异步 push  trimesh 烘焙结果（`Game.js:238` 注释里明确的"原地改写同一条数组引用"）能触发失效 | P0-0 的 maxFrame 数据（有尖峰才做） |
| **P2-2** | **`characterSolver` 参数调优** | `src/config.js`：`TRIMESH_CONTACT_ITERATIONS` 6→4；`TRIMESH_SUBSTEP_HARD_MAX` 96→32；给 `resolvePenetration` 加"候选三角数 > N 时降级 SAT 轴数（13→6）" | **中**（若 E4 判定物理是瓶颈） | **中**。会改变踩 packets / 台阶上行手感，必须手感回归 | **必须先有 E4/P0-0 的「物理 ms」数据** |
| **P2-3** | **点光源阴影改成"单面 2D 代理"**（用 SpotLight 代理点光源，摆脱 6 面 cube） | `src/world/Lights.js` 新增加 `enablePointShadowProxy()`，模仿现有 `enableAreaShadow` 的做法 | **高**（理论上再降 6×） | **高**。改变光衰减外观（点光源是全向），视觉差异明显；且要保证代理数量恒定。属于"换方案"而非"调参"，必须先证明 P0-1 不够用 | P0-1 收益不足时才做 |
| **P2-4** | **跨物件合批 / 远剔除**（含 ENEL看待禁令项） | 见 §5 | **未知（静态估算接近 0）** | **高** | 先满足 §5 的全部前置条件 |

---

### 建议实施顺序

```
P0-0（探针，~0.5 天）
  ↓ 拿到基线：绘制次数 / 物理 ms / 其他 ms / maxFrame
P0-1 + P0-2（并行，各 ~0.5~1 天）  ← 这两个覆盖了本次已确认的主因
  ↓ 用同一场景、同一站位复测，把数字贴回本报告 §3.1 表格
P0-3 / P1-1 / P1-3 / P1-4（低风险收尾，~1 天）
  ↓ 
P1-2（按「其他 ms」决定是否做）
  ↓
P2-*（全部需要实测数据背书再动）
```

---

## 5. 明确不建议做的事

### ❶ **不要直接把 `ENABLE_BATCH_MERGE` 打开**

`src/world/EditorBuildings.js:373`：
```js
const ENABLE_BATCH_MERGE = false;
```

**为什么不做**：
- 静态普查已确认：整个场景合并后只有 **65 个网格**。再压缩到 ~10 个，**从 65 降到 10 的收益，在一个"瓶颈根本不在 draw call"的场景里等于 0**（对照 §3.1 的门槛：`主 pass draw call < 200 → 禁止引入任何合批/合并改动`）。
- 收益接近 0，风险却是全项目最高的：它是**唯一会移动 mesh 的改动**。

**如果要开，必须先满足的全部前置条件**：

1. **先证明主 pass draw call 真的是瓶颈**（探针 A：`主 pass draw call > 500` 且 E1 实验显示"关阴影后 FPS 不回升"）。**当前已知数据不支持**。
2. **必须先处理 `trimesh.js:75-78` 的可见性依赖**：
   ```js
   function collectMeshes(object3D, out) {
     ...
     if (inColliderVis(o) || !isVisible(o)) return;   // ← 不可见的 mesh 不参与烘焙
   ```
   合批会把原 mesh 从场景移除、改成 world-space 的合并 mesh。这一步一旦与 trimesh 异步烘焙（`bakeTriMeshAsync`）产生时序交错，被合并掉的原 mesh 会被判定为 invisible → **碰撞体直接消失**。这正是历史上"开了合批后碰撞没了"的根因。（注释里说真凶已找到并修好，但这个开关**从未被重新打开验证过**，必须补回归测试。）
3. 合批后 `matrixAutoUpdate = false`（`EditorBuildings.js` 合批内的设置），**任何依赖节点局部矩阵的逻辑（含 `__onWindow` 的灯、convexParts、搬运家具）都要重新验证**。
4. 合批与 `setEditorSceneVisible`（`EditorBuildings.js:34-36`，进对战整组隐藏）的交互要验证。
5. 必须在 BATCH_GRID（48m）粒度下的 visibility toggling 与 collision 之间建立明确的"合批后不再单独 hid单个 mesh"的约束。

**结论：在没有 draw call 数据背书前，这一项应该被冻结。**

---

### ❷ **不要直接把 `ENABLE_LOD_HIDE` 打开**

`src/world/Lod.js:25`：`const ENABLE_LOD_HIDE = false;`

**为什么不做**：
- 收益接近 0：`Lod.js:51-52` 的阈值是 `shadowDist = 90 + min(r*2,160)`、`hideDist = 240 + min(r*3,360)`。这座地图 `boundary` 对角线约 400 米，**绝大多数摆放物连同半径放宽后仍在 hideDist 之内** → 剔不掉东西。
- 风险真实：`Lod.js` 隐藏 mesh ↔ `trimesh.js:78` 的 `!isVisible(o)` 直接相互作用 → 被隐藏的 complex 物体烘焙出的碰撞会缺斤少两。虽然 `Lod.js:53-57` 有 `noHide` 标记（complex 项由 `EditorBuildings.js:479` 的 `__batchable === false` 传入），但这条链上任何一环没对齐，就是"走到某个位置突然掉出地图"。

**如果要开，前置条件**：
1. 先确认 `registerLodTarget` 的 `noHide` 覆盖了**全部 trimesh 项**（当前 6 个 complex）；
2. 确认所有 complex 项的 trimesh 烘焙**已经完成**（异步）之后才允许 LOD 隐藏起作用 —— 否则如前所述碰撞会缺；
3. 把 `HIDE_DIST` 从 240 调到一个在这张图上有意义的数值（比如 150），否则开关等于没开。

---

### ❸ **不要在帧循环里重建任何 GPU 资源**（PMREM / shader / 几何合并）

- `SkyBox.js:355` 的注释已经明确记载这个坑：「过渡期不再逐档重建 PMREM：每档一次 buildEnvMap 在弱机是 **5~15ms 的卡顿尖峰**」。现在的实现是**加载期每时段各生成一份**，`update()` 里只换引用（`SkyBox.js:359/363-370`）—— **这是正确的，不要改回去**。
- 同理，不要在 `_loop` 里调用 `mergeStaticMeshes` / `mergeSceneBatches`。

---

### ❹ **绝对不要让「带阴影的灯的数量」发生抖动**（最高优先级铁律）

Three.js 的 program cache key 里包含 `numPointLightShadows` / `numSpotLightShadows`。**数量一变，所有已编译材质全部失效重编译 → 周期性卡顿尖峰**，且这种尖峰的表现正是用户说的"一卡一卡的"。

当前代码是**安全的**（`Lights.js:252-256`，恒定保持 `min(max, len)` 盏），但要注意两个**容易踩的实现陷阱**：

| ❌ 错误写法 | ✅ 正确写法 |
|---|---|
| 按距离/时间/是否 registering 灯 逐个 `light.castShadow = 亮/暗`（数量会漂） | 始终是「排序后取前 K 盏 true，其余 false」（`Lights.js:241-257` 现有写法） |
| **按 `light.intensity` 判断要不要投影**（0 亮度就关） | 保持 K 盏恒定；若想省，改 **K 的值**或改 **`shadow.camera.far`**，而不是改"哪几盏亮" |
| 在 `_loop` 里动态增删注册到 `_pointCands` 的灯 | 只在场景构建/销毁时通过 `clearShadowBudgets`（`Lights.js:263`）+ `registerPointLight` 同步做 |

> ⚠ **顺带报告一个潜在缺陷（当前线上未触发，但已埋雷）**：
> `Game.js:1188` 在 off-hours 时写 `light.intensity = 0`，但**没有同步 `castShadow`**；而 `Lights.js:256` 选 K 盏时**只看距离，不看亮度**。
> → **一旦某盏灯被设了开启时段，`intensity=0` 的灯照样会被渲染完整阴影贴图**（three.js 只在 `Light.visible === false` 时把它踢出灯光列表，`intensity=0` 不会）。
> 线上当前的 9 盏灯都没有 `onMode` 字段（`parseOnWindow`，`EditorBuildings.js:326-328` 返回 null → 常亮），**所以暂时没踩到**；但编辑器里一旦给灯设了"夜晚才亮"，白天就会为 0 亮度的灯付全额阴影代价，用户只会看到"白天更卡"。
> → 处理建议：`_applyEditorLightDayState`（`Game.js:1176-1191`）在写 `intensity = 0` 时**同步把该灯设为 `light.visible = false`**（而不是去动 `castShadow`，那会破坏数量恒定）。这是唯一既省代价、又不碰铁律的做法。

---

### ❺ **不要把"降分辨率"作为给用户的第一建议**

用户报告已明确：分辨率拉到最低仍然卡。而且 `Game.js:950` 的 `_adaptResolution` 自动档下限就是 `0.6`，手动档下限 `0.4`（`Game.js:809`）—— 他已经在这个区间的最底部了。**在这个位置上继续建议降分辨率，只会让画面更糊而帧率不变**，需要向用户解释清楚的是：`为什么降分辨率不起作用`（因为砍掉的是主 pass 像素，而瓶颈在固定的阴影趟数与 CPU），以及 `你会替他砍掉的是哪一部分`。

---

## 附录 A：线上场景实测数据

拉取自 `https://game666.lshserver.dpdns.org/api/scene`（200，23706 B）：

```
boundary : X[-115, 117]  Z[-155, 175]   showWalls=true  wallHeight=3
placed   : 29 项
lights   : 9 盏（area 3 + point 6）
collision: simple 23（含 zhaji.glb 的 16 个 convexParts） / complex 6（trimesh）
空 url   : 7 项（只有盒碰撞体，无模型）
```

**走完项目自身 `mergeStaticMeshes` 的场景普查结果：**

```
合计（编辑器摆放部分，乘以摆放次数）
场景图节点 208    网格 65    三角形 133,228
```

**complex（trimesh）明细：**

| GLB | 摆放次数 | 原始 prims | 合并后网格 | 三角面 |
|---|---|---|---|---|
| `import-1790933386381-___.glb` | 1 | 837 | 4 | 50,724 |
| `import-1790908774172-111.glb` | 1 | 828 | 6 | 32,842 |
| `import-1791188164505-school-hall.glb` | 1 | 90 | 12 | 3,452 |
| `import-1791174823222-floor.glb` | **3**（scale.y 各异 → bakeKey 不同 → 烘焙 3 次） | 3 | — | 36 |

**6 盏点光源全参数（注意 `distance: 100`）：**

| id | x, y, z | intensity | distance | decay |
|---|---|---|---|---|
| 130 | -93.4, 14.5, 10.7 | 40 | **100** | 1 |
| 133 | -77.3, 14.5, 10.7 | 30 | **100** | 1 |
| 134 | -58.9, 14.5, 10.7 | 30 | **100** | 1 |
| 135 | -77.3, 12.4, -13.9 | 30 | **100** | 1 |
| 136 | -81.4, 8.5, -29.0 | 30 | **100** | 2 |
| 137 | 2.6, 18.2, 77.2 | 30 | **100** | 1 |

> ⓘ 上述"合并后网格数"来自 Node 环境（纹理无法解码 → 材质会被视作相同）。**浏览器里的真实值会略高于 65，但仍在同一数量级（百级）**，不影响 §1 的负面结论（draw call 不是瓶颈）。这也是为什么**必须先用探针 A 实测**，而不是直接照着 65 这个数去砍合批。

---

## 附录 B：证据索引（`文件:行号` → 事实）

| 位置 | 事实 |
|---|---|
| `Game.js:169-175` | `shadowMap.enabled=true`、`PCFSoftShadowMap`、`autoUpdate=false`、`_shadowTick=0` |
| `Game.js:190` | `PerspectiveCamera(70, aspect, 0.1, 500)` |
| `Game.js:822` | 走超分时 `setPixelRatio(base * 1)` → 画布保持原生分辨率 |
| `Game.js:834-836` | `_useUpscale()` 条件：`_sharpen>0.001 && _dynScale<0.98` |
| `Game.js:850-871` | 全屏 5 抽样 unsharp-mask 合成着色器 |
| `Game.js:896-905` | RT：`HalfFloatType` + `samples: _aaOn ? 4 : 0` |
| `Game.js:913-939` | `_renderFrame()`：先 `updateShadowBudgets` → `updateLod`（非战斗）→ 超分/直渲分支 |
| `Game.js:921-926` | 直渲分支（不走超分时的路径） |
| `Game.js:945-957` | `_adaptResolution`：1.5s 节流，`<45fps` 降 0.2，`>57fps` 升 0.1，下限 0.6 |
| `Game.js:959-999` | `_updatePerfHud`：0.25s 刷新；碰撞体普查读缓存 `triCount/meshCount`（不遍历三角） |
| `Game.js:1159` | 每帧 `_timeSky.update(t, camera)` |
| `Game.js:1176-1191` | `_applyEditorLightDayState`：每帧循环 9 盏灯，写 intensity / 调 `setAreaBaseIntensity` |
| `Game.js:1188` | ⚠ off-hours 只写 `intensity=0`，不动 `castShadow` / `visible` |
| `Game.js:1208-1229` | `_applyQuality`：high/mid/low → shadowSize 2048/1024/512、dpr 2/1.5/1、PCFSoft/PCF/Basic |
| `Game.js:1927/1934` | `_updateAimUI`：只在状态翻转时写 style/class ✅ |
| `Game.js:2034/2038` | `_updatePickupHint`：只在状态翻转时写 ✅ |
| `Game.js:2202` | `void el.offsetWidth`（刻意的单次强制重排，非每帧） |
| `Game.js:6827-6892` | 主循环 25+ 个系统 update |
| `Game.js:6934-6944` | 每帧太阳阴影 texel 对齐 + `st.updateMatrixWorld()` |
| `Game.js:6962-6963` | `shadowMap.needsUpdate` 每 2 帧置一次（≈30Hz） |
| `Lights.js:20-22` | `MAX_POINT_SHADOW=4` / `MAX_AREA_SHADOW=2` / `SHADOW_MAP=512` |
| `Lights.js:93-105` | `configureShadow`；**far=30 的兜底只对 `!light.distance` 生效** ← 根因 1 的关键 |
| `Lights.js:150-152 / 191` | 面光源代理：`proxy.distance = dist` → `configureShadow(proxy, dist)` |
| `Lights.js:158-174` | `syncAreaShadow`：每盏每帧可被调用，含 `updateProjectionMatrix()` |
| `Lights.js:241-257` | `rebalance`：恒定保持 `min(max, len)` 盏 `castShadow`（铁律成立） |
| `Lights.js:252` | `const want = Math.min(max, list.length);` ← 数量恒定的保证 |
| `Lights.js:271-274` | `updateShadowBudgets` 每帧被调用两次 rebalance |
| `Lights.js:296-297` | 太阳 `castShadow=true`，`mapSize` 取 `DEFAULT_SETTINGS.shadowSize` |
| `EditorBuildings.js:34-36` | `setEditorSceneVisible`：进对战整组隐藏城市建筑 |
| `EditorBuildings.js:304-308` | `LIGHT_DEFAULTS`（distance 默认 12） |
| `EditorBuildings.js:326-328` | `parseOnWindow`：无 `onMode` → 返回 null（常亮） |
| `EditorBuildings.js:365/373` | `BATCH_GRID=48`；**`ENABLE_BATCH_MERGE = false`** |
| `EditorBuildings.js:479-480` | complex 项 → `registerLodTarget(h, { noHide: true })` |
| `EditorBuildings.js:517-529` | 点光源构造：`finiteOr(it.distance, LIGHT_DEFAULTS.distance)` → 线上 = 100；随后 `registerPointLight` |
| `EditorBuildings.js:549` | 面光源 → `enableAreaShadow`，代理 distance=14 |
| `Lod.js:15-25` | `SHADOW_DIST=90` / `HIDE_DIST=240` / `TICK_MS=300` / **`ENABLE_LOD_HIDE=false`** |
| `Lod.js:51-52` | 阈值还要按包围球半径放宽 → 在这张图上几乎剔不掉东西 |
| `trimesh.js:54-78` | `isVisible` / `inColliderVis` / `collectMeshes` 的 `if (inColliderVis(o) \|\| !isVisible(o)) return;` ← 可见性与碰撞的耦合点 |
| `trimesh.js:34-50` | `bakeByKey` + `BAKE_KEY_MAX=32` LRU |
| `trimesh.js:282-303` | `bakeTriMeshAsync`：key 由位置/缩放等决定 → floor 摆 3 份且 scale 不同 = 3 次烘焙 |
| `characterSolver.js` | 6 次接触迭代 × 13 根 SAT 轴；子步 = `ceil(dist/0.15)`，上限 96，撞台阶会重试翻倍 |
| `PlayerPhysics.js:69-79` | 每帧 new 3 个 `Vector3` |
| `PlayerPhysics.js:147-154` | 每帧重建 `_trimeshes` / `_simples` 分桶 |
| `PlayerPhysics.js:335/519` | `_prepareConvex` 用 `Set` + `toFixed(3)` 字符串键去重（一次性，缓存，OK） |
| `Network.js:20-21/295/301-341/352` | 20Hz `setInterval`；变化阈值（位移 >2cm / 朝向 >1°）；静止降 5Hz |
| `SnapshotBuffer.js:24-36/46-56/60-85/114-120` | 每帧线性扫 ≤48 条；`suggestDelayMs` 每 1s 才 sort；每次 push 一次 clone |
| `RemotePlayer.js:84-140` | 每帧采样插值；`_extrapolateTo` 生成 `{...d}`（外推时每帧一个对象） |
| `SkyBox.js:23-40` | `buildEnvMap` / `PMREMGenerator`（加载期） |
| `SkyBox.js:340-370` | `update()`：只换 env 引用（`useCachedEnv`），`scene.environmentIntensity` 每帧写（uniform，免费） |
| `SkyBox.js:355` | 注释明载"PMREM 逐档重建是 5~15ms 尖峰" → 已移除，勿复原 |
| `SkyBox.js:406-423` | 每帧写 4 个球壳的 opacity/renderOrder/visible/scale/position |
| `AssetLoader.js` | `optimizeLoadedModel` 在**加载期**执行 `mergeStaticMeshes`（once per URL）✅ |
| `config.js` | `TRIMESH_SUBSTEP_MAX_DIST 0.15` / `HARD_MAX 96` / `CONTACT_ITERATIONS 6` / `CELL_SIZE 2.0` / `LAYER_HEIGHT 2.0` |
| `main.js:74(perf)/Game.js:74` | URL 带 `perf` 即打开性能 HUD；`main.js:92` 暴露 `window.__game` |

---

*报告结束。本轮未修改任何 `.js` / `.html` 源码。*
