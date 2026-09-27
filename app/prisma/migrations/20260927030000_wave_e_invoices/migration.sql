-- Credit notes, invoice number sequence, activity, send history and a small catalog.
ALTER TABLE "SalesInvoice" ADD COLUMN "documentKind" TEXT NOT NULL DEFAULT 'invoice';
ALTER TABLE "SalesInvoice" ADD COLUMN "creditsInvoiceId" TEXT;

CREATE INDEX "SalesInvoice_creditsInvoiceId_idx" ON "SalesInvoice"("creditsInvoiceId");

ALTER TABLE "InvoiceEmailSend" ADD COLUMN "attachmentName" TEXT;
ALTER TABLE "InvoiceEmailSend" ADD COLUMN "grossCents" INTEGER;

CREATE TABLE "InvoiceSequence" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "nextNumber" INTEGER NOT NULL,
    CONSTRAINT "InvoiceSequence_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "InvoiceActivity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "invoiceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InvoiceActivity_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SalesInvoice" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "InvoiceActivity_invoiceId_createdAt_idx" ON "InvoiceActivity"("invoiceId", "createdAt");

CREATE TABLE "CatalogItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'kpl',
    "unitPriceCents" INTEGER NOT NULL,
    "vatRatePermille" INTEGER NOT NULL DEFAULT 255,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CatalogItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "CatalogItem_userId_archivedAt_idx" ON "CatalogItem"("userId", "archivedAt");
