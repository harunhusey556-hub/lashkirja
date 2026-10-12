import { reverseChargeRate, type VatLine } from "../alv";
import { accountOf, expenseAccount, salesAccount, type AccountKey } from "./chart";

/**
 * The posting engine: every source document becomes one balanced journal entry
 * (tosite) of debit and credit lines. Pure — the loader (load.ts) supplies the
 * documents and the reports (reports.ts) read the entries. The invariant
 * Σ debit = Σ credit is checked for every entry; an entry that would not
 * balance throws instead of entering the books.
 *
 * v1 is derived: entries are rebuilt from the documents each time, so they
 * always agree with the VAT return and never drift. Persisted, immutable
 * vouchers are the next step (.plans/2026-10-08-review-followup.md).
 */

export interface JournalLine {
  account: string;
  debitCents: number;
  creditCents: number;
}

export interface JournalEntry {
  /** `${sourceType}:${sourceId}` — stable, so the same document is the same entry. */
  id: string;
  /** YYYY-MM-DD */
  date: string;
  description: string;
  sourceType: SourceDocument["kind"];
  sourceId: string;
  lines: JournalLine[];
}

export type SourceDocument =
  | {
      kind: "sales_invoice";
      id: string;
      date: string;
      label: string;
      /** Per VAT rate; a credit note's rows are negative. */
      breakdown: Array<{ rate: number; netCents: number; vatCents: number }>;
    }
  | { kind: "invoice_payment"; id: string; date: string; label: string; amountCents: number }
  | {
      kind: "purchase_invoice";
      id: string;
      date: string;
      label: string;
      category: string | null;
      grossCents: number;
      vatCents: number;
      vatTreatment: string;
    }
  | { kind: "purchase_payment"; id: string; date: string; label: string; amountCents: number }
  | {
      kind: "receipt";
      id: string;
      date: string;
      label: string;
      type: "meno" | "tulo";
      category: string | null;
      grossCents: number;
      vatLines: VatLine[] | null;
      vatTreatment: string;
      /** Paid through the business bank account (a linked or source bank row). */
      paidFromBank: boolean;
    };

export class UnbalancedEntryError extends Error {
  constructor(readonly entryId: string, readonly differenceCents: number) {
    super(`Tosite ${entryId} ei täsmää: debet − kredit = ${differenceCents} senttiä`);
    this.name = "UnbalancedEntryError";
  }
}

/** Signed amounts per account (positive = debit) to merged, non-zero, balanced lines. */
function balanced(id: string, amounts: Array<[AccountKey, number]>): JournalLine[] {
  const byAccount = new Map<string, number>();
  for (const [key, cents] of amounts) {
    const code = accountOf(key).code;
    byAccount.set(code, (byAccount.get(code) ?? 0) + cents);
  }
  const lines: JournalLine[] = [];
  let difference = 0;
  for (const [account, cents] of byAccount) {
    if (cents === 0) continue;
    difference += cents;
    lines.push({ account, debitCents: cents > 0 ? cents : 0, creditCents: cents < 0 ? -cents : 0 });
  }
  if (difference !== 0) throw new UnbalancedEntryError(id, difference);
  return lines;
}

const REVERSE_CHARGE = new Set(["eu_service", "eu_goods", "non_eu_service"]);

/**
 * A purchase's debit side: the expense, deductible VAT and, under reverse
 * charge, the self-assessed VAT owed. Returns the amounts to credit the payer with.
 */
function purchaseSide(
  category: string | null,
  grossCents: number,
  documentVatCents: number,
  vatTreatment: string,
  date: string
): Array<[AccountKey, number]> {
  const expense = expenseAccount(category);
  if (vatTreatment === "domestic" || vatTreatment === "") {
    return [
      [expense, grossCents - documentVatCents],
      ["inputVat", documentVatCents],
    ];
  }
  if (REVERSE_CHARGE.has(vatTreatment)) {
    const base = grossCents - documentVatCents;
    const tax = Math.round((base * reverseChargeRate(date)) / 100);
    return [
      [expense, grossCents],
      ["inputVat", tax],
      ["outputVat", -tax],
    ];
  }
  // foreign_vat_charged (not deductible) and non_eu_goods (import VAT outside the app): all expense.
  return [[expense, grossCents]];
}

export function postDocument(doc: SourceDocument): JournalEntry {
  const id = `${doc.kind}:${doc.id}`;
  const entry = (description: string, amounts: Array<[AccountKey, number]>): JournalEntry => ({
    id,
    date: doc.date,
    description,
    sourceType: doc.kind,
    sourceId: doc.id,
    lines: balanced(id, amounts),
  });

  switch (doc.kind) {
    case "sales_invoice": {
      const gross = doc.breakdown.reduce((sum, row) => sum + row.netCents + row.vatCents, 0);
      return entry(doc.label, [
        ["receivables", gross],
        ...doc.breakdown.flatMap((row): Array<[AccountKey, number]> => [
          [salesAccount(row.rate), -row.netCents],
          ["outputVat", -row.vatCents],
        ]),
      ]);
    }
    case "invoice_payment":
      return entry(doc.label, [
        ["bank", doc.amountCents],
        ["receivables", -doc.amountCents],
      ]);
    case "purchase_invoice":
      return entry(doc.label, [
        ...purchaseSide(doc.category, doc.grossCents, doc.vatCents, doc.vatTreatment, doc.date),
        ["payables", -doc.grossCents],
      ]);
    case "purchase_payment":
      return entry(doc.label, [
        ["payables", doc.amountCents],
        ["bank", -doc.amountCents],
      ]);
    case "receipt": {
      const payer: AccountKey = doc.paidFromBank ? "bank" : "suspense";
      const vatCents = (doc.vatLines ?? []).reduce((sum, line) => sum + line.amountCents, 0);
      if (doc.type === "meno") {
        return entry(doc.label, [
          ...purchaseSide(doc.category, doc.grossCents, vatCents, doc.vatTreatment, doc.date),
          [payer, -doc.grossCents],
        ]);
      }
      // Income: revenue per VAT rate, the rounding rest with the largest line (or other income).
      const revenue: Array<[AccountKey, number]> = [];
      let netTotal = 0;
      const lines = doc.vatLines ?? [];
      for (const line of lines) {
        if (line.rate <= 0) continue;
        const net = Math.round((line.amountCents * 100) / line.rate);
        revenue.push([salesAccount(line.rate), -net]);
        netTotal += net;
      }
      const rest = doc.grossCents - vatCents - netTotal;
      if (rest !== 0) {
        const hasZero = lines.some((line) => line.rate === 0);
        const largest = [...lines].filter((line) => line.rate > 0).sort((a, b) => b.amountCents - a.amountCents)[0];
        const restAccount: AccountKey = hasZero ? "sales0" : largest ? salesAccount(largest.rate) : "otherIncome";
        revenue.push([restAccount, -rest]);
      }
      return entry(doc.label, [[payer, doc.grossCents], ...revenue, ["outputVat", -vatCents]]);
    }
  }
}

/** Every document posted, oldest first (ties by source type and id, so the order is stable). */
export function postAll(docs: SourceDocument[]): JournalEntry[] {
  return docs
    .map(postDocument)
    .sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : a.date < b.date ? -1 : 1));
}
