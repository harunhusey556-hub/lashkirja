-- Account close disables access without deleting the books.
ALTER TABLE "User" ADD COLUMN "accessDisabledAt" DATETIME;

-- Request workflow: status, optional export package, resolution time.
ALTER TABLE "AccountRequest" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE "AccountRequest" ADD COLUMN "packagePath" TEXT;
ALTER TABLE "AccountRequest" ADD COLUMN "resolvedAt" DATETIME;
ALTER TABLE "AccountRequest" ADD COLUMN "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "AccountRequest_status_idx" ON "AccountRequest"("status");
