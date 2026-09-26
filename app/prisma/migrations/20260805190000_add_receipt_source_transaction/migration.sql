-- DropIndex
-- IF EXISTS because the multi-account IMAP change removed this index from live
-- databases without a migration, leaving history and data out of sync. Fresh
-- databases still have it from 20260804201346_add_imap_account.
DROP INDEX IF EXISTS "ImapAccount_userId_key";

-- AlterTable
ALTER TABLE "Receipt" ADD COLUMN "sourceTransactionId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Receipt_sourceTransactionId_key" ON "Receipt"("sourceTransactionId");
