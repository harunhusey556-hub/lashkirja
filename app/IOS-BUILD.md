# Building the Tilikirja IPA on a Mac

The iOS app is a Capacitor shell (`fi.tiyouba.lashkirja`). It does not bundle the
Next.js server — it loads the deployed app over HTTPS, so the URL is baked in at
sync time through `CAPACITOR_SERVER_URL`.

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

# Where the running app lives. The IPA points at this address.
export CAPACITOR_SERVER_URL=https://your-app-url

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

- `CAPACITOR_SERVER_URL` must be HTTPS. A plain-HTTP address is only allowed for
  local testing and App Transport Security will block it on a device.
- Changing the URL means running `npm run ios:sync` again — it is written into
  the native project, not read at runtime. The installed IPA does not switch
  itself to production.
- Point `CAPACITOR_SERVER_URL` at a host running `next build && next start`.
  `next dev` shows Next's red Issue badge; that badge is not hidden. A web
  commit does not update an already installed IPA.
- After `cap sync`, `scripts/patch-ios-url-scheme.ts` adds the `lashkirja` URL scheme to `Info.plist`. The IPA script runs that patch. A closed app can then open `lashkirja://bank/callback`. An IPA built before this patch does not.
- `server.errorPath` is `offline.html` whenever `CAPACITOR_SERVER_URL` is set. `@capacitor/filesystem` and `@capacitor/share` are dependencies, so the same sync includes PDF share into Files.
- `ios.scrollEnabled: false` is already in `capacitor.config.ts`, but an
  installed IPA keeps the WebView bounce until you rebuild and reinstall.
  Shipping this web commit does not apply that native flag.
- Screen fit is web code: the shell fills the WKWebView, and the notch and
  home indicator are padding inside the header and tab bar. An IPA that
  already loads this server with `contentInset: "never"` picks that up on
  refresh. It does not need a new IPA.
- Long-press URL balloons and text selection on chrome are web CSS and the
  tab bar is a button, not a link. A tunnel refresh is enough. No new IPA.
- `ios.allowsLinkPreview: false` is in `capacitor.config.ts`. `npm run ios:sync`
  (which `scripts/build-ios-ipa.sh` runs) copies it to
  `ios/App/App/capacitor.config.json`, and Capacitor sets
  `WKWebView.allowsLinkPreview`. The native default is on if that key is
  absent. Harun's current IPA was synced from this config, so the flag is
  already in that binary. It does not suppress the URL balloon on its own.
- Capacitor 8 uses Swift Package Manager, so there is no `.xcworkspace`; the
  build script targets `ios/App/App.xcodeproj` directly.
