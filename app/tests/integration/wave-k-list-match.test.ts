import { beforeEach, describe, expect, it } from "vitest";
import { GET as listReceipts } from "@/app/api/receipts/route";
import { GET as getReceipt } from "@/app/api/receipts/[id]/route";
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

describe("receipt list matching", () => {
  it("does not score candidates on the list and does score them on one receipt", async () => {
    const receipt = await prisma.receipt.create({
      data: {
        userId: user.id,
        type: "meno",
        vendor: "Kukka Oy",
        date: new Date("2026-03-01T00:00:00.000Z"),
        totalAmountCents: 4990,
        reviewStatus: "approved",
        filePath: "/tmp/kukka.pdf",
        fileName: "kukka.pdf",
      },
    });
    const statement = await prisma.statement.create({
      data: {
        userId: user.id,
        fileName: "tiliote.csv",
        fileType: "csv",
        filePath: "/tmp/tiliote.csv",
        checksum: "kukka-checksum",
        periodMonth: "2026-03",
      },
    });
    await prisma.transaction.create({
      data: {
        statementId: statement.id,
        userId: user.id,
        date: new Date("2026-03-01T00:00:00.000Z"),
        counterparty: "Kukka Oy",
        amountCents: -4990,
        type: "meno",
        matchStatus: "unmatched",
      },
    });

    const list = await listReceipts(buildRequest("GET", "/api/receipts", undefined, { cookie }));
    expect(list.status).toBe(200);
    const listed = await readJson(list);
    expect(listed.receipts).toHaveLength(1);
    expect(listed.receipts[0].match.matchCandidates).toEqual([]);
    expect(listed.receipts[0].match.candidatesDeferred).toBe(true);
    expect(listed.receipts[0].match.status).toBe("unlinked");

    const detail = await getReceipt(
      buildRequest("GET", `/api/receipts/${receipt.id}`, undefined, { cookie }),
      { params: Promise.resolve({ id: receipt.id }) }
    );
    expect(detail.status).toBe(200);
    const opened = await readJson(detail);
    expect(opened.receipt.match.matchCandidates.length).toBeGreaterThan(0);
    expect(opened.receipt.match.matchCandidates[0].counterparty).toBe("Kukka Oy");
  });
});
