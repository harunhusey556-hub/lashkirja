-- W18 freshness contract: one change counter per user (GET /api/sync/version). Purely additive.
-- The counter is bumped by SQLite triggers, not by application code, so every write path (bank
-- sync, statement import, receipt/invoice/payment save, matching, deletes and cascades) moves it
-- without each route having to remember to. A row is created on the user's first change; a user
-- without one reads as version 0.
CREATE TABLE IF NOT EXISTS "DataVersion" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "version" INTEGER NOT NULL DEFAULT 0,
    "bankAt" DATETIME,
    "receiptsAt" DATETIME,
    "invoicesAt" DATETIME
);

-- The paged bank feed reads a user's rows newest first.
CREATE INDEX IF NOT EXISTS "Transaction_userId_date_idx" ON "Transaction"("userId", "date");

CREATE TRIGGER IF NOT EXISTS "DataVersion_Transaction_ai" AFTER INSERT ON "Transaction" BEGIN
    INSERT INTO "DataVersion" ("userId") SELECT u FROM (SELECT COALESCE(NEW."userId", (SELECT "userId" FROM "Statement" WHERE "id" = NEW."statementId")) AS u) WHERE u IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "DataVersion" WHERE "userId" = u);
    UPDATE "DataVersion" SET "version" = "version" + 1, "bankAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE "userId" = COALESCE(NEW."userId", (SELECT "userId" FROM "Statement" WHERE "id" = NEW."statementId"));
END;

CREATE TRIGGER IF NOT EXISTS "DataVersion_Transaction_au" AFTER UPDATE ON "Transaction" BEGIN
    INSERT INTO "DataVersion" ("userId") SELECT u FROM (SELECT COALESCE(NEW."userId", (SELECT "userId" FROM "Statement" WHERE "id" = NEW."statementId")) AS u) WHERE u IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "DataVersion" WHERE "userId" = u);
    UPDATE "DataVersion" SET "version" = "version" + 1, "bankAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE "userId" = COALESCE(NEW."userId", (SELECT "userId" FROM "Statement" WHERE "id" = NEW."statementId"));
END;

CREATE TRIGGER IF NOT EXISTS "DataVersion_Transaction_ad" AFTER DELETE ON "Transaction" BEGIN
    INSERT INTO "DataVersion" ("userId") SELECT u FROM (SELECT COALESCE(OLD."userId", (SELECT "userId" FROM "Statement" WHERE "id" = OLD."statementId")) AS u) WHERE u IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "DataVersion" WHERE "userId" = u);
    UPDATE "DataVersion" SET "version" = "version" + 1, "bankAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE "userId" = COALESCE(OLD."userId", (SELECT "userId" FROM "Statement" WHERE "id" = OLD."statementId"));
END;

CREATE TRIGGER IF NOT EXISTS "DataVersion_Statement_ai" AFTER INSERT ON "Statement" BEGIN
    INSERT INTO "DataVersion" ("userId") SELECT u FROM (SELECT NEW."userId" AS u) WHERE u IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "DataVersion" WHERE "userId" = u);
    UPDATE "DataVersion" SET "version" = "version" + 1, "bankAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE "userId" = NEW."userId";
END;

CREATE TRIGGER IF NOT EXISTS "DataVersion_Statement_au" AFTER UPDATE ON "Statement" BEGIN
    INSERT INTO "DataVersion" ("userId") SELECT u FROM (SELECT NEW."userId" AS u) WHERE u IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "DataVersion" WHERE "userId" = u);
    UPDATE "DataVersion" SET "version" = "version" + 1, "bankAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE "userId" = NEW."userId";
END;

CREATE TRIGGER IF NOT EXISTS "DataVersion_Statement_ad" AFTER DELETE ON "Statement" BEGIN
    INSERT INTO "DataVersion" ("userId") SELECT u FROM (SELECT OLD."userId" AS u) WHERE u IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "DataVersion" WHERE "userId" = u);
    UPDATE "DataVersion" SET "version" = "version" + 1, "bankAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE "userId" = OLD."userId";
