// 职责：物品图标（背包/建造工具等用到）。**手绘 SVG**，不用 emoji。
// 与 icons.js（Kenney Board Game Icons，脚本自动生成）同一套渲染约定：
//   viewBox = 56×56（Kenney 标准，中心在原点），填充/描边用 currentColor（给容器设 color 即自动适配）。
// 这里只放“物品专用”图标（Kenney 那套只有通用语义，没有锤子/桌椅）；handmade，手改无妨。
export const ITEM_ICONS = {
  // 建造锤
  hammer: { viewBox: '-28 -28 56 56', body: `
    <rect x="-3.5" y="-8" width="7" height="32" rx="2.5" fill="currentColor"/>
    <rect x="-17" y="-24" width="34" height="12" rx="3" fill="currentColor"/>
  ` },
  // 棍子：一根斜放的圆头棒
  club: { viewBox: '-28 -28 56 56', body: `
    <rect x="-4.5" y="-24" width="9" height="48" rx="4.5" fill="currentColor" transform="rotate(30)"/>
  ` },
  // 黑洞：外圈 + 中心实心
  blackhole: { viewBox: '-28 -28 56 56', body: `
    <circle cx="0" cy="0" r="22" fill="none" stroke="currentColor" stroke-width="4"/>
    <circle cx="0" cy="0" r="10" fill="currentColor"/>
  ` },
  // 捉迷藏玩具：虚线方块（变色方块）
  hide: { viewBox: '-28 -28 56 56', body: `
    <rect x="-20" y="-20" width="40" height="40" rx="5" fill="none" stroke="currentColor" stroke-width="4.5" stroke-dasharray="8 7"/>
  ` },
  // 加特林：三根枪管 + 机匣
  gatling: { viewBox: '-28 -28 56 56', body: `
    <rect x="-15" y="-24" width="7" height="30" rx="3" fill="currentColor"/>
    <rect x="-3.5" y="-24" width="7" height="30" rx="3" fill="currentColor"/>
    <rect x="8" y="-24" width="7" height="30" rx="3" fill="currentColor"/>
    <rect x="-19" y="6" width="38" height="11" rx="3" fill="currentColor"/>
  ` },
  // 控制枪：摇杆（底座 + 杆 + 球头）
  joystick: { viewBox: '-28 -28 56 56', body: `
    <circle cx="0" cy="7" r="15" fill="none" stroke="currentColor" stroke-width="4"/>
    <rect x="-3" y="-26" width="6" height="20" rx="3" fill="currentColor"/>
    <circle cx="0" cy="-26" r="7" fill="currentColor"/>
  ` },
  // 抓钩：带环的钩子
  hook: { viewBox: '-28 -28 56 56', body: `
    <path fill="none" stroke="currentColor" stroke-width="4.5" stroke-linecap="round" d="M3 -22 L3 2 Q3 16 -11 16 Q-22 16 -22 6"/>
    <circle cx="3" cy="-23" r="5" fill="none" stroke="currentColor" stroke-width="4"/>
  ` },
  // 椅子
  chair: { viewBox: '-28 -28 56 56', body: `
    <rect x="-15" y="-24" width="30" height="6" rx="2" fill="currentColor"/>
    <rect x="-15" y="-24" width="5" height="30" rx="2" fill="currentColor"/>
    <rect x="-15" y="0" width="30" height="6" rx="2" fill="currentColor"/>
    <rect x="-15" y="6" width="5" height="18" rx="2" fill="currentColor"/>
    <rect x="10" y="6" width="5" height="18" rx="2" fill="currentColor"/>
  ` },
  // 桌子
  table: { viewBox: '-28 -28 56 56', body: `
    <rect x="-24" y="-7" width="48" height="7" rx="2" fill="currentColor"/>
    <rect x="-20" y="0" width="6" height="24" rx="2" fill="currentColor"/>
    <rect x="14" y="0" width="6" height="24" rx="2" fill="currentColor"/>
  ` },
  // 沙发
  sofa: { viewBox: '-28 -28 56 56', body: `
    <rect x="-22" y="-16" width="44" height="16" rx="5" fill="currentColor"/>
    <rect x="-24" y="-4" width="48" height="22" rx="6" fill="currentColor"/>
    <rect x="-28" y="-8" width="8" height="22" rx="4" fill="currentColor"/>
    <rect x="20" y="-8" width="8" height="22" rx="4" fill="currentColor"/>
  ` },
  // 柜子
  cabinet: { viewBox: '-28 -28 56 56', body: `
    <rect x="-18" y="-24" width="36" height="48" rx="4" fill="none" stroke="currentColor" stroke-width="4.5"/>
    <rect x="-2" y="-24" width="4" height="48" fill="currentColor"/>
    <circle cx="-8" cy="-2" r="2.6" fill="currentColor"/>
    <circle cx="8" cy="-2" r="2.6" fill="currentColor"/>
  ` },
  // 灯
  lamp: { viewBox: '-28 -28 56 56', body: `
    <path fill="currentColor" d="M-14 -20 L14 -20 L8 0 L-8 0 Z"/>
    <rect x="-2.5" y="0" width="5" height="14" rx="2" fill="currentColor"/>
    <rect x="-12" y="14" width="24" height="6" rx="3" fill="currentColor"/>
  ` },
  // 兜底：问号方块
  box: { viewBox: '-28 -28 56 56', body: `
    <rect x="-18" y="-18" width="36" height="36" rx="6" fill="none" stroke="currentColor" stroke-width="4.5"/>
  ` },
};

// 生成内联 SVG 字符串（与 icons.js 的 icon() 同款：size 用 px 或 em，跟随容器缩放）
export function itemIconSvg(name, { size = '1.6em' } = {}) {
  const d = ITEM_ICONS[name];
  if (!d) return '';
  return `<svg viewBox="${d.viewBox}" width="${size}" height="${size}" ` +
    `style="display:block;flex:0 0 auto" aria-hidden="true" focusable="false">${d.body}</svg>`;
}

// 目录项 → 图标 key。商店有完整 item，背包只存名字（传 {name} 即可），两边共用这一套映射。
export function itemIconKeyFor(item) {
  if (!item) return 'box';
  if (item.kind === 'building') {
    const n = item.name || '';
    if (/椅|凳/.test(n)) return 'chair';
    if (/桌|台|几/.test(n)) return 'table';
    if (/沙发|床|垫/.test(n)) return 'sofa';
    if (/柜|架|箱/.test(n)) return 'cabinet';
    if (/灯/.test(n)) return 'lamp';
    return 'box';
  }
  const k = item.effect ? item.effect.k : '';
  const byKind = {
    club: 'club', blackhole: 'blackhole', hide: 'hide', gatling: 'gatling',
    control: 'joystick', grapple: 'hook', hammer: 'hammer',
  };
  return byKind[k] || 'box';
}
