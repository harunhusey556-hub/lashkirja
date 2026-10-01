/**
 * Pure geometry and scale helpers for the ds chart family. No React, no DOM:
 * everything here is a plain function of numbers so it can be unit tested.
 *
 * Conventions
 * - Money is whatever unit the caller uses; these helpers only compare and scale.
 * - "fraction" means 0 to 1 of the plot's height or width, measured from the
 *   bottom (vertical) or the left (horizontal).
 */

/** Never NaN or Infinity: a chart must not paint garbage from a bad number. */
export function finiteOr(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

export function clamp(value: number, min: number, max: number): number {
  if (min > max) return min;
  return Math.min(max, Math.max(min, value));
}

/* ------------------------------------------------------------------ */
/* Value axis                                                          */
/* ------------------------------------------------------------------ */

/** Mantissas a gridline step may take: 1, 1.5, 2, 3, 4, 5, 6, 8 times a power of ten. */
const STEP_MANTISSAS = [1, 1.5, 2, 3, 4, 5, 6, 8, 10];

export type NiceScale = {
  /** Lowest value on the axis (0, or a negative multiple of step). */
  min: number;
  /** Highest value on the axis (a multiple of step, or 1 for all-zero data). */
  max: number;
  step: number;
  /** The quiet gridlines, ascending, never the zero baseline. At most `maxLines`. */
  ticks: number[];
};

const EPS = 1e-9;

function roundTo(value: number, digits = 10): number {
  const p = 10 ** digits;
  return Math.round(value * p) / p + 0; // + 0 turns -0 into 0
}

/**
 * A readable axis for bars that always include zero. Picks the smallest "nice"
 * step for which the data fits in at most `maxLines` gridlines above and below
 * the baseline together, so the axis stays quiet.
 *
 * - all zero or empty data gives 0..1 and no gridlines;
 * - negative values extend the axis below zero;
 * - a lone huge or tiny value still gets a round maximum.
 */
export function niceScale(values: readonly number[], maxLines = 3): NiceScale {
  const clean = values.filter((value) => Number.isFinite(value));
  const hi = Math.max(0, ...clean);
  const lo = Math.min(0, ...clean);
  if (hi === 0 && lo === 0) return { min: 0, max: 1, step: 1, ticks: [] };

  const lines = Math.max(1, Math.floor(maxLines));
  const span = hi - lo;
  const startExp = Math.floor(Math.log10(span)) - 2;
  for (let exp = startExp; exp <= startExp + 6; exp += 1) {
    for (const mantissa of STEP_MANTISSAS) {
      const step = roundTo(mantissa * 10 ** exp, 12);
      const above = Math.ceil(hi / step - EPS);
      const below = Math.ceil(-lo / step - EPS);
      if (above + below <= lines) {
        const ticks: number[] = [];
        for (let i = -below; i <= above; i += 1) {
          if (i !== 0) ticks.push(roundTo(i * step, 10));
        }
        return { min: roundTo(-below * step, 10), max: roundTo(above * step, 10), step, ticks };
      }
    }
  }
  // Unreachable for finite input; keep the chart alive anyway.
  return { min: Math.min(0, lo), max: Math.max(1, hi), step: span, ticks: [] };
}

/** Where a value sits on the axis, 0 (axis min) to 1 (axis max), clamped. */
export function valueFraction(value: number, min: number, max: number): number {
  const span = max - min;
  if (!(span > 0) || !Number.isFinite(value)) return 0;
  return clamp((value - min) / span, 0, 1);
}

/**
 * A bar from the zero baseline. `bottom` and `height` are fractions of the
 * plot height; a positive value rises from zero, a negative one hangs below it.
 */
export function barRect(value: number, min: number, max: number): { bottom: number; height: number } {
  const zero = valueFraction(0, min, max);
  const at = valueFraction(value, min, max);
  if (value >= 0) return { bottom: zero, height: Math.max(0, at - zero) };
  return { bottom: at, height: Math.max(0, zero - at) };
}

/* ------------------------------------------------------------------ */
/* Grouped bars                                                        */
/* ------------------------------------------------------------------ */

export type BarMetrics = {
  columnWidth: number;
  /** Width of one bar of the pair (income or expense), whole px. */
  barWidth: number;
  /** Gap between the two bars of a pair, px. */
  gap: number;
};

export const BAR_MIN_WIDTH = 3;
export const BAR_MAX_WIDTH = 14;

/**
 * Bar pair sizes for `count` columns in `plotWidth` px. A pair fills about 70 %
 * of its column, never gets wider than 14 px per bar and never thinner than 3 px.
 */
export function barMetrics(plotWidth: number, count: number): BarMetrics {
  const n = Math.max(1, Math.floor(count));
  const columnWidth = Math.max(0, finiteOr(plotWidth)) / n;
  const gap = columnWidth < 24 ? 1 : 2;
  const inner = columnWidth * 0.7;
  const barWidth = clamp(Math.floor((inner - gap) / 2), BAR_MIN_WIDTH, BAR_MAX_WIDTH);
  return { columnWidth, barWidth, gap };
}

/**
 * Whether a column is wide enough for the full month label ("Syys") or only its
 * first letter. `maxChars` is the longest label, `fontPx` the label font size.
 */
export function labelMode(columnWidth: number, maxChars: number, fontPx: number): "full" | "short" {
  const needed = Math.max(1, maxChars) * Math.max(1, fontPx) * 0.62 + 6;
  return columnWidth >= needed ? "full" : "short";
}

/** First letter, uppercase: the compact label of a column. */
export function shortLabel(label: string): string {
  const first = Array.from(label.trim())[0];
  return first ? first.toLocaleUpperCase("fi-FI") : "";
}

/** The column under x (px from the plot's left edge), clamped to the first and last. */
export function columnIndexAt(x: number, plotWidth: number, count: number): number {
  const n = Math.floor(count);
  if (n <= 0) return -1;
  if (!(plotWidth > 0)) return 0;
  return clamp(Math.floor((finiteOr(x) / plotWidth) * n), 0, n - 1);
}

/* ------------------------------------------------------------------ */
/* Ranked list ("top N plus Muut")                                     */
/* ------------------------------------------------------------------ */

export type RankedItem = { key: string; label: string; valueCents: number; href?: string };
export type RankedRow = RankedItem & { isOther?: boolean };

export const OTHER_KEY = "__muut";

/**
 * Sorted descending (ties by label), zero and negative values dropped. More
 * than `topN` rows collapse into the first `topN` plus one "Muut" row that sums
 * the rest; one leftover row is shown as itself, a lone "Muut" says nothing.
 */
export function groupTopN(items: readonly RankedItem[], topN: number, otherLabel = "Muut"): RankedRow[] {
  const n = Math.max(1, Math.floor(topN));
  const positive = items
    .filter((item) => Number.isFinite(item.valueCents) && item.valueCents > 0)
    .slice()
    .sort((a, b) => b.valueCents - a.valueCents || a.label.localeCompare(b.label, "fi"));
  if (positive.length <= n + 1) return positive;
  const head = positive.slice(0, n);
  const rest = positive.slice(n);
  const other: RankedRow = {
    key: OTHER_KEY,
    label: otherLabel,
    valueCents: rest.reduce((sum, item) => sum + item.valueCents, 0),
    isOther: true,
  };
  return [...head, other];
}

/** Bar length of each row relative to the largest one (0 to 1). */
export function relativeFractions(values: readonly number[]): number[] {
  const max = Math.max(0, ...values.filter((value) => Number.isFinite(value)));
  if (!(max > 0)) return values.map(() => 0);
  return values.map((value) => (Number.isFinite(value) ? clamp(value / max, 0, 1) : 0));
}

/** "42 %" (non-breaking space), "< 1 %" for a small non-zero share, "" without a total. */
export function shareLabel(value: number, total: number): string {
  if (!(total > 0) || !Number.isFinite(value) || value <= 0) return "";
  const percent = (value / total) * 100;
  if (percent < 1) return "< 1 %";
  return `${Math.round(percent)} %`;
}

/* ------------------------------------------------------------------ */
/* Month bar and stacked bar                                           */
/* ------------------------------------------------------------------ */

export const MAX_SEGMENTS = 12;

/**
 * Segments of the month bar. At most `maxSegments` pills. The bar never lies at
 * the ends: it is full only when everything is done, empty only when nothing
 * is, and a partial state keeps at least one done and one open pill.
 */
export function segmentFill(done: number, total: number, maxSegments = MAX_SEGMENTS): { segments: number; filled: number } {
  const t = Math.floor(finiteOr(total));
  if (t <= 0) return { segments: 0, filled: 0 };
  const segments = clamp(t, 1, Math.max(1, Math.floor(maxSegments)));
  const d = clamp(Math.floor(finiteOr(done)), 0, t);
  if (d >= t) return { segments, filled: segments };
  if (d <= 0) return { segments, filled: 0 };
  if (segments === 1) return { segments, filled: 0 };
  return { segments, filled: clamp(Math.round((d / t) * segments), 1, segments - 1) };
}

/**
 * Widths of the stacked bar's segments as fractions summing to 1. A non-zero
 * value never gets less than `minShare` so it stays visible; the others give up
 * that space proportionally. Zero and negative values get 0.
 */
export function stackShares(values: readonly number[], minShare = 0.03): number[] {
  const positive = values.map((value) => (Number.isFinite(value) && value > 0 ? value : 0));
  const total = positive.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) return positive.map(() => 0);
  const raw = positive.map((value) => value / total);
  const nonZero = raw.filter((share) => share > 0).length;
  const floor = Math.min(minShare, 1 / nonZero);
  const small = raw.filter((share) => share > 0 && share < floor);
  if (small.length === 0) return raw;
  const smallTotal = small.length * floor;
  const bigTotal = raw.filter((share) => share >= floor).reduce((sum, share) => sum + share, 0);
  const scale = bigTotal > 0 ? (1 - smallTotal) / bigTotal : 0;
  return raw.map((share) => (share <= 0 ? 0 : share < floor ? floor : share * scale));
}

