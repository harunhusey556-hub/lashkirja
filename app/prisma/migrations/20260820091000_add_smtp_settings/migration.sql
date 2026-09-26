-- AlterTable: outgoing mail settings alongside the existing IMAP credentials.
ALTER TABLE "ImapAccount" ADD COLUMN "smtpHost" TEXT;
ALTER TABLE "ImapAccount" ADD COLUMN "smtpPort" INTEGER;
