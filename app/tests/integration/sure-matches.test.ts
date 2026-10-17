import { randomUUID } from "crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as listSure, POST as linkSure } from "@/app/api/matching/sure/route";
import { POST as undoSure } from "@/app/api/matching/sure/undo/route";
import { PATCH as patchProfile } from "@/app/api/profile/route";
import { prisma } from "@/lib/db";
import { runMatching } from "@/lib/matching";
import { IDEMPOTENCY_PROCESSING_MS } from "@/lib/idempotency";
import {
  failSureMatchChunkForTests,
  setSureRunBudgetForTests,
  SURE_MATCH_BATCH_KIND,
  SURE_MATCH_CHUNK,
  SURE_MATCH_UNDO_KIND,
  SURE_RUN_LOCK_SCOPE,
  SURE_RUN_MAX_MS,
} from "@/lib/sure-matches";
import { createReceipt, createStatementWithTransactions, createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, sessionCookie, type JsonValue } from "./helpers/http";

/**
 * Owner 2026-10-15: "Kohdista varmat (N)" links every receipt whose suggested bank row is
 * certain (viite + exact amount) or passes the auto-confirm rule, atomically, with one undo.
 */

let user: TestUser;
let cookie: string;

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

afterEach(() => {
  failSureMatchChunkForTests(null);
  setSureRunBudgetForTests(null);
});

/**
 * A receipt with a viite, its bank row carrying that viite, and a look-alike row (same
 * amount and name) that makes the pair "competing": the run suggests it but never posts it.
 */
async function certainButCompeting(owner = user) {
  const receipt = await createReceipt(owner.id, { totalAmountCents: 124_00, date: "2026-01-10", vendor: "Tukku Oy" });
  await prisma.receipt.update({ where: { id: receipt.id }, data: { reference: "13" } });
  const statement = await createStatementWithTransactions(owner.id, {
    periodMonth: "2026-01",
    transactions: [
      { date: "2026-01-12", amountCents: -124_00, counterparty: "Tukku Oy" },
      { date: "2026-01-11", amountCents: -124_00, counterparty: "Tukku Oy" },
    ],
  });
  const [withViite, rival] = statement.transactions.sort((a, b) => (a.date! < b.date! ? 1 : -1));
  await prisma.transaction.update({ where: { id: withViite.id }, data: { reference: "13" } });
  return { receipt, row: withViite, rival };
}

const get = async () => readJson(await listSure(buildRequest("GET", "/api/matching/sure", undefined, { cookie })));
const post = (key?: string) =>
  linkSure(buildRequest("POST", "/api/matching/sure", {}, { cookie, headers: key ? { "idempotency-key": key } : {} }));
const undo = (batchId: string) => undoSure(buildRequest("POST", "/api/matching/sure/undo", { batchId }, { cookie }));

