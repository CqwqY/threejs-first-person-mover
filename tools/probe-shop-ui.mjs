// 商店「分类 + 预览 + 搜索」改动的守卫探针（纯静态断言 + 资源对账，不依赖浏览器）。
// 防的事：以后重构 ShopPanel 时把搜索/分类/预览链路不小心拆断，界面不报错但功能整块消失。
// 用法：node tools/probe-shop-ui.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ok   ' : '  FAIL ') + msg); if (!cond) fails++; };

// 花括号配对抽函数体（不要用 indexOf 到文件尾的切片写法，会把后面的代码全断言进去）
function blockAt(src, anchor) {
  const i = src.indexOf(anchor);
  if (i < 0) return '';
  const b = src.indexOf('{', i);
  let depth = 0;
  for (let p = b; p < src.length; p++) {
    if (src[p] === '{') depth++;
    else if (src[p] === '}') { depth--; if (depth === 0) return src.slice(b, p + 1); }
  }
  return '';
}

const panel = read('src/ui/ShopPanel.js');
const shop = read('src/player/Shop.js');

console.log('[1] 搜索框链路');
ok(panel.includes("furnSearch.addEventListener('input'"), '搜索框绑定了 input 监听');
ok(/furnSearch\.addEventListener\('input'[^)]*\)\s*=>\s*\{[^}]*renderGrid\(\)/.test(panel), '输入时调用 renderGrid 只重刷商品区');
ok(panel.includes("placeholder=\"搜索家具：名称 / 描述关键词\""), '搜索框有中文占位提示');
const catBlock = blockAt(panel, 'function catOf');
ok(catBlock.includes('/（([^（）]+)）/.exec'), 'catOf 从描述里的全角括号提取类目');
ok(panel.includes(": '其他'"), '无类目标注的商品归入「其他」');

console.log('[2] 分类 chips 链路');
const catsBlock = blockAt(panel, 'function renderCats');
ok(catsBlock.includes("mkChip('全部', 'all'"), '分类条有「全部」');
ok(catsBlock.includes('furnCat = key') && catsBlock.includes('renderGrid()'), '点分类设置 furnCat 并重刷商品区');
ok(catsBlock.includes(".sort((a, b) => b[1] - a[1])"), '分类按商品数降序排列');
ok(/furnCat !== 'all'\)\s*list = list\.filter\(\(it\) => catOf\(it\) === furnCat\)/.test(panel), '商品列表按当前分类过滤');
ok(/furnQ[\s\S]{0,80}toLowerCase\(\)[\s\S]{0,120}includes\(q\)/.test(panel), '搜索词大小写不敏感地匹配名称/描述');

console.log('[3] 预览图链路');
const pvBlock = blockAt(panel, 'function buildPreview');
ok(pvBlock.includes("'furn-previews/' + item.id + '.png'"), '预览图按商品 id 指向 public/furn-previews/<id>.png');
ok(pvBlock.includes("import.meta.env?.BASE_URL"), '预览路径拼在 BASE_URL 上（适配子路径部署）');
ok(pvBlock.includes("img.loading = 'lazy'"), '预览图懒加载（140 张不能全量拉）');
ok(pvBlock.includes("'error'") && pvBlock.includes('itemIconSvg('), '加载失败回退矢量图标');
ok(pvBlock.includes("'mouseenter'") && pvBlock.includes("scale(1.9)"), '悬停放大预览');

console.log('[4] 页签隔离：道具页签不受影响');
ok(/redeemRow\.style\.display = isFurn \? 'none' : 'flex'/.test(panel), '兑换码行只在家具页签隐藏');
ok(/furnTools\.style\.display = isFurn \? 'block' : 'none'/.test(panel), '搜索/分类条只在家具页签显示');
ok(panel.includes("it.kind === 'building' : it.kind !== 'building'"), '道具/家具按 kind 分流未变');

console.log('[5] 预览资源与商品对账（动态）');
const ids = [...shop.matchAll(/id: '(furn_[a-z0-9_]+)'/g)].map((m) => m[1]);
const pvDir = path.join(ROOT, 'public', 'furn-previews');
const files = new Set(fs.readdirSync(pvDir).filter((f) => f.endsWith('.png')));
const missing = ids.filter((id) => !files.has(id + '.png'));
ok(files.size >= ids.length, 'public/furn-previews 共 ' + files.size + ' 张，不少于在售家具 ' + ids.length + ' 件');
ok(missing.length === 0, '每件在售家具都有预览图' + (missing.length ? '（缺: ' + missing.join(', ') + '）' : ''));

console.log('[6] 家具模型的地址解析（不能把服务端模型当站点同源文件取）');
const loader = read('src/world/AssetLoader.js');
const resBlock = blockAt(loader, 'function resolveUrl');
ok(/remoteOnly\.has\(url\)\)\s*return API_BASE \+ url/.test(resBlock), '探明只有服务端有的 url 走 API_BASE');
ok(resBlock.includes("/^\\/assets\\/(import-|furn_)/.test(url)"), 'import- 与 furn_ 前缀直接走 API_BASE（服务端 data/assets）');
const tryBlock = blockAt(loader, 'function canTryRemote');
ok(tryBlock.includes('!remoteOnly.has(rawUrl)'), '远程回退只试一次（防无限递归）');
const loadBlock = blockAt(loader, 'function loadGLB');
ok(loadBlock.includes('canTryRemote(rawUrl)'), 'loadGLB 挂了远程兜底分支');
ok(loadBlock.includes('remoteOnly.add(rawUrl)') && loadBlock.includes('return loadGLB(rawUrl)'), '同源 404 后改走 API_BASE 重试');
ok(loadBlock.includes('cache.delete(url)'), '回退前清掉失败缓存（失败 Promise 不能毒死后续）');

console.log(fails ? '\n' + fails + ' 条失败' : '\n全部通过');
process.exit(fails ? 1 : 0);
