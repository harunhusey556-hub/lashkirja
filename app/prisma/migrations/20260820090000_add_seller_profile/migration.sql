-- AlterTable: seller details printed on sales invoices.
ALTER TABLE "User" ADD COLUMN "businessName" TEXT;
ALTER TABLE "User" ADD COLUMN "businessId" TEXT;
ALTER TABLE "User" ADD COLUMN "addressStreet" TEXT;
ALTER TABLE "User" ADD COLUMN "addressPostalCode" TEXT;
ALTER TABLE "User" ADD COLUMN "addressCity" TEXT;
ALTER TABLE "User" ADD COLUMN "phone" TEXT;
ALTER TABLE "User" ADD COLUMN "invoiceIban" TEXT;
ALTER TABLE "User" ADD COLUMN "invoiceBic" TEXT;
ALTER TABLE "User" ADD COLUMN "invoiceTerms" TEXT;
