import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { POST as createCustomer } from "@/app/api/customers/route";
import { GET as getCustomer } from "@/app/api/customers/[id]/route";
import { POST as mergeCustomers } from "@/app/api/customers/merge/route";
import { POST as importCustomers } from "@/app/api/customers/import/route";
import { POST as createInvoice } from "@/app/api/invoices/route";
import { PATCH as patchInvoice } from "@/app/api/invoices/[id]/route";
import { DELETE as deleteInvoice } from "@/app/api/invoices/[id]/route";
import { POST as setStatus } from "@/app/api/invoices/[id]/status/route";
import { POST as addPayment, DELETE as deletePayment } from "@/app/api/invoices/[id]/payments/route";
import { POST as creditInvoice } from "@/app/api/invoices/[id]/credit/route";
import { POST as duplicateInvoice } from "@/app/api/invoices/[id]/duplicate/route";
import { GET as invoicePdf } from "@/app/api/invoices/[id]/pdf/route";
import { GET as previewSend, POST as sendInvoice } from "@/app/api/invoices/[id]/send/route";
import { PUT as setSequence } from "@/app/api/invoices/sequence/route";
import { POST as createCatalog, GET as listCatalog } from "@/app/api/catalog/route";
import { encrypt } from "@/lib/encryption";
import { openPosition } from "@/lib/invoices";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";

process.env.MAIL_TRANSPORT = "json";

let user: TestUser;
let cookie: string;
let customerId: string;

const LINE = { description: "Ripsienpidennys", quantity: 1, unitPrice: 100, vatRate: 25.5 };

async function makeCustomer(name = "Anna Asiakas", extra: Record<string, unknown> = {}) {
  const response = await createCustomer(
    buildRequest(
      "POST",
      "/api/customers",
      { name, email: "anna@example.fi", ...extra },
      { cookie }
    )
  );
  return (await readJson(response)).customer;
}

async function makeInvoice(overrides: Record<string, unknown> = {}) {
  const response = await createInvoice(
    buildRequest(
      "POST",
      "/api/invoices",
      { customerId, issueDate: "2026-01-15", dueDate: "2026-01-29", lines: [LINE], ...overrides },
      { cookie }
    )
  );
  expect(response.status).toBe(201);
  return (await readJson(response)).invoice;
}

async function send(id: string) {
  const response = await setStatus(
    buildRequest("POST", `/api/invoices/${id}/status`, { status: "sent" }, { cookie }),
    routeContext({ id })
  );
  expect(response.status).toBe(200);
  return (await readJson(response)).invoice;
}

async function pay(id: string, amount: number, paidDate = "2026-01-20") {
  const response = await addPayment(
    buildRequest("POST", `/api/invoices/${id}/payments`, { amount, paidDate }, { cookie }),
    routeContext({ id })
  );
  expect(response.status).toBe(201);
  return (await readJson(response)).invoice;
}

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
  customerId = (await makeCustomer()).id;
});

describe("credit notes", () => {
  it("issues a separate numbered document and credits the original", async () => {
    const invoice = await send((await makeInvoice()).id);
    const response = await creditInvoice(
      buildRequest("POST", `/api/invoices/${invoice.id}/credit`, {}, { cookie }),
      routeContext({ id: invoice.id })
    );
    expect(response.status).toBe(201);
    const note = (await readJson(response)).invoice;
    expect(note.documentKind).toBe("credit_note");
    expect(note.number).not.toBe(invoice.number);
    expect(note.gross).toBeCloseTo(-125.5);
    expect(note.creditsInvoice.number).toBe(invoice.number);
    expect(note.status).toBe("sent");

    const storedNote = await prisma.salesInvoice.findUnique({ where: { id: note.id } });
    expect(storedNote?.partySnapshot).toContain("Anna Asiakas");

    const original = await prisma.salesInvoice.findUnique({ where: { id: invoice.id } });
    expect(original?.status).toBe("credited");

    const again = await creditInvoice(
      buildRequest("POST", `/api/invoices/${invoice.id}/credit`, {}, { cookie }),
      routeContext({ id: invoice.id })
    );
    expect(again.status).toBe(409);

    const pdf = await invoicePdf(
      buildRequest("GET", `/api/invoices/${note.id}/pdf`, undefined, { cookie }),
      routeContext({ id: note.id })
    );
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(Buffer.from(await pdf.arrayBuffer())) });
    const text = (await parser.getText()).text;
    await parser.destroy();
    expect(text).toContain("HYVITYSLASKU");
    expect(text).toContain(String(invoice.number));
  });
});

