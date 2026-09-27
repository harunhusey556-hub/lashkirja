# App lock

Face ID and Touch ID are part of the local glance lock. They are compiled in with
`@aparajita/capacitor-biometric-auth` (Capacitor 8, Swift Package Manager). The
plugin calls `LAContext` and does not store the PIN in the keychain, so it does
not need a keychain entitlement. `Info.plist` includes `NSFaceIDUsageDescription`.

An already installed IPA does not gain the prompt until the next unsigned build
(`build-ipa.yml` runs `npx cap sync ios`, which links the plugin). A browser, or
an IPA from before this plugin, keeps the PIN and does not throw.

What the lock does:

- Optional 4–8 digit code, stored as a salted hash in this browser's
  `localStorage` under `lashkirja.app-lock.v1:<userId>`. Another account on
  the same device does not see that hash. An older unscoped key is deleted.
- Biometric unlock is a separate opt-in, `lashkirja.app-lock.biometric.v1:<userId>`.
  Asetukset → Turvallisuus shows a Face ID / Touch ID card above the password
  form. Before a PIN exists, the card says to set the code first. After a PIN
  exists, a native IPA with the plugin shows a switch and "Ota Face ID käyttöön"
  (or Touch ID). A browser says the switch lives in the installed app. A native
  build without the plugin says a new IPA is required. Turning the PIN off
  clears the opt-in. Another account does not inherit it.
- Opening the app, or returning from the background, covers the books. If
  biometrics are opted in, the system prompt is shown once. Cancel, failure,
  or a missing sensor leaves the PIN field. The PIN field is a password input.
- A wrong code waits 1s, then 2s, 4s, 8s, 16s, and at most 30s before the
  next try. After several failures the screen says to sign out.
- Unohdin koodin removes this user's lock and signs out of the server
  session. The lock is not a substitute for that session.
- Hiding the app covers the screen so the app switcher is less likely to
  snapshot receipts and balances. iOS may still snapshot before the page can
  paint.
- Kirjaudu ulos still has to succeed on the server. Clearing site data removes
  the code and the biometric opt-in and does not sign the user out.

The device passcode is not used as a substitute for this PIN. The system
dialog's other button is "Käytä koodia", which returns to the field above.
