// 职责：集中管理所有可调参数，逻辑代码不允许硬编码数值（除了少量纯结构常量）。
// 修改这里即可调整手感，无需改动其它模块。

export const Config = {
  // 水平移动速度（单位：米/秒）
  MOVE_SPEED: 5,
  // Shift 加速倍率：实际速度 = MOVE_SPEED * SPRINT_MULTIPLIER
  SPRINT_MULTIPLIER: 1.6,
  // 跳跃初速度（向上，正值；米/秒）
  JUMP_VELOCITY: 6,
  // 喷气背包悬停/上升速度（米/秒）：NPC 给玩家喷气背包后，空中按住空格以此速度持续上升
  JETPACK_LIFT: 5,
  // 重力加速度（向下，负值；米/秒^2）。负号表示方向朝 y 轴负方向。
  GRAVITY: -20,
  // ---- 斜面抓地（走上/停在斜坡上不再像踩冰一样下滑）----
  // 可站立坡度阈值：坡面法线的竖直分量（= cos 坡度角）不小于该值即视为「可走地面」。
  // 0.7 ≈ 45.6°，即坡度约 45° 以内可站立行走；更陡的面仍按墙面处理（被挡住 / 滑落，不能爬墙）。
  SLOPE_MAX_NORMAL_Y: 0.7,
  // 地面吸附距离（米）：脚底往下该范围内若存在可站立地面（坡面 / 盒顶 / 平地），
  // 就把玩家沿竖直方向吸附到该地面上，使上下坡时 y 紧跟坡面（下坡不掉空、上坡不陷入）。
  GROUND_SNAP_DISTANCE: 0.5,
  // 吸附的最大允许落差（米）：只在脚底与地面落差很小（正常贴地滑行）时才吸附。
  // 落差过大说明玩家正在下落；若仍吸附，会在离地尚远时被瞬间拉到地面并清零竖直速度，表现为「坠落震一下」。
  GROUND_SNAP_MAX_GAP: 0.15,
  // 吸附允许的最大下落速度（米/秒）：下落较快说明正在坠落，不吸附，交给碰撞解析正常着陆。
  GROUND_SNAP_MAX_FALL_SPEED: 2.0,
  // 上坡抓地强度（0~1）：在可站立斜面上，碰撞推出量的水平分量被抵消的比例。
  // 1 = 完全抵消（只沿竖直方向吸附到坡面，站得最稳、不下滑）；0 = 完全沿坡面法线推出（旧行为，会持续下滑）。
  SLOPE_GRIP: 1,

  // ---- complex 模式（室内 trimesh 碰撞）----
  // 单步子步的最大位移（米）：把一帧位移切成若干子步，保证每步子步位移不超过该值。
  // 这就是防穿透的**唯一不变式**：只要每步子步位移 ≤ 0.15m，即使 dt 抖动、速度突变，
  // 也不会有任何一步跨过薄楼板（0.12m）或薄墙（玩家 AABB 宽 0.8m，需要 >0.92m 才可能整体越过）。
  // 由此推得子步数 n = ceil(|Δ| / 该值)：
  //   · 常规行走（6 m/s、60fps → 0.1m）→ n = 1
  //   · 冲刺 + 下坠（|Δ| ≈ 0.35m）→ n = 3
  //   · 极速下落（|Δ| ≈ 3m）→ n = 20
  TRIMESH_SUBSTEP_MAX_DIST: 0.15,
  // 子步数的绝对安全上限：仅防御异常 dt / 速度导致的步数爆炸（如切回前台时 dt 被 clamp 前的极端值）。
  TRIMESH_SUBSTEP_HARD_MAX: 96,
  // 每个子步内去穿透（接触解析）的最大迭代次数：多面夹角（地板+墙）需要几轮才能收敛。
  TRIMESH_CONTACT_ITERATIONS: 6,
  // step-up 可自动跨上的最大台阶高度（米）：水平推进被竖直面挡住、抬升该高度后能继续走时自动上台阶。
  // 取约「角色高度的 40%」：角色高 1.6m → 1.6 × 0.4 = 0.64，低于此高度的矮墙/台阶自动迈上去。
  TRIMESH_STEP_UP_HEIGHT: 0.64,
  // 3D 宽相位的 XZ 格子尺寸（米）：大合并网格里用均匀格子把候选三角形限制在玩家附近。
  TRIMESH_CELL_SIZE: 2.0,
  // 3D 宽相位的 Y 分层高度（米）：多层建筑的各层三角形按 Y 分桶，
  // 否则各层会被压进同一格、层数一多就退化成全量遍历（收益归零）。
  TRIMESH_LAYER_HEIGHT: 2.0,
  // 烘焙分片：每累积这么多三角形就让出主线程一次，避免一次性遍历大模型卡住画面。
  TRIMESH_BAKE_CHUNK_TRIS: 20000,
  // 鼠标灵敏度：缩放鼠标移动量到旋转弧度
  MOUSE_SENSITIVITY: 0.002,
  // 手机触屏视角灵敏度：拖动像素到弧度的缩放（触屏拖动幅度通常大于鼠标位移，取更高值）
  TOUCH_SENSITIVITY: 0.014,
  // 骑车时的自由视角（仅电脑）：鼠标左右只转头看，不动车头；这是最大偏转角（度），
  // 取 150° 是为了还能回头看一眼，又不至于让「前/后」彻底分不清。
  RIDE_LOOK_MAX_DEG: 150,
  // 骑车相机的「跟随拉力」（1/秒）：相机水平朝向不是瞬间锁死在车头上，而是按这个速度缓动跟过去。
  // 越大越跟手（越小＝转弯时视角被慢慢拖过去、更迟）。约 5 时满舵（120°/s）落后约 25°。
  RIDE_CAM_LAG: 5,
  // 骑车相机的「回正力」（1/秒）：鼠标掰开的自由视角会按这个速度慢慢被拉回车头方向。
  // 越大回正越快（越小＝掰开后能保持更久）。0 = 永不回正（一直停在你摆的角度）。
  RIDE_CAM_RECENTER: 0.8,
  // 玩家身高，也是相机离地高度（米）
  PLAYER_HEIGHT: 1.7,
  // 玩家碰撞半径（水平方向，用于边界限制）
  PLAYER_RADIUS: 0.4,
  // ---- 移动时模型疯狂旋转【已临时注释，待重启用】----
  // 自转角速度基数（弧度/秒）：人物一旦移动，模型就绕自身竖轴飞速打转
  // MODEL_SPIN_SPEED: 16,
  // 触发自转的最小移动速度（米/秒）：低于它视为站着不动，停止加速自转
  // MODEL_SPIN_MIN_SPEED: 0.2,
  // ---- 玩家骨骼动画（boy/girl 的 mixamorig 骨架 + Idle/Walk/Run 三段动画）----
  // 说明：角色实际移动速度（5 m/s，冲刺 8 m/s）远快于真人走路，若让动画严格跟速度走，
  // 腿会甩成风车且明显「脚底下打滑」，所以这里只做**观感映射**：速度换成权重与步频，不追求物理准确。
  ANIM_IDLE_MAX: 0.35,   // 低于该速度视为站立
  ANIM_WALK_FULL: 1.8,   // 到该速度完全是走路姿态
  ANIM_WALK_REF: 3.0,    // 走路动画的基准步速：timeScale = speed / 该值
  ANIM_RUN_START: 4.2,   // 超过该速度开始混入跑步
  ANIM_RUN_FULL: 6.2,    // 到该速度完全是跑步姿态
  ANIM_RUN_REF: 6.5,     // 跑步动画的基准步速
  ANIM_TIMESCALE_MIN: 0.55, // 步频下限（站着将动未动时也在微动，避免突然起停）
  ANIM_TIMESCALE_MAX: 1.9,  // 步频上限（再快就成风车了）
  // 第一人称走路晃动幅度（米）：上下起伏的峰值；左右摇摆为其 0.6 倍
  BOB_AMPLITUDE: 0.04,
  // 走路晃动相位推进速度（弧度/米）：越大步伐越急促；约每 1.6m 走完一个完整起伏周期
  BOB_SPEED: 1.8,
  // 地面尺寸（单位：米）。1 世界单位 = 1 米。宽沿 x，长沿 z。
  GROUND_WIDTH: 160,
  GROUND_DEPTH: 310,
  // 旧的正方形边长（兼容历史引用；当前场景用上面的宽/深矩形）
  GROUND_SIZE: 50,
  // 四周墙面高度，防止玩家走出去
  WALL_HEIGHT: 3,
  // 抬头 / 低头最大俯仰角（度），限制为接近 90° 但不到
  MAX_PITCH_DEG: 89,
  // 主循环 dt 上限（秒），防止页面切后台后恢复时帧间隔过大导致角色瞬移
  MAX_DELTA_TIME: 0.1,
  // 地面与墙体的基础配色
  GROUND_COLOR: 0x2f6f5f,
  WALL_COLOR: 0xffffff,
  WALL_OPACITY: 0.35,
  // 多人在线中继地址（后端已迁到远程，支持 HTTPS/wss，wss 走 443）。
  // 纯本地调试可改回 'ws://localhost:9000'。
  RELAY_URL: 'wss://game666.lshserver.dpdns.org',

  // ---- AI 商人 NPC ----
  // NPC 世界坐标（米）：出生点约 (2,144)，放在旁边的校园喷泉(-2,143)
  NPC_POS: { x: -2, z: 143 },
  // 玩家离 NPC 多远内算「可对话」（水平距离，米）
  NPC_PROXIMITY: 3.2,
  // 触发对话的键（e.code）
  NPC_KEY: 'KeyF',

  // ---- 血量与战斗 ----
  HEALTH_MAX: 500,        // 血量上限（任何接口都不得超过这个值）
  RESPAWN_DELAY: 1.2,     // 死亡后自动重生的等待秒数
  // 投掷物默认参数（AI 未指定时使用；AI 指定的会被后端钳制到安全区间）
  PROJECTILE_SPEED: 18,   // 出手初速度（米/秒）
  PROJECTILE_RADIUS_MIN: 1,
  PROJECTILE_RADIUS_MAX: 20,
  DAMAGE_MIN: 1,
  DAMAGE_MAX: 120,        // 单次伤害上限，避免一击秒杀

  // ---- 电动车（双人载具）----
  VEHICLE_MODEL: '/models/scooter.glb',
  VEHICLE_POS: { x: -7, z: 144 }, // 停放点（未有人驾驶时固定停这里）
  VEHICLE_YAW: 0,                 // 停放时的朝向（弧度）
  VEHICLE_HEIGHT: 1.15,           // 归一化后的模型高度（米），按包围盒等比缩放
  VEHICLE_YAW_OFFSET: Math.PI,    // 模型自带朝向与"车头朝 -Z"之间的补偿角（弧度），必要时调这个
  VEHICLE_SPEED: 26,              // 骑乘时的最高前进速度（米/秒）
  VEHICLE_ACCEL: 20,              // 油门加速度（米/秒²）：越高起步越快（太小会感觉「车速缓慢上升」）
  VEHICLE_DRAG: 0.9,              // 松油门后的惯性阻力系数（越大滑得越短、越小越"溜"）
  VEHICLE_BRAKE: 30,              // 刹车减速度（米/秒²）
  VEHICLE_TURN: 2.1,              // 转向角速度（弧度/秒，满舵时）
  VEHICLE_STEER_SMOOTH: 14,       // 方向打进去 / 回正的平滑速度（越大越跟手、越小越"绵"）
  VEHICLE_REVERSE_RATIO: 0.45,    // 倒车最高速度 = 前进 × 它
  VEHICLE_KEY: 'KeyF',            // 上车/下车键
  VEHICLE_PROXIMITY: 2.6,         // 距离多远内可以上车（米）
  VEHICLE_SEAT_BACK: 0.95,        // 后座相对驾驶位向后偏移（米）
  VEHICLE_ID: 'scooter1',         // 载具标识，写进玩家状态用于配对前后座

  // ---- 昼夜循环 ----
  DAY_START: 0.35,   // 起始时刻（0 = 午夜，0.5 = 正午）
  // 时段天空盒交叉淡入比例：每段末尾用这段时间比例把下一张图淡入进来
  // （例如 0.18 = 本段最后 18% 的时间用于过渡），避免日出/日落时天空「啪」地换一张
  SKY_FADE_RATIO: 0.18,

  // ---- 远端玩家插值（多人延迟观感优化）----
  INTERP_MODE: 'buffer',      // 'buffer' = 快照缓冲 + 时间轴插值；'off' = 旧的指数平滑（一键回退对比）
  INTERP_DELAY_BASE: 100,     // 基准对抗延迟（ms），约等于 20Hz 的 2 个快照间隔
  INTERP_DELAY_MIN: 60,       // 网络良好时压到的下限（ms）
  INTERP_DELAY_MAX: 250,      // 抖动很大时放宽到的上限（ms）
  EXTRAPOLATE_MAX: 250,       // 缓冲耗尽后允许外推的最长时间（ms），超过就停住等新快照

  // ---- 传送门与「老师」Boss ----
  PORTAL_POS: { x: 11, z: 142 },  // 传送门所在坐标
  PORTAL_PROXIMITY: 4,            // 离传送门多近内出现「召唤老师」按钮（米）
  PORTAL_RESET_DELAY: 4,          // 老师被击败后传送门重新可用的等待秒数
  BOSS_MODEL: '/models/teacher.glb',
  BOSS_HEIGHT: 2.0,               // 归一化后的模型身高（米），按包围盒等比缩放
  BOSS_YAW_OFFSET: Math.PI,       // 模型自带朝向与「面朝 +Z」之间的补偿角（弧度），必要时调这个
  BOSS_RADIUS: 0.45,              // 命中判定圆柱半径（米）
  BOSS_HP: 1000,                  // 每个阶段的 Boss 血量（打空进入下一阶段）
  BOSS_SPAWN_DELAY: 10,           // 点击召唤后的出现倒计时（秒）
  BOSS_CHASE_SPEED: 4.4,          // 追击移动速度（米/秒）：要追得上玩家才能碰到人
  BOSS_CHASE_STOP: 0,             // 追到离目标这么近就停下（0 = 一路贴上去，靠接触判定秒杀）
  BOSS_CHASE_RANGE: 60,           // 超过该距离不再追击（米）
  BOSS_CONTACT_PAD: 0.15,         // 接触判定的额外余量（米）：碰到即秒杀
  // 阶段切换：血量打空后先「发白光 + 世界变红」，停顿这么多久再进入下一阶段
  BOSS_PHASE_SHIFT: 2.5,
  BOSS_VOLLEY_INTERVAL: 2.6,      // 一阶段弹幕间隔（秒）
  BOSS_VOLLEY_COUNT: 24,          // 每圈弹幕数量（向四周均分）
  BOSS_BULLET_SPEED: 9,           // 弹幕飞行速度（米/秒）
  BOSS_BULLET_LIFE: 4.5,          // 弹幕存活时间（秒）
  BOSS_BULLET_DAMAGE: 12,         // 单发弹幕命中玩家的伤害
  BOSS_BULLET_HIT_RADIUS: 0.55,   // 弹幕判定命中玩家的水平半径（米）
  // 二/三阶段：绕老师旋转的红色激光
  BOSS_LASER_COUNT: 3,            // 同时存在的激光数量
  BOSS_LASER_LEN: 26,             // 激光长度（米）
  BOSS_LASER_THICK: 0.35,         // 激光厚度（米）
  BOSS_LASER_DAMAGE: 80,          // 被激光扫到的伤害
  BOSS_LASER_HIT_COOLDOWN: 1.2,   // 同一玩家被激光命中的最小间隔（秒）
  BOSS_LASER_SPIN_2: 1.05,        // 二阶段旋转角速度（弧度/秒）
  BOSS_LASER_SPIN_3: 1.35,        // 三阶段旋转角速度（弧度/秒）
  BOSS_LASER_LOW: 0.05,           // 激光下沿高度（米）
  BOSS_LASER_HIGH_2: 0.6,         // 二阶段激光上沿高度（米）：跳起来（最高约 0.9m）就能躲开
  BOSS_LASER_HIGH_3: 5.0,         // 三阶段激光上沿高度（米）：跳不过去，必须用护盾
  BOSS_LASER_ON: 10,              // 激光持续开启时长（秒）
  BOSS_LASER_OFF: 5,              // 激光消失时长（秒）：给玩家留出输出窗口
  // 掩体：老师定期在朝向玩家的那一侧升起一圈石墙挡住粉笔头，10 秒后缩回地面。
  // 石头会同时进碰撞体列表，所以玩家自己也撞不过去，只能绕到背后的缺口打她。
  BOSS_WALL_INTERVAL: 16,         // 两次升墙之间的间隔（秒）
  BOSS_WALL_DURATION: 10,         // 掩体保持时长（秒）
  BOSS_WALL_COUNT: 6,             // 一圈的墙块数量
  BOSS_WALL_ARC: 250,             // 墙块铺开的角度（度），其余角度留作缺口
  BOSS_WALL_RADIUS: 2.8,          // 墙离老师的距离（米）
  BOSS_WALL_HEIGHT: 2.8,          // 墙高（米）
  BOSS_WALL_THICK: 0.35,          // 墙厚（米）
  BOSS_WALL_RISE: 0.8,            // 升起 / 缩回的动画时长（秒）
  // 落雷：每隔一段时间在老师附近随机位置落一道雷，落下前先给地面警示圈
  BOSS_BOLT_INTERVAL: 10,         // 落雷间隔（秒）
  BOSS_BOLT_WARN: 1.6,            // 预警时长（秒）
  BOSS_BOLT_RADIUS: 3,            // 落雷伤害半径（米）
  BOSS_BOLT_DAMAGE: 100,          // 落雷伤害
  BOSS_BOLT_SPREAD_MIN: 2,        // 随机落点离老师的最近距离（米）
  BOSS_BOLT_SPREAD_MAX: 11,       // 随机落点离老师的最远距离（米）
  // 三阶段：手动开启的间歇性护盾
  BOSS_SHIELD_KEY: 'KeyQ',        // 开启护盾的键
  SOUL_KEY: 'KeyP',               // 灵魂出窍切换键（肉身留在原地，视角自由飞行）
  SOUL_SPEED: 18,                 // 灵魂飞行速度（米/秒），按住 Shift 三倍
  PICKUP_KEY: 'KeyE',             // 靠近掉落物时按该键拾取（手机点屏幕上的「拾取」按钮）
  // 丢弃物品（会带物理效果掉在地上，全员可见）
  DROP_MODIFIER_KEY: 'KeyY',      // PC：按住该键 + 数字键，丢弃对应技能槽的物品
  DROP_THROW_SPEED: 7,            // 丢弃时朝视线方向的初速度（米/秒）
  DROP_THROW_UP: 3.5,             // 丢弃时附加的向上初速度（米/秒）
  DROP_RADIUS: 0.32,              // 丢弃物碰撞半径（静止时中心离地高度）
  DROP_LIFETIME: 90,              // 丢在地上的物品存在时长（秒）
  DROP_MAX: 60,                   // 同屏最多保留的丢弃物（超出先移除最旧的）
  DROP_GESTURE_MS: 320,           // 手机长按判定：最短按住时长（毫秒）
  DROP_GESTURE_DY: 42,            // 手机长按后上滑：触发丢弃的位移阈值（像素）
  DROP_PICKUP_RANGE: 2.8,         // 离掉落物多少米内出现「拾取」按钮（水平距离）
  DROP_PICKUP_HEIGHT: 2.6,        // 拾取的高度余量：物品比这还高/低就够不到（米）
  // 抓钩（技能槽物品「抓钩」，也是「疯狂抓钩」模式的基础移动手段）
  GRAPPLE_RANGE: 92,              // 钩爪最远能抓到的距离（米）——用户要求延长到 2 倍（原 46）
  GRAPPLE_SPEED: 25,              // 被拽过去的速度（米/秒）
  GRAPPLE_MAX_TIME: 2.4,          // 单次抓钩最长持续（秒），到时自动松手
  GRAPPLE_STOP_DIST: 1.9,         // 离锚点这么近就松手（米）
  GRAPPLE_COOLDOWN: 0,            // 松手后多久才能再抓（秒）。0 = 无冷却，松开即可立刻再抓
  GRAPPLE_THROW: 26,              // 钩中人时把对方甩出去的水平速度（米/秒）
  GRAPPLE_THROW_UP: 9,            // 钩中人时附加的向上速度（米/秒）
  GRAPPLE_CATCH_ARC: 18,          // 钩人的判定张角（度，以准星为中轴）
  GRAPPLE_CATCH_DY: 2.8,          // 钩人允许的高度差（米）
  // 疯狂抓钩：每根柱子顶上飘一颗光点，准星对上去按攻击就飞过去（不用再精确勾几何）
  GRAPPLE_BEACON_Y: 1.0,          // 光点中心相对柱顶的高度（米，也是抓钩的锚点）
  GRAPPLE_BEACON_ARC: 20,         // 瞄准光点的判定张角（度，以准星为中轴）
  GRAPPLE_BEACON_STOP: 0.9,       // 抓到光点后离它这么近就松手（比抓墙近，才能正好落到柱顶）
  // 疯狂抓钩：柱子场地 + 金币 + 底部岩浆（踩到地面＝掉进岩浆）
  GRAPPLE_ARENA_HALF: 22,         // 柱子场地半边长（米），实际 44×44
  GRAPPLE_PILLAR_COUNT: 16,       // 柱子数量
  // 起始平台（出生点）：环形均分。这三个数必须与 server-remote/index.js 的
  // grappleSpawnForIndex 保持一致（那边只发坐标、不建场景，没有共享模块，靠自检逐点对拍）。
  GRAPPLE_SPAWN_RADIUS: 15,       // 起始平台所在圆的半径（米）
  GRAPPLE_SPAWN_TOP_Y: 6,         // 起始平台顶面高度（米）
  GRAPPLE_SPAWN_COUNT: 6,         // 起始平台数量（环形均分）
  GRAPPLE_COIN_MAX: 40,           // 同屏金币上限
  GRAPPLE_COIN_INTERVAL: 2.2,     // 房主生成金币的间隔（秒）
  GRAPPLE_COIN_PER_WAVE: 2,       // 每波生成数量
  GRAPPLE_COIN_RADIUS: 1.2,       // 吃金币的判定半径（米）
  GRAPPLE_COIN_LIFETIME: 30,      // 金币存在时长（秒）
  GRAPPLE_MAGMA_DAMAGE: 9999,     // 掉进岩浆的伤害（直接判负退房）
  BOSS_SHIELD_DURATION: 1.5,      // 护盾持续时间（秒）
  BOSS_SHIELD_COOLDOWN: 2.8,      // 护盾冷却（秒，从开启时算）
  BOSS_SHIELD_DAMAGE: 100,        // 护盾成功挡下激光时老师掉的血
  BOSS_NET_HZ: 10,                // 联机时 Boss 位姿/血量的广播频率
  // Boss 战期间玩家的基础攻击（鼠标左键 / 手机「攻击」按钮）投出的粉笔头
  CHALK_DAMAGE: 50,
  CHALK_SPEED: 24,
  CHALK_RADIUS: 1.6,              // 粉笔头落点爆炸半径（只对 Boss 结算，不误伤玩家）
  CHALK_COOLDOWN: 0.28,           // 两次投掷的最小间隔（秒）
  // 技能槽 0 号位的「超级激光」：Boss 战期间占用 0 号槽，
  // 对老师累计造成 SUPER_CHARGE 点伤害后充能完成，触发一次追踪导弹，用完重新充能
  SUPER_CHARGE: 300,
  SUPER_MISSILE_DAMAGE: 300,      // 追踪导弹命中老师的伤害
  SUPER_MISSILE_SPEED: 26,        // 追踪导弹飞行速度（米/秒）
  SUPER_MISSILE_LIFE: 8,          // 追踪导弹最长飞行时间（秒）

  // ---- 商人「小满」与商店 ----
  MERCHANT_POS: { x: -14, z: 149 },  // 商人所在坐标
  MERCHANT_PROXIMITY: 3.6,           // 离多近内出现「找小满买东西」按钮（米）
  MERCHANT_MODEL: '/assets/girl.glb', // 女生模型
  MERCHANT_HEIGHT: 1.75,             // 归一化后的身高（米）
  MERCHANT_YAW: Math.PI * 0.25,      // 站姿朝向（弧度），让她面朝出生点方向
  BOSS_COIN_REWARD: 50,              // 击败老师奖励的学币

  // 兑换码：键统一按小写比较，值是要发的学币数。每个账号每个码只能用一次。
  REDEEM_CODES: {
    huacaozhongxue: 4000,
  },

  // ---- 棍子（横扫击飞）----
  CLUB_RANGE: 3.6,           // 横扫半径（米）
  CLUB_ARC_DEG: 160,         // 横扫张角（度），以玩家正前方为中心左右各一半
  CLUB_KNOCK: 15,            // 被扫到后的水平击飞速度（米/秒）
  CLUB_KNOCK_UP: 7,          // 击飞的向上分量（米/秒）
  CLUB_KNOCK_HOLD: 0.35,     // 被击飞后持续被推着飞的时长（秒）
  CLUB_SWING_TIME: 0.32,     // 挥棍动画时长（秒）
  CLUB_HIT_AT: 0.12,         // 动画进行到这个时间点时结算命中（秒）
  CLUB_COOLDOWN: 0.9,        // 两次挥棍的最小间隔（秒）

  // ---- 黑洞（投掷）----
  BLACKHOLE_SPEED: 14,        // 抛出初速度（米/秒）
  BLACKHOLE_GRAVITY: 0.35,    // 飞行时的重力系数（越小飞得越直）
  BLACKHOLE_GROW: 10,         // 长大耗时（秒），长满后开始吸人
  BLACKHOLE_RADIUS_MIN: 0.35, // 出手时的半径（米）
  BLACKHOLE_RADIUS_MAX: 3.0,  // 长满后的球体半径（米）
  BLACKHOLE_PULL_RADIUS: 10,  // 吸人判定半径（米）
  BLACKHOLE_PULL_SPEED: 14,   // 吸力最大速度（米/秒）
  BLACKHOLE_PULL_TIME: 1.6,   // 吸人持续时长（秒）
  BLACKHOLE_LIFE: 12.5,       // 总存活时间（吸完就消散）

  // ---- 捉迷藏玩具 ----
  HIDE_FIRST_REPORT: 5,       // 开局多久后先报一次方向（秒），之后按下面的间隔报
  HIDE_REPORT_INTERVAL: 30,   // 每隔多久向抓的人报告一次模糊方向（秒）
  HIDE_FUZZ_DEG: 40,          // 方向模糊量（±度）
  HIDE_BLOCK_SIZE: 1.0,       // 变成的方块边长（米）
  HIDE_CATCH_RANGE: 1.8,      // 抓的人离躲的人这么近就算抓到（米）

  // ---- 加特林（持续扫射 / 过热）----
  GATLING_DAMAGE: 5,          // 单发伤害
  GATLING_INTERVAL: 0.1,      // 两发之间的间隔（秒）
  GATLING_RANGE: 60,          // 射程（米）
  GATLING_HIT_RADIUS: 0.55,   // 弹道命中判定半径（米）
  GATLING_HEAT_PER_SHOT: 3.5, // 每发增加的热量（0~100，满 100 过热）
  GATLING_COOL_RATE: 28,      // 不射击时每秒散热量
  GATLING_RECOVER_AT: 30,     // 过热后要降到这个热量才能继续开火
  GATLING_BULLET_SPEED: 90,   // 子弹飞行速度（米/秒），只影响视觉，命中仍是瞬时判定
  GATLING_BULLET_STEP: 2,     // 射线拦截墙体的步进距离（米）；每步用线段扫描，薄墙也拦得住

  // ---- 控制枪：发射激光抓住别人，移动视角拖着对方走；对方可挣脱 ----
  CTRL_RANGE: 18,        // 抓取判定距离（米）
  CTRL_HIT_RADIUS: 0.6,  // 射线命中玩家的判定半径（米）
  CTRL_DIST: 4,          // 被控制者被吊在控制器视线正前方多远（米）
  CTRL_FOLLOW: 9,        // 被控制者被拉向锚点的速度（米/秒）
  CTRL_LIFT: 4,          // 被控制者跟随锚点高度变化的最大竖直速度（米/秒）
  CTRL_WATCHDOG: 3,      // 控制不设时长上限（用户要求「时间无限」）；仅当被控方这么久收不到控制者的锚点同步（掉线/崩溃）才自动松开
  CTRL_RATE: 20,         // 控制器向被控者同步锚点的频率（Hz）
  CTRL_BREAK_COOLDOWN: 1,// 挣脱后多久内免疫再次被抓（秒）

  // ---- 对战模式：匹配 + 单独竞技场（第一个模式「躲避陨石混战」）----
  COMBAT_ARENA_HALF: 16,        // 竞技场半边长（米），实际 32×32（紧凑，方便遭遇与躲避）
  COMBAT_WALL_HEIGHT: 4,        // 四周边界墙高度
  COMBAT_SPAWN_RADIUS: 12,      // 出生点离中心的半径（米），环形分布（须与 server arenaSpawnForIndex 的 r 一致）
  COMBAT_ROUND_SECONDS: 120,    // 抓钩模式的单局时长（秒）。陨石混战不限时——活到最后才结束。
  // 观战（对战中阵亡后，第三人称跟随存活玩家）
  SPECTATE_DIST: 5.0,           // 观战相机离目标多远（米）
  SPECTATE_LIFT: 1.6,           // 观战相机相对目标视点抬高多少（米）
  METEOR_INTERVAL: 0.6,         // 房主生成陨石的间隔（秒）→ 约 5 颗/秒
  METEOR_PER_WAVE: 3,           // 每波陨石数量
  METEOR_SPEED_MIN: 24,         // 下落速度（米/秒）
  METEOR_SPEED_MAX: 40,
  METEOR_RADIUS_MIN: 1.4,       // 陨石命中半径（米）
  METEOR_RADIUS_MAX: 3.2,
  METEOR_DAMAGE: 200,           // 被陨石砸中的伤害（一砸 200，500 血约 3 下）
  METEOR_IMPACT_PAD: 0.8,       // 落点判定额外余量（米）
  METEOR_SPAWN_Y: 60,           // 陨石初始高度
  METEOR_MAX_ALIVE: 80,         // 同屏陨石上限
  COMBAT_BALL_DAMAGE: 18,       // 对战里左键「能量球」的伤害（命中其他玩家结算）
  COMBAT_BALL_RADIUS: 2.4,      // 能量球爆炸半径（米）
  COMBAT_BALL_SPEED: 26,        // 出手速度（米/秒）
  COMBAT_BALL_COOLDOWN: 0.45,   // 攻击间隔（秒）

  // ---- 玩家聊天（PC 按 T / 手机左下角按钮）----
  CHAT_KEY: 'KeyT',             // PC 打开聊天输入的按键（须与 server 无关，纯本地）
  CHAT_MAX_LEN: 60,             // 单条发言最大字数（服务端另有一份 80 字硬上限）
  CHAT_LOG_MAX: 40,             // 屏幕上最多保留多少条消息（超出丢最旧的）
  CHAT_LINE_LIFE: 14,           // 一条消息停留多少秒后淡出（秒）；打开输入框时不消失
  CHAT_LINE_FADE: 0.6,          // 淡出动画时长（秒）
};

// 后端 HTTP 地址：编辑器保存/读取场景、素材清单、模型上传，以及游戏运行时拉取场景都走这里。
// 部署到 GitHub Pages 后仍指向这个远程后端，从而实现「编辑器改完 → 线上游戏即生效」的在线同步。
export const API_BASE = 'https://game666.lshserver.dpdns.org';