END;

CREATE TRIGGER IF NOT EXISTS "DataVersion_BankConnection_ai" AFTER INSERT ON "BankConnection" BEGIN
    INSERT INTO "DataVersion" ("userId") SELECT u FROM (SELECT NEW."userId" AS u) WHERE u IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "DataVersion" WHERE "userId" = u);
    UPDATE "DataVersion" SET "version" = "version" + 1, "bankAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE "userId" = NEW."userId";
END;

CREATE TRIGGER IF NOT EXISTS "DataVersion_BankConnection_au" AFTER UPDATE ON "BankConnection" BEGIN
    INSERT INTO "DataVersion" ("userId") SELECT u FROM (SELECT NEW."userId" AS u) WHERE u IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "DataVersion" WHERE "userId" = u);
    UPDATE "DataVersion" SET "version" = "version" + 1, "bankAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE "userId" = NEW."userId";
END;

CREATE TRIGGER IF NOT EXISTS "DataVersion_BankConnection_ad" AFTER DELETE ON "BankConnection" BEGIN
    INSERT INTO "DataVersion" ("userId") SELECT u FROM (SELECT OLD."userId" AS u) WHERE u IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "DataVersion" WHERE "userId" = u);
    UPDATE "DataVersion" SET "version" = "version" + 1, "bankAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE "userId" = OLD."userId";
END;

CREATE TRIGGER IF NOT EXISTS "DataVersion_ConnectedAccount_ai" AFTER INSERT ON "ConnectedAccount" BEGIN
    INSERT INTO "DataVersion" ("userId") SELECT u FROM (SELECT NEW."userId" AS u) WHERE u IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "DataVersion" WHERE "userId" = u);
    UPDATE "DataVersion" SET "version" = "version" + 1, "bankAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE "userId" = NEW."userId";
END;

CREATE TRIGGER IF NOT EXISTS "DataVersion_ConnectedAccount_au" AFTER UPDATE ON "ConnectedAccount" BEGIN
    INSERT INTO "DataVersion" ("userId") SELECT u FROM (SELECT NEW."userId" AS u) WHERE u IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "DataVersion" WHERE "userId" = u);
    UPDATE "DataVersion" SET "version" = "version" + 1, "bankAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE "userId" = NEW."userId";
END;

CREATE TRIGGER IF NOT EXISTS "DataVersion_ConnectedAccount_ad" AFTER DELETE ON "ConnectedAccount" BEGIN
    INSERT INTO "DataVersion" ("userId") SELECT u FROM (SELECT OLD."userId" AS u) WHERE u IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "DataVersion" WHERE "userId" = u);
    UPDATE "DataVersion" SET "version" = "version" + 1, "bankAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE "userId" = OLD."userId";
END;

CREATE TRIGGER IF NOT EXISTS "DataVersion_BankAccount_ai" AFTER INSERT ON "BankAccount" BEGIN
    INSERT INTO "DataVersion" ("userId") SELECT u FROM (SELECT NEW."userId" AS u) WHERE u IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "DataVersion" WHERE "userId" = u);
    UPDATE "DataVersion" SET "version" = "version" + 1, "bankAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE "userId" = NEW."userId";
END;

CREATE TRIGGER IF NOT EXISTS "DataVersion_BankAccount_au" AFTER UPDATE ON "BankAccount" BEGIN
    INSERT INTO "DataVersion" ("userId") SELECT u FROM (SELECT NEW."userId" AS u) WHERE u IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "DataVersion" WHERE "userId" = u);
    UPDATE "DataVersion" SET "version" = "version" + 1, "bankAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE "userId" = NEW."userId";
END;

CREATE TRIGGER IF NOT EXISTS "DataVersion_BankAccount_ad" AFTER DELETE ON "BankAccount" BEGIN
    INSERT INTO "DataVersion" ("userId") SELECT u FROM (SELECT OLD."userId" AS u) WHERE u IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "DataVersion" WHERE "userId" = u);
    UPDATE "DataVersion" SET "version" = "version" + 1, "bankAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE "userId" = OLD."userId";