/* ------------------------------------------------------------------ */
/* Sparkline                                                           */
/* ------------------------------------------------------------------ */

export type SparkGeometry = {
  /** SVG path in a 0..100 by 0..100 box (y grows downward); "" for fewer than two points. */
  path: string;
  /** The last point, in the same 0..100 box. */
  last: { x: number; y: number };
};

const SPARK_PAD_X = 3;
const SPARK_PAD_Y = 14;

/**
 * Path and last point of a sparkline. Points keep their order; non-finite ones
 * are skipped. All-equal data is a straight line through the middle, one point
 * is a dot in the middle, none gives null.
 */
export function sparkGeometry(points: readonly number[]): SparkGeometry | null {
  const clean = points.filter((value) => Number.isFinite(value));
  if (clean.length === 0) return null;
  if (clean.length === 1) return { path: "", last: { x: 50, y: 50 } };
  const lo = Math.min(...clean);
  const hi = Math.max(...clean);
  const span = hi - lo;
  const width = 100 - SPARK_PAD_X * 2;
  const height = 100 - SPARK_PAD_Y * 2;
  const coords = clean.map((value, index) => ({
    x: roundTo(SPARK_PAD_X + (index / (clean.length - 1)) * width, 2),
    y: roundTo(span > 0 ? SPARK_PAD_Y + (1 - (value - lo) / span) * height : 50, 2),
  }));
  const path = coords.map((c, index) => `${index === 0 ? "M" : "L"}${c.x} ${c.y}`).join(" ");
  return { path, last: coords[coords.length - 1] };
}
