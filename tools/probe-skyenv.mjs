// 自检：环境反射随天色的调度（src/world/SkyBox.js 的 envAt）
//   node tools/probe-skyenv.mjs
//
// 为什么要有这个：这段逻辑**连着踩过两次坑** ——
//   ① 时段一变就重建 PMREM（每分钟卡一帧 + 变色跳变）；
//   ② 为了省事把环境贴图定死成白天那张，结果「一整天都在反射白天的天空」，清晨/黄昏的暖色全丢。
// 判据很简单：一天里各时刻「用哪张时段贴图」和「环境光强度」必须对得上，且强度曲线连续（不跳变）。
import { envAt } from '../src/world/SkyBox.js';

let fail = 0;
function check(name, got, want) {
  const ok = String(got) === String(want);
  if (!ok) fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + name + ' = ' + got + (ok ? '' : '（期望 ' + want + '）'));
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const at = (h, m = 0) => (h * 60 + m) / 1440; // 世界时刻：0=00:00、0.5=12:00

// 时段划分：清晨 5-8 / 白天 8-17 / 夜晚 17-22 / 深夜 22-5（每段最后 18% 用于交叉淡入）
console.log('整段内（非过渡）：');
check('12:00 用白天贴图', envAt(at(12)).key, 'day');
check('12:00 强度', envAt(at(12)).intensity, 1);
check('06:00 用清晨贴图', envAt(at(6)).key, 'morning');
check('19:00 用夜晚贴图', envAt(at(19)).key, 'night');
check('19:00 强度', envAt(at(19)).intensity, 0.8);
check('02:00 用深夜贴图', envAt(at(2)).key, 'space');
check('02:00 强度', envAt(at(2)).intensity, 0.7);
check('23:00 仍是深夜贴图', envAt(at(23)).key, 'space');

console.log('白天→夜晚 的过渡（9 小时段的最后 18%：约 15:22 起，17:00 到位）：');
const mid = envAt(at(16, 0));
check('16:00 处于过渡中', mid.to, 'night');
check('16:00 还是白天贴图（未过中点）', mid.key, 'day');
check('16:00 强度已压低', mid.intensity < 0.95, true);
check('16:00 强度不低于谷底', mid.intensity >= Math.min(1, 0.8) * 0.8 - 1e-9, true);
const late = envAt(at(16, 45)); // a≈0.85：已过中点换图，强度在从谷底回升的路上（还没到 0.8）
check('16:45 已切到夜晚贴图', late.key, 'night');
check('16:45 强度高于谷底（在回升）', late.intensity > Math.min(1, 0.8) * 0.8 + 1e-9, true);
check('16:45 强度还没到整值', late.intensity < 0.8 - 1e-9, true);
check('17:00 收尾到 night 段', envAt(at(17)).key, 'night');
check('17:00 强度为 night 的整值', envAt(at(17)).intensity, 0.8);

console.log('曲线连续性（每 1 分钟采样，相邻两帧强度差必须极小）：');
let maxJump = 0, jumpAt = '';
for (let m = 0; m < 1440; m++) {
  const a = envAt(at(m / 60));
  const b = envAt(at((m + 1) / 60));
  const d = Math.abs(b.intensity - a.intensity);
  if (d > maxJump) { maxJump = d; jumpAt = (m / 60).toFixed(1) + 'h'; }
}
// 一段过渡 1.62 小时 ≈ 97 分钟走完 ~0.5 的落差 → 每分钟约 0.005；放宽到 0.02 足够
check('相邻分钟最大跳变 < 0.02（发生在 ' + jumpAt + '）', maxJump < 0.02, true);
console.log('       实际最大跳变 ' + maxJump.toFixed(5));

console.log(fail ? ('\n✗ ' + fail + ' 项不符') : '\n✓ 全部通过');
process.exit(fail ? 1 : 0);
