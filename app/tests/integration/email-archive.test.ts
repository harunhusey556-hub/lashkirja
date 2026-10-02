import { beforeEach, describe, expect, it } from "vitest";
import { POST as archiveNonBills } from "@/app/api/integrations/imap/archive/route";
import { prisma } from "@/lib/db";
import { resetRateLimitsForTests } from "@/lib/rate-limit";
import { createReceipt, createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, sessionCookie } from "./helpers/http";

/** Sähköposti → "Arkistoi ei-laskut": pending e-mail receipts without an amount leave the review queue. */

let user: TestUser;
let cookie: string;

beforeEach(async () => {
  resetRateLimitsForTests();
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

async function emailReceipt(totalAmountCents: number | null, reviewStatus = "pending") {
  const receipt = await createReceipt(user.id, { totalAmountCents, reviewStatus });
  return prisma.receipt.update({ where: { id: receipt.id }, data: { source: "email_sync" } });
}

describe("POST /api/integrations/imap/archive", () => {
  it("archives only pending e-mail receipts without an amount", async () => {
    const empty = await emailReceipt(null);
    const zero = await emailReceipt(0);
    const bill = await emailReceipt(4_990);
    const approved = await emailReceipt(null, "approved");
    const manual = await createReceipt(user.id, { totalAmountCents: null, reviewStatus: "pending" });

    const response = await archiveNonBills(buildRequest("POST", "/api/integrations/imap/archive", {}, { cookie }));
    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ archived: 2 });

    const status = async (id: string) => (await prisma.receipt.findUniqueOrThrow({ where: { id } })).reviewStatus;
    expect(await status(empty.id)).toBe("rejected");
    expect(await status(zero.id)).toBe("rejected");
    expect(await status(bill.id)).toBe("pending");
    expect(await status(approved.id)).toBe("approved");
    expect(await status(manual.id)).toBe("pending");
  });

  it("never touches another owner's receipts", async () => {
    const other = await createUser({ email: "toinen@example.com" });
    const theirs = await createReceipt(other.id, { totalAmountCents: null, reviewStatus: "pending" });
    await prisma.receipt.update({ where: { id: theirs.id }, data: { source: "email_sync" } });

    const response = await archiveNonBills(buildRequest("POST", "/api/integrations/imap/archive", {}, { cookie }));
    expect(await readJson(response)).toEqual({ archived: 0 });
    expect((await prisma.receipt.findUniqueOrThrow({ where: { id: theirs.id } })).reviewStatus).toBe("pending");
  });
});
