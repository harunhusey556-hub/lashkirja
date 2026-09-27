import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { GET as invoicePdf } from "@/app/api/invoices/[id]/pdf/route";
import { POST as sendInvoice } from "@/app/api/invoices/[id]/send/route";
import { POST as createInvoice } from "@/app/api/invoices/route";
import { POST as createCustomer } from "@/app/api/customers/route";
import { POST as setStatus } from "@/app/api/invoices/[id]/status/route";
import { encrypt } from "@/lib/encryption";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";

let user: TestUser;
let cookie: string;
let otherUser: TestUser;
let otherCookie: string;
let customerId: string;

process.env.MAIL_TRANSPORT = "json";

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

async function makeInvoice(auth = cookie, customer = customerId) {
  const response = await createInvoice(
    buildRequest(
      "POST",
      "/api/invoices",
      {
        customerId: customer,
        issueDate: "2026-01-15",
        lines: [{ description: "Ripsienpidennys", quantity: 1, unitPrice: 100, vatRate: 25.5 }],
      },
      { cookie: auth }
    )
  );
  expect(response.status).toBe(201);
  return (await readJson(response)).invoice;
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

async function extractPdfText(bytes: Buffer): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  try {
    return (await parser.getText()).text.replace(/\s+/g, " ");
  } finally {
    await parser.destroy();
  }
}

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
  otherUser = await createUser();
  otherCookie = await sessionCookie(otherUser);
  customerId = (await makeCustomer()).id;
});

describe("GET /api/invoices/[id]/pdf", () => {
  it("serves a PDF that carries the invoice's own numbers", async () => {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        businessName: "Liisan Ripsistudio",
        businessId: "0201256-6",
        invoiceIban: "FI2112345600000785",
        vatRegistered: true,
      },
    });
    const invoice = await makeInvoice();

    const response = await invoicePdf(
      buildRequest("GET", `/api/invoices/${invoice.id}/pdf`, undefined, { cookie }),
      routeContext({ id: invoice.id })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toContain("lasku-0001.pdf");
    expect(response.headers.get("cache-control")).toContain("no-store");

    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");

    const text = await extractPdfText(bytes);
    expect(text).toContain("Liisan Ripsistudio");
    expect(text).toContain("Anna Asiakas");
    expect(text).toContain("125,50 €");
    expect(text.replace(/\s/g, "")).toContain(invoice.reference);
  });

  it("keeps the issued PDF on the snapshot after the profile and customer change", async () => {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        businessName: "Vanha Studio",
        businessId: "0201256-6",
        invoiceIban: "FI2112345600000785",
      },
    });
    const invoice = await makeInvoice();
    await setStatus(
      buildRequest("POST", `/api/invoices/${invoice.id}/status`, { status: "sent" }, { cookie }),
      routeContext({ id: invoice.id })
    );

    await prisma.user.update({
      where: { id: user.id },
      data: { businessName: "Uusi Studio", invoiceIban: "FI4950000123456786" },
    });
    await prisma.customer.update({
      where: { id: customerId },
      data: { name: "Muutettu Asiakas", addressCity: "Turku" },
    });

    const response = await invoicePdf(
      buildRequest("GET", `/api/invoices/${invoice.id}/pdf`, undefined, { cookie }),
      routeContext({ id: invoice.id })
    );
    const text = await extractPdfText(Buffer.from(await response.arrayBuffer()));
    expect(text).toContain("Vanha Studio");
    expect(text).toContain("Anna Asiakas");
    expect(text).not.toContain("Uusi Studio");
    expect(text).not.toContain("Muutettu Asiakas");

    const draft = await makeInvoice();
    const draftPdf = await invoicePdf(
      buildRequest("GET", `/api/invoices/${draft.id}/pdf`, undefined, { cookie }),
      routeContext({ id: draft.id })
    );
    const draftText = await extractPdfText(Buffer.from(await draftPdf.arrayBuffer()));
    expect(draftText).toContain("Uusi Studio");
    expect(draftText).toContain("Muutettu Asiakas");
  });

  it("falls back to the person's own name when no business name is set", async () => {
    const invoice = await makeInvoice();
    const response = await invoicePdf(
      buildRequest("GET", `/api/invoices/${invoice.id}/pdf`, undefined, { cookie }),
      routeContext({ id: invoice.id })
    );
    const text = await extractPdfText(Buffer.from(await response.arrayBuffer()));
    expect(text).toContain("Testi Käyttäjä");
  });

  it("404s on another user's invoice and 401s without a session", async () => {
    const invoice = await makeInvoice();
    expect(
      (
        await invoicePdf(
          buildRequest("GET", `/api/invoices/${invoice.id}/pdf`, undefined, {
            cookie: otherCookie,
          }),
          routeContext({ id: invoice.id })
        )
      ).status
    ).toBe(404);
    expect(
      (
        await invoicePdf(
          buildRequest("GET", `/api/invoices/${invoice.id}/pdf`),
          routeContext({ id: invoice.id })
        )
      ).status
    ).toBe(401);
  });
});

