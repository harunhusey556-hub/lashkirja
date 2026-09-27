import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/encryption";
import { EnableBankingError, type EnableBankingClient } from "@/lib/enablebanking/client";
import { syncBankConnection } from "@/lib/enablebanking/sync";
import { statementTargetMonth } from "@/lib/report-calendar";
import { writePrivateUpload } from "@/lib/storage";
import { readStoredZip } from "@/lib/zip-store";
import { GET as alvReport } from "@/app/api/alv/route";
import { GET as dashboard } from "@/app/api/dashboard/route";
import { GET as exportPackage } from "@/app/api/export/package/route";
import { POST as createCustomer } from "@/app/api/customers/route";
import { GET as listInvoices, POST as createInvoice } from "@/app/api/invoices/route";
import { POST as setStatus } from "@/app/api/invoices/[id]/status/route";
import { POST as creditInvoice } from "@/app/api/invoices/[id]/credit/route";
import { GET as profitLoss } from "@/app/api/reports/profit-loss/route";
import { GET as precheck } from "@/app/api/period-lock/precheck/route";
import { PUT as setLock } from "@/app/api/period-lock/route";
import {
  createReceipt,
  createStatementWithTransactions,
  createUser,
  resetDatabase,
  type TestUser,
} from "./helpers/factories";
import { buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";

let user: TestUser;
let cookie: string;

const VAT_255 = JSON.stringify([{ rate: 25.5, amount: 25.5 }]);

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

describe("partial bank sync", () => {
  it("returns a row for the account that succeeded and the one that failed", async () => {
    const connection = await prisma.bankConnection.create({
      data: {
        userId: user.id,
        aspspName: "Testipankki",
        aspspCountry: "FI",
        psuType: "business",
        status: "active",
        sessionIdEnc: encrypt("session-1"),
        validUntil: new Date("2027-01-01T00:00:00.000Z"),
        accounts: {
          create: [
            {
              userId: user.id,
              iban: "FI2112345600000785",
              label: "Käyttötili",
              providerAccountUid: "ok",
              inScope: true,
            },
            {
              userId: user.id,
              iban: "FI2112345600000786",
              label: "Säästötili",
              providerAccountUid: "fail",
              inScope: true,
            },
          ],
        },
      },
      include: { accounts: true },
    });

    const client = {
      getSession: async () => ({ status: "AUTHORIZED" }),
      getAccountTransactions: async (query: { accountUid: string }) => {
        if (query.accountUid === "fail") {
          throw new EnableBankingError("Tilin tapahtumien haku epäonnistui.", 400, "ASPSP_ERROR");
        }
        return {
          transactions: [
            {
              status: "BOOK",
              booking_date: "2026-03-31",
              credit_debit_indicator: "CRDT",
              transaction_amount: { currency: "EUR", amount: "10.00" },
              entry_reference: "ok-1",
              debtor: { name: "Maksaja" },
            },
          ],
          continuationKey: null,
        };
      },
      getAccountBalances: async () => [],
    } as unknown as EnableBankingClient;

    const result = await syncBankConnection(user.id, connection.id, { attended: false, client });
    expect(result.imported).toBe(1);
    expect(result.accounts).toHaveLength(2);
    const ok = result.accounts.find((account) => account.ok);
    const failed = result.accounts.find((account) => !account.ok);
    expect(ok?.imported).toBe(1);
    expect(ok?.name).toContain("Käyttötili");
    expect(failed?.error).toBe("Tilin tapahtumien haku epäonnistui.");
    expect(failed?.name).toContain("Säästötili");

    const statement = await prisma.statement.findFirst({ where: { userId: user.id } });
    expect(statement?.periodMonth).toBe(statementTargetMonth("2026-03-31"));
    const stored = await prisma.bankConnection.findUnique({ where: { id: connection.id } });
    expect(stored?.status).toBe("active");
    expect(stored?.lastError).toBe("Tilin tapahtumien haku epäonnistui.");
    expect(stored?.lastSuccessAt).toBeNull();
  });
});

describe("period close precheck", () => {
  it("lists missing documents, suggested matches, and draft invoices before lock", async () => {
    const statement = await createStatementWithTransactions(user.id, {
      periodMonth: "2026-02",
      transactions: [
        { date: "2026-02-02", amountCents: -1500, counterparty: "Puuttuva Oy" },
        { date: "2026-02-03", amountCents: -2500, counterparty: "Ehdotus Oy" },
      ],
    });
    await prisma.transaction.update({
      where: { id: statement.transactions[1].id },
      data: { matchStatus: "suggested" },
    });
    await createReceipt(user.id, {
      date: "2026-02-10",
      reviewStatus: "pending",
      vendor: "Avoin kuitti",
    });
    const customer = await createCustomer(
      buildRequest("POST", "/api/customers", { name: "Luonnosasiakas" }, { cookie })
    );
    const customerId = (await readJson(customer)).customer.id as string;
    const draft = await createInvoice(
      buildRequest(
        "POST",
        "/api/invoices",
        {
          customerId,
          issueDate: "2026-02-12",
          lines: [{ description: "Luonnos", quantity: 1, unitPrice: 40, vatRate: 25.5 }],
        },
        { cookie }
      )
    );
    expect(draft.status).toBe(201);

    const response = await precheck(
      buildRequest("GET", "/api/period-lock/precheck?month=2026-02", undefined, { cookie })
    );
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.missingDocuments.map((item: { title: string }) => item.title)).toEqual(
      expect.arrayContaining(["Puuttuva Oy", "Avoin kuitti"])
    );
    expect(body.unmatchedTransactions.map((item: { title: string }) => item.title)).toEqual(["Ehdotus Oy"]);
    expect(body.draftInvoices).toHaveLength(1);
    expect(body.draftInvoices[0].title).toBe("Luonnosasiakas");

    const locked = await setLock(
      buildRequest("PUT", "/api/period-lock", { month: "2026-02" }, { cookie })
    );
    expect(locked.status).toBe(200);
  });
});

