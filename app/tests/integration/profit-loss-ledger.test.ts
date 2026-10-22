import { beforeEach, describe, expect, it } from "vitest";
import { GET as profitLossRoute } from "@/app/api/reports/profit-loss/route";
import { GET as exportCsv } from "@/app/api/export/route";
import { GET as exportPackage } from "@/app/api/export/package/route";
import { GET as dashboard } from "@/app/api/dashboard/route";
import { prisma } from "@/lib/db";
import { loadAlvPeriodSources, profitLossOf } from "@/lib/alv-period";
import { loadCashflow } from "@/lib/koti-cashflow";
import { loadLedger } from "@/lib/ledger/load";
import { entriesBetween, incomeStatement } from "@/lib/ledger/reports";
import { readStoredZip } from "@/lib/zip-store";
import { createReceipt, createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, sessionCookie } from "./helpers/http";

/**
 * S1: the profit and loss and the ledger read the same documents. A purchase invoice no receipt
 * documents (rent, a bill typed in by hand) was posted by the ledger but missing from Raportit,
 * Koti, the CSV export and the accountant package, so Tulos ja tase and Raportit disagreed.
 */

let user: TestUser;
let cookie: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const WINDOW = { start: new Date("2026-03-01T00:00:00.000Z"), end: new Date("2026-05-01T00:00:00.000Z") };
const day = (value: string) => new Date(`${value}T00:00:00.000Z`);

async function salesInvoice(number: number, issue: string, status: string, netCents: number, documentKind = "invoice") {
  const customer = await prisma.customer.create({ data: { userId: user.id, name: "Asiakas Oy" } });
  const vatCents = Math.round(netCents * 0.255);
  return prisma.salesInvoice.create({
    data: {
      userId: user.id,
      customerId: customer.id,
      number,
      reference: `${number}0`,
      documentKind,
      issueDate: day(issue),
      dueDate: day(issue),
      status,
      netCents,
      vatCents,
      grossCents: netCents + vatCents,
      lines: { create: [{ description: "Ripsienpidennys", quantityMilli: 1000, unitPriceCents: netCents, vatRatePermille: 255, netCents }] },
    },
  });
}

async function purchaseInvoice(issue: string, grossCents: number, vatCents: number, overrides: Record<string, unknown> = {}) {
  return prisma.purchaseInvoice.create({
    data: {
      userId: user.id,
      supplierName: "Tukku Oy",
      issueDate: day(issue),
      dueDate: day(issue),
      status: "open",
      grossCents,
      vatCents,
      netCents: grossCents - vatCents,
      ...overrides,
    },
  });
}

/**
 * March and April 2026. Net figures in cents:
 *   income   10 000 + 2 000 (cash sale) - 1 000 (credit note)                    = 11 000
 *   expenses receipts 1 000 + 500 + 5 000; invoices 80 000 + 9 881 + 10 000 - 2 000 + 3 000 = 107 381
 */
async function seed() {
  await salesInvoice(1, "2026-03-10", "sent", 10_000);
  await salesInvoice(2, "2026-03-11", "draft", 5_000); // not part of the books
  await salesInvoice(3, "2026-04-02", "sent", -1_000, "credit_note");

  await createReceipt(user.id, { date: "2026-03-12", totalAmountCents: 1_255, vatDetails: '[{"rate":25.5,"amount":2.55}]', category: "tarvikkeet" });
  await createReceipt(user.id, { date: "2026-03-13", totalAmountCents: 500, vatDetails: null, category: null });
  await createReceipt(user.id, { type: "tulo", date: "2026-03-14", totalAmountCents: 2_510, vatDetails: '[{"rate":25.5,"amount":5.1}]', category: "muut_tulot" });
  await createReceipt(user.id, { date: "2026-03-15", totalAmountCents: 9_999, reviewStatus: "pending" }); // not approved

  // No receipt: the rent has no VAT of its own, the typed-in bill has.
  await purchaseInvoice("2026-03-01", 80_000, 0, { supplierName: "Kiinteistö Oy", category: "vuokra" });
  await purchaseInvoice("2026-03-05", 12_400, 2_519, { status: "paid", category: "tarvikkeet" });
  await purchaseInvoice("2026-03-08", 9_999, 0, { status: "cancelled" });
  // The same purchase twice, as the receipt and as the invoice linked to it: the receipt counts.
  const documented = await createReceipt(user.id, { date: "2026-03-20", totalAmountCents: 6_275, vatDetails: '[{"rate":25.5,"amount":12.75}]', vendor: "Ripsitukku Oy" });
  await purchaseInvoice("2026-03-20", 6_275, 1_275, { supplierName: "Ripsitukku Oy", receiptId: documented.id });
  // Reverse charge: no VAT on the document, the whole amount is the expense.
  await purchaseInvoice("2026-04-03", 10_000, 0, { vatTreatment: "eu_service", category: "ohjelmistot", supplierName: "Cloud Ltd" });
  // A supplier credit note is a negative expense.
  await purchaseInvoice("2026-04-10", -2_510, -510, { category: "tarvikkeet" });
  // Linked to a receipt that is not approved: that receipt is not counted, so the invoice is.
  const pending = await createReceipt(user.id, { date: "2026-04-15", totalAmountCents: 3_765, reviewStatus: "pending", vendor: "Kone Oy" });
  await purchaseInvoice("2026-04-15", 3_765, 765, { supplierName: "Kone Oy", receiptId: pending.id });
}

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
  await seed();
});

