// 纯逻辑自检（不依赖浏览器/WebGL），覆盖本轮「手机端 UI 收口」：
//  1) 时钟：手机端媒体查询里不能再把 .idc-time 藏掉（上一次就是为了腾地方把时间一起 display:none，
//     结果手机上永远看不到世界时间）。
//  2) 算术对拍：校卡小牌宽度（PlayerHUD）与顶部按钮行的 left 起点（Game）是一对必须同步的常量——
//     改一个忘另一个，窄屏上那排按钮就会被挤出屏幕。这里直接把两侧数字抽出来验算。
//  3) 设置弹窗：modal（居中 + 遮罩 + Esc）、布局动作注入点、非 modal 的编辑器行为不受影响。
//  4) 手机布局模块：旧侧栏彻底移除、导出动作 API、编辑模式有顶部「完成」条。
// 用法：node ui-check.mjs
import { readFileSync } from 'node:fs';
import { Config } from './src/config.js';

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log('  FAIL ' + msg); } else { console.log('  ok   ' + msg); } };

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const hudSrc = read('./src/ui/PlayerHUD.js');
const setSrc = read('./src/ui/SettingsPanel.js');
const mobSrc = read('./src/ui/MobileLayout.js');
const layoutSrc = read('./src/ui/layout.js');
const skillSrc = read('./src/ui/SkillSlots.js');
const mainSrc = read('./src/main.js');
const gameSrc = read('./src/core/Game.js');
const themeSrc = read('./src/ui/theme.js');
const mcCtlSrc = read('./src/ui/MobileControls.js');
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

// 两侧的锚点都写成 calc(env(safe-area-inset-*) + Npx)：横屏时刘海在左右两侧，
// 不减掉 inset 的话校卡会被切、最右边的按钮会被顶出屏幕。这里把「基础值」抽出来验算，
// 并确认 inset 确实挂上了 —— 少了任何一处，横屏真机上才会露馅，纯逻辑测不出来。
const idcBase = /\.idc\s*\{[^}]*?left:\s*calc\(env\(safe-area-inset-left,\s*0px\)\s*\+\s*(\d+)px\)/.exec(coarse || '');
const idcLeft = idcBase ? Number(idcBase[1]) : NaN;
ok(Number.isFinite(idcLeft), '能抽出校卡 left 的安全区基准值：' + (idcBase ? idcBase[1] + 'px' : '(未找到)'));
ok(idcLeft === 12, `校卡左边距基准仍是 12px（实际 ${idcLeft}）`);

// Game 里顶部按钮行：left/right/top 三个基础值都跟在 env() 后面
const rowRe = /left:calc\(env\(safe-area-inset-left,\s*0px\)\s*\+\s*(\d+)px\);\s*' \+\s*'right:calc\(env\(safe-area-inset-right,\s*0px\)\s*\+\s*(\d+)px\);\s*' \+\s*'top:calc\(env\(safe-area-inset-top,\s*0px\)\s*\+\s*(\d+)px\)/.exec(gameSrc);
const leftRow = rowRe ? Number(rowRe[1]) : NaN;
const rightRow = rowRe ? Number(rowRe[2]) : NaN;
const topRowV = rowRe ? Number(rowRe[3]) : NaN;
ok(Number.isFinite(leftRow), '能抽出顶部按钮行的 left 基准值：' + (rowRe ? rowRe[1] + 'px' : '(未找到)'));
ok(rightRow === 8, `按钮行右边距基准仍是 8px（实际 ${rightRow}）`);
ok(topRowV === 12, `按钮行顶部基准与校卡同高 12px（实际 ${topRowV}）`);

// 校卡贴 left(safe + 12)，按钮行要落在「同一基准 + 宽 + 间距 4」上
const expectLeft = idcLeft + wCard + 4;
ok(leftRow === expectLeft,
  `顶部按钮行起点 = 校卡 left + 校卡宽 + 4（期望 ${expectLeft}，实际 ${leftRow}）`);

// 窄屏兜底：按钮行可用宽度要容得下三个按钮（背包 / 设置 / 对战匹配）。
// 按钮是「图标键 36px + 下方文字」竖排一组：宽度 = max(图标键, 字数 × 11px) × 1.1 余量，
// 再加两个 gap 8px。数都来自样式（theme.js 的 .kui-iconbtn / .kui-topbtn > b、Game 的 gap:8px），
// 下面顺手对拍这些样式没被人改掉，免得估算失真。
// 顶部现在是**四个**按钮（背包 / 设置 / 对战匹配 / 全屏）。
// 估算必须用极窄屏（≤380px）收紧后的数字 —— 那才是放不下的那种屏幕：
// 图标键 32、标签 10px、间距 4（见 theme.js 的 @media (pointer: coarse) and (max-width: 380px)）。
// 「退出全屏」是 4 字，所以全屏按钮按 4 字算，不能按建按钮时的「全屏」2 字算。
const ICONBTN = 32, LABEL_PX = 10, TOPGAP = 4, BTN_CHARS = [2, 2, 4, 4];
const wBtn = (n) => Math.max(ICONBTN, n * LABEL_PX * 1.1);
const needW = BTN_CHARS.reduce((a, n) => a + wBtn(n), 0) + TOPGAP * (BTN_CHARS.length - 1);
const narrow = 360 - leftRow - 8;
ok(narrow >= needW,
  `360px 窄屏下按钮行还剩 ${narrow}px，够放四个图标按钮（约需 ${Math.round(needW)}px）`);
