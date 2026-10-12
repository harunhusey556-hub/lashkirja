-- W24: keyset paging of Kuitit, Myynti and Ostolaskut (`?cursor=&limit=`). Each page reads the
-- user's rows in `[date, id]` order; with these the order comes straight from the index instead of
-- a temporary sort of every row of the user. Purely additive.
CREATE INDEX IF NOT EXISTS "Receipt_userId_date_id_idx" ON "Receipt"("userId", "date", "id");
CREATE INDEX IF NOT EXISTS "SalesInvoice_userId_issueDate_id_idx" ON "SalesInvoice"("userId", "issueDate", "id");
CREATE INDEX IF NOT EXISTS "PurchaseInvoice_userId_dueDate_id_idx" ON "PurchaseInvoice"("userId", "dueDate", "id");
