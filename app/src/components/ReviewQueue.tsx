"use client";

import { Disclosure } from "@/components/ds/Disclosure";
import { useLeavingRows } from "@/components/useLeavingRows";
import { useState } from "react";
import Link from "next/link";
import { formatEur } from "@/lib/statement-client";
import { Button, buttonClass } from "@/components/ui";
import ConfirmModal from "@/components/ConfirmModal";
import BottomSheet from "@/components/BottomSheet";
import { ChevronDown } from "lucide-react";
import { ActionPill, Card, Icon, ListRow } from "@/components/ds";
import { detailHref } from "@/lib/routes";

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
  const [confirmBulk, setConfirmBulk] = useState(false);
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
    if (receipt.totalAmount == null) {
      onReview(receipt.id, "approved");
      return;
    }
    leave(receipt.id, () => {
      setGone((current) => new Set(current).add(receipt.id));
      onReview(receipt.id, "approved");
    });
  }
  // VS-23: a row carries one action pill; "Hylkää" and the details live in the row's own sheet.
  const [sheetFor, setSheetFor] = useState<ReviewQueueReceipt | null>(null);
  // A zero or missing total is almost always an unread receipt: approving it
  // in bulk books nothing, so it is named before the tap (BOOKS-28).
  const withoutTotal = receipts.filter((r) => !r.totalAmount).length;

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
          <h2 className="text-body font-medium text-ink">
            {title} ({receipts.length})
          </h2>
          <p className="mt-1 text-caption text-ink-2">{description}</p>
          <p className="mt-1 text-caption tabular-nums text-ink-2">Yhteensä {formatEur(total)}</p>
        </div>
        <Icon icon={ChevronDown} className={`text-ink-2 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {onApproveAll && (
        <Button
          type="button"
          className="mt-3 w-full"
          busy={bulkBusy}
          busyLabel="Hyväksytään…"
          onClick={() => (withoutTotal > 0 ? setConfirmBulk(true) : onApproveAll())}
        >
          Hyväksy kaikki {receipts.length} kpl
        </Button>
      )}
      {onApproveAll && withoutTotal > 0 && (
        <p className="mt-2 text-caption text-warning" role="note">
          {withoutTotal === 1 ? "1 kuitilta puuttuu summa." : `${withoutTotal} kuitilta puuttuu summa.`} Tarkista ennen
          hyväksyntää.
        </p>
      )}
      {onApproveAll && (
        <ConfirmModal
          isOpen={confirmBulk}
          title={`Hyväksytäänkö ${receipts.length} kuittia?`}
          description={`${withoutTotal === 1 ? "Yhdeltä kuitilta" : `${withoutTotal} kuitilta`} puuttuu summa (0,00 €). Ne kirjataan ilman summaa.`}
          confirmLabel="Hyväksy silti"
          isDestructive={false}
          onConfirm={() => {
            setConfirmBulk(false);
            onApproveAll();
          }}
          onCancel={() => setConfirmBulk(false)}
        />
      )}

      <Disclosure open={open}>
        <div className="mt-3 -mx-4 border-t border-line">
          <div className="divide-y divide-line">
            {visible.filter((r) => !gone.has(r.id)).map((r) => (
              <div key={r.id} className={leaving.has(r.id) ? "row-leave" : undefined}>
              <ListRow
                title={r.vendor || "Tuntematon myyjä"}
                amount={r.totalAmount != null ? formatEur(r.totalAmount) : "–"}
                secondary={rowSecondary(r)}
                onClick={() => setSheetFor(r)}
                ariaLabel={`${r.vendor || "Tuntematon myyjä"}, ${r.totalAmount != null ? formatEur(r.totalAmount) : "ei summaa"}, ${rowSecondary(r)}`}
                trailing={<ActionPill onClick={() => approve(r)}>Hyväksy</ActionPill>}
              />
              </div>
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
