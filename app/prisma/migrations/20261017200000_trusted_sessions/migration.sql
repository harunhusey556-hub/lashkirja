-- Trusted-device sessions: device key, token generation, revoke reason. Purely additive;
-- existing rows stay unbound (deviceKey NULL) at generation 0 and keep working.
ALTER TABLE "AuthSession" ADD COLUMN "deviceKey" TEXT;
ALTER TABLE "AuthSession" ADD COLUMN "tokenGeneration" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AuthSession" ADD COLUMN "rotatedAt" DATETIME;
ALTER TABLE "AuthSession" ADD COLUMN "revokedReason" TEXT;
