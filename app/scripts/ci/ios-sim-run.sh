#!/usr/bin/env bash
# Runs the built simulator app end to end on the macOS runner and collects
# evidence. Used only by .github/workflows/ios-sim-check.yml, after the API
# server is already listening on 127.0.0.1:3000.
#
#   APP_PATH   the built App.app (Debug-iphonesimulator)
#   OUT        artifact directory
#   ROUTES     comma-separated routes for the autopilot
#   DEVICE     optional simulator name ("iPhone 16 Pro"); empty = newest iPhone
#
# Evidence: screenshots/ (one per autopilot step), run.mp4 (whole run),
# steps.jsonl (per-step layout metrics measured inside WKWebView),
# webview-console.log, app-stdout.log / app-stderr.log (Capacitor's native
# console bridge), device.log (os_log of the app and WebKit), device.txt,
# launch-screen.txt (how dark the first seconds of each launch are).
#
# The job fails when a launch does not finish in time, when the autopilot
# reports any problem (done-*.json "problems"), or when the built app does
# not register the lashkirja:// scheme.
set -uo pipefail

: "${APP_PATH:?}" "${OUT:?}" "${ROUTES:?}"
DEVICE="${DEVICE:-}"
BUNDLE_ID="fi.tiyouba.lashkirja"
FIRST_TIMEOUT="${FIRST_TIMEOUT:-600}"
RELAUNCH_TIMEOUT="${RELAUNCH_TIMEOUT:-120}"
mkdir -p "$OUT/screenshots"
# Absolute: `simctl launch --stdout` resolves a relative path inside the
# simulated device, not in this directory.
OUT="$(cd "$OUT" && pwd)"
SDK_VERSION="${SIM_SDK_VERSION:-}"

# ---- Pick a simulator: the runtime that matches the Xcode SDK (else the
# newest one not newer than it), then the requested name, else the
# highest-numbered iPhone, preferring a plain "Pro" (Dynamic Island).
xcrun simctl list devices available -j > "$OUT/simctl-devices.json"
PICK=$(DEVICE="$DEVICE" SDK_VERSION="$SDK_VERSION" node -e '
const data = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).devices;
const wanted = process.env.DEVICE || "";
const sdk = (process.env.SDK_VERSION || "").split(".").map(Number);
const sdkVersion = sdk.length >= 2 && !Number.isNaN(sdk[0]) ? sdk[0] * 100 + (sdk[1] || 0) : Infinity;
let best = null;
for (const [runtime, devices] of Object.entries(data)) {
  const m = runtime.match(/SimRuntime\.iOS-(\d+)-(\d+)/);
  if (!m) continue;
  const version = Number(m[1]) * 100 + Number(m[2]);
  if (version > sdkVersion) continue;
  for (const d of devices) {
    if (!d.isAvailable || !/^iPhone/.test(d.name)) continue;
    if (wanted && d.name !== wanted) continue;
    const num = Number((d.name.match(/^iPhone (\d+)/) || [0, 0])[1]);
    const kind = /^iPhone \d+ Pro$/.test(d.name) ? 3 : /^iPhone \d+$/.test(d.name) ? 2 : 1;
    const score = version * 100000 + num * 10 + kind;
    if (!best || score > best.score) best = { score, udid: d.udid, name: d.name, runtime };
  }
}
if (!best) { console.error("no available iPhone simulator" + (wanted ? " named " + wanted : "")); process.exit(1); }
console.log([best.udid, best.name, best.runtime.replace(/^.*SimRuntime\./, "")].join("|"));
' "$OUT/simctl-devices.json") || exit 1
UDID="${PICK%%|*}"
REST="${PICK#*|}"
DEVICE_NAME="${REST%%|*}"
RUNTIME="${REST#*|}"
echo "Simulator: $DEVICE_NAME ($RUNTIME) $UDID; Xcode SDK iphonesimulator $SDK_VERSION" | tee "$OUT/device.txt"

# ---- Boot, clean status bar, light appearance, install.
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b
# SpringBoard can still be settling after bootstatus returns.
sleep 10
xcrun simctl ui "$UDID" appearance light || true
xcrun simctl status_bar "$UDID" override --time "9:41" --batteryState charged --batteryLevel 100 \
  --cellularMode active --cellularBars 4 --wifiBars 3 || true
