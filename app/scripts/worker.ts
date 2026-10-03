import { enableBankingStatus } from "../src/lib/enablebanking/signing";
import { syncDueBankConnections } from "../src/lib/enablebanking/sync";
import { listSyncableImapAccounts, syncImapAccount } from "../src/lib/mail-sync";
import { drainPendingDocumentJobs } from "../src/lib/document-jobs";
import { runDueRecurringPurchases } from "../src/lib/recurring-purchases";
import { runMatchReviewCycle } from "../src/lib/match-review-run";
import { formatReconcileSummary, reconcileEnabled, reconcilePosPayments } from "../src/lib/pos-payments";

const SYNC_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

async function runBankSyncCycle() {
  if (!enableBankingStatus().ready) return;
  console.log(`[${new Date().toISOString()}] Checking bank connections due for sync...`);
  try {
    const result = await syncDueBankConnections();
    console.log(
      `[${new Date().toISOString()}] Bank sync processed=${result.processed} imported=${result.imported} skipped=${result.skipped} errors=${result.errors.length}`
    );
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Bank sync cycle failed`, error);
  }
}

/** Toistuvat ostolaskut: idempotent per period, so the hourly cron running it too is harmless. */
async function runRecurringPurchaseCycle() {
  try {
    const result = await runDueRecurringPurchases();
    if (result.users === 0) return;
    console.log(
      `[${new Date().toISOString()}] Recurring purchases users=${result.users} created=${result.created} skipped=${result.skipped} periodLocked=${result.periodLocked.length} failed=${result.failed.length} errors=${result.errors.length}`
    );
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Recurring purchase cycle failed`, error);
  }
}

/** AI review of uncertain bank-row matches, after the syncs and never inside one (cached per question). */
async function runMatchReview() {
  try {
    const result = await runMatchReviewCycle();
    if (result.reviewed > 0) {
      console.log(`[${new Date().toISOString()}] Match review users=${result.users} reviewed=${result.reviewed}`);
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Match review cycle failed`, error);
  }
}

/**
 * Korttimaksut: a backup for card payments the app and the Stripe webhook
 * missed. It only reads from Stripe and books through the same once-only path.
 * Off with POS_RECONCILE=off; a no-op without STRIPE_SECRET_KEY.
 */
async function runPosReconcile() {
  if (!reconcileEnabled()) return;
  try {
    const result = await reconcilePosPayments();
    if (result.checked > 0 || result.errors > 0) {
      console.log(`[${new Date().toISOString()}] ${formatReconcileSummary(result)}`);
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] POS reconcile cycle failed`, error instanceof Error ? error.name : "error");
  }
}

async function runSyncCycle() {
  console.log(`[${new Date().toISOString()}] Starting background email sync cycle...`);
  try {
    const accounts = await listSyncableImapAccounts();
    if (accounts.length === 0) {
      console.log(`[${new Date().toISOString()}] No IMAP accounts connected. Skipping sync.`);
      return;
    }

    for (const account of accounts) {
      console.log(`[${new Date().toISOString()}] Syncing account: ${account.email}...`);
      try {
        const count = await syncImapAccount(account.id);
        console.log(`[${new Date().toISOString()}] Successfully synced ${count} new receipts for ${account.email}.`);
      } catch (error) {
        console.error(`[${new Date().toISOString()}] Failed to sync account ${account.email}:`, error);
      }
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error fetching IMAP accounts:`, error);
  }
}

async function main() {
  console.log(`[${new Date().toISOString()}] Lashkirja Background Worker Started.`);
  console.log(`[${new Date().toISOString()}] Next sync in ${SYNC_INTERVAL_MS / 1000 / 60} minutes.`);
  
  // Run immediately on start
  await runSyncCycle();
  await runBankSyncCycle();
  await runRecurringPurchaseCycle();
  await drainPendingDocumentJobs().catch((error) =>
    console.error(`[${new Date().toISOString()}] Document jobs failed`, error)
  );
  await runMatchReview();
  await runPosReconcile();

  // Schedule loop. Bank sync itself stays on a 6h gate inside syncDueBankConnections.
  setInterval(async () => {
    await runSyncCycle();
    await runBankSyncCycle();
    await runRecurringPurchaseCycle();
    await drainPendingDocumentJobs().catch((error) =>
      console.error(`[${new Date().toISOString()}] Document jobs failed`, error)
    );
    await runMatchReview();
    await runPosReconcile();
  }, SYNC_INTERVAL_MS);
}

// Keep the process alive
main().catch(console.error);

process.on("SIGINT", () => {
  console.log("Shutting down worker...");
  process.exit(0);
});
