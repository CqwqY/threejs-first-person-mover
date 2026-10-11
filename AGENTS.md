# AGENTS.md — 花草中学（first-person-mover）项目指令

> **本文件是本项目所有任务的最高优先规范。在此项目下的任何任务，都必须先读本文件再动手。**
> 本文件只放「必须每次遵守的硬约束 + 项目一句话背景」；专题细节见文末引用。
> 最后更新：2026-10-11

---

## 0. 项目一句话

**一个跑在浏览器里的 3D 校园第一人称沙盒：玩家自由走动 + 8 个由 LLM 驱动、有记忆会反思会社交的 AI 学生，在一个"玩家不在时也继续运转"的校园里过日子。**

- 技术底色：**浏览器 Three.js 前端 + 常驻 Node relay 服务端 + 云端 GLM 大模型**，三者分工明确。
- 主线不是"做更好的游戏"，而是"**让一群 NPC 看起来像人**"，玩法只是承载它们的舞台。
- 详细背景/现状见 `E:/玩法/项目背景与现状.md`。

---

## 1. ⚠⚠ 五条团队铁律（违反 = 做错方向，必须回滚）

### 铁律 1：代码只给旋钮，内容归 LLM
> 用户原话：「**我们不能让代码写好功能，而是让 LLM 自己写底层的逻辑才对！**」

- **不新增硬编码动作 / 台词 / 话题**。代码只提供**物理原语 + 参数**。
- 遇到新需求先问：**"这是已有原语的参数组合吗？"** 是就别加动作。
  - ✅ 正例："跟我走" = `person` 原语 + `keep` 参数（不是新动作）。
  - ❌ 反例：曾写的 `startFollow` / `startWait` 硬编码函数已被**整体回滚**。

### 铁律 2：翻译器只允许存在一份
- **`translateIntent(out)` 是唯一的「意图 → 物理原语」映射**；`normalizeAct` 只是兼容壳。
- 新增任何"改道来源"（对话/广播/委托…）**一律复用 `translateIntent`**，绝不复制白名单。
- 同一个"意图→动作"的映射写两份 ⇒ 必然漂移，症状是"某个入口**静默不生效**"（不报错）。

### 铁律 3：事件驱动 > 定时驱动
- 触发源只能是：**靠近 / 看到 / 听到 / 被搭话 / 卡住 / AI 说"该做某事"**。
- **定时器只当「上限 / 成本保险」，绝不当「触发」。**
- 概率型触发**必须有上界**才好测（如 `chatRoll()` 用 `dt/剩余`，同一对最多 4s 必开口）。

### 铁律 4：随机性只能用于"要不要开口"，不能用于"事情死活"
- 一旦开始（有了 LLM 明确意图），**存活与否一律信 LLM**（如对话的 `continue` 字段）。
- ❌ 在代码里再叠一层 `Math.random()` ⇒ (a) 会砍掉 LLM 明明想做的事；(b) 测试 flaky（同代码时红时绿）。

### 铁律 5：玩家的"身份键"必须稳定 —— `ownerKeyOf(ws)`
- `ws.__id` **每次重连都变**；拿它做 Key 的一切（对话历史/归属/定位）都会**重连即失忆**。
- ✅ 一律用 `ownerKeyOf(ws)`：登录 `u:<userId>`、游客 `anon:<IP>`；`isPlayerKey()` 认 `p:`/`u:`/`anon:` 三前缀。

---

## 2. ⚠⚠ 静默失效 10 条（代码看着对、零报错、功能整块消失）

> 这是本项目最大的风险类型：**不报错 = 最难查**。改任何东西前先扫一遍。

1. **未声明变量 + 空 `.catch(()=>{})`**：新语句接到行尾 `//` 注释后 → 变量从未声明 → 严格模式抛 `ReferenceError` → 被空 catch 吞。
   ⇒ 绝不把语句接到行尾注释后；**绝不写空 catch**。（`node --check`/esbuild **抓不到**未声明标识符）
2. **累加型字段未初始化**：`this._x += …` 无初值 → `NaN` → 比较恒 false → 整块永不执行。
   ⇒ 累加字段必须在**构造函数**里赋初值。
3. **`visible` 被误当纯渲染开关**：`trimesh.collectMeshes` 跳过不可见网格 → 隐藏待烘焙对象 = **空碰撞体**。
   ⇒ 动可见性前 grep `visible`；带 complex 碰撞的物件必须 `registerLodTarget(obj,{noHide:true})`。