xcrun simctl install "$UDID" "$APP_PATH"

# ---- Step server (screenshots in lockstep with the autopilot).
npx tsx scripts/ci/sim-step-server.ts --udid "$UDID" --out "$OUT" --routes "$ROUTES" \
  > "$OUT/step-server.log" 2>&1 &
STEP_PID=$!
for _ in $(seq 1 60); do
  if curl -s -o /dev/null -X POST http://127.0.0.1:3999/log -d '{"level":"runner","text":"step server up"}'; then break; fi
  sleep 1
done

# ---- Device log (the app process and WebKit's processes).
xcrun simctl spawn "$UDID" log stream --style compact --level debug \
  --predicate 'process == "App" OR process BEGINSWITH "com.apple.WebKit"' \
  > "$OUT/device.log" 2>&1 &
LOG_PID=$!

# ---- Screen recording of the whole run.
xcrun simctl io "$UDID" recordVideo --codec=h264 --force "$OUT/run.mp4" > "$OUT/record.log" 2>&1 &
REC_PID=$!
sleep 3

wait_for() {
  local file="$1" timeout="$2" waited=0
  while [[ ! -f "$file" && "$waited" -lt "$timeout" ]]; do
    sleep 2
    waited=$((waited + 2))
    if (( waited % 30 == 0 )); then
      echo "  ...${waited}s, last step: $(tail -n 1 "$OUT/step-server.log" 2>/dev/null)"
    fi
  done
  [[ -f "$file" ]]
}

# Screenshots of the first seconds of a launch, before the web app paints:
# the system launch screen, then the SplashScreen plugin's copy of it. Both
# must be the canvas colour with the icon, never black.
capture_launch() {
  local prefix="$1" i
  for i in $(seq -w 1 12); do
    xcrun simctl io "$UDID" screenshot --type=png "$OUT/screenshots/$prefix-launch-$i.png" >/dev/null 2>&1 || true
    sleep 0.4
  done
}

# Luminance of each early frame -> launch-screen.txt. A dark frame is a
# ::warning::, not a failure: the home screen can be caught mid-zoom.
measure_launch() {
  local prefix="$1" file bmp
  for file in "$OUT/screenshots/$prefix"-launch-*.png; do
    [[ -f "$file" ]] || continue
    bmp="$OUT/$(basename "${file%.png}").bmp"
    if sips -s format bmp "$file" --out "$bmp" >/dev/null 2>&1; then
      python3 scripts/ci/launch-luminance.py "$bmp" "$(basename "$file")" >> "$OUT/launch-screen.txt" 2>&1 || true
    fi
    rm -f "$bmp"
  done
  if grep -q "^$prefix-launch.*DARK" "$OUT/launch-screen.txt" 2>/dev/null; then
    echo "::warning::A $prefix launch frame is mostly dark; see launch-screen.txt and screenshots/$prefix-launch-*.png"
  fi
}

launch_app() {
  local suffix="$1" attempt
  for attempt in 1 2 3; do
    # NSUnbufferedIO=YES (what Xcode sets when it runs an app): stdout is a
    # file here, so Swift's print was block-buffered and a short run such as
    # the relaunch never flushed it (app-stdout-relaunch.log was empty).
    if SIMCTL_CHILD_NSUnbufferedIO=YES xcrun simctl launch --terminate-running-process \
      --stdout="$OUT/app-stdout$suffix.log" --stderr="$OUT/app-stderr$suffix.log" "$UDID" "$BUNDLE_ID"; then
      return 0
    fi
    echo "launch attempt $attempt failed; retrying"
    sleep 10
  done
  return 1
}

# ---- First launch: log in, walk the routes, open the sheets, then sign out
# and walk the chat onboarding with the not-onboarded user.
FIRST_OK=0
capture_launch "first" &
CAPTURE_PID=$!
if launch_app ""; then
  if wait_for "$OUT/done-first.json" "$FIRST_TIMEOUT"; then FIRST_OK=1; fi
else
  echo "::error::simctl could not launch the app"
