-- Toistuvat ostolaskut: a routine expense (rent, a subscription) becomes a
-- purchase invoice every period. One run row per (template, "YYYY-MM") keeps a
-- period from being created twice; deleting the template keeps its invoices.
CREATE TABLE "RecurringPurchase" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "supplierName" TEXT NOT NULL,
    "supplierBusinessId" TEXT,
    "supplierIban" TEXT,
    "reference" TEXT,
    "category" TEXT,
    "notes" TEXT,
    "grossCents" INTEGER NOT NULL,
    "vatRate" REAL NOT NULL,
    "interval" TEXT NOT NULL,
    "dayOfMonth" INTEGER NOT NULL,
    "dueDays" INTEGER NOT NULL,
    "startDate" DATETIME NOT NULL,
    "endDate" DATETIME,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "nextRunDate" DATETIME NOT NULL,
    "lastRunAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RecurringPurchase_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "RecurringPurchaseRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recurringPurchaseId" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "purchaseInvoiceId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RecurringPurchaseRun_recurringPurchaseId_fkey" FOREIGN KEY ("recurringPurchaseId") REFERENCES "RecurringPurchase" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RecurringPurchaseRun_purchaseInvoiceId_fkey" FOREIGN KEY ("purchaseInvoiceId") REFERENCES "PurchaseInvoice" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- A nullable column with a NULL default may carry its foreign key in place, so
-- the purchase invoice table (and its payments) is not rebuilt.
ALTER TABLE "PurchaseInvoice" ADD COLUMN "recurringPurchaseId" TEXT REFERENCES "RecurringPurchase" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "PurchaseInvoice_recurringPurchaseId_idx" ON "PurchaseInvoice"("recurringPurchaseId");
CREATE INDEX "RecurringPurchase_userId_active_nextRunDate_idx" ON "RecurringPurchase"("userId", "active", "nextRunDate");
CREATE UNIQUE INDEX "RecurringPurchaseRun_purchaseInvoiceId_key" ON "RecurringPurchaseRun"("purchaseInvoiceId");
CREATE UNIQUE INDEX "RecurringPurchaseRun_recurringPurchaseId_periodKey_key" ON "RecurringPurchaseRun"("recurringPurchaseId", "periodKey");
