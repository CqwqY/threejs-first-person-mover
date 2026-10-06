// 自检：一键隐藏 UI（H 键）—— 接线 / body 类 / CSS 规则 / 加载屏豁免
//
// 关键正确性：
//   ① 隐藏靠「body 加类 + 一条 CSS」而非维护元素清单（本项目 UI 散落几十处）——
//      断言 CSS 规则确实隐藏 body 直属非 #app 元素、且**豁免** .fpm-loading 与提示条；
//   ② canvas(#app) 绝不能被藏；
//   ③ 用 display 而非摘 DOM（摘了各模块持有的引用会失效）；
//   ④ H 键接线（Game 里 installUiHotkey(Config.HIDE_UI_KEY)）存在，且打字时不触发。
//
// 跑：node tools/probe-ui-hide.mjs（退出码非 0 = 有回归）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let fails = 0;
function ok(cond, name, extra = '') {
  if (cond) console.log('  ok    ' + name + (extra ? ' — ' + extra : ''));
  else { fails++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}
// 花括号配对抽函数体（不用 slice(indexOf) —— 会扫到文件末尾把后续函数也断言进去）。
// ⚠ 必须先跳过**参数列表**：`function f(opts = {}) {` 里参数中的 `{}` 会让「第一个 {」定位错
//   （本项目已踩过：installUiHotkey 的 opts = {} 被当成了函数体起点）。
function blockAt(src, decl) {
  const i = src.indexOf(decl);
  if (i < 0) return '';
  // 从 decl 起找「参数列表的右括号」，其后的第一个 { 才是函数体起点
  const parenOpen = src.indexOf('(', i);
  let pDepth = 0, bodyOpen = -1;
  for (let j = parenOpen; j < src.length; j++) {
    const c = src[j];
    if (c === '(') pDepth++;
    else if (c === ')') { pDepth--; if (pDepth === 0) { bodyOpen = src.indexOf('{', j); break; } }
  }
  if (bodyOpen < 0) return '';
  let depth = 0;
  for (let j = bodyOpen; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(i, j + 1); }
  }
  return src.slice(i);
}

const uiSrc = read('src/util/UiVisibility.js');
const gameSrc = read('src/core/Game.js');
const cfgSrc = read('src/config.js');

console.log('\n【1】CSS 规则：隐藏 body 直属 UI、豁免 #app / 加载屏 / 提示条');
{
  ok(/HIDE_CLASS\s*=\s*'kui-hide-ui'/.test(uiSrc), 'HIDE_CLASS = kui-hide-ui');
  // 规则本体：.kui-hide-ui > :not(#app):not(.fpm-loading):not(.fpm-uihide-tip){display:none!important}
  ok(/\.kui-hide-ui\s*>\s*:not\(#app\)/.test(uiSrc), '规则隐藏 body 直属、排除 #app（canvas 不能藏）');
  ok(/not\(\.fpm-loading\)/.test(uiSrc), '豁免加载屏（加载期按 H 不会让玩家以为卡死）');
  ok(/not\(\.fpm-uihide-tip\)/.test(uiSrc), '豁免「UI 已隐藏」提示条（否则不知按什么恢复）');
  ok(/display:none!important/.test(uiSrc), '用 !important 压过各 UI 自带的 inline display');
}

console.log('\n【2】实现方式：加类 + 不摘 DOM（守住各模块的元素引用）');
{
  const setBody = blockAt(uiSrc, 'export function setUiHidden');
  ok(setBody.includes('classList.toggle'), 'setUiHidden 用 classList.toggle 切换 body 类');
  ok(setBody.includes('HIDE_CLASS'), 'toggle 的目标是 HIDE_CLASS');
  ok(!/\.remove\(\)/.test(setBody) && !/appendChild/.test(setBody), 'setUiHidden 不动 DOM 结构（不摘/不重建元素）');
  ok(/export function toggleUiHidden/.test(uiSrc), '导出 toggleUiHidden');
  ok(/export function isUiHidden/.test(uiSrc), '导出 isUiHidden');
}

console.log('\n【3】热键：接线 + 打字不误触 + 组合键不拦');
{
  const hk = blockAt(uiSrc, 'export function installUiHotkey');
  ok(hk.includes('addEventListener'), 'installUiHotkey 注册 keydown');
  ok(hk.includes('e.code !== code'), '按 e.code（不是 e.key）判键');
  ok(/isEditable|contentEditable/.test(hk), '打字时（INPUT/TEXTAREA/contentEditable）不响应');
  ok(/ctrlKey/.test(hk) && /metaKey/.test(hk) && /altKey/.test(hk), 'Ctrl/Cmd/Alt 组合键不拦');
  ok(hk.includes('preventDefault'), '触发时 preventDefault');
  ok(/removeEventListener/.test(hk), '返回卸载函数（removeEventListener）');
  ok(/onToggle/.test(hk), '支持 onToggle 回调（供 toast）');
}

console.log('\n【4】config：HIDE_UI_KEY 已定义且是 KeyH');
{
  ok(/HIDE_UI_KEY\s*:\s*'KeyH'/.test(cfgSrc), "Config.HIDE_UI_KEY = 'KeyH'");
}

console.log('\n【5】Game 接线：installUiHotkey(Config.HIDE_UI_KEY) 且带 toast');
{
  ok(/import\s*\{[^}]*installUiHotkey[^}]*\}\s*from\s*'\.\.\/util\/UiVisibility\.js'/.test(gameSrc), 'Game.js 引入了 installUiHotkey');
  const wire = gameSrc.match(/installUiHotkey\([\s\S]*?\);/);
  ok(!!wire, 'Game.js 调用了 installUiHotkey');
  if (wire) {
    ok(wire[0].includes('Config.HIDE_UI_KEY'), '传入 Config.HIDE_UI_KEY');
    ok(/onToggle/.test(wire[0]), '带 onToggle（toast 提示）');
  }
  // 不能把 canvas 容器藏了：断言没有任何代码对 #app 设 display:none
  ok(!/getElementById\('app'\)[\s\S]{0,80}display\s*=\s*'none'/.test(gameSrc), '没有任何地方把 #app 设成 display:none');
}

console.log('\n【6】样式幂等（重复安装不重复插 style）');
{
  const es = blockAt(uiSrc, 'function ensureStyle');
  ok(es.includes('getElementById(STYLE_ID)'), 'ensureStyle 先查 STYLE_ID 再插（幂等）');
  ok(es.includes('STYLE_ID'), 'STYLE_ID 常量存在');
}

console.log('');
if (fails) { console.log('✗ UI 隐藏探针失败 ' + fails + ' 项'); process.exit(1); }
console.log('✓ UI 隐藏探针全部通过');
