#!/usr/bin/env python3
# 学生行为策略训练器（纯 Python，无 torch / numpy，零依赖，能在本机 CPU 上跑）。
#
# 阶段1 预训练（自主，无人）：tools/npc-policy/gen_synthetic.py 产出自"规则大脑"的数据
#   例： python tools/npc-policy/gen_synthetic.py -n 3000 -o tools/npc-policy/feed/sft_pretrain.csv
# 阶段2 SFT（示范，人投喂）：你按 template.csv 填的 状态->动作 行
# 阶段3 RM（偏好，人投喂）：带 chosen / rejected 两列的状态行（A 比 B 好）
# 阶段4 RLHF（强化，无人）：用 RM 偏好对做 DPO，微调策略（无需再与环境交互）
# 阶段5 迭代（循环）：把游戏里导出的新轨迹标几行，并回 feed/ 再跑本脚本
#
# 产出 server-remote/data/campus_policy.json（policy.js 直接前向，零依赖）。
# 用法：
#   python tools/npc-policy/train.py --data tools/npc-policy/feed --out server-remote/data/campus_policy.json
#   python tools/npc-policy/train.py --data feed/sft.csv feed/pref.csv   # 也可直接传文件
import sys, os, json, math, random, csv, argparse

# ⚠ 与 server-remote/policy.js 的 STATE_KEYS / ACTIONS 必须逐字一致（probe-policy.mjs 会校验）
STATE_KEYS = ['hunger','fatigue','fun','study','social','bladder','hour','isWeekend',
              'cur_classroom','cur_canteen','cur_playground','cur_library','cur_shop','cur_dorm',
              'cur_toilet','cur_gate','cur_fountain','cur_other','hasClass','nearFriend','playerNear']
ACTIONS = ['classroom','canteen','playground','library','shop','dorm','toilet','gate','fountain','other',
           'wander','rest','chat_with','follow_player','help_player']
A2I = {a: i for i, a in enumerate(ACTIONS)}

# ---------------- 小工具 ----------------
def relu(x): return x if x > 0 else 0.0
def softmax(v):
    m = max(v); e = [math.exp(x - m) for x in v]; s = sum(e)
    return [x / s for x in e]
def log_softmax(v):
    m = max(v); e = [x - m for x in v]; s = sum(math.exp(x) for x in e)
    return [x - math.log(s) for x in e]

# ---------------- 网络（2 隐藏层 MLP，手写前向/反向） ----------------
class MLP:
    def __init__(self, din, hidden, dout, rng):
        self.hidden = hidden; self.dout = dout
        sizes = [din] + hidden + [dout]
        self.W = []; self.b = []
        for i in range(len(sizes) - 1):
            fan = sizes[i]
            self.W.append([[rng.uniform(-1, 1) * math.sqrt(2.0 / fan) for _ in range(sizes[i])] for _ in range(sizes[i + 1])])
            self.b.append([0.0] * sizes[i + 1])
    def forward(self, x):
        a = x; zs = []; acts = [x]
        for l in range(len(self.W)):
            z = [sum(self.W[l][i][j] * a[j] for j in range(len(a))) + self.b[l][i] for i in range(len(self.W[l]))]
            zs.append(z)
            a = [relu(v) for v in z] if l < len(self.W) - 1 else z
            acts.append(a)
        return zs, acts
    def copy(self):
        c = MLP.__new__(MLP)
        c.hidden = self.hidden; c.dout = self.dout
        c.W = [[row[:] for row in layer] for layer in self.W]
        c.b = [row[:] for row in self.b]
        return c
    def sgd(self, grads, lr):
        for l in range(len(self.W)):
            Wl = self.W[l]; bl = self.b[l]; gl = grads[l]; gW = gl['W']; gb = gl['b']
            for i in range(len(Wl)):
                Wi = Wl[i]; gWi = gW[i]; di = gb[i]
                for j in range(len(Wi)): Wi[j] -= lr * gWi[j]
                bl[i] -= lr * di
    def dump(self):
        return {'W': self.W, 'b': self.b}

def zeros_grads(net):
    return [{'W': [[0.0] * len(row) for row in layer], 'b': [0.0] * len(layer)} for layer in net.W]

def backprop(net, zs, acts, out_grad):
    L = len(net.W)
    grads = zeros_grads(net)
    d = out_grad[:]
    for l in range(L - 1, -1, -1):
        a_prev = acts[l]; gl = grads[l]; gW = gl['W']; gb = gl['b']
        for i in range(len(net.W[l])):
            di = d[i]; Wi = net.W[l][i]; gWi = gW[i]
            for j in range(len(a_prev)): gWi[j] = di * a_prev[j]
            gb[i] = di
        if l > 0:
            d_prev = [0.0] * len(a_prev)
            for i in range(len(net.W[l])):
                di = d[i]; Wi = net.W[l][i]
                for j in range(len(a_prev)): d_prev[j] += Wi[j] * di
            zprev = zs[l - 1]
            d = [d_prev[j] * (1.0 if zprev[j] > 0 else 0.0) for j in range(len(d_prev))]
    return grads