END;

CREATE TRIGGER IF NOT EXISTS "DataVersion_MonthlyBalance_ai" AFTER INSERT ON "MonthlyBalance" BEGIN
    INSERT INTO "DataVersion" ("userId") SELECT u FROM (SELECT (SELECT "userId" FROM "BankAccount" WHERE "id" = NEW."bankAccountId") AS u) WHERE u IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "DataVersion" WHERE "userId" = u);
    UPDATE "DataVersion" SET "version" = "version" + 1, "bankAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE "userId" = (SELECT "userId" FROM "BankAccount" WHERE "id" = NEW."bankAccountId");
END;

CREATE TRIGGER IF NOT EXISTS "DataVersion_MonthlyBalance_au" AFTER UPDATE ON "MonthlyBalance" BEGIN
    INSERT INTO "DataVersion" ("userId") SELECT u FROM (SELECT (SELECT "userId" FROM "BankAccount" WHERE "id" = NEW."bankAccountId") AS u) WHERE u IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "DataVersion" WHERE "userId" = u);
    UPDATE "DataVersion" SET "version" = "version" + 1, "bankAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE "userId" = (SELECT "userId" FROM "BankAccount" WHERE "id" = NEW."bankAccountId");
END;

CREATE TRIGGER IF NOT EXISTS "DataVersion_MonthlyBalance_ad" AFTER DELETE ON "MonthlyBalance" BEGIN
    INSERT INTO "DataVersion" ("userId") SELECT u FROM (SELECT (SELECT "userId" FROM "BankAccount" WHERE "id" = OLD."bankAccountId") AS u) WHERE u IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "DataVersion" WHERE "userId" = u);
    UPDATE "DataVersion" SET "version" = "version" + 1, "bankAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE "userId" = (SELECT "userId" FROM "BankAccount" WHERE "id" = OLD."bankAccountId");
END;

CREATE TRIGGER IF NOT EXISTS "DataVersion_Receipt_ai" AFTER INSERT ON "Receipt" BEGIN
    INSERT INTO "DataVersion" ("userId") SELECT u FROM (SELECT NEW."userId" AS u) WHERE u IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "DataVersion" WHERE "userId" = u);
    UPDATE "DataVersion" SET "version" = "version" + 1, "receiptsAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE "userId" = NEW."userId";
END;

CREATE TRIGGER IF NOT EXISTS "DataVersion_Receipt_au" AFTER UPDATE ON "Receipt" BEGIN
    INSERT INTO "DataVersion" ("userId") SELECT u FROM (SELECT NEW."userId" AS u) WHERE u IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "DataVersion" WHERE "userId" = u);
    UPDATE "DataVersion" SET "version" = "version" + 1, "receiptsAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE "userId" = NEW."userId";
END;

CREATE TRIGGER IF NOT EXISTS "DataVersion_Receipt_ad" AFTER DELETE ON "Receipt" BEGIN
    INSERT INTO "DataVersion" ("userId") SELECT u FROM (SELECT OLD."userId" AS u) WHERE u IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "DataVersion" WHERE "userId" = u);
    UPDATE "DataVersion" SET "version" = "version" + 1, "receiptsAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE "userId" = OLD."userId";
END;

CREATE TRIGGER IF NOT EXISTS "DataVersion_MatchRejection_ai" AFTER INSERT ON "MatchRejection" BEGIN
    INSERT INTO "DataVersion" ("userId") SELECT u FROM (SELECT (SELECT s."userId" FROM "Transaction" t JOIN "Statement" s ON s."id" = t."statementId" WHERE t."id" = NEW."transactionId") AS u) WHERE u IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "DataVersion" WHERE "userId" = u);
    UPDATE "DataVersion" SET "version" = "version" + 1, "receiptsAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE "userId" = (SELECT s."userId" FROM "Transaction" t JOIN "Statement" s ON s."id" = t."statementId" WHERE t."id" = NEW."transactionId");
END;

