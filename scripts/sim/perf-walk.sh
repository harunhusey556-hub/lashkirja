#!/bin/zsh
# Timing walk (w35): PerfWalkTests on one simulator, then the app's own `perf <kind> <row> <ms>`
# lines (subsystem fi.lashkirja.perf) read from the simulator log, median per row over rounds 1-3
# (round 0 is the warm-up). Needs the demo API as for run-ui.sh (docs/quality/SIMULATOR.md).
#   scripts/sim/perf-walk.sh <simulator-udid> [tag]
# Results: build-sim/perf/<tag>/perf.ndjson (raw log), rows.txt (every figure), medians.txt.
set -u
U=${1:?simulator udid}; TAG=${2:-perf}
REPO=$(cd "$(dirname "$0")/../.." && pwd)
OUT="$REPO/build-sim/perf/$TAG"
rm -rf "$OUT"; mkdir -p "$OUT"
START=$(date '+%Y-%m-%d %H:%M:%S')
LK_SHOT_DIR="$OUT" "$REPO/scripts/sim/run-ui.sh" "$U" PerfWalkTests/testPerfWalk "$TAG"
xcrun simctl spawn "$U" log show --start "$START" --style ndjson \
  --predicate 'subsystem == "fi.lashkirja.perf" AND category == "Waits"' > "$OUT/perf.ndjson"
python3 - "$OUT" <<'PY'
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
PY
