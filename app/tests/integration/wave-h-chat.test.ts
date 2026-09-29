import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { resetRateLimitsForTests } from "@/lib/rate-limit";
import { claimAssistantReply, listConversationMessages, priorContextTurns, runAssistantTurn } from "@/lib/chat-store";
import { decideChatProposal } from "@/lib/chat-decision";
import { copilotRequestMessages } from "@/lib/chat-turn";
import { prepareChat } from "@/lib/ai-assistant";
import { computeAlvReport } from "@/lib/alv";
import { loadAlvPeriodSources } from "@/lib/alv-period";
import { replyClaimsUnperformedAction, replyUsesCalculatedAmount, explainsLimitedMode } from "@/lib/chat-honesty";
import { GET as listMessages, POST as postChat, PATCH as decideChat } from "@/app/api/ai/chat/route";
import {
  GET as listConversations,
  PATCH as patchConversation,
  POST as createConversation,
} from "@/app/api/ai/conversations/route";
import { createReceipt, createStatementWithTransactions, createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, sessionCookie } from "./helpers/http";

let user: TestUser;
let cookie: string;

beforeEach(async () => {
  delete process.env.COPILOT_GITHUB_TOKEN;
  resetRateLimitsForTests();
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

async function postMessage(message: string, extra: Record<string, unknown> = {}) {
  const response = await postChat(
    buildRequest("POST", "/api/ai/chat", { message, clientId: crypto.randomUUID(), ...extra }, { cookie })
  );
  const body = await readJson(response);
  return { response, body };
}

describe("conversations", () => {
  it("creates a persisted conversation and keeps its id across turns", async () => {
    const created = await createConversation(buildRequest("POST", "/api/ai/conversations", {}, { cookie }));
    const conversation = await readJson<{ id: string; title: string }>(created);
    expect(created.status).toBe(200);
    expect(conversation.id).toMatch(/\S+/);
    expect(conversation.title).toBe("Uusi keskustelu");

    const first = await postMessage("Hei", { conversationId: conversation.id, clientId: "client-hei-1" });
    expect(first.response.status).toBe(200);
    expect(first.body.conversationId).toBe(conversation.id);
    expect(first.body.replyToId).toBeTruthy();

    const again = await postMessage("Hei", { conversationId: conversation.id, clientId: "client-hei-1" });
    expect(again.body.id).toBe(first.body.id);
    const assistants = await prisma.chatMessage.count({
      where: { conversationId: conversation.id, role: "assistant" },
    });
    expect(assistants).toBe(1);

    const stored = await prisma.conversation.findUnique({ where: { id: conversation.id } });
    expect(stored?.title).toBe("Hei");
  });

  it("renames, searches, archives, and deletes with undo", async () => {
    const created = await readJson<{ id: string }>(
      await createConversation(buildRequest("POST", "/api/ai/conversations", {}, { cookie }))
    );
    await postMessage("ALV-kysymys toukokuulta", { conversationId: created.id });

    const renamed = await patchConversation(
      buildRequest("PATCH", "/api/ai/conversations", { id: created.id, title: "Toukokuun ALV" }, { cookie })
    );
    expect((await readJson<{ title: string }>(renamed)).title).toBe("Toukokuun ALV");

    const found = await readJson<{ conversations: Array<{ id: string }> }>(
      await listConversations(buildRequest("GET", "/api/ai/conversations?q=Toukokuun", undefined, { cookie }))
    );
    expect(found.conversations.map((row) => row.id)).toContain(created.id);

    await patchConversation(
      buildRequest("PATCH", "/api/ai/conversations", { id: created.id, archived: true }, { cookie })
    );
    const active = await readJson<{ conversations: Array<{ id: string }> }>(
      await listConversations(buildRequest("GET", "/api/ai/conversations", undefined, { cookie }))
    );
    expect(active.conversations.map((row) => row.id)).not.toContain(created.id);
    const archived = await readJson<{ conversations: Array<{ id: string }> }>(
      await listConversations(buildRequest("GET", "/api/ai/conversations?archived=1", undefined, { cookie }))
    );
    expect(archived.conversations.map((row) => row.id)).toContain(created.id);

    await patchConversation(
      buildRequest("PATCH", "/api/ai/conversations", { id: created.id, deleted: true }, { cookie })
    );
    const gone = await readJson<{ conversations: Array<{ id: string }> }>(
      await listConversations(buildRequest("GET", "/api/ai/conversations?archived=1", undefined, { cookie }))
    );
    expect(gone.conversations.map((row) => row.id)).not.toContain(created.id);

    await patchConversation(
      buildRequest("PATCH", "/api/ai/conversations", { id: created.id, deleted: false, archived: false }, { cookie })
    );
    const restored = await readJson<{ conversations: Array<{ id: string }> }>(
      await listConversations(buildRequest("GET", "/api/ai/conversations", undefined, { cookie }))
    );
    expect(restored.conversations.map((row) => row.id)).toContain(created.id);
  });
});

describe("chat history and context", () => {
  it("pages by createdAt and id without skipping a same-timestamp row", async () => {
    const conversation = await prisma.conversation.create({
      data: { userId: user.id, title: "Historia" },
    });
    const createdAt = new Date("2026-09-01T12:00:00.000Z");
    for (const id of ["m-c", "m-a", "m-b"]) {
      await prisma.chatMessage.create({
        data: {
          id,
          userId: user.id,
          conversationId: conversation.id,
          role: "user",
          content: id,
          status: "complete",
          createdAt,
        },
      });
    }
    const first = await listConversationMessages({
      userId: user.id,
      conversationId: conversation.id,
      take: 2,
    });
    expect(first.rows.map((row) => row.id)).toEqual(["m-c", "m-b"]);
    expect(first.hasMore).toBe(true);
    const oldest = first.rows[first.rows.length - 1];
    const second = await listConversationMessages({
      userId: user.id,
      conversationId: conversation.id,
      take: 2,
      before: { createdAt: oldest.createdAt, id: oldest.id },
    });
    expect(second.rows.map((row) => row.id)).toEqual(["m-a"]);

    const missingId = await listMessages(
      buildRequest(
        "GET",
        `/api/ai/chat?conversationId=${conversation.id}&before=${encodeURIComponent(createdAt.toISOString())}`,
        undefined,
        { cookie }
      )
    );
    expect(missingId.status).toBe(400);
  });

  it("gives the provider the earlier turns, not only the latest question", async () => {
    const conversation = await prisma.conversation.create({
      data: { userId: user.id, title: "Konteksti" },
    });
    const first = await prisma.chatMessage.create({
      data: {
        userId: user.id,
        conversationId: conversation.id,
        role: "user",
        content: "Kyse on ripsien tarvikkeista",
        status: "complete",
        createdAt: new Date("2026-09-01T10:00:00.000Z"),
      },
    });
    await prisma.chatMessage.create({
      data: {
        userId: user.id,
        conversationId: conversation.id,
        role: "assistant",
        content: "Selvä, tarvikkeet.",
        status: "complete",
        replyToId: first.id,
        createdAt: new Date("2026-09-01T10:00:01.000Z"),
      },
    });
    const latest = await prisma.chatMessage.create({
      data: {
        userId: user.id,
        conversationId: conversation.id,
        role: "user",
        content: "Mitä voin vähentää?",
        status: "complete",
        createdAt: new Date("2026-09-01T10:00:02.000Z"),
      },
    });
    const prior = await priorContextTurns(user.id, conversation.id, {
      createdAt: latest.createdAt,
      id: latest.id,
    });
    expect(prior.map((turn) => turn.content)).toEqual(["Kyse on ripsien tarvikkeista", "Selvä, tarvikkeet."]);
    const messages = copilotRequestMessages("system", latest.content, prior);
    expect(messages.map((turn) => turn.content)).toContain("Kyse on ripsien tarvikkeista");
    expect(messages.at(-1)?.content).toBe("Mitä voin vähentää?");
  });
});

describe("reply ownership", () => {
  it("lets only one retry own the assistant row for a user message", async () => {
    const conversation = await prisma.conversation.create({ data: { userId: user.id, title: "Retry" } });
    const userMessage = await prisma.chatMessage.create({
      data: {
        userId: user.id,
        conversationId: conversation.id,
        role: "user",
        content: "Hei",
        status: "complete",
      },
    });
    const [first, second] = await Promise.all([
      claimAssistantReply({
        userId: user.id,
        conversationId: conversation.id,
        userMessageId: userMessage.id,
        owner: "owner-a",
      }),
      claimAssistantReply({
        userId: user.id,
        conversationId: conversation.id,
        userMessageId: userMessage.id,
        owner: "owner-b",
      }),
    ]);
    const kinds = [first.kind, second.kind].sort();
    expect(kinds).toEqual(["busy", "owned"]);
    expect(await prisma.chatMessage.count({ where: { replyToId: userMessage.id } })).toBe(1);

    const owned = first.kind === "owned" ? first : second;
    const signal = new AbortController();
    signal.abort("stop");
    await runAssistantTurn({
      userId: user.id,
      conversationId: conversation.id,
      userMessageId: userMessage.id,
      owner: owned.kind === "owned" ? (first.kind === "owned" ? "owner-a" : "owner-b") : "owner-a",
      signal: signal.signal,
      stream: async function* () {
        yield "ei";
      },
    });
    const afterStop = await prisma.chatMessage.findFirst({ where: { replyToId: userMessage.id } });
    expect(afterStop?.status).toBe("cancelled");

    const retry = await claimAssistantReply({
      userId: user.id,
      conversationId: conversation.id,
      userMessageId: userMessage.id,
      owner: "owner-c",
    });
    expect(retry.kind).toBe("owned");
    expect(retry.kind === "owned" ? retry.messageId : "").toBe(afterStop?.id);
    expect(await prisma.chatMessage.count({ where: { role: "assistant", conversationId: conversation.id } })).toBe(1);
  });

  it("records disconnect, timeout, and backgrounding as an explicit status", async () => {
    const conversation = await prisma.conversation.create({ data: { userId: user.id, title: "Keskeytys" } });
    async function userMessage(content: string) {
      return prisma.chatMessage.create({
        data: {
          userId: user.id,
          conversationId: conversation.id,
          role: "user",
          content,
          status: "complete",
        },
      });
    }

    const disconnect = await userMessage("disconnect");
    const disconnectSignal = new AbortController();
    const disconnectResult = await runAssistantTurn({
      userId: user.id,
      conversationId: conversation.id,
      userMessageId: disconnect.id,
      owner: "disconnect",
      signal: disconnectSignal.signal,
      stream: async function* () {
        yield "puoli vastausta";
        disconnectSignal.abort("disconnect");
        yield " lisää";
      },
    });
    expect(disconnectResult.status).toBe("incomplete");
    expect(disconnectResult.content).toContain("puoli");

    const timed = await userMessage("timeout");
    const timeoutResult = await runAssistantTurn({
      userId: user.id,
      conversationId: conversation.id,
      userMessageId: timed.id,
      owner: "timeout",
      signal: new AbortController().signal,
      timeoutMs: 20,
      stream: async function* (signal: AbortSignal) {
        await new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    });
    expect(timeoutResult.status).toBe("failed");

    const background = await userMessage("background");
    const backgroundSignal = new AbortController();
    backgroundSignal.abort("background");
    const backgroundResult = await runAssistantTurn({
      userId: user.id,
      conversationId: conversation.id,
      userMessageId: background.id,
      owner: "background",
      signal: backgroundSignal.signal,
      stream: async function* () {
        yield "piiloon";
      },
    });
    expect(backgroundResult.status).toBe("cancelled");
  });
});

describe("chat limits and decisions", () => {
  it("rejects an oversized message and rate-limits further posts", async () => {
    const huge = await postMessage("a".repeat(4001));
    expect(huge.response.status).toBe(400);

    let lastStatus = 200;
    for (let index = 0; index < 21; index += 1) {
      const sent = await postMessage(`Hei ${index}`, { clientId: `rate-limit-key-${index}` });
      lastStatus = sent.response.status;
      if (lastStatus === 429) break;
    }
    expect(lastStatus).toBe(429);
  });

  it("accepts a match and the chat decision together, and rolls both back together", async () => {
    const statement = await createStatementWithTransactions(user.id, {
      periodMonth: "2026-09",
      transactions: [{ date: "2026-09-02", amountCents: -2500, counterparty: "Tukku Oy" }],
    });
    const receipt = await createReceipt(user.id, {
      date: "2026-09-02",
      totalAmountCents: 2500,
      vendor: "Tukku Oy",
      type: "meno",
    });
    const transaction = statement.transactions[0];
    const conversation = await prisma.conversation.create({ data: { userId: user.id, title: "Täsmäytys" } });
    const assistant = await prisma.chatMessage.create({
      data: {
        userId: user.id,
        conversationId: conversation.id,
        role: "assistant",
        content: "Ehdotus",
        status: "complete",
        proposalData: JSON.stringify({
          type: "match_proposal",
          transactionId: transaction.id,
          receiptId: receipt.id,
          txSummary: "Tukku",
          receiptSummary: "kuitti",
          confidenceScore: 0.9,
          reasons: ["amount"],
        }),
      },
    });

    await expect(
      decideChatProposal(
        { userId: user.id, messageId: assistant.id, decision: "accepted" },
        { beforeChatWrite: () => { throw new Error("chat failed"); } }
      )
    ).rejects.toThrow(/chat failed/);
    expect((await prisma.transaction.findUnique({ where: { id: transaction.id } }))?.receiptId).toBeNull();
    expect(JSON.parse((await prisma.chatMessage.findUnique({ where: { id: assistant.id } }))!.proposalData!).status).toBeUndefined();

    const response = await decideChat(
      buildRequest("PATCH", "/api/ai/chat", { id: assistant.id, decision: "accepted" }, { cookie })
    );
    expect(response.status).toBe(200);
    expect((await prisma.transaction.findUnique({ where: { id: transaction.id } }))?.receiptId).toBe(receipt.id);
    const saved = await prisma.chatMessage.findUnique({ where: { id: assistant.id } });
    expect(JSON.parse(saved!.proposalData!).status).toBe("accepted");
  });

  it("stores a chat rejection so the same pair is not suggested again", async () => {
    const statement = await createStatementWithTransactions(user.id, {
      periodMonth: "2026-09",
      transactions: [{ date: "2026-09-03", amountCents: -1800, counterparty: "Liima Oy" }],
    });
    const receipt = await createReceipt(user.id, {
      date: "2026-09-03",
      totalAmountCents: 1800,
      vendor: "Liima Oy",
      type: "meno",
    });
    const transaction = statement.transactions[0];
    const before = await prepareChat(user.id, "Täsmäytä kuitit");
    expect(before.kind).toBe("local");
    if (before.kind === "local") expect(before.proposal?.receiptId).toBe(receipt.id);

    const conversation = await prisma.conversation.create({ data: { userId: user.id, title: "Hylkäys" } });
    const assistant = await prisma.chatMessage.create({
      data: {
        userId: user.id,
        conversationId: conversation.id,
        role: "assistant",
        content: "Ehdotus",
        status: "complete",
        proposalData: JSON.stringify({
          type: "match_proposal",
          transactionId: transaction.id,
          receiptId: receipt.id,
          txSummary: "Liima",
          receiptSummary: "kuitti",
          confidenceScore: 0.9,
          reasons: ["amount"],
        }),
      },
    });
    const response = await decideChat(
      buildRequest("PATCH", "/api/ai/chat", { id: assistant.id, decision: "rejected" }, { cookie })
    );
    expect(response.status).toBe(200);
    const rejection = await prisma.matchRejection.findUnique({
      where: { transactionId_receiptId: { transactionId: transaction.id, receiptId: receipt.id } },
    });
    expect(rejection).toBeTruthy();
    const after = await prepareChat(user.id, "Täsmäytä kuitit");
    if (after.kind === "local") expect(after.proposal?.receiptId).not.toBe(receipt.id);
  });
});

describe("honest book answers", () => {
  it("answers the VAT question from the books, with no limited-mode label", async () => {
    const now = new Date();
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    await createReceipt(user.id, {
      type: "tulo",
      date: `${month}-10`,
      totalAmountCents: 12_550,
      vatDetails: JSON.stringify([{ rate: 25.5, amount: 25.5 }]),
      vendor: "Asiakas",
    });
    const sent = await postMessage("Mikä on tämän kuun ALV?");
    expect(sent.response.status).toBe(200);
    // A calculated answer is a real answer: no "Rajattu tila" preamble (OWN-09).
    expect(sent.body.content).not.toMatch(/Rajattu tila|Rajoitettu tila|kielimalli/);
    expect(sent.body.limited).toBe(false);
    expect(replyClaimsUnperformedAction(sent.body.content)).toBe(false);
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const sources = await loadAlvPeriodSources(user.id, start, end);
    const report = computeAlvReport(sources.receipts, sources.invoices);
    expect(replyUsesCalculatedAmount(sent.body.content, report.field308.amount.toFixed(2))).toBe(true);
    expect(sent.body.sources).toEqual(
      expect.arrayContaining([{ label: "ALV-raportti", href: expect.stringContaining("/kirjanpito/alv?period=") }])
    );
  });
});
