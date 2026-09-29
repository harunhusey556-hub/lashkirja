import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { LEGACY_LIMITED_NOTICE_EN, LEGACY_LIMITED_NOTICE_FI } from "@/lib/chat-legacy";
import { limitedModeNotice } from "@/lib/chat-policy";
import { priorContextTurns } from "@/lib/chat-store";
import { GET as listMessages } from "@/app/api/ai/chat/route";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, sessionCookie } from "./helpers/http";

const FORBIDDEN = /Rajattu|Rajoitettu|Limited mode|kielimalli/i;
const VAT_TAIL = "Ripsipalveluiden yleinen ALV-kanta 2026 on **25,5 %**. Katso /kirjanpito/alv.";

let user: TestUser;
let cookie: string;

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

/** A conversation as production stored it before OWN-09. */
async function seedLegacyConversation() {
  const conversation = await prisma.conversation.create({ data: { userId: user.id, title: "ALV" } });
  const at = (seconds: number) => new Date(Date.UTC(2026, 8, 1, 9, 0, seconds));
  const question = await prisma.chatMessage.create({
    data: { userId: user.id, conversationId: conversation.id, role: "user", content: "Mikä on ALV?", createdAt: at(0) },
  });
  const reply = await prisma.chatMessage.create({
    data: {
      userId: user.id,
      conversationId: conversation.id,
      role: "assistant",
      content: `${LEGACY_LIMITED_NOTICE_FI}\n\n${VAT_TAIL}`,
      proposalData: JSON.stringify({ limited: true }),
      replyToId: question.id,
      createdAt: at(1),
    },
  });
  const noticeOnly = await prisma.chatMessage.create({
    data: {
      userId: user.id,
      conversationId: conversation.id,
      role: "assistant",
      content: LEGACY_LIMITED_NOTICE_EN,
      proposalData: JSON.stringify({ limited: true }),
      createdAt: at(2),
    },
  });
  return { conversation, reply, noticeOnly };
}

describe("legacy Rajattu tila notice in stored chat history", () => {
  it("never reaches the drawer through GET /api/ai/chat, even on an unmigrated row", async () => {
    const { conversation, reply, noticeOnly } = await seedLegacyConversation();
    const response = await listMessages(
      buildRequest("GET", `/api/ai/chat?conversationId=${conversation.id}`, undefined, { cookie })
    );
    expect(response.status).toBe(200);
    const body = await readJson<{ messages: Array<{ id: string; content: string }> }>(response);
    const byId = new Map(body.messages.map((message) => [message.id, message.content]));
    expect(byId.get(reply.id)).toBe(VAT_TAIL);
    expect(byId.get(noticeOnly.id)).toBe(limitedModeNotice(true));
    for (const message of body.messages) expect(message.content).not.toMatch(FORBIDDEN);
  });

  it("is not fed back to the model as prior context", async () => {
    const { conversation } = await seedLegacyConversation();
    const turns = await priorContextTurns(user.id, conversation.id, {
      createdAt: new Date(Date.UTC(2026, 8, 1, 10)),
      id: "zzzz",
    });
    expect(turns.length).toBe(3);
    for (const turn of turns) expect(turn.content).not.toMatch(FORBIDDEN);
  });

  it("the data migration rewrites the stored rows on the real schema and is idempotent", async () => {
    const { reply, noticeOnly } = await seedLegacyConversation();
    const sql = readFileSync(
      path.join(process.cwd(), "prisma", "migrations", "20260929120000_strip_legacy_chat_notice", "migration.sql"),
      "utf8"
    );
    const statements = sql
      .split(/;\s*(?:\r?\n|$)/)
      .map((part) => part.replace(/^\s*--.*$/gm, "").trim())
      .filter(Boolean);
    expect(statements.length).toBe(2);
    for (let run = 0; run < 2; run += 1) {
      for (const statement of statements) await prisma.$executeRawUnsafe(statement);
      const stored = await prisma.chatMessage.findMany({ where: { id: { in: [reply.id, noticeOnly.id] } } });
      const byId = new Map(stored.map((row) => [row.id, row.content]));
      expect(byId.get(reply.id)).toBe(VAT_TAIL);
      expect(byId.get(noticeOnly.id)).toBe(limitedModeNotice(true));
    }
    const leftovers = await prisma.chatMessage.count({
      where: { role: "assistant", OR: [{ content: { startsWith: "Rajattu tila" } }, { content: { startsWith: "Limited mode" } }] },
    });
    expect(leftovers).toBe(0);
  });
});