describe("open balance across payments", () => {
  it("stays consistent through partial payments, overpay, deletion and a refund", async () => {
    const invoice = await send((await makeInvoice()).id);

    const first = await pay(invoice.id, 50);
    expect(first.open).toBeCloseTo(75.5);
    expect(first.status).toBe("sent");

    const covered = await pay(invoice.id, 75.5);
    expect(covered.open).toBe(0);
    expect(covered.status).toBe("paid");

    const over = await pay(invoice.id, 10);
    expect(over.open).toBeCloseTo(-10);
    expect(over.status).toBe("paid");
    expect(
      openPosition({
        status: "paid",
        grossCents: 12550,
        paidCents: 13550,
      }).collectible
    ).toBe(false);

    const overPayment = over.payments.find((payment: { amount: number }) => payment.amount === 10);
    const afterDelete = await readJson(
      await deletePayment(
        buildRequest(
          "DELETE",
          `/api/invoices/${invoice.id}/payments?paymentId=${overPayment.id}`,
          undefined,
          { cookie }
        ),
        routeContext({ id: invoice.id })
      )
    );
    expect(afterDelete.invoice.open).toBe(0);
    expect(afterDelete.invoice.status).toBe("paid");

    const refunded = await pay(invoice.id, -20);
    expect(refunded.open).toBeCloseTo(20);
    expect(refunded.status).toBe("sent");
    expect(refunded.activity.some((entry: { kind: string }) => entry.kind === "payment_added")).toBe(
      true
    );
  });
});

describe("invoice numbers", () => {
  it("does not reuse a deleted draft, ignores year rollover, and only moves the start forward", async () => {
    const first = await makeInvoice();
    expect(first.number).toBe(1);
    const removed = await deleteInvoice(
      buildRequest("DELETE", `/api/invoices/${first.id}`, undefined, { cookie }),
      routeContext({ id: first.id })
    );
    expect(removed.status).toBe(200);

    const second = await makeInvoice();
    expect(second.number).toBe(2);

    const nextYear = await makeInvoice({ issueDate: "2027-01-04", dueDate: "2027-01-18" });
    expect(nextYear.number).toBe(3);

    const raised = await readJson(
      await setSequence(
        buildRequest("PUT", "/api/invoices/sequence", { startingNumber: 50 }, { cookie })
      )
    );
    expect(raised.nextNumber).toBe(50);
    const jumped = await makeInvoice();
    expect(jumped.number).toBe(50);

    const kept = await readJson(
      await setSequence(
        buildRequest("PUT", "/api/invoices/sequence", { startingNumber: 10 }, { cookie })
      )
    );
    expect(kept.nextNumber).toBe(51);
  });

  it("gives parallel creates different numbers", async () => {
    const [a, b] = await Promise.all([makeInvoice(), makeInvoice()]);
    expect(new Set([a.number, b.number]).size).toBe(2);
  });
});

describe("send history and review", () => {
  it("records the attachment and a failed attempt, and blocks a missing IBAN", async () => {
    await prisma.imapAccount.create({
      data: {
        userId: user.id,
        email: "liisa@example.fi",
        host: "imap.gmail.com",
        port: 993,
        encryptedPass: encrypt("app-password"),
      },
    });
    const invoice = await makeInvoice();

    const blocked = await readJson(
      await previewSend(
        buildRequest("GET", `/api/invoices/${invoice.id}/send`, undefined, { cookie }),
        routeContext({ id: invoice.id })
      )
    );
    expect(blocked.preview.missing).toContain("tilinumero");
    expect(blocked.preview.blockedReason).toContain("tilinumero");
    expect(blocked.preview.attachment).toBe("lasku-0001.pdf");

    const refused = await sendInvoice(
      buildRequest("POST", `/api/invoices/${invoice.id}/send`, {}, { cookie }),
      routeContext({ id: invoice.id })
    );
    expect(refused.status).toBe(409);
    expect(await prisma.invoiceEmailSend.count()).toBe(0);

    await prisma.user.update({
      where: { id: user.id },
      data: { invoiceIban: "FI2112345600000785" },
    });
    const { sendInvoiceByEmail } = await import("@/lib/invoice-mail");
    await expect(
      sendInvoiceByEmail(user.id, invoice.id, {}, {
        deliver: async () => {
          throw new Error("SMTP down");
        },
      })
    ).rejects.toThrow(/SMTP/);
    const sent = await sendInvoiceByEmail(user.id, invoice.id, {});
    expect(sent.attachment).toBe("lasku-0001.pdf");

    const sends = await prisma.invoiceEmailSend.findMany({
      where: { invoiceId: invoice.id },
      orderBy: { createdAt: "asc" },
    });
    expect(sends.map((row) => row.status)).toEqual(["failed", "sent"]);
    expect(sends[1].attachmentName).toBe("lasku-0001.pdf");
    expect(sends[1].grossCents).toBe(12550);
  });
});

