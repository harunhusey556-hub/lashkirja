/**
 * Password recovery when the user cannot sign in.
 *
 * A reset link is sent with the platform mailbox when `PLATFORM_SMTP_HOST`
 * and `PLATFORM_SMTP_FROM` are set (`PLATFORM_SMTP_PORT`, `PLATFORM_SMTP_USER`,
 * and `PLATFORM_SMTP_PASS` are optional). That path does not use the invoice
 * mailbox. If the platform mailbox is missing or fails, the app tries the
 * mailbox the user connected under Asetukset → Sähköpostien tuonti.
 * If neither sends, the link is not shown. A recovery request is stored
 * (`kind=recovery`, status pending) and the user sees it under Tietosuoja
 * after they can sign in. Support with access to this server can mint one
 * link and mark the request. See `npx tsx scripts/account-requests.ts list`.
 *
 * The books are not involved. A reset replaces the password, revokes every
 * tracked session, and sets a cutoff on the user. A cookie sealed before
 * session tracking (it only carries the user id) is refused after that
 * cutoff. The same cutoff is set by logout-all and by a password change.
 * The way back in is a new login, which seals a session id.
 *
 * ## User
 *
 * 1. On the login screen, choose Unohditko salasanan?
 * 2. Enter the account email. The reply is the same whether or not the
 *    account exists.
 * 3. Open the link and choose a new password (at least 8 characters).
 * 4. Sign in. Other devices are signed out.
 *
 * While signed in, change the password under Asetukset → Turvallisuus. The
 * current password is required.
 *
 * ## Support
 *
 * From the app directory, with `DATABASE_URL` and `SESSION_SECRET` set:
 *
 * ```
 * npx tsx scripts/account-recovery.ts kayttaja@example.com
 * ```
 *
 * The command prints one link, valid for 30 minutes, and does not print the
 * password. Send that link to the user. It is single-use. Do not put it in
 * the application log after it has been delivered.
 *
 * There is no screen that sets another person's password.
