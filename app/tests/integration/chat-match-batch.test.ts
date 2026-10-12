import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@/lib/db";
import { resetCopilotPauseForTests } from "@/lib/copilot";
import { createChatToolSession } from "@/lib/chat-tools";
import { runMatching } from "@/lib/matching";
import { processAiChatMessage } from "@/lib/ai-assistant";
import { POST as confirmAll } from "@/app/api/matching/confirm-all/route";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, sessionCookie } from "./helpers/http";

const NOW = new Date("2026-10-03T09:00:00.000Z");

let owner: TestUser;
let cookie: string;

type Pair = { transactionId: string; receiptId: string };
type BatchProposal = {
  type: string;
  confident: number;
  ambiguous: number;
  pairs: Pair[];
  cards: Array<{ ambiguous: boolean; receiptId: string | null }>;
};

async function statement(rows: Array<{ date: string; amountCents: number; counterparty: string; reference?: string }>) {
  return prisma.statement.create({
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
          type: "meno",
        })),
      },
    },
  });
}

async function receipt(data: { vendor: string; date: string; cents: number; reference?: string }) {
  return prisma.receipt.create({
    data: {
      userId: owner.id,
      type: "meno",
      vendor: data.vendor,
      date: new Date(`${data.date}T00:00:00.000Z`),
      totalAmountCents: data.cents,
      reference: data.reference ?? null,
      // Pending, as an import leaves them: the confirm approves.
      reviewStatus: "pending",
      category: "muut",
      filePath: `/tmp/${randomUUID()}.pdf`,
      fileName: `${data.vendor}.pdf`,
    },
  });
}

/** `count` receipt/bank-row pairs that match by viite + amount (certain). */
async function seedCertainPairs(count: number) {
  for (let i = 0; i < count; i += 1) {
    const reference = `91${String(i).padStart(2, "0")}`;
    await receipt({ vendor: `Toimittaja ${i}`, date: "2026-09-08", cents: 10_000 + i, reference });
    await statement([{ date: "2026-09-09", amountCents: -(10_000 + i), counterparty: `TOIMITTAJA ${i}`, reference }]);
  }
}

/** One bank row that two identical receipts fit: the owner's choice, never a pair. */
async function seedAmbiguousRow() {
  await receipt({ vendor: "Kahvila Lumo", date: "2026-09-19", cents: 890 });
  await receipt({ vendor: "Kahvila Lumo", date: "2026-09-20", cents: 890 });
  await statement([{ date: "2026-09-21", amountCents: -890, counterparty: "KAHVILA LUMO" }]);
}

async function proposalOfReview(): Promise<BatchProposal> {
  const session = createChatToolSession(owner.id, NOW);
  const result = JSON.parse(await session.run("review_matches", "{}"));
  expect(result.ok).toBe(true);
  return session.proposal() as unknown as BatchProposal;
}

function postConfirmAll(body: unknown, as = cookie) {
  return confirmAll(buildRequest("POST", "/api/matching/confirm-all", body, { cookie: as }));
}

beforeEach(async () => {
  resetCopilotPauseForTests();
  await resetDatabase();
  vi.stubEnv("COPILOT_GITHUB_TOKEN", "");
  vi.stubEnv("LLM_API_KEY", "");
  owner = await createUser();
  cookie = await sessionCookie(owner);
});

