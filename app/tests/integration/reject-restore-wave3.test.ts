/**
 * Wave 3, lane F2 (F38): a rejected receipt stays listed and can be put back.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { PATCH as reviewReceipt } from "@/app/api/receipts/[id]/review/route";
import { GET as listReceipts } from "@/app/api/receipts/route";
import { createReceipt, createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";

let user: TestUser;
let cookie: string;

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

async function review(id: string, reviewStatus: string) {
  return reviewReceipt(
    buildRequest("PATCH", `/api/receipts/${id}/review`, { reviewStatus }, { cookie }),
    routeContext({ id })
  );
}

async function listIds(reviewStatus: string): Promise<string[]> {
  const body = await readJson(
    await listReceipts(buildRequest("GET", `/api/receipts?reviewStatus=${reviewStatus}`, undefined, { cookie }))
  );
  return body.receipts.map((row: { id: string }) => row.id);
}

describe("reject and restore", () => {
  it("a rejected receipt is listed as rejected and can go back to the queue", async () => {
    const receipt = await createReceipt(user.id, { reviewStatus: "pending" });
    expect((await review(receipt.id, "rejected")).status).toBe(200);
    expect(await listIds("rejected")).toEqual([receipt.id]);
    expect(await listIds("pending")).toEqual([]);

    expect((await review(receipt.id, "pending")).status).toBe(200);
    expect(await listIds("pending")).toEqual([receipt.id]);
    expect(await listIds("rejected")).toEqual([]);
  });

  it("an approved receipt is not sent back to the queue by this route", async () => {
    const receipt = await createReceipt(user.id, { reviewStatus: "approved" });
    const response = await review(receipt.id, "pending");
    expect(response.status).toBe(409);
    expect((await prisma.receipt.findUnique({ where: { id: receipt.id } }))?.reviewStatus).toBe("approved");
  });
});
