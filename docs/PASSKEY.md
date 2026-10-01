# Pääsyavaimet (passkeys) — what the owner must set up

Passkeys are an **extra** way to sign in. The password always keeps working.
Until the steps below are done, the passkey button simply does not appear.

## 1. Server (production `.env` on the PC)

```
WEBAUTHN_RP_ID=desktop-7gu8ukj.tail42feb1.ts.net
APPLE_TEAM_ID=XXXXXXXXXX
# optional, default is https://<WEBAUTHN_RP_ID>
# WEBAUTHN_ORIGINS=https://desktop-7gu8ukj.tail42feb1.ts.net
```

- `WEBAUTHN_RP_ID` is the public Funnel host name only: no `https://`, no path. Every passkey
  is bound to it. **If the host ever changes, all existing passkeys stop working**; people then
  sign in with the password and create new ones.
- `APPLE_TEAM_ID` is the 10-character Team ID from developer.apple.com, under Membership.
  Without it the web still offers passkeys, but the iOS app hides the button.
- Restart the server. The deploy must also apply the new database migration
  `20261003090000_passkeys` (`npx prisma migrate deploy`, which is the normal deploy step).

Check (anyone can run it, and it must return 200 JSON with no redirect):

```
curl -i https://desktop-7gu8ukj.tail42feb1.ts.net/.well-known/apple-app-site-association
# expect: Content-Type: application/json
# {"webcredentials":{"apps":["XXXXXXXXXX.fi.tiyouba.lashkirja"]}}
curl https://desktop-7gu8ukj.tail42feb1.ts.net/api/auth/passkey/status
# expect: {"web":true,"native":true}
```

Apple's CDN caches the file. After the first fetch, this shows what iOS will see (it can take
up to a day to refresh): `https://app-site-association.cdn-apple.com/a/v1/desktop-7gu8ukj.tail42feb1.ts.net`

## 2. The app build: associated domains needs real signing

iOS lets the app use passkeys for the host only if the **signed** app carries the entitlement
`com.apple.developer.associated-domains = webcredentials:<host>`
(`app/ios/App/App/App.entitlements`, kept in the Xcode project for Xcode and TestFlight
builds). The unsigned CI build (`build-ipa.yml`) ignores it by default.

**In short: passkeys on the device need an Xcode or TestFlight build, or the opt-in CI input
below plus a re-signer that keeps the entitlement.** The default CI IPA has no passkey
entitlement, so passkey sign-in in that app says "Pääsyavaimet eivät ole vielä käytössä tällä
palvelimella". The password always works.

What a signed build needs:

1. In developer.apple.com, under Identifiers, the App ID **`fi.tiyouba.lashkirja`** with the
   **Associated Domains** capability turned on.
2. A provisioning profile for that App ID from your team (development, ad hoc or App Store)
   that was created or regenerated **after** step 1, so it includes the capability.
3. The app signed with that profile **and** with the entitlements file above.

### Sideloadly: honest status

- **Default (`embed_passkey_entitlements` off):** the CI IPA is exactly as before batch 3:
  unsigned, no signature, no embedded entitlements, built with `CODE_SIGN_ENTITLEMENTS=""`.
  Install it with Sideloadly as always. Passkeys do not work in it.
- **Opt-in (`embed_passkey_entitlements: true` in Run workflow):** CI writes the
  `api_base_url` host into `App.entitlements`, gives the app an ad-hoc signature that embeds
  `com.apple.developer.associated-domains`, and uploads `App.entitlements` as a separate
  artifact (`LashKirja-passkey-entitlements`). If embedding fails it logs a warning and
  packages the plain IPA. Risk: Sideloadly may refuse this IPA ("entitlement not allowed by
  profile") or strip the entitlement. If that happens, build again with the input off.
- Sideloadly re-signs with a profile it makes itself. **It has not been verified that this
  profile includes Associated Domains, or that Sideloadly keeps the app's
  `associated-domains` entitlement.** If either is missing, the app installs and works, but
  "Kirjaudu pääsyavaimella" ends with "Pääsyavaimet eivät ole vielä käytössä tällä
  palvelimella". The password still works.
- Things to try in Sideloadly: sign in with the paid account, keep the bundle id
  `fi.tiyouba.lashkirja`, and turn on Associated Domains for that App ID in the developer portal
  first (step 1), and run the workflow with the opt-in input. If Sideloadly's advanced options
  accept an entitlements file, give it `App.entitlements` from the entitlements artifact.

### Reliable alternative

Build a **signed** IPA instead of re-signing an unsigned one. Either:

- **Xcode on a Mac:** open `app/ios/App/App.xcodeproj`, choose your team under Signing &
  Capabilities (Associated Domains is already listed through `App.entitlements`), then use
  Product > Archive and Distribute (Ad Hoc or TestFlight), or
- **Signed CI / TestFlight:** add GitHub secrets (distribution certificate `.p12` and its
  password, the provisioning profile from step 2, the team id, and an App Store Connect API key
  for TestFlight). Then a workflow runs `xcodebuild archive` + `-exportArchive` with
  `CODE_SIGN_ENTITLEMENTS=App/App.entitlements`. That workflow is not written yet: it needs
  those secrets first.

TestFlight is the most predictable path: Apple then signs the app with the capability, and
nothing else has to cooperate.

## 3. On the phone

iOS 16 or later, with iCloud Keychain on. Sign in with the password once: the app offers
"Luo pääsyavain" one time. You can also go to Asetukset > Tili ja turvallisuus > Pääsyavaimet,
where you can add, rename and delete passkeys. Deleting a passkey there stops it from signing in
at once. iOS keeps its copy in Passwords until you remove it there too.

Adding a passkey asks for the current password first (in Settings a sheet asks for it; the
one-time offer after a password sign-in reuses the password just typed). The server mints the
registration challenge only after that check, and the challenge lives five minutes, so a
stolen session alone cannot add a passkey.

A password reset, a password change and "Kirjaa ulos muut laitteet" delete **every** passkey of
the account (the app says so). Add them again afterwards.

## Desktop development

```
WEBAUTHN_RP_ID=localhost
WEBAUTHN_ORIGINS=http://localhost:3200
```

Open the app at `http://localhost:3200`, not at `127.0.0.1`, because the RP ID must match the
host.
