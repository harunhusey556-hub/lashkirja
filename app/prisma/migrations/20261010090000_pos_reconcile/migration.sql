-- Korttimaksujen täsmäytys (worker): when this card payment was last checked
-- with Stripe. The worker checks never-checked payments first (oldest first),
-- then the least recently checked, so an abandoned intent cannot use up an
-- owner's reads for the whole 7-day window.
ALTER TABLE "PosPayment" ADD COLUMN "reconciledAt" DATETIME;
CREATE INDEX "PosPayment_status_createdAt_idx" ON "PosPayment"("status", "createdAt");
