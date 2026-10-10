#!/usr/bin/env python3
# 阶段1 预训练（自主，无人）：把当前"规则大脑"的行为克隆成数据集。
# 复刻 server-remote/npcworld.js 的 decide()：课程表时段 70% 优先、否则按最迫切需求选区域。
# 这样模型一上来就和现在"看起来不错"的行为一致，之后再靠 SFT / 偏好把它调得更聪明。
#   python tools/npc-policy/gen_synthetic.py -n 3000 -o tools/npc-policy/feed/sft_pretrain.csv
import argparse, csv, json, random

STATE_KEYS = ['hunger','fatigue','fun','study','social','bladder','hour','isWeekend',
              'cur_classroom','cur_canteen','cur_playground','cur_library','cur_shop','cur_dorm',
              'cur_toilet','cur_gate','cur_fountain','cur_other','hasClass','nearFriend','playerNear']
ZONE_TYPES = ['classroom','canteen','playground','library','shop','dorm','toilet','gate','fountain','other']
SCHEDULE = [(0,6.5,'dorm'),(6.5,7.5,'canteen'),(7.5,11.6,'classroom'),(11.6,12.6,'canteen'),
            (12.6,13.4,'dorm'),(13.4,17,'classroom'),(17,18,'playground'),(18,18.8,'canteen'),
            (18.8,21,'library'),(21,24,'dorm')]
NEED_MAP = {'hunger':'canteen','fatigue':'dorm','fun':'playground','study':'library','social':'fountain','bladder':'toilet'}

def schedule_type(h):
    for a, b, t in SCHEDULE:
        if a <= h < b: return t
    return None

def decide(hour, needs, cur_zone, near_friend, player_near):
    seg = schedule_type(hour)
    if seg and random.random() < 0.7:
        return seg
    # 最迫切的需求（带扰动，避免每次都选同一个）
    best, bv = None, -1
    for k, v in needs.items():
        s = v + random.random() * 0.15
        if s > bv: bv = s; best = k
    a = NEED_MAP.get(best, 'other')
    if a not in ZONE_TYPES: a = 'other'
    return a

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('-n', type=int, default=3000)
    ap.add_argument('-o', default='tools/npc-policy/feed/sft_pretrain.csv')
    ap.add_argument('--seed', type=int, default=7)
    args = ap.parse_args()
    rng = random.Random(args.seed)

    rows = []
    for _ in range(args.n):
        needs = {k: rng.random() for k in NEED_MAP}
        hour = rng.uniform(0, 24)
        is_weekend = 0
        cur_zone = rng.choice(ZONE_TYPES) if rng.random() < 0.7 else None
        has_class = 1 if schedule_type(hour) == 'classroom' else 0
        near_friend = 1 if (cur_zone and rng.random() < 0.4) else 0
        player_near = 1 if rng.random() < 0.25 else 0
        action = decide(hour, needs, cur_zone, near_friend, player_near)
        # 非上课时段、且身边有人：偶尔改成聊天（增加多样性，避免全是"去区域"）
        if not has_class and (near_friend or player_near) and rng.random() < 0.12:
            action = 'chat_with'
        # 很累且非上课：偶尔原地休息
        if not has_class and needs['fatigue'] > 0.75 and rng.random() < 0.15:
            action = 'rest'
        x = {k: 0.0 for k in STATE_KEYS}
        for k in needs: x[k] = round(needs[k], 3)
        x['hour'] = round(hour, 2)
        x['isWeekend'] = is_weekend
        for zt in ZONE_TYPES: x['cur_' + zt] = 1 if zt == cur_zone else 0
        x['hasClass'] = has_class
        x['nearFriend'] = near_friend
        x['playerNear'] = player_near
        x['action'] = action
        x['weight'] = 1.0
        rows.append(x)

    os_mkdir = __import__('os').path.dirname(args.o)
    if os_mkdir: __import__('os').makedirs(os_mkdir, exist_ok=True)
    with open(args.o, 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.DictWriter(f, fieldnames=STATE_KEYS + ['action', 'weight'])
        w.writeheader()
        for r in rows: w.writerow(r)
    print(f"生成 {len(rows)} 行 → {args.o}")

if __name__ == '__main__':
    main()
