// 纯逻辑自检（不依赖浏览器/WebGL），覆盖本轮「手机端 UI 收口」：
//  1) 时钟：手机端媒体查询里不能再把 .idc-time 藏掉（上一次就是为了腾地方把时间一起 display:none，
//     结果手机上永远看不到世界时间）。
//  2) 算术对拍：校卡小牌宽度（PlayerHUD）与顶部按钮行的 left 起点（Game）是一对必须同步的常量——
//     改一个忘另一个，窄屏上那排按钮就会被挤出屏幕。这里直接把两侧数字抽出来验算。
//  3) 设置弹窗：modal（居中 + 遮罩 + Esc）、布局动作注入点、非 modal 的编辑器行为不受影响。
//  4) 手机布局模块：旧侧栏彻底移除、导出动作 API、编辑模式有顶部「完成」条。
// 用法：node ui-check.mjs
import { readFileSync } from 'node:fs';

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log('  FAIL ' + msg); } else { console.log('  ok   ' + msg); } };

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const hudSrc = read('./src/ui/PlayerHUD.js');
const setSrc = read('./src/ui/SettingsPanel.js');
const mobSrc = read('./src/ui/MobileLayout.js');
const mainSrc = read('./src/main.js');
const gameSrc = read('./src/core/Game.js');
const edSrc = read('./src/editor/EditorApp.js');

// 抽出 `header ... { ... }` 的完整块（花括号配对）
function extractBlock(src, header) {
  const at = src.indexOf(header);
  if (at < 0) return null;
  const open = src.indexOf('{', at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(open + 1, i); }
  }
  return null;
}