describe("cross-report reconciliation", () => {
  it("keeps dashboard, ALV, P&L, and invoice totals on their own bases", async () => {
    await createReceipt(user.id, {
      type: "tulo",
      date: "2026-03-31",
      totalAmountCents: 12_550,
      category: "myynti",
      vatDetails: VAT_255,
    });
    await createReceipt(user.id, {
      type: "meno",
      date: "2026-03-02",
      totalAmountCents: 12_550,
      category: "tarvikkeet",
      vatDetails: VAT_255,
    });
    await createReceipt(user.id, {
      type: "tulo",
      date: "2026-04-01",
      totalAmountCents: 99_900,
      vatDetails: VAT_255,
    });
    await createStatementWithTransactions(user.id, {
      periodMonth: statementTargetMonth("2026-03-31"),
      transactions: [{ date: "2026-03-20", amountCents: 10_000, counterparty: "Pankki" }],
    });

    const customer = await createCustomer(
      buildRequest("POST", "/api/customers", { name: "Anna Asiakas" }, { cookie })
    );
    const customerId = (await readJson(customer)).customer.id as string;

    async function invoice(issueDate: string, unitPrice: number) {
      const response = await createInvoice(
        buildRequest(
          "POST",
          "/api/invoices",
          {
            customerId,
            issueDate,
            lines: [{ description: "Työ", quantity: 1, unitPrice, vatRate: 25.5 }],
          },
          { cookie }
        )
      );
      expect(response.status).toBe(201);
      return (await readJson(response)).invoice as { id: string; gross: number };
    }

    const sent = await invoice("2026-03-10", 100);
    await setStatus(
      buildRequest("POST", `/api/invoices/${sent.id}/status`, { status: "sent" }, { cookie }),
      routeContext({ id: sent.id })
    );
    const draft = await invoice("2026-03-11", 40);
    const credited = await invoice("2026-03-12", 80);
    await setStatus(
      buildRequest("POST", `/api/invoices/${credited.id}/status`, { status: "sent" }, { cookie }),
      routeContext({ id: credited.id })
    );
    const credit = await creditInvoice(
      buildRequest("POST", `/api/invoices/${credited.id}/credit`, undefined, { cookie }),
      routeContext({ id: credited.id })
    );
    expect(credit.status).toBe(201);

    const pl = await readJson(
      await profitLoss(
        buildRequest("GET", "/api/reports/profit-loss?from=2026-03&to=2026-03", undefined, { cookie })
      )
    );
    // P&L is approved receipts only. The sent invoice is not income here.
    expect(pl.total.incomeGross).toBe(125.5);
    expect(pl.total.incomeNet).toBe(100);
    expect(pl.total.expenseNet).toBe(100);
    expect(pl.total.receiptCount).toBe(2);

    const alv = await readJson(
      await alvReport(buildRequest("GET", "/api/alv?period=2026-03", undefined, { cookie }))
    );
    // Receipt VAT 25.50 + sent invoice VAT 25.50. Draft and the credited invoice stay out.
    expect(alv.field301.vat).toBe(51);
    expect(alv.field307.amount).toBe(25.5);
    expect(alv.creditedInvoiceCount).toBe(1);
    expect(alv.sources.invoiceCount).toBe(1);

    const front = await readJson(
      await dashboard(buildRequest("GET", "/api/dashboard?month=2026-03", undefined, { cookie }))
    );
    // Cash view follows the statement target month, not the receipt gross.
    expect(front.source).toBe("tiliote");
    expect(front.income).toBe(100);
    expect(front.income).not.toBe(pl.total.incomeGross);
    const april = await readJson(
      await dashboard(buildRequest("GET", "/api/dashboard?month=2026-04", undefined, { cookie }))
    );
    expect(april.source).toBe("kuitit");
    expect(april.income).toBe(999);

    const sentList = await readJson(
      await listInvoices(
        buildRequest("GET", "/api/invoices?month=2026-03&status=sent", undefined, { cookie })
      )
    );
    const sentGross = (sentList.invoices as Array<{ gross: number; documentKind: string }>)
      .filter((row) => row.documentKind === "invoice")
      .reduce((sum, row) => sum + row.gross, 0);
    expect(sentGross).toBe(sent.gross);
    const draftList = await readJson(
      await listInvoices(
        buildRequest("GET", "/api/invoices?month=2026-03&status=draft", undefined, { cookie })
      )
    );
    expect(draftList.invoices).toHaveLength(1);
    expect(draftList.invoices[0].gross).toBe(draft.gross);
    expect(draft.gross).not.toBe(sent.gross);
  });
});

