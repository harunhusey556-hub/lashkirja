-- DropIndex
DROP INDEX "Transaction_suggestedReceiptId_key";

-- CreateIndex
CREATE INDEX "Transaction_suggestedReceiptId_idx" ON "Transaction"("suggestedReceiptId");
