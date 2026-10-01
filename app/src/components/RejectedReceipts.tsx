"use client";

import { useState } from "react";

import { ChevronDown } from "lucide-react";
import { Disclosure } from "@/components/ds/Disclosure";
import { ActionPill, Card, Icon, ListRow } from "@/components/ds";
import { detailHref } from "@/lib/routes";
import { formatEur } from "@/lib/statement-client";

interface RejectedReceipt {
  id: string;
  vendor: string | null;
  date: string | null;
  totalAmount: number | null;
  fileName: string;
}

/**
 * Hylätyt kuitit: a rejected receipt is not in the books, but it is never
 * gone from sight. It can be opened, or put back to the review queue (F38).
 */
export default function RejectedReceipts({
  receipts,
  onRestore,
}: {
  receipts: RejectedReceipt[];
  onRestore: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (receipts.length === 0) return null;
  return (
    <Card>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="active-press flex w-full items-center justify-between gap-3 text-left"
        aria-expanded={open}
      >
        <div className="min-w-0">
          <h2 className="text-body font-medium text-ink">Hylätyt kuitit ({receipts.length})</h2>
          <p className="mt-1 text-caption text-ink-2">Eivät ole kirjanpidossa. Voit palauttaa kuitin tarkastettavaksi.</p>
        </div>
        <Icon icon={ChevronDown} className={`text-ink-2 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      <Disclosure open={open}>
        <div className="mt-3 -mx-4 divide-y divide-line border-t border-line">
          {receipts.map((receipt) => {
            const date = receipt.date ? new Date(receipt.date).toLocaleDateString("fi-FI") : "–";
            return (
              <ListRow
                key={receipt.id}
                title={receipt.vendor || "Tuntematon myyjä"}
                amount={receipt.totalAmount != null ? formatEur(receipt.totalAmount) : "–"}
                secondary={`${date} · ${receipt.fileName}`}
                href={detailHref("receipt", receipt.id)}
                ariaLabel={`${receipt.vendor || "Tuntematon myyjä"}, hylätty. Avaa kuitti.`}
                trailing={<ActionPill onClick={() => onRestore(receipt.id)}>Palauta</ActionPill>}
              />
            );
          })}
        </div>
      </Disclosure>
    </Card>
  );
}
