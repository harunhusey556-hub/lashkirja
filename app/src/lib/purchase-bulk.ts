import { runLimited } from "@/lib/bank-bulk";

/**
 * Bulk actions on Ostolaskut (W20): which ticked invoices an action can take,
 * and the words of its confirmation. Pure, so the counts the bar shows are the
 * counts the requests send.
 */

export interface BulkPurchase {
  id: string;
  status: "open" | "paid" | "credited" | "cancelled";
  /** Euros still to pay. */
  open: number;
  isCreditNote?: boolean;
}

export type PurchaseBulkKind = "pay" | "remove";

/** Open invoices with something left to pay; a credit note, a paid or a cancelled invoice is left alone. */
export function payablePurchases<T extends BulkPurchase>(selected: readonly T[]): T[] {
  return selected.filter((invoice) => invoice.status === "open" && !invoice.isCreditNote && invoice.open > 0);
}

function invoices(count: number): string {
  return count === 1 ? "1 ostolasku" : `${count} ostolaskua`;
}

export const purchaseBulkLabels = {
  pay: (count: number) => `Merkitse maksetuiksi (${count})`,
  remove: (count: number) => `Poista valitut (${count})`,
} as const;

export function purchaseBulkTitle(kind: PurchaseBulkKind, count: number): string {
  return kind === "pay" ? `Merkitäänkö ${invoices(count)} maksetuksi?` : `Poistetaanko ${invoices(count)}?`;
}

export function purchaseBulkBody(kind: PurchaseBulkKind): string {
  return kind === "pay"
    ? "Jokaiselle kirjataan koko avoin summa maksetuksi tänään."
    : "Poistoa ei voi perua. Laskut, joilla on maksuja tai hyvityslasku, jäävät paikalleen.";
}

/** One sentence for the toast: "Merkittiin maksetuiksi 3.", "Poistettiin 2, epäonnistui 1." */
export function purchaseBulkOutcome(kind: PurchaseBulkKind, done: number, failed: number): string {
  const verb = kind === "pay" ? "Merkittiin maksetuiksi" : "Poistettiin";
  if (failed === 0) return `${verb} ${done}.`;
  if (done === 0) return `Mikään ei onnistunut (${failed} epäonnistui).`;
  return `${verb} ${done}, epäonnistui ${failed}.`;
}

export { runLimited };
