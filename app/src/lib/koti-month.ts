/**
 * What Koti says about the month it shows, as plain functions (F10, F11, F26).
 *
 * Koti must say what is true: a month with nothing recorded is not "Kaikki
 * kirjattu", a month without a tiliote is not "in order" because nothing could
 * be compared, and "Tulot" / "Menot" name the basis they are counted on.
 */

export interface KotiMonthFacts {
  /** The month shown is the current one (or later). */
  atCurrent: boolean;
  /** Blocking things to do in the month (the headline's count). */
  blockingCount: number;
  /** A brand-new account: the start checklist replaces the verdict. */
  setupEmpty: boolean;
  /** Overdue invoices and account checks: not bookkeeping left undone, but not "nothing" either. */
  otherOpen: boolean;
  /** Bank rows, approved receipts or sales documents recorded in the month. */
  hasActivity: boolean;
  /** The month is shown from its tiliote (not from documents only). */
  hasStatement: boolean;
}

export function kotiMonthHasActivity(data: { txCount: number; receiptCount: number; invoiceCount?: number }): boolean {
  return data.txCount > 0 || data.receiptCount > 0 || (data.invoiceCount ?? 0) > 0;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function kotiHeadline(facts: KotiMonthFacts): string {
  if (facts.blockingCount > 0) {
    return facts.atCurrent
      ? `${plural(facts.blockingCount, "asia", "asiaa")} ennen kuun loppua`
      : `${plural(facts.blockingCount, "asia", "asiaa")} kesken`;
  }
  if (facts.setupEmpty) return "Aloitetaan";
  if (!facts.hasActivity) return "Ei kirjauksia tässä kuussa";
  if (facts.atCurrent) return facts.otherOpen ? "Kirjanpito on ajan tasalla" : "Kaikki kunnossa";
  // A past month shown without its tiliote has nothing open, but "kirjattu" would claim the bank was checked.
  return facts.hasStatement ? "Kaikki kirjattu" : "Ei avoimia asioita";
}

/**
 * The line about a missing tiliote under the headline. The current month says
 * "tämän kuun"; a past month never does, and stays silent when it is empty.
 */
export function kotiStatementLine(facts: {
  atCurrent: boolean;
  hasActivity: boolean;
  hasStatement: boolean;
  setupEmpty: boolean;
}): string | null {
  if (facts.hasStatement || facts.setupEmpty) return null;
  if (facts.atCurrent) return "Tämän kuun tiliotetta ei ole vielä.";
  return facts.hasActivity ? "Tältä kuulta ei ole tiliotetta." : null;
}

/**
 * The basis under "Kuukauden tulos" (F11). Koti counts the gross of invoices
 * and receipts, or the bank rows; Raportit counts net of VAT. A VAT-registered
 * owner is told which one this is, so the two screens never share a word for two numbers.
 */
export function kotiResultBasis(source: "tiliote" | "kuitit", vatRegistered: boolean): string {
  const base = source === "tiliote" ? "tiliotteen mukaan" : "laskujen ja kuittien mukaan";
  return vatRegistered ? `${base}, sis. ALV` : base;
}

/** The accessible name of a Tulot / Menot card. */
export function kotiResultLabel(label: "Tulot" | "Menot", amountText: string, vatRegistered: boolean): string {
  return `${label} ${amountText}${vatRegistered ? " sis. ALV" : ""}, avaa`;
}

/**
 * F25: the month Koti shows lives in the address (`/dashboard?month=2026-08`),
 * so Back from the month close or an invoice returns to the same month. A
 * missing, malformed or future value is the current month.
 */
export function parseKotiMonth(raw: string | null | undefined, current: string): string {
  if (!raw || !/^\d{4}-(0[1-9]|1[0-2])$/.test(raw)) return current;
  return raw > current ? current : raw;
}

/** The address for a month: plain `/dashboard` for the current one. */
export function kotiMonthHref(month: string, current: string): string {
  return month >= current ? "/dashboard" : `/dashboard?month=${month}`;
}
