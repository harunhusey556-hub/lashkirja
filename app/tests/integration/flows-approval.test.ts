import { beforeEach, describe, expect, it } from "vitest";
import { PATCH as review } from "@/app/api/receipts/[id]/review/route";
import { POST as batchApprove } from "@/app/api/receipts/batch-approve/route";
import { prisma } from "@/lib/db";
import { resetRateLimitsForTests } from "@/lib/rate-limit";
import { createReceipt, createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";

/**
 * TF-02 (P0) / FP-6: approval of a receipt with no amount is refused by the
 * server on every path, so no client (old IPA, Koti pill, Kuitit batch) can
 * book a 0,00 € receipt into the VAT return.
 */

let user: TestUser;
let cookie: string;

beforeEach(async () => {
  resetRateLimitsForTests();
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

function approve(id: string) {
  return review(
    buildRequest("PATCH", `/api/receipts/${id}/review`, { reviewStatus: "approved" }, { cookie }),
    routeContext({ id })
  );
}

describe("PATCH /api/receipts/[id]/review", () => {
  it("refuses to approve a pending receipt with a null total and leaves it pending", async () => {
    const receipt = await createReceipt(user.id, {
      reviewStatus: "pending",
      totalAmountCents: null,
      date: "2026-09-20",
    });

    const response = await approve(receipt.id);
    expect(response.status).toBe(422);
    const body = await readJson(response);
    expect(body.error.code).toBe("RECEIPT_INCOMPLETE");
    expect(body.error.message).toMatch(/summa/);

    const after = await prisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(after.reviewStatus).toBe("pending");
  });

  it("approves the same receipt once the amount is filled in", async () => {
    const receipt = await createReceipt(user.id, {
      reviewStatus: "pending",
      totalAmountCents: null,
      date: "2026-09-20",
    });
    await prisma.receipt.update({ where: { id: receipt.id }, data: { totalAmountCents: 1_990 } });

    const response = await approve(receipt.id);
    expect(response.status).toBe(200);
    const after = await prisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(after.reviewStatus).toBe("approved");
  });

  it("still allows rejecting a receipt with no amount", async () => {
    const receipt = await createReceipt(user.id, { reviewStatus: "pending", totalAmountCents: null });
    const response = await review(
      buildRequest("PATCH", `/api/receipts/${receipt.id}/review`, { reviewStatus: "rejected" }, { cookie }),
      routeContext({ id: receipt.id })
    );
    expect(response.status).toBe(200);
  });

  it("refuses to approve a receipt dated in a closed month", async () => {
    const receipt = await createReceipt(user.id, { reviewStatus: "pending", date: "2026-07-10" });
    await prisma.user.update({ where: { id: user.id }, data: { booksLockedThrough: "2026-07" } });

    const response = await approve(receipt.id);
    expect(response.status).toBe(409);
    const after = await prisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(after.reviewStatus).toBe("pending");
  });
});

describe("POST /api/receipts/batch-approve", () => {
  it("approves the complete receipts and reports the one without an amount as failed", async () => {
    const complete = await createReceipt(user.id, { reviewStatus: "pending", date: "2026-09-02" });
    const noTotal = await createReceipt(user.id, {
      reviewStatus: "pending",
      totalAmountCents: null,
      date: "2026-09-03",
    });

    const response = await batchApprove(
      buildRequest(
        "POST",
        "/api/receipts/batch-approve",
        { receiptIds: [complete.id, noTotal.id] },
        { cookie }
      )
    );
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.succeeded).toEqual([complete.id]);
    expect(body.failed).toEqual([{ id: noTotal.id, error: expect.stringMatching(/summa/) }]);

    const after = await prisma.receipt.findUniqueOrThrow({ where: { id: noTotal.id } });
    expect(after.reviewStatus).toBe("pending");
  });
});
