# Release checklist (P6)

Source: `docs/superpowers/plans/2026-10-05-native-polish-master-plan.md` section P6 and the PARKED sections.
Checked 2026-10-06 against `origin/integration` 661607b. Status: OK, FIXED (gap closed in this change), OPEN (engineering gap), OWNER (needs the owner, a device or an account).

## Automated gates

| # | Item | Status | Evidence |
|---|------|--------|----------|
| G1 | LashKirjaCore tests green | OK | `iOS native` job `core-linux` (`.github/workflows/ios-native.yml:22`). Last finished run on `feature/integration-ci` at 70bdff0: success. The run for 661607b was still in progress when checked. |
| G2 | iOS app builds on macOS CI | OK | Jobs `ios-build` (:39, simulator build and unit tests) and `ipa` (:65, Release unsigned archive). Same run, success at 70bdff0. |
| G3 | TypeScript/server build green | OK | `npx tsc --noEmit` in `app/`: exit 0 (after `prisma generate`; a fresh checkout without the generated client shows 566 false TS7006 errors). |
| G4 | Integration/unit tests green | OK | `npx vitest run`: 1712 passed, 5 failed, 3 files. The 5 are the known Windows-only ones: 3 in `backup-script.test.ts`, 1 in `db-permissions.test.ts`, 1 in `db-upgrade.test.ts`. Nothing else failed. |
| G5 | No new lint/type errors | OK | `npm run lint`: exit 0, 0 errors, 30 warnings (pre-existing). tsc as G3. |

## Real-device matrix

| Item | Status | Evidence |
|------|--------|----------|
| One current iPhone validates install, login/OTP, session restore, background, camera/photo/file, PDF, keyboard, swipe-back, offline recovery, Face ID, bank return; record model, iOS and build number | OWNER | Short Turkish checklist for the owner: `docs/quality/DEVICE-MATRIX-TR.md`. Build number is now the CI run number (R5). Passkey and bank OAuth need credentials. |

## Release checklist

