import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { GET as previewSend, POST as sendInvoice } from "@/app/api/invoices/[id]/send/route";
import { POST as createInvoice } from "@/app/api/invoices/route";
import { POST as createCustomer } from "@/app/api/customers/route";
import { GET as listTemplates, POST as createTemplate } from "@/app/api/invoice-email-templates/route";
import {
  DELETE as deleteTemplate,
  PATCH as patchTemplate,
} from "@/app/api/invoice-email-templates/[id]/route";
import { sendMail } from "@/lib/mailer";
import { sendInvoiceByEmail } from "@/lib/invoice-mail";
import { encrypt } from "@/lib/encryption";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";

// The real composer under the JSON transport, wrapped so a test can read what was handed to SMTP.
vi.mock("@/lib/mailer", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/mailer")>();
  return { ...real, sendMail: vi.fn(real.sendMail) };
});

process.env.MAIL_TRANSPORT = "json";

let user: TestUser;
let cookie: string;
let customerId: string;

async function makeInvoice() {
  const response = await createInvoice(
    buildRequest(
      "POST",
      "/api/invoices",
      {
        customerId,
        issueDate: "2026-01-15",
        dueDate: "2026-01-29",
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

async function preview(id: string, query = "") {
  const response = await previewSend(
    buildRequest("GET", `/api/invoices/${id}/send${query}`, undefined, { cookie }),
    routeContext({ id })
  );
  return { status: response.status, body: await readJson(response) };
}

function post(id: string, body: Record<string, unknown>) {
  return sendInvoice(buildRequest("POST", `/api/invoices/${id}/send`, body, { cookie }), routeContext({ id }));
}

function lastMail() {
  const calls = vi.mocked(sendMail).mock.calls;
  return calls[calls.length - 1][1];
}

async function create(body: Record<string, unknown>, as = cookie) {
  const response = await createTemplate(buildRequest("POST", "/api/invoice-email-templates", body, { cookie: as }));
  return { status: response.status, body: await readJson(response) };
}

async function list(as = cookie, query = "") {
  const response = await listTemplates(buildRequest("GET", `/api/invoice-email-templates${query}`, undefined, { cookie: as }));
  return { status: response.status, body: await readJson(response) };
}

async function patch(id: string, body: Record<string, unknown>, as = cookie) {
  const response = await patchTemplate(
    buildRequest("PATCH", `/api/invoice-email-templates/${id}`, body, { cookie: as }),
    routeContext({ id })
  );
  return { status: response.status, body: await readJson(response) };
}

async function remove(id: string, as = cookie) {
  const response = await deleteTemplate(
    buildRequest("DELETE", `/api/invoice-email-templates/${id}`, undefined, { cookie: as }),
    routeContext({ id })
  );
  return { status: response.status, body: await readJson(response) };
}

const TEMPLATE = {
  name: "Kanta-asiakas",
  subject: "Lasku {laskunumero} – {yritys}",
  body: "Hei {asiakas},\n\nsumma {summa}, eräpäivä {erapaiva}, viite {viitenumero}, tili {tilinumero}.\n\n{tuntematon} jää ennalleen.",
};

beforeEach(async () => {
  await resetDatabase();
  vi.mocked(sendMail).mockClear();
  user = await createUser();
  await prisma.user.update({
    where: { id: user.id },
    data: { invoiceIban: "FI2112345600000785", businessName: "Liisan Ripset" },
  });
  cookie = await sessionCookie(user);
  const response = await createCustomer(
    buildRequest("POST", "/api/customers", { name: "Anna Asiakas", email: "anna@example.fi" }, { cookie })
  );
  customerId = (await readJson(response)).customer.id;
});

describe("the send check hands the text over for editing", () => {
  it("fills the built-in subject and message for this invoice when there is no template", async () => {
    const invoice = await makeInvoice();
    const { body } = await preview(invoice.id);
    expect(body.preview.subject).toBe(`Lasku ${invoice.number} · Liisan Ripset`);
    expect(body.preview.message).toContain(`liitteenä lasku ${invoice.number}.`);
    expect(body.preview.message).toContain("Eräpäivä: 29.1.2026");
    expect(body.preview.message).toContain("Summa: 125,50");
    expect(body.preview.templateId).toBeNull();
    expect(body.preview.templates).toEqual([]);
    expect(body.preview.placeholders).toMatchObject({
      asiakas: "Anna Asiakas",
      laskunumero: String(invoice.number),
      erapaiva: "29.1.2026",
      tilinumero: "FI21 1234 5600 0007 85",
      yritys: "Liisan Ripset",
    });
  });

  it("fills them from the default template, placeholders rendered", async () => {
    const invoice = await makeInvoice();
    const other = await create({ ...TEMPLATE, name: "Muu" });
    const made = await create({ ...TEMPLATE, isDefault: true });
    const { body } = await preview(invoice.id);
    expect(body.preview.templateId).toBe(made.body.template.id);
    expect(body.preview.subject).toBe(`Lasku ${invoice.number} – Liisan Ripset`);
    expect(body.preview.message).toContain("Hei Anna Asiakas,");
    expect(body.preview.message).toContain("eräpäivä 29.1.2026");
    expect(body.preview.message).toContain("tili FI21 1234 5600 0007 85");
    expect(body.preview.message).toContain("{tuntematon} jää ennalleen.");
    expect(body.preview.message).not.toContain("{asiakas}");
    expect(body.preview.templates).toEqual([
      { id: made.body.template.id, name: "Kanta-asiakas", isDefault: true },
      { id: other.body.template.id, name: "Muu", isDefault: false },
    ]);
  });

  it("renders a chosen template with ?templateId=, and not another owner's", async () => {
    const invoice = await makeInvoice();
    const chosen = await create({ ...TEMPLATE, name: "Lyhyt", subject: "Lasku {laskunumero}", body: "Kiitos, {asiakas}!" });
    const { body } = await preview(invoice.id, `?templateId=${chosen.body.template.id}`);
    expect(body.preview.subject).toBe(`Lasku ${invoice.number}`);
    expect(body.preview.message).toBe("Kiitos, Anna Asiakas!");
    expect(body.preview.templateId).toBe(chosen.body.template.id);

    const stranger = await createUser();
    const strangerCookie = await sessionCookie(stranger);
    const theirs = await create(TEMPLATE, strangerCookie);
    expect((await preview(invoice.id, `?templateId=${theirs.body.template.id}`)).status).toBe(404);
  });
});

describe("the send carries the owner's own text", () => {
  it("sends the custom subject and message, with placeholders filled", async () => {
    await connectMail();
    const invoice = await makeInvoice();
    const response = await post(invoice.id, {
      subject: "Oma aihe {laskunumero}",
      message: "Hei {asiakas},\nkiitos käynnistä!",
    });
    expect(response.status).toBe(200);
    const mail = lastMail();
    expect(mail.subject).toBe(`Oma aihe ${invoice.number}`);
    expect(mail.text).toBe("Hei Anna Asiakas,\nkiitos käynnistä!");
    const row = await prisma.invoiceEmailSend.findFirst({ where: { invoiceId: invoice.id } });
    expect(row?.subject).toBe(`Oma aihe ${invoice.number}`);
  });

  it("sends markup as plain text and keeps a line break out of the subject", async () => {
    await connectMail();
    const invoice = await makeInvoice();
    const response = await post(invoice.id, {
      subject: "Lasku\r\nBcc: varas@example.com",
      message: "<b>Hei</b> <script>alert(1)</script>\r\nRivi kaksi\u0007",
    });
    expect(response.status).toBe(200);
    const mail = lastMail();
    expect(mail.subject).toBe("Lasku Bcc: varas@example.com");
    expect(mail.text).toBe("<b>Hei</b> <script>alert(1)</script>\nRivi kaksi");
    // Plain text only: no HTML part a mail client would render.
    expect(mail).not.toHaveProperty("html");
    const sent = await vi.mocked(sendMail).mock.results.at(-1)!.value;
    const composed = JSON.parse(sent.raw);
    expect(composed.html).toBeUndefined();
    expect(composed.bcc).toBeUndefined();
    expect(composed.text).toContain("<script>alert(1)</script>");
  });

  it("refuses a subject over 200, a message over 5000 and an empty message", async () => {
    await connectMail();
    const invoice = await makeInvoice();
    const long = await post(invoice.id, { subject: "a".repeat(201) });
    expect(long.status).toBe(400);
    expect(JSON.stringify(await readJson(long))).toContain("Aihe on liian pitkä");
    const huge = await post(invoice.id, { message: "a".repeat(5001) });
    expect(huge.status).toBe(400);
    expect(JSON.stringify(await readJson(huge))).toContain("Viesti on liian pitkä");
    expect((await post(invoice.id, { message: "   " })).status).toBe(400);
    expect((await post(invoice.id, { subject: "a".repeat(200), message: "a".repeat(5000) })).status).toBe(200);
    expect(vi.mocked(sendMail)).toHaveBeenCalledTimes(1);
  });

  it("a send without text of its own uses the default template, also for automatic sends", async () => {
    await connectMail();
    const invoice = await makeInvoice();
    await create({ ...TEMPLATE, isDefault: true });
    expect((await post(invoice.id, {})).status).toBe(200);
    expect(lastMail().subject).toBe(`Lasku ${invoice.number} – Liisan Ripset`);
    expect(lastMail().text).toContain("Hei Anna Asiakas,");

    // The recurring schedule calls the same function without any text.
    let text = "";
    await sendInvoiceByEmail(user.id, invoice.id, {}, {
      deliver: async (_account, mail) => {
        text = mail.text;
        return { messageId: "m-2", from: "liisa@example.fi", to: mail.to, accepted: [mail.to] };
      },
    });
    expect(text).toContain("Hei Anna Asiakas,");
  });

  it("without templates the built-in text goes out as before", async () => {
    await connectMail();
    const invoice = await makeInvoice();
    expect((await post(invoice.id, {})).status).toBe(200);
    expect(lastMail().subject).toBe(`Lasku ${invoice.number} · Liisan Ripset`);
    expect(lastMail().text).toContain("Viitenumero:");
  });
});

describe("Sähköpostimallit API", () => {
  it("creates, lists, edits and deletes a template, and documents the placeholders", async () => {
    const made = await create(TEMPLATE);
    expect(made.status).toBe(201);
    expect(made.body.template).toMatchObject({ name: "Kanta-asiakas", kind: "invoice", isDefault: false });
    // Placeholders are kept as typed; they are filled per invoice.
    expect(made.body.template.body).toContain("{asiakas}");

    const listed = await list();
    expect(listed.body.templates).toHaveLength(1);
    expect(listed.body.placeholders.map((p: { key: string }) => p.key)).toEqual([
      "asiakas",
      "laskunumero",
      "summa",
      "erapaiva",
      "viitenumero",
      "tilinumero",
      "yritys",
    ]);

    const edited = await patch(made.body.template.id, { name: "Uusi nimi", subject: "Aihe {laskunumero}" });
    expect(edited.status).toBe(200);
    expect(edited.body.template).toMatchObject({ name: "Uusi nimi", subject: "Aihe {laskunumero}", body: TEMPLATE.body });

    expect((await remove(made.body.template.id)).status).toBe(200);
    expect((await list()).body.templates).toEqual([]);
    expect((await remove(made.body.template.id)).status).toBe(404);
  });

  it("validates name, subject, body and kind", async () => {
    expect((await create({ ...TEMPLATE, name: "  " })).status).toBe(400);
    expect((await create({ ...TEMPLATE, subject: "a".repeat(201) })).status).toBe(400);
    expect((await create({ ...TEMPLATE, body: "a".repeat(5001) })).status).toBe(400);
    expect((await create({ ...TEMPLATE, kind: "spam" })).status).toBe(400);
    expect((await create({ ...TEMPLATE, html: "<b>x</b>" })).status).toBe(400);
    const oneLine = await create({ ...TEMPLATE, subject: "Rivi\nToinen" });
    expect(oneLine.body.template.subject).toBe("Rivi Toinen");
  });

  it("keeps one default per kind", async () => {
    const first = await create({ ...TEMPLATE, name: "A", isDefault: true });
    const second = await create({ ...TEMPLATE, name: "B", isDefault: true });
    const reminder = await create({ ...TEMPLATE, name: "M", kind: "reminder", isDefault: true });
    let rows = (await list()).body.templates as Array<{ id: string; isDefault: boolean; kind: string }>;
    expect(rows.filter((t) => t.isDefault && t.kind === "invoice").map((t) => t.id)).toEqual([second.body.template.id]);
    expect(rows.find((t) => t.id === reminder.body.template.id)?.isDefault).toBe(true);

    await patch(first.body.template.id, { isDefault: true });
    rows = (await list(cookie, "?kind=invoice")).body.templates;
    expect(rows.map((t) => [t.id, t.isDefault])).toEqual([
      [first.body.template.id, true],
      [second.body.template.id, false],
    ]);
    expect((await list(cookie, "?kind=muu")).status).toBe(400);
  });

  it("shows, edits and deletes only the owner's templates", async () => {
    const mine = await create(TEMPLATE);
    const stranger = await createUser();
    const strangerCookie = await sessionCookie(stranger);
    expect((await list(strangerCookie)).body.templates).toEqual([]);
    expect((await patch(mine.body.template.id, { name: "Varastettu" }, strangerCookie)).status).toBe(404);
    expect((await remove(mine.body.template.id, strangerCookie)).status).toBe(404);
    // A stranger's default does not touch mine.
    await patch(mine.body.template.id, { isDefault: true });
    await create({ ...TEMPLATE, isDefault: true }, strangerCookie);
    expect((await list()).body.templates[0]).toMatchObject({ name: "Kanta-asiakas", isDefault: true });
  });

  it("requires a session", async () => {
    const response = await listTemplates(buildRequest("GET", "/api/invoice-email-templates"));
    expect(response.status).toBe(401);
  });
});
