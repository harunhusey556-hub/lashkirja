"use client";

import { useId } from "react";
import Link from "next/link";
import { FileUp, PenLine } from "lucide-react";
import BottomSheet from "@/components/BottomSheet";
import { Icon, IconTile } from "@/components/ds";
import { BANK_COPY } from "@/lib/bank-status";

/**
 * What "Yhdistä pankki" can do while the connection is not in use (BOOKS-03):
 * one calm sentence and the two routes that work today. Whatever the server
 * still needs is for its owner and never shown here (L5).
 */
export default function BankSetupSheet({
  isOpen,
  onClose,
  onAddManual,
}: {
  isOpen: boolean;
  onClose: () => void;
  /** Opens the manual account form; without it the row links to Pankkitilit. */
  onAddManual?: () => void;
}) {
  const titleId = useId();
  return (
    <BottomSheet isOpen={isOpen} onClose={onClose} title={BANK_COPY.setupTitle} labelledBy={titleId} dirty={false}>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 pb-2 pt-1 sheet-safe-bottom">
        <div className="space-y-3 text-body leading-relaxed text-ink">
          <p>{BANK_COPY.setupLead}</p>
        </div>

        <div>
          <p className="mb-2 px-1 text-caption text-ink-2">Toimii jo nyt</p>
          <div className="overflow-hidden rounded-card border border-line bg-surface divide-y divide-line">
            <Link
              href="/kirjanpito/pankkitilit#tiliotteet"
              onClick={onClose}
              className="active-press flex min-h-14 items-center gap-3 px-4 py-3"
            >
              <IconTile>
                <Icon icon={FileUp} />
              </IconTile>
              <span className="min-w-0 flex-1">
                <span className="block text-body font-medium text-ink">Tuo tiliote tiedostona</span>
                <span className="block text-caption text-ink-2">PDF, XML, XLSX tai CSV verkkopankista</span>
              </span>
            </Link>
            {onAddManual ? (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onAddManual();
                }}
                className="active-press flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left"
              >
                <ManualRowBody />
              </button>
            ) : (
              <Link
                href="/kirjanpito/pankkitilit"
                onClick={onClose}
                className="active-press flex min-h-14 items-center gap-3 px-4 py-3"
              >
                <ManualRowBody />
              </Link>
            )}
          </div>
        </div>
      </div>
    </BottomSheet>
  );
}

function ManualRowBody() {
  return (
    <>
      <IconTile>
        <Icon icon={PenLine} />
      </IconTile>
      <span className="min-w-0 flex-1">
        <span className="block text-body font-medium text-ink">Lisää tili käsin</span>
        <span className="block text-caption text-ink-2">Saldot kirjataan itse kuukausittain</span>
      </span>
    </>
  );
}
