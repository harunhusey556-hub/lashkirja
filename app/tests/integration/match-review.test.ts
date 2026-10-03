import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@/lib/db";
import { resetCopilotPauseForTests } from "@/lib/copilot";
import { createChatToolSession } from "@/lib/chat-tools";
import { buildInlineCandidates, matchExplanation, runMatching } from "@/lib/matching";
import { processAiChatMessage } from "@/lib/ai-assistant";
import { REVIEW_EVENT_KIND } from "@/lib/match-review";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";

const NOW = new Date("2026-10-03T09:00:00.000Z");

let owner: TestUser;

type Verdict = (candidates: Array<{ id: string }>) => { match: string | null; confidence: number; reasons: string[] };

/** An OpenAI-compatible endpoint that answers every review with `verdict`; request bodies are kept. */
function installReviewer(verdict: Verdict) {
  const bodies: Array<Record<string, unknown> & { messages: Array<{ role: string; content: string }> }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (!String(url).startsWith("https://llm.test/")) throw new Error(`unexpected fetch ${url}`);
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      const data = JSON.parse(body.messages[1].content) as { candidates: Array<{ id: string }> };
      return new Response(
        JSON.stringify({ model: body.model, choices: [{ message: { role: "assistant", content: JSON.stringify(verdict(data.candidates)) } }] }),
        { headers: { "content-type": "application/json" } }
      );
    })
  );
  return bodies;
}

async function statement(rows: Array<{ date: string; amountCents: number; counterparty: string; reference?: string; message?: string }>) {
  const created = await prisma.statement.create({
    data: {
      userId: owner.id,
      fileName: `tiliote-${randomUUID()}.csv`,
      fileType: "csv",
      filePath: `/tmp/${randomUUID()}.csv`,
      checksum: randomUUID(),
      periodMonth: "2026-09",
      transactions: {
        create: rows.map((row) => ({
          date: new Date(`${row.date}T00:00:00.000Z`),
          amountCents: row.amountCents,
          counterparty: row.counterparty,
          reference: row.reference ?? null,
          message: row.message ?? null,
          type: row.amountCents >= 0 ? "tulo" : "meno",
        })),
      },
    },
    include: { transactions: { orderBy: { date: "asc" } } },
  });
  return created.transactions;
}

async function receipt(data: { vendor: string; date: string; cents: number; reference?: string; reviewStatus?: string }) {
  return prisma.receipt.create({
    data: {
      userId: owner.id,
      type: "meno",
      vendor: data.vendor,
      date: new Date(`${data.date}T00:00:00.000Z`),
      totalAmountCents: data.cents,
      reference: data.reference ?? null,
      reviewStatus: data.reviewStatus ?? "approved",
      category: "muut",
      filePath: `/tmp/${randomUUID()}.pdf`,
      fileName: `${data.vendor}.pdf`,
    },
  });
}

/** Rows: phone bill (amount + name, uncertain), rent (viite + amount, certain), two look-alike kuitit, an amount-only coincidence. */
async function fixtures() {
  const phone = await receipt({ vendor: "Puhelinfirma Oy", date: "2026-09-10", cents: 4_990 });
  // Pending, so the certain pair stays a suggestion instead of linking itself.
  const rent = await receipt({ vendor: "Vuokranantaja Ky", date: "2026-09-01", cents: 120_000, reference: "1232", reviewStatus: "pending" });
  const coffeeA = await receipt({ vendor: "Kahvila Lumo", date: "2026-09-19", cents: 890 });
  const coffeeB = await receipt({ vendor: "Kahvila Lumo", date: "2026-09-20", cents: 890 });
  const fuel = await receipt({ vendor: "Neste", date: "2026-09-05", cents: 1_500 });
  const rows = await statement([
    { date: "2026-09-04", amountCents: -120_000, counterparty: "VUOKRA", reference: "1232" },
    { date: "2026-09-05", amountCents: -1_500, counterparty: "SHELL HELSINKI" },
    { date: "2026-09-12", amountCents: -4_990, counterparty: "PUHELINFIRMA OY" },
    { date: "2026-09-21", amountCents: -890, counterparty: "KAHVILA LUMO" },
  ]);
  const [rentRow, fuelRow, phoneRow, coffeeRow] = rows;
  return { phone, rent, coffeeA, coffeeB, fuel, rentRow, fuelRow, phoneRow, coffeeRow };
}

