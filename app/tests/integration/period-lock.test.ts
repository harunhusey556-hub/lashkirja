import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { helsinkiMonthKey } from "@/lib/validation";
import { GET as lockState, PUT as setLock } from "@/app/api/period-lock/route";
import { POST as createInvoice } from "@/app/api/invoices/route";
import { PATCH as patchInvoice, DELETE as deleteInvoice } from "@/app/api/invoices/[id]/route";
import { POST as setStatus } from "@/app/api/invoices/[id]/status/route";
import { POST as addPayment } from "@/app/api/invoices/[id]/payments/route";
import { POST as createCustomer } from "@/app/api/customers/route";
import { POST as createPurchase } from "@/app/api/purchase-invoices/route";
import { PATCH as patchPurchase } from "@/app/api/purchase-invoices/[id]/route";
import { POST as saveReceipt } from "@/app/api/receipts/save/route";
import { DELETE as deleteReceipt } from "@/app/api/receipts/[id]/route";
import { PUT as putBalance } from "@/app/api/bank-accounts/[id]/balances/route";
import { POST as runMatch } from "@/app/api/invoices/match/route";
import {
  createBankAccountRow,
  createReceipt,
  createUpload,
  createStatementWithTransactions,
  createUser,
  resetDatabase,
  type TestUser,
} from "./helpers/factories";
import { buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";

let user: TestUser;
let cookie: string;
let customerId: string;

const LOCKED_MONTH = "2026-01";
const OPEN_MONTH = "2026-05";

async function lockThrough(month: string | null, reopen = false) {
  const response = await setLock(
    buildRequest("PUT", "/api/period-lock", reopen ? { month, reopen } : { month }, { cookie })
  );
  expect(response.status).toBe(200);
  return readJson(response);
}

async function makeInvoice(issueDate: string) {
  const response = await createInvoice(
    buildRequest(
      "POST",
      "/api/invoices",
      {
        customerId,
        issueDate,
        dueDate: issueDate,
        lines: [{ description: "Työ", quantity: 1, unitPrice: 100, vatRate: 25.5 }],
      },
      { cookie }
    )
  );
  return { status: response.status, body: await readJson(response) };
}

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
  const customer = await readJson(
    await createCustomer(buildRequest("POST", "/api/customers", { name: "Anna" }, { cookie }))
  );
  customerId = customer.customer.id;
});

describe("/api/period-lock", () => {
  it("stores and clears the watermark", async () => {
    expect(
      (await readJson(await lockState(buildRequest("GET", "/api/period-lock", undefined, { cookie }))))
        .lockedThrough
    ).toBeNull();

    expect((await lockThrough("2026-01")).lockedThrough).toBe("2026-01");
    expect((await lockThrough(null, true)).lockedThrough).toBeNull();
  });

  it("keeps later locks when an earlier month is chosen without reopening (F68)", async () => {
    await lockThrough("2026-09");
    const refused = await setLock(buildRequest("PUT", "/api/period-lock", { month: "2026-06" }, { cookie }));
    expect(refused.status).toBe(409);
    expect((await readJson(refused)).error.code).toBe("PERIOD_REOPEN_REQUIRED");
    const cleared = await setLock(buildRequest("PUT", "/api/period-lock", { month: null }, { cookie }));
    expect(cleared.status).toBe(409);
    expect(
      (await readJson(await lockState(buildRequest("GET", "/api/period-lock", undefined, { cookie }))))
        .lockedThrough
    ).toBe("2026-09");
  });

  it("reopens months on an explicit choice and leaves an audit trail (F68)", async () => {
    await lockThrough("2026-08");
    expect((await lockThrough("2026-06", true)).lockedThrough).toBe("2026-06");
    await lockThrough("2026-07");
    await lockThrough(null, true);
    const events = await prisma.automationEvent.findMany({
      where: { userId: user.id, kind: "lock" },
      orderBy: { createdAt: "asc" },
    });
    expect(events.map((event) => [event.previousValue, event.newValue, event.reason])).toEqual([
      [null, "2026-08", "käyttäjä lukitsi kauden"],
      ["2026-08", "2026-06", "käyttäjä avasi kaudet"],
      ["2026-06", "2026-07", "käyttäjä lukitsi kauden"],
      ["2026-07", null, "käyttäjä avasi kaudet"],
    ]);
  });

  it("refuses the running month, like the Kuukausi page (F69)", async () => {
    const running = helsinkiMonthKey(new Date());
    const response = await setLock(buildRequest("PUT", "/api/period-lock", { month: running }, { cookie }));
    expect(response.status).toBe(400);
    expect((await readJson(response)).error.message).toContain("kesken");
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.booksLockedThrough).toBeNull();
  });

  it("refuses a future month and a malformed one", async () => {
    const future = await setLock(
      buildRequest("PUT", "/api/period-lock", { month: "2999-01" }, { cookie })
    );
    expect(future.status).toBe(400);

    const malformed = await setLock(
      buildRequest("PUT", "/api/period-lock", { month: "2026-13" }, { cookie })
    );
    expect(malformed.status).toBe(400);
  });

  it("requires a session and blocks cross-site changes", async () => {
    expect((await lockState(buildRequest("GET", "/api/period-lock"))).status).toBe(401);
    expect(
      (
        await setLock(
          buildRequest("PUT", "/api/period-lock", { month: "2026-01" }, {
            cookie,
            secFetchSite: "cross-site",
          })
        )
      ).status
    ).toBe(403);
  });
});

