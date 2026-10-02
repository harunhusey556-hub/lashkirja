-- Sähköposti shows when the mailbox was last read, by the background run too.
ALTER TABLE "ImapAccount" ADD COLUMN "lastCheckedAt" DATETIME;
