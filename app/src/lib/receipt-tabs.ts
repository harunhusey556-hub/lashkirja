/**
 * The kuitit list's top filter row - one of five mutually exclusive tabs
 * (all cannot combine with "type" or "linked" at once, matching what the
 * list's `type`/`linkedStatus` query params already enforced before this
 * became `FilterChips`). Pure functions, no React or fetch here.
 */
export const RECEIPT_TAB_IDS = ["all", "tulo", "meno", "linked", "unlinked"] as const;
export type ReceiptTabId = (typeof RECEIPT_TAB_IDS)[number];

export type ReceiptTabCounts = Record<ReceiptTabId, number>;
export const ZERO_RECEIPT_TAB_COUNTS: ReceiptTabCounts = {
  all: 0,
  tulo: 0,
  meno: 0,
  linked: 0,
  unlinked: 0,
};

const TAB_LABEL: Record<ReceiptTabId, string> = {
  all: "Kaikki",
  tulo: "Myynnit",
  meno: "Ostot",
  linked: "Linkitetty",
  unlinked: "Ei linkitetty",
};

export interface ReceiptTabChip {
  id: ReceiptTabId;
  label: string;
  count: number;
}

/** Chips for `FilterChips`, in a fixed order, with live DB-side counts. */
export function receiptTabChips(counts: ReceiptTabCounts): ReceiptTabChip[] {
  return RECEIPT_TAB_IDS.map((id) => ({ id, label: TAB_LABEL[id], count: counts[id] }));
}

/** The `{ type, linkedStatus }` advanced-filter pair a tab selection maps to. */
export function receiptTabQuery(id: ReceiptTabId): { type: string; linkedStatus: string } {
  switch (id) {
    case "tulo":
      return { type: "tulo", linkedStatus: "" };
    case "meno":
      return { type: "meno", linkedStatus: "" };
    case "linked":
      return { type: "", linkedStatus: "linked" };
    case "unlinked":
      return { type: "", linkedStatus: "unlinked" };
    default:
      return { type: "", linkedStatus: "" };
  }
}

/** The reverse of `receiptTabQuery`, to restore the active tab from persisted state. */
export function receiptTabFromQuery(type: string, linkedStatus: string): ReceiptTabId {
  if (linkedStatus === "linked") return "linked";
  if (linkedStatus === "unlinked") return "unlinked";
  if (type === "tulo") return "tulo";
  if (type === "meno") return "meno";
  return "all";
}
