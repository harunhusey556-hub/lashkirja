"""Motion gate over three motion-report.json files (.github/workflows/ios-motion-gate.yml).
A row is suite/step/check. NEW FAIL = PASS in the baseline and FAIL (or crash) in both PR runs, so
one noisy run neither fails nor clears a row.
usage: motion-gate.py <baseline.json> <pr-run1.json> <pr-run2.json>"""
import json, sys
KS = ['intermediate', 'flash', 'shift_video', 'shift_probe']

def rows(path):
    out = {}
    for r in json.load(open(path, encoding='utf-8')):
        for k in KS:
            v = r['checks'][k]
            if r.get('crashed'): v = 'CRASH'
            out[(r['suite'], r['id'], k)] = v
    return out

b, p1, p2 = (rows(p) for p in sys.argv[1:4])
keys = sorted(set(b) | set(p1) | set(p2))
new = [k for k in keys if b.get(k) == 'PASS' and p1.get(k) in ('FAIL', 'CRASH') and p2.get(k) in ('FAIL', 'CRASH')]
fixed = [k for k in keys if b.get(k) in ('FAIL', 'CRASH') and p1.get(k) == 'PASS' and p2.get(k) == 'PASS']
for name, d in (('baseline', b), ('pr-run1', p1), ('pr-run2', p2)):
    print(f"{name}: " + ", ".join(f"{k} {sum(1 for x, v in d.items() if x[2] == k and v == 'FAIL')}" for k in KS)
          + f", crashed {len({x[:2] for x, v in d.items() if v == 'CRASH'})}, steps {len({x[:2] for x in d})}")
print(f"\nNEW FAIL (PASS in baseline, FAIL in both PR runs): {len(new)}")
print(f"FIXED (FAIL in baseline, PASS in both PR runs): {len(fixed)}\n")
print("| suite | step | check | baseline | pr-run1 | pr-run2 | gate |\n|---|---|---|---|---|---|---|")
for k in keys:
    vals = [d.get(k, '-') for d in (b, p1, p2)]
    if all(v in ('PASS', 'n/a', '-') for v in vals):
        continue
    gate = 'NEW FAIL' if k in new else 'fixed' if k in fixed else ''
    print(f"| {k[0]} | {k[1]} | {k[2]} | " + " | ".join(vals) + f" | {gate} |")