async function review(month?: string) {
  const session = createChatToolSession(owner.id, NOW);
  const result = JSON.parse(await session.run("review_matches", JSON.stringify(month ? { month } : {})));
  return { result, session };
}

beforeEach(async () => {
  resetCopilotPauseForTests();
  await resetDatabase();
  vi.stubEnv("COPILOT_GITHUB_TOKEN", "");
  vi.stubEnv("LLM_API_KEY", "test-key");
  vi.stubEnv("LLM_BASE_URL", "https://llm.test/v1");
  vi.stubEnv("LLM_CHAT_MODEL", "gemini-2.5-flash");
  vi.stubEnv("MATCH_AI_REVIEW", "");
  vi.stubEnv("LLM_REASONING_EFFORT", "");
  owner = await createUser({ firstName: "Omistaja" });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the gate in the stored suggestions", () => {
  it("never suggests an amount-only pair or one of two look-alikes; suggests the clear ones", async () => {
    vi.stubEnv("LLM_API_KEY", "");
    const f = await fixtures();
    await runMatching(owner.id);
    const rows = await prisma.transaction.findMany({ where: { statement: { userId: owner.id } } });
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(f.fuelRow.id)).toMatchObject({ matchStatus: "unmatched", suggestedReceiptId: null });
    expect(byId.get(f.coffeeRow.id)).toMatchObject({ matchStatus: "unmatched", suggestedReceiptId: null });
    expect(byId.get(f.phoneRow.id)).toMatchObject({ matchStatus: "suggested", suggestedReceiptId: f.phone.id });
    expect(byId.get(f.rentRow.id)).toMatchObject({ matchStatus: "suggested", suggestedReceiptId: f.rent.id });
    // The row says why, in Finnish.
    expect(matchExplanation(JSON.parse(byId.get(f.phoneRow.id)!.matchReasons!))).toEqual([
      "summa sama",
      "nimi vastaa",
      "veloitettu 2 päivää oston jälkeen",
    ]);

    // The look-alikes are both offered inline for the owner to choose; the coincidence is not.
    const inline = await buildInlineCandidates(owner.id, rows);
    expect(inline.get(f.coffeeRow.id)?.map((c) => c.receipt.id).sort()).toEqual([f.coffeeA.id, f.coffeeB.id].sort());
    expect(inline.get(f.coffeeRow.id)?.[0].explanation).toContain("useampi yhtä sopiva vaihtoehto, valitse itse");
    expect(inline.has(f.fuelRow.id)).toBe(false);
  });
});

