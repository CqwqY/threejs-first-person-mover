// 编辑器「导入 GLB 模型」自检（纯 Node，不依赖浏览器/WebGL）：
//  1) 从真实源码里抽出 asciiFileName / sanitizeName 两个函数，逐条验证：
//     上传用的文件名必须是纯 ASCII，且**经过服务端清洗后不变**（否则存进去、取不回来）。
//  2) 用真实的 http 服务端 + 真实 fetch 复现老写法（直接把 f.name 塞进请求头）的失败形态：
//     中文名会让 fetch **同步抛 TypeError、请求一条都发不出去**——这正是「Network 里什么都看不到」的原因。
//  3) 静态断言：源码里已经不再用原始文件名当请求头、不再静默吞异常、有大小预检与同源兜底。
// 用法：node editor-upload-check.mjs
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log('  FAIL ' + msg); } else { console.log('  ok   ' + msg); } };
const eq = (a, b, msg) => ok(a === b, msg + '（实际 ' + JSON.stringify(a) + '）');

const appSrc = readFileSync('./src/editor/EditorApp.js', 'utf8');
const srvSrc = readFileSync('./server-remote/index.js', 'utf8');

// 从源码里截出某个函数体（`function name(...) {` 起，按大括号配平到结尾），再交给 new Function 求值。
// 这样测的是线上真正会跑的那份实现，而不是脚本里抄一遍的副本。
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('源码里找不到函数 ' + name);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error('函数体没配平：' + name);
}
const asciiFileName = new Function(extractFn(appSrc, 'asciiFileName') + '; return asciiFileName;')();
const sanitizeName = new Function(extractFn(srvSrc, 'sanitizeName') + '; return sanitizeName;')();
// 服务端静态路由与上传用的是同一条清洗规则，取出来一起验
const routeClean = (n) => decodeURIComponent(n).replace(/[^a-zA-Z0-9._-]/g, '_');

console.log('== 1. 上传文件名必须是纯 ASCII 且经服务端清洗后不变 ==');
const cases = [
  'chair.glb', 'My Model.glb', 'a.b.glb', 'noext', 'x.gltf', '.glb',
  '椅子.glb', '沙发 01.glb', '日本語.gltf', '汽车模型.glb', '🎈.glb',
];
for (const raw of cases) {
  const out = asciiFileName(raw);
  const isAscii = /^[\x20-\x7e]+$/.test(out);          // 全部落在可打印 ASCII
  const noSpace = !/\s/.test(out);
  const hasExt = /\.(glb|gltf)$/i.test(out);
  const survives = sanitizeName(out) === out && routeClean(out) === out; // 服务端不会把它改掉
  let headerOk = true;
  try { new Headers({ 'x-filename': out }); } catch (e) { headerOk = false; }  // 构造请求头不抛错
  ok(isAscii && noSpace && hasExt && survives && headerOk,
    JSON.stringify(raw) + ' → ' + JSON.stringify(out)
    + (isAscii ? '' : ' [非 ASCII]') + (noSpace ? '' : ' [含空白]') + (hasExt ? '' : ' [缺扩展名]')
    + (survives ? '' : ' [被服务端改写]') + (headerOk ? '' : ' [请求头非法]'));
}
ok(asciiFileName('') === 'model.glb', '空名字兜底为 model.glb');
ok(asciiFileName('椅子.glb').endsWith('.glb'), '中文名仍保留 .glb 扩展名（服务端按扩展名判 MIME）');

console.log('== 2. 复现老写法的失败形态（请求发不出去）==');
// 起一个只记录「收到几次请求」的微型服务端，版本与线上 /api/upload 的契约一致
let hits = 0;
let gotName = '';
let gotLen = 0;
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/upload') {
    hits++;
    gotName = req.headers['x-filename'] || '';
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      gotLen = Buffer.concat(chunks).length;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, url: '/assets/import-' + Date.now() + '-' + sanitizeName(gotName) }));
    });
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;
const payload = new ArrayBuffer(4096);

// 老写法：headers: { 'x-filename': f.name }
let oldThrew = null;
try {
  await fetch(base + '/api/upload', { method: 'POST', headers: { 'x-filename': '椅子.glb' }, body: payload });
} catch (e) { oldThrew = e; }
ok(oldThrew !== null, '老写法（原始中文名进请求头）确实抛错：' + (oldThrew && oldThrew.name));
ok(hits === 0, '而且请求一条都没发出去（这就是 Network 面板里「没有上传」的原因，hits=' + hits + '）');
ok(/ByteString|Invalid value|invalid header/i.test(String(oldThrew && oldThrew.message)),
  '浏览器/Node 给的原因是「请求头值不是合法的 ByteString」而不是「接口没返回地址」');

// 新写法：headers: { 'x-filename': asciiFileName(f.name) }
const r2 = await fetch(base + '/api/upload', {
  method: 'POST', headers: { 'x-filename': asciiFileName('椅子.glb') }, body: payload,
});
const j2 = await r2.json();
ok(r2.ok && j2.ok && typeof j2.url === 'string', '新写法上传成功：' + JSON.stringify(j2.url));
eq(hits, 1, '服务端确实收到了这次请求');
eq(gotName, '__.glb', '服务端看到的是清洗后的 ASCII 名');
eq(routeClean(j2.url.split('/').pop()), j2.url.split('/').pop(), '返回的 URL 文件名能被静态路由原样取回（不会 404）');
eq(gotLen, 4096, '文件字节完整送达');
await new Promise((r) => server.close(r));

console.log('== 3. 源码静态断言 ==');
// 断言跑在**去掉注释**的源码上：否则注释里提到旧文案/旧写法也会让测试误判（这轮就踩过一次）
const appCode = appSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
ok(!/'x-filename': f\.name/.test(appCode), '不再把原始文件名直接当请求头（旧写法已移除）');
ok(/asciiFileName\(file\.name\)/.test(appCode), '上传时改用 asciiFileName(file.name)');
ok(!/catch \(e\) \{ assetUrl = ''; \}/.test(appCode), '不再用空 catch 吞掉上传异常');
ok(/请求未发出/.test(appCode), '区分「请求未发出」与「服务端返回错误」两类失败');
ok(/MAX_UPLOAD_BYTES/.test(appCode) && /f\.size > MAX_UPLOAD_BYTES/.test(appCode), '文件大小预检（超 64MB 给人话提示）');
ok(/SAME_ORIGIN_UPLOAD/.test(appCode) && /\[\.\.\.new Set\(\[UPLOAD_URL, SAME_ORIGIN_UPLOAD\]\)\]/.test(appCode),
  '线上后端失败时退回同源 /api/upload');
ok(!/未返回可用地址/.test(appCode), '误导性的「未返回可用地址」提示已删除');
ok(/reason: 'HTTP ' \+ r\.status/.test(appCode), '失败提示里带上真实的 HTTP 状态码与响应正文');
ok(/console\.(info|warn)\('\[编辑器\]/.test(appCode), '成功/失败都写 console，便于 F12 直接看');
ok(readFileSync('./editor.html', 'utf8').includes('id="fileIn"'), 'editor.html 仍有 #fileIn 入口');

console.log(fails ? ('\nFAILED: ' + fails) : '\nALL PASS');
process.exit(fails ? 1 : 0);
