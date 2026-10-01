import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { GET as previewSend, POST as sendInvoice } from "@/app/api/invoices/[id]/send/route";
import { GET as previewReminder } from "@/app/api/invoices/[id]/reminders/route";
import { POST as createInvoice } from "@/app/api/invoices/route";
import { POST as createCustomer } from "@/app/api/customers/route";
import { POST as setStatus } from "@/app/api/invoices/[id]/status/route";
import { PUT as setLock } from "@/app/api/period-lock/route";
import { encrypt } from "@/lib/encryption";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";

let user: TestUser;
let cookie: string;
let customerId: string;

process.env.MAIL_TRANSPORT = "json";

async function makeInvoice(issueDate = "2026-01-15") {
  const response = await createInvoice(
    buildRequest(
      "POST",
      "/api/invoices",
      {
        customerId,
        issueDate,
        dueDate: issueDate,
        lines: [{ description: "Ripsienpidennys", quantity: 1, unitPrice: 100, vatRate: 25.5 }],
      },
      { cookie }
    )
  );
  expect(response.status).toBe(201);
  return (await readJson(response)).invoice;
}

async function connectMail() {
  await prisma.imapAccount.create({
    data: {
      userId: user.id,
      email: "liisa@example.fi",
      host: "imap.gmail.com",
      port: 993,
      encryptedPass: encrypt("app-password"),
    },
  });
}

async function preview(id: string) {
  return (
    await readJson(
      await previewSend(
        buildRequest("GET", `/api/invoices/${id}/send`, undefined, { cookie }),
        routeContext({ id })
      )
    )
  ).preview;
}

function post(id: string, key?: string, body: Record<string, unknown> = {}) {
  return sendInvoice(
    buildRequest("POST", `/api/invoices/${id}/send`, body, {
      cookie,
      ...(key ? { headers: { "Idempotency-Key": key } } : {}),
    }),
    routeContext({ id })
  );
}

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  await prisma.user.update({ where: { id: user.id }, data: { invoiceIban: "FI2112345600000785" } });
  cookie = await sessionCookie(user);
  const response = await createCustomer(
    buildRequest("POST", "/api/customers", { name: "Anna Asiakas", email: "anna@example.fi" }, { cookie })
  );
  customerId = (await readJson(response)).customer.id;
});

describe("the send sheet knows before the tap (F41, G09)", () => {
  it("says that no mailbox is connected, in the preview", async () => {
    const invoice = await makeInvoice();
    const result = await preview(invoice.id);
    expect(result.mailboxMissing).toBe(true);
    expect(result.blockedReason).toBe("Sähköpostitiliä ei ole yhdistetty.");
  });

  it("is ready once a mailbox is connected", async () => {
    await connectMail();
    const invoice = await makeInvoice();
    const result = await preview(invoice.id);
    expect(result.mailboxMissing).toBe(false);
    expect(result.blockedReason).toBeNull();
  });

  it("names a closed month in Finnish words, not as an ISO key", async () => {
    await connectMail();
    const invoice = await makeInvoice("2026-08-12");
    await setLock(buildRequest("PUT", "/api/period-lock", { month: "2026-08" }, { cookie }));
    const result = await preview(invoice.id);
    expect(result.lockedMonth).toBe("2026-08");
    expect(result.blockedReason).toBe("Kausi elokuu 2026 on suljettu.");
    expect(result.blockedReason).not.toContain("2026-08");
  });

  it("keeps the other reasons first: a missing recipient is named before the mailbox", async () => {
    const noEmail = await createCustomer(
      buildRequest("POST", "/api/customers", { name: "Ei Sähköpostia" }, { cookie })
    );
    customerId = (await readJson(noEmail)).customer.id;
    const invoice = await makeInvoice();
    const result = await preview(invoice.id);
    expect(result.blockedReason).toBe("Vastaanottaja puuttuu.");
    expect(result.mailboxMissing).toBe(true);
  });

  it("the reminder preview says it too", async () => {
    const invoice = await makeInvoice("2026-01-15");
    await setStatus(
      buildRequest("POST", `/api/invoices/${invoice.id}/status`, { status: "sent" }, { cookie }),
      routeContext({ id: invoice.id })
    );
    const noMailbox = await readJson(
      await previewReminder(
        buildRequest("GET", `/api/invoices/${invoice.id}/reminders`, undefined, { cookie }),
        routeContext({ id: invoice.id })
      )
    );
    expect(noMailbox.reminder.mailboxMissing).toBe(true);
    await connectMail();
    const withMailbox = await readJson(
      await previewReminder(
        buildRequest("GET", `/api/invoices/${invoice.id}/reminders`, undefined, { cookie }),
        routeContext({ id: invoice.id })
      )
    );
    expect(withMailbox.reminder.mailboxMissing).toBe(false);
  });

  it("a locked month's real refusal also names the month in Finnish", async () => {
    await connectMail();
    const invoice = await makeInvoice("2026-08-12");
    await setLock(buildRequest("PUT", "/api/period-lock", { month: "2026-08" }, { cookie }));
    const response = await post(invoice.id);
    expect(response.status).toBe(409);
    const body = await readJson(response);
    expect(JSON.stringify(body)).toContain("elokuu 2026");
    expect(JSON.stringify(body)).not.toContain("2026-08 ");
  });
});

describe("a send whose answer was lost does not go out twice (G04)", () => {
  async function sentRows(id: string) {
    return prisma.invoiceEmailSend.count({ where: { invoiceId: id, status: "sent" } });
  }

  it("the retry with the same key gets the first answer and sends nothing more", async () => {
    await connectMail();
    const invoice = await makeInvoice();
    const first = await post(invoice.id, "send-key-1");
    expect(first.status).toBe(200);
    expect((await readJson(first)).replayed).toBeUndefined();
    expect(await sentRows(invoice.id)).toBe(1);

    // The client never saw the answer and taps again with the same key.
    const retry = await post(invoice.id, "send-key-1");
    expect(retry.status).toBe(200);
    const retryBody = await readJson(retry);
    expect(retryBody.replayed).toBe(true);
    expect(retryBody.ok).toBe(true);
    expect(await sentRows(invoice.id)).toBe(1);
  });

  it("a new key is a deliberate second send", async () => {
    await connectMail();
    const invoice = await makeInvoice();
    expect((await post(invoice.id, "send-key-a")).status).toBe(200);
    expect((await post(invoice.id, "send-key-b")).status).toBe(200);
    expect(await sentRows(invoice.id)).toBe(2);
  });

  it("a send that failed can be retried with the same key", async () => {
    const invoice = await makeInvoice();
    const refused = await post(invoice.id, "send-key-c");
    expect(refused.status).toBe(409);
    await connectMail();
    const retry = await post(invoice.id, "send-key-c");
    expect(retry.status).toBe(200);
    expect(await sentRows(invoice.id)).toBe(1);
  });

  it("a key used with another body is refused", async () => {
    await connectMail();
    const invoice = await makeInvoice();
    expect((await post(invoice.id, "send-key-d", { subject: "Yksi" })).status).toBe(200);
    const other = await post(invoice.id, "send-key-d", { subject: "Kaksi" });
    expect(other.status).toBe(409);
    expect(await sentRows(invoice.id)).toBe(1);
  });

  it("without a key the old behaviour stays", async () => {
    await connectMail();
    const invoice = await makeInvoice();
    expect((await post(invoice.id)).status).toBe(200);
    expect((await post(invoice.id)).status).toBe(200);
    expect(await sentRows(invoice.id)).toBe(2);
  });
});
