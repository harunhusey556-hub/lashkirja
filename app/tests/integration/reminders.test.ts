import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import {
  GET as reminderPreview,
  POST as sendReminder,
} from "@/app/api/invoices/[id]/reminders/route";
import { GET as reminderPdf } from "@/app/api/invoices/[id]/reminders/pdf/route";
import { GET as overdueList } from "@/app/api/invoices/overdue/route";
import { POST as createInvoice } from "@/app/api/invoices/route";
import { POST as createCustomer } from "@/app/api/customers/route";
import { POST as setStatus } from "@/app/api/invoices/[id]/status/route";
import { POST as addPayment } from "@/app/api/invoices/[id]/payments/route";
import { encrypt } from "@/lib/encryption";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, routeContext, sessionCookie, type JsonValue } from "./helpers/http";

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

let user: TestUser;
let cookie: string;
let otherUser: TestUser;
let otherCookie: string;
let customerId: string;

process.env.MAIL_TRANSPORT = "json";

/** Far in the past, so "overdue" does not depend on when the suite runs. */
const OLD_ISSUE = "2026-01-01";
const OLD_DUE = "2026-01-15";

async function makeCustomer(overrides: Record<string, unknown> = {}, auth = cookie) {
  const response = await createCustomer(
    buildRequest(
      "POST",
      "/api/customers",
      { name: "Anna Asiakas", email: "anna@example.fi", ...overrides },
      { cookie: auth }
    )
  );
  return (await readJson(response)).customer;
}

async function makeSentInvoice(overrides: Record<string, unknown> = {}, auth = cookie) {
  const created = await readJson(
    await createInvoice(
      buildRequest(
        "POST",
        "/api/invoices",
        {
          customerId,
          issueDate: OLD_ISSUE,
          dueDate: OLD_DUE,
          lines: [{ description: "Ripsienpidennys", quantity: 1, unitPrice: 100, vatRate: 25.5 }],
          ...overrides,
        },
        { cookie: auth }
      )
    )
  );
  const invoice = created.invoice;
  await setStatus(
    buildRequest("POST", `/api/invoices/${invoice.id}/status`, { status: "sent" }, { cookie: auth }),
    routeContext({ id: invoice.id })
  );
  return invoice;
}

async function connectMailAccount(userId: string) {
  return prisma.imapAccount.create({
    data: {
      userId,
      email: "liisa@example.fi",
      host: "imap.gmail.com",
      port: 993,
      encryptedPass: encrypt("app-password"),
    },
  });
}

beforeEach(async () => {
  mail.sent = 0;
  mail.failNext = false;
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
  otherUser = await createUser();
  otherCookie = await sessionCookie(otherUser);
  customerId = (await makeCustomer()).id;
  await connectMailAccount(user.id);
});

