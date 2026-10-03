-- Tilin luonti ja salasanan palautus sähköpostikoodilla. Purely additive:
-- two new tables and two new AccountToken columns with defaults.
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
CREATE INDEX "PendingSignup_expiresAt_idx" ON "PendingSignup"("expiresAt");

CREATE TABLE "AccountCodeGuard" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scope" TEXT NOT NULL,
    "hourFailures" INTEGER NOT NULL DEFAULT 0,
    "hourStart" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dayFailures" INTEGER NOT NULL DEFAULT 0,
    "dayStart" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "blockedUntil" DATETIME
);
CREATE UNIQUE INDEX "AccountCodeGuard_scope_key" ON "AccountCodeGuard"("scope");