describe("Kohdista varmat", () => {
  it("counts and links a certain pair the run left as a suggestion, then one Kumoa takes it back", async () => {
    const { receipt, row } = await certainButCompeting();
    await runMatching(user.id);
    const suggested = await prisma.transaction.findUniqueOrThrow({ where: { id: row.id } });
    expect(suggested).toMatchObject({ matchStatus: "suggested", suggestedReceiptId: receipt.id });
    expect(JSON.parse(suggested.matchReasons ?? "[]")).toContain("competing");

    const before = await get();
    expect(before.count).toBe(1);
    expect(before.pairs[0]).toMatchObject({ transactionId: row.id, receiptId: receipt.id, amount: 124 });
    expect(before.pairs[0].reasons).toEqual(expect.arrayContaining(["viite täsmää"]));

    const response = await post();
    expect(response.status).toBe(200);
    const batch = await readJson(response);
    expect(batch.linked.map((pair: JsonValue) => pair.transactionId)).toEqual([row.id]);
    expect(await prisma.transaction.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      receiptId: receipt.id,
      matchStatus: "confirmed",
    });
    expect((await get()).count).toBe(0);
    // Nothing left: a second tap links nothing and has nothing to undo.
    expect(await readJson(await post())).toEqual({ batchId: null, linked: [] });

    const undone = await undo(batch.batchId);
    expect(undone.status).toBe(200);
    expect(await readJson(undone)).toEqual({
      restored: 1,
      undone: [{ transactionId: row.id, receiptId: receipt.id }],
      skipped: [],
    });
    expect(await prisma.transaction.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      receiptId: null,
      matchStatus: "suggested",
      suggestedReceiptId: receipt.id,
      matchReasons: suggested.matchReasons,
    });
    expect((await get()).count).toBe(1);
    expect(await readJson(await undo(batch.batchId))).toEqual({ restored: 0, undone: [], skipped: [] });
  });

  it("replays the same answer for the same Idempotency-Key", async () => {
    await certainButCompeting();
    await runMatching(user.id);
    const first = await readJson(await post("sure-key-1"));
    const again = await readJson(await post("sure-key-1"));
    expect(first.linked).toHaveLength(1);
    expect(again).toEqual(first);
  });

  it("re-checks the pair: a stored suggestion the gate no longer calls sure is not linked", async () => {
    const { receipt, row } = await certainButCompeting();
    await runMatching(user.id);
    // The viite was corrected away after the run: the stored suggestion says nothing about it now.
    await prisma.receipt.update({ where: { id: receipt.id }, data: { reference: null } });
    expect((await get()).count).toBe(0);
    expect((await readJson(await post())).linked).toEqual([]);
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: row.id } })).receiptId).toBeNull();
  });

  it("leaves pending receipts and another owner's pairs out, and refuses another owner's batch", async () => {
    const other = await createUser();
    const { receipt } = await certainButCompeting();
    await prisma.receipt.update({ where: { id: receipt.id }, data: { reviewStatus: "pending" } });
    await certainButCompeting(other);
    await runMatching(user.id);
    await runMatching(other.id);
    expect((await get()).count).toBe(0);

    const otherCookie = await sessionCookie(other);
    const theirs = await readJson(
      await linkSure(buildRequest("POST", "/api/matching/sure", {}, { cookie: otherCookie }))
    );
    expect(theirs.linked).toHaveLength(1);
    expect((await undo(theirs.batchId)).status).toBe(404);
  });

  it("with 'Kohdista varmat automaattisesti' on, the run links the certain pair itself", async () => {
    const { receipt, row } = await certainButCompeting();
    const saved = await patchProfile(
      buildRequest("PATCH", "/api/profile", { autoLinkSureMatches: true }, { cookie })
    );
    expect(saved.status).toBe(200);
    expect((await readJson(saved)).profile.autoLinkSureMatches).toBe(true);
    await runMatching(user.id);
    expect(await prisma.transaction.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      receiptId: receipt.id,
      matchStatus: "confirmed",
    });
  });
});

/** A Finnish viite (base + check digit, weights 7-3-1 from the right). */
function viite(base: number): string {
  const digits = String(base).split("").reverse();
  const sum = digits.reduce((total, digit, index) => total + Number(digit) * [7, 3, 1][index % 3], 0);
  return `${base}${(10 - (sum % 10)) % 10}`;
}

/**
 * `count` certain pairs (viite + exact amount) waiting as suggestions, written
 * straight to the database so a long backlog is quick to set up.
 */
async function seedSurePairs(count: number, owner = user) {
  const receipts = await prisma.receipt.createManyAndReturn({
    data: Array.from({ length: count }, (_, i) => ({
      userId: owner.id,
      type: "meno",
      date: new Date("2026-01-10T00:00:00.000Z"),
      totalAmountCents: 10_000 + i,
      category: "tarvikkeet",
      vendor: `Tukku ${i} Oy`,
      vatDetails: JSON.stringify([{ rate: 25.5, amount: 20 }]),
      reviewStatus: "approved",
      reference: viite(1000 + i),
      filePath: `/tmp/${randomUUID()}.pdf`,
      fileName: "kuitti.pdf",
    })),
    select: { id: true, totalAmountCents: true, reference: true, vendor: true },
  });
  const statement = await prisma.statement.create({
    data: {
      userId: owner.id,
      fileName: `tiliote-${randomUUID()}.csv`,
      fileType: "csv",
      filePath: `/tmp/${randomUUID()}.csv`,
      checksum: randomUUID(),
      periodMonth: "2026-01",
    },
  });
  await prisma.transaction.createMany({
    data: receipts.map((receipt) => ({
      statementId: statement.id,
      date: new Date("2026-01-12T00:00:00.000Z"),
      amountCents: -(receipt.totalAmountCents ?? 0),
      counterparty: receipt.vendor,
      reference: receipt.reference,
      type: "meno",
      matchStatus: "suggested",
      suggestedReceiptId: receipt.id,
      matchScore: 90,
      matchReasons: JSON.stringify(["reference", "competing"]),
    })),
  });
  const rows = await prisma.transaction.findMany({ where: { statementId: statement.id }, select: { id: true, suggestedReceiptId: true } });
  return receipts.map((receipt) => ({
    receiptId: receipt.id,
    transactionId: rows.find((row) => row.suggestedReceiptId === receipt.id)!.id,
  }));
}