| # | Item | Status | Evidence |
|---|------|--------|----------|
| R1 | Production API base verified | FIXED | `ios-native/App/project.yml:19` sets `API_BASE_URL` to the https Tailscale Funnel host, read at runtime from Info.plist `LKAPIBaseURL` (`project.yml:50`, `Sources/LashKirjaApp.swift:7`). The `ipa` job passes the same value (`ios-native.yml` env `API_URL`). No `localhost`, `127.0.0.1` or `http://` in any non-test Swift or yml source (git grep, no hits). Added: the `ipa` job now reads the built Info.plist and fails on a non-https, localhost, `.local` or placeholder host. Not run yet on macOS; the next `iOS native` run proves it. |
| R2 | No test secrets/tokens in repo/build | OK | `git ls-files`: only `app/.env.example` (placeholders). Key-pattern scan (Stripe `sk_`/`rk_`/`whsec_`, AWS, Google, GitHub, Slack, Anthropic, PEM, JWT) found hits only in test fixtures (`app/src/lib/enablebanking/signing.test.ts:48`, `app/tests/integration/stripe-pos.test.ts:34-36,153,161`). Assignment scan: CI-only `SESSION_SECRET` in 3 workflows, placeholder values in `.env.example:5,13`, and a development-only fallback secret in `session-options.ts:6`, `encryption.ts:5`, `account-security.ts:51`. `session-options.ts:8` throws in production without a 32-char `SESSION_SECRET`. No values printed here. History was not scanned. |
| R3 | Privacy strings/capabilities accurate | OK | `project.yml:52-62`: camera (VisionKit scanner `Kirjanpito/DocumentScanner.swift`, `UIImagePickerController` in `CaptureFlow.swift`), photo library (`PhotosPicker`), Face ID (`Asetukset/AppLock.swift`), location when in use and Bluetooth (both only for Stripe Terminal; no `CLLocationManager` in app code, strings kept because the SDK links them), `UIBackgroundModes: [fetch]` plus `BGTaskSchedulerPermittedIdentifiers` (`LashKirjaApp.swift:61`), quick-action items (`project.yml:72-83`). Spotlight (`SpotlightIndexer.swift`) and App Intents (`Shell/QuickActions.swift:81`) need no string. No microphone, contacts, or photo-add use, so none declared. Nothing removed. |
| R3b | Privacy manifest (`PrivacyInfo.xcprivacy`) | OPEN | None in `ios-native/`. Not needed for sideloaded builds; needed for an App Store submission. Add with the correct required-reason entries when the owner decides to publish. |
| R4 | App icon/launch screen final | OK | `Resources/Assets.xcassets/AppIcon.appiconset/Contents.json`: single 1024x1024 universal icon (`AppIcon-512@2x.png`, RGB PNG, no alpha), which Xcode 14+ scales for all sizes. `ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon` (`project.yml:97`). Launch screen is `UILaunchScreen: {}` (`project.yml:51`): system background, no image. Deliberate; a branded launch image is a design choice for the owner. |
| R5 | Version/build number correct | FIXED | `MARKETING_VERSION: "1.0.0"` (`project.yml:17`) unchanged. `ios-native.yml` `ipa` job already passed `CURRENT_PROJECT_VERSION=${{ github.run_number }}`; Info.plist maps it to `CFBundleVersion` (`project.yml:48`). Added a check that the built `CFBundleVersion` equals the run number and logs it. The simulator `ios-build` job uses the default `1`. |
| R6 | Crash/error observation endpoint working | OPEN | Exists server side: `POST /api/observe` (`app/src/app/api/observe/route.ts`, session-only, rate limited, redacted), `GET /api/health` (`HEALTH_TOKEN`), events to log, `OBSERVE_WEBHOOK_URL` or `SENTRY_DSN` (`app/docs/ops.md:9-28`, `src/lib/observe.ts`). Only the web client posts to it (`src/components/ClientErrorReporter.tsx`). The native app has no client error or crash reporting; the only crash data is the owner's Xcode/device logs. Gap: a small native reporter posting uncaught errors to `/api/observe` (no third-party SDK). Endpoint itself not exercised against production here. |
| R7 | Backup/restore server procedure documented | OK | `app/docs/backup.md` (snapshot, off-machine copy, restore, verification), scripts `app/scripts/backup-db.sh`, `app/scripts/restore-drill.sh`, `app/scripts/ops/backup-local.ps1`, rollback in `app/docs/deploy-rollback.md`. A real restore drill on the production host and an off-machine target are OWNER actions. Script tests fail on Windows only (G4). |
| R8 | Accessibility pass complete | OK | Commit 582b86a "P5 accessibility pass (VoiceOver, Dynamic Type, tap targets, Reduce Motion)"; simulator large-text walk in 4486bc2. Real VoiceOver and largest-size check on a device is in `DEVICE-MATRIX-TR.md`. |
| R9 | Known blocked features clearly gated | OK | Tap to Pay: `LK_TAP_TO_PAY_ENTITLEMENT: "NO"` (`project.yml:31`), only `Release-Signed` sets YES and references the entitlements file (`project.yml:108-114`). `POSDevice.hasEntitlement` reads it (`Sources/POS/POSCoordinator.swift:35`), so the unsigned build reports "Puuttuu tästä versiosta" (`Asetukset/PaymentsSettingsView.swift:113,122`) and the card-payment sheet shows what is missing (`POS/POSPaymentSheet.swift:274`, `Core/Sales/POS.swift:327`). Passkey: sign-in button only shows once the server says passkeys work (`Login/LoginView.swift:19-56`), creation only when `canCreate` (`Asetukset/PasskeysView.swift:101-116`), and a build without associated domains maps to `.notConfigured` (:376), not a crash. The project has no associated-domains entitlement, so the unsigned IPA cannot complete passkeys. Per the PARKED rule, no POS work was done. |

## Summary

Counts (16 rows): OK 11, FIXED 2 (R1, R5), OPEN 2 (R3b privacy manifest, R6 native error reporting), OWNER 1 (device matrix).

## Still owner-side before a real release

- Run the device matrix and record model, iOS version and the build number (CFBundleVersion, equal to the CI run number of the IPA).
- Restore drill on the production host and an off-machine backup target (`LASHKIRJA_BACKUP_REMOTE`).
- Tap to Pay and native passkey stay parked until the owner says "unblock Tap to Pay / resume POS" and has a paid Apple Developer account.
