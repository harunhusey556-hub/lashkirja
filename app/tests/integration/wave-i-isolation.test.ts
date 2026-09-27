import { beforeEach, describe, expect, it } from "vitest";
import { GET as getReceipt } from "@/app/api/receipts/[id]/route";
import { GET as getReceiptFile } from "@/app/api/receipts/[id]/file/route";
import { GET as getInvoice } from "@/app/api/invoices/[id]/route";
import { GET as getInvoicePdf } from "@/app/api/invoices/[id]/pdf/route";
import { POST as createInvoice } from "@/app/api/invoices/route";
import { POST as setStatus } from "@/app/api/invoices/[id]/status/route";
import { DELETE as deletePayment, POST as addPayment } from "@/app/api/invoices/[id]/payments/route";
import { POST as createCustomer } from "@/app/api/customers/route";
import { GET as getBankAccount } from "@/app/api/bank-accounts/[id]/route";
import { GET as getStatement } from "@/app/api/statements/[id]/route";
import { GET as getChat } from "@/app/api/ai/chat/route";
import { prisma } from "@/lib/db";
import {
  createBankAccountRow,
  createReceipt,
  createStatementWithTransactions,
  createUser,
  resetDatabase,
  type TestUser,
} from "./helpers/factories";
import { buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";

let owner: TestUser;
let ownerCookie: string;
let otherCookie: string;

beforeEach(async () => {
  await resetDatabase();
  owner = await createUser({ email: "owner-wave-i@example.com" });
  const other = await createUser({ email: "other-wave-i@example.com" });
  ownerCookie = await sessionCookie(owner);
  otherCookie = await sessionCookie(other);
});

async function expectHidden(response: Response, secret: string) {
  expect([403, 404]).toContain(response.status);
  const text = await response.text();
  expect(text).not.toContain(secret);
}

describe("wave I cross-user isolation", () => {
  it("hides another user's receipt, file, invoice, pdf, payment, bank account, statement, and chat", async () => {
    const receipt = await createReceipt(owner.id, { vendor: "Salainen Tukku" });
    await expectHidden(
      await getReceipt(
        buildRequest("GET", `/api/receipts/${receipt.id}`, undefined, { cookie: otherCookie }),
        routeContext({ id: receipt.id })
      ),
      "Salainen Tukku"
    );
    await expectHidden(
      await getReceiptFile(
        buildRequest("GET", `/api/receipts/${receipt.id}/file`, undefined, { cookie: otherCookie }),
        routeContext({ id: receipt.id })
      ),
      "Salainen Tukku"
    );

    const customer = await createCustomer(
      buildRequest("POST", "/api/customers", { name: "Anna Asiakas" }, { cookie: ownerCookie })
    );
    const customerId = (await readJson<{ customer: { id: string } }>(customer)).customer.id;
    const created = await createInvoice(
      buildRequest(
        "POST",
        "/api/invoices",
        {
          customerId,
          issueDate: "2026-01-10",
          lines: [{ description: "Salainen rivi", quantity: 1, unitPrice: 100, vatRate: 25.5 }],
        },
        { cookie: ownerCookie }
      )
    );
    expect(created.status).toBe(201);
    const invoiceId = (await readJson<{ invoice: { id: string } }>(created)).invoice.id;
    const sent = await setStatus(
      buildRequest("POST", `/api/invoices/${invoiceId}/status`, { status: "sent" }, { cookie: ownerCookie }),
      routeContext({ id: invoiceId })
    );
    expect(sent.status).toBe(200);
    const paid = await addPayment(
      buildRequest(
        "POST",
        `/api/invoices/${invoiceId}/payments`,
        { amount: 10, paidDate: "2026-01-15" },
        { cookie: ownerCookie }
      ),
      routeContext({ id: invoiceId })
    );
    expect(paid.status).toBe(201);
    const paymentId = (await readJson<{ invoice: { payments: { id: string }[] } }>(paid)).invoice.payments[0].id;

    await expectHidden(
      await getInvoice(
        buildRequest("GET", `/api/invoices/${invoiceId}`, undefined, { cookie: otherCookie }),
        routeContext({ id: invoiceId })
      ),
      "Salainen rivi"
    );
    await expectHidden(
      await getInvoicePdf(
        buildRequest("GET", `/api/invoices/${invoiceId}/pdf`, undefined, { cookie: otherCookie }),
        routeContext({ id: invoiceId })
      ),
      "Salainen rivi"
    );
    const payment = await deletePayment(
      buildRequest(
        "DELETE",
        `/api/invoices/${invoiceId}/payments?paymentId=${paymentId}`,
        undefined,
        { cookie: otherCookie }
      ),
      routeContext({ id: invoiceId })
    );
    expect([403, 404]).toContain(payment.status);
    expect(await prisma.invoicePayment.findUnique({ where: { id: paymentId } })).not.toBeNull();

    const account = await createBankAccountRow(owner.id, { name: "Salainen tili", iban: "FI2112345600000785" });
    await expectHidden(
      await getBankAccount(
        buildRequest("GET", `/api/bank-accounts/${account.id}`, undefined, { cookie: otherCookie }),
        routeContext({ id: account.id })
      ),
      "FI2112345600000785"
    );

    const statement = await createStatementWithTransactions(owner.id, {
      transactions: [{ date: "2026-01-15", amountCents: -1500, counterparty: "Salainen vastapuoli" }],
    });
    await expectHidden(
      await getStatement(
        buildRequest("GET", `/api/statements/${statement.id}`, undefined, { cookie: otherCookie }),
        routeContext({ id: statement.id })
      ),
      "Salainen vastapuoli"
    );

    const conversation = await prisma.conversation.create({
      data: { userId: owner.id, title: "Salainen keskustelu" },
    });
    await prisma.chatMessage.create({
      data: {
        userId: owner.id,
        conversationId: conversation.id,
        role: "user",
        content: "Salainen viesti",
      },
    });
    await expectHidden(
      await getChat(
        buildRequest(
          "GET",
          `/api/ai/chat?conversationId=${conversation.id}`,
          undefined,
          { cookie: otherCookie }
        )
      ),
      "Salainen viesti"
    );
  });
});
