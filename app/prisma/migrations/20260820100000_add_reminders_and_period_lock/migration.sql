-- AlterTable: late interest, reminder fee and the closed-books watermark.
ALTER TABLE "User" ADD COLUMN "lateInterestPercent" REAL;
ALTER TABLE "User" ADD COLUMN "reminderFeeCents" INTEGER NOT NULL DEFAULT 500;
ALTER TABLE "User" ADD COLUMN "booksLockedThrough" TEXT;

-- CreateTable
CREATE TABLE "InvoiceReminder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "invoiceId" TEXT NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 1,
    "sentAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentTo" TEXT,
    "dueDate" DATETIME NOT NULL,
    "openCents" INTEGER NOT NULL,
    "interestCents" INTEGER NOT NULL,
    "feeCents" INTEGER NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "annualRatePercent" REAL,
    "daysLate" INTEGER NOT NULL,
    CONSTRAINT "InvoiceReminder_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SalesInvoice" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "InvoiceReminder_invoiceId_sentAt_idx" ON "InvoiceReminder"("invoiceId", "sentAt");
