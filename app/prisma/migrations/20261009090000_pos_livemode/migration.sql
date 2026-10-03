-- Korttimaksun tila Stripessä: livemode true vain oikealle maksulle.
-- A Stripe test payment must never reach the books. The value comes from the
-- PaymentIntent (re-checked from Stripe at finalize, webhook and refund), and a
-- payment is booked only when it is true AND the server key is a live key.
-- Existing rows start as false (treated as test) until Stripe is asked again.
ALTER TABLE "PosPayment" ADD COLUMN "livemode" BOOLEAN NOT NULL DEFAULT false;
