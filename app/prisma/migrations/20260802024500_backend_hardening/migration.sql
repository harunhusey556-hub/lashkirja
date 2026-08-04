-- Exact money, tenant-scoped upload ownership, deduplication, and hot-path indexes.
ALTER TABLE "Statement" ADD COLUMN "checksum" TEXT;

CREATE TABLE "Upload" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "extractedJson" TEXT,
    "extractionSource" TEXT,
    "confidence" REAL,
    "rawText" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "claimedAt" DATETIME,
    CONSTRAINT "Upload_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_Receipt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "vendor" TEXT,
    "date" DATETIME,
    "totalAmountCents" INTEGER,
    "vatDetails" TEXT,
    "category" TEXT,
    "type" TEXT NOT NULL DEFAULT 'meno',
    "reference" TEXT,
    "invoiceNumber" TEXT,
    "filePath" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "confidence" REAL,
    "rawText" TEXT,
    "uploadId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Receipt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Receipt_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "Upload" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Receipt" (
    "category", "confidence", "createdAt", "date", "fileName", "filePath",
    "id", "invoiceNumber", "rawText", "reference", "source", "type",
    "updatedAt", "userId", "vatDetails", "vendor", "totalAmountCents"
)
SELECT
    "category", "confidence", "createdAt", "date", "fileName", "filePath",
    "id", "invoiceNumber", "rawText", "reference", "source", "type",
    "updatedAt", "userId", "vatDetails", "vendor",
    CASE WHEN "totalAmount" IS NULL THEN NULL ELSE CAST(ROUND("totalAmount" * 100.0) AS INTEGER) END
FROM "Receipt";
DROP TABLE "Receipt";
ALTER TABLE "new_Receipt" RENAME TO "Receipt";
CREATE UNIQUE INDEX "Receipt_uploadId_key" ON "Receipt"("uploadId");
CREATE INDEX "Receipt_userId_date_idx" ON "Receipt"("userId", "date");
CREATE INDEX "Receipt_userId_createdAt_idx" ON "Receipt"("userId", "createdAt");

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
    CONSTRAINT "Transaction_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "Statement" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Transaction_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "Receipt" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Transaction_suggestedReceiptId_fkey" FOREIGN KEY ("suggestedReceiptId") REFERENCES "Receipt" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Transaction" (
    "counterparty", "createdAt", "date", "id", "matchReasons", "matchScore",
    "matchStatus", "message", "receiptId", "reference", "statementId",
    "suggestedReceiptId", "type", "amountCents"
)
SELECT
    "counterparty", "createdAt", "date", "id", "matchReasons", "matchScore",
    "matchStatus", "message", "receiptId", "reference", "statementId",
    "suggestedReceiptId", "type", CAST(ROUND("amount" * 100.0) AS INTEGER)
FROM "Transaction";
DROP TABLE "Transaction";
ALTER TABLE "new_Transaction" RENAME TO "Transaction";
CREATE UNIQUE INDEX "Transaction_receiptId_key" ON "Transaction"("receiptId");
CREATE UNIQUE INDEX "Transaction_suggestedReceiptId_key" ON "Transaction"("suggestedReceiptId");
CREATE INDEX "Transaction_statementId_date_idx" ON "Transaction"("statementId", "date");
CREATE INDEX "Transaction_statementId_matchStatus_idx" ON "Transaction"("statementId", "matchStatus");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

CREATE UNIQUE INDEX "Upload_storageKey_key" ON "Upload"("storageKey");
CREATE INDEX "Upload_userId_purpose_claimedAt_idx" ON "Upload"("userId", "purpose", "claimedAt");
CREATE INDEX "Upload_expiresAt_idx" ON "Upload"("expiresAt");
CREATE UNIQUE INDEX "Upload_userId_sha256_purpose_key" ON "Upload"("userId", "sha256", "purpose");
CREATE INDEX "Statement_userId_periodMonth_idx" ON "Statement"("userId", "periodMonth");
CREATE INDEX "Statement_userId_uploadedAt_idx" ON "Statement"("userId", "uploadedAt");
CREATE UNIQUE INDEX "Statement_userId_checksum_key" ON "Statement"("userId", "checksum");