fi
wait "$CAPTURE_PID" 2>/dev/null || true
measure_launch "first"
xcrun simctl io "$UDID" screenshot --type=png "$OUT/screenshots/zz-final-first.png" || true

# ---- Cold relaunch: the Keychain session must skip the login form.
RELAUNCH_OK=0
if [[ "$FIRST_OK" == 1 ]]; then
  xcrun simctl terminate "$UDID" "$BUNDLE_ID" || true
  sleep 2
  capture_launch "relaunch" &
  CAPTURE_PID=$!
  if launch_app "-relaunch" && wait_for "$OUT/done-relaunch.json" "$RELAUNCH_TIMEOUT"; then RELAUNCH_OK=1; fi
  wait "$CAPTURE_PID" 2>/dev/null || true
  measure_launch "relaunch"
fi

# ---- Deep link: what this run proves, and what it does not.
# Proven: the built app registers lashkirja:// (a hard check below), and iOS
# resolves the scheme to this app: `simctl openurl` succeeds and iOS shows
# its "Open in LashKirja?" prompt (zz-after-openurl.png).
# NOT proven: that the app handles the URL after "Open". Accepting the
# system prompt needs a SpringBoard tap this runner cannot make without
# extra tooling (idb), so the harness makes no deep-link handling claim.
SCHEME_OK=0
if /usr/libexec/PlistBuddy -c "Print :CFBundleURLTypes" "$APP_PATH/Info.plist" > "$OUT/url-types.txt" 2>&1 \
  && grep -q "lashkirja" "$OUT/url-types.txt"; then
  SCHEME_OK=1
fi
xcrun simctl openurl "$UDID" "lashkirja://dashboard" > "$OUT/openurl.log" 2>&1 || true
sleep 4
xcrun simctl io "$UDID" screenshot --type=png "$OUT/screenshots/zz-after-openurl.png" || true

# ---- Stop the recording cleanly (SIGINT finalises the mp4), then the rest.
kill -INT "$REC_PID" 2>/dev/null || true
wait "$REC_PID" 2>/dev/null || true
kill "$LOG_PID" "$STEP_PID" 2>/dev/null || true
find ~/Library/Logs/DiagnosticReports -name 'App*' -newer "$OUT/device.txt" -exec cp {} "$OUT/" \; 2>/dev/null || true

if [[ ! -s "$OUT/app-stdout-relaunch.log" ]]; then
  echo "::warning::app-stdout-relaunch.log is empty: the relaunch console was not captured"
fi

# Problems the autopilot reported fail the job: a walk that finished with a
# timeout, a missing button or a failed save is not a green run. Prints the
# count; an unreadable file counts as one problem.
count_problems() {
  node -e '
    const fs = require("fs");
    const path = require("path");
    const file = process.argv[1];
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const problems = Array.isArray(data.problems) ? data.problems : [];
    for (const problem of problems) {
      console.error(`::error::${path.basename(file)}: ${String(problem).split("\n")[0]}`);
    }
    console.log(problems.length);
  ' "$1" || echo 1
}

echo "first launch done: $FIRST_OK, relaunch done: $RELAUNCH_OK, lashkirja:// registered: $SCHEME_OK"
[[ "$FIRST_OK" == 1 ]] || { echo "::error::The autopilot did not finish the first launch within ${FIRST_TIMEOUT}s"; exit 1; }
[[ "$RELAUNCH_OK" == 1 ]] || { echo "::error::The autopilot did not finish the cold relaunch within ${RELAUNCH_TIMEOUT}s"; exit 1; }
PROBLEMS=0
for phase in first relaunch; do
  n=$(count_problems "$OUT/done-$phase.json" | tail -n 1)
  [[ "$n" =~ ^[0-9]+$ ]] || n=1
  PROBLEMS=$((PROBLEMS + n))
done
[[ "$PROBLEMS" == 0 ]] || { echo "::error::The autopilot reported $PROBLEMS problem(s); see done-*.json"; exit 1; }
[[ "$SCHEME_OK" == 1 ]] || { echo "::error::The built app does not register the lashkirja:// scheme (url-types.txt)"; exit 1; }
exit 0
