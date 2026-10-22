import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { POST as createInvoice } from "@/app/api/invoices/route";
import { POST as setStatus } from "@/app/api/invoices/[id]/status/route";
import { POST as createCustomer } from "@/app/api/customers/route";
import { listOverdueInvoices, previewReminder } from "@/lib/invoice-reminders";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";

/**
 * Beta audit NICE: a reminder preview answered 409 "eräpäivä ei ole vielä mennyt"
 * until about 03:00 Helsinki time for an invoice that fell due the day before,
 * because days late were counted on the UTC day. Due dates are Helsinki calendar
 * days, so the day turns over at Helsinki midnight (22:00 UTC in winter, 21:00 in summer).
 */

let user: TestUser;
let cookie: string;
let customerId: string;

async function makeSentInvoice(dueDate: string): Promise<string> {
  const created = await createInvoice(
    buildRequest(
      "POST",
      "/api/invoices",
      {
        customerId,
        issueDate: "2026-02-01",
        dueDate,
        lines: [{ description: "Ripsienpidennys", quantity: 1, unitPrice: 100, vatRate: 0 }],
      },
      { cookie }
    )
  );
  expect(created.status).toBe(201);
  const id = (await readJson(created)).invoice.id as string;
  const sent = await setStatus(
    buildRequest("POST", `/api/invoices/${id}/status`, { status: "sent" }, { cookie }),
    routeContext({ id })
  );
  expect(sent.status).toBe(200);
  return id;
}

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
  await prisma.user.update({ where: { id: user.id }, data: { lateInterestPercent: 10 } });
  const response = await createCustomer(
    buildRequest("POST", "/api/customers", { name: "Anna Asiakas", email: "anna@example.fi" }, { cookie })
  );
  customerId = (await readJson(response)).customer.id;
});

describe("reminder preview follows the Helsinki calendar day", () => {
  it("is not overdue on the due date itself, up to the last second before Helsinki midnight", async () => {
    const id = await makeSentInvoice("2026-03-01");
    // 23:59:59 on 1.3. in Helsinki (UTC+2).
    await expect(previewReminder(user.id, id, new Date("2026-03-01T21:59:59.000Z"))).rejects.toMatchObject({
      code: "INVOICE_NOT_OVERDUE",
      statusCode: 409,
    });
  });

  it("is one day late from 00:00 Helsinki time, not from 02:00 or 03:00", async () => {
    const id = await makeSentInvoice("2026-03-01");
    // 00:00:00 and 00:30 on 2.3. in Helsinki (UTC+2); the UTC day is still 1.3.
    for (const instant of ["2026-03-01T22:00:00.000Z", "2026-03-01T22:30:00.000Z"]) {
      const preview = await previewReminder(user.id, id, new Date(instant));
      expect(preview.daysLate).toBe(1);
    }
  });

  it("does the same in summer time (UTC+3)", async () => {
    const id = await makeSentInvoice("2026-07-01");
    await expect(previewReminder(user.id, id, new Date("2026-07-01T20:59:59.000Z"))).rejects.toMatchObject({
      code: "INVOICE_NOT_OVERDUE",
    });
    const preview = await previewReminder(user.id, id, new Date("2026-07-01T21:00:00.000Z"));
    expect(preview.daysLate).toBe(1);
  });

  it("counts interest and the payment term from the same Helsinki day as the days late", async () => {
    const id = await makeSentInvoice("2026-03-01");
    const preview = await previewReminder(user.id, id, new Date("2026-03-01T22:30:00.000Z"));
    // 100,00 € at 10 % for one day is 0,03 €; seven days from 2.3. is 9.3.
    expect(preview.interest).toBe(0.03);
    expect(preview.dueDate).toBe("2026-03-09");
  });

  it("lists the invoice on the reminder work list at the same moment", async () => {
    await makeSentInvoice("2026-03-01");
    const before = await listOverdueInvoices(user.id, new Date("2026-03-01T21:59:59.000Z"));
    expect(before).toHaveLength(0);
    const after = await listOverdueInvoices(user.id, new Date("2026-03-01T22:00:00.000Z"));
    expect(after).toHaveLength(1);
    expect(after[0].daysLate).toBe(1);
  });
});