describe("S1: the profit and loss equals the ledger", () => {
  it("counts the purchase invoices no receipt documents, once, as the ledger posts them", async () => {
    const sources = await loadAlvPeriodSources(user.id, WINDOW.start, WINDOW.end);
    const report = profitLossOf(sources);
    expect(report.total).toMatchObject({
      incomeNetCents: 11_000,
      incomeVatCents: 2_805,
      expenseNetCents: 107_381,
      expenseGrossCents: 111_685,
      expenseVatCents: 4_304,
      profitNetCents: 11_000 - 107_381,
      purchaseInvoiceCount: 5,
    });
    // The linked invoice and the cancelled one are not among them.
    expect(sources.skippedPurchaseInvoiceCount).toBe(1);
    const rent = report.total.expenseByCategory.find((row) => row.category === "vuokra");
    expect(rent).toMatchObject({ grossCents: 80_000, vatCents: 0, netCents: 80_000, count: 1 });

    const entries = await loadLedger(user.id, WINDOW.end);
    const books = incomeStatement(entriesBetween(entries, "2026-03-01", "2026-05-01"));
    expect(report.total.incomeNetCents).toBe(books.revenueCents);
    expect(report.total.expenseNetCents).toBe(books.expensesCents);
    expect(report.total.profitNetCents).toBe(books.resultCents);

    // Month by month: the same invoice date puts a document in the same month in both.
    for (const [month, from, to] of [["2026-03", "2026-03-01", "2026-04-01"], ["2026-04", "2026-04-01", "2026-05-01"]]) {
      const period = report.months.find((candidate) => candidate.month === month)!;
      const monthBooks = incomeStatement(entriesBetween(entries, from, to));
      expect(period.incomeNetCents, month).toBe(monthBooks.revenueCents);
      expect(period.expenseNetCents, month).toBe(monthBooks.expensesCents);
      expect(period.profitNetCents, month).toBe(monthBooks.resultCents);
    }
  });

  it("has the purchase invoices in every report that reads the period's books", async () => {
    // Raportit
    const profitLoss: Json = await readJson(
      await profitLossRoute(buildRequest("GET", "/api/reports/profit-loss?from=2026-03&to=2026-04", undefined, { cookie }))
    );
    expect(profitLoss.total).toMatchObject({ expenseNet: 1073.81, expenseVat: 43.04, profitNet: -963.81, purchaseInvoiceCount: 5 });
    expect(profitLoss.months.map((month: Json) => month.purchaseInvoiceCount)).toEqual([2, 3]);

    // The CSV export: the Yhteensä row closes with the purchase invoice count.
    const csv = await (await exportCsv(buildRequest("GET", "/api/export?type=profit-loss&year=2026", undefined, { cookie }))).text();
    const total = csv.split(/\r?\n/).find((line) => line.includes("Yhteensä"))!;
    expect(total).toContain("1073,81");
    expect(total.endsWith(";5")).toBe(true);

    // The accountant package, for March.
    const march = readStoredZip(
      Buffer.from(await (await exportPackage(buildRequest("GET", "/api/export/package?month=2026-03", undefined, { cookie }))).arrayBuffer())
    );
    const packaged = JSON.parse(march.get("raportit/tuloslaskelma.json")!.toString("utf8"));
    expect(packaged).toMatchObject({ month: "2026-03", expenseNet: 963.81, purchaseInvoiceCount: 2 });

    // Koti: the month's expenses (gross, as the front page counts) and the cashflow bars.
    const koti: Json = await readJson(await dashboard(buildRequest("GET", "/api/dashboard?month=2026-03", undefined, { cookie })));
    expect(koti.expenses).toBe(1004.3);
    const cashflow = await loadCashflow(user.id, "2026-04", 2);
    expect(cashflow.map((month) => [month.month, month.expenses, month.source])).toEqual([
      ["2026-03", 1004.3, "kuitit"],
      ["2026-04", 112.55, "kuitit"],
    ]);
  });
});

