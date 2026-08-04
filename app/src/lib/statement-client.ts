export interface LinkedReceipt {
  id: string;
  vendor: string | null;
  totalAmount: number | null;
  date: string | null;
}

export interface StatementTransaction {
  id: string;
  date: string | null;
  counterparty: string | null;
  amount: number;
  reference: string | null;
  message: string | null;
  type: string;
  matchStatus: string;
  receiptId: string | null;
  receipt: LinkedReceipt | null;
  suggestedReceiptId: string | null;
  suggestedReceipt: LinkedReceipt | null;
  matchCandidates?: MatchCandidate[];
}

export interface MatchCandidate {
  score: number;
  reasons: string[];
  receipt: LinkedReceipt & { fileName?: string | null };
}

export interface StatementTotals {
  income: number;
  expenses: number;
  transfers: number;
  net: number;
  txCount: number;
}

export interface StatementData {
  id: string;
  fileName: string;
  fileType: string;
  uploadedAt: string;
  periodMonth: string | null;
  transactions: StatementTransaction[];
  totals: StatementTotals;
}

export type StatementTxFilter =
  | "all"
  | "linked"
  | "missing"
  | "suggested"
  | "ignored"
  | "palkka"
  | "transfers";

export const STATEMENT_TX_FILTERS: {
  id: StatementTxFilter;
  label: string;
  shortLabel?: string;
}[] = [
  { id: "all", label: "Kaikki" },
  { id: "linked", label: "Linkitetyt kuitit", shortLabel: "Linkitetyt" },
  { id: "missing", label: "Puuttuvat kuitit", shortLabel: "Puuttuvat" },
  { id: "suggested", label: "Ehdotukset" },
  { id: "ignored", label: "Ei kuittia tarvita", shortLabel: "Merkitty" },
  { id: "palkka", label: "Palkka", shortLabel: "Palkka" },
  { id: "transfers", label: "Omat siirrot", shortLabel: "Siirrot" },
];

export function formatEur(n: number): string {
  return (
    n.toLocaleString("fi-FI", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }) + " €"
  );
}

export function formatMonth(month: string | null): string {
  if (!month) return "Ei kuukautta";
  const [y, m] = month.split("-");
  const names = [
    "tammikuu",
    "helmikuu",
    "maaliskuu",
    "huhtikuu",
    "toukokuu",
    "kesäkuu",
    "heinäkuu",
    "elokuu",
    "syyskuu",
    "lokakuu",
    "marraskuu",
    "joulukuu",
  ];
  return `${names[parseInt(m, 10) - 1]} ${y}`;
}

export function receiptLabel(r: LinkedReceipt): string {
  const parts = [r.vendor || "Kuitti"];
  if (r.totalAmount != null) parts.push(formatEur(r.totalAmount));
  if (r.date) parts.push(new Date(r.date).toLocaleDateString("fi-FI"));
  return parts.join(" · ");
}

export function needsReceipt(t: StatementTransaction): boolean {
  return (
    t.type !== "oma_siirto" &&
    t.type !== "palkka" &&
    t.matchStatus !== "confirmed" &&
    t.matchStatus !== "ignored"
  );
}

export function recomputeTotals(
  transactions: StatementTransaction[]
): StatementTotals {
  let income = 0;
  let expenses = 0;
  let transfers = 0;
  for (const t of transactions) {
    if (t.type === "tulo") income += t.amount;
    else if (t.type === "meno") expenses += Math.abs(t.amount);
    else if (t.type === "oma_siirto" || t.type === "palkka") transfers += t.amount;
  }
  return {
    income: Math.round(income * 100) / 100,
    expenses: Math.round(expenses * 100) / 100,
    transfers: Math.round(transfers * 100) / 100,
    net: Math.round((income - expenses) * 100) / 100,
    txCount: transactions.length,
  };
}

export function filterStatementTransactions(
  transactions: StatementTransaction[],
  filter: StatementTxFilter
): StatementTransaction[] {
  switch (filter) {
    case "linked":
      return transactions.filter((t) => t.matchStatus === "confirmed");
    case "missing":
      return transactions.filter(needsReceipt);
    case "suggested":
      return transactions.filter((t) => t.matchStatus === "suggested");
    case "ignored":
      return transactions.filter((t) => t.matchStatus === "ignored");
    case "palkka":
      return transactions.filter((t) => t.type === "palkka");
    case "transfers":
      return transactions.filter((t) => t.type === "oma_siirto");
    default:
      return transactions;
  }
}

export function countStatementFilters(
  transactions: StatementTransaction[]
): Record<StatementTxFilter, number> {
  return {
    all: transactions.length,
    linked: transactions.filter((t) => t.matchStatus === "confirmed").length,
    missing: transactions.filter(needsReceipt).length,
    suggested: transactions.filter((t) => t.matchStatus === "suggested").length,
    ignored: transactions.filter((t) => t.matchStatus === "ignored").length,
    palkka: transactions.filter((t) => t.type === "palkka").length,
    transfers: transactions.filter((t) => t.type === "oma_siirto").length,
  };
}