describe("GET /api/invoices/[id]/reminders - preview", () => {
  it("adds the reminder fee and, when configured, late interest", async () => {
    await prisma.user.update({
      where: { id: user.id },
      data: { lateInterestPercent: 11.5, reminderFeeCents: 500 },
    });
    const invoice = await makeSentInvoice();

    const body = await readJson(
      await reminderPreview(
        buildRequest("GET", `/api/invoices/${invoice.id}/reminders`, undefined, { cookie }),
        routeContext({ id: invoice.id })
      )
    );

    expect(body.reminder.level).toBe(1);
    expect(body.reminder.open).toBe(125.5);
    expect(body.reminder.fee).toBe(5);
    expect(body.reminder.daysLate).toBeGreaterThan(100);
    expect(body.reminder.interest).toBeGreaterThan(0);
    expect(body.reminder.total).toBeCloseTo(
      body.reminder.open + body.reminder.interest + body.reminder.fee,
      2
    );
    expect(body.reminder.recipient).toBe("anna@example.fi");
  });

  it("charges no interest until a rate is configured", async () => {
    const invoice = await makeSentInvoice();
    const body = await readJson(
      await reminderPreview(
        buildRequest("GET", `/api/invoices/${invoice.id}/reminders`, undefined, { cookie }),
        routeContext({ id: invoice.id })
      )
    );
    expect(body.reminder.interest).toBe(0);
    expect(body.reminder.total).toBe(130.5); // 125,50 + 5,00 fee
  });

  it("counts only the still-open amount after a partial payment", async () => {
    const invoice = await makeSentInvoice();
    await addPayment(
      buildRequest(
        "POST",
        `/api/invoices/${invoice.id}/payments`,
        { amount: 25.5, paidDate: "2026-02-01" },
        { cookie }
      ),
      routeContext({ id: invoice.id })
    );

    const body = await readJson(
      await reminderPreview(
        buildRequest("GET", `/api/invoices/${invoice.id}/reminders`, undefined, { cookie }),
        routeContext({ id: invoice.id })
      )
    );
    expect(body.reminder.open).toBe(100);
  });

  it("refuses a draft, a paid and a not-yet-due invoice", async () => {
    const draft = await readJson(
      await createInvoice(
        buildRequest(
          "POST",
          "/api/invoices",
          {
            customerId,
            issueDate: OLD_ISSUE,
            dueDate: OLD_DUE,
            lines: [{ description: "Työ", quantity: 1, unitPrice: 10, vatRate: 25.5 }],
          },
          { cookie }
        )
      )
    );
    const draftResponse = await reminderPreview(
      buildRequest("GET", `/api/invoices/${draft.invoice.id}/reminders`, undefined, { cookie }),
      routeContext({ id: draft.invoice.id })
    );
    expect(draftResponse.status).toBe(409);
    expect((await readJson(draftResponse)).error.code).toBe("INVOICE_NOT_OPEN");

    const paid = await makeSentInvoice();
    await addPayment(
      buildRequest(
        "POST",
        `/api/invoices/${paid.id}/payments`,
        { amount: 125.5, paidDate: "2026-02-01" },
        { cookie }
      ),
      routeContext({ id: paid.id })
    );
    const paidResponse = await reminderPreview(
      buildRequest("GET", `/api/invoices/${paid.id}/reminders`, undefined, { cookie }),
      routeContext({ id: paid.id })
    );
    expect(paidResponse.status).toBe(409);

    const future = await makeSentInvoice({ issueDate: "2026-01-01", dueDate: "2999-01-01" });
    const futureResponse = await reminderPreview(
      buildRequest("GET", `/api/invoices/${future.id}/reminders`, undefined, { cookie }),
      routeContext({ id: future.id })
    );
    expect(futureResponse.status).toBe(409);
    expect((await readJson(futureResponse)).error.code).toBe("INVOICE_NOT_OVERDUE");
  });

  it("404s on another user's invoice", async () => {
    const invoice = await makeSentInvoice();
    expect(
      (
        await reminderPreview(
          buildRequest("GET", `/api/invoices/${invoice.id}/reminders`, undefined, {
            cookie: otherCookie,
          }),
          routeContext({ id: invoice.id })
        )
      ).status
    ).toBe(404);
  });
});

describe("GET /api/invoices/[id]/reminders/pdf", () => {
  it("renders a reminder that names the original invoice and the new total", async () => {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        businessName: "Liisan Ripsistudio",
        invoiceIban: "FI2112345600000785",
        lateInterestPercent: 11.5,
      },
    });
    const invoice = await makeSentInvoice();

    const response = await reminderPdf(
      buildRequest("GET", `/api/invoices/${invoice.id}/reminders/pdf`, undefined, { cookie }),
      routeContext({ id: invoice.id })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toContain("muistutus-0001.pdf");

    const bytes = Buffer.from(await response.arrayBuffer());
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(bytes) });
    const text = (await parser.getText()).text.replace(/\s+/g, " ");
    await parser.destroy();

    expect(text).toContain("MAKSUMUISTUTUS");
    expect(text).toContain("Liisan Ripsistudio");
    expect(text).toContain("Anna Asiakas");
    expect(text).toContain("Viivästyskorko");
    expect(text).toContain("Muistutusmaksu");
    expect(text).toContain("Maksettava yhteensä");
    // The original reference is repeated so a payment still reconciles.
    expect(text.replace(/\s/g, "")).toContain(invoice.reference);
  });
});

