/**
 * Password recovery when the user cannot sign in.
 *
 * LashKirja does not run its own mail server. A reset link is sent with the
 * invoice mailbox the user already connected (Asetukset → Sähköpostien tuonti).
 * If that mailbox is missing, or sending fails, the link is not shown in the
 * app. Support with access to this server can mint one link and pass it to
 * the user on a channel they already trust.
 *
 * The books are not involved. A reset only replaces the password and revokes
 * tracked sessions.
 *
 * ## User
 *
 * 1. On the login screen, choose Unohditko salasanan?
 * 2. Enter the account email. The reply is the same whether or not the
 *    account exists.
 * 3. Open the link and choose a new password (at least 10 characters).
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
