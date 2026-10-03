-- Tilin luonti ja salasanan palautus sähköpostikoodilla. Purely additive:
-- one new table and two new AccountToken columns with defaults.
ALTER TABLE "AccountToken" ADD COLUMN "codeHash" TEXT;
ALTER TABLE "AccountToken" ADD COLUMN "codeAttempts" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "PendingSignup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "PendingSignup_email_key" ON "PendingSignup"("email");
