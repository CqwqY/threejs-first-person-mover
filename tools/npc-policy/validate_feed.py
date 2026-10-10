#!/usr/bin/env python3
# 投喂数据校验：在你跑 train.py 之前，先确认格式对、动作合法、数值在范围里。
#   python tools/npc-policy/validate_feed.py tools/npc-policy/feed
# 也支持直接传文件。输出统计 + 坏行清单，坏行不进训练（train.py 同样是跳过）。
import sys, os, csv, json

STATE_KEYS = ['hunger','fatigue','fun','study','social','bladder','hour','isWeekend',
              'cur_classroom','cur_canteen','cur_playground','cur_library','cur_shop','cur_dorm',
              'cur_toilet','cur_gate','cur_fountain','cur_other','hasClass','nearFriend','playerNear']
ACTIONS = ['classroom','canteen','playground','library','shop','dorm','toilet','gate','fountain','other',
           'wander','rest','chat_with','follow_player','help_player']
A2I = set(ACTIONS)
HOUR_KEYS = {'hour'}

def check_row(r, is_pref):
    errs = []
    for k in STATE_KEYS:
        if k not in r or r[k] in (None, ''):
            errs.append(f"缺字段 {k}"); continue
        try: fv = float(r[k])
        except Exception: errs.append(f"{k} 非数字: {r[k]}"); continue
        if k == 'hour':
            if not (0 <= fv <= 24): errs.append(f"hour 超出 [0,24]: {fv}")
        else:
            if not (0 <= fv <= 1): errs.append(f"{k} 应 ∈ [0,1]: {fv}")
    if is_pref:
        for col in ('chosen', 'rejected'):
            if str(r.get(col, '')).strip() not in A2I: errs.append(f"{col} 动作非法: {r.get(col)}")
    else:
        if str(r.get('action', '')).strip() not in A2I: errs.append(f"action 动作非法: {r.get('action')}")
    return errs

def main():
    paths = sys.argv[1:] or ['feed']
    files = []
    for p in paths:
        if os.path.isdir(p):
            files += [os.path.join(p, fn) for fn in sorted(os.listdir(p)) if fn.endswith(('.csv', '.json'))]
        else:
            files.append(p)
    total_bc = total_pref = bad = 0
    action_counts = {}
    for fp in files:
        ext = os.path.splitext(fp)[1].lower()
        rows = []
        if ext == '.csv':
            with open(fp, newline='', encoding='utf-8-sig') as f:
                for r in csv.DictReader(f): rows.append(r)
        else:
            with open(fp, encoding='utf-8') as f:
                d = json.load(f); rows = d if isinstance(d, list) else d.get('rows', [])
        is_pref = any('chosen' in r and 'rejected' in r for r in rows)
        for r in rows:
            errs = check_row(r, is_pref)
            if errs:
                bad += 1
                if bad <= 20: print(f"  [坏] {os.path.basename(fp)}: {errs[:2]}")
                continue
            if is_pref:
                total_pref += 1
            else:
                total_bc += 1
                a = str(r.get('action', '')).strip()
                action_counts[a] = action_counts.get(a, 0) + 1
    print(f"\n统计：SFT {total_bc} 行，偏好对 {total_pref} 对，坏行 {bad}")
    if action_counts:
        print("动作分布：")
        for a in ACTIONS:
            if action_counts.get(a): print(f"  {a:14s} {action_counts[a]}")
    if bad: print("⚠ 有坏行未计入训练"); sys.exit(1)
    print("✓ 全部通过")

if __name__ == '__main__':
    main()
