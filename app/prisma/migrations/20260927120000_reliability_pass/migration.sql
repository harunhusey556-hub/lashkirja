-- Legacy cookies (no AuthSession id) die after logout-all or a password change.
ALTER TABLE "User" ADD COLUMN "legacySessionsRevokedAt" DATETIME;

-- Same idempotency key with a different body is refused.
ALTER TABLE "IdempotencyRecord" ADD COLUMN "requestHash" TEXT NOT NULL DEFAULT '';

-- The run that may write a document result. Cancel and retry replace it.
ALTER TABLE "BackgroundJob" ADD COLUMN "attemptToken" TEXT;

-- Invoice send holds the row until the PDF outcome is stored.
ALTER TABLE "SalesInvoice" ADD COLUMN "sendLockToken" TEXT;
ALTER TABLE "SalesInvoice" ADD COLUMN "sendLockAt" DATETIME;
ALTER TABLE "SalesInvoice" ADD COLUMN "sentContentHash" TEXT;
ALTER TABLE "SalesInvoice" ADD COLUMN "sentDocumentSnapshot" TEXT;

ALTER TABLE "InvoiceEmailSend" ADD COLUMN "contentHash" TEXT;
ALTER TABLE "InvoiceEmailSend" ADD COLUMN "documentSnapshot" TEXT;