describe("a figure opens the lists it is made of", () => {
  it("counts the purchase invoices in each category row, so a row can open Ostolaskut", async () => {
    const profitLoss: Json = await readJson(
      await profitLossRoute(buildRequest("GET", "/api/reports/profit-loss?from=2026-03&to=2026-04", undefined, { cookie }))
    );
    const rows = Object.fromEntries(
      profitLoss.total.expenseByCategory.map((row: Json) => [row.category, [row.count, row.purchaseInvoiceCount]])
    );
    // Rent is a purchase invoice alone; the supplies mix two receipts with a bill and a supplier credit note.
    expect(rows).toEqual({ vuokra: [1, 1], tarvikkeet: [4, 2], ohjelmistot: [1, 1], Luokittelematon: [2, 1] });
    const sum = (index: number) => Object.values<number[]>(rows).reduce((total, row) => total + row[index], 0);
    expect(sum(1)).toBe(profitLoss.total.purchaseInvoiceCount);
    // Income rows hold no purchase invoice.
    expect(profitLoss.total.incomeByCategory.every((row: Json) => row.purchaseInvoiceCount === 0)).toBe(true);
  });

  it("tells Koti how many of the month's costs are purchase invoices and how many are receipts", async () => {
    const march: Json = await readJson(await dashboard(buildRequest("GET", "/api/dashboard?month=2026-03", undefined, { cookie })));
    // March: the rent and the typed-in bill; three expense receipts (the linked invoice is that receipt's).
    expect(march).toMatchObject({ purchaseInvoiceCount: 2, expenseReceiptCount: 3 });
    const april: Json = await readJson(await dashboard(buildRequest("GET", "/api/dashboard?month=2026-04", undefined, { cookie })));
    expect(april).toMatchObject({ purchaseInvoiceCount: 3, expenseReceiptCount: 0 });
  });
});

async function booksOfWindow() {
  const sources = await loadAlvPeriodSources(user.id, WINDOW.start, WINDOW.end);
  const entries = await loadLedger(user.id, WINDOW.end);
  return { sources, report: profitLossOf(sources), books: incomeStatement(entriesBetween(entries, "2026-03-01", "2026-05-01")) };
}

describe("S1: a purchase invoice filed from an approved receipt counts once", () => {
  // fileReceiptAsPurchaseInvoice takes the invoice's VAT from the receipt's lines, so a bill without VAT
  // (insurance, exempt rent) ends up as a zero-VAT invoice linked to a receipt that is already an expense.
  const cases = [
    { name: "a receipt without VAT lines", vatDetails: null, invoiceVatCents: 0, treatment: "no_vat" },
    { name: "a receipt with a 0 % VAT line", vatDetails: '[{"rate":0,"amount":0}]', invoiceVatCents: 0, treatment: "no_vat" },
    { name: "a receipt whose VAT breakdown the return cannot use", vatDetails: null, invoiceVatCents: 6_000, treatment: "counted" },
  ];

  for (const { name, vatDetails, invoiceVatCents, treatment } of cases) {
    it(`takes the expense from the receipt only: ${name}`, async () => {
      const before = await booksOfWindow();
      const receipt = await createReceipt(user.id, {
        date: "2026-04-20",
        totalAmountCents: 30_000,
        vatDetails,
        vendor: "Vakuutus Oy",
        category: "vakuutukset",
      });
      const invoice = await purchaseInvoice("2026-04-20", 30_000, invoiceVatCents, {
        supplierName: "Vakuutus Oy",
        category: "vakuutukset",
        receiptId: receipt.id,
      });
      const after = await booksOfWindow();

      // The VAT return still classifies the invoice as before; only the books leave it out.
      expect(after.sources.purchaseInvoiceRows.find((row) => row.id === invoice.id)).toMatchObject({ treatment, receiptInBooks: true });

      expect(after.report.total.expenseGrossCents - before.report.total.expenseGrossCents).toBe(30_000);
      expect(after.report.total.expenseNetCents - before.report.total.expenseNetCents).toBe(30_000);
      expect(after.report.total.receiptCount).toBe(before.report.total.receiptCount + 1);
      expect(after.report.total.purchaseInvoiceCount).toBe(before.report.total.purchaseInvoiceCount);
      const insurance = after.report.total.expenseByCategory.find((row) => row.category === "vakuutukset");
      expect(insurance).toMatchObject({ grossCents: 30_000, netCents: 30_000, count: 1 });

      expect(after.books.expensesCents - before.books.expensesCents).toBe(30_000);
      expect(after.report.total.expenseNetCents).toBe(after.books.expensesCents);
      expect(after.report.total.profitNetCents).toBe(after.books.resultCents);
    });
  }
});

