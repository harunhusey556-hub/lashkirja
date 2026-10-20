import { beforeEach, describe, expect, it } from "vitest";
import { GET as profitLoss } from "@/app/api/reports/profit-loss/route";
import { GET as listReceipts } from "@/app/api/receipts/route";
import { GET as receiptCounts } from "@/app/api/receipts/counts/route";
import { syncReceiptDocumentKind } from "@/lib/purchase-invoices";
import { createReceipt, createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, sessionCookie } from "./helpers/http";

/**
 * X079 (B8): the list behind a report figure holds the rows the figure is made of. The profit and
 * loss counts a bill filed as an ostolasku among the expenses; the phone's drill therefore asks
 * GET /api/receipts with the figure's period and type and no `kind` (ReceiptListQuery.drill), for
 * the rows and the chip counts alike. Kuitit's own `kind=receipt` leaves the bill to its Laskut
 * chip, which is how Raportit's Menot read 35 while its list said 34 kuittia.
 */

let user: TestUser;
let cookie: string;

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

async function expenseCount(from: string, to: string): Promise<number> {
  const body = await readJson<{ total: { expenseByCategory: Array<{ count: number }> } }>(
    await profitLoss(buildRequest("GET", `/api/reports/profit-loss?from=${from}&to=${to}`, undefined, { cookie }))
  );
  return body.total.expenseByCategory.reduce((sum, row) => sum + row.count, 0);
}

/** The first page as the phone asks it (ReceiptListPaging.firstQuery), with the page's total. */
async function listTotal(params: string): Promise<{ total: number; ids: string[] }> {
  const response = await listReceipts(
    buildRequest("GET", `/api/receipts?${params}&sort=date_desc&cursor=&limit=50`, undefined, { cookie })
  );
  expect(response.status).toBe(200);
  const body = await readJson<{ receipts: Array<{ id: string }>; total: number }>(response);
  return { total: body.total, ids: body.receipts.map((receipt) => receipt.id) };
}

async function counts(params: string) {
  const body = await readJson<{ counts: { all: number; meno: number; laskut: number } }>(
    await receiptCounts(buildRequest("GET", `/api/receipts/counts?${params}`, undefined, { cookie }))
  );
  return body.counts;
}

describe("a report figure's list (X079)", () => {
  it("lists every document the Menot figure counts, the filed bill too", async () => {
    const kuitti = await createReceipt(user.id, { vendor: "Tukku Oy", date: "2026-09-05", category: "tarvikkeet" });
    const bill = await createReceipt(user.id, {
      vendor: "Kiinteistö Oy Kauppakatu 1",
      date: "2026-09-10",
      totalAmountCents: 31_000,
      category: "vuokra",
      vatDetails: JSON.stringify([{ rate: 25.5, amount: 62.99 }]),
    });
    expect((await syncReceiptDocumentKind(user.id, bill.id, "invoice")).action).toBe("filed");
    // Another month's expense stays out of the month's figure and its list.
    await createReceipt(user.id, { date: "2026-08-20" });

    const monthFigure = await expenseCount("2026-09", "2026-09");
    expect(monthFigure).toBe(2);

    // The drill's own query: period and type, no kind.
    const drilled = await listTotal("month=2026-09&type=meno");
    expect(drilled.total).toBe(monthFigure);
    expect(drilled.ids.sort()).toEqual([kuitti.id, bill.id].sort());
    expect((await counts("month=2026-09")).meno).toBe(monthFigure);

    // The year's figure and its list agree the same way.
    const yearFigure = await expenseCount("2026-01", "2026-12");
    expect(yearFigure).toBe(3);
    expect((await listTotal("month=2026&type=meno")).total).toBe(yearFigure);

    // Kuitit's own entry: the kuitit only, the bill under its Laskut chip.
    const kuitit = await listTotal("month=2026-09&type=meno&kind=receipt");
    expect(kuitit.ids).toEqual([kuitti.id]);
    expect(kuitit.total).toBe(monthFigure - 1);
    expect(await counts("month=2026-09&kind=receipt")).toMatchObject({ meno: 1, laskut: 1 });
  });
});
