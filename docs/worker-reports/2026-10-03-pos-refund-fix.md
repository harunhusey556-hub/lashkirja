# WORKER REPORT — fix/pos-refund-fix (B1, S1, S3 from logs/review-f1be13f.md)

Base: f1be13f. No migration. No push or merge.

## Files
- `app/src/lib/pos-payments.ts`
  - B1: `refundInfos()` keeps only `status === "succeeded"` refunds. A succeeded refund whose
    amount is not `Number.isSafeInteger && > 0` throws (`POS_REFUND_UNKNOWN`, 502). It is not dropped.
  - B1: `applyRefundTotal()` throws before any write takes effect when the total is not a safe
    integer >= 0. Before it inserts fresh `PosRefund` rows, it checks that
    recorded sum + fresh sum <= Stripe `amount_refunded` and <= `pos.amountCents`. A throw rolls
    back the whole transaction: no rows and no total change. The webhook then answers 500, so Stripe
    retries. The app route answers 502, and the client retries with the same key, which is the same
    refund at Stripe.
  - B1: a new webhook case `charge.refund.updated` / `refund.updated` re-reads the PaymentIntent
    total and the refund list. This lets a pending refund that later succeeds get its card.
  - S1: `refundPosPayment()` saves the fresh PaymentIntent's `livemode` before the refund gating.
    This also applies to already-succeeded rows.
- `app/src/lib/stripe.ts`
  - S3: `listRefunds()` throws a new `StripeListIncompleteError` (`POS_REFUNDS_INCOMPLETE`, 502)
    when `has_more !== false` or `data` is not an array.
- `app/tests/integration/helpers/fake-stripe.ts`: adds `refundStatus`, `setRefund(id, status)`
  and `refundsHaveMore`.
- `app/tests/integration/stripe-pos.test.ts`: 7 new tests in "refund in a locked month":
  - pending refund gives no card; once it succeeds, exactly one card, also after repeated events
  - pending refund that then fails gives no card
  - a sum over the refunded total gives a 500, no rows, and an unchanged total; a retry once the data agrees books 2
  - recorded + fresh above the total gives no new row
  - a non-integer amount books nothing
  - has_more: listRefunds throws the typed error, route 502, webhook 500, no rows; a retry once it is a single page books 2
  - S1: a live row stored with livemode=false is corrected to true and gets its card

Before the fix, 6 of the 7 new tests failed. The non-integer test already gave a 500 from Prisma's Int column.

## Checks (run in this worktree)
- `npm ci && npx prisma generate`: ok (758 packages, Prisma Client 7.9.1)
- `npx tsc --noEmit -p .`: exit 0
- `npm run lint`: exit 0, 0 errors, 30 warnings, none in the touched files
- `stripe-pos.test.ts`: 86/86 passed
- Integration suite: 97 files, 1000/1000 passed
- `npx vitest run src`: 1711 passed, 6 failed (4 files):
  - known Windows/sqlite3 CLI failures: backup-script x3, db-permissions x1, db-upgrade x1
  - glossary-lint x1: timed out at 5 s under full-suite load. Run alone, it passed 3/3.

## Not done / notes
- The Stripe Dashboard webhook endpoint must subscribe to `charge.refund.updated` (or
  `refund.updated`). Without that, a pending refund that later succeeds gets its card only at the
  next `charge.refunded` or app refund for the same payment. The endpoint's event list is not in the repo.
- `refundedCents` still only grows. A pending refund that fails stays in the total, which is pre-existing behaviour.
  With B1 it no longer creates a card or row.
- S1 is only in the app refund path. The `charge.refunded` webhook still gates on the stored
  `livemode`. The new refund.updated path does not save the mode either.
- If a recorded succeeded refund later fails at Stripe (rare), the bound check blocks new cards for
  that payment. This is fail-safe and needs support.
- S2 and S4 are out of scope and not touched.
