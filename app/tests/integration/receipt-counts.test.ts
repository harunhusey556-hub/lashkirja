import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { GET as getCounts } from "@/app/api/receipts/counts/route";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, sessionCookie } from "./helpers/http";

let user: TestUser;
let cookie: string;

interface RowOverrides {
  type?: string;
  vendor?: string;
  date?: Date;
  userId?: string;
  linked?: boolean;
}

async function makeRow(overrides: RowOverrides = {}) {
  const receipt = await prisma.receipt.create({
    data: {
      userId: overrides.userId ?? user.id,
      type: overrides.type ?? "meno",
      vendor: overrides.vendor ?? "Tukku Oy",
      date: overrides.date ?? new Date("2026-01-15T00:00:00Z"),
      totalAmountCents: 1000,
      reviewStatus: "approved",
      filePath: "/tmp/kuitti.pdf",
      fileName: "kuitti.pdf",
    },
  });
  if (overrides.linked) {
    const statement = await prisma.statement.create({
      data: {
        userId: overrides.userId ?? user.id,
        fileName: "tiliote.csv",
        fileType: "csv",
        filePath: "/tmp/tiliote.csv",
        checksum: `checksum-${receipt.id}`,
        periodMonth: "2026-01",
      },
    });
    await prisma.transaction.create({
      data: {
        statementId: statement.id,
        userId: overrides.userId ?? user.id,
        date: overrides.date ?? new Date("2026-01-15T00:00:00Z"),
        amountCents: 1000,
        type: "meno",
        matchStatus: "confirmed",
        receiptId: receipt.id,
      },
    });
  }
  return receipt;
}

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

describe("GET /api/receipts/counts", () => {
  it("counts every tab from the database, not the capped list, scoped by user", async () => {
    const otherUser = await createUser();

    await makeRow({ type: "meno" });
    await makeRow({ type: "meno" });
    await makeRow({ type: "tulo" });
    await makeRow({ type: "meno", linked: true });
    await makeRow({ type: "meno", userId: otherUser.id }); // another user - must never be counted

    const response = await getCounts(buildRequest("GET", "/api/receipts/counts", undefined, { cookie }));
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.counts).toEqual({ all: 4, tulo: 1, meno: 3, linked: 1, unlinked: 3 });
  });

  it("scopes counts by the same month filter the visible list uses", async () => {
    await makeRow({ date: new Date("2026-01-05T00:00:00Z") });
    await makeRow({ date: new Date("2026-02-05T00:00:00Z") });

    const response = await getCounts(
      buildRequest("GET", "/api/receipts/counts?month=2026-01", undefined, { cookie })
    );
    const body = await readJson(response);
    expect(body.counts.all).toBe(1);
  });

  it("requires a session", async () => {
    const response = await getCounts(buildRequest("GET", "/api/receipts/counts"));
    expect(response.status).toBe(401);
  });

  it("rejects an invalid month the same way the list endpoint does", async () => {
    const response = await getCounts(
      buildRequest("GET", "/api/receipts/counts?month=not-a-month", undefined, { cookie })
    );
    expect(response.status).toBe(400);
  });
});
