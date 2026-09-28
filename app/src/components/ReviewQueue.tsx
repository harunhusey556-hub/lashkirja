"use client";

import { useState } from "react";
import { formatEur } from "@/lib/statement-client";
import { Button } from "@/components/ui";
import { ChevronDown } from "lucide-react";
import { ActionPill, Card, Icon, ListRow, MoreMenu } from "@/components/ds";

interface ReviewQueueReceipt {
  id: string;
  vendor: string | null;
  date: string | null;
  totalAmount: number | null;
  fileName: string;
}

interface Props {
  title: string;
  description: string;
  receipts: ReviewQueueReceipt[];
  rejectLabel: string;
  onReview: (id: string, status: "approved" | "rejected") => void;
  /** Only for homogeneous batches, where one-by-one review is pure busywork. */
  onApproveAll?: () => void;
  bulkBusy?: boolean;
}

const COLLAPSED_ROWS = 5;

function rowSecondary(receipt: ReviewQueueReceipt): string {
  const date = receipt.date ? new Date(receipt.date).toLocaleDateString("fi-FI") : "–";
  return `${date} · ${receipt.fileName}`;
}

/** A unique accessible name per row's "..." menu: two receipts can share a vendor and a date. */
function rowMenuLabel(receipt: ReviewQueueReceipt): string {
  return `Lisää toimintoja: ${receipt.vendor || "Tuntematon myyjä"} ${receipt.fileName}`;
}

/**
 * A pending-review batch. Split by document origin, because a bank-drafted
 * sale and an emailed receipt need different wording and different actions -
 * they were previously all shown as "sähköpostikuitit".
 *
 * Long batches stay collapsed to a handful of rows: 50 near-identical MobilePay
 * settlements is not something a human can meaningfully read row by row.
 */
export default function ReviewQueue({
  title,
  description,
  receipts,
  rejectLabel,
  onReview,
  onApproveAll,
  bulkBusy = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const total = receipts.reduce((sum, r) => sum + (r.totalAmount ?? 0), 0);
  const visible = showAll ? receipts : receipts.slice(0, COLLAPSED_ROWS);
  const hidden = receipts.length - visible.length;

  return (
    <Card>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="active-press flex w-full items-center justify-between gap-3 text-left"
        aria-expanded={open}
      >
        <div className="min-w-0">
          <h3 className="text-[15px] font-medium text-ink">
            {title} ({receipts.length})
          </h3>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{description}</p>
          <p className="mt-1 text-[13px] tabular-nums text-ink-2">Yhteensä {formatEur(total)}</p>
        </div>
        <Icon icon={ChevronDown} className={`text-ink-2 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {onApproveAll && (
        <Button
          type="button"
          className="mt-3 w-full"
          busy={bulkBusy}
          busyLabel="Hyväksytään…"
          onClick={onApproveAll}
        >
          Hyväksy kaikki {receipts.length} kpl
        </Button>
      )}

      {open && (
        <div className="mt-3 -mx-4 border-t border-line">
          <div className="divide-y divide-line">
            {visible.map((r) => (
              <ListRow
                key={r.id}
                title={r.vendor || "Tuntematon myyjä"}
                amount={r.totalAmount != null ? formatEur(r.totalAmount) : "–"}
                secondary={rowSecondary(r)}
                trailing={
                  <div className="flex items-center gap-1.5">
                    <ActionPill onClick={() => onReview(r.id, "approved")}>Hyväksy</ActionPill>
                    <MoreMenu
                      label={rowMenuLabel(r)}
                      items={[{ label: rejectLabel, onSelect: () => onReview(r.id, "rejected"), tone: "danger" as const }]}
                    />
                  </div>
                }
              />
            ))}
          </div>
          {hidden > 0 && (
            <div className="px-4 py-3">
              <Button type="button" variant="secondary" className="w-full" onClick={() => setShowAll(true)}>
                Näytä loput {hidden} kpl
              </Button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
