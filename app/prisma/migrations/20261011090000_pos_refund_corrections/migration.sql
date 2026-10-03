-- Korttimaksun palautus lukitulla kuukaudella. A locked month is never changed:
-- a refund of a booked card payment whose month is locked becomes a correction
-- card (Huomioitavat); accepting it posts a negative card payment row in the
-- first open month. One row per Stripe refund id, so retries and webhooks
-- never make two cards or two corrections.
CREATE TABLE "PosRefund" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "posPaymentId" TEXT NOT NULL,
    "stripeRefundId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "refundedAt" DATETIME NOT NULL,
    "books" TEXT NOT NULL,
    "correctionPaymentId" TEXT,
    "correctedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PosRefund_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PosRefund_posPaymentId_fkey" FOREIGN KEY ("posPaymentId") REFERENCES "PosPayment" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PosRefund_correctionPaymentId_fkey" FOREIGN KEY ("correctionPaymentId") REFERENCES "InvoicePayment" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PosRefund_stripeRefundId_key" ON "PosRefund"("stripeRefundId");
CREATE UNIQUE INDEX "PosRefund_correctionPaymentId_key" ON "PosRefund"("correctionPaymentId");
CREATE INDEX "PosRefund_userId_books_idx" ON "PosRefund"("userId", "books");
CREATE INDEX "PosRefund_posPaymentId_idx" ON "PosRefund"("posPaymentId");
