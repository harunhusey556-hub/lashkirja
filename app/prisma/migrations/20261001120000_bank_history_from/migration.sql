-- The owner picks how far back the first bank sync goes, instead of the
-- bank's whole history (often years). Null keeps the old "longest" behaviour.
ALTER TABLE "BankConnection" ADD COLUMN "historyFrom" TEXT;
