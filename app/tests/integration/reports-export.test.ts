import { beforeEach, describe, expect, it } from "vitest";
import { GET as profitLoss } from "@/app/api/reports/profit-loss/route";
import { GET as exportCsv } from "@/app/api/export/route";
import { POST as createCustomer } from "@/app/api/customers/route";
import { POST as createInvoice } from "@/app/api/invoices/route";
import {
  createBankAccountRow,
  createReceipt,
  createStatementWithTransactions,
  createUser,
  resetDatabase,
  type TestUser,
} from "./helpers/factories";
import { buildRequest, readJson, sessionCookie } from "./helpers/http";

let user: TestUser;
let cookie: string;
let otherUser: TestUser;

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
  otherUser = await createUser();
});

describe("GET /api/reports/profit-loss", () => {
  it("nets VAT out of income and expenses over the requested range", async () => {
    await createReceipt(user.id, {
      type: "tulo",
      date: "2026-01-10",
      totalAmountCents: 125_50,
      category: "myynti",
      vatDetails: JSON.stringify([{ rate: 25.5, amount: 25.5 }]),
    });
    await createReceipt(user.id, {
      type: "meno",
      date: "2026-02-10",
      totalAmountCents: 62_75,
      category: "tarvikkeet",
      vatDetails: JSON.stringify([{ rate: 25.5, amount: 12.75 }]),
    });

    const body = await readJson(
      await profitLoss(
        buildRequest("GET", "/api/reports/profit-loss?from=2026-01&to=2026-12", undefined, {
          cookie,
        })
      )
    );

    expect(body.total).toMatchObject({
      incomeNet: 100,
      expenseNet: 50,
      profitNet: 50,
      receiptCount: 2,
    });
    expect(body.months.map((month: { month: string }) => month.month)).toEqual([
      "2026-01",
      "2026-02",
    ]);
  });

  it("leaves receipts outside the range out of the report", async () => {
    await createReceipt(user.id, { date: "2025-12-31", totalAmountCents: 999_00 });
    await createReceipt(user.id, { date: "2026-01-01", totalAmountCents: 100_00 });

    const body = await readJson(
      await profitLoss(
        buildRequest("GET", "/api/reports/profit-loss?from=2026-01&to=2026-01", undefined, {
          cookie,
        })
      )
    );
    expect(body.total.receiptCount).toBe(1);
    expect(body.total.expenseGross).toBe(100);
  });

  it("counts only approved receipts, so drafts cannot move the result", async () => {
    await createReceipt(user.id, { date: "2026-01-05", totalAmountCents: 100_00 });
    await createReceipt(user.id, {
      date: "2026-01-06",
      totalAmountCents: 500_00,
      reviewStatus: "pending",
    });

    const body = await readJson(
      await profitLoss(
        buildRequest("GET", "/api/reports/profit-loss?from=2026-01&to=2026-01", undefined, {
          cookie,
        })
      )
    );
    expect(body.total.receiptCount).toBe(1);
  });

  it("flags receipts with no VAT breakdown instead of guessing a rate", async () => {
    await createReceipt(user.id, {
      date: "2026-01-05",
      totalAmountCents: 100_00,
      vatDetails: null,
    });
    const body = await readJson(
      await profitLoss(
        buildRequest("GET", "/api/reports/profit-loss?from=2026-01&to=2026-01", undefined, {
          cookie,
        })
      )
    );
    expect(body.total.missingVatCount).toBe(1);
    expect(body.total.expenseNet).toBe(100);
  });

  it("never mixes in another user's receipts", async () => {
    await createReceipt(otherUser.id, { date: "2026-01-05", totalAmountCents: 900_00 });
    const body = await readJson(
      await profitLoss(
        buildRequest("GET", "/api/reports/profit-loss?from=2026-01&to=2026-01", undefined, {
          cookie,
        })
      )
    );
    expect(body.total.receiptCount).toBe(0);
  });

  it("rejects a malformed or reversed range", async () => {
    expect(
      (
        await profitLoss(
          buildRequest("GET", "/api/reports/profit-loss?from=2026-13", undefined, { cookie })
        )
      ).status
    ).toBe(400);
    expect(
      (
        await profitLoss(
          buildRequest("GET", "/api/reports/profit-loss?from=2026-06&to=2026-01", undefined, {
            cookie,
          })
        )
      ).status
    ).toBe(400);
  });

  it("requires a session", async () => {
    expect(
      (await profitLoss(buildRequest("GET", "/api/reports/profit-loss"))).status
    ).toBe(401);
  });
});

