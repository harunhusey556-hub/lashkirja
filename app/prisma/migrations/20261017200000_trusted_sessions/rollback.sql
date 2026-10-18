-- Manual rollback of migration.sql (sqlite >= 3.35). Not run by prisma migrate; after running it,
-- delete the row for 20261017200000_trusted_sessions from _prisma_migrations.
ALTER TABLE "AuthSession" DROP COLUMN "revokedReason";
ALTER TABLE "AuthSession" DROP COLUMN "rotatedAt";
ALTER TABLE "AuthSession" DROP COLUMN "tokenGeneration";
ALTER TABLE "AuthSession" DROP COLUMN "deviceKey";
