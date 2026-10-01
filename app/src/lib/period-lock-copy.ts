/** Words for the Suljetut kaudet screen: what a lock change does, in named months (F68). */
import { formatMonth } from "./format";
import { helsinkiMonthKey } from "./validation";

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

/**
 * The months the lock card offers: the last 24 finished months, newest first,
 * by the Helsinki calendar the server checks with. The running month is never
 * lockable. A month the books are already locked through (an older lock, or the
 * running month under the former rule) is always listed so the select can show it.
 */
export function lockMonthOptions(now: Date, lockedThrough: string | null): string[] {
  const [year, month] = helsinkiMonthKey(now).split("-").map(Number);
  const options: string[] = [];
  for (let back = 1; back <= 24; back += 1) {
    const total = year * 12 + (month - 1) - back;
    const optionYear = Math.floor(total / 12);
    const optionMonth = total - optionYear * 12 + 1;
    options.push(`${optionYear}-${String(optionMonth).padStart(2, "0")}`);
  }
  if (lockedThrough && !options.includes(lockedThrough)) {
    options.push(lockedThrough);
    options.sort().reverse();
  }
  return options;
}