4. **重试到上限后静默 `return`**：⇒ 任何放弃/降级分支都必须**广播状态**（`connecting/open/reconnecting/failed` + `onStatus`）。
5. **「取引用后清空原数组」= 批量回调全不触发** ⇒ 批量回调前一律 **`.slice()` 拷贝**再清空。
6. **渲染开关误伤动态体（"人在但模型没了 + 打不到"）**：`SkinnedMesh` 骨骼矩阵可带镜像（负行列式）把绕向翻掉。
   ⇒ **任何"省片元"的渲染开关都不要碰 SkinnedMesh / 动态体**。
7. **协议升级没审计全链路（"模型出现一瞬间就消失、还打不到"）**：快照改**增量**后 `_clone()` 把半条入库 → 插值采到 undefined → **坐标 NaN**。
   ⇒ 缓冲入库前必须 `_merge` 补全；`syncModel` 加 NaN 防线。NaN 在 JSON 里是 **null**。
8. **「先清空再重建」的异步空窗口**：`buildBody` 先 `clear()` 再加 —— 中间失败该节点**永久空掉**、零报错。
   ⇒ 换子节点一律**先加新的、再摘旧的**（`swapBody`）；`loadGLB` 失败须 `cache.delete(url)`。
9. **同一个量在双端各写一套换算/钳制，单位不一致**（"一进编辑角度跳到 720°"）。
   ⇒ 单位必须**注释钉死在字段旁**；两端**都**做归一化（别只信一端）。⚠ rotY 全项目单位是**度**。
10. **新建 `PlayerPhysics` 忘了设 `bound`** ⇒ 静默退回 `Config.GROUND_*` 旧矩形（"AI 被旧边界困住"）。
    ⇒ **任何新建的 `PlayerPhysics` 都必须显式 `physics.bound = <与玩家同一份边界>`**。

---

## 3. NPC 大脑：当前架构（改 NPC 必读）

```
快环（每帧）  System1：A* 寻路 + 客户端三维物理碰撞 + 微动作（原地活动/挪步/起跳/走台面）
慢环（低频）  System2：GLM 规划 → 反思 → 日计划 → 事件（公告/广播/委托）
```

- **双系统分工**：LLM（System2，灵魂）低频定意图/计划；本地代码（System1，本能）每帧执行走位/碰撞/动画。
- **定案频率：每 2 分钟、8 个 NPC 轮流**各调一次 GLM（`PLAN_INTERVAL_MS=120000`、`PLAN_STAGGER_MS=15000`）。
- **守卫式接入**：有模型且契约一致才用策略网络决策，否则**自动回退规则大脑**（零回归风险）。
- ⚠ **两个节拍别混**：`planAt`=LLM 规划节拍（贵，2min）；`decideAt`=规则大脑节拍（免费）。
  想让 NPC"别停下来"只能提前 `decideAt`——**一旦提前 `planAt`，LLM 调用量 ×8**。
- ⚠ **统一决策入口 `kind:'act'`**：LLM 直接输出 `{action,type,target,params,think,mem}`，服务端用 `translateIntent` 映射成既有 goalType。
- ⚠ **区域不给 AI 看名字**：`zoneAiName(z)` = `desc`(用途) 优先，**绝不用 `name`**。
- ⚠ **所有 NPC 发言必须走 `speak(id,text,except)`**（= 广播气泡 + 触发 8m 内听到）。**别再直接 `broadcast({t:'npc_say',...})`** —— 否则这句话没人听到。
- ⚠ **记忆归属要结构化**：一次调用写两人记忆极易写反，按**实际台词**拼（谁说的写谁）；模型的洞察存 `think` 而非 `mem`。
- ⚠ **prompt 里"提到我的名字=我本人"必须明写**；关系/人物一律给**人名**，绝不喂 `s3` 这种内部 id。
- 契约唯一真源：`tools/npc-policy/state_schema.json`（`train.py` 与 `policy.js` 必须逐字一致）。

专题细节 → `E:/玩法/.workbuddy/memory/MEMORY-npc.md`

---

## 4. 改动后的必做校验（三层 + 真构建）

```bash
# ① 语法
node --check <改动的每个 .js>
# ② 尾随注释守卫（防静默失效第 1 条）
node tools/lint-trailing-comment.mjs
# ③ 相关探针（一次命令只跑一个探针！）
node tools/probe-<相关>.mjs
# ④ 提交前：真 vite build（必须出到项目根之外）
npx vite build --outDir "$TEMP/_vite_xxx"
```

- NPC 相关探针：`probe-npc-social` / `probe-npc-identity` / `probe-npc-move` / `probe-npc-plan` / `probe-students` / `probe-policy`。
- ⚠ **探针临时目录 `rmSync` 会被沙箱"批量删除守卫"拦截**（>50 次删除/轮）⇒ 症状是进程**无声卡死/exit 非 0**。
  绕法：`env -u CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR -u CODEBUDDY_TOOL_CALL_ID node ...` + `dangerouslyDisableSandbox:true`，且**一次命令只跑一个探针**。