describe("activity and duplicate", () => {
  it("records creation, an amount change and a copied draft", async () => {
    const invoice = await makeInvoice();
    expect(invoice.activity.map((entry: { summary: string }) => entry.summary)).toContain(
      "Lasku luotiin."
    );
    const patched = await readJson(
      await patchInvoice(
        buildRequest(
          "PATCH",
          `/api/invoices/${invoice.id}`,
          {
            lines: [{ description: "Ripsienpidennys", quantity: 2, unitPrice: 100, vatRate: 25.5 }],
            expectedUpdatedAt: invoice.updatedAt,
          },
          { cookie }
        ),
        routeContext({ id: invoice.id })
      )
    );
    expect(
      patched.invoice.activity.some((entry: { kind: string }) => entry.kind === "amount_changed")
    ).toBe(true);

    const copyResponse = await duplicateInvoice(
      buildRequest("POST", `/api/invoices/${invoice.id}/duplicate`, {}, { cookie }),
      routeContext({ id: invoice.id })
    );
    expect(copyResponse.status).toBe(201);
    const copy = (await readJson(copyResponse)).invoice;
    expect(copy.status).toBe("draft");
    expect(copy.number).not.toBe(invoice.number);
    expect(copy.payments).toEqual([]);
    expect(copy.activity.some((entry: { kind: string }) => entry.kind === "duplicated")).toBe(true);
  });
});

describe("customers and catalog", () => {
  it("shows one customer with balance and last payment", async () => {
    const invoice = await send((await makeInvoice()).id);
    await pay(invoice.id, 40, "2026-02-02");
    const detail = await readJson(
      await getCustomer(
        buildRequest("GET", `/api/customers/${customerId}`, undefined, { cookie }),
        routeContext({ id: customerId })
      )
    );
    expect(detail.openBalance).toBeCloseTo(85.5);
    expect(detail.lastPayment).toMatchObject({ amount: 40, invoiceNumber: invoice.number });
    expect(detail.invoices).toHaveLength(1);
    expect(detail.customer.email).toBe("anna@example.fi");
  });

  it("merges a duplicate without dropping invoices", async () => {
    const other = await makeCustomer("Anna B", { email: "b@example.fi" });
    const invoice = await makeInvoice();
    const merged = await readJson(
      await mergeCustomers(
        buildRequest(
          "POST",
          "/api/customers/merge",
          { keepId: other.id, mergeId: customerId },
          { cookie }
        )
      )
    );
    expect(merged.invoices).toHaveLength(1);
    expect(merged.invoices[0].id).toBe(invoice.id);
    const archived = await prisma.customer.findUnique({ where: { id: customerId } });
    expect(archived?.archivedAt).not.toBeNull();
    expect(await prisma.salesInvoice.count({ where: { customerId: other.id } })).toBe(1);
  });

  it("previews CSV errors and inserts only valid rows", async () => {
    const csv = ["nimi,sähköposti", "Bertta,bertta@example.fi", ",ei-nimea@example.fi"].join("\n");
    const preview = await readJson(
      await importCustomers(buildRequest("POST", "/api/customers/import", { csv }, { cookie }))
    );
    expect(preview.created).toBe(0);
    expect(preview.rows[1].errors.length).toBeGreaterThan(0);
    expect(await prisma.customer.count({ where: { name: "Bertta" } })).toBe(0);

    const committed = await readJson(
      await importCustomers(
        buildRequest("POST", "/api/customers/import", { csv, commit: true }, { cookie })
      )
    );
    expect(committed.created).toBe(1);
    expect(await prisma.customer.count({ where: { name: "Bertta" } })).toBe(1);
  });

  it("stores a catalog line and lists it", async () => {
    const created = await createCatalog(
      buildRequest(
        "POST",
        "/api/catalog",
        { name: "Klassinen", unit: "kpl", unitPrice: 80, vatRate: 25.5 },
        { cookie }
      )
    );
    expect(created.status).toBe(201);
    const listed = await readJson(
      await listCatalog(buildRequest("GET", "/api/catalog", undefined, { cookie }))
    );
    expect(listed.items).toEqual([
      expect.objectContaining({ name: "Klassinen", unitPrice: 80, vatRate: 25.5 }),
    ]);
  });
});
