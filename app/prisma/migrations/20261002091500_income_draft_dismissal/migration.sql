-- The owner deleted the sale draft made from a bank row: the row does not get another one.
CREATE TABLE "IncomeDraftDismissal" (
    "transactionId" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IncomeDraftDismissal_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
