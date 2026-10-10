// 学生行为策略网络（推理端，零依赖）：把"去哪"的决策权从规则交给一张 tiny MLP。
// 模型文件 campus_policy.json 由 tools/npc-policy/train.py 产出（纯 Python，无需 torch/numpy）。
// 这里只做前向：归一化状态向量 -> argmax(action)。
//
// ⚠ 与 train.py 的 STATE_KEYS / ACTIONS 必须逐字一致（tools/probe-policy.mjs 会校验）。
import fs from 'node:fs';
import path from 'node:path';

export const STATE_KEYS = [
  'hunger', 'fatigue', 'fun', 'study', 'social', 'bladder', 'hour', 'isWeekend',
  'cur_classroom', 'cur_canteen', 'cur_playground', 'cur_library', 'cur_shop', 'cur_dorm',
  'cur_toilet', 'cur_gate', 'cur_fountain', 'cur_other', 'hasClass', 'nearFriend', 'playerNear',
];
export const ACTIONS = [
  'classroom', 'canteen', 'playground', 'library', 'shop', 'dorm', 'toilet', 'gate', 'fountain', 'other',
  'wander', 'rest', 'chat_with', 'follow_player', 'help_player',
];
const ZONE_ACTIONS = new Set(ACTIONS.slice(0, 10));

function dense(W, b, x) {
  const out = new Array(W.length);
  for (let i = 0; i < W.length; i++) {
    let s = b[i];
    const Wi = W[i];
    for (let j = 0; j < x.length; j++) s += Wi[j] * x[j];
    out[i] = s;
  }
  return out;
}
function reluInPlace(x) {
  for (let i = 0; i < x.length; i++) if (x[i] < 0) x[i] = 0;
  return x;
}

export class PolicyNet {
  constructor(json) {
    this.state = Array.isArray(json.state) ? json.state : STATE_KEYS;
    this.actions = Array.isArray(json.actions) ? json.actions : ACTIONS;
    this.hidden = Array.isArray(json.hidden) ? json.hidden : [40, 40];
    this.W = json.weights;
    this.b = json.biases;
    this.meta = json.meta || {};
    this.ready = !!(this.W && this.b && this.W.length === this.hidden.length + 1);
    // 两端契约一致性（train.py 写的 state/actions 必须和这里对齐）
    this.contractOk =
      JSON.stringify(this.state) === JSON.stringify(STATE_KEYS) &&
      JSON.stringify(this.actions) === JSON.stringify(ACTIONS);
  }
  forwardVec(x) {
    let h = x;
    for (let l = 0; l < this.hidden.length; l++) h = reluInPlace(dense(this.W[l], this.b[l], h));
    return dense(this.W[this.hidden.length], this.b[this.hidden.length], h); // logits
  }
  decide(x) {
    const logits = this.forwardVec(x);
    let best = 0, bv = -1e18;
    for (let i = 0; i < logits.length; i++) if (logits[i] > bv) { bv = logits[i]; best = i; }
    return this.actions[best];
  }
  isZone(a) { return ZONE_ACTIONS.has(a); }
}

// 同步加载：没有模型 / 模型损坏 / 契约不一致 → 返回 ready:false（npcworld 自动退回规则大脑）。
export function loadPolicy(dataDir) {
  try {
    const f = path.join(dataDir, 'campus_policy.json');
    if (!fs.existsSync(f)) return { ready: false, net: null, reason: 'no-model' };
    const net = new PolicyNet(JSON.parse(fs.readFileSync(f, 'utf8')));
    if (!net.ready) return { ready: false, net: null, reason: 'bad-model' };
    if (!net.contractOk) return { ready: false, net: null, reason: 'contract-mismatch' };
    return { ready: true, net, meta: net.meta };
  } catch (e) {
    return { ready: false, net: null, reason: String((e && e.message) || e) };
  }
}
