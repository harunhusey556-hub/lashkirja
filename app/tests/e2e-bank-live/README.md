# Real bank consent test

Run against an existing configured application, using a dedicated test account. This test grants actual bank read access when the user approves in the bank's own site. It does not send payments, automatically click consent, capture bank passwords or revoke existing connections.

Set PLAYWRIGHT_BASE_URL to the application's origin, BANK_E2E_EMAIL and BANK_E2E_PASSWORD to the dedicated app account, and BANK_E2E_LIVE=1. Keep credentials in the environment, not command history or committed files.

Run: `npx playwright test -c playwright.bank-live.config.ts`

When Playwright Inspector pauses, select the bank, complete its authentication and consent manually, and resume after returning to LashKirja. The test requires a newly created active connection with accounts visible through the authenticated API. Trace, video and screenshots are disabled to avoid recording bank authentication. A missing/disabled integration produces a skip, never a claimed successful real-bank test.

The normal integration suite separately verifies state/session ownership, callback errors, revoked/expired consent and connection isolation with a controlled provider. Those checks do not replace the real-bank test.