ok(/font:\s*600 11px\/1\.2 var\(--kui-font\)/.test(themeSrc), '.kui-topbtn > b 默认仍是 11px 字号');
ok(/\.kui-toprow\s*\{[^}]*gap:\s*8px/.test(themeSrc),
  '手机端按钮行默认 gap 8px（写在 class 里 —— 行内样式压不过极窄屏的媒体查询）');
const narrowMq = /@media \(pointer: coarse\) and \(max-width: 380px\)\s*\{([\s\S]*?)\n    \}/.exec(themeSrc);
ok(!!narrowMq, 'theme.js 有极窄屏（≤380px）收紧规则');
if (narrowMq) {
  ok(/\.kui-toprow\s*\{\s*gap:\s*4px/.test(narrowMq[1]), '极窄屏按钮行 gap 收到 4px');
  ok(/\.kui-iconbtn\s*\{\s*width:\s*32px/.test(narrowMq[1]), '极窄屏图标键收到 32px');
  ok(/\.kui-topbtn > b\s*\{\s*font-size:\s*10px/.test(narrowMq[1]), '极窄屏标签字号收到 10px');
}
// 只看按钮行那一段（Game.js 里别处也有内联的 display:flex;gap:8px，不能全局否定）
const rowAt = gameSrc.indexOf("row.className = 'kui-toprow'");
const rowSeg = rowAt >= 0 ? gameSrc.slice(rowAt, rowAt + 420) : '';
ok(rowSeg && !/display:flex/.test(rowSeg) && !/gap:/.test(rowSeg),
  '按钮行排布不再写进行内样式（行内会压过上面这条媒体查询）');
ok(/row\.className = 'kui-toprow'/.test(gameSrc), '手机端按钮行挂 .kui-toprow');

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
  // 触屏判定已收拢进 src/util/isCoarse.js 的 isCoarsePointer()（多信号 OR + 主指针兜底），
  // Game 里不该再有裸 matchMedia —— 早先那条「裸 matchMedia 恰好 1 次」的断言已经过时，
  // 现在要查的是「判定只调一次封装、结果落在实例上、各处复用」。
  // 只数「真正的调用」：import 行与注释里也会出现这个名字，得剔掉
  const n = (gameSrc
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|import\b)/.test(l)) // 注释与 import 不算调用
    .join('\n')
    .match(/isCoarsePointer\(\)/g) || []).length;
  ok(n === 1, `Game.js 里 isCoarsePointer() 只调一次（实际 ${n} 次）`);
  ok(!/matchMedia\('\(pointer: coarse\)'\)/.test(gameSrc),
    'Game.js 里没有裸的 matchMedia(\'(pointer: coarse)\')（判定已收拢进 isCoarse.js）');
  ok(/this\._coarsePointer = coarsePointer;/.test(gameSrc), '判定结果落在实例上供各处复用');
  ok(/const coarse = !!this\._coarsePointer;/.test(gameSrc), '_createTopButtons 复用同一份判定');
}

// ---------------------------------------------------------------------------
console.log('== 7. 横屏触控区（无缝 + 让开安全区）==');
// 两个触控区必须首尾相接：曾经是 44vw + 50vw，中间永远留着 6vw 的缝
// （竖屏 360px 时 21.6px、横屏 780px 时 46.8px）。那条缝两头都摸不到 ——
// 手指落进去「既不走也不转视角」，是横屏最明显的手感问题。
const widthVw = (sel) => {
  const m = new RegExp('\\.' + sel + '\\{[^}]*?width:\\s*(\\d+)vw').exec(mcCtlSrc);
  return m ? Number(m[1]) : NaN;
};
const wLeft = widthVw('mc-left');
const wRight = widthVw('mc-right');
ok(Number.isFinite(wLeft) && Number.isFinite(wRight), `能抽出两个触控区宽度：左 ${wLeft}vw / 右 ${wRight}vw`);
ok(wLeft + wRight === 100, `左右触控区无缝相接（${wLeft}vw + ${wRight}vw = ${wLeft + wRight}vw，必须等于 100）`);