describe("Kohdista varmat: a long backlog and a guarded Kumoa (review 2026-10-16, rows 28-29)", () => {
  it("links 500 pairs in chunks under one batch, a re-run links nothing more, and one Kumoa takes all back", async () => {
    const pairs = await seedSurePairs(500);
    expect((await get()).count).toBe(500);

    const batch = await readJson(await post());
    expect(batch.linked).toHaveLength(500);
    expect(batch.batchId).toEqual(expect.any(String));
    expect(await prisma.transaction.count({ where: { matchStatus: "confirmed" } })).toBe(500);
    // More than one chunk was needed, and still one batch holds every pair.
    expect(500).toBeGreaterThan(SURE_MATCH_CHUNK);
    const batches = await prisma.automationEvent.findMany({ where: { userId: user.id, kind: SURE_MATCH_BATCH_KIND } });
    expect(batches).toHaveLength(1);
    expect(JSON.parse(batches[0].previousValue ?? "[]")).toHaveLength(500);

    expect(await readJson(await post())).toEqual({ batchId: null, linked: [] });

    const undone = await readJson(await undo(batch.batchId));
    expect(undone.restored).toBe(500);
    expect(undone.skipped).toEqual([]);
    expect(await prisma.transaction.count({ where: { matchStatus: "suggested", receiptId: null } })).toBe(500);
    const back = await prisma.receipt.findUniqueOrThrow({ where: { id: pairs[499].receiptId } });
    expect(back.totalAmountCents).toBe(10_499);
  }, 120_000);

  it("Kumoa leaves a receipt the owner edited after the batch and reports it as skipped", async () => {
    const [edited, untouched] = await seedSurePairs(2);
    const batch = await readJson(await post());
    expect(batch.linked).toHaveLength(2);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await prisma.receipt.update({ where: { id: edited.receiptId }, data: { totalAmountCents: 77_00, vendor: "Korjattu Oy" } });

    const result = await readJson(await undo(batch.batchId));
    expect(result).toEqual({
      restored: 1,
      undone: [untouched],
      skipped: [{ ...edited, reason: "edited" }],
    });
    expect(await prisma.transaction.findUniqueOrThrow({ where: { id: edited.transactionId } })).toMatchObject({
      receiptId: edited.receiptId,
      matchStatus: "confirmed",
    });
    expect((await prisma.receipt.findUniqueOrThrow({ where: { id: edited.receiptId } })).totalAmountCents).toBe(77_00);
    expect(await prisma.transaction.findUniqueOrThrow({ where: { id: untouched.transactionId } })).toMatchObject({
      receiptId: null,
      matchStatus: "suggested",
    });
  });

  it("Kumoa leaves pairs in a closed period alone, and a later Kumoa does not reach them either", async () => {
    const [pair] = await seedSurePairs(1);
    const batch = await readJson(await post());
    await prisma.user.update({ where: { id: user.id }, data: { booksLockedThrough: "2026-01" } });

    expect(await readJson(await undo(batch.batchId))).toEqual({
      restored: 0,
      undone: [],
      skipped: [{ ...pair, reason: "locked" }],
    });
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: pair.transactionId } })).receiptId).toBe(pair.receiptId);

    await prisma.user.update({ where: { id: user.id }, data: { booksLockedThrough: null } });
    expect(await readJson(await undo(batch.batchId))).toEqual({ restored: 0, undone: [], skipped: [] });
  });

  it("two Kumoa at the same moment restore the batch once", async () => {
    await seedSurePairs(3);
    const batch = await readJson(await post());
    const [first, second] = await Promise.all([undo(batch.batchId), undo(batch.batchId)]);
    expect([first.status, second.status]).toEqual([200, 200]);
    const restored = [(await readJson(first)).restored, (await readJson(second)).restored].sort();
    expect(restored).toEqual([0, 3]);
    expect(
      await prisma.automationEvent.count({ where: { userId: user.id, kind: "sure_match_undo", resourceId: batch.batchId } })
    ).toBe(1);
  });

  it("a pair unlinked by hand after the batch is reported as changed, not restored", async () => {
    const [pair] = await seedSurePairs(1);
    const batch = await readJson(await post());
    await prisma.transaction.update({ where: { id: pair.transactionId }, data: { receiptId: null, matchStatus: "unmatched" } });
    expect(await readJson(await undo(batch.batchId))).toEqual({
      restored: 0,
      undone: [],
      skipped: [{ ...pair, reason: "changed" }],
    });
  });
});

