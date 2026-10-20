"""Motion gate over three motion-report.json files (.github/workflows/ios-motion-gate.yml).
A row is suite/step/check. NEW FAIL = PASS in the baseline and FAIL (or crash) in both PR runs, so
one noisy run neither fails nor clears a row. FIXED = a real FAIL in the baseline and PASS in both
PR runs: a check that saw nothing (NO-MOTION, UNREACHED, SKIPPED, 'n/a (no settle)', no row) never
fixes anything. NEW MISS = judged (PASS or FAIL) in the baseline and judged in neither PR run: the
branch lost what the gate could see, so the gate exits 1. So does a walk with no step at all: three
empty reports compare as equal (F003, run 39355446040: the scripts stopped at once, the job passed).
usage: motion-gate.py <baseline.json> <pr-run1.json> <pr-run2.json>"""
import json, sys
KS = ['intermediate', 'flash', 'shift_video', 'shift_probe']
MISSES = ['NO-MOTION', 'UNREACHED', 'SKIPPED', 'n/a (no settle)']

def rows(path):
    out = {}
    for r in json.load(open(path, encoding='utf-8')):
        for k in KS:
            v = r['checks'][k]
            if r.get('crashed'): v = 'CRASH'
            out[(r['suite'], r['id'], k)] = v
    return out

def gate(b, p1, p2):
    keys = sorted(set(b) | set(p1) | set(p2))
    new = [k for k in keys if b.get(k) == 'PASS' and p1.get(k) in ('FAIL', 'CRASH') and p2.get(k) in ('FAIL', 'CRASH')]
    fixed = [k for k in keys if b.get(k) == 'FAIL' and p1.get(k) == 'PASS' and p2.get(k) == 'PASS']
    seen = ('PASS', 'FAIL', 'CRASH')
    miss = [k for k in keys if b.get(k) in ('PASS', 'FAIL') and p1.get(k, '-') not in seen and p2.get(k, '-') not in seen]
    return keys, new, fixed, miss

def main(argv):
    b, p1, p2 = (rows(p) for p in argv[1:4])
    keys, new, fixed, miss = gate(b, p1, p2)
    for name, d in (('baseline', b), ('pr-run1', p1), ('pr-run2', p2)):
        print(f"{name}: " + ", ".join(f"{k} {sum(1 for x, v in d.items() if x[2] == k and v == 'FAIL')}" for k in KS)
              + f", crashed {len({x[:2] for x, v in d.items() if v == 'CRASH'})}, steps {len({x[:2] for x in d})}; not judged: "
              + ", ".join(f"{m} {len({x[:2] for x, v in d.items() if v == m})}" for m in MISSES))
    print(f"\nNEW FAIL (PASS in baseline, FAIL in both PR runs): {len(new)}")
    print(f"FIXED (FAIL in baseline, PASS in both PR runs): {len(fixed)}")
    print(f"NEW MISS (judged in baseline, in neither PR run): {len(miss)}\n")
    empty = [name for name, d in (('baseline', b), ('pr-run1', p1), ('pr-run2', p2)) if not d]
    if empty:
        print(f"NO WALK: {', '.join(empty)} judged no step, so there is nothing to compare\n")
    print("| suite | step | check | baseline | pr-run1 | pr-run2 | gate |\n|---|---|---|---|---|---|---|")
    for k in keys:
        vals = [d.get(k, '-') for d in (b, p1, p2)]
        if all(v in ('PASS', 'n/a', '-') for v in vals) and k not in miss:
            continue
        mark = 'NEW FAIL' if k in new else 'fixed' if k in fixed else 'NEW MISS' if k in miss else ''
        print(f"| {k[0]} | {k[1]} | {k[2]} | " + " | ".join(vals) + f" | {mark} |")
    return 1 if miss or empty else 0

if __name__ == '__main__':
    sys.exit(main(sys.argv))
