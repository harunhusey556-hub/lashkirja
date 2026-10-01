/** Words for the Suljetut kaudet screen: what a lock change does, in named months (F68). */
import { formatMonth } from "./format";

export type LockChangeKind = "lock" | "reopen" | "none";

/** Choosing an earlier month than the current lock (or none) reopens months; it is not "Lukitse". */
export function lockChangeKind(current: string | null, selected: string | null): LockChangeKind {
  if (current === selected) return "none";
  if (current !== null && (selected === null || selected < current)) return "reopen";
  return "lock";
}

export function monthAfter(month: string): string {
  const [year, number] = month.split("-").map(Number);
  const total = year * 12 + number;
  const nextYear = Math.floor(total / 12);
  return `${nextYear}-${String(total - nextYear * 12 + 1).padStart(2, "0")}`;
}

/** The months that become editable when the lock moves from `lockedThrough` back to `selected`. */
export function reopenedRangeLabel(selected: string | null, lockedThrough: string): string {
  if (selected === null) return `kaikki kuukaudet ${formatMonth(lockedThrough)} asti`;
  const from = monthAfter(selected);
  if (from === lockedThrough) return formatMonth(lockedThrough);
  if (from.slice(0, 4) === lockedThrough.slice(0, 4)) {
    const [first] = formatMonth(from).split(" ");
    return `${first}–${formatMonth(lockedThrough)}`;
  }
  return `${formatMonth(from)}–${formatMonth(lockedThrough)}`;
}