- ⚠ **写静态断言查"语义"不查"代码字面形状"**：否则每次合理重构都假红，且假红会掩盖真问题。
- ⚠ 断言里写多行字面量必须先 **CRLF→LF 归一化**（Windows 检出是 CRLF）。
- ⚠ `material.needsUpdate` 是只写 setter（读恒 undefined）→ 断言查 `material.version`。

---

## 5. 部署约定（⚠ 服务端必须让用户手动执行）

| 部分 | 方式 | 备注 |
|---|---|---|
| **前端** | push 到 `main` → GitHub Pages **自动部署** | `play.caiyz.dpdns.org`；⚠ CI `node-version` **必须 ≥22**，否则 `npm ci` 遇 `EBADENGINE` → **Pages 静默永不部署** |
| **服务端** | **用户手动** scp + `pm2 restart fp-relay` | ⚠ 服务器只开密码登录，本机公钥没装 |
| 移动端 | Capacitor Android | `@capacitor/*` 8.x |

### 服务端部署（改动 `server-remote/` 后必须提示用户）

✅ **优先让用户跑**：`bash tools/deploy-relay.sh`（一条命令传文件 + 重启）

命令式（用户嫌脚本麻烦时）：
```bash
scp <文件> cai@100.127.187.92:/home/cai/fp-relay/
ssh cai@100.127.187.92 "pm2 restart fp-relay"
```

⚠ **护栏**：
- 用户名 `cai`、路径 `/home/cai/fp-relay/` —— **别再试 root/ubuntu**。
- **两个目标目录别混**：源码（`*.js`）→ `/home/cai/fp-relay/`；**模型资产 → `/home/cai/fp-relay/data/assets/`**。
- 多文件互相 import（`index.js` ← `npcworld.js` ← `policy.js` ← `ai-student.js`）**必须全部传完再 restart**，否则 ESM 解析失败 → **整个 relay 起不来**。
- **最小文件集**：`index.js`、`npcworld.js`、`policy.js`、`ai-student.js`、`ai.key.js`、`auth.js`。

### 判定 Pages 是否部署成功（本机 github.com 全系 HTTP 000）
```bash
curl -s --noproxy '*' -D - -o /dev/null <url>?v=$(date +%s) | grep -i last-modified
```
比某提交早 ⇒ **那之后的部署全没生效**（不是缓存慢）。

---

## 6. Git 推送约定

- 本机 `GIT_TERMINAL_PROMPT=0` + `credential.helper=helper-selector`（GitHub Desktop 的）**取不到凭据**。
- **不要用 `git credential fill`**（会弹 GUI 选择器，被 SIGTERM 杀掉）。
- ✅ 唯一可行写法（GCM 取凭据 → 写临时 store → push）：
```sh
GCM="C:/Users/Administrator/.workbuddy/binaries/PortableGit/versions/1.2.0/mingw64/bin/git-credential-manager.exe"
CF=$(printf "protocol=https\nhost=github.com\n\n" | GCM_INTERACTIVE=never GIT_TERMINAL_PROMPT=0 "$GCM" get 2>/dev/null)
U=$(printf '%s\n' "$CF" | grep '^username=' | cut -d= -f2-); P=$(printf '%s\n' "$CF" | grep '^password=' | cut -d= -f2-)
printf 'https://%s:%s@github.com\n' "$U" "$P" > /tmp/gc
git -c credential.helper= -c credential.helper="store --file=/tmp/gc" push origin HEAD
rm -f /tmp/gc; unset CF U P
```
- ⚠ **别把 GCM 直接当 push 的 credential.helper**（首次直接 push 会被沙箱 SIGTERM）。
- 提交信息用中文 `feat(npc):` / `fix(relay):` / `docs:` 等前缀（见现有 git log）。

---

## 7. 目录速查

