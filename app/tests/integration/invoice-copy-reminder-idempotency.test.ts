import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { POST as createInvoice } from "@/app/api/invoices/route";
import { POST as createCustomer } from "@/app/api/customers/route";
import { POST as duplicate } from "@/app/api/invoices/[id]/duplicate/route";
import { POST as sendReminder } from "@/app/api/invoices/[id]/reminders/route";
import { POST as setStatus } from "@/app/api/invoices/[id]/status/route";
import { encrypt } from "@/lib/encryption";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";

const mail = vi.hoisted(() => ({ sent: 0, failNext: false }));

vi.mock("@/lib/mailer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mailer")>();
  return {
    ...actual,
    sendMail: async (...args: Parameters<typeof actual.sendMail>) => {
      if (mail.failNext) {
        mail.failNext = false;
        throw new Error("SMTP down");
      }
      mail.sent += 1;
      return actual.sendMail(...args);
    },
  };
});

process.env.MAIL_TRANSPORT = "json";

let user: TestUser;
let cookie: string;
let invoiceId: string;

beforeEach(async () => {
  mail.sent = 0;
  mail.failNext = false;
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
  await prisma.imapAccount.create({
    data: {
      userId: user.id,
      email: "liisa@example.fi",
      host: "imap.gmail.com",
      port: 993,
      encryptedPass: encrypt("app-password"),
    },
  });
  const customer = (
    await readJson(
      await createCustomer(
        buildRequest("POST", "/api/customers", { name: "Anna Asiakas", email: "anna@example.fi" }, { cookie })
      )
    )
  ).customer;
  const created = await readJson(
    await createInvoice(
      buildRequest(
        "POST",
        "/api/invoices",
        {
          customerId: customer.id,
          issueDate: "2026-01-01",
          dueDate: "2026-01-15",
          lines: [{ description: "Ripsienpidennys", quantity: 1, unitPrice: 100, vatRate: 25.5 }],
        },
        { cookie }
      )
    )
  );
  invoiceId = created.invoice.id;
  await setStatus(
    buildRequest("POST", `/api/invoices/${invoiceId}/status`, { status: "sent" }, { cookie }),
    routeContext({ id: invoiceId })
  );
});

const invoiceCount = () => prisma.salesInvoice.count({ where: { userId: user.id } });

function copy(key: string | null) {
  const headers: Record<string, string> = key ? { "idempotency-key": key } : {};
  return duplicate(
    buildRequest("POST", `/api/invoices/${invoiceId}/duplicate`, undefined, { cookie, headers }),
    routeContext({ id: invoiceId })
  );
}

function remind(key: string | null, body: Record<string, unknown> = {}) {
  const headers: Record<string, string> = key ? { "idempotency-key": key } : {};
  return sendReminder(
    buildRequest("POST", `/api/invoices/${invoiceId}/reminders`, body, { cookie, headers }),
    routeContext({ id: invoiceId })
  );
}

describe("POST /api/invoices/[id]/duplicate with Idempotency-Key", () => {
  it("makes one copy and replays the answer on a retry", async () => {
    const first = await copy("dup-1");
    expect(first.status).toBe(201);
    const firstBody = await readJson(first);

    const retry = await copy("dup-1");
    expect(retry.status).toBe(201);
    expect((await readJson(retry)).invoice.id).toBe(firstBody.invoice.id);
    expect(await invoiceCount()).toBe(2);
  });

  it("a new key is a deliberate second copy", async () => {
    await copy("dup-a");
    await copy("dup-b");
    expect(await invoiceCount()).toBe(3);
  });

  it("still copies without a key", async () => {
    expect((await copy(null)).status).toBe(201);
    expect((await copy(null)).status).toBe(201);
    expect(await invoiceCount()).toBe(3);
  });

  it("releases the key when the copy fails, so the retry can run", async () => {
    const missing = await duplicate(
      buildRequest("POST", "/api/invoices/nope/duplicate", undefined, {
        cookie,
        headers: { "idempotency-key": "dup-x" },
      }),
      routeContext({ id: "nope" })
    );
    expect(missing.status).toBe(404);
    expect(await prisma.idempotencyRecord.count({ where: { key: "dup-x" } })).toBe(0);
  });
});

describe("POST /api/invoices/[id]/reminders with Idempotency-Key", () => {
  it("mails once and replays the answer instead of hitting the cooldown", async () => {
    const first = await remind("rem-1");
    expect(first.status).toBe(201);
    const firstBody = await readJson(first);

    const retry = await remind("rem-1");
    expect(retry.status).toBe(201);
    const retryBody = await readJson(retry);
    expect(retryBody.reminder.id).toBe(firstBody.reminder.id);
    expect(retryBody.replayed).toBe(true);
    expect(mail.sent).toBe(1);
  });

  it("refuses the same key with a different message", async () => {
    await remind("rem-2", { message: "Hei" });
    const other = await remind("rem-2", { message: "Eri teksti" });
    expect(other.status).toBe(409);
    expect(mail.sent).toBe(1);
  });

  it("releases the key when the mail fails, so the retry sends", async () => {
    mail.failNext = true;
    const failed = await remind("rem-3");
    expect(failed.status).toBeGreaterThanOrEqual(400);
    expect(mail.sent).toBe(0);

    const retry = await remind("rem-3");
    expect(retry.status).toBe(201);
    expect(mail.sent).toBe(1);
  });

  it("without a key the cooldown still refuses a repeat", async () => {
    expect((await remind(null)).status).toBe(201);
    expect((await remind(null)).status).toBeGreaterThanOrEqual(400);
    expect(mail.sent).toBe(1);
  });
});
