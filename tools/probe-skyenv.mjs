// 自检：环境反射随天色的调度（src/world/SkyBox.js 的 envAt）
//   node tools/probe-skyenv.mjs
//
// 为什么要有这个：这段逻辑**连着踩过两次坑** ——
//   ① 时段一变就重建 PMREM（每分钟卡一帧 + 变色跳变）；
//   ② 为了省事把环境贴图定死成白天那张，结果「一整天都在反射白天的天空」，清晨/黄昏的暖色全丢。
// 判据很简单：一天里各时刻「用哪张时段贴图」和「环境光强度」必须对得上，且强度曲线连续（不跳变）。
import { envAt } from '../src/world/SkyBox.js';

// ⚠ 夜间两张时段贴图的 IBL 强度在这里钉死一份期望值：
//   调 SkyBox.js 的 ENV_INTENSITY.night / .space 时必须同步改这两个数，
//   否则下面所有「单调下降 / 过渡未到底 / 明暗对比」断言会一起失效。
const NIGHT_I = 0.56;
const SPACE_I = 0.32;

let fail = 0;
function check(name, got, want) {
  const ok = String(got) === String(want);
  if (!ok) fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + name + ' = ' + got + (ok ? '' : '（期望 ' + want + '）'));
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const at = (h, m = 0) => (h * 60 + m) / 1440; // 世界时刻：0=00:00、0.5=12:00

// 时段划分：清晨 5:30-8 / 白天 8-17:30 / 夜晚 17:30-21 / 深夜 21-次日 5:30；
// 每段末尾固定 30 分钟交叉淡入（Config.SKY_FADE_DUR），不再按段长比例。
console.log('整段内（非过渡）：');
check('12:00 用白天贴图', envAt(at(12)).key, 'day');
check('12:00 强度', envAt(at(12)).intensity, 1);
check('06:00 用清晨贴图', envAt(at(6)).key, 'morning');
check('19:00 用夜晚贴图', envAt(at(19)).key, 'night');
check('19:00 强度', near(envAt(at(19)).intensity, NIGHT_I), true);
check('02:00 用深夜贴图', envAt(at(2)).key, 'space');
check('02:00 强度', near(envAt(at(2)).intensity, SPACE_I), true);
check('23:00 仍是深夜贴图', envAt(at(23)).key, 'space');

console.log('白天→夜晚 的过渡（固定 30 分钟淡入：17:00 起、17:30 到位）：');
// 亮度是**单调插值**（1.0 → 夜间整值一路变暗），不再是"先压到谷底再回升"的哑铃。
// ⚠ 时刻基准：SkyBox 用 Config.SKY_FADE_DUR 固定 30 分钟预淡入，不是旧的「段长 18%」。
//   16:00 根本不在过渡里，拿它断言必然假失败（这批断言曾整组飘红）。
const mid = envAt(at(17, 10)); // a≈0.33
check('17:10 处于过渡中', mid.to, 'night');
check('17:10 还是白天贴图（未过中点）', mid.key, 'day');
check('17:10 强度已在白天与夜间整值之间', mid.intensity < 1 && mid.intensity > NIGHT_I, true);
const late = envAt(at(17, 25)); // a≈0.83
check('17:25 已切到夜晚贴图', late.key, 'night');
// 单调性：过渡过程中强度只能一路往下走，不许出现"暗一下又亮回来"的凹谷
check('17:25 比 17:10 更暗（单调下降，没有凹谷）', late.intensity < mid.intensity, true);
// 从白天整值往夜间整值降：17:25 应该"还在往下降、尚未到底"，所以强度仍高于夜间整值
check('17:25 还在往 night 整值降（未到底）', late.intensity > NIGHT_I + 1e-9, true);
check('17:25 已降过半程', late.intensity < (1 + NIGHT_I) / 2, true);
check('17:30 收尾到 night 段', envAt(at(17, 30)).key, 'night');
check('17:30 强度为 night 的整值', near(envAt(at(17, 30)).intensity, NIGHT_I), true);

console.log('明暗对比（"环境光整天一个亮度"就是这里被压平过）：');
const vals = ['morning', 'day', 'night', 'space'].map((k) => {
  const h = { morning: 6, day: 12, night: 19, space: 2 }[k];
  return envAt(at(h)).intensity;
});
check('最亮与最暗至少差 3 倍（现在是 ' + (vals[1] / vals[3]).toFixed(2) + ' 倍）', vals[1] / vals[3] >= 3, true);
check('夜间确实比旧值 0.45 更亮', vals[2] > 0.45, true);
check('深夜确实比旧值 0.25 更亮', vals[3] > 0.25, true);

console.log('反射分档（过渡期按档重建小图 PMREM，别每帧重建）：');
const s1 = envAt(at(17, 10)).step, s2 = envAt(at(17, 20)).step;
check('过渡中 step 随进度前进', s2 > s1, true);
check('非过渡期 step 为 0', envAt(at(12)).step, 0);

console.log('曲线连续性（每 1 分钟采样，相邻两帧强度差必须极小）：');
let maxJump = 0, jumpAt = '';
for (let m = 0; m < 1440; m++) {
  const a = envAt(at(m / 60));
  const b = envAt(at((m + 1) / 60));
  const d = Math.abs(b.intensity - a.intensity);
  if (d > maxJump) { maxJump = d; jumpAt = (m / 60).toFixed(1) + 'h'; }
}
// 固定 30 分钟走完 ~0.44 的落差 → 每分钟约 0.015；放宽到 0.02 足够
check('相邻分钟最大跳变 < 0.02（发生在 ' + jumpAt + '）', maxJump < 0.02, true);
console.log('       实际最大跳变 ' + maxJump.toFixed(5));

console.log(fail ? ('\n✗ ' + fail + ' 项不符') : '\n✓ 全部通过');
process.exit(fail ? 1 : 0);
