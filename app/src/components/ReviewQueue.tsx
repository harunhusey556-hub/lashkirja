"use client";

import { useState } from "react";
import { formatEur } from "@/lib/statement-client";

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

/**
 * A pending-review batch. Split by document origin, because a bank-drafted
 * sale and an emailed receipt need different wording and different actions —
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
    <div className="bg-warning/10 border border-warning/20 rounded-2xl p-4 shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="w-full flex items-center justify-between gap-3 text-left"
        aria-expanded={open}
      >
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-warning-dark">
            {title} ({receipts.length})
          </h3>
          <p className="text-xs text-charcoal/80 mt-1 leading-relaxed">
            {description}
          </p>
          <p className="text-xs text-warm-gray mt-1 tabular-nums">
            Yhteensä {formatEur(total)}
          </p>
        </div>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden
          className={`w-5 h-5 shrink-0 text-warning-dark transition-transform duration-300 ${
            open ? "rotate-180" : ""
          }`}
        >
          <path
            fillRule="evenodd"
            d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {onApproveAll && (
        <button
          type="button"
          onClick={onApproveAll}
          disabled={bulkBusy}
          className="mt-3 w-full py-2.5 rounded-xl bg-success text-white text-sm font-medium hover:bg-success-dark transition-colors disabled:opacity-50"
        >
          {bulkBusy
            ? "Hyväksytään..."
            : `Hyväksy kaikki ${receipts.length} kpl`}
        </button>
      )}

      {open && (
        <div className="space-y-2 mt-4">
          {visible.map((r) => (
            <div
              key={r.id}
              className="bg-white rounded-xl p-3 shadow-sm flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-charcoal truncate">
                  {r.vendor || "Tuntematon myyjä"}
                </p>
                <p className="text-xs text-warm-gray truncate">
                  {r.date ? new Date(r.date).toLocaleDateString("fi-FI") : "–"} ·{" "}
                  {r.totalAmount != null ? formatEur(r.totalAmount) : "–"}
                </p>
              </div>
              <div className="flex gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => onReview(r.id, "rejected")}
                  className="flex-1 sm:flex-none px-3 py-2 text-xs font-medium text-danger hover:bg-danger/10 rounded-lg transition-colors border border-danger/30"
                >
                  {rejectLabel}
                </button>
                <button
                  type="button"
                  onClick={() => onReview(r.id, "approved")}
                  className="flex-1 sm:flex-none px-3 py-2 text-xs font-medium text-white bg-success hover:bg-success-dark rounded-lg transition-colors"
                >
                  Hyväksy
                </button>
              </div>
            </div>
          ))}

          {hidden > 0 && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="w-full py-2.5 text-sm text-charcoal rounded-xl border border-warm-gray-light/60 hover:bg-white transition-colors"
            >
              Näytä loput {hidden} kpl
            </button>
          )}
        </div>
      )}
    </div>
  );
}