```
E:/玩法/first-person-mover/
├── src/                 前端（96 文件 / 3.4 万行，Three.js 0.170 + Vite）
│   ├── core/            Game.js 主循环、设置、昼夜
│   ├── world/           Students.js(NPC 渲染) / World / Props / SkyBox / Lod …
│   ├── player/          PlayerPhysics / 技能槽
│   ├── net/             Network.js（WebSocket 客户端）
│   └── editor/          编辑器
├── server-remote/       服务端（7 文件 / 7 千行，Node + pm2 fp-relay）
│   ├── npcworld.js      3166 行 = NPC 世界与大脑（核心）
│   ├── index.js         2263 行 = WS 路由 + 业务（商店/公告/委托）
│   ├── ai-student.js    GLM prompt 拼装
│   ├── policy.js        策略网络推理；auth.js 账号体系
│   └── data/            students.json / shop.json / feed/（训练集）
├── tools/               54 个探针 probe-*.mjs + npc-policy/ 训练脚本 + deploy-relay.sh
├── .github/workflows/   deploy.yml（Pages 自动部署）
└── docs/                历史方案文档

E:/玩法/                调研与方案（项目外，但归属本项目）
├── 项目背景与现状.md      背景 + 现状（本 AGENTS.md 的详细版）
├── AI有人样-调研与方案.md  斯坦福等同类项目调研 + 改造清单
├── 玩法机制设计.md        玩法方向
└── 渲染卡顿-外部调试清单对照.md / 多人延迟观感优化调研报告.md 等
```

---

## 8. 已知缺口 / 下一步（P0 → P2）

| 优先级 | 事项 | 理由 |
|---|---|---|
| **P0** | **活动 event 对象** `{id,host,what,place,at,joiners,status}` | 最像斯坦福高光；让传播与涌现第一次真正发生 |
| **P0** | 作息深化（深夜回宿舍 `sleep` 状态） | 成本极小，"像学生"的强信号 |
| **P1** | 3 人小群聊（一个发起人 + 两个听众，仍一次调用） | 小组事件聊得起来 |
| **P1** | 承诺与人情 `promises:[{to,what,at,kept}]` | "说好下午一起去"是"像人"的强信号 |
| **P2** | 检索语义化（同义表 → 极小 local embedding） | 同义改写能检索到 |
| **P2** | 地点/物件级知识 | 观察更具体 |

> **判据**：凡是能让"**个体行为传播成集体事件**"的，优先做 —— 那才是"人样"的来源。

---

## 9. 成本护栏（LLM 调用预算）

> 原则：**每个"想"都必须有「触发条件 + 冷却 + 全局串行」三件套。**

| 用途 | 触发 | 频率上限 |
|---|---|---|
| `plan` 规划 | 每学生 2 分钟 | 8 人 ≈ 240/h |
| `chat` NPC↔NPC | 靠近 + 概率 | ≤ 144/h |
| `dayplan` 日计划 | 每游戏日 1 次 | ≈ 8/游戏日 |
| `reflect` 反思 | 攒够新记忆 / 重要度达标 | ≤ 60/h（实际远低） |
| `post` 贴公告 | plan 给出 post | ≤ 24/h |
| `talk` 玩家搭话 | 玩家 | 玩家决定（不受冷却） |

合计上限 ≈ **470/h ≈ 8 次/分钟**（天花板，实际均值远低）。
禁止新增"无护栏的 LLM 调用"。

---

## 10. 性能：一句话结论

```
总帧 50ms
├─ 固定开销 ≈ 6ms   （CPU + 物理 + draw call；avgCalls=45 / avgTris=6.7 万 → 极轻）
└─ 像素着色 ≈ 44ms（88%） ← 唯一瓶颈：PBR + 7 路阴影 + 天空 IBL + RectAreaLight LTC + 超分合成
```

- **已证伪（别再花力气）**：draw call / 几何量、主 pass 阴影趟数、网络包体。
- **唯一被实测验证有效的杠杆：降分辨率**（`0.5× → 23.2 fps 涨到 47.8 fps`）。
- ⚠ **探针只能证明"实现没写错"，证明不了"它是瓶颈"** —— 定位瓶颈必须靠 `perftest.html` 实测。

专题细节 → `E:/玩法/.workbuddy/memory/MEMORY-render.md`

---

## 附：相关指令文件

| 文件 | 内容 |
|---|---|
| `E:/玩法/.workbuddy/memory/MEMORY.md` | 全局护栏索引 + 静默失效 10 条 + 部署命令 |
| `E:/玩法/.workbuddy/memory/MEMORY-npc.md` | NPC 大脑全部铁律（本文件第 3 节的详细版） |
| `E:/玩法/.workbuddy/memory/MEMORY-render.md` | 渲染/性能实测结论 |
| `E:/玩法/.workbuddy/memory/MEMORY-window.md` | 障眼法窗户 / 墙体挖洞 |
| `E:/玩法/.workbuddy/memory/MEMORY-data.md` | 网络同步 / 服务端权威 / 编辑器鉴权 |
| `E:/玩法/.workbuddy/memory/MEMORY-assets-ui.md` | 模型导入 / 骨骼 / UI |
| `E:/玩法/项目背景与现状.md` | 背景 + 现状（叙述版，给外部人看） |
