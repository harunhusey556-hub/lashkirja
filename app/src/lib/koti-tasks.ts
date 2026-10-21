/**
 * Koti's task rows: the words and figures both clients show (iOS KotiTasks.swift). A receipt
 * waiting for approval names its category by the label the receipt list uses, and a credit
 * note says it is one; a bank row shows its signed amount, money out with a minus (C2, X081).
 */
import { approvalGapText, type ApprovalGap } from "@/lib/receipt-approval";
import { categoryLabel } from "@/lib/receipt-categories";
import { formatEur } from "@/lib/format";

function vatRateText(rate: number): string {
  return `ALV ${String(rate).replace(".", ",")} %`;
}

/** "Hyvityslasku · Tarvikkeet & ostot · ALV 25,5 %": what is missing, or what the approval books. */
export function pendingReceiptSecondary(item: {
  amount: number | null;
  category: string | null;
  vatRate: number | null;
  gaps?: ApprovalGap[];
}): string {
  const gaps = item.gaps ?? [];
  const category = item.category ? categoryLabel(item.category) : null;
  const rest =
    gaps.length > 0
      ? approvalGapText(gaps)
      : category && item.vatRate != null
        ? `${category} · ${vatRateText(item.vatRate)}`
        : category || (item.vatRate != null ? vatRateText(item.vatRate) : "Tarkista luokka ja ALV");
  return item.amount != null && item.amount < 0 ? `Hyvityslasku · ${rest}` : rest;
}

/** A bank row's figure: the signed cash amount, as Pankki and the iOS Koti show it. */
export function bankRowAmount(amount: number): string {
  return formatEur(amount);
}
