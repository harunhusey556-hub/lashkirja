"use client";

import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import ReceiptMatchPanel from "@/components/ReceiptMatchPanel";
import { ListRow, MoreMenu, StatusTag } from "@/components/ds";
import { formatDate, formatEur } from "@/lib/format";
import { categoryLabel } from "@/lib/receipt-categories";
import { RECEIPT_MATCH_STATUS, receiptMatchStatusKey } from "@/lib/status-labels";
import type { SavedReceipt } from "./types";

const SOURCE_LABEL: Record<string, string> = { ai: "AI", ocr: "OCR" };

function sourceLabel(source: string): string {
  return SOURCE_LABEL[source] ?? "Manuaalinen";
}

function rowSecondary(receipt: SavedReceipt): string {
  const category = receipt.category ? categoryLabel(receipt.category) : "Ei kategoriaa";
  return `${formatDate(receipt.date)} · ${category}`;
}

/** A unique accessible name per row's "..." menu: two receipts can share a vendor and a date. */
function rowMenuLabel(receipt: SavedReceipt): string {
  return `Lisää toimintoja: ${receipt.vendor || "Tuntematon"} ${receipt.fileName}`;
}

export function ReceiptRow({
  receipt,
  expanded,
  onToggleExpand,
  selected,
  onToggleSelect,
  matchBusy,
  onConfirmMatch,
  onDeleteRequest,
  deleting,
}: {
  receipt: SavedReceipt;
  expanded: boolean;
  onToggleExpand: () => void;
  selected: boolean;
  onToggleSelect: () => void;
  matchBusy: boolean;
  onConfirmMatch: (transactionId: string) => void;
  onDeleteRequest: () => void;
  deleting: boolean;
}) {
  const router = useRouter();
  const matchKey = receiptMatchStatusKey(receipt.match);
  const matchStatus = RECEIPT_MATCH_STATUS[matchKey];
  const amountText = `${receipt.type === "tulo" ? "+" : ""}${formatEur(receipt.totalAmount)}`;
  const secondaryText = rowSecondary(receipt);

  return (
    <div>
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
            onClick={onToggleExpand}
            title={receipt.vendor || "Tuntematon"}
            amount={amountText}
            amountTone={receipt.type === "tulo" ? "positive" : "default"}
            secondary={secondaryText}
            ariaLabel={`${receipt.vendor || "Tuntematon"}, ${amountText}, ${secondaryText}`}
            trailing={
              <div className="flex items-center gap-1.5">
                <StatusTag tone={matchStatus.tone}>{matchStatus.label}</StatusTag>
                <MoreMenu
                  label={rowMenuLabel(receipt)}
                  items={[
                    { label: "Muokkaa", onSelect: () => router.push(`/kuitit/${receipt.id}`) },
                    {
                      label: "Poista",
                      onSelect: onDeleteRequest,
                      tone: "danger" as const,
                      disabled: deleting,
                    },
                  ]}
                />
              </div>
            }
          />
        </div>
      </div>

      {expanded && (
        <div className="space-y-3 border-t border-line px-4 pb-4 pt-3">
          <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-[13px]">
            <div>
              <dt className="text-ink-2">Tiedosto</dt>
              <dd className="truncate text-ink">{receipt.fileName}</dd>
            </div>
            <div>
              <dt className="text-ink-2">Lähde</dt>
              <dd className="text-ink">{sourceLabel(receipt.source)}</dd>
            </div>
            {receipt.invoiceNumber && (
              <div>
                <dt className="text-ink-2">Laskun nro</dt>
                <dd className="text-ink">{receipt.invoiceNumber}</dd>
              </div>
            )}
            {receipt.reference && (
              <div>
                <dt className="text-ink-2">Viite</dt>
                <dd className="text-ink">{receipt.reference}</dd>
              </div>
            )}
          </dl>

          <ReceiptMatchPanel
            match={receipt.match}
            linkedTransaction={receipt.linkedTransaction}
            compact
            busy={matchBusy}
            onConfirm={onConfirmMatch}
          />
        </div>
      )}
    </div>
  );
}
