// 云控数据「终端查看器」：从 stdin（或文件路径）读服务端 JSON，打成人类可读的表格直接看，不落盘。
//
// 用法（git-bash / cmd 都行）：
//   B=https://game666.lshserver.dpdns.org
//   N="C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-6/node.exe"
//
//   curl -s --noproxy '*' "$B/api/shop"  | "$N" tools/cloud-view.mjs shop
//   curl -s --noproxy '*' "$B/api/build" | "$N" tools/cloud-view.mjs build
//   ssh cai@100.127.187.92 "cat /home/cai/fp-relay/data/shop.json" | "$N" tools/cloud-view.mjs shop
//
//   --grep=沙发     只显示含关键词的行（任何类型都支持）
//   --full          scene 类型显示完整结构（默认只打摘要）
//
// 类型：shop 商品 | build 已摆家具 | areas 建造范围 | scene 编辑器场景 | models 素材清单 | auto 自动猜
import fs from 'node:fs';

const argv = process.argv.slice(2);
const flags = argv.filter((a) => a.startsWith('--'));
const rest = argv.filter((a) => !a.startsWith('--'));
const kind = String(rest[0] || 'auto').toLowerCase();
const file = rest[1] || '';
const grep = (flags.find((f) => f.startsWith('--grep=')) || '').slice(7);
const full = flags.includes('--full');

function readInput() {
  if (file) return fs.readFileSync(file, 'utf8');
  // 没有文件时读 stdin（管道过来的 curl / ssh 输出）
  try { return fs.readFileSync(0, 'utf8'); } catch (e) { return ''; }
}

const raw = readInput();
if (!raw || !raw.trim()) {
  console.error('没有读到数据。用法：curl -s --noproxy \'*\' "$B/api/shop" | node tools/cloud-view.mjs shop');
  process.exit(1);
}
let data;
try {
  data = JSON.parse(raw);
} catch (e) {
  console.error('不是合法 JSON（服务端可能在报错）：' + e.message + '\n前 200 字节：\n' + raw.slice(0, 200));
  process.exit(1);
}
if (data && data.ok === false) console.error('注意：服务端返回 ok=false —— ' + (data.error || ''));

const lines = [];
const push = (s) => lines.push(String(s));
// 中文在终端里占两列，按「显示宽度」补齐，否则名称列会歪
function dispWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  return w;
}
const pad = (s, n) => { const t = String(s ?? ''); return t + ' '.repeat(Math.max(0, n - dispWidth(t))); };

function guess(d) {
  if (Array.isArray(d)) return d.some((x) => x && x.itemId) ? 'build' : 'models';
  if (d.areas) return 'areas';
  if (d.models) return 'models';
  if (d.items && d.items.some((x) => x && x.price !== undefined)) return 'shop';
  if (d.items && d.items.some((x) => x && x.itemId !== undefined)) return 'build';
  if (d.buildings || d.lights || d.objects) return 'scene';
  return 'keys';
}
const k = kind === 'auto' ? guess(data) : kind;

if (k === 'shop') {
  const it = data.items || [];
  const f = it.filter((x) => /^furn_/.test(String(x.id || '')));
  const bad = f.filter((x) => !x.url || String(x.url).includes('placeholder'));
  const over = it.filter((x) => Number(x.price) > 100);
  push('商品总数 ' + it.length + ' | 家具 ' + f.length + ' | 仍是占位模型 ' + bad.length + ' | 价格>100 ' + over.length);
  push('');
  push([pad('id', 30), pad('名称', 14), pad('价格', 6), pad('类型', 9), 'url'].join(''));
  for (const x of it) push([pad(x.id, 30), pad(x.name, 14), pad(x.price, 6), pad(x.kind, 9), (x.url || '-')].join(''));
} else if (k === 'build') {
  const it = data.items || [];
  push('已摆家具 ' + it.length + ' 件');
  push('');
  push([pad('id', 16), pad('itemId', 30), pad('x', 8), pad('y', 8), pad('z', 8), pad('rotY', 6), pad('scale', 6), 'owner'].join(''));
  for (const b of it) {
    push([pad(b.id, 16), pad(b.itemId, 30), pad(Number(b.x).toFixed(2), 8), pad(Number(b.y).toFixed(2), 8),
      pad(Number(b.z).toFixed(2), 8), pad(b.rotY, 6), pad(b.scale, 6), b.owner || '-'].join(''));
  }
} else if (k === 'areas') {
  const a = data.areas || [];
  push('建造范围 ' + a.length + ' 块');
  for (const r of a) push(JSON.stringify(r));
  if (!a.length) push('（没有配置，客户端会用 Config.BUILD_AREAS 兜底）');
} else if (k === 'models') {
  const m = data.models || [];
  push('已上传素材 ' + m.length + ' 个');
  for (const x of m) push(typeof x === 'string' ? x : JSON.stringify(x));
} else if (k === 'scene') {
  const d = data;
  const keys = Object.keys(d);
  push('场景顶层字段：' + keys.join(', '));
  for (const key of ['buildings', 'objects', 'lights', 'colliders', 'areas', 'tracks']) {
    const v = d[key];
    if (Array.isArray(v)) push('  ' + key + '：' + v.length + ' 项');
    else if (v && typeof v === 'object') push('  ' + key + '：对象 ' + Object.keys(v).length + ' 键');
  }
  if (full) { push(''); push(JSON.stringify(d, null, 2)); }
  else push('\n（加 --full 看完整结构）');
} else {
  push('未知类型「' + k + '」，只列出顶层结构：');
  for (const [key, v] of Object.entries(data)) {
    push('  ' + pad(key, 20) + (Array.isArray(v) ? '数组 ' + v.length + ' 项' : typeof v));
  }
}

const out = grep ? lines.filter((l) => l.includes(grep)) : lines;
console.log(out.join('\n'));
if (grep) console.log('\n（已按「' + grep + '」过滤，共 ' + out.length + ' / ' + lines.length + ' 行）');
