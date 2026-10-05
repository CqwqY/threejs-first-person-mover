// 静态检查：揪出「行尾注释吃掉了代码」。
//
// 为什么需要它：2026-10-05 一次编辑器改动把
//     clearLodTargets();  // 注释…  const gen = ++_buildGen;   ← 两行挤到一行
// 写成了同一行，于是 `const gen` 变成注释的一部分、变量**从未声明**；
// 下面 `if (gen !== _buildGen)` 在 ESM 严格模式下抛 ReferenceError，
// 又被 `.catch(() => {})` 静默吞掉 → **碰撞体永远 push 不进去，碰撞全没了，控制台却不报错**。
//
// ⚠ `node --check` 和 esbuild **都抓不到**（未声明标识符不是语法错误，两个都实测通过）。
//
// 判定规则（刻意收窄，避免误报）：
//   只检查**行尾注释**（`//` 前面有实际代码）。行首的文档注释里出现代码示例是常态，不报。
//   行尾注释里若出现「声明/控制流关键字 + 分号」，几乎必然是被注释吞掉的语句。
import fs from 'node:fs';
import path from 'node:path';

const ROOTS = ['src', 'server', 'server-remote', 'tools'];
// 语句级关键字：出现在行尾注释里基本不可能是正常说明文字
const STMT = /\b(const|let|var|return|function|class|throw|export|import)\s/;

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|mjs|cjs)$/.test(e.name)) out.push(p);
  }
}

const files = [];
for (const r of ROOTS) walk(r, files);

// 剥掉字符串与正则字面量，否则 `startsWith('//')`、`/^\/(assets)\//` 里的 //
// 会被当成注释起点，产生误报。
function stripLiterals(line) {
  let out = '';
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === '/' && line[i + 1] === '/') { out += line.slice(i); break; } // 真注释：后面原样保留
    if (c === '/' && line[i + 1] === '*') { const e = line.indexOf('*/', i + 2); i = e < 0 ? line.length : e + 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === '\\') { j += 2; continue; }
        if (line[j] === c) { j++; break; }
        j++;
      }
      out += 'STR'; i = j; continue;
    }
    // 正则字面量：前一个非空字符是运算符/括号/逗号等才可能（避免把 a / b 当正则）
    if (c === '/' && /[(,=!&|?:;+\-*%[{~]$/.test(out.trimEnd())) {
      let j = i + 1, inCls = false;
      while (j < line.length) {
        const d = line[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '[') inCls = true;
        else if (d === ']') inCls = false;
        else if (d === '/' && !inCls) { j++; break; }
        j++;
      }
      while (j < line.length && /[gimsuyd]/.test(line[j])) j++;
      out += 'RE'; i = j; continue;
    }
    out += c; i++;
  }
  return out;
}

const hits = [];
for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = stripLiterals(raw);
    const k = line.indexOf('//');
    if (k <= 0) return;                       // 无注释，或就是行首注释 → 不报
    const before = line.slice(0, k);
    if (!/\S/.test(before)) return;           // // 前面只有空白 → 仍是行首注释
    const after = line.slice(k + 2);
    if (!after.includes(';')) return;         // 没有分号 → 不太像一整条语句
    if (!STMT.test(after)) return;
    hits.push(`${f}:${i + 1}\n    ${raw.trim()}`);
  });
}

if (hits.length) {
  console.error(`✗ 发现 ${hits.length} 处「行尾注释里含语句」——很可能是被注释吃掉的代码：\n`);
  for (const h of hits) console.error('  ' + h);
  process.exit(1);
}
console.log(`✓ 行尾注释检查通过（扫描 ${files.length} 个文件）`);
