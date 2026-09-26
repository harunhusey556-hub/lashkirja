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
  the native project, not read at runtime.
- Capacitor 8 uses Swift Package Manager, so there is no `.xcworkspace`; the
  build script targets `ios/App/App.xcodeproj` directly.
