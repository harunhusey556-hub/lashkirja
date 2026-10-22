"""Motion gate over three motion-report.json files (.github/workflows/ios-motion-gate.yml).
A row is suite/step/check. NEW FAIL = PASS in the baseline and FAIL (or crash) in both PR runs, so
one noisy run neither fails nor clears a row; it is listed for the PR's review and does not fail
the job, as its summary line says. FIXED = a real FAIL in the baseline and PASS in both
PR runs: a check that saw nothing (NO-MOTION, UNREACHED, SKIPPED, 'n/a (no settle)', no row) never
fixes anything. NEW MISS = judged (PASS or FAIL) in the baseline and judged in neither PR run: the
branch lost what the gate could see, so the gate exits 1. So does a walk with no step at all: three
empty reports compare as equal (F003, run 39355446040: the scripts stopped at once, the job passed).
So does a launch row ("prebuild") that PASSes in the baseline and FAILs in both PR runs: a tab copy kept alive is no flaky check.
usage: motion-gate.py <baseline.json> <pr-run1.json> <pr-run2.json>"""
import json, sys
KS = ['intermediate', 'flash', 'shift_video', 'shift_probe', 'stall']
# The walk's launch row (motion-audit.py prebuild_row), judged like a step's checks.
LAUNCH = ['prebuild']
MISSES = ['NO-MOTION', 'UNREACHED', 'SKIPPED', 'MISS-WINDOW', 'NO-TOUCH', 'n/a (no settle)']

def rows(path):
    out = {}
    for r in json.load(open(path, encoding='utf-8')):
        for k in KS + LAUNCH:
            # A report from before the stall check has no row for it.
            if k not in r['checks']: continue
            v = r['checks'][k]
            if r.get('crashed'): v = 'CRASH'
            out[(r['suite'], r['id'], k)] = v
    return out

def judged(d):
    """The steps a walk judged: its launch row says nothing of whether the walk ran."""
    return {x[:2] for x in d if x[2] in KS}

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
              + f", crashed {len({x[:2] for x, v in d.items() if v == 'CRASH'})}, steps {len(judged(d))}; not judged: "
              + ", ".join(f"{m} {len({x[:2] for x, v in d.items() if v == m})}" for m in MISSES))
    print("tab copies kept alive after launch: " + ", ".join(
        f"{name} {len({x[:2] for x, v in d.items() if x[2] == 'prebuild' and v == 'FAIL'})}" for name, d in (('baseline', b), ('pr-run1', p1), ('pr-run2', p2))))
    print(f"\nNEW FAIL (PASS in baseline, FAIL in both PR runs; listed for review, the job does not fail on it): {len(new)}")
    print(f"FIXED (FAIL in baseline, PASS in both PR runs): {len(fixed)}")
    print(f"NEW MISS (judged in baseline, in neither PR run): {len(miss)}\n")
    # Not a noisy check: a tab copy is released or it is not. Kept in both PR walks where the baseline
    # released it fails the job. Kept in the baseline too is the open M086 (CI showed the Myynti window
    # held on every launch while the iMac freed it): listed, so every gate does not go red over it.
    both = [k for k in keys if k[2] == 'prebuild' and p1.get(k) == 'FAIL' and p2.get(k) == 'FAIL']
    kept = [k for k in both if b.get(k) != 'FAIL']
    if kept:
        print(f"PREBUILD: a tab copy was kept alive after launch in both PR walks ({', '.join(k[0] for k in kept)}); this fails the job\n")
    if len(both) > len(kept):
        print(f"PREBUILD: a tab copy kept alive before and after ({', '.join(k[0] for k in both if k not in kept)}), the open M086; listed, the job does not fail on it\n")
    empty = [name for name, d in (('baseline', b), ('pr-run1', p1), ('pr-run2', p2)) if not judged(d)]
    if empty:
        print(f"NO WALK: {', '.join(empty)} judged no step, so there is nothing to compare\n")
    print("| suite | step | check | baseline | pr-run1 | pr-run2 | gate |\n|---|---|---|---|---|---|---|")
    for k in keys:
        vals = [d.get(k, '-') for d in (b, p1, p2)]
        if all(v in ('PASS', 'n/a', '-') for v in vals) and k not in miss:
            continue
        mark = 'NEW FAIL' if k in new else 'fixed' if k in fixed else 'NEW MISS' if k in miss else ''
        print(f"| {k[0]} | {k[1]} | {k[2]} | " + " | ".join(vals) + f" | {mark} |")
    return 1 if miss or empty or kept else 0

if __name__ == '__main__':
    sys.exit(main(sys.argv))