describe("period export package", () => {
  it("zips the reports, match metadata, and a stored document", async () => {
    const upload = await writePrivateUpload(user.id, ".pdf", Buffer.from("%PDF-1.4\n"));
    await createReceipt(user.id, {
      type: "tulo",
      date: "2026-03-05",
      vendor: "Paketti Oy",
      totalAmountCents: 12_550,
      vatDetails: VAT_255,
    });
    await prisma.receipt.updateMany({
      where: { userId: user.id, vendor: "Paketti Oy" },
      data: { filePath: upload.storageKey, fileName: "kuitti.pdf" },
    });
    await createStatementWithTransactions(user.id, {
      periodMonth: "2026-03",
      transactions: [{ date: "2026-03-05", amountCents: 12_550, counterparty: "Paketti Oy" }],
    });

    const response = await exportPackage(
      buildRequest("GET", "/api/export/package?month=2026-03", undefined, { cookie })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/zip");
    const files = readStoredZip(Buffer.from(await response.arrayBuffer()));
    expect(files.get("lue-minut.txt")?.toString("utf8")).toContain("Tuloslaskelma");
    expect(files.get("lue-minut.txt")?.toString("utf8")).toContain("ALV");
    const alv = JSON.parse(files.get("raportit/alv.json")!.toString("utf8"));
    expect(alv.month).toBe("2026-03");
    expect(alv.field301.vat).toBe(25.5);
    expect(files.get("csv/kuitit.csv")?.toString("utf8")).toContain("Paketti Oy");
    const matches = JSON.parse(files.get("taydennys/kohdistukset.json")!.toString("utf8"));
    expect(matches.transactions).toHaveLength(1);
    expect(matches.transactions[0].counterparty).toBe("Paketti Oy");
    expect(files.get("tositteet/kuitti.pdf")?.subarray(0, 5).toString("utf8")).toBe("%PDF-");
    const joined = [...files.keys()].join("\n");
    expect(joined).not.toContain("session");
    expect(joined).not.toContain(".env");
  });
});
