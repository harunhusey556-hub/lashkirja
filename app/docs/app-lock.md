# App lock

Face ID and Touch ID are **deferred_product** for this build.

The installed app is a web view. A biometric prompt needs a Capacitor plugin
compiled into a new IPA. This project does not include one, and an already
installed IPA would not gain it from a web deploy. Adding the plugin only in
JavaScript would throw on device.

What shipped instead is a local glance lock:

- Optional 4–8 digit code, stored as a salted hash in this browser's
  `localStorage` under `lashkirja.app-lock.v1:<userId>`. Another account on
  the same device does not see that hash. An older unscoped key is deleted.
- The field is a password input, so the digits are not shown.
- A wrong code waits 1s, then 2s, 4s, 8s, 16s, and at most 30s before the
  next try. After several failures the screen says to sign out.
- Unohdin koodin removes this user's lock and signs out of the server
  session. The lock is not a substitute for that session.
- Opening the app, or returning from the background, covers the books until
  the code is entered.
- Hiding the app covers the screen so the app switcher is less likely to
  snapshot receipts and balances. iOS may still snapshot before the page can
  paint; that limit is why a native biometric plugin remains the later step.
- The lock does not replace the server session. Kirjaudu ulos still has to
  succeed on the server. Clearing site data removes the code and does not
  sign the user out.

Set or remove the code under Asetukset → Turvallisuus.
