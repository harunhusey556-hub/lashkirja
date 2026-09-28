# Building the LashKirja IPA on a Mac

The iOS app is a Capacitor shell (`fi.tiyouba.lashkirja`). The UI (every page,
`out/` from the mobile static export) ships inside the IPA. The app is not a
thin WebView pointed at a server; only its API calls go over the network.

## Bundled UI model

There are two build targets from the same Next.js app:

- **Web** (`next build`): the desktop/browser app, served by the running
  Next.js server.
- **Mobile** (`npm run build:mobile -- --api-base-url <url>`, Task 4): a static
  export (`out/`) with no server-only code (proxy, route handlers, `cookies()`)
  — everything the app needs, prerendered to files. `cap sync ios` copies
  `out/` into `ios/App/App/public`, and the native `NextExportRouter`
  (`MainViewController.swift`) resolves paths the same way the JS export does.

The API base URL is the only server address in the mobile build:

- It is `--api-base-url` on the CLI (`API_BASE_URL` env for this script,
  `api_base_url` as the `build-ipa.yml` workflow input), baked into the
  JS bundle at build time as `NEXT_PUBLIC_API_BASE_URL`. It is not a
  Capacitor `server.url` — `capacitor.config.ts` has no `server.url` and no
  `errorPath` any more, because there is no remote WebView server to fail
  over from.
- Every app request is a `fetch` to that origin (`src/lib/build-target.ts`),
  not a page load, so the API's CORS allowlist (`MOBILE_APP_ORIGINS`) must
  include the app's real origin (`capacitor://localhost` on iOS).

Consequences that were not true of the old remote-URL shell:

- **A UI change needs a new IPA.** Since the UI is bundled, not loaded from a
  server, redeploying the web app no longer updates an installed app at all —
  not even after a refresh. Ship a new IPA for any change under `src/`.
- **Server deploys must stay backward compatible with installed IPAs.** An
  old IPA keeps calling the API it was built against; the server cannot
  assume every client is on the latest UI. The API responds with a version
  header so a mismatch can be surfaced (an "update the app" banner is
  tracked on the roadmap, not built yet) — never change or remove that
  header's meaning without checking what installed IPAs expect from it.
- **Verify locally before building an IPA.** The Task 4 harness reproduces
  the bundled build without Xcode: `npm run build:mobile -- --api-base-url
  http://127.0.0.1:3200` builds the export, and
  `npx tsx scripts/mobile/serve-export.ts` (port 3210) serves it with the
  same path-resolution rules as the native router, for a Playwright check
  (`playwright.mobile.config.ts`) or a manual look in a phone-sized browser
  tab. This catches a broken export before spending Xcode/CI time on it.

## Requirements

- macOS with Xcode installed (`xcode-select --install` for the CLI tools)
- Node 20+
- An Apple ID. A free one is enough for a build you install on your own phone;
  that signature expires after 7 days. A paid Developer account ($99/year) is
  needed for TestFlight or a signature that lasts a year.

## Steps

```bash
git clone git@github.com:harunhusey556-hub/lashkirja.git
cd lashkirja/app
npm install

# The only server address the app calls at runtime (fetch, not a WebView load).
export API_BASE_URL=https://your-api-url

# Optional but usually needed: your Apple team id (Xcode > Settings > Accounts).
export DEVELOPMENT_TEAM=XXXXXXXXXX

npm run ios:ipa
```

The IPA lands in `app/build/ios/export/`.

## If signing fails

Open the project once so Xcode can create a profile, then rerun the script:

```bash
npm run ios:sync
npm run ios:open
```

In Xcode: target **App** > *Signing & Capabilities* > tick *Automatically manage
signing* and pick your team. Then **Product > Archive**, and *Distribute App* in
the Organizer window produces the same IPA.

## Notes

- `API_BASE_URL` must be HTTPS (or `http://127.0.0.1`/`http://localhost` for
  local emulation only). App Transport Security blocks a plain-HTTP address
  to any other host on a device.
- Changing the URL means building a new IPA — `npm run ios:ipa` runs the
  mobile export again with the new `--api-base-url` before `cap sync`, and
  it is baked into the JS bundle at build time, not read at runtime. The
  installed IPA does not switch itself to a new API address.
- After `cap sync`, `scripts/patch-ios-url-scheme.ts` adds the `lashkirja` URL scheme to `Info.plist`. `scripts/build-ios-ipa.sh` and `build-ipa.yml` both run that patch after `npx cap sync ios`. A closed app can then open `lashkirja://bank/callback`. An IPA built before this patch does not.
- Face ID / Touch ID uses `@aparajita/capacitor-biometric-auth`. `cap sync` links it. `NSFaceIDUsageDescription` is already in `ios/App/App/Info.plist`. An IPA built before this plugin cannot prompt. See `docs/app-lock.md`.
- Camera, photo library (including limited library), and the Files picker are requested when the user taps Ota kuva, Valitse kuvista, or Valitse tiedosto. The Finnish usage strings live in `Info.plist`. `@capacitor/camera` and `@capawesome/capacitor-file-picker` are linked by `cap sync`. An IPA built before those plugins still falls back to the web file input and will not show the new prompts. See `docs/native-files.md`.
- `public/offline.html` and `scripts/patch-ios-offline-server.ts` are unused
  leftovers of the old remote-URL shell (harmless; not deleted). There is no
  `server.errorPath` any more — a failed `fetch` to the API is an in-app
  state, not a WebView navigation failure. `@capacitor/filesystem` and
  `@capacitor/share` are dependencies, so `cap sync` includes PDF share into
  Files.
- `ios.scrollEnabled: false` is already in `capacitor.config.ts`, and an
  installed IPA keeps the WebView bounce until you rebuild and reinstall —
  this is a native flag, read at launch from `ios/App/App/capacitor.config.json`,
  so it always needs a new IPA regardless of the build target.
- Screen fit (notch/home-indicator padding) reacts to `env(safe-area-inset-*)`
  in CSS, but the underlying `contentInset: "never"` that makes WKWebView
  report real insets is native config. Once an IPA has it, tweaking the CSS
  that consumes it is still a UI change and, per the bundled model above,
  needs a new IPA like any other `src/` change.
- Long-press URL balloons and text selection on chrome are web CSS and the
  tab bar is a button, not a link — also a UI change, so also needs a new IPA.
- `ios.allowsLinkPreview: false` is in `capacitor.config.ts`. `npm run ios:sync`
  (which `scripts/build-ios-ipa.sh` runs) copies it to
  `ios/App/App/capacitor.config.json`, and Capacitor sets
  `WKWebView.allowsLinkPreview`. The native default is on if that key is
  absent. Harun's current IPA was synced from this config, so the flag is
  already in that binary. It does not suppress the URL balloon on its own.
- Capacitor 8 uses Swift Package Manager, so there is no `.xcworkspace`; the
  build script targets `ios/App/App.xcodeproj` directly.
