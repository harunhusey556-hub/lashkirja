#!/usr/bin/env bash
# Simulator motion audit in one command, from the Windows PC (docs/quality/SIMULATOR.md §4):
#   scripts/sim/motion-audit.sh [--head] [--no-sync | --sync-only | --collect] [suite ...]
#   e.g. test00_Calibration test01_Koti (default: the whole class as one run, "all"). --collect only waits for and copies
#   back runs already started (when the caller's shell gave up waiting), then analyzes.
# 1. Snapshots this worktree (uncommitted changes too, never .mono) and sends it to the iMac as a
#    git bundle: the iMac has no GitHub credentials.
# 2. Runs MotionAuditTests suite by suite through run-ui.sh (which builds, records and serves the
#    .rec/.req channel), one simulator run at a time.
# 3. Copies videos, steps.json and probe.log back and runs motion-audit.py over them.
# Needs the demo API on :3999 and the reverse tunnel (SIMULATOR.md §1-2) already up.
set -euo pipefail
UDID=${LK_SIM_UDID:-9D2F3A52-4B81-4EB3-B6FF-0C457695BB90}
REMOTE=${LK_REMOTE_DIR:-LashKirja/motion-sim}
REPO=$(cd "$(dirname "$0")/../.." && pwd)
OUT=${LK_MOTION_OUT:-sim-shots/motion}  # relative to the repo: Windows Python cannot read /c/... paths
SYNC=1; RUN=1; SYNC_ONLY=0; HEAD_ONLY=0
while [ $# -gt 0 ]; do case $1 in --no-sync) SYNC=0; shift;; --collect) SYNC=0; RUN=0; shift;; --sync-only) SYNC_ONLY=1; shift;; --head) HEAD_ONLY=1; shift;; *) break;; esac; done
SUITES=("$@")
# No suite named: the whole class in one run (one build check, one sign-in), as "all".
[ ${#SUITES[@]} -gt 0 ] || SUITES=(all)

cd "$REPO"
if [ $SYNC = 1 ]; then
# A commit of the working tree made through a throwaway index: HEAD and the real index stay as they are.
idx=$(mktemp)
GIT_INDEX_FILE=$idx git read-tree HEAD
GIT_INDEX_FILE=$idx git add -A  # .mono is ignored
snap=$(git commit-tree "$(GIT_INDEX_FILE=$idx git write-tree)" -p HEAD -m "motion-audit snapshot")
# --head: the last commit only (a "before" run while fixes wait uncommitted).
[ $HEAD_ONLY = 1 ] && snap=$(git rev-parse HEAD)
rm -f "$idx"
git update-ref refs/motion-audit/snapshot "$snap"
mkdir -p build-sim; bundle=build-sim/motion-audit.bundle  # relative: git and scp read /tmp differently on Windows
git bundle create -q "$bundle" refs/motion-audit/snapshot
scp -q "$bundle" imac:/tmp/lk-motion.bundle
rm -f "$bundle"
ssh imac "set -e; mkdir -p ~/$REMOTE; cd ~/$REMOTE; [ -d .git ] || git init -q
  git fetch -q /tmp/lk-motion.bundle refs/motion-audit/snapshot
  git checkout -q -f --detach FETCH_HEAD; git clean -fdq -e sim-shots -e build-sim; rm -f /tmp/lk-motion.bundle"
echo "iMac ~/$REMOTE at snapshot ${snap:0:10}"
[ $SYNC_ONLY = 1 ] && exit 0
fi

mkdir -p "$OUT"
for suite in "${SUITES[@]}"; do
  tag="motion-$suite"
  only=MotionAuditTests; [ "$suite" = all ] || only="MotionAuditTests/$suite"
  echo "== $suite"
  # Detached on the Mac (a dropped ssh must not kill a 20-minute build); this side polls.
  [ $RUN = 1 ] && ssh imac "cd ~/$REMOTE && mkdir -p build-sim && rm -f build-sim/$tag.run &&
    nohup scripts/sim/run-ui.sh $UDID $only $tag > build-sim/$tag.run 2>&1 < /dev/null &"
  until ssh imac "grep -q '^EXIT=' ~/$REMOTE/build-sim/$tag.run 2>/dev/null"; do sleep 20; done
  ssh imac "tail -30 ~/$REMOTE/build-sim/$tag.run"
  # Where the simulator app could not write to the host path, the probe log is in its container.
  ssh imac "cd ~/$REMOTE/sim-shots/$tag 2>/dev/null && [ -s probe.log ] || {
    c=\$(xcrun simctl get_app_container $UDID fi.tiyouba.lashkirja data 2>/dev/null) && cp \"\$c/tmp/motion-probe.log\" probe.log; }" || true
  rm -rf "${OUT:?}/$suite"
  scp -q -r "imac:~/$REMOTE/sim-shots/$tag" "$OUT/$suite" || echo "nothing to copy for $suite"
done

python scripts/sim/motion-audit.py "$OUT"