// ---------------------------------------------------------------------------
console.log('== 1. 手机端时钟 ==');
const coarse = extractBlock(hudSrc, '@media (pointer: coarse)');
ok(!!coarse, 'PlayerHUD 里有 @media (pointer: coarse) 块');
// 旧写法 `.idc-time, .idc-hint { display: none; }` 会被这条抓住
const hideRule = /\.idc-time[^{]*\{[^}]*display\s*:\s*none/.exec(coarse || '');
ok(!hideRule, '手机端不再隐藏 .idc-time（时钟可见）' + (hideRule ? ' -> ' + hideRule[0].replace(/\s+/g, ' ') : ''));
ok(/\.idc-hint[^{]*\{[^}]*display\s*:\s*none/.test(coarse || ''), '手机端仍隐藏「校卡」提示（只腾这两个字的地方）');
ok(/\.idc-mini-name\s*\{[^}]*flex:\s*1 1 auto/.test(coarse || ''), '手机端昵称自适应截断（时间不被挤掉）');
ok(/\.idc-time\s*\{[^}]*flex:\s*0 0 auto/.test(coarse || ''), '手机端时间为固定宽度（不被压缩）');
ok(/\.idc-time\s*\{[^}]*font-size/.test(coarse || ''), '手机端时间字号单独收过（窄屏放得下）');

// ---------------------------------------------------------------------------
console.log('== 2. 校卡宽度 ↔ 顶栏起点（算术对拍）==');
const wMatch = /\.idc-card\s*\{[^}]*?width:\s*(\d+)px/.exec(coarse || '');
const wCard = wMatch ? Number(wMatch[1]) : NaN;
ok(Number.isFinite(wCard), '能抽出手机端校卡宽度：' + (wMatch ? wMatch[1] + 'px' : '(未找到)'));

// Game 里顶部按钮行：left:172px;right:8px;top:12px  —— 与校卡同一个 top:12px
const topRow = /left:(\d+)px;right:8px;top:12px/.exec(gameSrc);
const leftRow = topRow ? Number(topRow[1]) : NaN;
ok(Number.isFinite(leftRow), '能抽出顶部按钮行的 left：' + (topRow ? topRow[1] + 'px' : '(未找到)'));

// 校卡贴 left:12px，按钮行要落在「12 + 宽 + 间距 4」上
const expectLeft = 12 + wCard + 4;
ok(leftRow === expectLeft,
  `顶部按钮行起点 = 12 + 校卡宽 + 4（期望 ${expectLeft}，实际 ${leftRow}）`);

// 窄屏兜底：按钮行可用宽度要容得下三个按钮（背包 / 设置 / 对战匹配）
// 每个按钮 padding 6+8*2=22 + 1px 边框*2，字号 12px 的中文按 12px/字估算
const BTN = [2, 2, 4].reduce((a, n) => a + n * 12 + 22 + 2, 0) + 6 * 2; // 两个 gap = 12
const narrow = 360 - leftRow - 8;
ok(narrow >= BTN, `360px 窄屏下按钮行还剩 ${narrow}px，够放三个按钮（约需 ${BTN}px）`);

// ---------------------------------------------------------------------------
console.log('== 3. 设置弹窗（modal）==');
ok(/const modal = !!opts\.modal/.test(setSrc), '支持 opts.modal');
ok(/const title = opts\.title/.test(setSrc), '支持 opts.title');
ok(/root\.className = 'gx-win' \+ \(modal \? ' gx-win--modal' : ''\)/.test(setSrc), 'modal 时有独立标记类');
ok(/root\.style\.display = modal \? 'flex' : 'block'/.test(setSrc), 'modal 用 flex 居中；非 modal 保持块级');
ok(/align-items:center;justify-content:center;padding:16px;/.test(setSrc), '遮罩用 flex 居中卡片');
ok(/if \(e\.target === root\) close\(\)/.test(setSrc), '点遮罩空白处关闭');
ok(/e\.key === 'Escape' && isOpen\(\)/.test(setSrc), 'Esc 关闭（且只在打开时生效）');
ok(/root\.addEventListener\('pointerdown', \(e\) => e\.stopPropagation\(\)\)/.test(setSrc),
  '遮罩掐断 pointerdown 冒泡（别让这一下穿透到游戏触发指针锁定）');
ok(/function setLayoutActions\(api\)/.test(setSrc), '导出 setLayoutActions');
ok(/layoutBox\.style\.display = layoutActions \? '' : 'none'/.test(setSrc), '没注入动作时布局区块保持隐藏');
{
  const at = setSrc.indexOf('btnAdjust.addEventListener');
  const seg = at >= 0 ? setSrc.slice(at, at + 260) : '';
  ok(/close\(\);\s*layoutActions\.onAdjust\(\)/.test(seg), '「调整位置」先收起弹窗再进拖拽模式（弹窗会盖住要摆的控件）');
}
ok(/isOpen,/.test(setSrc) && /toggle: \(\) => \{ if \(isOpen\(\)\) close\(\); else open\(\); \}/.test(setSrc),
  'open/close/toggle 统一走同一对函数（不再各自写一遍 display）');
// 编辑器：keep 右上浮层
{
  const at = edSrc.indexOf('createSettingsPanel(');
  const seg = at >= 0 ? edSrc.slice(at, at + 2500) : '';
  ok(seg.length > 0 && !/\bmodal\s*:/.test(seg), '编辑器未传 modal（仍是右上浮层，方便边调光照边看场景）');
  ok(!/setLayoutActions\(/.test(edSrc), '编辑器不注入布局动作（区块因此永不显示）');
}
ok(/modal: true,/.test(gameSrc) && /title: '设置'/.test(gameSrc), '游戏端：modal + 标题「设置」');

// ---------------------------------------------------------------------------
console.log('== 4. 手机布局模块收口 ==');
ok(!/\.ml-bar|\.ml-tab|\.ml-panel|\.ml-btn/.test(mobSrc), '旧侧栏（ml-bar/ml-tab/ml-panel/ml-btn）已彻底移除');
ok(!/textContent = '布局'/.test(mobSrc), '不再有「布局」页签');
ok(/if \(!coarse\) return null;/.test(mobSrc), '非触屏返回 null（桌面端不会出现那一组按钮）');
ok(/return \{\s*isEditing:/.test(mobSrc), '导出 isEditing');
ok(/toggleEdit: \(\) => \{ if \(editing\) exit\(\); else enter\(\); return editing; \}/.test(mobSrc), '导出 toggleEdit（进出编辑模式）');
ok(/\bcheck,/.test(mobSrc) && /\breset,/.test(mobSrc), '导出 check / reset');
ok(/\.ml-edit-bar\{/.test(mobSrc), '编辑模式有顶部提示条样式');
ok(/done\.addEventListener\('click', \(\) => exit\(\)\)/.test(mobSrc), '「完成」退出编辑模式');
ok(/bar\.addEventListener\('pointerdown', \(e\) => e\.stopPropagation\(\)\)/.test(mobSrc),
  '编辑条吞掉 pointerdown（右侧半屏是视角拖动区，别误转视角）');
ok(/z-index:9700/.test(mobSrc) && /z-index:9701/.test(mobSrc), '编辑条 / 提示气泡的层级高过顶部按钮行（9500）');
// 编辑模式不再依赖侧栏来收口
ok(!/setPanelOpen/.test(mobSrc), '不再操作侧栏开合');

// ---------------------------------------------------------------------------
console.log('== 5. 接线（main.js）==');
ok(/const layoutApi = initMobileLayout\(\)/.test(mainSrc), 'main 接住 initMobileLayout 的返回值');
ok(/game\.settingsPanel && game\.settingsPanel\.setLayoutActions/.test(mainSrc), 'main 先判空再注入（老页面缓存 / 未接线也不炸）');
ok(/onAdjust: \(\) => layoutApi\.toggleEdit\(\)/.test(mainSrc), 'onAdjust → toggleEdit');
ok(/onCheck: \(\) => layoutApi\.check\(\)/.test(mainSrc), 'onCheck → check');
ok(/onReset: \(\) => layoutApi\.reset\(\)/.test(mainSrc), 'onReset → reset');

// ---------------------------------------------------------------------------
console.log('== 6. 联动：Game 里 coarse 只判一次 ==');
{
  // 之前 _createTopButtons 与构造函数各判一份 matchMedia，改一边容易漏另一边
  const n = (gameSrc.match(/matchMedia\('\(pointer: coarse\)'\)/g) || []).length;
  ok(n === 1, `Game.js 里 (pointer: coarse) 只判一次（实际 ${n} 次）`);
  ok(/this\._coarsePointer = coarsePointer;/.test(gameSrc), '判定结果落在实例上供各处复用');
  ok(/const coarse = !!this\._coarsePointer;/.test(gameSrc), '_createTopButtons 复用同一份判定');
}

console.log(fails === 0 ? '\nPASS 全部通过' : `\nFAIL ${fails} 条未通过`);
process.exit(fails === 0 ? 0 : 1);
