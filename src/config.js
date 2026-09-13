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
  // 玩家身高，也是相机离地高度（米）
  PLAYER_HEIGHT: 1.7,
  // 玩家碰撞半径（水平方向，用于边界限制）
  PLAYER_RADIUS: 0.4,
  // 地面边长（整块正方形地面，单位：米）
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
};