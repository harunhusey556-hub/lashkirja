-- RedefineTables
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
    "notes" TEXT,
    "type" TEXT NOT NULL DEFAULT 'meno',
    "reference" TEXT,
    "invoiceNumber" TEXT,
    "filePath" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "confidence" REAL,
    "rawText" TEXT,
    "reviewStatus" TEXT NOT NULL DEFAULT 'approved',
    "uploadId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Receipt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Receipt_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "Upload" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Receipt" ("category", "confidence", "createdAt", "date", "fileName", "filePath", "id", "invoiceNumber", "notes", "rawText", "reference", "source", "totalAmountCents", "type", "updatedAt", "uploadId", "userId", "vatDetails", "vendor") SELECT "category", "confidence", "createdAt", "date", "fileName", "filePath", "id", "invoiceNumber", "notes", "rawText", "reference", "source", "totalAmountCents", "type", "updatedAt", "uploadId", "userId", "vatDetails", "vendor" FROM "Receipt";
DROP TABLE "Receipt";
ALTER TABLE "new_Receipt" RENAME TO "Receipt";
CREATE UNIQUE INDEX "Receipt_uploadId_key" ON "Receipt"("uploadId");
CREATE INDEX "Receipt_userId_date_idx" ON "Receipt"("userId", "date");
CREATE INDEX "Receipt_userId_createdAt_idx" ON "Receipt"("userId", "createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
