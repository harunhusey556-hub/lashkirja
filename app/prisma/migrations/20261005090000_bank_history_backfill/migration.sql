-- The owner can move "Mistä lähtien" after connecting. Each account remembers
-- the earliest day its history was read from, so an earlier choice backfills
-- only the missing window; the connection remembers the bank's limit once the
-- bank has refused an older start.
ALTER TABLE "BankConnection" ADD COLUMN "historyLimitDays" INTEGER;
ALTER TABLE "ConnectedAccount" ADD COLUMN "historyFrom" TEXT;
