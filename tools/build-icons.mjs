/**
 * 从 Kenney "Board Game Icons" 里挑出界面要用的图标，压成「可直接内联的 SVG 片段」。
 *
 * 为什么压成片段而不是直接引 .svg 文件：
 *   - 图标要跟着主题换色（`currentColor`），外链 <img> 做不到；
 *   - 内联省掉 60+ 次网络请求，Kenney 的 UI 素材本来就是这套用法。
 *
 * 官方原图两个坑，这里都处理了：
 *   1. **没有 viewBox / width / height** —— 直接内联会渲染成 0x0。
 *      路径坐标是 -28..56 这种「以中心为原点」的值，所以按实际包围盒补 viewBox。
 *   2. 填充写死 `#FFFFFF` —— 换成 `currentColor` 才能跟随主题。
 *
 * 输出：src/ui/icons.js，导出 `ICONS`（名字 → {viewBox, body}）与 `icon(name, opts)`。
 * 用法：el.insertAdjacentHTML('beforeend', icon('bag'))
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// 界面语义 → Kenney 文件名。挑的都是「图形本身能表达功能」的，
// 文字标签一律保留（用户要求），图标只做辅助提示。
const WANTED = {
  bag: 'card_add',            // 背包 = 加东西的容器
  settings: 'puzzle',         // 设置 = 拼图
  combat: 'sword',            // 对战 = 交叉的剑
  close: 'rhombus',           // 关闭（配合文字 × 用）
  info: 'book_open',          // 说明 / 操作手册
  key: 'card',                // 键位提示
  clock: 'hourglass',         // 计时 / 冷却
  spin: 'spinner',            // 加载中
  trophy: 'crown_a',          // 结算 / 名次
  coin: 'token',              // 学币
  shield: 'shield',           // 防御 / 护盾
  skull: 'skull',             // 死亡 / 淘汰
  flag: 'flag_triangle',      // 目标 / 终点
  character: 'character',     // 角色
  cards: 'cards_stack',       // 卡组 / 对战
  lock: 'lock_closed',        // 锁定
  potion: 'flask_full',       // 状态 / 增益
  stack: 'tokens',            // 堆叠 / 数量
  star: 'award',              // 成就
  home: 'structure_house',    // 返回
  map: 'direction_n',         // 地图 / 方向
};

// ---- 视图框 ----
// Kenney 全套图标都画在**统一的 56x56 网格**里（中心在原点，即 -28..28），
// 所以固定用这个 viewBox，而不是按各自动画包围盒 ——
// 后者会因图形宽窄不同（30x53 vs 56x56）导致并排时图标大小参差。
// 固定之后所有图标视觉大小一致，这是图标集该有的样子。
const VIEWBOX = '-28 -28 56 56';

const srcDir = process.argv[2];
if (!srcDir) {
  console.error('用法: node tools/build-icons.mjs <Vector/Icons 目录>');
  process.exit(1);
}

const parts = [];
const names = [];
for (const [name, file] of Object.entries(WANTED)) {
  const p = resolve(srcDir, file + '.svg');
  let svg;
  try {
    svg = readFileSync(p, 'utf8');
  } catch {
    console.error(`  跳过 ${name}：找不到 ${file}.svg`);
    continue;
  }
  // 取所有 <path ...>，把 fill 换成 currentColor
  const paths = [...svg.matchAll(/<path\b[^>]*\/?>/g)].map((m) => {
    const tag = m[0]
      .replace(/fill="[^"]*"/g, 'fill="currentColor"')
      .replace(/\s*stroke="none"/g, '')   // 描边交给 fill，避免和主题描边打架
      .replace(/<path\b(?![\s\S]*\bd=)/, '<path'); // 保持原样
    return '    ' + tag;
  });
  if (!paths.length) {
    console.error(`  跳过 ${name}：${file}.svg 里没有 path`);
    continue;
  }
  parts.push(
    `  // ${file}.svg\n` +
    `  ${name}: { viewBox: '${VIEWBOX}', body: \`\n${paths.join('\n')}\n  \` },`
  );
  names.push(name);
}

const out = `// ⚠ 本文件由 tools/build-icons.mjs 自动生成，**不要手改**。
// 素材：Kenney "Board Game Icons"（CC0）—— https://kenney.nl/assets/board-game-icons
//
// 统一了两件事，改的时候注意：
//   1. 官方 SVG **没有 viewBox**，直接内联会渲染成 0x0 —— 这里统一补成 Kenney 的标准 56x56；
//   2. 填充写死 #FFFFFF —— 换成 currentColor 才能跟着主题换色。
// 所以用的时候只要给容器设 color，图标就自动适配：
//   el.style.color = 'var(--kui-ink)'   → 深色（浅底）
//   el.style.color = 'var(--kui-paper)' → 浅色（深底）
export const ICONS = {
${parts.join('\n')}
};

// 生成内联 SVG 字符串。size 默认按 viewBox 高度自适应（用 em，跟文字一起缩放）。
export function icon(name, { size = '1.15em', cls = '' } = {}) {
  const d = ICONS[name];
  if (!d) return '';
  return \`<svg class="\${cls}" viewBox="\${d.viewBox}" width="\${size}" height="\${size}" \` +
    \`style="display:block;flex:0 0 auto" aria-hidden="true" focusable="false">\${d.body}</svg>\`;
}
`;

writeFileSync(resolve(HERE, '../src/ui/icons.js'), out);
console.log(`已生成 src/ui/icons.js：${names.length} 个图标（${names.join(', ')}）`);
