import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@/lib/db";
import { resetRateLimitsForTests } from "@/lib/rate-limit";
import { resetCopilotPauseForTests } from "@/lib/copilot";
import { createChatToolSession, toolHonesty } from "@/lib/chat-tools";
import { alvReportOf, loadAlvPeriodSources } from "@/lib/alv-period";
import { alvPeriodBoundsUtc, helsinkiCalendarDate } from "@/lib/validation";
import { POST as postChat, PATCH as decideChat } from "@/app/api/ai/chat/route";
import {
  createBankAccountRow,
  createReceipt,
  createStatementWithTransactions,
  createUser,
  resetDatabase,
  type TestUser,
} from "./helpers/factories";
import { buildRequest, readJson, sessionCookie } from "./helpers/http";

/* ------------------------------ fixtures ------------------------------ */

const NOW = new Date("2026-10-15T09:00:00.000Z");
let invoiceNumber = 1000;

async function customer(userId: string, name: string, term = 14) {
  return prisma.customer.create({ data: { userId, name, defaultPaymentTermDays: term } });
}

/** A sales invoice with one 25,5 % line, so the books (lines) and the stored totals agree. */
async function invoice(
  userId: string,
  customerId: string,
  options: { status: string; issueDate: string; dueDate: string; netCents: number; paidCents?: number }
) {
  invoiceNumber += 1;
  const vatCents = Math.round((options.netCents * 255) / 1000);
  const created = await prisma.salesInvoice.create({
    data: {
      userId,
      customerId,
      number: invoiceNumber,
      reference: `${invoiceNumber}${Math.floor(Math.random() * 1e6)}`,
      issueDate: new Date(`${options.issueDate}T00:00:00.000Z`),
      dueDate: new Date(`${options.dueDate}T00:00:00.000Z`),
      status: options.status,
      netCents: options.netCents,
      vatCents,
      grossCents: options.netCents + vatCents,
      lines: { create: [{ description: "Ripsienpidennys", quantityMilli: 1000, unitPriceCents: options.netCents, vatRatePermille: 255, netCents: options.netCents }] },
    },
  });
  if (options.paidCents) {
    await prisma.invoicePayment.create({ data: { invoiceId: created.id, paidDate: new Date(`${options.issueDate}T00:00:00.000Z`), amountCents: options.paidCents } });
  }
  return created;
}

async function purchase(userId: string, options: { supplier: string; status?: string; issueDate: string; dueDate: string; grossCents: number; vatCents?: number }) {
  return prisma.purchaseInvoice.create({
    data: {
      userId,
      supplierName: options.supplier,
      issueDate: new Date(`${options.issueDate}T00:00:00.000Z`),
      dueDate: new Date(`${options.dueDate}T00:00:00.000Z`),
      status: options.status ?? "open",
      grossCents: options.grossCents,
      vatCents: options.vatCents ?? 0,
      netCents: options.grossCents - (options.vatCents ?? 0),
    },
  });
}

async function call(userId: string, name: string, args: Record<string, unknown> = {}) {
  const session = createChatToolSession(userId, NOW);
  const result = JSON.parse(await session.run(name, JSON.stringify(args)));
  return { result, session };
}

/* --------------------------- a fake model --------------------------- */

type Step = { call: string; args: Record<string, unknown> } | { say: string };