# ---------------- 训练阶段 ----------------
def train_bc(net, data, epochs, lr, rng):
    n = len(data)
    for ep in range(epochs):
        idx = list(range(n)); rng.shuffle(idx)
        tot = 0.0
        for k in idx:
            x, a_idx, w = data[k]
            zs, acts = net.forward(x)
            p = softmax(zs[-1])
            g = [p[i] for i in range(len(p))]
            g[a_idx] -= 1.0
            for i in range(len(g)): g[i] *= w
            net.sgd(backprop(net, zs, acts, g), lr)
            tot += -math.log(p[a_idx] + 1e-12)
        if ep % 10 == 0 or ep == epochs - 1:
            print(f"  [BC ] epoch {ep:3d} loss={tot / n:.4f}")
    return tot / n

def train_dpo(net, pairs, epochs, lr, beta, ref):
    m = len(pairs)
    for ep in range(epochs):
        tot = 0.0; rng.shuffle(pairs)
        for (x, c, r) in pairs:
            zs, acts = net.forward(x)
            lp = log_softmax(zs[-1])
            zr, _ = ref.forward(x); lpr = log_softmax(zr[-1])
            D = (lp[c] - lp[r]) - (lpr[c] - lpr[r])
            sig = 1.0 / (1.0 + math.exp(beta * D))
            dLdD = -beta * sig
            g = [0.0] * len(lp)
            g[c] = dLdD; g[r] = -dLdD
            net.sgd(backprop(net, zs, acts, g), lr)
            tot += math.log(1.0 + math.exp(-beta * D) + 1e-12)
        if ep % 5 == 0 or ep == epochs - 1:
            print(f"  [DPO] epoch {ep:3d} loss={tot / max(1, m):.4f}")
    return tot / max(1, m)

# ---------------- 数据加载 ----------------
def build_x(row):
    x = []
    for k in STATE_KEYS:
        v = row.get(k)
        if v is None or v == '':
            x.append(0.0); continue
        try:
            fv = float(v)
        except Exception:
            fv = 0.0
        if k == 'hour':
            fv = fv / 24.0
        x.append(max(0.0, min(1.0, fv)))
    return x

def load_file(path, bc, pref):
    ext = os.path.splitext(path)[1].lower()
    rows = []
    if ext == '.csv':
        with open(path, newline='', encoding='utf-8-sig') as f:
            for r in csv.DictReader(f): rows.append(r)
    elif ext == '.json':
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
        rows = data if isinstance(data, list) else data.get('rows', [])
    else:
        return
    is_pref = any('chosen' in r and 'rejected' in r for r in rows)
    for r in rows:
        try:
            if is_pref:
                c = A2I.get(str(r.get('chosen', '')).strip())
                rr = A2I.get(str(r.get('rejected', '')).strip())
                if c is None or rr is None:
                    print(f"  [warn] 跳过偏好行（动作不在集合）: {r}"); continue
                pref.append((build_x(r), c, rr))
            else:
                a = A2I.get(str(r.get('action', '')).strip())
                if a is None:
                    print(f"  [warn] 跳过 SFT 行（动作不在集合）: {r.get('action')}"); continue
                w = 1.0
                try: w = max(0.0, float(r.get('weight', 1.0)))
                except Exception: w = 1.0
                bc.append((build_x(r), a, w))
        except Exception as e:
            print(f"  [warn] 跳过坏行: {e}")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', nargs='+', default=['feed'], help='投喂文件或目录（默认 feed/）')
    ap.add_argument('--out', default='server-remote/data/campus_policy.json')
    ap.add_argument('--epochs', type=int, default=25)
    ap.add_argument('--lr', type=float, default=0.08)
    ap.add_argument('--hidden', default='32,32', help='隐藏层尺寸，逗号分隔（tiny net，25 epoch 已足够）')
    ap.add_argument('--dpo-epochs', type=int, default=20)
    ap.add_argument('--beta', type=float, default=0.3)
    ap.add_argument('--seed', type=int, default=7)
    args = ap.parse_args()
    rng = random.Random(args.seed)
    hidden = [int(x) for x in args.hidden.split(',') if x]

    bc, pref = [], []
    for d in args.data:
        if os.path.isdir(d):
            for fn in sorted(os.listdir(d)):
                if fn.endswith('.csv') or fn.endswith('.json'):
                    load_file(os.path.join(d, fn), bc, pref)
        else:
            load_file(d, bc, pref)
    print(f"载入：SFT {len(bc)} 行，偏好对 {len(pref)} 对")

    if not bc:
        print("没有 SFT 数据，退出（先跑 gen_synthetic.py 或投喂 template.csv）"); sys.exit(1)

    net = MLP(len(STATE_KEYS), hidden, len(ACTIONS), rng)
    print(f"网络：{len(STATE_KEYS)}→{hidden}→{len(ACTIONS)}")
    loss = train_bc(net, bc, args.epochs, args.lr, rng)
    phases = [f"BC x{args.epochs}"]
    if pref:
        ref = net.copy()
        train_dpo(net, pref, args.dpo_epochs, args.lr * 0.5, args.beta, ref)
        phases.append(f"DPO x{args.dpo_epochs}")

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    model = {
        'version': 1,
        'state': STATE_KEYS,
        'actions': ACTIONS,
        'hidden': hidden,
        'weights': net.W,
        'biases': net.b,
        'meta': {'trainedRows': len(bc), 'prefPairs': len(pref), 'loss': round(loss, 4),
                 'phases': phases, 'createdAt': __import__('datetime').datetime.utcnow().isoformat() + 'Z'},
    }
    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump(model, f, ensure_ascii=False)
    print(f"已保存模型 → {args.out}（{os.path.getsize(args.out)} 字节）")

if __name__ == '__main__':
    main()
