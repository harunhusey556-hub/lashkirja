# Native integrations (2026-10-06)

Branch `feature/native-integrations` from `origin/native`. Built without a Swift toolchain (Windows); verified by the `iOS native` CI run.

## What changed
- **Document scanner**: `CaptureFlow` opens `VNDocumentCameraViewController` (`DocumentScanner.swift`) when `isSupported`, else the old `CameraPicker`. Each scanned page becomes its own queued receipt (`kuitti-N.jpg`), exactly like a multi-photo pick, since `ReceiptUploadQueue` is one file per receipt. When matching a bank row (single mode) only page 1 is used. Same upload, OCR and editor flow. `NSCameraUsageDescription` kept.
- **Routes**: `QuickAction` in LashKirjaCore parses `lashkirja://capture`, `lashkirja://invoice/new`, `lashkirja://assistant` (tests: `QuickActionTests`). `AppModel.handle(url:)` sets `pendingQuickAction`; `MainTabView` (exists only when signed in) consumes it, also on first appearance, so a link before login runs after login. It opens the capture cover, the invoice form sheet and the assistant sheet.
- **Quick actions**: static `UIApplicationShortcutItems` in `project.yml` (Kuvaa kuitti, Uusi lasku, Avustaja). `QuickActions.swift` holds the app/scene delegate (cold launch via connection options, warm via `performActionFor`).
- **App Intents**: three intents (`openAppWhenRun`) plus `AppShortcutsProvider` with Finnish phrases. They only deliver the same route; no network.
- `PendingCapture.transactionId` is now optional (nil = plain capture).

## Simulator
- `xcrun simctl openurl booted lashkirja://capture` (and `invoice/new`, `assistant`).
- The scanner is unsupported in the simulator (no camera), so it shows the old flow there; test the scanner on a device.
- Quick actions: long-press the icon on the simulator Home Screen. Siri phrases need a device.
- Not cleared on sign-out (`endLocalSession` left alone on request): a pending action stays until the next sign-in.
