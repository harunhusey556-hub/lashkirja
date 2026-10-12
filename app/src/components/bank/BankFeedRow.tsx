"use client";

import { memo } from "react";
import { ListRow, StatusTag } from "@/components/ds";
import { SelectableRow } from "@/components/SelectableRow";
import { formatDayMonth, formatEurSigned } from "@/lib/format";
import { rowState, type FeedRow } from "@/lib/bank-feed";

const ROW_TAG: Partial<Record<ReturnType<typeof rowState>, { tone: "warning" | "accent"; label: string }>> = {
  sale: { tone: "warning", label: "Hyväksy myynti" },
  suggested: { tone: "accent", label: "Tarkista" },
};

/** "Maksu laskulle 5": the row is done because an invoice took it (F12). */
function invoicePaymentNote(row: FeedRow): string {
  if (row.paidInvoice) return `Maksu laskulle ${row.paidInvoice.number}`;
  return row.settlesPurchase ? "Maksu ostolaskulle" : "Kunnossa";
}

export function rowSecondary(row: FeedRow): string {
  const day = row.date ? formatDayMonth(row.date) : "";
  const state = rowState(row);
  const note =
    state === "linked"
      ? "Kunnossa"
      : state === "invoice"
        ? invoicePaymentNote(row)
        : state === "ignored"
        ? "Ei kuittia tarvita"
        : state === "transfer"
          ? row.type === "palkka"
            ? "Palkka"
            : "Oma siirto"
          : state === "missing"
            ? row.amount > 0
              ? "Kuittia ei vielä ole"
              : "Kuitti puuttuu"
            : "";
  return [day, note].filter(Boolean).join(" · ");
}

function rowTag(row: FeedRow) {
  const state = rowState(row);
  if (state === "missing") {
    return <StatusTag tone="warning">{row.amount > 0 ? "Puuttuu" : "Uusi kuitti"}</StatusTag>;
  }
  const tag = ROW_TAG[state];
  return tag ? <StatusTag tone={tag.tone}>{tag.label}</StatusTag> : null;
}

/**
 * One bank row. Memoised: the list passes the same `row` object for a row that
 * did not change (`feedRows` + `reuseEqualRows`) and stable callbacks, so a
 * decision on one row, a poll that found nothing, or ticking one checkbox
 * repaints that row and not the other few hundred.
 */
export const BankFeedRow = memo(function BankFeedRow({
  row,
  leaving,
  done,
  swap,
  selectMode,
  selected,
  onOpen,
  onToggle,
}: {
  row: FeedRow;
  leaving: boolean;
  done: boolean;
  /** The month this row sits in just unfolded: play the list-swap fade. */
  swap: boolean;
  selectMode: boolean;
  selected: boolean;
  onOpen: (id: string) => void;
  onToggle: (id: string) => void;
}) {
  const className =
    [leaving ? "row-leave" : "", done ? "row-done" : "", swap ? "list-swap" : ""].filter(Boolean).join(" ") || undefined;
  const title = row.counterparty || (row.amount > 0 ? "Tulo" : "Meno");
  const body = (
    <ListRow
      title={title}
      secondary={rowSecondary(row)}
      amount={formatEurSigned(row.amount)}
      amountTone={row.amount > 0 ? "positive" : "default"}
      trailing={rowTag(row)}
      // In select mode a tap on the row ticks it; opening the sheet is the other mode's job.
      onClick={() => (selectMode ? onToggle(row.id) : onOpen(row.id))}
    />
  );
  return (
    <div data-leave-key={row.id} className={className}>
      {selectMode ? (
        <SelectableRow selected={selected} onToggle={() => onToggle(row.id)} label={`Valitse ${title}`}>
          {body}
        </SelectableRow>
      ) : (
        body
      )}
    </div>
  );
});
