-- ECB exchange-rate cache for foreign-currency documents. Purely additive.
CREATE TABLE "FxRate" (
    "currency" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "rate" REAL NOT NULL,
    "rateDate" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'ECB',
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("currency", "date")
);