describe("S1: a receipt is booked the way the ledger posts it", () => {
  // The ledger takes a receipt's own VAT off the cost under `domestic` only. Reverse charge nets out in
  // the VAT accounts and foreign VAT is not deductible, so the whole amount is the expense.
  const foreign = ["eu_service", "eu_goods", "non_eu_service", "non_eu_goods", "foreign_vat_charged"];

  for (const vatTreatment of foreign) {
    it(`books the whole amount of a ${vatTreatment} receipt that has VAT lines`, async () => {
      const before = await booksOfWindow();
      await createReceipt(user.id, {
        date: "2026-04-21",
        totalAmountCents: 10_000,
        vatDetails: '[{"rate":25.5,"amount":20.32}]',
        category: "ohjelmistot",
        vatTreatment,
      });
      const after = await booksOfWindow();

      expect(after.report.total.expenseGrossCents - before.report.total.expenseGrossCents).toBe(10_000);
      expect(after.report.total.expenseVatCents - before.report.total.expenseVatCents).toBe(0);
      expect(after.report.total.expenseNetCents - before.report.total.expenseNetCents).toBe(10_000);
      expect(after.books.expensesCents - before.books.expensesCents).toBe(10_000);
      expect(after.report.total.expenseNetCents).toBe(after.books.expensesCents);
      expect(after.report.total.profitNetCents).toBe(after.books.resultCents);
    });
  }

  it("still takes the VAT of a domestic receipt off its cost", async () => {
    const before = await booksOfWindow();
    await createReceipt(user.id, { date: "2026-04-21", totalAmountCents: 10_000, vatDetails: '[{"rate":25.5,"amount":20.32}]', vatTreatment: "domestic" });
    const after = await booksOfWindow();
    expect(after.report.total.expenseNetCents - before.report.total.expenseNetCents).toBe(7_968);
    expect(after.books.expensesCents - before.books.expensesCents).toBe(7_968);
  });

  // A refund or a supplier's credit note is stored negative on every intake path; the ledger posts the
  // mirror of a purchase, so the expense goes down. The profit and loss took its magnitude and added it.
  const refunds = [
    { name: "a refund receipt with negative VAT lines", type: "meno", total: -5_020, vat: '[{"rate":25.5,"amount":-10.2}]', expense: -4_000, income: 0 },
    { name: "a refund receipt without VAT lines", type: "meno", total: -3_000, vat: null, expense: -3_000, income: 0 },
    { name: "a refund of income with negative VAT lines", type: "tulo", total: -2_510, vat: '[{"rate":25.5,"amount":-5.1}]', expense: 0, income: -2_000 },
  ];

  for (const { name, type, total, vat, expense, income } of refunds) {
    it(`takes ${name} off the figures, as the ledger does`, async () => {
      const before = await booksOfWindow();
      await createReceipt(user.id, { type, date: "2026-04-22", totalAmountCents: total, vatDetails: vat, category: type === "tulo" ? "muut_tulot" : "tarvikkeet" });
      const after = await booksOfWindow();

      expect(after.report.total.expenseNetCents - before.report.total.expenseNetCents).toBe(expense);
      expect(after.report.total.incomeNetCents - before.report.total.incomeNetCents).toBe(income);
      expect(after.books.expensesCents - before.books.expensesCents).toBe(expense);
      expect(after.books.revenueCents - before.books.revenueCents).toBe(income);
      expect(after.report.total.incomeNetCents).toBe(after.books.revenueCents);
      expect(after.report.total.expenseNetCents).toBe(after.books.expensesCents);
      expect(after.report.total.profitNetCents).toBe(after.books.resultCents);

      // The month it is dated in agrees too.
      const entries = await loadLedger(user.id, WINDOW.end);
      const april = incomeStatement(entriesBetween(entries, "2026-04-01", "2026-05-01"));
      const period = after.report.months.find((candidate) => candidate.month === "2026-04")!;
      expect(period.expenseNetCents).toBe(april.expensesCents);
      expect(period.incomeNetCents).toBe(april.revenueCents);
    });
  }
});
