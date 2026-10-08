import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as postChatReceipt } from "@/app/api/ai/chat/receipt/route";
import { GET as listMessages, PATCH as decideChat } from "@/app/api/ai/chat/route";
import { prisma } from "@/lib/db";
import { ReceiptExtractionError, type ExtractedReceipt } from "@/lib/ai";
import { setChatReceiptExtractorForTests } from "@/lib/chat-receipt";
import { RECEIPT_UPLOADS_PER_WINDOW, resetRateLimitsForTests } from "@/lib/rate-limit";
import { createStatementWithTransactions, createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildFormRequest, buildRequest, readJson, sessionCookie } from "./helpers/http";

const READ: ExtractedReceipt = {
  vendor: "K-Market",
  date: "2026-09-20",
  totalAmount: 8.9,
  vatDetails: [{ rate: 13.5, amount: 1.06 }],
  category: "muut",
  notes: null,
  type: "meno",
  reference: null,
  invoiceNumber: null,
  source: "ocr",
  provenance: "local-ocr",
  confidence: 0.7,
};

let user: TestUser;
let cookie: string;
let extractions: number;
let extracted: ExtractedReceipt | Error;

function jpeg(extra = 0, name = "kuitti.jpg"): File {
  return new File([Uint8Array.from([0xff, 0xd8, 0xff, extra, 0xd9])], name, { type: "image/jpeg" });
}

async function send(
  file: File | null,
  fields: { conversationId?: string; clientId?: string } = {},
  options: { cookie?: string | null } = {}
) {
  const form = new FormData();
  if (file) form.set("file", file);
  if (fields.conversationId) form.set("conversationId", fields.conversationId);
  form.set("clientId", fields.clientId ?? crypto.randomUUID());
  const response = await postChatReceipt(
    buildFormRequest("/api/ai/chat/receipt", form, {
      cookie: options.cookie === null ? undefined : (options.cookie ?? cookie),
    })
  );
  return { response, body: await readJson(response) };
}

async function bankRow(owner: string, row: { date: string; amountCents: number; counterparty: string }) {
  const statement = await createStatementWithTransactions(owner, {
    periodMonth: row.date.slice(0, 7),
    transactions: [row],
  });
  return statement.transactions[0];
}

beforeEach(async () => {
  resetRateLimitsForTests();
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
  extractions = 0;
  extracted = READ;
  setChatReceiptExtractorForTests(async () => {
    extractions += 1;
    if (extracted instanceof Error) throw extracted;
    return extracted;
  });
});

afterEach(() => {
  setChatReceiptExtractorForTests(null);
});

