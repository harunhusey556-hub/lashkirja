-- Freeze the parties printed on an issued invoice, record an explicit
-- close that is not a payment, and keep one row per invoice email attempt.
ALTER TABLE "SalesInvoice" ADD COLUMN "partySnapshot" TEXT;
ALTER TABLE "SalesInvoice" ADD COLUMN "closedReason" TEXT;
ALTER TABLE "SalesInvoice" ADD COLUMN "closedAt" DATETIME;

ALTER TABLE "PurchaseInvoice" ADD COLUMN "closedReason" TEXT;
ALTER TABLE "PurchaseInvoice" ADD COLUMN "closedAt" DATETIME;

CREATE TABLE "InvoiceEmailSend" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "invoiceId" TEXT NOT NULL,
    "toAddress" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "messageId" TEXT,
    "error" TEXT,
    "partySnapshot" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    CONSTRAINT "InvoiceEmailSend_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SalesInvoice" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "InvoiceEmailSend_invoiceId_createdAt_idx" ON "InvoiceEmailSend"("invoiceId", "createdAt");
