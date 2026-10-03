-- Sähköpostimallit: saved subject + body for an invoice e-mail, with
-- placeholders the server fills per invoice. One default per user and kind is
-- kept by the application (the same way as the default bank account).
CREATE TABLE "InvoiceEmailTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'invoice',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "InvoiceEmailTemplate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "InvoiceEmailTemplate_userId_kind_idx" ON "InvoiceEmailTemplate"("userId", "kind");