describe("review_matches (chat tool)", () => {
  it("asks the thinking model only about the uncertain pick; an agreeing answer passes and the certain pair is the card", async () => {
    const bodies = installReviewer((candidates) => ({ match: candidates[0].id, confidence: 0.9, reasons: ["sama operaattori"] }));
    const f = await fixtures();
    await runMatching(owner.id);

    const { result, session } = await review("2026-09");
    expect(result.ok).toBe(true);
    expect(result.aiReview).toBe(true);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ model: "gemini-2.5-flash", reasoning_effort: "medium" });
    const asked = JSON.parse(bodies[0].messages[1].content);
    expect(asked.bankRow.id).toBe(f.phoneRow.id);
    expect(asked.candidates.map((c: { id: string }) => c.id)).toEqual([f.phone.id]);

    const passed = Object.fromEntries(result.passed.map((m: { transactionId: string }) => [m.transactionId, m]));
    expect(passed[f.rentRow.id]).toMatchObject({ status: "certain", kind: "kuitti", shownAsCard: true });
    expect(passed[f.rentRow.id].reasons).toEqual(expect.arrayContaining(["viite täsmää", "summa sama"]));
    expect(passed[f.phoneRow.id]).toMatchObject({ status: "ai_accepted", confidence: 0.9 });
    expect(passed[f.phoneRow.id].reasons).toEqual(["summa sama", "nimi vastaa", "veloitettu 2 päivää oston jälkeen", "sama operaattori"]);
    expect(passed[f.fuelRow.id]).toBeUndefined();
    expect(result.ambiguous.map((row: { transactionId: string }) => row.transactionId)).toEqual([f.coffeeRow.id]);
    expect(result.ambiguous[0].options).toHaveLength(2);

    // One card per reply, waiting for Hyväksy; nothing linked.
    expect(session.proposal()).toMatchObject({
      type: "match_proposal",
      transactionId: f.rentRow.id,
      receiptId: f.rent.id,
      reasons: expect.arrayContaining(["viite täsmää", "summa sama"]),
    });
    expect(await prisma.transaction.count({ where: { receiptId: { not: null } } })).toBe(0);

    // The stored suggestion carries the review; a second run asks nothing.
    const phoneRow = await prisma.transaction.findUnique({ where: { id: f.phoneRow.id } });
    expect(JSON.parse(phoneRow!.matchReasons!)).toEqual(expect.arrayContaining(["ai", "fi:sama operaattori"]));
    await review("2026-09");
    expect(bodies).toHaveLength(1);
  });

  it("a disagreeing or unsure model withdraws the suggestion, and a later sync does not bring it back", async () => {
    installReviewer(() => ({ match: null, confidence: 0.9, reasons: ["eri saaja"] }));
    const f = await fixtures();
    await runMatching(owner.id);

    const { result } = await review();
    expect(result.passed.map((m: { transactionId: string }) => m.transactionId)).toEqual([f.rentRow.id]);
    expect(result.notSuggested).toEqual([expect.objectContaining({ transactionId: f.phoneRow.id, why: ["eri saaja"] })]);
    expect(await prisma.transaction.findUnique({ where: { id: f.phoneRow.id } })).toMatchObject({
      matchStatus: "unmatched",
      suggestedReceiptId: null,
    });

    await runMatching(owner.id);
    expect((await prisma.transaction.findUnique({ where: { id: f.phoneRow.id } }))?.matchStatus).toBe("unmatched");
    const rows = await prisma.transaction.findMany({ where: { statement: { userId: owner.id } } });
    expect((await buildInlineCandidates(owner.id, rows)).has(f.phoneRow.id)).toBe(false);
    expect(await prisma.automationEvent.count({ where: { userId: owner.id, kind: REVIEW_EVENT_KIND } })).toBe(1);
  });

  it("a model without reasoning still reviews; low confidence vetoes", async () => {
    vi.stubEnv("LLM_CHAT_MODEL", "gpt-4o-mini");
    const bodies = installReviewer((candidates) => ({ match: candidates[0].id, confidence: 0.6, reasons: [] }));
    const f = await fixtures();
    await runMatching(owner.id);
    const { result } = await review();
    expect(bodies[0].reasoning_effort).toBeUndefined();
    expect(result.notSuggested.map((m: { transactionId: string }) => m.transactionId)).toEqual([f.phoneRow.id]);
  });

  it("rejects a bad month and never reads another owner's rows", async () => {
    installReviewer((candidates) => ({ match: candidates[0].id, confidence: 0.9, reasons: [] }));
    await fixtures();
    expect((await review("2026-13")).result).toMatchObject({ ok: false });
    const stranger = await createUser({ firstName: "Vieras" });
    const session = createChatToolSession(stranger.id, NOW);
    const result = JSON.parse(await session.run("review_matches", "{}"));
    expect(result).toMatchObject({ ok: true, passed: [], ambiguous: [] });
    expect(session.proposal()).toBeNull();
  });
});

describe("the chat's kohdista turn", () => {
  it("offers nothing when only weak pairs exist, and says so", async () => {
    installReviewer((candidates) => ({ match: candidates[0].id, confidence: 0.99, reasons: [] }));
    await receipt({ vendor: "Neste", date: "2026-09-05", cents: 1_500 });
    await receipt({ vendor: "Shell", date: "2026-09-05", cents: 2_200 });
    await statement([{ date: "2026-09-05", amountCents: -1_500, counterparty: "SHELL HELSINKI" }]);
    const result = await processAiChatMessage(owner.id, "kohdista kuitit");
    expect(result.proposal).toBeUndefined();
    expect(result.reply).toMatch(/ei löytynyt varmaa ehdotusta/);
  });

  it("offers a reviewed pair with its Finnish reasons", async () => {
    installReviewer((candidates) => ({ match: candidates[0].id, confidence: 0.9, reasons: [] }));
    const phone = await receipt({ vendor: "Puhelinfirma Oy", date: "2026-09-10", cents: 4_990 });
    const [row] = await statement([{ date: "2026-09-12", amountCents: -4_990, counterparty: "PUHELINFIRMA OY" }]);
    const result = await processAiChatMessage(owner.id, "kohdista kuitit");
    expect(result.proposal).toMatchObject({
      type: "match_proposal",
      transactionId: row.id,
      receiptId: phone.id,
      reasons: ["summa sama", "nimi vastaa", "veloitettu 2 päivää oston jälkeen"],
    });
  });
});