describe("a closed period refuses changes", () => {
  beforeEach(async () => {
    await lockThrough(LOCKED_MONTH);
  });

  it("blocks a sales invoice dated inside it, and allows a later one", async () => {
    const blocked = await makeInvoice("2026-01-20");
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("PERIOD_LOCKED");
    expect(blocked.body.error.message).toContain("tammikuu 2026");
    expect(blocked.body.error.message).toContain("Suljetut kaudet");

    const allowed = await makeInvoice("2026-05-20");
    expect(allowed.status).toBe(201);
  });

  it("blocks editing, status changes and deletion of an invoice inside it", async () => {
    const open = await makeInvoice("2026-05-20");
    const invoiceId = open.body.invoice.id;
    // Close the period the invoice sits in, after the fact.
    await lockThrough("2026-05");

    const patched = await patchInvoice(
      buildRequest(
        "PATCH",
        `/api/invoices/${invoiceId}`,
        {
          notes: "muutos",
          expectedUpdatedAt: (
            await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoiceId } })
          ).updatedAt.toISOString(),
        },
        { cookie }
      ),
      routeContext({ id: invoiceId })
    );
    expect(patched.status).toBe(409);

    const status = await setStatus(
      buildRequest("POST", `/api/invoices/${invoiceId}/status`, { status: "sent" }, { cookie }),
      routeContext({ id: invoiceId })
    );
    expect(status.status).toBe(409);

    const deleted = await deleteInvoice(
      buildRequest("DELETE", `/api/invoices/${invoiceId}`, undefined, { cookie }),
      routeContext({ id: invoiceId })
    );
    expect(deleted.status).toBe(409);
    expect(await prisma.salesInvoice.count()).toBe(1);
  });

  it("blocks a payment dated inside it but allows one dated after it", async () => {
    const created = await makeInvoice("2026-05-20");
    const invoiceId = created.body.invoice.id;
    await setStatus(
      buildRequest("POST", `/api/invoices/${invoiceId}/status`, { status: "sent" }, { cookie }),
      routeContext({ id: invoiceId })
    );

    const blocked = await addPayment(
      buildRequest(
        "POST",
        `/api/invoices/${invoiceId}/payments`,
        { amount: 10, paidDate: "2026-01-05" },
        { cookie }
      ),
      routeContext({ id: invoiceId })
    );
    expect(blocked.status).toBe(409);

    const allowed = await addPayment(
      buildRequest(
        "POST",
        `/api/invoices/${invoiceId}/payments`,
        { amount: 10, paidDate: "2026-05-25" },
        { cookie }
      ),
      routeContext({ id: invoiceId })
    );
    expect(allowed.status).toBe(201);
  });

  it("blocks a purchase invoice and its later edit", async () => {
    const blocked = await createPurchase(
      buildRequest(
        "POST",
        "/api/purchase-invoices",
        {
          supplierName: "Tukku",
          issueDate: "2026-01-10",
          dueDate: "2026-01-24",
          gross: 124,
          vat: 24,
        },
        { cookie }
      )
    );
    expect(blocked.status).toBe(409);

    const open = await readJson(
      await createPurchase(
        buildRequest(
          "POST",
          "/api/purchase-invoices",
          {
            supplierName: "Tukku",
            issueDate: "2026-05-10",
            dueDate: "2026-05-24",
            gross: 124,
            vat: 24,
          },
          { cookie }
        )
      )
    );
    await lockThrough("2026-05");
    const patched = await patchPurchase(
      buildRequest(
        "PATCH",
        `/api/purchase-invoices/${open.invoice.id}`,
        { gross: 200 },
        { cookie }
      ),
      routeContext({ id: open.invoice.id })
    );
    expect(patched.status).toBe(409);
  });

  it("blocks a receipt dated inside it and its deletion", async () => {
    const upload = await createUpload(user.id);
    const response = await saveReceipt(
      buildRequest(
        "POST",
        "/api/receipts/save",
        { uploadId: upload.id, vendor: "Tukku", date: "2026-01-10", totalAmount: 50 },
        { cookie }
      )
    );
    expect(response.status).toBe(409);
    expect((await readJson(response)).error.code).toBe("PERIOD_LOCKED");

    const existing = await createReceipt(user.id, { date: "2026-01-10" });
    const deleted = await deleteReceipt(
      buildRequest("DELETE", `/api/receipts/${existing.id}`, undefined, { cookie }),
      routeContext({ id: existing.id })
    );
    expect(deleted.status).toBe(409);
    expect(await prisma.receipt.count()).toBe(1);
  });

  it("blocks a month-end balance inside it", async () => {
    const account = await createBankAccountRow(user.id, { openingDate: "2026-01-01" });
    const blocked = await putBalance(
      buildRequest(
        "PUT",
        `/api/bank-accounts/${account.id}/balances`,
        { month: "2026-01", closingBalance: 100 },
        { cookie }
      ),
      routeContext({ id: account.id })
    );
    expect(blocked.status).toBe(409);

    const allowed = await putBalance(
      buildRequest(
        "PUT",
        `/api/bank-accounts/${account.id}/balances`,
        { month: OPEN_MONTH, closingBalance: 100 },
        { cookie }
      ),
      routeContext({ id: account.id })
    );
    expect(allowed.status).toBe(200);
  });

  it("skips a locked reference match instead of failing the whole run", async () => {
    // Invoice in an open month, bank row dated inside the closed one.
    const created = await makeInvoice("2026-05-20");
    const invoiceId = created.body.invoice.id;
    await setStatus(
      buildRequest("POST", `/api/invoices/${invoiceId}/status`, { status: "sent" }, { cookie }),
      routeContext({ id: invoiceId })
    );
    const invoice = await prisma.salesInvoice.findUnique({ where: { id: invoiceId } });

    await createStatementWithTransactions(user.id, { transactions: [] });
    await prisma.statement.create({
      data: {
        userId: user.id,
        fileName: "tiliote.csv",
        fileType: "csv",
        filePath: "/tmp/lock.csv",
        periodMonth: "2026-01",
        transactions: {
          create: [
            {
              date: new Date("2026-01-20T00:00:00Z"),
              amountCents: 125_50,
              reference: invoice!.reference,
              type: "tulo",
            },
          ],
        },
      },
    });

    const result = await readJson(
      await runMatch(buildRequest("POST", "/api/invoices/match", undefined, { cookie }))
    );
    expect(result.applied).toHaveLength(0);
    expect(result.skippedLocked).toHaveLength(1);
    expect(result.skippedLocked[0].invoiceId).toBe(invoiceId);
    expect(await prisma.invoicePayment.count()).toBe(0);
  });

  it("lets everything through again once the books are reopened", async () => {
    expect((await makeInvoice("2026-01-20")).status).toBe(409);
    await lockThrough(null, true);
    expect((await makeInvoice("2026-01-20")).status).toBe(201);
  });

  it("does not leak one user's lock onto another", async () => {
    const other = await createUser();
    const otherCookie = await sessionCookie(other);
    const otherCustomer = await readJson(
      await createCustomer(
        buildRequest("POST", "/api/customers", { name: "Toinen" }, { cookie: otherCookie })
      )
    );

    const response = await createInvoice(
      buildRequest(
        "POST",
        "/api/invoices",
        {
          customerId: otherCustomer.customer.id,
          issueDate: "2026-01-20",
          dueDate: "2026-01-20",
          lines: [{ description: "Työ", quantity: 1, unitPrice: 10, vatRate: 25.5 }],
        },
        { cookie: otherCookie }
      )
    );
    expect(response.status).toBe(201);
  });
});
