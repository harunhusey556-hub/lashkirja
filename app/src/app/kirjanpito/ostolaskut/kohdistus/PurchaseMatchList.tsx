import { ListRow, Section } from "@/components/ds";
import { tintedButtonClass } from "@/components/control-styles";
import { Button } from "@/components/ui";
import { formatDate, formatDayMonth, formatEur } from "@/lib/format";

/** An open ostolasku as GET /api/purchase-invoices returns it (only what this page reads). */
export interface OpenPurchase {
  id: string;
  supplierName: string;
  invoiceNumber: string | null;
  dueDate: string;
  displayStatus: "open" | "paid" | "cancelled" | "overdue";
  open: number;
}

/** A bank payment the matcher proposes for an ostolasku (lib/purchase-invoices.ts PurchaseMatchSuggestion). */
export interface PaymentSuggestion {
  invoiceId: string;
  transactionId: string;
  amount: number;
  paidDate: string | null;
  counterparty: string | null;
  score: number;
  reasons: string[];
}

export interface PurchaseMatchRow {
  invoice: OpenPurchase;
  suggestion: PaymentSuggestion | null;
}

/**
 * "Varma": the exact open amount and a strong supplier match, scored by the
 * shared gate (match-gate.ts; 0.7 is amount + any name match, 0.9 a viite hit).
 * A suggestion is already unambiguous - two equally plausible payables give
 * none - so this only keeps the weakest name matches for a look first.
 */
export const SURE_SUGGESTION_SCORE = 0.8;

export function isSureSuggestion(suggestion: PaymentSuggestion): boolean {
  return suggestion.score >= SURE_SUGGESTION_SCORE;
}

/** Open ostolaskut with their proposed payment, proposals first, then by due date. */
export function purchaseMatchRows(invoices: OpenPurchase[], suggestions: PaymentSuggestion[]): PurchaseMatchRow[] {
  const byInvoice = new Map(suggestions.map((suggestion) => [suggestion.invoiceId, suggestion]));
  return invoices
    .filter((invoice) => invoice.displayStatus === "open" || invoice.displayStatus === "overdue")
    .map((invoice) => ({ invoice, suggestion: byInvoice.get(invoice.id) ?? null }))
    .sort(
      (a, b) =>
        Number(Boolean(b.suggestion)) - Number(Boolean(a.suggestion)) ||
        a.invoice.dueDate.localeCompare(b.invoice.dueDate)
    );
}

/**
 * "Hyväksy kaikki varmat (n)", only while sure proposals wait: shown with nothing to accept, it read
 * as the page's next step and did nothing (X168).
 */
export function AcceptAllSureButton({
  sureCount,
  busy,
  disabled,
  onClick,
}: {
  sureCount: number;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  if (sureCount <= 0) return null;
  return (
    <Button
      type="button"
      variant="primary"
      className="w-full"
      onClick={onClick}
      busy={busy}
      busyLabel="Kohdistetaan…"
      disabled={disabled}
    >
      {`Hyväksy kaikki varmat (${sureCount})`}
    </Button>
  );
}

function invoiceLine(invoice: OpenPurchase): string {
  const due = `${invoice.displayStatus === "overdue" ? "myöhässä, eräpäivä" : "eräpäivä"} ${formatDayMonth(invoice.dueDate)}`;
  return invoice.invoiceNumber ? `${invoice.invoiceNumber} · ${due}` : due.charAt(0).toUpperCase() + due.slice(1);
}

function paymentLine(suggestion: PaymentSuggestion): string {
  return [
    "Pankki",
    suggestion.counterparty?.trim() || null,
    suggestion.paidDate ? formatDate(suggestion.paidDate) : null,
    formatEur(suggestion.amount),
  ]
    .filter(Boolean)
    .join(" · ");
}

export function PurchaseMatchList({
  rows,
  busyId,
  onAccept,
  onReject,
}: {
  rows: PurchaseMatchRow[];
  /** The invoice whose row is being written; its buttons are disabled. */
  busyId: string | null;
  onAccept: (suggestion: PaymentSuggestion) => void;
  onReject: (suggestion: PaymentSuggestion) => void;
}) {
  const proposed = rows.filter((row) => row.suggestion);
  const waiting = rows.filter((row) => !row.suggestion);
  return (
    <>
      {proposed.length > 0 && (
        <Section title="Ehdotetut maksut" count={proposed.length}>
          {proposed.map(({ invoice, suggestion }) => {
            const pick = suggestion!;
            const busy = busyId === invoice.id;
            return (
              <div key={invoice.id} data-testid="purchase-match-row" className="px-4 py-3">
                <div className="flex items-baseline justify-between gap-3 text-body font-medium text-ink">
                  <span className="min-w-0 [overflow-wrap:anywhere]">{invoice.supplierName}</span>
                  <span className="shrink-0 tabular-nums">{formatEur(invoice.open)}</span>
                </div>
                <p className="mt-0.5 text-caption text-ink-2">{invoiceLine(invoice)}</p>
                <p className="mt-2 text-caption text-ink">{paymentLine(pick)}</p>
                {pick.reasons.length > 0 && (
                  <p className="mt-0.5 text-caption text-ink-2">
                    {pick.reasons.join(", ")}
                    {isSureSuggestion(pick) ? " · varma" : ""}
                  </p>
                )}
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onAccept(pick)}
                    aria-label={`Hyväksy maksu ${formatEur(pick.amount)} ostolaskulle ${invoice.supplierName}`}
                    className={tintedButtonClass("accent")}
                  >
                    Hyväksy
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onReject(pick)}
                    aria-label={`Hylkää maksuehdotus ostolaskulle ${invoice.supplierName}`}
                    className={tintedButtonClass("neutral")}
                  >
                    Hylkää
                  </button>
                </div>
              </div>
            );
          })}
        </Section>
      )}
      {waiting.length > 0 && (
        <Section title="Ei maksuehdotusta" count={waiting.length}>
          {waiting.map(({ invoice }) => (
            <ListRow
              key={invoice.id}
              // That ostolasku itself (its "Kohdista pankkiin"), not the list to search again.
              href={`/kirjanpito/ostolaskut?id=${encodeURIComponent(invoice.id)}`}
              title={invoice.supplierName}
              amount={formatEur(invoice.open)}
              secondary={invoiceLine(invoice)}
            />
          ))}
        </Section>
      )}
    </>
  );
}
