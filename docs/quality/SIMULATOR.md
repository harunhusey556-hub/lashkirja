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