describe("POST /api/invoices/[id]/send", () => {
  it("emails the PDF to the customer and marks the draft sent", async () => {
    await connectMailAccount(user.id);
    const invoice = await makeInvoice();

    const response = await sendInvoice(
      buildRequest("POST", `/api/invoices/${invoice.id}/send`, {}, { cookie }),
      routeContext({ id: invoice.id })
    );
    expect(response.status).toBe(200);

    const body = await readJson(response);
    expect(body.sentTo).toBe("anna@example.fi");
    expect(body.invoice.status).toBe("sent");
    expect(body.invoice.sentAt).not.toBeNull();

    const stored = await prisma.salesInvoice.findUnique({ where: { id: invoice.id } });
    expect(stored?.status).toBe("sent");
    expect(stored?.partySnapshot).toContain("Anna Asiakas");

    const sends = await prisma.invoiceEmailSend.findMany({ where: { invoiceId: invoice.id } });
    expect(sends).toEqual([
      expect.objectContaining({ status: "sent", toAddress: "anna@example.fi" }),
    ]);
    expect(sends[0]?.partySnapshot).toContain("Anna Asiakas");
  });

  it("blocks a locked period before SMTP and leaves no send row", async () => {
    await connectMailAccount(user.id);
    const invoice = await makeInvoice();
    await prisma.user.update({
      where: { id: user.id },
      data: { booksLockedThrough: "2026-01" },
    });

    const response = await sendInvoice(
      buildRequest("POST", `/api/invoices/${invoice.id}/send`, {}, { cookie }),
      routeContext({ id: invoice.id })
    );
    expect(response.status).toBe(409);
    expect((await readJson(response)).error.code).toBe("PERIOD_LOCKED");
    expect(await prisma.invoiceEmailSend.count({ where: { invoiceId: invoice.id } })).toBe(0);
    const stored = await prisma.salesInvoice.findUnique({ where: { id: invoice.id } });
    expect(stored?.status).toBe("draft");
  });

  it("records a failed delivery and does not mark the invoice sent", async () => {
    await connectMailAccount(user.id);
    const invoice = await makeInvoice();
    const { sendInvoiceByEmail } = await import("@/lib/invoice-mail");

    await expect(
      sendInvoiceByEmail(user.id, invoice.id, {}, {
        deliver: async () => {
          throw new Error("smtp down");
        },
      })
    ).rejects.toThrow(/smtp down/);

    const stored = await prisma.salesInvoice.findUnique({ where: { id: invoice.id } });
    expect(stored?.status).toBe("draft");
    const sends = await prisma.invoiceEmailSend.findMany({ where: { invoiceId: invoice.id } });
    expect(sends.map((row) => row.status)).toEqual(["failed"]);
  });

  it("reports that the mail left when the outcome cannot be stored", async () => {
    await connectMailAccount(user.id);
    await prisma.user.update({
      where: { id: user.id },
      data: { businessName: "Lähtenyt Oy" },
    });
    const invoice = await makeInvoice();
    const { sendInvoiceByEmail } = await import("@/lib/invoice-mail");

    const result = await sendInvoiceByEmail(user.id, invoice.id, {}, {
      persist: async () => false,
    });

    expect(result.recorded).toBe(false);
    expect(result.notice).toMatch(/lähti/);
    expect(result.sentTo).toBe("anna@example.fi");
    const stored = await prisma.salesInvoice.findUnique({ where: { id: invoice.id } });
    expect(stored?.status).toBe("draft");
    const send = await prisma.invoiceEmailSend.findFirst({ where: { invoiceId: invoice.id } });
    expect(send?.status).toBe("pending");
    expect(send?.partySnapshot).toContain("Lähtenyt Oy");
  });

  it("attaches the invoice PDF under its own filename", async () => {
    await connectMailAccount(user.id);
    const invoice = await makeInvoice();

    // The JSON transport hands back the composed message instead of sending it.
    const { findSenderAccount, sendMail } = await import("@/lib/mailer");
    const account = (await findSenderAccount(user.id))!;
    const sent = await sendMail(account, {
      to: "anna@example.fi",
      subject: "Lasku 1",
      text: "Liitteenä lasku.",
      attachments: [
        { filename: "lasku-0001.pdf", content: Buffer.from("%PDF-1.3"), contentType: "application/pdf" },
      ],
    });

    const composed = JSON.parse(sent.raw!);
    expect(composed.from.address).toBe("liisa@example.fi");
    expect(composed.to[0].address).toBe("anna@example.fi");
    expect(composed.attachments[0].filename).toBe("lasku-0001.pdf");
    expect(composed.attachments[0].contentType).toBe("application/pdf");
    expect(invoice.number).toBe(1);
  });

  it("uses an explicit recipient, subject and message when given", async () => {
    await connectMailAccount(user.id);
    const invoice = await makeInvoice();

    const body = await readJson(
      await sendInvoice(
        buildRequest(
          "POST",
          `/api/invoices/${invoice.id}/send`,
          { to: "kirjanpito@example.fi", subject: "Oma otsikko", message: "Oma viesti" },
          { cookie }
        ),
        routeContext({ id: invoice.id })
      )
    );
    expect(body.sentTo).toBe("kirjanpito@example.fi");
  });

  it("refuses when there is no mail account connected", async () => {
    const invoice = await makeInvoice();
    const response = await sendInvoice(
      buildRequest("POST", `/api/invoices/${invoice.id}/send`, {}, { cookie }),
      routeContext({ id: invoice.id })
    );
    expect(response.status).toBe(409);
    expect((await readJson(response)).error.code).toBe("NO_MAIL_ACCOUNT");

    const stored = await prisma.salesInvoice.findUnique({ where: { id: invoice.id } });
    expect(stored?.status).toBe("draft"); // nothing was claimed to have happened
  });

  it("refuses when the customer has no address and none was given", async () => {
    await connectMailAccount(user.id);
    const anonymous = await makeCustomer({ name: "Ei sähköpostia", email: "" });
    const invoice = await makeInvoice(cookie, anonymous.id);

    const response = await sendInvoice(
      buildRequest("POST", `/api/invoices/${invoice.id}/send`, {}, { cookie }),
      routeContext({ id: invoice.id })
    );
    expect(response.status).toBe(400);
  });

  it("refuses a credited invoice and rejects a malformed address", async () => {
    await connectMailAccount(user.id);
    const invoice = await makeInvoice();
    await setStatus(
      buildRequest("POST", `/api/invoices/${invoice.id}/status`, { status: "sent" }, { cookie }),
      routeContext({ id: invoice.id })
    );
    await setStatus(
      buildRequest(
        "POST",
        `/api/invoices/${invoice.id}/status`,
        { status: "credited" },
        { cookie }
      ),
      routeContext({ id: invoice.id })
    );

    const credited = await sendInvoice(
      buildRequest("POST", `/api/invoices/${invoice.id}/send`, {}, { cookie }),
      routeContext({ id: invoice.id })
    );
    expect(credited.status).toBe(409);

    const other = await makeInvoice();
    const badAddress = await sendInvoice(
      buildRequest("POST", `/api/invoices/${other.id}/send`, { to: "not-an-email" }, { cookie }),
      routeContext({ id: other.id })
    );
    expect(badAddress.status).toBe(400);
  });

  it("keeps a sent invoice sent instead of resetting it", async () => {
    await connectMailAccount(user.id);
    const invoice = await makeInvoice();
    await setStatus(
      buildRequest("POST", `/api/invoices/${invoice.id}/status`, { status: "sent" }, { cookie }),
      routeContext({ id: invoice.id })
    );

    const body = await readJson(
      await sendInvoice(
        buildRequest("POST", `/api/invoices/${invoice.id}/send`, {}, { cookie }),
        routeContext({ id: invoice.id })
      )
    );
    expect(body.invoice.status).toBe("sent");
  });

  it("blocks cross-site sends and another user's invoice", async () => {
    await connectMailAccount(user.id);
    const invoice = await makeInvoice();

    expect(
      (
        await sendInvoice(
          buildRequest("POST", `/api/invoices/${invoice.id}/send`, {}, {
            cookie,
            secFetchSite: "cross-site",
          }),
          routeContext({ id: invoice.id })
        )
      ).status
    ).toBe(403);

    expect(
      (
        await sendInvoice(
          buildRequest("POST", `/api/invoices/${invoice.id}/send`, {}, { cookie: otherCookie }),
          routeContext({ id: invoice.id })
        )
      ).status
    ).toBe(404);
  });
});
