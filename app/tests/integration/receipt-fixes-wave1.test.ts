import { beforeEach, describe, expect, it } from "vitest";
import { POST as saveReceipt } from "@/app/api/receipts/save/route";
import { PATCH as patchReceipt } from "@/app/api/receipts/[id]/route";
import { PATCH as reviewReceipt } from "@/app/api/receipts/[id]/review/route";
import { prisma } from "@/lib/db";
import { createReceipt, createUpload, createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";

let user: TestUser;
let cookie: string;

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

async function save(body: Record<string, unknown>) {
  const upload = await createUpload(user.id);
  const response = await saveReceipt(
    buildRequest(
      "POST",
      "/api/receipts/save",
      { uploadId: upload.id, category: "muut", type: "meno", ...body },
      { cookie }
    )
  );
  return { response, upload };
}

async function patch(id: string, body: Record<string, unknown>) {
  return patchReceipt(
    buildRequest("PATCH", `/api/receipts/${id}`, body, { cookie }),
    routeContext({ id })
  );
}

async function review(id: string, reviewStatus: "approved" | "rejected") {
  return reviewReceipt(
    buildRequest("PATCH", `/api/receipts/${id}/review`, { reviewStatus }, { cookie }),
    routeContext({ id })
  );
}

describe("F164: VAT lines are checked on the server", () => {
  it("refuses a VAT line larger than the receipt total and leaves the upload unclaimed", async () => {
    const { response, upload } = await save({
      vendor: "Tukku",
      date: "2026-03-03",
      totalAmount: 10,
      vatDetails: [{ rate: 25.5, amount: 50 }],
    });
    expect(response.status).toBe(400);
    const body = await readJson(response);
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(body.error.message).toBe("ALV-summa ei voi olla suurempi kuin kuitin summa.");
    expect(await prisma.receipt.count()).toBe(0);
    const stored = await prisma.upload.findUnique({ where: { id: upload.id } });
    expect(stored?.claimedAt).toBeNull();
  });

  it("refuses the VAT lines together when they add up to more than the total", async () => {
    const { response } = await save({
      vendor: "Tukku",
      date: "2026-03-03",
      totalAmount: 10,
      vatDetails: [
        { rate: 25.5, amount: 6 },
        { rate: 10, amount: 5 },
      ],
    });
    expect(response.status).toBe(400);
  });

  it("refuses a rate the VAT return does not know", async () => {
    const { response } = await save({
      vendor: "Tukku",
      date: "2026-03-03",
      totalAmount: 10,
      vatDetails: [{ rate: 99, amount: 0.5 }],
    });
    expect(response.status).toBe(400);
    expect((await readJson(response)).error.message).toMatch(/99 %/);
  });

  it("still saves a VAT line that fits, in a current, legacy or zero rate", async () => {
    for (const rate of [25.5, 14, 0]) {
      const { response } = await save({
        vendor: `Tukku ${rate}`,
        date: "2026-03-03",
        totalAmount: 12.5,
        vatDetails: [{ rate, amount: rate === 0 ? 0 : 1.5 }],
      });
      expect(response.status, String(rate)).toBe(200);
    }
  });

  it("refuses a PATCH whose VAT is larger than the stored total, and one that shrinks the total under the stored VAT", async () => {
    const receipt = await createReceipt(user.id, {
      reviewStatus: "pending",
      totalAmountCents: 10_00,
      vatDetails: JSON.stringify([{ rate: 25.5, amount: 2.03 }]),
    });
    const tooMuch = await patch(receipt.id, { vatDetails: [{ rate: 25.5, amount: 50 }] });
    expect(tooMuch.status).toBe(400);
    const smallerTotal = await patch(receipt.id, { totalAmount: 1 });
    expect(smallerTotal.status).toBe(400);
    const badRate = await patch(receipt.id, { vatDetails: [{ rate: 99, amount: 0.5 }] });
    expect(badRate.status).toBe(400);
    const unchanged = await prisma.receipt.findUnique({ where: { id: receipt.id } });
    expect(unchanged?.totalAmountCents).toBe(10_00);
    expect(unchanged?.vatDetails).toBe(JSON.stringify([{ rate: 25.5, amount: 2.03 }]));

    const fine = await patch(receipt.id, { totalAmount: 30, vatDetails: [{ rate: 25.5, amount: 6.1 }] });
    expect(fine.status).toBe(200);
    const notesOnly = await patch(receipt.id, { notes: "muistiinpano" });
    expect(notesOnly.status).toBe(200);
  });
});

describe("F06: rejecting an approved receipt respects the period lock", () => {
  async function lockThrough(month: string) {
    await prisma.user.update({ where: { id: user.id }, data: { booksLockedThrough: month } });
  }

  it("refuses the rejection with PERIOD_LOCKED and leaves the status alone", async () => {
    const receipt = await createReceipt(user.id, { date: "2026-07-03", reviewStatus: "approved" });
    await lockThrough("2026-07");
    const response = await review(receipt.id, "rejected");
    expect(response.status).toBe(409);
    expect((await readJson(response)).error.code).toBe("PERIOD_LOCKED");
    const after = await prisma.receipt.findUnique({ where: { id: receipt.id } });
    expect(after?.reviewStatus).toBe("approved");
  });

  it("still lets a pending receipt of a closed month be rejected, it is not in the books", async () => {
    const receipt = await createReceipt(user.id, { date: "2026-07-03", reviewStatus: "pending" });
    await lockThrough("2026-07");
    const response = await review(receipt.id, "rejected");
    expect(response.status).toBe(200);
  });

  it("still lets an approved receipt of an open month be rejected", async () => {
    const receipt = await createReceipt(user.id, { date: "2026-09-03", reviewStatus: "approved" });
    await lockThrough("2026-07");
    const response = await review(receipt.id, "rejected");
    expect(response.status).toBe(200);
    const after = await prisma.receipt.findUnique({ where: { id: receipt.id } });
    expect(after?.reviewStatus).toBe("rejected");
  });
});

describe("F61: receipt text keeps a plain less-than sign", () => {
  it("stores ordinary text with < and > as typed", async () => {
    const { response } = await save({
      vendor: "LT-host Cafe <3 Kukka & Co",
      date: "2026-03-03",
      totalAmount: 12.5,
      notes: "Hinta < 50 € ja > 20 €",
      reference: "5 < 10",
      invoiceNumber: "3 <= 4",
    });
    expect(response.status).toBe(200);
    const stored = await prisma.receipt.findFirstOrThrow();
    expect(stored.vendor).toBe("LT-host Cafe <3 Kukka & Co");
    expect(stored.notes).toBe("Hinta < 50 € ja > 20 €");
    expect(stored.reference).toBe("5 < 10");
    expect(stored.invoiceNumber).toBe("3 <= 4");
  });

  it("keeps a PATCHed note with a bracket, and still drops a real tag", async () => {
    const receipt = await createReceipt(user.id, { reviewStatus: "pending" });
    const response = await patch(receipt.id, { notes: "Alle 50 € (<50) ja yli 20 > 10 <b>lihava</b>" });
    expect(response.status).toBe(200);
    const stored = await prisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(stored.notes).toBe("Alle 50 € (<50) ja yli 20 > 10 lihava");
  });
});