CREATE TRIGGER IF NOT EXISTS "DataVersion_MatchRejection_au" AFTER UPDATE ON "MatchRejection" BEGIN
    INSERT INTO "DataVersion" ("userId") SELECT u FROM (SELECT (SELECT s."userId" FROM "Transaction" t JOIN "Statement" s ON s."id" = t."statementId" WHERE t."id" = NEW."transactionId") AS u) WHERE u IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "DataVersion" WHERE "userId" = u);
    UPDATE "DataVersion" SET "version" = "version" + 1, "receiptsAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE "userId" = (SELECT s."userId" FROM "Transaction" t JOIN "Statement" s ON s."id" = t."statementId" WHERE t."id" = NEW."transactionId");
END;

CREATE TRIGGER IF NOT EXISTS "DataVersion_MatchRejection_ad" AFTER DELETE ON "MatchRejection" BEGIN
    INSERT INTO "DataVersion" ("userId") SELECT u FROM (SELECT (SELECT s."userId" FROM "Transaction" t JOIN "Statement" s ON s."id" = t."statementId" WHERE t."id" = OLD."transactionId") AS u) WHERE u IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "DataVersion" WHERE "userId" = u);
    UPDATE "DataVersion" SET "version" = "version" + 1, "receiptsAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE "userId" = (SELECT s."userId" FROM "Transaction" t JOIN "Statement" s ON s."id" = t."statementId" WHERE t."id" = OLD."transactionId");
END;

CREATE TRIGGER IF NOT EXISTS "DataVersion_SalesInvoice_ai" AFTER INSERT ON "SalesInvoice" BEGIN
    INSERT INTO "DataVersion" ("userId") SELECT u FROM (SELECT NEW."userId" AS u) WHERE u IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "DataVersion" WHERE "userId" = u);
    UPDATE "DataVersion" SET "version" = "version" + 1, "invoicesAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE "userId" = NEW."userId";
END;

CREATE TRIGGER IF NOT EXISTS "DataVersion_SalesInvoice_au" AFTER UPDATE ON "SalesInvoice" BEGIN
    INSERT INTO "DataVersion" ("userId") SELECT u FROM (SELECT NEW."userId" AS u) WHERE u IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "DataVersion" WHERE "userId" = u);
    UPDATE "DataVersion" SET "version" = "version" + 1, "invoicesAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE "userId" = NEW."userId";
END;

CREATE TRIGGER IF NOT EXISTS "DataVersion_SalesInvoice_ad" AFTER DELETE ON "SalesInvoice" BEGIN
    INSERT INTO "DataVersion" ("userId") SELECT u FROM (SELECT OLD."userId" AS u) WHERE u IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "DataVersion" WHERE "userId" = u);
    UPDATE "DataVersion" SET "version" = "version" + 1, "invoicesAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE "userId" = OLD."userId";
END;

CREATE TRIGGER IF NOT EXISTS "DataVersion_InvoicePayment_ai" AFTER INSERT ON "InvoicePayment" BEGIN
    INSERT INTO "DataVersion" ("userId") SELECT u FROM (SELECT (SELECT "userId" FROM "SalesInvoice" WHERE "id" = NEW."invoiceId") AS u) WHERE u IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "DataVersion" WHERE "userId" = u);
    UPDATE "DataVersion" SET "version" = "version" + 1, "invoicesAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE "userId" = (SELECT "userId" FROM "SalesInvoice" WHERE "id" = NEW."invoiceId");
END;

CREATE TRIGGER IF NOT EXISTS "DataVersion_InvoicePayment_au" AFTER UPDATE ON "InvoicePayment" BEGIN
    INSERT INTO "DataVersion" ("userId") SELECT u FROM (SELECT (SELECT "userId" FROM "SalesInvoice" WHERE "id" = NEW."invoiceId") AS u) WHERE u IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "DataVersion" WHERE "userId" = u);
    UPDATE "DataVersion" SET "version" = "version" + 1, "invoicesAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE "userId" = (SELECT "userId" FROM "SalesInvoice" WHERE "id" = NEW."invoiceId");
