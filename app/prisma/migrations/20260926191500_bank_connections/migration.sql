-- CreateTable
CREATE TABLE "BankConnection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "aspspName" TEXT NOT NULL,
    "aspspCountry" TEXT NOT NULL,
    "aspspLogo" TEXT,
    "psuType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "authStateHash" TEXT,
    "sessionIdEnc" TEXT,
    "validUntil" DATETIME,
    "requiredPsuHeaders" TEXT,
    "lastSyncAt" DATETIME,
    "lastSuccessAt" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BankConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BankAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "iban" TEXT NOT NULL,
    "label" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "providerAccountUid" TEXT NOT NULL,
    "inScope" BOOLEAN NOT NULL DEFAULT false,
    "balanceCents" INTEGER,
    "balanceAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BankAccount_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "BankConnection" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Transaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "statementId" TEXT NOT NULL,
    "date" DATETIME,
    "counterparty" TEXT,
    "amountCents" INTEGER NOT NULL,
    "reference" TEXT,
    "message" TEXT,
    "type" TEXT NOT NULL DEFAULT 'meno',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receiptId" TEXT,
    "suggestedReceiptId" TEXT,
    "matchStatus" TEXT NOT NULL DEFAULT 'unmatched',
    "matchScore" REAL,
    "matchReasons" TEXT,
    "userId" TEXT,
    "bankRef" TEXT,
    "source" TEXT NOT NULL DEFAULT 'file',
    "iban" TEXT,
    CONSTRAINT "Transaction_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "Statement" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Transaction_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "Receipt" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Transaction_suggestedReceiptId_fkey" FOREIGN KEY ("suggestedReceiptId") REFERENCES "Receipt" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Transaction" ("amountCents", "counterparty", "createdAt", "date", "id", "matchReasons", "matchScore", "matchStatus", "message", "receiptId", "reference", "statementId", "suggestedReceiptId", "type") SELECT "amountCents", "counterparty", "createdAt", "date", "id", "matchReasons", "matchScore", "matchStatus", "message", "receiptId", "reference", "statementId", "suggestedReceiptId", "type" FROM "Transaction";
DROP TABLE "Transaction";
ALTER TABLE "new_Transaction" RENAME TO "Transaction";
UPDATE "Transaction" SET "userId" = (
    SELECT "userId" FROM "Statement" WHERE "Statement"."id" = "Transaction"."statementId"
);
CREATE UNIQUE INDEX "Transaction_receiptId_key" ON "Transaction"("receiptId");
CREATE INDEX "Transaction_statementId_date_idx" ON "Transaction"("statementId", "date");
CREATE INDEX "Transaction_statementId_matchStatus_idx" ON "Transaction"("statementId", "matchStatus");
CREATE INDEX "Transaction_suggestedReceiptId_idx" ON "Transaction"("suggestedReceiptId");
CREATE INDEX "Transaction_userId_source_idx" ON "Transaction"("userId", "source");
CREATE UNIQUE INDEX "Transaction_userId_bankRef_key" ON "Transaction"("userId", "bankRef");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "BankConnection_userId_status_idx" ON "BankConnection"("userId", "status");

-- CreateIndex
CREATE INDEX "BankConnection_status_lastSyncAt_idx" ON "BankConnection"("status", "lastSyncAt");

-- CreateIndex
CREATE INDEX "BankConnection_authStateHash_idx" ON "BankConnection"("authStateHash");

-- CreateIndex
CREATE INDEX "BankAccount_userId_iban_idx" ON "BankAccount"("userId", "iban");

-- CreateIndex
CREATE UNIQUE INDEX "BankAccount_connectionId_providerAccountUid_key" ON "BankAccount"("connectionId", "providerAccountUid");
