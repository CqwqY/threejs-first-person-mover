// 自检：服务端 CORS 的 Access-Control-Allow-Methods 必须覆盖**所有实际用到的** HTTP 方法
// （node tools/probe-cors-methods.mjs）
//
// 为什么要测：用户报「撤回公告点了说网络不通」。
//   根因：客户端撤回走 `fetch(..., {method:'DELETE', headers:{'Content-Type':'application/json'}})`。
//   带 application/json 的请求**不是** CORS 简单请求 ⇒ 浏览器先发 OPTIONS 预检。
//   服务端虽然回了 204，但 `Access-Control-Allow-Methods` 只写了 'GET, POST, OPTIONS'
//   ⇒ 预检不通过 ⇒ 浏览器**拒发**真正的 DELETE ⇒ 前端 fetch **抛异常** ⇒ 命中 catch → 报"网络不通"。
//   （POST 发布能用、DELETE 撤回不能用 —— 差别就在这一行允许列表。）
//
// 规则：只要服务端路由里出现了某个方法（method === 'XXX'），Allow-Methods 就必须包含它。
//   这条守卫专门防"以后再加个带 body 的 PUT/PATCH/DELETE 又忘了配 CORS"。
//
// ⚠ server/index.js（本地开发）与 server-remote/index.js（线上）是两份独立文件，都要查。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const TARGETS = [
  path.join(ROOT, 'server-remote', 'index.js'),
  path.join(ROOT, 'server', 'index.js'),
];

// 触发 CORS 预检的方法（简单方法只有 GET/HEAD/POST）。这些方法一旦被路由用到，
// 就 REQUIRED 出现在 Allow-Methods，否则浏览器会拦。
const PREFLIGHT_METHODS = ['DELETE', 'PUT', 'PATCH'];

let fails = 0;
function check(name, ok, extra) {
  if (!ok) { fails++; console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`); }
  else console.log(`  ok    ${name}`);
}

// CRLF→LF 归一化：Windows 检出是 CRLF，否则多行字面量断言必然失败
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

for (const file of TARGETS) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  if (!fs.existsSync(file)) { console.log(`\n${rel}: 不存在，跳过`); continue; }
  const src = read(file);
  console.log(`\n${rel}:`);

  // 取 Allow-Methods 那一行里的方法集合
  const m = src.match(/Access-Control-Allow-Methods'\s*,\s*'([^']*)'/);
  if (!m) { check('找到 Access-Control-Allow-Methods 行', false); continue; }
  const allowed = m[1].split(',').map((s) => s.trim().toUpperCase());
  check(`Allow-Methods 含 OPTIONS（预检本身要允许）`, allowed.includes('OPTIONS'), `[${allowed.join(', ')}]`);

  // 扫描所有 `req.method === 'XXX'` 用到的非简单方法
  const used = new Set();
  for (const mm of src.matchAll(/req\.method\s*===\s*'([A-Z]+)'/g)) {
    if (PREFLIGHT_METHODS.includes(mm[1])) used.add(mm[1]);
  }

  check(`源码里用到的预检方法都进了 Allow-Methods`,
    [...used].every((x) => allowed.includes(x)),
    used.size ? `用到 [${[...used].join(', ')}]，允许 [${allowed.join(', ')}]` : '（无 DELETE/PUT/PATCH）');
}

console.log(fails === 0 ? '\n✓ 全部通过' : `\n✗ ${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
