/**
 * Matching outgoing bank rows to purchase invoices (ostolaskut) by hand: the
 * owner opens an invoice and picks the bank row that paid it, or opens a bank
 * row and picks the invoice. The ranking is the match gate's (match-gate.ts:
 * exact amount, viite / invoice number, supplier name vs counterparty, date
 * around the due date) with one payables addition: a small difference from
 * the open amount (a bank fee, rounding) still ranks, flagged "summa poikkeaa
 * X €". Nothing here is applied automatically; the owner confirms, and the
 * link is the ordinary payment with a `transactionId` (recordPurchasePayment).
 */
import { prisma } from "./db";
import { AppError, NotFoundError, ValidationError } from "./api-errors";
import { centsToEuros } from "./money";
import { formatEur } from "./format";
import { ELIGIBLE_MIN, gatePair, RELATED_MAX, type GateCandidate, type GateRow } from "./match-gate";

/** A difference of up to 2 € or 0.5 % of the amount owed counts as a fee. */
export const FEE_TOLERANCE_CENTS = 2_00;
export const FEE_TOLERANCE_RATIO = 0.005;
/** The most rows or invoices one list returns. */
export const PURCHASE_CANDIDATE_LIMIT = 30;
/** Without a search, rows this far around the invoice are listed even with no signal. */
const WINDOW_BEFORE_ISSUE_DAYS = 30;
const WINDOW_AFTER_DUE_DAYS = 90;
const DAY_MS = 86_400_000;

export interface PurchaseSide {
  id: string;
  supplierName: string;
  supplierIban: string | null;
  reference: string | null;
  invoiceNumber: string | null;
  issueDate: Date;
  dueDate: Date;
  grossCents: number;
  /** Still owed; equals the gross on an unpaid invoice. */
  openCents: number;
}

export interface PurchaseBankRow {
  id: string;
  date: Date | null;
  /** Signed: a payment out is negative. */
  amountCents: number;
  counterparty: string | null;
  reference: string | null;
  message: string | null;
}

export interface PurchasePairScore {
  score: number;
  /** The gate would suggest this pair on its own (exact amount + identity, or a viite). */
  eligible: boolean;
  exactAmount: boolean;
  /** Bank amount minus the amount owed, when it is a fee-sized difference; null otherwise. */
  amountDiffCents: number | null;
  /** Finnish reasons for "Miksi". */
  reasons: string[];
  /** Bank date minus the due date, whole days; null without a bank date. */
  dueGapDays: number | null;
}

/** The fee-sized difference between what the bank row paid and what is owed, or null. */
export function feeDifferenceCents(paidCents: number, invoice: Pick<PurchaseSide, "grossCents" | "openCents">): number | null {
  const owed = invoice.openCents > 0 ? invoice.openCents : invoice.grossCents;
  const diff = paidCents - owed;
  if (diff === 0) return null;
  const tolerance = Math.max(FEE_TOLERANCE_CENTS, Math.round(owed * FEE_TOLERANCE_RATIO));
  return Math.abs(diff) <= tolerance ? diff : null;
}

function gateRow(row: PurchaseBankRow): GateRow {
  return { ...row, amountCents: Math.abs(row.amountCents), counterpartyIban: null };
}

