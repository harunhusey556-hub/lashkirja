/**
 * Pure geometry and words for the Koti charts (OWN-22). Kept out of the
 * components so the shapes and the sentences VoiceOver reads are unit tested.
 */
import { formatEur } from "@/lib/format";

export const MONTH_NAMES = [
  "Tammikuu", "Helmikuu", "Maaliskuu", "Huhtikuu", "Toukokuu", "Kesäkuu",
  "Heinäkuu", "Elokuu", "Syyskuu", "Lokakuu", "Marraskuu", "Joulukuu",
];
export const MONTH_SHORT = ["Tam", "Hel", "Maa", "Huh", "Tou", "Kes", "Hei", "Elo", "Syy", "Lok", "Mar", "Jou"];

/** "2026-09" -> index 8; -1 for anything else. */
export function monthIndex(month: string): number {
  const n = Number(month.slice(5, 7));
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n - 1 : -1;
}

export function monthTitle(month: string): string {
  return MONTH_NAMES[monthIndex(month)] ?? month;
}

export function monthShort(month: string): string {
  return MONTH_SHORT[monthIndex(month)] ?? month;
}

export interface LinePoint {
  x: number;
  y: number;
}

export interface LineGeometry {
  points: LinePoint[];
  /** The 2 px line. */
  line: string;
  /** The soft fill under the line, closed at the plot's bottom edge. */
  area: string;
  min: number;
  max: number;
}

/**
 * A line through the values across `width` x `height` px. The vertical range is
 * the data's own (with 12 % air above and below), not zero-based: a balance
 * moving between 10 000 € and 11 000 € must show its movement. The fill is a
 * fading wash, not a magnitude area, so it never claims a zero baseline.
 * A flat series sits in the middle.
 */
export function lineGeometry(values: readonly number[], width: number, height: number, inset = 6): LineGeometry | null {
  const clean = values.filter((value) => Number.isFinite(value));
  if (clean.length < 2 || clean.length !== values.length || width <= 0 || height <= 0) return null;
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const span = max - min;
  const top = inset;
  const bottom = height - inset;
  const usable = bottom - top;
  const yOf = (value: number) =>
    span === 0 ? top + usable / 2 : top + usable * 0.12 + (usable * 0.76 * (max - value)) / span;
  const step = clean.length > 1 ? (width - inset * 2) / (clean.length - 1) : 0;
  const points = clean.map((value, index) => ({ x: round(inset + step * index), y: round(yOf(value)) }));
  const line = points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x} ${point.y}`).join(" ");
  const first = points[0];
  const last = points[points.length - 1];
  const area = `${line} L${last.x} ${height} L${first.x} ${height} Z`;
  return { points, line, area, min, max };
}

/** Index of the point nearest to `x` (px from the plot's left edge). */
export function nearestIndex(x: number, width: number, count: number, inset = 6): number {
  if (count <= 0 || width <= 0) return -1;
  if (count === 1) return 0;
  const step = (width - inset * 2) / (count - 1);
  const index = Math.round((x - inset) / step);
  return Math.max(0, Math.min(count - 1, index));
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** "+1 200,00 € kuudessa kuukaudessa" style change line; null for a single point. */
export function balanceChange(points: ReadonlyArray<{ balance: number }>): { amount: number; text: string } | null {
  if (points.length < 2) return null;
  const amount = Math.round((points[points.length - 1].balance - points[0].balance) * 100) / 100;
  const months = points.length - 1;
  const span = months === 1 ? "kuukaudessa" : `${months} kuukaudessa`;
  if (amount === 0) return { amount, text: `Ennallaan ${span}` };
  const sign = amount > 0 ? "+" : "−";
  return { amount, text: `${sign}${formatEur(Math.abs(amount))} ${span}` };
}

/** One sentence for VoiceOver: "Pankkitilien saldo huhtikuusta syyskuuhun: nousi 1 200,00 €, nyt 12 300,00 €." */
export function balanceTrendSummary(points: ReadonlyArray<{ month: string; balance: number }>): string {
  if (points.length === 0) return "Pankkitilien saldo";
  const last = points[points.length - 1];
  if (points.length === 1) return `Pankkitilien saldo ${formatEur(last.balance)}.`;
  const change = balanceChange(points)!;
  const from = monthTitle(points[0].month).toLocaleLowerCase("fi");
  const to = monthTitle(last.month).toLocaleLowerCase("fi");
  const word = change.amount === 0 ? "pysyi ennallaan" : `${change.amount > 0 ? "nousi" : "laski"} ${formatEur(Math.abs(change.amount))}`;
  return `Pankkitilien saldo ${from}–${to}: ${word}, nyt ${formatEur(last.balance)}.`;
}
