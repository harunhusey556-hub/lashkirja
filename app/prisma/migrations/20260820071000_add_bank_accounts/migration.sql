-- CreateTable
CREATE TABLE "BankAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "bankName" TEXT,
    "iban" TEXT,
    "bic" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "openingBalanceCents" INTEGER NOT NULL DEFAULT 0,
    "openingDate" DATETIME NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BankAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MonthlyBalance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bankAccountId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "closingBalanceCents" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MonthlyBalance_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- AlterTable
ALTER TABLE "Statement" ADD COLUMN "bankAccountId" TEXT REFERENCES "BankAccount" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE UNIQUE INDEX "BankAccount_userId_iban_key" ON "BankAccount"("userId", "iban");
CREATE INDEX "BankAccount_userId_archivedAt_idx" ON "BankAccount"("userId", "archivedAt");
CREATE UNIQUE INDEX "MonthlyBalance_bankAccountId_month_key" ON "MonthlyBalance"("bankAccountId", "month");
CREATE INDEX "MonthlyBalance_bankAccountId_month_idx" ON "MonthlyBalance"("bankAccountId", "month");
CREATE INDEX "Statement_bankAccountId_periodMonth_idx" ON "Statement"("bankAccountId", "periodMonth");
