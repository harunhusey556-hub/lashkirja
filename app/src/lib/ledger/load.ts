import { prisma } from "../db";
import { parseVatDetails } from "../alv";
import { bookedSalesWhere, classifyPurchaseInvoices, loadCountedReceipts } from "../alv-period";
import { computeInvoiceTotals } from "../invoices";
import { postAll, type JournalEntry, type SourceDocument } from "./posting";

/**
 * The owner's documents up to `end`, as the VAT return counts them (the same
 * loaders, so the books and the return never disagree), posted to journal
 * entries. Everything from the first document is loaded: the balance sheet
 * needs every earlier entry, not only the period's.
 */

const BEGINNING = new Date("2000-01-01T00:00:00.000Z");
const day = (date: Date) => date.toISOString().slice(0, 10);

export async function loadLedgerDocuments(userId: string, end: Date): Promise<SourceDocument[]> {
  const [{ counted }, invoices, purchaseRows] = await Promise.all([
    loadCountedReceipts(userId, BEGINNING, end),
    prisma.salesInvoice.findMany({
      where: bookedSalesWhere(userId, BEGINNING, end),
      include: { lines: true, customer: { select: { name: true } }, payments: true },
    }),
    classifyPurchaseInvoices(userId, BEGINNING, end),
  ]);

  const docs: SourceDocument[] = [];

  for (const invoice of invoices) {
    const totals = computeInvoiceTotals(
      invoice.lines.map((line) => ({
        quantityMilli: line.quantityMilli,
        unitPriceCents: line.unitPriceCents,
        vatRatePermille: line.vatRatePermille,
      }))
    );
    const kind = invoice.documentKind === "credit_note" ? "Hyvityslasku" : "Myyntilasku";
    docs.push({
      kind: "sales_invoice",
      id: invoice.id,
      date: day(invoice.issueDate),
      label: `${kind} ${invoice.number ?? ""} ${invoice.customer?.name ?? ""}`.replace(/\s+/g, " ").trim(),
      breakdown: totals.breakdown.map((row) => ({ rate: row.ratePermille / 10, netCents: row.netCents, vatCents: row.vatCents })),
    });
    for (const payment of invoice.payments) {
      if (payment.paidDate >= end) continue;
      docs.push({
        kind: "invoice_payment",
        id: payment.id,
        date: day(payment.paidDate),
        label: `Suoritus, lasku ${invoice.number ?? ""} ${invoice.customer?.name ?? ""}`.replace(/\s+/g, " ").trim(),
        amountCents: payment.amountCents,
      });
    }
  }

  for (const receipt of counted) {
    if (!receipt.date || receipt.totalAmountCents == null) continue;
    if (receipt.type !== "meno" && receipt.type !== "tulo") continue;
    docs.push({
      kind: "receipt",
      id: receipt.id,
      date: day(receipt.date),
      label: `${receipt.type === "tulo" ? "Tulo" : "Kuitti"} ${receipt.vendor ?? ""}`.trim(),
      type: receipt.type,
      category: receipt.category,
      grossCents: Math.abs(receipt.totalAmountCents),
      vatLines: parseVatDetails(receipt.vatDetails),
      vatTreatment: receipt.vatTreatment,
      paidFromBank: Boolean(receipt.linkedTransaction || receipt.sourceTransactionId),
    });
  }

  // Purchase invoices the return counts on their own. One documented by a receipt is already
  // in the books through that receipt (paid from the bank): neither it nor its payments post again.
  const countedIds = purchaseRows
    .filter((row) => row.treatment === "counted" || row.treatment === "no_vat")
    .map((row) => row.id);
  if (countedIds.length > 0) {
    const purchases = await prisma.purchaseInvoice.findMany({
      where: { id: { in: countedIds } },
      include: { payments: true },
    });
    for (const purchase of purchases) {
      docs.push({
        kind: "purchase_invoice",
        id: purchase.id,
        date: day(purchase.issueDate),
        label: `Ostolasku ${purchase.invoiceNumber ?? ""} ${purchase.supplierName}`.replace(/\s+/g, " ").trim(),
        category: purchase.category,
        grossCents: purchase.grossCents,
        vatCents: purchase.vatCents,
        vatTreatment: purchase.vatTreatment,
      });
      for (const payment of purchase.payments) {
        if (payment.paidDate >= end) continue;
        docs.push({
          kind: "purchase_payment",
          id: payment.id,
          date: day(payment.paidDate),
          label: `Maksu, ostolasku ${purchase.supplierName}`,
          amountCents: payment.amountCents,
        });
      }
    }
  }
  return docs;
}

export async function loadLedger(userId: string, end: Date): Promise<JournalEntry[]> {
  return postAll(await loadLedgerDocuments(userId, end));
}
