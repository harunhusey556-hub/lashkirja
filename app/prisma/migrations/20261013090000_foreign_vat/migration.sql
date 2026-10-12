-- Ulkomaiset ostot: alkuperäinen valuutta ja ALV-käsittely (käännetty
-- verovelvollisuus). Purely additive: existing rows keep EUR / domestic.
ALTER TABLE "Receipt" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'EUR';
ALTER TABLE "Receipt" ADD COLUMN "originalAmountCents" INTEGER;
ALTER TABLE "Receipt" ADD COLUMN "vatTreatment" TEXT NOT NULL DEFAULT 'domestic';
ALTER TABLE "PurchaseInvoice" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'EUR';
ALTER TABLE "PurchaseInvoice" ADD COLUMN "originalAmountCents" INTEGER;
ALTER TABLE "PurchaseInvoice" ADD COLUMN "vatTreatment" TEXT NOT NULL DEFAULT 'domestic';
