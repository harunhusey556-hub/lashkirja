import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { createCustomer } from "@/lib/customers";
import { encrypt } from "@/lib/encryption";
import { sendInvoiceByEmail } from "@/lib/invoice-mail";
import { createInvoice, updateInvoice } from "@/lib/sales-invoices";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";

process.env.MAIL_TRANSPORT = "json";

let user: TestUser;
let invoiceId: string;
let updatedAt: string;

const MINUTE = 60 * 1000;

const delivered = async () => ({
  messageId: "msg-retry",
  from: "liisa@example.fi",
  to: "anna@example.fi",
  accepted: ["anna@example.fi"],
});

/** What a server restart in the middle of a send leaves behind. */
async function leaveAttempt(status: string, ageMs: number) {
  const at = new Date(Date.now() - ageMs);
  await prisma.invoiceEmailSend.create({
    data: { invoiceId, toAddress: "anna@example.fi", subject: "Lasku 1", status, createdAt: at },
  });
  await prisma.salesInvoice.update({
    where: { id: invoiceId },
    data: { sendLockToken: "dead-process", sendLockAt: at },
  });
}

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  await prisma.user.update({ where: { id: user.id }, data: { invoiceIban: "FI2112345600000785" } });
  await prisma.imapAccount.create({
    data: {
      userId: user.id,
      email: "liisa@example.fi",
      host: "imap.example.test",
      port: 993,
      encryptedPass: encrypt("secret"),
    },
  });
  const customer = await createCustomer(user.id, { name: "Anna", email: "anna@example.fi" });
  const invoice = await createInvoice(user.id, {
    customerId: customer.id,
    issueDate: "2026-01-15",
    lines: [{ description: "Työ", quantity: 1, unitPrice: 50, vatRate: 25.5 }],
  });
  invoiceId = invoice.id;
  updatedAt = invoice.updatedAt;
});

describe("a send that was left in 'sending' by a crash", () => {
  it("can be retried once the attempt is a few minutes old", async () => {
    await leaveAttempt("sending", 15 * MINUTE);

    const result = await sendInvoiceByEmail(user.id, invoiceId, {}, { deliver: delivered });
    expect(result.recorded).toBe(true);

    const attempts = await prisma.invoiceEmailSend.findMany({
      where: { invoiceId },
      orderBy: { createdAt: "asc" },
    });
    expect(attempts.map((attempt) => attempt.status)).toEqual(["failed", "sent"]);
    expect(attempts[0].error).toMatch(/keskeytyi/);
    const stored = await prisma.salesInvoice.findUnique({ where: { id: invoiceId } });
    expect(stored?.status).toBe("sent");
    expect(stored?.sendLockToken).toBeNull();
  });

  it("still blocks a second send while the attempt could be running", async () => {
    await leaveAttempt("sending", 1 * MINUTE);

    await expect(
      sendInvoiceByEmail(user.id, invoiceId, {}, {
        deliver: async () => {
          throw new Error("must not send again");
        },
      })
    ).rejects.toMatchObject({ code: "SEND_IN_PROGRESS", statusCode: 409 });
  });

  it("never treats a send the mail server accepted as a crash leftover", async () => {
    await leaveAttempt("ambiguous", 60 * MINUTE);

    await expect(
      sendInvoiceByEmail(user.id, invoiceId, {}, {
        deliver: async () => {
          throw new Error("must not send again");
        },
      })
    ).rejects.toMatchObject({ code: "SEND_AMBIGUOUS", statusCode: 409 });
  });

  it("lets the invoice be edited again once the dead send's lock is old", async () => {
    await leaveAttempt("sending", 15 * MINUTE);
    const stored = await prisma.salesInvoice.findUnique({ where: { id: invoiceId } });

    await expect(
      updateInvoice(user.id, invoiceId, {
        expectedUpdatedAt: stored?.updatedAt.toISOString() ?? updatedAt,
        notes: "Korjattu",
      })
    ).resolves.toBeTruthy();
  });

  it("keeps refusing an edit while the lock is fresh", async () => {
    await leaveAttempt("sending", 1 * MINUTE);
    const stored = await prisma.salesInvoice.findUnique({ where: { id: invoiceId } });

    await expect(
      updateInvoice(user.id, invoiceId, {
        expectedUpdatedAt: stored?.updatedAt.toISOString() ?? updatedAt,
        notes: "Korjattu",
      })
    ).rejects.toMatchObject({ code: "SEND_IN_PROGRESS" });
  });
});
