-- Korttimaksut (Stripe Terminal / Tap to Pay). Each business takes card
-- payments on its own Stripe connected account (direct charges); the payment
-- is booked on the invoice only after the server has verified it with Stripe.
ALTER TABLE "User" ADD COLUMN "stripeAccountId" TEXT;
ALTER TABLE "User" ADD COLUMN "stripeLocationId" TEXT;
ALTER TABLE "User" ADD COLUMN "stripeChargesEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "stripePayoutsEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "stripeDetailsSubmitted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "posEnabled" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "User_stripeAccountId_key" ON "User"("stripeAccountId");

CREATE TABLE "PosPayment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'stripe',
    "providerPaymentIntentId" TEXT NOT NULL,
    "providerChargeId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "status" TEXT NOT NULL DEFAULT 'created',
    "refundedCents" INTEGER NOT NULL DEFAULT 0,
    "cardBrand" TEXT,
    "cardLast4" TEXT,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "succeededAt" DATETIME,
    "refundedAt" DATETIME,
    CONSTRAINT "PosPayment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PosPayment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SalesInvoice" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PosPayment_providerPaymentIntentId_key" ON "PosPayment"("providerPaymentIntentId");
CREATE INDEX "PosPayment_userId_createdAt_idx" ON "PosPayment"("userId", "createdAt");
CREATE INDEX "PosPayment_invoiceId_idx" ON "PosPayment"("invoiceId");

-- One card payment books at most one invoice payment (finalize and the
-- webhook may both arrive; the unique index is the backstop).
ALTER TABLE "InvoicePayment" ADD COLUMN "posPaymentId" TEXT REFERENCES "PosPayment" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE UNIQUE INDEX "InvoicePayment_posPaymentId_key" ON "InvoicePayment"("posPaymentId");
