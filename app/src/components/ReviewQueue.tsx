"use client";

import { Disclosure } from "@/components/ds/Disclosure";
import { useLeavingRows } from "@/components/useLeavingRows";
import { useState } from "react";
import Link from "next/link";
import { formatEur } from "@/lib/statement-client";
import { Button, buttonClass } from "@/components/ui";
import BottomSheet from "@/components/BottomSheet";
import { ChevronDown } from "lucide-react";
import { ActionPill, Card, Icon, ListRow } from "@/components/ds";
import { detailHref } from "@/lib/routes";
import { approvalGapText, type ApprovalGap } from "@/lib/receipt-approval";
import { queueTotalText, splitApprovable } from "@/lib/review-queue";

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
  /**
   * Only for homogeneous batches, where one-by-one review is pure busywork.
   * Gets the ids of the receipts that are ready; incomplete ones are not offered.
   */
  onApproveAll?: (readyIds: string[]) => void;
  bulkBusy?: boolean;
}

const COLLAPSED_ROWS = 5;

function rowSecondary(receipt: ReviewQueueReceipt, gaps: ApprovalGap[] = []): string {
  const date = receipt.date ? new Date(receipt.date).toLocaleDateString("fi-FI") : "–";
  const base = date;
  return gaps.length > 0 ? `${approvalGapText(gaps)} · ${base}` : base;
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
  // An approved row folds out at once and stays out until the list reloads;
  // a refused approval (e.g. no amount) comes back with the reload.
  const { leaving, leave } = useLeavingRows();
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const [prevReceipts, setPrevReceipts] = useState(receipts);
  if (prevReceipts !== receipts) {
    setPrevReceipts(receipts);
    setGone(new Set());
  }
  function approve(receipt: ReviewQueueReceipt) {
    leave(receipt.id, () => {
      setGone((current) => new Set(current).add(receipt.id));
      onReview(receipt.id, "approved");
    });
  }
  // VS-23: a row carries one action pill; "Hylkää" and the details live in the row's own sheet.
  const [sheetFor, setSheetFor] = useState<ReviewQueueReceipt | null>(null);
  // One approval rule for every path (receipt-approval.ts): a receipt without an
  // amount or a vendor is completed first, so it never gets a "Hyväksy" and the
  // bulk button only carries the ready ones (F15).
  const { ready, incomplete } = splitApprovable(receipts);
  const gapsById = new Map(incomplete.map((r) => [r.id, r.gaps]));
  const sheetGaps = sheetFor ? (gapsById.get(sheetFor.id) ?? []) : [];
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
          <h2 className="text-body font-medium text-ink">
            {title} ({receipts.length})
          </h2>
          <p className="mt-1 text-caption text-ink-2">{description}</p>
          <p className="mt-1 text-caption tabular-nums text-ink-2">{queueTotalText(receipts, formatEur)}</p>
        </div>
        <Icon icon={ChevronDown} className={`text-ink-2 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {onApproveAll && ready.length > 0 && (
        <Button
          type="button"
          className="mt-3 w-full"
          busy={bulkBusy}
          busyLabel="Hyväksytään…"
          onClick={() => onApproveAll(ready.map((r) => r.id))}
        >
          {incomplete.length === 0 ? `Hyväksy kaikki (${ready.length})` : `Hyväksy valmiit (${ready.length})`}
        </Button>
      )}
      {incomplete.length > 0 && (
        <p className="mt-2 text-caption text-warning" role="note">
          {incomplete.length === 1 ? "1 kuitti vaatii täydennyksen." : `${incomplete.length} kuittia vaatii täydennyksen.`}
        </p>
      )}

      <Disclosure open={open}>
        <div className="mt-3 -mx-4 border-t border-line">
          <div className="divide-y divide-line">
            {visible.filter((r) => !gone.has(r.id)).map((r) => (
              <div key={r.id} data-leave-key={r.id} className={leaving.has(r.id) ? "row-leave" : undefined}>
              <ListRow
                title={r.vendor || "Tuntematon myyjä"}
                amount={r.totalAmount != null ? formatEur(r.totalAmount) : "–"}
                secondary={rowSecondary(r, gapsById.get(r.id))}
                onClick={() => setSheetFor(r)}
                ariaLabel={`${r.vendor || "Tuntematon myyjä"}, ${r.totalAmount != null ? formatEur(r.totalAmount) : "ei summaa"}, ${rowSecondary(r, gapsById.get(r.id))}`}
                trailing={
                  gapsById.has(r.id) ? (
                    <ActionPill href={detailHref("receipt", r.id)}>Täydennä</ActionPill>
                  ) : (
                    <ActionPill onClick={() => approve(r)}>Hyväksy</ActionPill>
                  )
                }
              />
              </div>
            ))}
          </div>
          {hidden > 0 && (
            <div className="px-4 py-3">
              <Button type="button" variant="secondary" className="w-full" onClick={() => setShowAll(true)}>
                Näytä loput ({hidden})
              </Button>
            </div>
          )}
        </div>
      </Disclosure>

      <BottomSheet
        isOpen={sheetFor !== null}
        onClose={() => setSheetFor(null)}
        title={sheetFor?.vendor || "Tuntematon myyjä"}
        subtitle={sheetFor ? rowSecondary(sheetFor) : undefined}
        labelledBy="review-sheet-title"
        heightClass="max-h-[60dvh]"
      >
        {sheetFor && (
          <div className="space-y-3 px-5 py-4 sheet-safe-bottom">
            <p className="text-title-2 font-bold tabular-nums tracking-[-0.02em] text-ink">
              {sheetFor.totalAmount != null ? formatEur(sheetFor.totalAmount) : "–"}
            </p>
            {sheetGaps.length > 0 ? (
              <>
                <p className="text-caption text-warning" role="note">
                  {approvalGapText(sheetGaps)}, ennen kuin kuitin voi hyväksyä.
                </p>
                <Link href={detailHref("receipt", sheetFor.id)} className={buttonClass("primary", "w-full")}>
                  Täydennä kuitti
                </Link>
              </>
            ) : (
              <>
                <Button
                  type="button"
                  className="w-full"
                  onClick={() => {
                    onReview(sheetFor.id, "approved");
                    setSheetFor(null);
                  }}
                >
                  Hyväksy
                </Button>
                <Link href={detailHref("receipt", sheetFor.id)} className={buttonClass("secondary", "w-full")}>
                  Avaa kuitti
                </Link>
              </>
            )}
            <Button
              type="button"
              variant="danger"
              className="w-full"
              onClick={() => {
                onReview(sheetFor.id, "rejected");
                setSheetFor(null);
              }}
            >
              {rejectLabel}
            </Button>
          </div>
        )}
      </BottomSheet>
    </Card>
  );
}
