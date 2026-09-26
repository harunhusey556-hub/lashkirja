-- CreateTable
CREATE TABLE "RecurringInvoice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "name" TEXT,
    "interval" TEXT NOT NULL,
    "anchorDay" INTEGER NOT NULL,
    "startDate" DATETIME NOT NULL,
    "endDate" DATETIME,
    "nextRunAt" DATETIME,
    "paymentTermDays" INTEGER NOT NULL DEFAULT 14,
    "notes" TEXT,
    "autoSend" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RecurringInvoice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RecurringInvoice_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RecurringInvoiceLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recurringInvoiceId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT NOT NULL,
    "quantityMilli" INTEGER NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'kpl',
    "unitPriceCents" INTEGER NOT NULL,
    "vatRatePermille" INTEGER NOT NULL DEFAULT 255,
    CONSTRAINT "RecurringInvoiceLine_recurringInvoiceId_fkey" FOREIGN KEY ("recurringInvoiceId") REFERENCES "RecurringInvoice" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RecurringInvoiceRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recurringInvoiceId" TEXT NOT NULL,
    "issueDate" DATETIME NOT NULL,
    "invoiceId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'created',
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RecurringInvoiceRun_recurringInvoiceId_fkey" FOREIGN KEY ("recurringInvoiceId") REFERENCES "RecurringInvoice" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RecurringInvoiceRun_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SalesInvoice" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "RecurringInvoice_userId_active_nextRunAt_idx" ON "RecurringInvoice"("userId", "active", "nextRunAt");
CREATE INDEX "RecurringInvoice_customerId_idx" ON "RecurringInvoice"("customerId");
CREATE INDEX "RecurringInvoiceLine_recurringInvoiceId_sortOrder_idx" ON "RecurringInvoiceLine"("recurringInvoiceId", "sortOrder");
CREATE UNIQUE INDEX "RecurringInvoiceRun_invoiceId_key" ON "RecurringInvoiceRun"("invoiceId");
CREATE UNIQUE INDEX "RecurringInvoiceRun_recurringInvoiceId_issueDate_key" ON "RecurringInvoiceRun"("recurringInvoiceId", "issueDate");
CREATE INDEX "RecurringInvoiceRun_recurringInvoiceId_createdAt_idx" ON "RecurringInvoiceRun"("recurringInvoiceId", "createdAt");