const landCss = extractBlock(mcCtlSrc, '@media (orientation: landscape)');
ok(!!landCss, 'MobileControls 里有横屏专用媒体查询');
ok(/\.mc-left\{[^}]*height:\s*var\(--app-vh[^}]*min-height:\s*0/.test(landCss || ''),
  '横屏时移动区补满全高，并撤掉竖屏那条 min-height:200px');
ok(/\.mc-joy\{[^}]*left:calc\(env\(safe-area-inset-left/.test(landCss || ''),
  '横屏摇杆让开左侧安全区（刘海在侧边）');
ok(/\.mc-jump\{[^}]*right:calc\(env\(safe-area-inset-right/.test(landCss || ''),
  '横屏跳跃键让开右侧安全区');
// 横屏块只该改位置：摇杆/跳跃键的尺寸由 MobileLayout 用 vmin 的 clamp 统一管，
// 而 ChatBox 的聊天栏高度公式直接依赖那组 clamp —— 在这里再写一套 px 尺寸会静默错位。
ok(!/\.mc-(joy|jump)\{[^}]*(width|height):\s*\d+px/.test(landCss || ''),
  '横屏块不重复定义摇杆/跳跃键的尺寸（尺寸只归 MobileLayout 的 clamp 管）');
ok(/clamp\(92px,\s*26vmin,\s*124px\)/.test(mobSrc), '摇杆尺寸仍是 clamp(92px,26vmin,124px)');
ok(/clamp\(56px,\s*15vmin,\s*78px\)/.test(mobSrc), '跳跃键尺寸仍是 clamp(56px,15vmin,78px)');

// ---- 拖完位置必须立刻生效，不能要刷新 ----
// relayout() 有「视口尺寸变了才重排」的滞回门槛（防地址栏小幅抖动），
// 而拖拽保存只写 localStorage、屏幕尺寸没变 → 门槛不放行 → applyLayout 不跑、
// 技能槽的 onRelayout 回调也不触发 → 表现为「位置改了要刷新才生效」。
// 凡是「刚改了记录但尺寸没动」的场景必须走 forceRelayout()。
ok(/export function forceRelayout\(\)/.test(layoutSrc), 'layout.js 导出 forceRelayout()');
ok(/forceRelayout\(\)/.test(mobSrc), 'MobileLayout 退出编辑模式时调用 forceRelayout()');
ok(!/^\s*relayout\(\);.*退出时补跑/ms.test(mobSrc),
  'MobileLayout 不再用无参 relayout() 收尾（那会被尺寸门槛挡掉）');
ok(/forceRelayout\(\)/.test(layoutSrc.replace(/export function forceRelayout\(\)[\s\S]*?\n\}/, '')),
  'resetLayout 也走 forceRelayout()（重置同样不改变视口尺寸）');
// 技能槽必须订阅重排，否则按钮不会贴到保存的位置
ok(/onRelayout\(\(\)\s*=>\s*\{[^}]*readSavedPos\(\)[^}]*layoutMobile\(\)/s.test(skillSrc),
  '技能槽订阅 onRelayout，读保存位置后重排（否则拖完位置不动）');

// ---- 加特林过热：开着枪不能同时降温 ----
// 曾经的 bug：_updateGatling 每帧先无条件散热再开火，10 发/秒 × 3.5 的升温被散热吃掉大半，
// 净升温只剩 7/秒 → 要扫 14 秒才过热，玩家体感就是「一直打也不会过热、热量条几乎不动」。
// 这里用算术 + 源码顺序两道闸钉住：散热只能发生在「没在开火」的时候。
const perSec = Config.GATLING_HEAT_PER_SHOT / Config.GATLING_INTERVAL;
ok(perSec > Config.GATLING_COOL_RATE,
  `扫射净升温为正（升温 ${perSec}/秒 > 散热 ${Config.GATLING_COOL_RATE}/秒）`);
const overheatSec = 100 / perSec;
ok(overheatSec > 1.5 && overheatSec < 8,
  `持续扫射到过热的耗时合理（${overheatSec.toFixed(1)} 秒，不是几十秒也秒不过热）`);
ok(Config.GATLING_COOL_DELAY > 0, '有停火散热延迟（点射不会一松手就把热量掉光）');
const gatBlock = extractBlock(gameSrc, '  _updateGatling(dt) {');
ok(!!gatBlock, '取到 _updateGatling 函数体');
ok(gatBlock && /fired \|\| holding/.test(gatBlock), '散热分支被「正在开火/扣着扳机」挡住');
ok(gatBlock && gatBlock.indexOf('const holding') < gatBlock.indexOf('GATLING_COOL_RATE'),
  '先判开火、后散热（顺序写反就变回边打边降温）');

console.log(fails === 0 ? '\nPASS 全部通过' : `\nFAIL ${fails} 条未通过`);
process.exit(fails === 0 ? 0 : 1);
