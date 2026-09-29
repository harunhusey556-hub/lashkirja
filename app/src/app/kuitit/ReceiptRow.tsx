"use client";

import { Check } from "lucide-react";
import { ListRow, StatusTag } from "@/components/ds";
import { formatDate, formatEur } from "@/lib/format";
import { categoryLabel } from "@/lib/receipt-categories";
import { RECEIPT_MATCH_STATUS, receiptMatchStatusKey } from "@/lib/status-labels";
import { detailHref } from "@/lib/routes";
import type { SavedReceipt } from "./types";

function rowSecondary(receipt: SavedReceipt): string {
  const category = receipt.category ? categoryLabel(receipt.category) : "Ei kategoriaa";
  return `${formatDate(receipt.date)} · ${category}`;
}

/**
 * One receipt in the Kuitit list. A tap pushes the receipt's own screen
 * (BOOKS-13, N2): the file, the details and the bank match live there, so the
 * list never expands in place. A record row (type B): the trailing affordance is the
 * status tag only; "Poista" is on the receipt's own screen and in the bulk bar (VS-23).
 */
export function ReceiptRow({
  receipt,
  selected,
  onToggleSelect,
}: {
  receipt: SavedReceipt;
  selected: boolean;
  onToggleSelect: () => void;
}) {
  const matchKey = receiptMatchStatusKey(receipt.match);
  const matchStatus = RECEIPT_MATCH_STATUS[matchKey];
  const amountText = `${receipt.type === "tulo" ? "+" : ""}${formatEur(receipt.totalAmount)}`;
  const secondaryText = rowSecondary(receipt);

  return (
    <div className="flex items-stretch">
      <label className="relative flex w-11 shrink-0 cursor-pointer items-center justify-center">
        <input
          type="checkbox"
          className="peer sr-only"
          checked={selected}
          onChange={onToggleSelect}
          aria-label={`Valitse ${receipt.vendor || "kuitti"}`}
        />
        <span className="flex h-5 w-5 items-center justify-center rounded-full border-[1.5px] border-ink-2/50 bg-surface transition-colors peer-checked:border-ink peer-checked:bg-ink peer-focus-visible:ring-2 peer-focus-visible:ring-accent/40">
          <Check
            aria-hidden
            width={12}
            height={12}
            strokeWidth={3.5}
            className={`text-canvas transition-opacity ${selected ? "opacity-100" : "opacity-0"}`}
          />
        </span>
      </label>
      <div className="min-w-0 flex-1">
        <ListRow
          href={detailHref("receipt", receipt.id)}
          title={receipt.vendor || "Tuntematon"}
          amount={amountText}
          amountTone={receipt.type === "tulo" ? "positive" : "default"}
          secondary={secondaryText}
          ariaLabel={`${receipt.vendor || "Tuntematon"}, ${amountText}, ${secondaryText}, ${matchStatus.label}`}
          trailing={<StatusTag tone={matchStatus.tone}>{matchStatus.label}</StatusTag>}
        />
      </div>
    </div>
  );
}
