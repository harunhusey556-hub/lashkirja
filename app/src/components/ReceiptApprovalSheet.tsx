"use client";

import BottomSheet from "@/components/BottomSheet";
import { Button } from "@/components/ui";
import { KeyValueList } from "@/components/ds";
import { formatDate, formatEur } from "@/lib/format";
import { categoryLabel } from "@/lib/receipt-categories";
import { approvalGapText, type ApprovalGap } from "@/lib/receipt-approval";

export interface ApprovalSheetReceipt {
  receiptId: string;
  party: string;
  amount: number | null;
  type: string;
  date: string | null;
  category: string | null;
  vatRate: number | null;
  gaps: ApprovalGap[];
}

/**
 * The approval sheet (spec §3.6, TF-03, FP-5): the Koti row body opens this,
 * so tapping the row finishes the task in place just like the pill.
 * A receipt with a gap (FP-6) offers "Täydennä kuitti" instead of "Hyväksy".
 */
export function ReceiptApprovalSheet({
  receipt,
  onClose,
  onApprove,
  onEdit,
}: {
  receipt: ApprovalSheetReceipt | null;
  onClose: () => void;
  onApprove: (receipt: ApprovalSheetReceipt) => void;
  onEdit: (receipt: ApprovalSheetReceipt) => void;
}) {
  const open = receipt !== null;
  const complete = receipt ? receipt.gaps.length === 0 : false;
  return (
    <BottomSheet
      isOpen={open}
      onClose={onClose}
      title={receipt?.party ?? "Kuitti"}
      subtitle={receipt ? (receipt.type === "tulo" ? "Tulokuitti odottaa hyväksyntää" : "Kuitti odottaa hyväksyntää") : undefined}
      labelledBy="approval-sheet-title"
      heightClass="max-h-[80dvh]"
      dirty={false}
    >
      {receipt ? (
        <div className="space-y-4 px-4 py-2 sheet-safe-bottom">
          <KeyValueList
            rows={[
              { label: "Summa", value: receipt.amount == null ? "Puuttuu" : formatEur(receipt.amount) },
              { label: "Päivä", value: receipt.date ? formatDate(receipt.date) : "Puuttuu" },
              { label: "Luokka", value: receipt.category ? categoryLabel(receipt.category) : "Ei valittu" },
              {
                label: "ALV",
                value: receipt.vatRate == null ? "Ei eritelty" : `${String(receipt.vatRate).replace(".", ",")} %`,
              },
            ]}
          />
          {complete ? (
            <p className="px-1 text-caption text-ink-2">Tiedot on luettu kuitista. Tarkista ne ennen hyväksyntää.</p>
          ) : (
            <p className="px-1 text-caption text-warning" role="note">
              {approvalGapText(receipt.gaps)}, ennen kuin kuitin voi hyväksyä.
            </p>
          )}
          <div className="space-y-2">
            {complete ? (
              <>
                <Button className="w-full" haptic="medium" onClick={() => onApprove(receipt)}>
                  Hyväksy
                </Button>
                <Button variant="secondary" className="w-full" onClick={() => onEdit(receipt)}>
                  Muuta
                </Button>
              </>
            ) : (
              <Button className="w-full" onClick={() => onEdit(receipt)}>
                Täydennä kuitti
              </Button>
            )}
          </div>
        </div>
      ) : null}
    </BottomSheet>
  );
}
