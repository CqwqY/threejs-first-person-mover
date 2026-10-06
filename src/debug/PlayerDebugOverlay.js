// 职责：联机排查用的「玩家模型体检」浮层（URL 带 ?pdbg 时才装）。
//
// 为什么要有它：手机/平板没法开控制台，而「看得见名牌和手持物、看不见人」这类问题
// 光看画面完全分不清是「人没渲染」还是「人被放到别处去了」。浮层直接把关键量贴屏幕上。
//
// 默认不创建任何 DOM、不占任何帧时间 —— 只有地址栏带 ?pdbg 时才挂上，定位完即可删。
import { debugPlayerBodies } from '../player/PlayerModel.js';

export function installPlayerDebugOverlay(game) {
  if (typeof document === 'undefined' || !document.body) return null;
  const el = document.createElement('pre');
  // 放左上、不吃点击（pointer-events:none），避免影响操作
  el.style.cssText = 'position:fixed;left:8px;top:8px;z-index:99999;margin:0;padding:8px 10px;' +
    'max-height:64vh;max-width:92vw;overflow:auto;background:rgba(0,0,0,0.72);color:#9ff;' +
    'font:12px/1.55 ui-monospace,Consolas,monospace;border-radius:6px;pointer-events:none;white-space:pre;';
  document.body.appendChild(el);

  const f = (v) => (Number.isFinite(v) ? v.toFixed(1) : String(v));
  const tick = () => {
    const g = game || (typeof window !== 'undefined' ? window.__game : null);
    if (!g || !g.playerManager) { el.textContent = 'pdbg: 还没有 playerManager'; return; }
    const pm = g.playerManager;
    const rows = debugPlayerBodies(pm);
    const cam = g.camera ? g.camera.position : null;
    const head = 'pdbg  players=' + rows.length + '  localId=' + String(pm.localId).slice(0, 8) +
      '  cam=' + (cam ? [f(cam.x), f(cam.y), f(cam.z)].join(',') : '-') +
      '  shadow=' + !!(g.renderer && g.renderer.shadowMap && g.renderer.shadowMap.enabled);
    el.textContent = head + '\n' + rows.map((r) => JSON.stringify(r)).join('\n');
  };
  tick();
  const timer = setInterval(tick, 500);
  return () => { clearInterval(timer); el.remove(); };
}
