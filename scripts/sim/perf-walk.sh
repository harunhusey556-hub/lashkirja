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
python3 "$REPO/scripts/sim/perf-medians.py" "$OUT"
