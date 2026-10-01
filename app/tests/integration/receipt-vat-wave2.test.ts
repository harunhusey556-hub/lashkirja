import { beforeEach, describe, expect, it } from "vitest";
import { PATCH as patchReceipt } from "@/app/api/receipts/[id]/route";
import { prisma } from "@/lib/db";
import { createReceipt, createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, routeContext, sessionCookie } from "./helpers/http";

let user: TestUser;
let cookie: string;

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

async function patch(id: string, body: Record<string, unknown>) {
  return patchReceipt(
    buildRequest("PATCH", `/api/receipts/${id}`, body, { cookie }),
    routeContext({ id })
  );
}

describe("R61: a stored VAT line is not re-judged when it is sent back unchanged", () => {
  it("lets the category of a receipt with an off-list stored rate change", async () => {
    const stored = JSON.stringify([{ rate: 22, amount: 2.25 }]);
    const receipt = await createReceipt(user.id, {
      reviewStatus: "pending",
      totalAmountCents: 12_50,
      vatDetails: stored,
    });
    const response = await patch(receipt.id, {
      category: "muut",
      vatDetails: [{ rate: 22, amount: 2.25 }],
    });
    expect(response.status).toBe(200);
    const after = await prisma.receipt.findUnique({ where: { id: receipt.id } });
    expect(after?.category).toBe("muut");
    expect(after?.vatDetails).toBe(stored);
  });

  it("still holds a CHANGED line to the same rule as save", async () => {
    const receipt = await createReceipt(user.id, {
      reviewStatus: "pending",
      totalAmountCents: 12_50,
      vatDetails: JSON.stringify([{ rate: 22, amount: 2.25 }]),
    });
    const otherRate = await patch(receipt.id, { vatDetails: [{ rate: 20, amount: 2.08 }] });
    expect(otherRate.status).toBe(400);
    const otherAmount = await patch(receipt.id, { vatDetails: [{ rate: 22, amount: 2.3 }] });
    expect(otherAmount.status).toBe(400);
    const tooMuch = await patch(receipt.id, { vatDetails: [{ rate: 25.5, amount: 99 }] });
    expect(tooMuch.status).toBe(400);
  });

  it("stores no VAT when an empty list is sent, and none is invented when it is left out", async () => {
    const receipt = await createReceipt(user.id, {
      reviewStatus: "approved",
      totalAmountCents: 12_50,
      vatDetails: null,
    });
    const notesOnly = await patch(receipt.id, { notes: "vain selite" });
    expect(notesOnly.status).toBe(200);
    expect((await prisma.receipt.findUnique({ where: { id: receipt.id } }))?.vatDetails).toBeNull();
    const empty = await patch(receipt.id, { vatDetails: [] });
    expect(empty.status).toBe(200);
    expect((await prisma.receipt.findUnique({ where: { id: receipt.id } }))?.vatDetails).toBeNull();
  });
});
