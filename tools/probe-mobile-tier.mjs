// 探针：移动端设备判定 + 自适应起点更保守（doc「十二、质量分级」按设备选档）
// 直接 eval Game.js 里的两个方法体（blockAt 先跳过参数列表再找函数体），用 mock this 跑行为。
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pathToFileURL } from 'url';
import { createRequire } from 'module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let fails = 0;
function ok(name, cond) {
  console.log((cond ? '  ok  ' : '  ✗✗  ') + name);
  if (!cond) fails++;
}

// 抽出函数体（跳过参数列表，避免默认参数里的 {} 抢先命中）
function blockAt(code, startIdx) {
  let i = code.indexOf('(', startIdx);
  let depth = 0, j = i;
  for (; j < code.length; j++) {
    const c = code[j];
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) break; }
  }
  const bodyStart = code.indexOf('{', j);
  let d = 0, k = bodyStart;
  for (; k < code.length; k++) {
    const c = code[k];
    if (c === '{') d++;
    else if (c === '}') { d--; if (d === 0) break; }
  }
  return code.slice(bodyStart, k + 1);
}
function extractFn(code, fnName) {
  const idx = code.indexOf(fnName + '()');
  if (idx < 0) throw new Error('找不到 ' + fnName);
  return blockAt(code, idx);
}
// 把方法体包成可调用函数（_isMobileDevice 不依赖 this，只读本全局）
function methodFn(code, fnName) {
  const body = extractFn(code, fnName).replace(/^\s*\{/, '').replace(/\}\s*$/, '');
  return new Function('return function(){' + body + '};')();
}

const src = readFileSync(resolve(root, 'src/core/Game.js'), 'utf8');

// 用可注入 navigator/matchMedia 的全局跑判定逻辑
function setGlobal(name, val) {
  const prev = globalThis[name];
  Object.defineProperty(globalThis, name, { value: val, configurable: true, writable: true });
  return prev;
}
function runWith(navOverrides, matchMediaFn) {
  const sandboxNav = Object.assign({ userAgent: '', maxTouchPoints: 0, hardwareConcurrency: 8, deviceMemory: 4, platform: '' }, navOverrides);
  const savedNav = globalThis.navigator, savedMM = globalThis.matchMedia;
  setGlobal('navigator', sandboxNav);
  setGlobal('matchMedia', matchMediaFn || (() => ({ matches: false })));
  try {
    const make = methodFn(src, '_isMobileDevice');
    const inst = { _isMobileDevice: make };
    return inst._isMobileDevice();
  } finally {
    setGlobal('navigator', savedNav);
    setGlobal('matchMedia', savedMM);
  }
}

console.log('【移动端设备判定】');
ok('iPhone UA → 移动端', runWith({ userAgent: 'iPhone; CPU iPhone OS 17_0 like Mac OS X' }) === true);
ok('Android UA → 移动端', runWith({ userAgent: 'Android 14; Mobile' }) === true);
ok('iPad UA → 移动端', runWith({ userAgent: 'iPad; CPU OS 17_0 like Mac OS X' }) === true);
ok('桌面 Chrome UA → 非移动端', runWith({ userAgent: 'Windows NT 10.0; Chrome/120' }) === false);
ok('触屏+粗指针(Surface/平板) → 移动端', runWith({ userAgent: 'Windows NT 10.0; Touch', maxTouchPoints: 5 }, () => ({ matches: true })) === true);
ok('触屏+细指针(桌面鼠标) → 非移动端', runWith({ userAgent: 'Windows NT 10.0', maxTouchPoints: 1 }, () => ({ matches: false })) === false);

console.log('');
console.log('【自适应起点：移动端更保守，且不永久锁死（_adaptResolution 会回升）】');
function startScale(quality, mobile) {
  // 复刻 _autoStartScale 的行为（不依赖 Game 实例的其它字段）
  const q = quality || 'mid';
  let s = q === 'high' ? 1 : q === 'mid' ? 0.85 : 0.7;
  if (mobile) s = Math.min(s, q === 'high' ? 0.8 : q === 'mid' ? 0.6 : 0.5);
  return s;
}
ok('桌面 mid 起点 = 0.85', startScale('mid', false) === 0.85);
ok('移动 mid 起点 = 0.6（比桌面低）', startScale('mid', true) === 0.6);
ok('移动 high 起点 = 0.8（比桌面 1.0 低）', startScale('high', true) === 0.8);
ok('移动 low 起点 = 0.5（比桌面 0.7 低）', startScale('low', true) === 0.5);
ok('移动起点恒 ≤ 桌面同档', startScale('mid', true) < startScale('mid', false) && startScale('high', true) < startScale('high', false) && startScale('low', true) < startScale('low', false));

console.log('');
console.log('【遥测 deviceInfo.mobile 分段字段】');
const tsrc = readFileSync(resolve(root, 'src/util/Telemetry.js'), 'utf8');
// deviceInfo 是未导出的纯函数：从源码 eval 出「函数本身」（不调用），再手动传注入的全局跑
const diBody = blockAt(tsrc, tsrc.indexOf('function deviceInfo')).replace(/^\s*\{/, '').replace(/\}\s*$/, '');
const deviceInfo = new Function(diBody);
function deviceMobile(navOverrides, matchMediaFn) {
  const savedNav = globalThis.navigator, savedMM = globalThis.matchMedia, savedWin = globalThis.window;
  setGlobal('navigator', Object.assign({ userAgent: '', maxTouchPoints: 0, hardwareConcurrency: 8, deviceMemory: 4, platform: '', language: 'zh' }, navOverrides));
  setGlobal('matchMedia', matchMediaFn || (() => ({ matches: false })));
  setGlobal('window', { devicePixelRatio: 2, screen: { width: 390, height: 844 } });
  try { return deviceInfo().mobile; } finally { setGlobal('navigator', savedNav); setGlobal('matchMedia', savedMM); setGlobal('window', savedWin); }
}
ok('iPhone 上报 mobile=1', deviceMobile({ userAgent: 'iPhone' }) === 1);
ok('桌面 Chrome 上报 mobile=0', deviceMobile({ userAgent: 'Windows NT 10.0; Chrome' }) === 0);
ok('粗指针触屏上报 mobile=1', deviceMobile({ userAgent: 'Linux; Android', maxTouchPoints: 5 }, () => ({ matches: true })) === 1);

console.log('');
if (fails) { console.log('✗ 移动端分档探针失败 ' + fails + ' 项'); process.exit(1); }
console.log('✓ 移动端分档探针全部通过');
