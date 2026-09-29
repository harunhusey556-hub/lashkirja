/**
 * Profit and loss (tuloslaskelma) built from receipts and sales invoices.
 *
 * Documents, not bank rows, are the source: only a receipt or an invoice
 * carries the VAT breakdown. A receipt whose VAT is unknown is counted at its
 * gross amount and reported in `missingVat`, never silently assumed to be
 * 25,5 % - a guessed VAT figure in a P&L is worse than a visible gap.
 *
 * Sales invoices count by invoice date, the same basis as the VAT return
 * (see ./alv-period). A credit note is negative income in its own month.
 */
import { parseVatDetails } from "./alv";
import { monthKey } from "./bank-balances";
import { centsToEuros } from "./money";

export interface ReportReceipt {
  type: string; // "tulo" | "meno"
  date: Date | string | null;
  totalAmountCents: number | null;
  category: string | null;
  vatDetails: string | null;
}

/** A booked sales invoice or credit note; totals are signed (credit note < 0). */
export interface ReportInvoice {
  issueDate: Date | string;
  documentKind: "invoice" | "credit_note";
  netCents: number;
  vatCents: number;
  grossCents: number;
}

/** Category rows the invoices land in, so the drill-down can tell them apart. */
export const INVOICE_CATEGORY = "Myyntilaskut";
export const CREDIT_NOTE_CATEGORY = "Hyvityslaskut";

export interface CategoryRow {
  category: string;
  grossCents: number;
  vatCents: number;
  netCents: number;
  count: number;
}

export interface ProfitLossPeriod {
  month: string | null;
  incomeGrossCents: number;
  incomeVatCents: number;
  incomeNetCents: number;
  expenseGrossCents: number;
  expenseVatCents: number;
  expenseNetCents: number;
  /** Net of VAT: what the business actually earned. */
  profitNetCents: number;
  /** Cash view: gross in minus gross out. */
  profitGrossCents: number;
  incomeByCategory: CategoryRow[];
  expenseByCategory: CategoryRow[];
  receiptCount: number;
  /** Ordinary sales invoices counted in the period. */
  invoiceCount: number;
  /** Credit notes counted (negative) in the period. */
  creditNoteCount: number;
  missingVatCount: number;
  uncategorisedCount: number;
}

export const UNCATEGORISED = "Luokittelematon";

function monthOf(value: Date | string): string {
  return monthKey(value);
}

function emptyPeriod(month: string | null): ProfitLossPeriod {
  return {
    month,
    incomeGrossCents: 0,
    incomeVatCents: 0,
    incomeNetCents: 0,
    expenseGrossCents: 0,
    expenseVatCents: 0,
    expenseNetCents: 0,
    profitNetCents: 0,
    profitGrossCents: 0,
    incomeByCategory: [],
    expenseByCategory: [],
    receiptCount: 0,
    invoiceCount: 0,
    creditNoteCount: 0,
    missingVatCount: 0,
    uncategorisedCount: 0,
  };
}

interface Accumulator {
  period: ProfitLossPeriod;
  income: Map<string, CategoryRow>;
  expense: Map<string, CategoryRow>;
}

function newAccumulator(month: string | null): Accumulator {
  return { period: emptyPeriod(month), income: new Map(), expense: new Map() };
}

function addToCategory(
  target: Map<string, CategoryRow>,
  category: string,
  grossCents: number,
  vatCents: number
): void {
  const row = target.get(category) ?? {
    category,
    grossCents: 0,
    vatCents: 0,
    netCents: 0,
    count: 0,
  };
  row.grossCents += grossCents;
  row.vatCents += vatCents;
  row.netCents += grossCents - vatCents;
  row.count += 1;
  target.set(category, row);
}

function finish(accumulator: Accumulator): ProfitLossPeriod {
  const byGross = (a: CategoryRow, b: CategoryRow) => b.grossCents - a.grossCents;
  const period = accumulator.period;
  period.incomeByCategory = [...accumulator.income.values()].sort(byGross);
  period.expenseByCategory = [...accumulator.expense.values()].sort(byGross);
  period.incomeNetCents = period.incomeGrossCents - period.incomeVatCents;
  period.expenseNetCents = period.expenseGrossCents - period.expenseVatCents;
  period.profitNetCents = period.incomeNetCents - period.expenseNetCents;
  period.profitGrossCents = period.incomeGrossCents - period.expenseGrossCents;
  return period;
}