describe("POST /api/invoices/[id]/reminders", () => {
  it("emails the reminder and stores what was demanded", async () => {
    await prisma.user.update({
      where: { id: user.id },
      data: { lateInterestPercent: 11.5, reminderFeeCents: 500 },
    });
    const invoice = await makeSentInvoice();

    const response = await sendReminder(
      buildRequest("POST", `/api/invoices/${invoice.id}/reminders`, {}, { cookie }),
      routeContext({ id: invoice.id })
    );
    expect(response.status).toBe(201);

    const body = await readJson(response);
    expect(body.sentTo).toBe("anna@example.fi");
    expect(body.reminder.level).toBe(1);

    const stored = await prisma.invoiceReminder.findMany({ where: { invoiceId: invoice.id } });
    expect(stored).toHaveLength(1);
    expect(stored[0].openCents).toBe(12_550);
    expect(stored[0].feeCents).toBe(500);
    expect(stored[0].interestCents).toBeGreaterThan(0);
    expect(stored[0].totalCents).toBe(
      stored[0].openCents + stored[0].feeCents + stored[0].interestCents
    );
    expect(stored[0].sentTo).toBe("anna@example.fi");
  });

  it("numbers a second reminder and keeps the first one intact", async () => {
    const invoice = await makeSentInvoice();
    await sendReminder(
      buildRequest("POST", `/api/invoices/${invoice.id}/reminders`, {}, { cookie }),
      routeContext({ id: invoice.id })
    );
    // The first one has run its course: its own 7 day term and the cooldown are over.
    await prisma.invoiceReminder.updateMany({
      where: { invoiceId: invoice.id },
      data: {
        sentAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
        dueDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
      },
    });
    const second = await readJson(
      await sendReminder(
        buildRequest("POST", `/api/invoices/${invoice.id}/reminders`, {}, { cookie }),
        routeContext({ id: invoice.id })
      )
    );
    expect(second.reminder.level).toBe(2);
    expect(await prisma.invoiceReminder.count({ where: { invoiceId: invoice.id } })).toBe(2);
  });

  it("sends exactly one mail and stores one reminder when three calls arrive together", async () => {
    const invoice = await makeSentInvoice();
    const post = () =>
      sendReminder(
        buildRequest("POST", `/api/invoices/${invoice.id}/reminders`, {}, { cookie }),
        routeContext({ id: invoice.id })
      );

    const responses = await Promise.all([post(), post(), post()]);
    const statuses = responses.map((response) => response.status).sort();

    expect(statuses).toEqual([201, 409, 409]);
    expect(mail.sent).toBe(1);
    const stored = await prisma.invoiceReminder.findMany({ where: { invoiceId: invoice.id } });
    expect(stored).toHaveLength(1);
    expect(stored[0].level).toBe(1);
  });

  it("refuses an immediate repeat and says when the next reminder may go out", async () => {
    const invoice = await makeSentInvoice();
    const post = () =>
      sendReminder(
        buildRequest("POST", `/api/invoices/${invoice.id}/reminders`, {}, { cookie }),
        routeContext({ id: invoice.id })
      );

    expect((await post()).status).toBe(201);
    const repeat = await post();
    expect(repeat.status).toBe(409);
    const error = (await readJson(repeat)).error;
    expect(error.code).toBe("REMINDER_TOO_SOON");
    // The first reminder gives the customer 7 days: the message names the end
    // of that term and the day a new reminder may go, not a 24 hour window.
    expect(error.message).toMatch(
      /^Edellisessä muistutuksessa asiakkaalla on maksuaikaa \d+\.\d+\.\d{4} asti\. Uuden muistutuksen voi lähettää \d+\.\d+\.\d{4} alkaen\.$/
    );
    expect(mail.sent).toBe(1);
    expect(await prisma.invoiceReminder.count({ where: { invoiceId: invoice.id } })).toBe(1);
  });

  it("V34: refuses a second reminder 25 hours later while the first one's 7 day term still runs", async () => {
    const invoice = await makeSentInvoice();
    const post = () =>
      sendReminder(
        buildRequest("POST", `/api/invoices/${invoice.id}/reminders`, {}, { cookie }),
        routeContext({ id: invoice.id })
      );
    expect((await post()).status).toBe(201);
    await prisma.invoiceReminder.updateMany({
      where: { invoiceId: invoice.id },
      data: { sentAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });

    const again = await post();
    expect(again.status).toBe(409);
    expect((await readJson(again)).error.code).toBe("REMINDER_TOO_SOON");
    expect(mail.sent).toBe(1);
    expect(await prisma.invoiceReminder.count({ where: { invoiceId: invoice.id } })).toBe(1);
  });

  it("V35: the preview says a new reminder is not possible yet, and when it is", async () => {
    const invoice = await makeSentInvoice();
    const fresh = await readJson(
      await reminderPreview(
        buildRequest("GET", `/api/invoices/${invoice.id}/reminders`, undefined, { cookie }),
        routeContext({ id: invoice.id })
      )
    );
    expect(fresh.reminder.nextReminderAt).toBeNull();

    await sendReminder(
      buildRequest("POST", `/api/invoices/${invoice.id}/reminders`, {}, { cookie }),
      routeContext({ id: invoice.id })
    );
    const waiting = await readJson(
      await reminderPreview(
        buildRequest("GET", `/api/invoices/${invoice.id}/reminders`, undefined, { cookie }),
        routeContext({ id: invoice.id })
      )
    );
    const stored = await prisma.invoiceReminder.findFirstOrThrow({ where: { invoiceId: invoice.id } });
    expect(new Date(waiting.reminder.nextReminderAt).getTime()).toBeGreaterThan(stored.dueDate.getTime());
    expect(waiting.reminder.nextReminderNote).toMatch(/maksuaikaa .* asti/);

    // The same fact on the Laskut list and the overdue work list.
    const overdue = await readJson(
      await overdueList(buildRequest("GET", "/api/invoices/overdue", undefined, { cookie }))
    );
    expect(overdue.invoices[0].nextReminderAt).toBe(waiting.reminder.nextReminderAt);
  });

  it("frees the slot again when the mail could not be sent", async () => {
    const invoice = await makeSentInvoice();
    const post = () =>
      sendReminder(
        buildRequest("POST", `/api/invoices/${invoice.id}/reminders`, {}, { cookie }),
        routeContext({ id: invoice.id })
      );

    mail.failNext = true;
    expect((await post()).status).toBeGreaterThanOrEqual(500);
    expect(await prisma.invoiceReminder.count({ where: { invoiceId: invoice.id } })).toBe(0);

    const retry = await post();
    expect(retry.status).toBe(201);
    expect((await readJson(retry)).reminder.level).toBe(1);
    expect(mail.sent).toBe(1);
  });

  it("does not let a reservation that never went out block the next reminder for long", async () => {
    const invoice = await makeSentInvoice();
    // Left behind by a process that died before it could send.
    await prisma.invoiceReminder.create({
      data: {
        invoiceId: invoice.id,
        level: 1,
        sentTo: null,
        sentAt: new Date(Date.now() - 30 * 60 * 1000),
        dueDate: new Date("2026-02-01T00:00:00.000Z"),
        openCents: 12_550,
        interestCents: 0,
        feeCents: 500,
        totalCents: 13_050,
        daysLate: 10,
      },
    });
    const response = await sendReminder(
      buildRequest("POST", `/api/invoices/${invoice.id}/reminders`, {}, { cookie }),
      routeContext({ id: invoice.id })
    );
    expect(response.status).toBe(201);
    expect((await readJson(response)).reminder.level).toBe(1);
    expect(await prisma.invoiceReminder.count({ where: { invoiceId: invoice.id } })).toBe(1);
  });

  it("does not record a reminder when there is no mail account", async () => {
    await prisma.imapAccount.deleteMany({ where: { userId: user.id } });
    const invoice = await makeSentInvoice();

    const response = await sendReminder(
      buildRequest("POST", `/api/invoices/${invoice.id}/reminders`, {}, { cookie }),
      routeContext({ id: invoice.id })
    );
    expect(response.status).toBe(409);
    expect((await readJson(response)).error.code).toBe("NO_MAIL_ACCOUNT");
    expect(await prisma.invoiceReminder.count()).toBe(0);
  });

  it("does not record a reminder when there is nowhere to send it", async () => {
    const anonymous = await makeCustomer({ name: "Ei sähköpostia", email: "" });
    const invoice = await makeSentInvoice({ customerId: anonymous.id });

    const response = await sendReminder(
      buildRequest("POST", `/api/invoices/${invoice.id}/reminders`, {}, { cookie }),
      routeContext({ id: invoice.id })
    );
    expect(response.status).toBe(400);
    expect(await prisma.invoiceReminder.count()).toBe(0);
  });

  it("accepts an explicit recipient and blocks cross-site sends", async () => {
    const invoice = await makeSentInvoice();
    const body = await readJson(
      await sendReminder(
        buildRequest(
          "POST",
          `/api/invoices/${invoice.id}/reminders`,
          { to: "perinta@example.fi" },
          { cookie }
        ),
        routeContext({ id: invoice.id })
      )
    );
    expect(body.sentTo).toBe("perinta@example.fi");

    expect(
      (
        await sendReminder(
          buildRequest("POST", `/api/invoices/${invoice.id}/reminders`, {}, {
            cookie,
            secFetchSite: "cross-site",
          }),
          routeContext({ id: invoice.id })
        )
      ).status
    ).toBe(403);
  });

  it("refuses to remind about an invoice that was paid in the meantime", async () => {
    const invoice = await makeSentInvoice();
    await addPayment(
      buildRequest(
        "POST",
        `/api/invoices/${invoice.id}/payments`,
        { amount: 125.5, paidDate: "2026-02-01" },
        { cookie }
      ),
      routeContext({ id: invoice.id })
    );

    const response = await sendReminder(
      buildRequest("POST", `/api/invoices/${invoice.id}/reminders`, {}, { cookie }),
      routeContext({ id: invoice.id })
    );
    expect(response.status).toBe(409);
    expect(await prisma.invoiceReminder.count()).toBe(0);
  });
});

describe("GET /api/invoices/overdue", () => {
  it("lists overdue unpaid invoices worst first, with reminder history", async () => {
    const older = await makeSentInvoice({ issueDate: "2026-01-01", dueDate: "2026-01-10" });
    await makeSentInvoice({ issueDate: "2026-02-01", dueDate: "2026-02-10" });
    await makeSentInvoice({ issueDate: "2026-01-01", dueDate: "2999-01-01" }); // not due
    await sendReminder(
      buildRequest("POST", `/api/invoices/${older.id}/reminders`, {}, { cookie }),
      routeContext({ id: older.id })
    );

    const body = await readJson(
      await overdueList(buildRequest("GET", "/api/invoices/overdue", undefined, { cookie }))
    );
    expect(body.invoices).toHaveLength(2);
    expect(body.invoices[0].invoiceId).toBe(older.id);
    expect(body.invoices[0].daysLate).toBeGreaterThan(body.invoices[1].daysLate);
    expect(body.invoices[0].reminderCount).toBe(1);
    expect(body.invoices[0].lastReminderAt).not.toBeNull();
    expect(body.invoices[1].reminderCount).toBe(0);
  });

  it("drops an invoice once it is settled and never shows another user's", async () => {
    const invoice = await makeSentInvoice();
    await addPayment(
      buildRequest(
        "POST",
        `/api/invoices/${invoice.id}/payments`,
        { amount: 125.5, paidDate: "2026-02-01" },
        { cookie }
      ),
      routeContext({ id: invoice.id })
    );

    const body = await readJson(
      await overdueList(buildRequest("GET", "/api/invoices/overdue", undefined, { cookie }))
    );
    expect(body.invoices).toEqual([]);

    const foreign = await readJson(
      await overdueList(
        buildRequest("GET", "/api/invoices/overdue", undefined, { cookie: otherCookie })
      )
    );
    expect(foreign.invoices.map((i: JsonValue) => i.invoiceId)).toEqual([]);
  });

  it("requires a session", async () => {
    expect((await overdueList(buildRequest("GET", "/api/invoices/overdue"))).status).toBe(401);
  });
});
