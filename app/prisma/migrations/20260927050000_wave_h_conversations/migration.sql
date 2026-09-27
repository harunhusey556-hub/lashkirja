-- Persisted conversations and one assistant reply per user message.
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'Uusi keskustelu',
    "archivedAt" DATETIME,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Conversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "Conversation_userId_updatedAt_idx" ON "Conversation"("userId", "updatedAt");

INSERT INTO "Conversation" ("id", "userId", "title", "createdAt", "updatedAt")
SELECT
    'legacy-' || "userId",
    "userId",
    'Aiempi keskustelu',
    MIN("createdAt"),
    MAX("createdAt")
FROM "ChatMessage"
GROUP BY "userId";

CREATE TABLE "ChatMessage_new" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "proposalData" TEXT,
    "clientId" TEXT,
    "replyToId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'complete',
    "replyOwner" TEXT,
    "ownerHeartbeat" DATETIME,
    "sources" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChatMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ChatMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ChatMessage_replyToId_fkey" FOREIGN KEY ("replyToId") REFERENCES "ChatMessage_new" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "ChatMessage_new" (
    "id",
    "userId",
    "conversationId",
    "role",
    "content",
    "proposalData",
    "clientId",
    "status",
    "createdAt"
)
SELECT
    m."id",
    m."userId",
    'legacy-' || m."userId",
    m."role",
    m."content",
    m."proposalData",
    m."clientId",
    'complete',
    m."createdAt"
FROM "ChatMessage" AS m;

DROP TABLE "ChatMessage";
ALTER TABLE "ChatMessage_new" RENAME TO "ChatMessage";

CREATE UNIQUE INDEX "ChatMessage_clientId_key" ON "ChatMessage"("clientId");
CREATE UNIQUE INDEX "ChatMessage_replyToId_key" ON "ChatMessage"("replyToId");
CREATE INDEX "ChatMessage_userId_createdAt_idx" ON "ChatMessage"("userId", "createdAt");
CREATE INDEX "ChatMessage_conversationId_createdAt_id_idx" ON "ChatMessage"("conversationId", "createdAt", "id");