const confirmedCount = () => prisma.transaction.count({ where: { matchStatus: "confirmed" } });

describe("Kohdista varmat: a run that stops early can still be taken back (ultrareview PR #31)", () => {
  it("a failing third chunk answers with the batch of chunks 1-2, and Kumoa restores them", async () => {
    await seedSurePairs(4 * SURE_MATCH_CHUNK);
    failSureMatchChunkForTests(2);
    const response = await post("sure-fail-1");
    expect(response.status).toBe(200);
    const batch = await readJson(response);
    expect(batch).toMatchObject({ partial: true, failed: true, error: "SURE_MATCH_CHUNK_FAILED", remaining: 2 * SURE_MATCH_CHUNK });
    expect(batch.batchId).toEqual(expect.any(String));
    expect(batch.linked).toHaveLength(2 * SURE_MATCH_CHUNK);
    expect(await confirmedCount()).toBe(2 * SURE_MATCH_CHUNK);

    const undone = await readJson(await undo(batch.batchId));
    expect(undone.restored).toBe(2 * SURE_MATCH_CHUNK);
    expect(await confirmedCount()).toBe(0);
  }, 60_000);

  it("a retry with the same key continues the same batch, so one Kumoa covers both runs", async () => {
    await seedSurePairs(4 * SURE_MATCH_CHUNK);
    failSureMatchChunkForTests(2);
    const first = await readJson(await post("sure-fail-2"));
    expect(first.failed).toBe(true);

    const again = await readJson(await post("sure-fail-2"));
    expect(again.batchId).toBe(first.batchId);
    expect(again.partial).toBeUndefined();
    expect(again.linked).toHaveLength(4 * SURE_MATCH_CHUNK);
    expect(await prisma.automationEvent.count({ where: { userId: user.id, kind: SURE_MATCH_BATCH_KIND } })).toBe(1);
    // The finished answer is the key's answer now.
    expect(await readJson(await post("sure-fail-2"))).toEqual(again);

    expect((await readJson(await undo(again.batchId))).restored).toBe(4 * SURE_MATCH_CHUNK);
    expect(await confirmedCount()).toBe(0);
  }, 60_000);

  it("a failing first chunk links nothing and leaves no empty batch behind", async () => {
    await seedSurePairs(3);
    failSureMatchChunkForTests(0);
    expect((await post()).status).toBe(500);
    expect(await confirmedCount()).toBe(0);
    expect(await prisma.automationEvent.count({ where: { userId: user.id, kind: SURE_MATCH_BATCH_KIND } })).toBe(0);
  });

  it("a run past its time stops after the chunk it is in and says how many are left", async () => {
    await seedSurePairs(SURE_MATCH_CHUNK + 20);
    setSureRunBudgetForTests(0);
    const batch = await readJson(await post("sure-slow-1"));
    expect(batch).toMatchObject({ partial: true, remaining: 20 });
    expect(batch.failed).toBeUndefined();
    expect(batch.linked).toHaveLength(SURE_MATCH_CHUNK);
    expect(batch.batchId).toEqual(expect.any(String));

    setSureRunBudgetForTests(null);
    const rest = await readJson(await post("sure-slow-2"));
    expect(rest.partial).toBeUndefined();
    expect(rest.linked).toHaveLength(20);
    expect(rest.batchId).not.toBe(batch.batchId);
    expect(await confirmedCount()).toBe(SURE_MATCH_CHUNK + 20);
  }, 60_000);
});