function sseBody(text: string) {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`).body!;
}

/** An OpenAI-compatible endpoint that plays `steps` in order; every request body is kept. */
function installModel(steps: Step[]) {
  const bodies: Array<{ messages: Array<{ role: string; content: string | null; tool_call_id?: string }>; stream?: boolean; tools?: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (!String(url).startsWith("https://llm.test/")) throw new Error(`unexpected fetch ${url}`);
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      const step = steps.shift() ?? { say: "Valmis." };
      if (body.stream) return new Response(sseBody("say" in step ? step.say : "Valmis."));
      const message =
        "call" in step
          ? { role: "assistant", content: null, tool_calls: [{ id: `call-${bodies.length}`, type: "function", function: { name: step.call, arguments: JSON.stringify(step.args) } }] }
          : { role: "assistant", content: step.say };
      return new Response(JSON.stringify({ choices: [{ message }] }), { headers: { "content-type": "application/json" } });
    })
  );
  return bodies;
}

function toolResults(bodies: ReturnType<typeof installModel>) {
  const last = bodies.at(-1)!;
  return last.messages.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content!));
}

interface ChatEvent {
  done?: boolean;
  status?: string;
  id?: string;
  content?: string;
  limited?: boolean;
  proposal?: Record<string, unknown> | null;
}

async function ask(cookie: string, message: string): Promise<ChatEvent> {
  const response = await postChat(buildRequest("POST", "/api/ai/chat", { message, clientId: randomUUID(), stream: true }, { cookie }));
  const text = await response.text();
  const events = text
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => JSON.parse(chunk.slice(6)) as ChatEvent);
  return events.find((event) => event.id && (event.done !== undefined || event.status)) ?? events.at(-1)!;
}

async function decide(cookie: string, id: string, decision: "accepted" | "rejected") {
  const response = await decideChat(buildRequest("PATCH", "/api/ai/chat", { id, decision }, { cookie }));
  return { response, body: await readJson(response) };
}

let owner: TestUser;
let stranger: TestUser;
let cookie: string;

beforeEach(async () => {
  resetRateLimitsForTests();
  resetCopilotPauseForTests();
  await resetDatabase();
  vi.stubEnv("COPILOT_GITHUB_TOKEN", "");
  vi.stubEnv("LLM_API_KEY", "test-key");
  vi.stubEnv("LLM_BASE_URL", "https://llm.test/v1");
  owner = await createUser({ firstName: "Omistaja" });
  stranger = await createUser({ firstName: "Vieras" });
  cookie = await sessionCookie(owner);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/* ------------------------------ read tools ------------------------------ */

describe("search_invoices", () => {
  it("finds a customer's open invoices from a loosely written name, owner-scoped, with exact totals and paging", async () => {
    const virtanen = await customer(owner.id, "Virtanen Oy");
    const other = await customer(owner.id, "Mäkinen Tmi");
    const theirs = await customer(stranger.id, "Virtanen Oy");
    await invoice(owner.id, virtanen.id, { status: "sent", issueDate: "2026-08-01", dueDate: "2026-08-15", netCents: 10_000 }); // overdue 125.50
    await invoice(owner.id, virtanen.id, { status: "sent", issueDate: "2026-10-01", dueDate: "2026-10-20", netCents: 20_000, paidCents: 5_000 }); // open 201.00
    await invoice(owner.id, virtanen.id, { status: "paid", issueDate: "2026-07-01", dueDate: "2026-07-15", netCents: 9_900, paidCents: 12_425 });
    await invoice(owner.id, other.id, { status: "sent", issueDate: "2026-09-01", dueDate: "2026-09-15", netCents: 7_000 });
    await invoice(stranger.id, theirs.id, { status: "sent", issueDate: "2026-09-01", dueDate: "2026-09-15", netCents: 99_900 });

    const { result } = await call(owner.id, "search_invoices", { customer: "virtaselle", status: "open" });
    expect(result.ok).toBe(true);
    expect(result.matchedCustomers).toEqual(["Virtanen Oy"]);
    expect(result.total).toMatchObject({ count: 2, gross: "376.50", open: "326.50" });
    expect(result.items.map((item: { open: string }) => item.open)).toEqual(["201.00", "125.50"]);
    expect(result.items[1]).toMatchObject({ status: "overdue", daysOverdue: 61, href: expect.stringMatching(/^\/laskut\/lasku\?id=/) });

    const overdue = (await call(owner.id, "search_invoices", { status: "overdue" })).result;
    expect(overdue.total.count).toBe(2);
    expect(JSON.stringify(overdue)).not.toContain("999");

    const first = (await call(owner.id, "search_invoices", { customer: "VIRTANEN", limit: 1 })).result;
    expect(first.total.count).toBe(3);
    expect(first.items).toHaveLength(1);
    const second = (await call(owner.id, "search_invoices", { customer: "VIRTANEN", limit: 1, cursor: first.nextCursor })).result;
    expect(second.items[0].id).not.toBe(first.items[0].id);
  });

  it("returns a model's bad argument to it instead of failing the turn", async () => {
    const { result } = await call(owner.id, "search_invoices", { status: "whatever" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/status/);
    const cursor = (await call(owner.id, "search_invoices", { cursor: "not-ours" })).result;
    expect(cursor).toMatchObject({ ok: false });
  });
});

describe("search_receipts and search_purchase_invoices", () => {
  it("filters receipts by vendor, period and missing VAT for the owner only", async () => {
    await createReceipt(owner.id, { vendor: "Lumene Tukku", date: "2026-09-03", totalAmountCents: 4_990, vatDetails: null });
    await createReceipt(owner.id, { vendor: "Lumene Tukku", date: "2026-09-20", totalAmountCents: 12_550 });
    await createReceipt(owner.id, { vendor: "Lumene Tukku", date: "2026-08-20", totalAmountCents: 1_000 });
    await createReceipt(owner.id, { vendor: "Neste", date: "2026-09-05", totalAmountCents: 6_000 });
    await createReceipt(stranger.id, { vendor: "Lumene Tukku", date: "2026-09-04", totalAmountCents: 77_700, vatDetails: null });

    const all = (await call(owner.id, "search_receipts", { vendor: "lumene", period: "2026-09" })).result;
    expect(all.total).toMatchObject({ count: 2, expenses: "175.40", vat: "25.50", missingVatCount: 1 });
    const missing = (await call(owner.id, "search_receipts", { vendor: "lumene", period: "2026-09", missingVat: true })).result;
    expect(missing.items).toHaveLength(1);
    expect(missing.items[0]).toMatchObject({ gross: "49.90", missingVat: true, vat: null });
  });

  it("lists open and overdue purchase invoices with their open amount", async () => {
    await purchase(owner.id, { supplier: "Vuokranantaja Oy", issueDate: "2026-09-01", dueDate: "2026-09-30", grossCents: 80_000 });
    await purchase(owner.id, { supplier: "Elisa", issueDate: "2026-10-01", dueDate: "2026-10-25", grossCents: 3_990, vatCents: 810 });
    await purchase(owner.id, { supplier: "Elisa", status: "paid", issueDate: "2026-09-01", dueDate: "2026-09-25", grossCents: 3_990 });
    await purchase(stranger.id, { supplier: "Elisa", issueDate: "2026-10-01", dueDate: "2026-10-25", grossCents: 55_500 });

    const open = (await call(owner.id, "search_purchase_invoices", { status: "open" })).result;
    expect(open.total).toMatchObject({ count: 2, open: "839.90" });
    const overdue = (await call(owner.id, "search_purchase_invoices", { status: "overdue" })).result;
    expect(overdue.items.map((item: { supplier: string }) => item.supplier)).toEqual(["Vuokranantaja Oy"]);
    const elisa = (await call(owner.id, "search_purchase_invoices", { supplier: "elisa" })).result;
    expect(elisa.total.count).toBe(2);
  });
});

describe("period_summary, vat_return", () => {
  it("reports the period like Raportit and compares it with the periods before", async () => {
    const c = await customer(owner.id, "Asiakas");
    await invoice(owner.id, c.id, { status: "sent", issueDate: "2026-09-10", dueDate: "2026-09-24", netCents: 40_000 });
    await createReceipt(owner.id, { date: "2026-09-12", totalAmountCents: 12_550, vatDetails: JSON.stringify([{ rate: 25.5, amount: 25.5 }]) });
    await invoice(owner.id, c.id, { status: "sent", issueDate: "2026-08-10", dueDate: "2026-08-24", netCents: 10_000 });
    await invoice(stranger.id, (await customer(stranger.id, "X")).id, { status: "sent", issueDate: "2026-09-10", dueDate: "2026-09-24", netCents: 500_000 });

    const { result } = await call(owner.id, "period_summary", { period: "2026-09", compare: 1 });
    expect(result.income).toEqual({ gross: "502.00", vat: "102.00", net: "400.00" });
    expect(result.expenses).toEqual({ gross: "125.50", vat: "25.50", net: "100.00" });
    expect(result.profitNet).toBe("300.00");
    expect(result.vatPayable).toEqual({ amount: "76.50", isRefund: false });
    expect(result.previous).toHaveLength(1);
    expect(result.previous[0]).toMatchObject({ period: { key: "2026-08" }, profitNet: "100.00" });

    const range = (await call(owner.id, "period_summary", { from: "2026-08", to: "2026-09" })).result;
    expect(range.months.map((m: { month: string }) => m.month)).toEqual(["2026-08", "2026-09"]);
    expect(range.income.net).toBe("500.00");
  });

  it("gives the VAT return the ALV page computes", async () => {
    const c = await customer(owner.id, "Asiakas");
    await invoice(owner.id, c.id, { status: "sent", issueDate: "2026-09-10", dueDate: "2026-09-24", netCents: 40_000 });
    await createReceipt(owner.id, { date: "2026-09-12", totalAmountCents: 12_550 });
    const { result } = await call(owner.id, "vat_return", { period: "2026-09" });
    const { start, end } = alvPeriodBoundsUtc("2026-09");
    const report = alvReportOf(await loadAlvPeriodSources(owner.id, start, end));
    expect(result.payable.amount).toBe(report.field308.amount.toFixed(2));
    expect(result).toMatchObject({ sales255: { netSales: "400.00", vat: "102.00" }, deductibleVat: "25.50", filing: { state: "open" }, href: "/kirjanpito/alv?period=2026-09" });
    expect((await call(owner.id, "vat_return", { period: "2026-q3" })).result.period).toBe("2026-Q3");
  });
});

describe("bank_position, cash_forecast, work_queue", () => {
  it("gives balances per account and the cash outlook", async () => {
    const account = await createBankAccountRow(owner.id, { name: "Käyttötili", iban: "FI2112345600000785", openingBalanceCents: 100_000, openingDate: "2026-01-01" });
    await createStatementWithTransactions(owner.id, { bankAccountId: account.id, periodMonth: "2026-09", transactions: [{ date: "2026-09-10", amountCents: -20_000 }] });
    await createBankAccountRow(stranger.id, { name: "Vieras", openingBalanceCents: 9_999_900 });

    const bank = (await call(owner.id, "bank_position")).result;
    expect(bank.total).toBe("800.00");
    expect(bank.accounts).toEqual([expect.objectContaining({ name: "Käyttötili", iban: "…0785", balance: "800.00" })]);

    const c = await customer(owner.id, "Asiakas");
    await invoice(owner.id, c.id, { status: "sent", issueDate: "2026-10-01", dueDate: "2026-10-20", netCents: 10_000 }); // 125.50 due in window
    await invoice(owner.id, c.id, { status: "sent", issueDate: "2026-10-01", dueDate: "2026-12-31", netCents: 10_000 }); // outside
    await purchase(owner.id, { supplier: "Vuokra", issueDate: "2026-10-01", dueDate: "2026-10-30", grossCents: 50_000 });
    const forecast = (await call(owner.id, "cash_forecast", { days: 30 })).result;
    expect(forecast).toMatchObject({
      bankBalance: "800.00",
      receivables: { total: "125.50", count: 1 },
      payables: { total: "500.00", count: 1 },
      projectedBalance: "425.50",
    });
  });

  it("lists the month's open tasks and whether it can be closed", async () => {
    await createReceipt(owner.id, { vendor: "Odottava", date: "2026-09-08", reviewStatus: "pending" });
    const { result } = await call(owner.id, "work_queue", { month: "2026-09" });
    expect(result.blockingTotal).toBeGreaterThanOrEqual(1);
    expect(result.items).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "pending_receipt", party: "Odottava" })]));
    expect(result.verdict).toMatch(/kesken/);
    expect(result.ended).toBe(true);
  });
});

describe("the honesty hook", () => {
  it("collects every figure, id and link a tool returned, with its tool, period and record", async () => {
    const c = await customer(owner.id, "Virtanen Oy");
    const row = await invoice(owner.id, c.id, { status: "sent", issueDate: "2026-09-01", dueDate: "2026-09-15", netCents: 10_000 });
    const { session } = await call(owner.id, "search_invoices", { customer: "virtanen", period: "2026-09" });
    expect(session.figures()).toEqual(expect.arrayContaining([{ amount: "125.50", tool: "search_invoices", period: "2026-09", recordId: row.id }]));
    const allowed = toolHonesty(session);
    expect(allowed.allowedAmounts).toContain("125.50");
    expect(allowed.allowedRecordIds).toContain(row.id);
    expect(allowed.allowedHrefs).toContain(`/laskut/lasku?id=${row.id}`);
  });
});

/* ------------------------- the loop through the route ------------------------- */

describe("chat turn with tools", () => {
  it("answers from a tool's figure, and the guard lets that figure through", async () => {
    const c = await customer(owner.id, "Virtanen Oy");
    // Partly paid: the open 75,50 € is in no context preview, only in the tool's answer.
    await invoice(owner.id, c.id, { status: "sent", issueDate: "2026-09-01", dueDate: "2026-09-15", netCents: 10_000, paidCents: 5_000 });
    const bodies = installModel([
      { call: "search_invoices", args: { customer: "Virtaselle", status: "open" } },
      { say: "Virtanen Oy:ltä on maksamatta 75,50 €." },
    ]);
    const final = await ask(cookie, "Paljonko Virtaselle on maksamatta?");
    expect(final.status).toBe("complete");
    expect(final.content).toBe("Virtanen Oy:ltä on maksamatta 75,50 €.");
    expect(toolResults(bodies)[0].total.open).toBe("75.50");
    expect(bodies[0].tools).toBeTruthy();
  });

  it("still refuses a figure no tool returned", async () => {
    installModel([
      { call: "search_invoices", args: { status: "open" } },
      { say: "Avoimia laskuja on 999,00 €." },
    ]);
    const final = await ask(cookie, "Paljonko on avoinna?");
    expect(final.content).not.toContain("999");
    expect(final.limited).toBe(true);
  });
});

describe("propose_invoice_draft", () => {
  it("shows a draft as a card, creates it only on Hyväksy, and only once", async () => {
    const c = await customer(owner.id, "Anna Laine", 7);
    installModel([
      { call: "propose_invoice_draft", args: { customer: "anna laineelle", lines: [{ description: "Ripsienpidennys", quantity: 1, unitPrice: 80 }, { description: "Huolto", quantity: 2, unitPrice: 25.5 }] } },
      { say: "Tein ehdotuksen laskuluonnokseksi Anna Laineelle. Vahvista se alta." },
    ]);
    const final = await ask(cookie, "Tee Anna Laineelle lasku ripsienpidennyksestä 80 € ja kahdesta huollosta 25,50 €");
    expect(final.status).toBe("complete");
    expect(final.proposal).toMatchObject({
      type: "invoice_draft",
      customerId: c.id,
      customerName: "Anna Laine",
      paymentTermDays: 7,
      issueDate: helsinkiCalendarDate(new Date()),
      totals: { net: "131.00", vat: "33.41", gross: "164.41" },
    });
    expect(await prisma.salesInvoice.count({ where: { userId: owner.id } })).toBe(0);

    const accepted = await decide(cookie, final.id!, "accepted");
    expect(accepted.response.status).toBe(200);
    expect(accepted.body.proposal).toMatchObject({ status: "accepted", invoiceId: expect.any(String), href: expect.stringMatching(/^\/laskut\/lasku\?id=/) });
    const created = await prisma.salesInvoice.findMany({ where: { userId: owner.id }, include: { lines: true } });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ status: "draft", customerId: c.id, grossCents: 16_441 });
    expect(created[0].lines).toHaveLength(2);

    const again = await decide(cookie, final.id!, "accepted");
    expect(again.response.status).toBe(200);
    expect(await prisma.salesInvoice.count({ where: { userId: owner.id } })).toBe(1);
    expect((await decide(cookie, final.id!, "rejected")).response.status).toBe(409);
  });

  it("drops the card when the reply claims the invoice was already made", async () => {
    await customer(owner.id, "Anna Laine");
    installModel([
      { call: "propose_invoice_draft", args: { customer: "Anna Laine", lines: [{ description: "Ripset", quantity: 1, unitPrice: 50 }] } },
      { say: "Loin laskun Anna Laineelle." },
    ]);
    const final = await ask(cookie, "Lasku Anna Laineelle 50 €");
    expect(final.limited).toBe(true);
    expect(final.proposal ?? null).toBeNull();
    expect(await prisma.salesInvoice.count({ where: { userId: owner.id } })).toBe(0);
  });

  it("creates nothing when rejected, and asks back when the customer is unclear", async () => {
    await customer(owner.id, "Anna Laine");
    await customer(owner.id, "Anna Lehto");
    const bodies = installModel([
      { call: "propose_invoice_draft", args: { customer: "Anna", lines: [{ description: "Ripset", quantity: 1, unitPrice: 50 }] } },
      { say: "Kumpi Anna?" },
    ]);
    const unclear = await ask(cookie, "Lasku Annalle 50 €");
    expect(unclear.proposal ?? null).toBeNull();
    expect(toolResults(bodies)[0]).toMatchObject({ ok: false, candidates: ["Anna Laine", "Anna Lehto"] });

    installModel([
      { call: "propose_invoice_draft", args: { customer: "Anna Laine", lines: [{ description: "Ripset", quantity: 1, unitPrice: 50 }] } },
      { say: "Ehdotus on alla." },
    ]);
    const final = await ask(cookie, "Lasku Anna Laineelle 50 €");
    const rejected = await decide(cookie, final.id!, "rejected");
    expect(rejected.body.proposal.status).toBe("rejected");
    expect(await prisma.salesInvoice.count({ where: { userId: owner.id } })).toBe(0);
  });
});

describe("propose_receipt_update", () => {
  it("changes the receipt only on Hyväksy, through the receipt edit", async () => {
    const receipt = await createReceipt(owner.id, { vendor: "Lumene", date: "2026-09-03", category: "muut", totalAmountCents: 4_990 });
    installModel([
      { call: "propose_receipt_update", args: { receiptId: receipt.id, category: "tarvikkeet", totalAmount: 59.9, vatLines: [{ rate: 25.5, amount: 12.17 }] } },
      { say: "Ehdotin kuitille uutta luokkaa ja summaa. Vahvista alta." },
    ]);
    const final = await ask(cookie, "Korjaa Lumenen kuitti tarvikkeisiin, summa oli 59,90");
    expect(final.proposal).toMatchObject({
      type: "receipt_update",
      receiptId: receipt.id,
      changes: expect.arrayContaining([
        expect.objectContaining({ field: "category", from: "Muut", to: "Tarvikkeet & ostot" }),
        expect.objectContaining({ field: "totalAmount" }),
      ]),
    });
    expect((await prisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } })).category).toBe("muut");

    const accepted = await decide(cookie, final.id!, "accepted");
    expect(accepted.response.status).toBe(200);
    expect(accepted.body.proposal).toMatchObject({ status: "accepted", href: `/kuitit/kuitti?id=${receipt.id}` });
    const updated = await prisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(updated).toMatchObject({ category: "tarvikkeet", totalAmountCents: 5_990 });
    expect(JSON.parse(updated.vatDetails!)).toEqual([{ rate: 25.5, amount: 12.17 }]);
    expect(await prisma.automationEvent.count({ where: { userId: owner.id, kind: "category", resourceId: receipt.id } })).toBe(1);
  });

  it("refuses on Hyväksy when the period was closed or the receipt changed meanwhile", async () => {
    const locked = await createReceipt(owner.id, { vendor: "Lukittu", date: "2026-08-03", category: "muut" });
    installModel([{ call: "propose_receipt_update", args: { receiptId: locked.id, category: "tarvikkeet" } }, { say: "Ehdotus alla." }]);
    const lockedTurn = await ask(cookie, "Korjaa luokka");
    await prisma.user.update({ where: { id: owner.id }, data: { booksLockedThrough: "2026-08" } });
    const refused = await decide(cookie, lockedTurn.id!, "accepted");
    expect(refused.response.status).toBeGreaterThanOrEqual(400);
    expect((await prisma.receipt.findUniqueOrThrow({ where: { id: locked.id } })).category).toBe("muut");
    expect(JSON.parse((await prisma.chatMessage.findUniqueOrThrow({ where: { id: lockedTurn.id! } })).proposalData!).status).toBeUndefined();

    const edited = await createReceipt(owner.id, { vendor: "Muokattu", date: "2026-09-03", category: "muut" });
    installModel([{ call: "propose_receipt_update", args: { receiptId: edited.id, vendor: "Lumene Oy" } }, { say: "Ehdotus alla." }]);
    const editedTurn = await ask(cookie, "Korjaa myyjä");
    await prisma.receipt.update({ where: { id: edited.id }, data: { notes: "käsin muutettu", updatedAt: new Date(Date.now() + 5_000) } });
    const conflict = await decide(cookie, editedTurn.id!, "accepted");
    expect(conflict.response.status).toBe(409);
    expect((await prisma.receipt.findUniqueOrThrow({ where: { id: edited.id } })).vendor).toBe("Muokattu");
  });

  it("carries the proposal on a non-streamed reply too", async () => {
    const receipt = await createReceipt(owner.id, { vendor: "Lumene", date: "2026-09-03", category: "muut" });
    // The non-streamed route prepares the turn twice (route, then processAiChatMessage): two scripts.
    installModel([
      { call: "propose_receipt_update", args: { receiptId: receipt.id, category: "tarvikkeet" } },
      { say: "Ehdotus alla." },
    ]);
    const response = await postChat(buildRequest("POST", "/api/ai/chat", { message: "Korjaa luokka", clientId: randomUUID() }, { cookie }));
    const body = await readJson(response);
    expect(response.status).toBe(200);
    expect(body.proposal).toMatchObject({ type: "receipt_update", receiptId: receipt.id });
    const stored = await prisma.chatMessage.findUniqueOrThrow({ where: { id: body.id } });
    expect(JSON.parse(stored.proposalData!).type).toBe("receipt_update");
  });

  it("never proposes a change to another owner's receipt or into a closed period", async () => {
    const theirs = await createReceipt(stranger.id, { vendor: "Vieras" });
    const { result } = await call(owner.id, "propose_receipt_update", { receiptId: theirs.id, category: "muut" });
    expect(result).toMatchObject({ ok: false });
    await prisma.user.update({ where: { id: owner.id }, data: { booksLockedThrough: "2026-08" } });
    const mine = await createReceipt(owner.id, { date: "2026-08-03", category: "muut" });
    expect((await call(owner.id, "propose_receipt_update", { receiptId: mine.id, category: "tarvikkeet" })).result).toMatchObject({ ok: false });
  });
});
