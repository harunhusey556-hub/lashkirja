# Simulator walk (native app)

The native app is checked end to end in the iOS Simulator on the iMac, against a throwaway
demo API. Never against production, never with real credentials.

## 1. Demo API on the Windows PC

A clean checkout with no `.env`, so nothing can reach real data or send real mail:

```bash
git worktree add --detach C:/Users/Hhusey/lk-simserver native   # once
cd C:/Users/Hhusey/lk-simserver/app && npm ci && npx prisma generate
export DATABASE_URL="file:./sim-demo.db"
rm -f sim-demo.db && npx prisma migrate deploy && npx tsx scripts/demo-seed.ts --ci
SESSION_SECRET=$(openssl rand -hex 32) CRON_SECRET=$(openssl rand -hex 16) \
  ENABLEBANKING_ENABLED=false npx next dev -H 127.0.0.1 -p 3999
```

## 2. Tunnel to the iMac

`ssh -o ExitOnForwardFailure=yes -N -R 127.0.0.1:3999:127.0.0.1:3999 imac`.
The API is then `http://127.0.0.1:3999` on the iMac only (loopback, so ATS allows plain http).

## 3. Run the walk on the iMac

```bash
ssh imac 'cd ~/LashKirja/native-sim && git pull -q && scripts/sim/run-ui.sh <udid> "" p0'
```

- Use your own simulator devices (`xcrun simctl create "LK-P0 iPhone 17" …`), never one another
  agent has booted. The script waits until no other project's xcodebuild runs.
- Results: `sim-shots/<tag>/notes.txt` (PASS/FAIL lines) and one screenshot per step.
- Checks are recorded, not asserted. Open the screenshot behind every PASS before trusting it:
  text anchors can match the screen behind a sheet.
- Demo login: `demo@lashkirja.fi` (from `app/scripts/demo-seed.ts`).
- Offline: stop the tunnel mid-run; the app should show its offline state and recover.

## 4. Motion audit (screen changes, flashes, layout shift)

One command from the Windows PC, with §1 and §2 running:

```bash
scripts/sim/motion-audit.sh                       # every suite, ~1 h on the iMac
scripts/sim/motion-audit.sh test01_Koti           # one suite
scripts/sim/motion-audit.sh --collect test01_Koti # a run already started: wait, copy back, analyze
```

- It sends this worktree (uncommitted changes too) to `~/LashKirja/motion-sim` on the iMac as a git
  bundle, runs `MotionAuditTests/<suite>` there through `run-ui.sh` (detached, so a dropped ssh does
  not kill the build), copies `sim-shots/motion-<suite>` back to `sim-shots/motion/<suite>` and runs
  `scripts/sim/motion-audit.py`, which writes `sim-shots/motion/motion-report.md` and `.json`, with a
  contact sheet PNG per step (red frame = the frame a check flagged).
- Each step asks the host for a video through the walk's file channel: `<name>.rec` holds the
  longest it may run (30 s), `run-ui.sh` runs `simctl io recordVideo` and writes `<name>.recording`
  (start and stop epoch) once the recording really runs; the test taps only then, and ends the
  recording with `<name>.stop` once the step's result is filmed (its `seconds` past the action, and
  past a sheet's `MARK presented`). `steps.json` lists every step (from, action, to, kind, expected
  result, when its element was found, the tap went out and the app's probe saw the touch), and
  `xcui.log` the stretches XCUITest drove the app, so a main-thread stall can be told apart.
- The app, launched with `-LKMotionAudit` (Debug only), runs `MotionProbe`: ten times a second it
  reads every layer's frame in its scroll view's content coordinates and logs any move over 2 pt to
  `probe.log`, with the screen's name (`.motionProbe(...)` on tabs, pushed routes and the shell's
  sheets). The analyzer calls a move after the step's layout went quiet a late layout shift.
- The Haswell simulator writes ~4 frames a second and only when the screen changes, so the video
  catches an intermediate screen, a flash or a late jump (each lasts at least one frame) but not
  fine jank. Jank is for Instruments: signposts `Motion/settle` and `Screens/first-paint` on a device.
- Checks and thresholds are in the analyzer's docstring; the calibration (known good and known bad
  steps in `test00_Calibration`) is stated at the top of every report.
- Each suite's launch is also a row, `prebuild-freed`: the tab copies the app builds and throws away
  after launch (`Shell/TabPrebuild.swift`) must be gone 2 s later (`MARK prebuild-<tab>-freed=...`
  in `probe.log`; `MARK prebuild-<tab>-late=` is the same look 10 s on). A tab the baseline built and
  released but both PR walks kept fails the gate job; a tab kept before and after (the open M086) or
  one the baseline never built (whether a tab is prebuilt depends on timing) is listed only. With `LK_RETAIN_TRACE=1` (the workflow's `retain_trace` input) `run-ui.sh`
  also saves `retain-prebuild-<tab>-window.txt`, the `leaks --traceTree --noContent` of what holds
  the copy's window, and `retain-autoreleasepools.txt`. `LK_CONFIGURATION=Release-UITest` walks the
  optimized app instead of Debug (the probe is Debug only).
- Limits seen on the first runs (2026-10-15): `xctrace --template 'Animation Hitches'` answers
  "Hitches is not supported on this platform" on the simulator. Each suite starts from a fresh
  launch and opens screens seconds later, while the launch prefetch is still waiting on the
  `next dev` demo API (a route's first hit compiles it), so a first visit measures the cold worst
  case; a cache or prefetch fix shows on the revisit steps. Run-to-run noise follows the iMac's
  load: compare a step across runs, not only the totals. A step started while the previous screen
  was still loading gets that screen's late content.