describe("POST /api/ai/chat/receipt", () => {
  it("saves a pending receipt and proposes the bank row it fits", async () => {
    const tx = await bankRow(user.id, { date: "2026-09-20", amountCents: -890, counterparty: "K-Market" });

    const { response, body } = await send(jpeg(1));
    expect(response.status).toBe(200);
    expect(body.conversationId).toBeTruthy();
    expect(body.receiptId).toBeTruthy();

    const receipt = await prisma.receipt.findUnique({ where: { id: body.receiptId } });
    expect(receipt).toMatchObject({
      userId: user.id,
      reviewStatus: "pending",
      source: "ocr",
      vendor: "K-Market",
      totalAmountCents: 890,
      fileName: "kuitti.jpg",
    });
    expect(receipt?.uploadId).toBeTruthy();

    expect(body.userMessage).toMatchObject({ role: "user", content: "Kuitti: kuitti.jpg", proposal: null });
    expect(body.assistantMessage.role).toBe("assistant");
    expect(body.assistantMessage.content).toBe(
      "Luin kuitin: **K-Market**, 8,90 €, 20.9.2026, ALV 13,5 % 1,06 €. Tallensin sen kuitteihin tarkistettavaksi. " +
        `Se sopii pankkitapahtumaan ${body.assistantMessage.proposal.txSummary}. Hyväksy kohdistus alta.`
    );
    expect(body.assistantMessage.proposal).toMatchObject({
      type: "match_proposal",
      transactionId: tx.id,
      receiptId: body.receiptId,
      txSummary: "K-Market — -8.90 € (20.9.2026)",
      receiptSummary: "K-Market — 8.90 € (kuitti.jpg)",
    });
    expect(body.assistantMessage.proposal.confidenceScore).toBeGreaterThan(0.85);
    // The card says why, in Finnish, never with an internal code.
    expect(body.assistantMessage.proposal.reasons).toEqual(["summa sama", "nimi vastaa", "sama päivä"]);
    expect(body.assistantMessage.sources).toEqual(
      expect.arrayContaining([
        { label: "Avaa kuitti", href: `/kuitit/kuitti?id=${body.receiptId}` },
        expect.objectContaining({ href: `/pankki/tapahtumat?month=2026-09&rivi=${tx.id}` }),
      ])
    );

    // Stored like any chat turn: history shows it and the decision reads it.
    const history = await readJson(
      await listMessages(buildRequest("GET", `/api/ai/chat?conversationId=${body.conversationId}`, undefined, { cookie }))
    );
    expect(history.messages.map((m: { id: string }) => m.id)).toEqual([body.userMessage.id, body.assistantMessage.id]);
    expect(history.messages[1].proposal).toMatchObject({ transactionId: tx.id, receiptId: body.receiptId });
  });

  it("says no bank row was found when nothing fits", async () => {
    await bankRow(user.id, { date: "2026-03-02", amountCents: -45_000, counterparty: "Vuokranantaja Oy" });

    const { response, body } = await send(jpeg(2));
    expect(response.status).toBe(200);
    expect(body.assistantMessage.proposal).toBeNull();
    expect(body.assistantMessage.content).toBe(
      "Luin kuitin: **K-Market**, 8,90 €, 20.9.2026, ALV 13,5 % 1,06 €. Tallensin sen kuitteihin tarkistettavaksi. " +
        "En löytänyt sille vielä pankkitapahtumaa. Kohdistan sen, kun tapahtuma tulee pankista."
    );
    expect(body.assistantMessage.sources).toEqual([
      { label: "Avaa kuitti", href: `/kuitit/kuitti?id=${body.receiptId}` },
    ]);
  });

  it("keeps an unreadable file as a pending receipt and asks for the details", async () => {
    await bankRow(user.id, { date: "2026-09-20", amountCents: -890, counterparty: "K-Market" });
    extracted = new ReceiptExtractionError("NO_TEXT", "Kuitista ei saatu luettua tekstiä.");

    const { response, body } = await send(jpeg(3));
    expect(response.status).toBe(200);
    expect(body.assistantMessage.proposal).toBeNull();
    expect(body.assistantMessage.content).toBe(
      "En saanut kuitista selvää. Tallensin sen kuitteihin, täydennä tiedot käsin."
    );
    const receipt = await prisma.receipt.findUnique({ where: { id: body.receiptId } });
    expect(receipt).toMatchObject({ reviewStatus: "pending", totalAmountCents: null, source: "manual" });
  });

  it("reuses the stored receipt when the same file comes again", async () => {
    const tx = await bankRow(user.id, { date: "2026-09-20", amountCents: -890, counterparty: "K-Market" });
    const first = await send(jpeg(4));
    const second = await send(jpeg(4, "sama.jpg"));

    expect(second.response.status).toBe(200);
    expect(second.body.receiptId).toBe(first.body.receiptId);
    expect(await prisma.receipt.count({ where: { userId: user.id } })).toBe(1);
    expect(extractions).toBe(1);
    expect(second.body.assistantMessage.content).toContain("Tämä kuitti on jo tallennettu.");
    // Still unlinked, so the bank row is offered again.
    expect(second.body.assistantMessage.proposal).toMatchObject({ transactionId: tx.id, receiptId: first.body.receiptId });
  });

  it("answers a repeated clientId with the first answer and one receipt", async () => {
    await bankRow(user.id, { date: "2026-09-20", amountCents: -890, counterparty: "K-Market" });
    const clientId = crypto.randomUUID();
    const first = await send(jpeg(5), { clientId });
    const again = await send(jpeg(5), { clientId, conversationId: first.body.conversationId });

    expect(again.response.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(extractions).toBe(1);
    expect(await prisma.receipt.count({ where: { userId: user.id } })).toBe(1);
    expect(await prisma.chatMessage.count({ where: { userId: user.id } })).toBe(2);
  });

  it("continues the open conversation it is given", async () => {
    const conversation = await prisma.conversation.create({ data: { userId: user.id, title: "Kuitit" } });
    const { response, body } = await send(jpeg(6), { conversationId: conversation.id });
    expect(response.status).toBe(200);
    expect(body.conversationId).toBe(conversation.id);
    expect(body.userMessage.conversationId).toBe(conversation.id);
  });

  it("never proposes another owner's bank row", async () => {
    const other = await createUser();
    await bankRow(other.id, { date: "2026-09-20", amountCents: -890, counterparty: "K-Market" });

    const { response, body } = await send(jpeg(7));
    expect(response.status).toBe(200);
    expect(body.assistantMessage.proposal).toBeNull();
  });

  it("refuses a missing file, a wrong file type and a signed-out caller", async () => {
    const missing = await send(null);
    expect(missing.response.status).toBe(400);
    expect(typeof missing.body.error).toBe("string");

    const text = new File([Buffer.from("ei kuva")], "kuitti.jpg", { type: "image/jpeg" });
    const invalid = await send(text);
    expect(invalid.response.status).toBe(400);
    expect(typeof invalid.body.error).toBe("string");

    const signedOut = await send(jpeg(8), {}, { cookie: null });
    expect(signedOut.response.status).toBe(401);

    expect(extractions).toBe(0);
    expect(await prisma.receipt.count()).toBe(0);
    expect(await prisma.chatMessage.count()).toBe(0);
  });

  it("rate limits the paid extraction", async () => {
    let status = 200;
    for (let index = 0; index <= RECEIPT_UPLOADS_PER_WINDOW && status !== 429; index += 1) {
      status = (await send(null)).response.status;
    }
    expect(status).toBe(429);
  });
});

describe("POST /api/ai/chat/receipt never proposes a weak match", () => {
  it("vendor and date alone, without the amount, give no proposal", async () => {
    await bankRow(user.id, { date: "2026-09-20", amountCents: -1_290, counterparty: "K-Market" });
    const { body } = await send(jpeg(20));
    expect(body.assistantMessage.proposal).toBeNull();
  });

  it("two equally fitting bank rows give no proposal", async () => {
    await bankRow(user.id, { date: "2026-09-20", amountCents: -890, counterparty: "K-Market" });
    await bankRow(user.id, { date: "2026-09-21", amountCents: -890, counterparty: "K-Market" });
    const { body } = await send(jpeg(21));
    expect(body.assistantMessage.proposal).toBeNull();
  });
});

describe("PATCH /api/ai/chat accepting a receipt proposal", () => {
  it("approves the pending receipt and links it to the bank row", async () => {
    const tx = await bankRow(user.id, { date: "2026-09-20", amountCents: -890, counterparty: "K-Market" });
    const { body } = await send(jpeg(10));
    expect(body.assistantMessage.proposal).toBeTruthy();

    const response = await decideChat(
      buildRequest("PATCH", "/api/ai/chat", { id: body.assistantMessage.id, decision: "accepted" }, { cookie })
    );
    expect(response.status).toBe(200);
    const updated = await readJson(response);
    expect(updated.proposal.status).toBe("accepted");
    expect((await prisma.transaction.findUnique({ where: { id: tx.id } }))?.receiptId).toBe(body.receiptId);
    expect((await prisma.receipt.findUnique({ where: { id: body.receiptId } }))?.reviewStatus).toBe("approved");
  });

  it("refuses an incomplete pending receipt with 422 and links nothing", async () => {
    const tx = await bankRow(user.id, { date: "2026-09-20", amountCents: -890, counterparty: "K-Market" });
    // Read without an amount: only its viite ties it to the row.
    extracted = { ...READ, totalAmount: null, vatDetails: [], reference: "1232" };
    await prisma.transaction.update({ where: { id: tx.id }, data: { reference: "1232" } });
    const { body } = await send(jpeg(11));
    expect(body.assistantMessage.proposal).toMatchObject({ transactionId: tx.id });

    const response = await decideChat(
      buildRequest("PATCH", "/api/ai/chat", { id: body.assistantMessage.id, decision: "accepted" }, { cookie })
    );
    expect(response.status).toBe(422);
    expect(await readJson(response)).toEqual({ error: "Täydennä kuitin tiedot ennen kohdistusta." });
    expect((await prisma.transaction.findUnique({ where: { id: tx.id } }))?.receiptId).toBeNull();
    expect((await prisma.receipt.findUnique({ where: { id: body.receiptId } }))?.reviewStatus).toBe("pending");
    const message = await prisma.chatMessage.findUnique({ where: { id: body.assistantMessage.id } });
    expect(JSON.parse(message!.proposalData!).status).toBeUndefined();
  });

  it("gives the period-lock error for a closed month and links nothing", async () => {
    const tx = await bankRow(user.id, { date: "2026-09-20", amountCents: -890, counterparty: "K-Market" });
    const { body } = await send(jpeg(12));
    await prisma.user.update({ where: { id: user.id }, data: { booksLockedThrough: "2026-09" } });

    const response = await decideChat(
      buildRequest("PATCH", "/api/ai/chat", { id: body.assistantMessage.id, decision: "accepted" }, { cookie })
    );
    expect(response.status).toBe(409);
    expect((await readJson(response)).error).toMatch(/suljettu/);
    expect((await prisma.transaction.findUnique({ where: { id: tx.id } }))?.receiptId).toBeNull();
  });
});
