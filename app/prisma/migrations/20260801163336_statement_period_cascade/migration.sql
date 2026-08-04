-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Statement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "periodMonth" TEXT,
    "periodSource" TEXT NOT NULL DEFAULT 'auto',
    "uploadedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Statement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Statement" ("fileName", "filePath", "fileType", "id", "uploadedAt", "userId") SELECT "fileName", "filePath", "fileType", "id", "uploadedAt", "userId" FROM "Statement";
DROP TABLE "Statement";
ALTER TABLE "new_Statement" RENAME TO "Statement";
CREATE TABLE "new_Transaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "statementId" TEXT NOT NULL,
    "date" DATETIME,
    "counterparty" TEXT,
    "amount" REAL NOT NULL,
    "reference" TEXT,
    "message" TEXT,
    "type" TEXT NOT NULL DEFAULT 'meno',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Transaction_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "Statement" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Transaction" ("amount", "counterparty", "createdAt", "date", "id", "message", "reference", "statementId", "type") SELECT "amount", "counterparty", "createdAt", "date", "id", "message", "reference", "statementId", "type" FROM "Transaction";
DROP TABLE "Transaction";
ALTER TABLE "new_Transaction" RENAME TO "Transaction";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
