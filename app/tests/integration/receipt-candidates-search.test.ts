import { beforeEach, describe, expect, it } from "vitest";
import { GET as getReceipt } from "@/app/api/receipts/[id]/route";
import { createReceipt, createStatementWithTransactions, createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";

/**
 * 2026-10-08: "ABC Prisma Kotka" 9,43 € and the bank row "KSO ABC Sahkonlataus" 9,43 € a day
 * later. Too weak a name for an automatic suggestion, but the receipt screen, where the owner
 * picks by hand, must still list the row.
 */

let user: TestUser;
let cookie: string;

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

describe("GET /api/receipts/[id] match candidates", () => {
  it("lists a same-amount bank row with a different name, without suggesting it", async () => {
    const receipt = await createReceipt(user.id, {
      date: "2026-08-12",
      totalAmountCents: 943,
      vendor: "ABC Prisma Kotka",
      reviewStatus: "approved",
      vatDetails: '[{"rate":25.5,"amount":1.91}]',
    });
    const statement = await createStatementWithTransactions(user.id, {
      periodMonth: "2026-08",
      transactions: [
        { date: "2026-08-13", amountCents: -943, counterparty: "KSO ABC Sahkonlataus" },
        { date: "2026-08-13", amountCents: -2_500, counterparty: "Neste" },
      ],
    });
    const response = await getReceipt(
      buildRequest("GET", `/api/receipts/${receipt.id}`, undefined, { cookie }),
      routeContext({ id: receipt.id })
    );
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.receipt.match.suggestedTransaction).toBeNull();
    const ids = body.receipt.match.matchCandidates.map((candidate: { id: string }) => candidate.id);
    expect(ids[0]).toBe(statement.transactions.find((tx) => tx.amountCents === -943)!.id);
    expect(ids).not.toContain(statement.transactions.find((tx) => tx.amountCents === -2_500)!.id);
  });
});