END;

CREATE TRIGGER IF NOT EXISTS "DataVersion_InvoicePayment_ad" AFTER DELETE ON "InvoicePayment" BEGIN
    INSERT INTO "DataVersion" ("userId") SELECT u FROM (SELECT (SELECT "userId" FROM "SalesInvoice" WHERE "id" = OLD."invoiceId") AS u) WHERE u IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "DataVersion" WHERE "userId" = u);
    UPDATE "DataVersion" SET "version" = "version" + 1, "invoicesAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE "userId" = (SELECT "userId" FROM "SalesInvoice" WHERE "id" = OLD."invoiceId");
END;

CREATE TRIGGER IF NOT EXISTS "DataVersion_PurchaseInvoice_ai" AFTER INSERT ON "PurchaseInvoice" BEGIN
    INSERT INTO "DataVersion" ("userId") SELECT u FROM (SELECT NEW."userId" AS u) WHERE u IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "DataVersion" WHERE "userId" = u);
    UPDATE "DataVersion" SET "version" = "version" + 1, "invoicesAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE "userId" = NEW."userId";
END;

CREATE TRIGGER IF NOT EXISTS "DataVersion_PurchaseInvoice_au" AFTER UPDATE ON "PurchaseInvoice" BEGIN
    INSERT INTO "DataVersion" ("userId") SELECT u FROM (SELECT NEW."userId" AS u) WHERE u IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "DataVersion" WHERE "userId" = u);
    UPDATE "DataVersion" SET "version" = "version" + 1, "invoicesAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE "userId" = NEW."userId";
END;

CREATE TRIGGER IF NOT EXISTS "DataVersion_PurchaseInvoice_ad" AFTER DELETE ON "PurchaseInvoice" BEGIN
    INSERT INTO "DataVersion" ("userId") SELECT u FROM (SELECT OLD."userId" AS u) WHERE u IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "DataVersion" WHERE "userId" = u);
    UPDATE "DataVersion" SET "version" = "version" + 1, "invoicesAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE "userId" = OLD."userId";
END;

CREATE TRIGGER IF NOT EXISTS "DataVersion_PurchasePayment_ai" AFTER INSERT ON "PurchasePayment" BEGIN
    INSERT INTO "DataVersion" ("userId") SELECT u FROM (SELECT (SELECT "userId" FROM "PurchaseInvoice" WHERE "id" = NEW."purchaseInvoiceId") AS u) WHERE u IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "DataVersion" WHERE "userId" = u);
    UPDATE "DataVersion" SET "version" = "version" + 1, "invoicesAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE "userId" = (SELECT "userId" FROM "PurchaseInvoice" WHERE "id" = NEW."purchaseInvoiceId");
END;

CREATE TRIGGER IF NOT EXISTS "DataVersion_PurchasePayment_au" AFTER UPDATE ON "PurchasePayment" BEGIN
    INSERT INTO "DataVersion" ("userId") SELECT u FROM (SELECT (SELECT "userId" FROM "PurchaseInvoice" WHERE "id" = NEW."purchaseInvoiceId") AS u) WHERE u IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "DataVersion" WHERE "userId" = u);
    UPDATE "DataVersion" SET "version" = "version" + 1, "invoicesAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE "userId" = (SELECT "userId" FROM "PurchaseInvoice" WHERE "id" = NEW."purchaseInvoiceId");
END;

CREATE TRIGGER IF NOT EXISTS "DataVersion_PurchasePayment_ad" AFTER DELETE ON "PurchasePayment" BEGIN
    INSERT INTO "DataVersion" ("userId") SELECT u FROM (SELECT (SELECT "userId" FROM "PurchaseInvoice" WHERE "id" = OLD."purchaseInvoiceId") AS u) WHERE u IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "DataVersion" WHERE "userId" = u);
    UPDATE "DataVersion" SET "version" = "version" + 1, "invoicesAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE "userId" = (SELECT "userId" FROM "PurchaseInvoice" WHERE "id" = OLD."purchaseInvoiceId");
END;