describe("accepting a whole review in one tap", () => {
  it("confirms 5 of 5 proposed pairs, and a second tap links nothing twice", async () => {
    await seedCertainPairs(5);
    await runMatching(owner.id);
    const proposal = await proposalOfReview();
    expect(proposal.type).toBe("match_batch");
    expect(proposal.pairs).toHaveLength(5);
    expect(proposal.cards).toHaveLength(5);

    const first = await postConfirmAll({ pairs: proposal.pairs });
    expect(first.status).toBe(200);
    expect(await readJson(first)).toMatchObject({ ok: true, confirmed: 5, skipped: 0, alreadyConfirmed: 0 });
    expect(await prisma.transaction.count({ where: { statement: { userId: owner.id }, matchStatus: "confirmed", receiptId: { not: null } } })).toBe(5);
    expect(await prisma.receipt.count({ where: { userId: owner.id, reviewStatus: "approved" } })).toBe(5);
    const events = await prisma.automationEvent.count({ where: { userId: owner.id, kind: "match" } });
    expect(events).toBe(5);

    const second = await postConfirmAll({ pairs: proposal.pairs });
    expect(second.status).toBe(200);
    expect(await readJson(second)).toMatchObject({ ok: true, confirmed: 0, skipped: 0, alreadyConfirmed: 5 });
    // No duplicate links and no second audit event.
    expect(await prisma.transaction.count({ where: { statement: { userId: owner.id }, receiptId: { not: null } } })).toBe(5);
    expect(await prisma.automationEvent.count({ where: { userId: owner.id, kind: "match" } })).toBe(events);
  });

  it("keeps an ambiguous row out of the batch and counts it for the owner's choice", async () => {
    await seedCertainPairs(3);
    await seedAmbiguousRow();
    await runMatching(owner.id);
    const proposal = await proposalOfReview();
    expect(proposal).toMatchObject({ type: "match_batch", confident: 3, ambiguous: 1 });
    expect(proposal.cards).toHaveLength(4);
    expect(proposal.cards.filter((card) => card.ambiguous)).toHaveLength(1);
    expect(proposal.pairs).toHaveLength(3);

    const result = await readJson(await postConfirmAll({ pairs: proposal.pairs }));
    expect(result).toMatchObject({ confirmed: 3, skipped: 0 });
    // The two coffee receipts stay open.
    expect(await prisma.transaction.count({ where: { statement: { userId: owner.id }, receiptId: { not: null } } })).toBe(3);
  });

  it("never confirms pairs of another owner's books", async () => {
    await seedCertainPairs(2);
    await runMatching(owner.id);
    const proposal = await proposalOfReview();
    const stranger = await createUser({ firstName: "Vieras" });
    const response = await postConfirmAll({ pairs: proposal.pairs }, await sessionCookie(stranger));
    expect(response.status).toBe(200);
    expect(await readJson(response)).toMatchObject({ confirmed: 0, alreadyConfirmed: 0, skipped: 2 });
    expect(await prisma.transaction.count({ where: { receiptId: { not: null } } })).toBe(0);
  });
});

describe("the chat's kohdista turn carries every proposal", () => {
  it("answers 'Kohdista kaikki kuitit' with one batch card and a matching sentence", async () => {
    await seedCertainPairs(5);
    await seedAmbiguousRow();
    await runMatching(owner.id);
    const result = await processAiChatMessage(owner.id, "Kohdista kaikki kuitit");
    expect(result.proposal).toMatchObject({ type: "match_batch", confident: 5, ambiguous: 1 });
    expect((result.proposal as unknown as BatchProposal).cards).toHaveLength(6);
    expect(result.reply).toContain("Löysin 6 ehdotusta, 5 niistä varmoja. Hyväksy ne kerralla alta.");
    expect(result.reply).not.toMatch(/Pankki-näkymä/);
    // Nothing is linked by asking.
    expect(await prisma.transaction.count({ where: { statement: { userId: owner.id }, receiptId: { not: null } } })).toBe(0);
  });

  it.each(["kohdista kuitit", "Täsmäytä kaikki kuitit", "Yhdistä kuitit"])("routes '%s' to the same batch", async (text) => {
    await seedCertainPairs(3);
    await runMatching(owner.id);
    const result = await processAiChatMessage(owner.id, text);
    expect(result.proposal).toMatchObject({ type: "match_batch", confident: 3, ambiguous: 0 });
    expect(result.reply).toContain("Löysin 3 ehdotusta, 3 niistä varmoja.");
  });

  it("keeps the plain single card for one lone pair", async () => {
    await seedCertainPairs(1);
    await runMatching(owner.id);
    const result = await processAiChatMessage(owner.id, "Kohdista kuitit");
    expect(result.proposal).toMatchObject({ type: "match_proposal" });
    expect(result.reply).toContain("Löysin ehdotuksen");
  });
});
