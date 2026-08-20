/** Shared Finnish formatting so every screen shows money and months alike. */

const eurFormatter = new Intl.NumberFormat("fi-FI", {
  style: "currency",
  currency: "EUR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatEur(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "–";
  return eurFormatter.format(value);
}

/** Same as formatEur but always shows the sign, for differences and deltas. */
export function formatEurSigned(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "–";
  const formatted = eurFormatter.format(Math.abs(value));
  if (value === 0) return formatted;
  return `${value > 0 ? "+" : "−"}${formatted}`;
}

const MONTH_NAMES = [
  "tammikuu", "helmikuu", "maaliskuu", "huhtikuu", "toukokuu", "kesäkuu",
  "heinäkuu", "elokuu", "syyskuu", "lokakuu", "marraskuu", "joulukuu",
];

export function formatMonth(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return month;
  const name = MONTH_NAMES[Number(match[2]) - 1];
  return name ? `${name} ${match[1]}` : month;
}

/** Compact form for tables: "01/2026". */
export function formatMonthShort(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  return match ? `${match[2]}/${match[1]}` : month;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "–";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "–";
  return new Intl.DateTimeFormat("fi-FI", {
    day: "numeric",
    month: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

/** Accepts "1 234,56" and "1234.56" alike; returns null when unparsable. */
export function parseFinnishNumber(value: string): number | null {
  const cleaned = value.replace(/\s| /g, "").replace(",", ".");
  if (!cleaned || !/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

export function currentMonthKey(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}
