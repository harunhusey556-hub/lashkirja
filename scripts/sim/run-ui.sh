#!/bin/zsh
# Simulator walk of the native app against a throwaway demo API (see docs/quality/SIMULATOR.md).
# Runs on the Mac, from a checkout of `native`:
#   scripts/sim/run-ui.sh <simulator-udid> [only-testing, e.g. P0Tests/testA_ProfileSwipeBack] [tag]
# Screenshots and notes.txt land in $LK_SHOT_DIR (default: <repo>/sim-shots/<tag>).
#
# The Mac is shared: the script waits until no other project's xcodebuild runs and the load is low,
# because two simulator test runs at once on a small Mac time each other out.
set -u
U=${1:?simulator udid}; ONLY=${2:-}; TAG=${3:-walk}
REPO=$(cd "$(dirname "$0")/../.." && pwd)
APP="$REPO/ios-native/App"
SH=${LK_SHOT_DIR:-$REPO/sim-shots/$TAG}
API=${LK_API_BASE_URL:-http://127.0.0.1:3999}
CORES=$(sysctl -n hw.ncpu)

quiet=0
while true; do
  load=$(sysctl -n vm.loadavg | awk '{print int($2)}')
  if pgrep -f xcodebuild | xargs -I{} ps -o args= -p {} 2>/dev/null | grep -v "$APP" | grep -q xcodebuild; then quiet=0; else quiet=$((quiet+1)); fi
  if [ $quiet -ge 4 ] && [ $load -lt $((CORES * 2)) ]; then break; fi
  sleep 30
done

curl -s -o /dev/null --max-time 60 "$API/login" || { echo "API $API not reachable (tunnel down?)"; exit 2; }
# `simctl bootstatus -b` can hang for minutes on a busy Mac; poll the device state instead.
xcrun simctl boot "$U" 2>/dev/null
for i in {1..60}; do xcrun simctl list devices | grep "$U" | grep -q Booted && break; sleep 2; done
sleep 5

rm -rf "$SH" "$REPO/build-sim/$TAG.xcresult"; mkdir -p "$SH" "$REPO/build-sim"
# XCUIScreen screenshots time out on a headless simulator, so the test asks the host for them.
( while true; do for r in "$SH"/*.req(N); do n=${r:r}; xcrun simctl io "$U" screenshot "$n.png" >/dev/null 2>&1; rm -f "$r"; done; sleep 0.3; done ) &
W=$!
trap 'kill $W 2>/dev/null' EXIT

cd "$APP" && PATH=$HOME/bin:$PATH xcodegen generate -q
# Ad-hoc signing: an unsigned simulator build cannot use the Keychain, so sign-in would fail.
TEST_RUNNER_LK_SHOT_DIR="$SH" xcodebuild test -project LashKirja.xcodeproj -scheme LashKirja-UITests \
  -destination "id=$U" -derivedDataPath "$REPO/build-sim" \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO API_BASE_URL="$API" \
  ${ONLY:+-only-testing:LashKirjaUITests/$ONLY} -resultBundlePath "$REPO/build-sim/$TAG.xcresult" \
  > "$REPO/build-sim/$TAG.log" 2>&1
echo "EXIT=$?"
grep -E " error:|TEST (SUCCEEDED|FAILED)" "$REPO/build-sim/$TAG.log" | head -20
cat "$SH/notes.txt" 2>/dev/null
