// 职责：自适应渲染分辨率的**纯决策逻辑**（不碰 DOM / WebGL，可在 Node 里直接跑断言）。
//
// 为什么单独抽出来：Game 里那套老逻辑会在「帧率富余」时一档档升到 1.0×，
// 而 1.0× 会跨过 _useUpscale() 的 0.98 判据 —— 整条渲染路径从
// 「低分辨率 RT + 升采样」硬切成「原生直渲」，观感就是「画面突然变很清楚、
// 连环境光色调都变了」。之后像素量翻倍又掉帧、再降回来，来回横跳。
// 现在自动模式的天花板钉死在 CEIL(< UPSCALE_LIMIT)，路径永远不切。
// 想用真正的 1.0× 原生渲染，必须在设置面板把「渲染分辨率」手动钉成 100%。

export const ADAPT = {
  FLOOR: 0.5,           // 实测甜点：再低画面发虚，收益递减
  CEIL: 0.95,           // 自动模式上限，必须 < UPSCALE_LIMIT
  UPSCALE_LIMIT: 0.98,  // 与 Game._useUpscale() 共用的唯一判据
  DROP: 42,             // 低于此帧率降档
  RAISE: 56,            // 高于此帧率才升档（贴近 vsync 上限，别一流畅就猛升）
  DROP_STEP: 0.15,      // 掉帧要降得快
  RAISE_STEP: 0.04,     // 回升要慢，避免画质一秒一跳
  MIN_INTERVAL: 2000,   // ms：改 drawingBuffer 本身有成本，别频繁做
  RAISE_COOLDOWN: 5000, // ms：刚降过档至少冷却这么久才允许升（治降→升→降震荡）
};

// state: { scale, lastChange, lastDrop }；now 单位 ms（performance.now()）。
// 返回 null = 本帧不动；否则返回新的 { scale, lastChange, lastDrop }。
// ⚠ 只读入参、不改入参：调用方拿到结果再落到 Game 的字段上，避免半更新状态。
export function adaptScaleDecision(state, fps, now) {
  const s = Number(state.scale);
  if (!isFinite(s) || !isFinite(fps) || fps <= 0) return null;
  if (now - state.lastChange < ADAPT.MIN_INTERVAL) return null;

  let next = s;
  let dropped = false;
  if (fps < ADAPT.DROP && s > ADAPT.FLOOR) {
    next = Math.max(ADAPT.FLOOR, s - ADAPT.DROP_STEP);
    dropped = true;
  } else if (fps > ADAPT.RAISE && s < ADAPT.CEIL) {
    // 刚降过档就别急着升回去：那是横跳最常见的一拍。
    if (now - state.lastDrop < ADAPT.RAISE_COOLDOWN) return null;
    next = Math.min(ADAPT.CEIL, s + ADAPT.RAISE_STEP);
  } else {
    return null;
  }

  // 硬护栏：无论入参被谁写成 1.0，自动模式的结果永远落在超分区间内。
  next = Math.max(ADAPT.FLOOR, Math.min(ADAPT.CEIL, next));
  // 只过滤「实际没变」，阈值必须很小：0.5 起步、步长 0.04 时最后一档是 0.94→0.95
  // （差 0.01），用旧的 0.01 判据会把这一步吃掉，永远卡在 0.94 上不去。
  if (Math.abs(next - s) < 1e-4) return null;
  return {
    scale: next,
    lastChange: now,
    lastDrop: dropped ? now : state.lastDrop,
  };
}
