import { beforeEach, describe, expect, it } from "vitest";
import { GET as listReceipts } from "@/app/api/receipts/route";
import { prisma } from "@/lib/db";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, sessionCookie } from "./helpers/http";

let user: TestUser;
let cookie: string;

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

describe("receipt pagination", () => {
  it("returns the total and a second page past the 200-row cap", async () => {
    await prisma.receipt.createMany({
      data: Array.from({ length: 201 }, (_, index) => ({
        userId: user.id,
        type: "meno",
        date: new Date(Date.UTC(2020, 0, 1) + index * 86_400_000),
        totalAmountCents: 1000 + index,
        vendor: `Myyjä ${index}`,
        reviewStatus: "approved",
        filePath: `/tmp/kuitti-${index}.pdf`,
        fileName: "kuitti.pdf",
      })),
    });

    const first = await listReceipts(buildRequest("GET", "/api/receipts", undefined, { cookie }));
    expect(first.status).toBe(200);
    const firstBody = await readJson(first);
    expect(firstBody.count).toBe(201);
    expect(firstBody.receipts).toHaveLength(200);
    expect(firstBody.truncated).toBe(true);
    expect(firstBody.receipts.some((row: { vendor: string }) => row.vendor === "Myyjä 0")).toBe(false);

    const second = await listReceipts(
      buildRequest("GET", "/api/receipts?offset=200", undefined, { cookie })
    );
    const secondBody = await readJson(second);
    expect(secondBody.count).toBe(201);
    expect(secondBody.receipts).toHaveLength(1);
    expect(secondBody.receipts[0].vendor).toBe("Myyjä 0");
    expect(secondBody.truncated).toBe(false);
  });

  it("rejects an offset that is not a page index", async () => {
    const response = await listReceipts(
      buildRequest("GET", "/api/receipts?offset=-1", undefined, { cookie })
    );
    expect(response.status).toBe(400);
  });
});
