// 场景事件总线：摆件之间的「触发器」通信。
//
// 为什么不用现成的事件库/为什么不用 DOM 事件：
//   场景交互（三维区域的选项卡、运动器、将来的开关/按钮）只需要「按名字触发一件事」，
//   不需要冒泡、不需要 once、不需要 payload。一个 Map 就够，杀鸡别用牛刀。
//
// 事件名就是字符串匹配：区域选项卡配 event:'open_door'，运动器配 trigger:'open_door'，
// 点一下选项卡 → fire('open_door') → 所有配了这个名字的运动器收到。改名字两边同步改。
//
// ⚠ 生命周期：编辑器场景重建时必须 clearSceneEvents()（EditorBuildings.clearHolders 里调），
//   否则上一份场景的订阅会残留 —— 旧运动器还挂着旧模型引用，触发一次就把已删除的对象动了。

const _subs = new Map(); // 事件名 -> Set<fn>
let _syncHook = null;    // (ev) => void：本地触发时上报服务器（由 Game 注入 network.send）

// 只挂一次，重复调用以最后一次为准。传 null 可关闭（编辑器不需要联机）。
export function setSceneEventSyncHook(fn) {
  _syncHook = typeof fn === 'function' ? fn : null;
}

export function sceneOn(name, fn) {
  const key = String(name || '');
  if (!key || typeof fn !== 'function') return () => {};
  let set = _subs.get(key);
  if (!set) { set = new Set(); _subs.set(key, set); }
  set.add(fn);
  return () => sceneOff(key, fn); // 返回退订函数，方便一次性订阅
}

export function sceneOff(name, fn) {
  const set = _subs.get(String(name || ''));
  if (!set) return;
  set.delete(fn);
  if (!set.size) _subs.delete(String(name || ''));
}

// 触发一个事件：同步调用所有订阅者。单个订阅者抛错不能拖垮其它订阅者（出声但不中断）。
// 返回收到的订阅者数量（0 = 没有匹配的触发器，调用方可据此提示「没有东西响应」）。
// opts.broadcast === false：纯本地事件（玩家进出区域，各端按自己的位置各算一次，广播会让别人误触发）。
// opts.remote === true：这是服务器转发来的事件，只本地执行、不再上报（否则会无限回环）。
export function sceneFire(name, opts) {
  const key = String(name || '');
  const o = opts || {};
  const set = _subs.get(key);
  if (!set || !set.size) return 0;
  // 只上报真正有人订阅的事件，避免把空事件名广播满全房间
  if (o.broadcast !== false && o.remote !== true && _syncHook) {
    try { _syncHook(key); } catch (e) { console.warn('[sceneEvents] 事件同步上报失败:', e); }
  }
  let n = 0;
  for (const fn of Array.from(set)) { // 拷贝：订阅者里再订阅/退订也安全
    try { fn(); n++; } catch (e) { console.error('[sceneEvents] 事件「' + key + '」的订阅者出错:', e); }
  }
  return n;
}

export function clearSceneEvents() {
  _subs.clear();
}

export function sceneEventCount() { return _subs.size; }
