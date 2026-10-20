#!/usr/bin/env python3
"""Medians of a timing walk (w35). <dir> holds notes.txt (the walk's "ROUND n <epoch>" lines) and
perf.ndjson (`log show --style ndjson` of subsystem fi.lashkirja.perf). Writes rows.txt (every
figure with its round) and medians.txt (per row: the first figure after each launch, rounds 1-3)."""
import json, sys, statistics, datetime
out = sys.argv[1]
rounds = []
for line in open(f"{out}/notes.txt"):
    if line.startswith("ROUND "):
        _, n, at = line.split()
        rounds.append((float(at), int(n)))
def round_of(ts):
    current = None
    for at, n in rounds:
        if ts >= at: current = n
    return current
figures = {}
with open(f"{out}/rows.txt", "w") as rows:
    for line in open(f"{out}/perf.ndjson"):
        try: e = json.loads(line)
        except ValueError: continue
        msg = e.get("eventMessage", "")
        if not msg.startswith("perf "): continue
        _, kind, row, ms = msg.split()
        ts = datetime.datetime.strptime(e["timestamp"][:26], "%Y-%m-%d %H:%M:%S.%f").timestamp()
        r = round_of(ts)
        rows.write(f"{r} {kind} {row} {ms}\n")
        # The first figure of a row in a round: the first visit after that launch.
        if r: figures.setdefault((kind, row), {}).setdefault(r, int(ms))
with open(f"{out}/medians.txt", "w") as med:
    for (kind, row), per in sorted(figures.items()):
        values = [per[r] for r in sorted(per)]
        med.write(f"{kind:7} {row:12} median {int(statistics.median(values)):6} ms  runs {values}\n")
print(open(f"{out}/medians.txt").read())
