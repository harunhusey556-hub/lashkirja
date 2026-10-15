import { beforeEach, describe, expect, it } from "vitest";
import { GET as listSure, POST as linkSure } from "@/app/api/matching/sure/route";
import { POST as undoSure } from "@/app/api/matching/sure/undo/route";
import { PATCH as patchProfile } from "@/app/api/profile/route";
import { prisma } from "@/lib/db";
import { runMatching } from "@/lib/matching";
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
    expect(await readJson(undone)).toEqual({ restored: 1 });
    expect(await prisma.transaction.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      receiptId: null,
      matchStatus: "suggested",
      suggestedReceiptId: receipt.id,
      matchReasons: suggested.matchReasons,
    });
    expect((await get()).count).toBe(1);
    expect(await readJson(await undo(batch.batchId))).toEqual({ restored: 0 });
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