describe("Kohdista varmat: one run per owner at a time (ultrareview PR #31)", () => {
  it("a run while another holds the owner's run marker is refused with SURE_MATCH_RUNNING", async () => {
    await seedSurePairs(2);
    await prisma.idempotencyRecord.create({
      data: { userId: user.id, scope: SURE_RUN_LOCK_SCOPE, key: "run", statusCode: 0, body: "" },
    });
    const refused = await post("sure-busy-1");
    expect(refused.status).toBe(409);
    expect((await readJson(refused)).error.code).toBe("SURE_MATCH_RUNNING");
    expect(await confirmedCount()).toBe(0);
    // The refused key is free again: the same tap works once the other run is gone.
    await prisma.idempotencyRecord.deleteMany({ where: { userId: user.id, scope: SURE_RUN_LOCK_SCOPE } });
    expect((await readJson(await post("sure-busy-1"))).linked).toHaveLength(2);
    expect(await prisma.idempotencyRecord.count({ where: { userId: user.id, scope: SURE_RUN_LOCK_SCOPE } })).toBe(0);
  });

  it("a marker left by a crashed run is taken over once it is older than any run can last", async () => {
    await seedSurePairs(2);
    await prisma.idempotencyRecord.create({
      data: {
        userId: user.id,
        scope: SURE_RUN_LOCK_SCOPE,
        key: "run",
        statusCode: 0,
        body: "",
        createdAt: new Date(Date.now() - IDEMPOTENCY_PROCESSING_MS - 1000),
      },
    });
    expect((await readJson(await post())).linked).toHaveLength(2);
  });

  it("the stale windows outlast the longest run", () => {
    expect(SURE_RUN_MAX_MS).toBeLessThan(IDEMPOTENCY_PROCESSING_MS);
  });

  it("two runs at the same moment do not split the backlog between two batches", async () => {
    await seedSurePairs(3 * SURE_MATCH_CHUNK);
    const answers = await Promise.all([post("sure-race-a"), post("sure-race-b")]);
    const bodies = await Promise.all(answers.map((answer) => readJson(answer)));
    const linked = bodies.reduce((total, body) => total + (body.linked?.length ?? 0), 0);
    expect(linked).toBe(3 * SURE_MATCH_CHUNK);
    const batches = await prisma.automationEvent.findMany({ where: { userId: user.id, kind: SURE_MATCH_BATCH_KIND } });
    expect(batches).toHaveLength(1);
    for (const [index, answer] of answers.entries()) {
      if (answer.status === 409) expect(bodies[index].error.code).toBe("SURE_MATCH_RUNNING");
      else expect(answer.status).toBe(200);
    }
  }, 60_000);
});

describe("Kohdista varmat: Kumoa of a long batch (ultrareview PR #31)", () => {
  it("undoes in chunks; a Kumoa cut off midway is finished by the next one, each pair once", async () => {
    await seedSurePairs(500);
    const batch = await readJson(await post());
    expect(batch.linked).toHaveLength(500);

    failSureMatchChunkForTests(3);
    expect((await undo(batch.batchId)).status).toBe(500);
    // Chunks 1-3 committed on their own; the failing fourth rolled back.
    expect(await confirmedCount()).toBe(500 - 3 * SURE_MATCH_CHUNK);

    const rest = await readJson(await undo(batch.batchId));
    expect(rest.restored).toBe(500 - 3 * SURE_MATCH_CHUNK);
    expect(rest.skipped).toEqual([]);
    expect(await confirmedCount()).toBe(0);
    expect(await readJson(await undo(batch.batchId))).toEqual({ restored: 0, undone: [], skipped: [] });
    const markers = await prisma.automationEvent.findMany({ where: { userId: user.id, kind: SURE_MATCH_UNDO_KIND } });
    expect(markers).toHaveLength(1);
    expect(markers[0].newValue).toBe("500");
  }, 120_000);
});
