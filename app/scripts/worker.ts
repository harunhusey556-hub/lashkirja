import { prisma } from "../src/lib/db";
import { enableBankingStatus } from "../src/lib/enablebanking/signing";
import { syncDueBankConnections } from "../src/lib/enablebanking/sync";
import { syncImapAccount } from "../src/lib/mail-sync";
import { drainPendingDocumentJobs } from "../src/lib/document-jobs";

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

async function runSyncCycle() {
  console.log(`[${new Date().toISOString()}] Starting background email sync cycle...`);
  try {
    const accounts = await prisma.imapAccount.findMany();
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
  await drainPendingDocumentJobs().catch((error) =>
    console.error(`[${new Date().toISOString()}] Document jobs failed`, error)
  );

  // Schedule loop. Bank sync itself stays on a 6h gate inside syncDueBankConnections.
  setInterval(async () => {
    await runSyncCycle();
    await runBankSyncCycle();
    await drainPendingDocumentJobs().catch((error) =>
      console.error(`[${new Date().toISOString()}] Document jobs failed`, error)
    );
  }, SYNC_INTERVAL_MS);
}

// Keep the process alive
main().catch(console.error);

process.on("SIGINT", () => {
  console.log("Shutting down worker...");
  process.exit(0);
});