function gateCandidate(invoice: PurchaseSide): GateCandidate {
  return {
    id: invoice.id,
    kind: "lasku",
    date: invoice.issueDate,
    dueDate: invoice.dueDate,
    amountCents: invoice.grossCents,
    openCents: invoice.openCents,
    party: invoice.supplierName,
    reference: invoice.reference,
    invoiceNumber: invoice.invoiceNumber,
    iban: invoice.supplierIban,
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** One bank row against one purchase invoice. */
export function scorePurchasePair(row: PurchaseBankRow, invoice: PurchaseSide): PurchasePairScore {
  const verdict = gatePair(gateRow(row), gateCandidate(invoice));
  const exactAmount = verdict.signals.amount !== null;
  const diff = exactAmount ? null : feeDifferenceCents(Math.abs(row.amountCents), invoice);
  const reasons = [...verdict.reasons];
  let score = verdict.score;

  if (diff !== null) {
    // Placed where "summa sama" would be: after the viite, before the name.
    reasons.splice(verdict.signals.reference ? 1 : 0, 0, `summa poikkeaa ${formatEur(centsToEuros(Math.abs(diff)))}`);
    const identity = verdict.signals.reference || verdict.signals.iban || verdict.signals.name > 0;
    if (verdict.eligible) {
      score = Math.min(0.99, score + 0.02);
    } else {
      // Close to the amount and from the supplier: under every eligible pair, over an amount alone.
      score = Math.min(identity ? ELIGIBLE_MIN - 0.01 : RELATED_MAX, score + (identity ? 0.25 : 0.1));
    }
  }

  const dueGapDays = row.date ? Math.round((row.date.getTime() - invoice.dueDate.getTime()) / DAY_MS) : null;
  return {
    score: round3(score),
    eligible: verdict.eligible,
    exactAmount,
    amountDiffCents: diff,
    reasons,
    dueGapDays,
  };
}

/** Best first: score, then the bank date nearest the due date, then the newest row. */
export function rankPurchasePairs<T>(
  pairs: Array<{ row: PurchaseBankRow; invoice: PurchaseSide; item: T }>
): Array<{ item: T; row: PurchaseBankRow; invoice: PurchaseSide; score: PurchasePairScore }> {
  return pairs
    .map((pair) => ({ ...pair, score: scorePurchasePair(pair.row, pair.invoice) }))
    .sort((a, b) => {
      if (b.score.score !== a.score.score) return b.score.score - a.score.score;
      const gap = (value: number | null) => (value === null ? Number.MAX_SAFE_INTEGER : Math.abs(value));
      const byGap = gap(a.score.dueGapDays) - gap(b.score.dueGapDays);
      if (byGap !== 0) return byGap;
      return (b.row.date?.getTime() ?? 0) - (a.row.date?.getTime() ?? 0);
    });
}

/** Free text over names and messages, or an amount typed as "124,50", "124.5" or "124,50 €". */
export function matchesPurchaseSearch(
  query: string,
  texts: Array<string | null | undefined>,
  amountCents: number
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (texts.some((text) => text?.toLowerCase().includes(q))) return true;
  const numeric = q.replace(/[\s €]/g, "").replace(",", ".");
  if (!/^\d+(\.\d{0,2})?$/.test(numeric)) return false;
  const amountText = (Math.abs(amountCents) / 100).toFixed(2);
  return amountText.startsWith(numeric);
}

/* ------------------------------ database side ------------------------------ */

function isoDay(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

function openCentsOf(invoice: { grossCents: number; payments: Array<{ amountCents: number }> }): number {
  return invoice.grossCents - invoice.payments.reduce((sum, payment) => sum + payment.amountCents, 0);
}

export interface PurchaseBankCandidate {
  transactionId: string;
  statementId: string;
  date: string | null;
  counterparty: string | null;
  message: string | null;
  reference: string | null;
  /** What the row paid, as a positive amount. */
  amount: number;
  score: number;
  exactAmount: boolean;
  /** Bank amount minus the amount owed, in euros, when a fee-sized difference. */
  amountDiff: number | null;
  reasons: string[];
}

export interface PurchaseBankCandidateList {
  candidates: PurchaseBankCandidate[];
  /** Matching rows before the cap. */
  total: number;
  /** Months that have offerable rows (for the month chips), newest first. */
  months: Array<{ month: string; count: number }>;
}

/**
 * Outgoing bank rows that may have paid this purchase invoice: the owner's own,
 * not yet a purchase or sales payment, and not documented by another receipt
 * (a row confirmed to this invoice's own receipt is the same purchase and is
 * offered). Best first, at most PURCHASE_CANDIDATE_LIMIT.
 */
export async function listBankRowsForPurchase(
  userId: string,
  invoiceId: string,
  options: { q?: string | null; month?: string | null } = {}
): Promise<PurchaseBankCandidateList> {
  const invoice = await prisma.purchaseInvoice.findFirst({
    where: { id: invoiceId, userId },
    include: { payments: { select: { amountCents: true } } },
  });
  if (!invoice) throw new NotFoundError("Ostolaskua ei löytynyt.");

  const rows = await prisma.transaction.findMany({
    where: {
      statement: { userId },
      amountCents: { lt: 0 },
      purchasePayment: null,
      invoicePayment: null,
      OR: [{ receiptId: null }, ...(invoice.receiptId ? [{ receiptId: invoice.receiptId }] : [])],
    },
    select: {
      id: true,
      statementId: true,
      date: true,
      amountCents: true,
      counterparty: true,
      reference: true,
      message: true,
      statement: { select: { periodMonth: true } },
    },
  });

  const side: PurchaseSide = { ...invoice, openCents: openCentsOf(invoice) };
  const q = options.q?.trim() ?? "";
  const monthOf = (row: (typeof rows)[number]) => isoDay(row.date)?.slice(0, 7) ?? row.statement.periodMonth ?? "";
  const searched = rows.filter((row) =>
    matchesPurchaseSearch(q, [row.counterparty, row.message, row.reference], row.amountCents)
  );

  const months = new Map<string, number>();
  for (const row of searched) {
    const key = monthOf(row);
    if (key) months.set(key, (months.get(key) ?? 0) + 1);
  }

  const windowStart = side.issueDate.getTime() - WINDOW_BEFORE_ISSUE_DAYS * DAY_MS;
  const windowEnd = side.dueDate.getTime() + WINDOW_AFTER_DUE_DAYS * DAY_MS;
  const ranked = rankPurchasePairs(
    searched
      .filter((row) => !options.month || monthOf(row) === options.month)
      .map((row) => ({ row, invoice: side, item: row }))
  ).filter(
    (entry) =>
      // Searching or picking a month shows every hit; the plain list keeps to likely rows.
      q !== "" ||
      Boolean(options.month) ||
      entry.score.score > 0 ||
      (entry.row.date !== null && entry.row.date.getTime() >= windowStart && entry.row.date.getTime() <= windowEnd)
  );

  return {
    candidates: ranked.slice(0, PURCHASE_CANDIDATE_LIMIT).map(({ item, score }) => ({
      transactionId: item.id,
      statementId: item.statementId,
      date: isoDay(item.date),
      counterparty: item.counterparty,
      message: item.message,
      reference: item.reference,
      amount: centsToEuros(Math.abs(item.amountCents)),
      score: score.score,
      exactAmount: score.exactAmount,
      amountDiff: score.amountDiffCents === null ? null : centsToEuros(score.amountDiffCents),
      reasons: score.reasons,
    })),
    total: ranked.length,
    months: [...months.entries()]
      .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
      .map(([month, count]) => ({ month, count })),
  };
}

export interface PurchaseInvoiceCandidate {
  invoice: {
    id: string;
    supplierName: string;
    invoiceNumber: string | null;
    reference: string | null;
    issueDate: string;
    dueDate: string;
    gross: number;
    open: number;
  };
  score: number;
  exactAmount: boolean;
  amountDiff: number | null;
  reasons: string[];
}

/** Open purchase invoices that one outgoing bank row may have paid, best first. */
export async function listPurchasesForBankRow(
  userId: string,
  transactionId: string,
  options: { q?: string | null } = {}
): Promise<{ candidates: PurchaseInvoiceCandidate[]; total: number }> {
  const row = await prisma.transaction.findFirst({
    where: { id: transactionId, statement: { userId } },
    select: {
      id: true,
      date: true,
      amountCents: true,
      counterparty: true,
      reference: true,
      message: true,
      purchasePayment: { select: { id: true } },
      invoicePayment: { select: { id: true } },
    },
  });
  if (!row) throw new NotFoundError("Tapahtumaa ei löytynyt.");
  if (row.amountCents >= 0) {
    throw new ValidationError("Vain lähtevän maksun voi kohdistaa ostolaskuun.");
  }
  if (row.purchasePayment || row.invoicePayment) {
    throw new AppError("Tämä pankkitapahtuma on jo kohdistettu laskulle.", "TRANSACTION_ALREADY_USED", 409);
  }

  const invoices = await prisma.purchaseInvoice.findMany({
    where: { userId, status: "open" },
    include: { payments: { select: { amountCents: true } } },
  });
  const q = options.q?.trim() ?? "";
  const ranked = rankPurchasePairs(
    invoices
      .map((invoice) => ({ ...invoice, openCents: openCentsOf(invoice) }))
      .filter((invoice) => invoice.openCents > 0)
      .filter((invoice) =>
        matchesPurchaseSearch(q, [invoice.supplierName, invoice.invoiceNumber, invoice.reference], invoice.openCents)
      )
      .map((invoice) => ({ row, invoice, item: invoice }))
  );

  return {
    candidates: ranked.slice(0, PURCHASE_CANDIDATE_LIMIT).map(({ item, score }) => ({
      invoice: {
        id: item.id,
        supplierName: item.supplierName,
        invoiceNumber: item.invoiceNumber,
        reference: item.reference,
        issueDate: item.issueDate.toISOString().slice(0, 10),
        dueDate: item.dueDate.toISOString().slice(0, 10),
        gross: centsToEuros(item.grossCents),
        open: centsToEuros(item.openCents),
      },
      score: score.score,
      exactAmount: score.exactAmount,
      amountDiff: score.amountDiffCents === null ? null : centsToEuros(score.amountDiffCents),
      reasons: score.reasons,
    })),
    total: ranked.length,
  };
}

/** AutomationEvent kind: the owner said this bank row did not pay this purchase invoice. */
export const PURCHASE_MATCH_REJECTED_KIND = "purchase_match_rejected";

/** "Hylkää" on a suggestion: the pair is not suggested again (a search still finds it). */
export async function rejectPurchaseSuggestion(
  userId: string,
  invoiceId: string,
  transactionId: string
): Promise<void> {
  const [invoice, row] = await Promise.all([
    prisma.purchaseInvoice.findFirst({ where: { id: invoiceId, userId }, select: { id: true } }),
    prisma.transaction.findFirst({ where: { id: transactionId, statement: { userId } }, select: { id: true } }),
  ]);
  if (!invoice || !row) throw new NotFoundError("Ostolaskua tai pankkitapahtumaa ei löytynyt.");
  const existing = await prisma.automationEvent.findFirst({
    where: { userId, kind: PURCHASE_MATCH_REJECTED_KIND, resourceId: transactionId, newValue: invoiceId },
    select: { id: true },
  });
  if (existing) return;
  await prisma.automationEvent.create({
    data: {
      userId,
      kind: PURCHASE_MATCH_REJECTED_KIND,
      resourceType: "transaction",
      resourceId: transactionId,
      newValue: invoiceId,
      reason: "Käyttäjä hylkäsi ostolaskun maksuehdotuksen.",
    },
  });
}

/** "transactionId:invoiceId" for every rejected pair. */
export async function rejectedPurchasePairs(userId: string): Promise<Set<string>> {
  const rows = await prisma.automationEvent.findMany({
    where: { userId, kind: PURCHASE_MATCH_REJECTED_KIND },
    select: { resourceId: true, newValue: true },
  });
  return new Set(rows.map((row) => `${row.resourceId}:${row.newValue ?? ""}`));
}
