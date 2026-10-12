-- Ostolaskun hyvityslasku (toimittajan hyvitys). A credit note is a PurchaseInvoice
-- row with a negative total; this links it to the invoice it corrects.
-- Purely additive: existing rows keep a NULL link.
ALTER TABLE "PurchaseInvoice" ADD COLUMN "creditsInvoiceId" TEXT REFERENCES "PurchaseInvoice" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "PurchaseInvoice_creditsInvoiceId_idx" ON "PurchaseInvoice"("creditsInvoiceId");
