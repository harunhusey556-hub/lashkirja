-- AlterTable
ALTER TABLE "Receipt" ADD COLUMN "invoiceNumber" TEXT;
ALTER TABLE "Receipt" ADD COLUMN "reference" TEXT;

-- CreateTable
CREATE TABLE "MatchRejection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "transactionId" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MatchRejection_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MatchRejection_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "Receipt" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Transaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "statementId" TEXT NOT NULL,
    "date" DATETIME,
    "counterparty" TEXT,
    "amount" REAL NOT NULL,
    "reference" TEXT,
    "message" TEXT,
    "type" TEXT NOT NULL DEFAULT 'meno',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receiptId" TEXT,
    "suggestedReceiptId" TEXT,
    "matchStatus" TEXT NOT NULL DEFAULT 'unmatched',
    "matchScore" REAL,
    "matchReasons" TEXT,
    CONSTRAINT "Transaction_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "Statement" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Transaction_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "Receipt" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Transaction" ("amount", "counterparty", "createdAt", "date", "id", "message", "reference", "statementId", "type") SELECT "amount", "counterparty", "createdAt", "date", "id", "message", "reference", "statementId", "type" FROM "Transaction";
DROP TABLE "Transaction";
ALTER TABLE "new_Transaction" RENAME TO "Transaction";
CREATE UNIQUE INDEX "Transaction_receiptId_key" ON "Transaction"("receiptId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "MatchRejection_transactionId_receiptId_key" ON "MatchRejection"("transactionId", "receiptId");
