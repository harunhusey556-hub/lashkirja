-- Client retry key so a repeated chat send does not insert a second user row.
ALTER TABLE "ChatMessage" ADD COLUMN "clientId" TEXT;
CREATE UNIQUE INDEX "ChatMessage_clientId_key" ON "ChatMessage"("clientId");
