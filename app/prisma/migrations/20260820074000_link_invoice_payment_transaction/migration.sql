-- SQLite cannot add a foreign key to an existing table, so the table is
-- rebuilt. InvoicePayment was introduced in the previous migration, so any
-- rows here are copied across unchanged.
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_InvoicePayment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "invoiceId" TEXT NOT NULL,
    "transactionId" TEXT,
    "paidDate" DATETIME NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InvoicePayment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SalesInvoice" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "InvoicePayment_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "new_InvoicePayment" ("id", "invoiceId", "transactionId", "paidDate", "amountCents", "source", "note", "createdAt")
SELECT "id", "invoiceId", "transactionId", "paidDate", "amountCents", "source", "note", "createdAt" FROM "InvoicePayment";

DROP TABLE "InvoicePayment";
ALTER TABLE "new_InvoicePayment" RENAME TO "InvoicePayment";

CREATE UNIQUE INDEX "InvoicePayment_transactionId_key" ON "InvoicePayment"("transactionId");
CREATE INDEX "InvoicePayment_invoiceId_idx" ON "InvoicePayment"("invoiceId");

PRAGMA foreign_keys=ON;