describe("GET /api/export", () => {
  async function csv(url: string): Promise<string> {
    const response = await exportCsv(buildRequest("GET", url, undefined, { cookie }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    // Response.text() decodes UTF-8 and drops the BOM, so read the bytes when
    // the BOM itself is what matters.
    return response.text();
  }

  async function csvBytes(url: string): Promise<Buffer> {
    const response = await exportCsv(buildRequest("GET", url, undefined, { cookie }));
    return Buffer.from(await response.arrayBuffer());
  }

  it("exports receipts with a BOM, semicolons and comma decimals", async () => {
    await createReceipt(user.id, {
      date: "2026-01-15",
      totalAmountCents: 125_50,
      vendor: "Tukku Oy",
    });

    const bytes = await csvBytes("/api/export?type=receipts");
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // Excel needs the BOM

    const text = await csv("/api/export?type=receipts");
    const [header, row] = text.trim().split("\r\n");
    expect(header.split(";")[0]).toBe("Päivä");
    expect(row).toContain("2026-01-15");
    expect(row).toContain("125,50");
  });

  it("filters by month", async () => {
    await createReceipt(user.id, { date: "2026-01-15", totalAmountCents: 100_00 });
    await createReceipt(user.id, { date: "2026-02-15", totalAmountCents: 200_00 });

    const january = await csv("/api/export?type=receipts&month=2026-01");
    expect(january.trim().split("\r\n")).toHaveLength(2); // header + one row
  });

  it("names the bank account on each transaction row", async () => {
    const account = await createBankAccountRow(user.id, { name: "Nordea käyttötili" });
    await createStatementWithTransactions(user.id, {
      bankAccountId: account.id,
      transactions: [{ date: "2026-01-10", amountCents: -4_050, counterparty: "Kauppa" }],
    });

    const text = await csv("/api/export?type=transactions");
    expect(text).toContain("Nordea käyttötili");
    expect(text).toContain("-40,50");
  });

  it("exports invoices with their derived status", async () => {
    const customer = (
      await readJson(
        await createCustomer(
          buildRequest("POST", "/api/customers", { name: "Anna Asiakas" }, { cookie })
        )
      )
    ).customer;
    await createInvoice(
      buildRequest(
        "POST",
        "/api/invoices",
        {
          customerId: customer.id,
          issueDate: "2026-01-10",
          lines: [{ description: "Työ", quantity: 1, unitPrice: 100, vatRate: 25.5 }],
        },
        { cookie }
      )
    );

    const text = await csv("/api/export?type=invoices");
    expect(text).toContain("Anna Asiakas");
    expect(text).toContain("125,50");
    expect(text).toContain("draft");
  });

  it("quotes a customer name containing the separator so columns cannot shift", async () => {
    await createCustomer(
      buildRequest("POST", "/api/customers", { name: "Kauneus; Oy" }, { cookie })
    );
    const text = await csv("/api/export?type=customers");
    expect(text).toContain('"Kauneus; Oy"');
    expect(text.trim().split("\r\n")).toHaveLength(2);
  });

  it("never exports another user's rows", async () => {
    await createReceipt(otherUser.id, { date: "2026-01-15", vendor: "Salainen Oy" });
    const text = await csv("/api/export?type=receipts");
    expect(text).not.toContain("Salainen Oy");
    expect(text.trim().split("\r\n")).toHaveLength(1); // header only
  });

  it("rejects an unknown export type and requires a session", async () => {
    expect(
      (await exportCsv(buildRequest("GET", "/api/export?type=nonsense", undefined, { cookie })))
        .status
    ).toBe(400);
    expect((await exportCsv(buildRequest("GET", "/api/export"))).status).toBe(401);
  });
});
