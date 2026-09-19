// 职责：集中管理所有可调参数，逻辑代码不允许硬编码数值（除了少量纯结构常量）。
// 修改这里即可调整手感，无需改动其它模块。

export const Config = {
  // 水平移动速度（单位：米/秒）
  MOVE_SPEED: 5,
  // Shift 加速倍率：实际速度 = MOVE_SPEED * SPRINT_MULTIPLIER
  SPRINT_MULTIPLIER: 1.6,
  // 跳跃初速度（向上，正值；米/秒）
  JUMP_VELOCITY: 6,
  // 重力加速度（向下，负值；米/秒^2）。负号表示方向朝 y 轴负方向。
  GRAVITY: -20,
  // 鼠标灵敏度：缩放鼠标移动量到旋转弧度
  MOUSE_SENSITIVITY: 0.002,
  // 手机触屏视角灵敏度：拖动像素到弧度的缩放（触屏拖动幅度通常大于鼠标位移，取更高值）
  TOUCH_SENSITIVITY: 0.014,
  // 玩家身高，也是相机离地高度（米）
  PLAYER_HEIGHT: 1.7,
  // 玩家碰撞半径（水平方向，用于边界限制）
  PLAYER_RADIUS: 0.4,
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
};

// 后端 HTTP 地址：编辑器保存/读取场景、素材清单、模型上传，以及游戏运行时拉取场景都走这里。
// 部署到 GitHub Pages 后仍指向这个远程后端，从而实现「编辑器改完 → 线上游戏即生效」的在线同步。
export const API_BASE = 'https://game666.lshserver.dpdns.org';