export interface ProfitLossResult {
  total: ProfitLossPeriod;
  months: ProfitLossPeriod[];
  /** Receipts with no date cannot be placed in a month. */
  undatedCount: number;
}

export function buildProfitLoss(
  receipts: ReportReceipt[],
  invoices: ReportInvoice[] = []
): ProfitLossResult {
  const total = newAccumulator(null);
  const byMonth = new Map<string, Accumulator>();
  let undatedCount = 0;

  const monthAccumulator = (value: Date | string): Accumulator => {
    const month = monthOf(value);
    const existing = byMonth.get(month) ?? newAccumulator(month);
    byMonth.set(month, existing);
    return existing;
  };

  for (const invoice of invoices) {
    const isCredit = invoice.documentKind === "credit_note";
    const category = isCredit ? CREDIT_NOTE_CATEGORY : INVOICE_CATEGORY;
    for (const target of [total, monthAccumulator(invoice.issueDate)]) {
      if (isCredit) target.period.creditNoteCount += 1;
      else target.period.invoiceCount += 1;
      // Signed: a credit note reduces income, it is never an expense.
      target.period.incomeGrossCents += invoice.grossCents;
      target.period.incomeVatCents += invoice.vatCents;
      addToCategory(target.income, category, invoice.grossCents, invoice.vatCents);
    }
  }

  for (const receipt of receipts) {
    const grossCents = receipt.totalAmountCents;
    if (grossCents === null || grossCents === undefined) continue;
    const gross = Math.abs(grossCents);

    const vatLines = parseVatDetails(receipt.vatDetails);
    const vatCents = vatLines
      ? vatLines.reduce((sum, line) => sum + Math.abs(line.amountCents), 0)
      : 0;
    const category = receipt.category?.trim() || UNCATEGORISED;
    const isIncome = receipt.type === "tulo";

    const targets: Accumulator[] = [total];
    if (receipt.date) {
      targets.push(monthAccumulator(receipt.date));
    } else {
      undatedCount += 1;
    }

    for (const target of targets) {
      target.period.receiptCount += 1;
      if (!vatLines) target.period.missingVatCount += 1;
      if (category === UNCATEGORISED) target.period.uncategorisedCount += 1;
      if (isIncome) {
        target.period.incomeGrossCents += gross;
        target.period.incomeVatCents += vatCents;
        addToCategory(target.income, category, gross, vatCents);
      } else {
        target.period.expenseGrossCents += gross;
        target.period.expenseVatCents += vatCents;
        addToCategory(target.expense, category, gross, vatCents);
      }
    }
  }

  return {
    total: finish(total),
    months: [...byMonth.values()]
      .map(finish)
      .sort((a, b) => (a.month! < b.month! ? -1 : a.month! > b.month! ? 1 : 0)),
    undatedCount,
  };
}

/** Euro-facing shape for the API. */
export function periodToEuros(period: ProfitLossPeriod) {
  const rows = (list: CategoryRow[]) =>
    list.map((row) => ({
      category: row.category,
      gross: centsToEuros(row.grossCents),
      vat: centsToEuros(row.vatCents),
      net: centsToEuros(row.netCents),
      count: row.count,
    }));

  return {
    month: period.month,
    incomeGross: centsToEuros(period.incomeGrossCents),
    incomeVat: centsToEuros(period.incomeVatCents),
    incomeNet: centsToEuros(period.incomeNetCents),
    expenseGross: centsToEuros(period.expenseGrossCents),
    expenseVat: centsToEuros(period.expenseVatCents),
    expenseNet: centsToEuros(period.expenseNetCents),
    profitNet: centsToEuros(period.profitNetCents),
    profitGross: centsToEuros(period.profitGrossCents),
    incomeByCategory: rows(period.incomeByCategory),
    expenseByCategory: rows(period.expenseByCategory),
    receiptCount: period.receiptCount,
    invoiceCount: period.invoiceCount,
    creditNoteCount: period.creditNoteCount,
    missingVatCount: period.missingVatCount,
    uncategorisedCount: period.uncategorisedCount,
  };
}
