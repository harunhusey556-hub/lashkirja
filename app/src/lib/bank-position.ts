/**
 * OWN-18: the one answer to "is a bank connected, and what is the balance".
 *
 * Two tables hold the owner's bank accounts:
 * - `BankAccount`: a bookkeeping (ledger) account, added by hand or from a
 *   tiliote; its balance is the rollforward of its statements.
 * - `ConnectedAccount`: an account an Enable Banking consent returned. The
 *   ones the owner keeps in bookkeeping (`inScope`) of a usable consent are
 *   connected accounts too, with the balance the bank reported.
 *
 * Koti, the Pankkitilit total and the start checklist all read this module, so
 * a connected bank can never again read as "no bank". An IBAN that is both a
 * ledger account and a connected account counts once, as the ledger account
 * (its balance is the bookkeeping position). A consent that has ended is told
 * as one to connect again, never as "no bank".
 */
import { prisma } from "./db";
import { addMonths, monthKey } from "./bank-balances";
import { getBankOverview, type BankOverview } from "./bank-accounts";
import { normalizeIban } from "./iban";
import { centsToEuros, eurosToCents } from "./money";

export type BankPositionState =
  /** Nothing connected and no ledger account. */
  | "none"
  /** At least one account is counted, and no consent needs renewing. */
  | "connected"
  /** A consent has ended (expired, failed, withdrawn by the bank) and its accounts are not covered by another one. */
  | "reconnect"
  /** A usable consent exists, but none of its accounts is kept in bookkeeping. */
  | "unscoped";

export interface PositionConnectionAccount {
  id: string;
  iban: string;
  label: string | null;
  currency: string;
  inScope: boolean;
  balanceCents: number | null;
  balanceAt: Date | null;
}

export interface PositionConnection {
  id: string;
  aspspName: string;
  aspspCountry: string;
  status: string;
  validUntil: Date | null;
  lastError: string | null;
  sessionIdEnc: string | null;
  createdAt: Date;
  accounts: PositionConnectionAccount[];
}

export interface ConnectedPositionAccount {
  id: string;
  connectionId: string;
  iban: string;
  label: string | null;
  aspspName: string;
  currency: string;
  /** Euros, as the bank last reported it; null when the bank gave no balance. */
  balance: number | null;
  balanceAt: string | null;
}

export interface BankPosition {
  state: BankPositionState;
  /** Ledger accounts in use plus connected accounts no ledger account covers. */
  accountCount: number;
  /** Euros, EUR accounts with a known balance only. */
  totalBalance: number;
  /** True when at least one counted account has a known EUR balance. */
  hasBalance: boolean;
  excludedCurrencies: string[];
  /** Ledger accounts whose reported and computed balance disagree. */
  needsAttention: number;
  /** The bank to connect again ("S-Pankki"), when state is "reconnect". */
  reconnectBank: string | null;
  /** Connected accounts that are not also a ledger account. */
  connectedOnly: ConnectedPositionAccount[];
}

/** A consent the app can still sync with. */
export function consentUsable(connection: Pick<PositionConnection, "status" | "validUntil">, now: Date): boolean {
  if (connection.status !== "active") return false;
  return !(connection.validUntil && connection.validUntil.getTime() <= now.getTime());
}

/**
 * A consent that existed and has ended: the owner must connect again. A failed
 * first attempt (no session ever made) and a consent the owner disconnected
 * himself are not "ended" in this sense; they are simply gone.
 */
export function consentEnded(connection: PositionConnection, now: Date): boolean {
  if (connection.status === "expired") return true;
  if (connection.status === "error") return connection.sessionIdEnc !== null;
  if (connection.status === "revoked") return Boolean(connection.lastError?.trim());
  return connection.status === "active" && !consentUsable(connection, now);
}

type LedgerAccount = Pick<
  BankOverview["accounts"][number],
  "iban" | "currency" | "currentBalance" | "archivedAt" | "mismatchCount"
>;

export function combineBankPosition(
  ledgerAccounts: readonly LedgerAccount[],
  connections: readonly PositionConnection[],
  now: Date = new Date()
): BankPosition {
  const ledger = ledgerAccounts.filter((account) => !account.archivedAt);
  const ledgerIbans = new Set(ledger.map((account) => (account.iban ? normalizeIban(account.iban) : "")).filter(Boolean));

  // Newest consent first, so an IBAN under an old and a new consent is the new one.
  const ordered = [...connections].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const usable = ordered.filter((connection) => consentUsable(connection, now));

  const connectedByIban = new Map<string, ConnectedPositionAccount>();
  for (const connection of usable) {
    for (const account of connection.accounts) {
      if (!account.inScope) continue;
      const iban = normalizeIban(account.iban);
      if (!iban || ledgerIbans.has(iban) || connectedByIban.has(iban)) continue;
      connectedByIban.set(iban, {
        id: account.id,
        connectionId: connection.id,
        iban,
        label: account.label,
        aspspName: connection.aspspName,
        currency: account.currency,
        balance: account.balanceCents === null ? null : centsToEuros(account.balanceCents),
        balanceAt: account.balanceAt ? account.balanceAt.toISOString() : null,
      });
    }
  }
  const connectedOnly = [...connectedByIban.values()];

  // An ended consent matters only while its accounts are not covered by a usable one.
  const coveredIbans = new Set(
    usable.flatMap((connection) => connection.accounts.map((account) => normalizeIban(account.iban)))
  );
  // ...and only while the owner has not connected the same bank (name and
  // country) again since: a newer usable consent for that bank supersedes it,
  // whatever accounts either one lists. Without this an old failed consent
  // with no accounts kept Koti on "Yhteys vanhentunut" after a reconnect.
  const superseded = (connection: PositionConnection) =>
    usable.some(
      (other) =>
        other.id !== connection.id &&
        other.aspspName === connection.aspspName &&
        other.aspspCountry === connection.aspspCountry &&
        other.createdAt.getTime() > connection.createdAt.getTime()
    );
  const ended = ordered.find((connection) => {
    if (!consentEnded(connection, now)) return false;
    if (superseded(connection)) return false;
    const scoped = connection.accounts.filter((account) => account.inScope);
    const relevant = scoped.length > 0 ? scoped : connection.accounts;
    return relevant.length === 0 || relevant.some((account) => !coveredIbans.has(normalizeIban(account.iban)));
  });

  let totalCents = 0;
  let hasBalance = false;
  const excluded = new Set<string>();
  const add = (currency: string, cents: number | null) => {
    if (currency !== "EUR") {
      excluded.add(currency);
      return;
    }
    if (cents === null) return;
    totalCents += cents;
    hasBalance = true;
  };
  for (const account of ledger) add(account.currency, eurosToCents(account.currentBalance));
  for (const account of connectedOnly) add(account.currency, account.balance === null ? null : eurosToCents(account.balance));

  const accountCount = ledger.length + connectedOnly.length;
  const state: BankPositionState = ended
    ? "reconnect"
    : accountCount > 0
      ? "connected"
      : usable.length > 0
        ? "unscoped"
        : "none";

  return {
    state,
    accountCount,
    totalBalance: centsToEuros(totalCents),
    hasBalance,
    excludedCurrencies: [...excluded].sort(),
    needsAttention: ledger.filter((account) => account.mismatchCount > 0).length,
    reconnectBank: ended ? ended.aspspName : null,
    connectedOnly,
  };
}

export async function loadPositionConnections(userId: string): Promise<PositionConnection[]> {
  return prisma.bankConnection.findMany({
    where: { userId, status: { in: ["active", "expired", "error", "revoked"] } },
    select: {
      id: true,
      aspspName: true,
      aspspCountry: true,
      status: true,
      validUntil: true,
      lastError: true,
      sessionIdEnc: true,
      createdAt: true,
      accounts: {
        select: {
          id: true,
          iban: true,
          label: true,
          currency: true,
          inScope: true,
          balanceCents: true,
          balanceAt: true,
        },
      },
    },
  });
}

/** The ledger overview (as /api/bank-accounts gives it) together with the combined position. */
export async function getBankPosition(
  userId: string,
  options: { overview?: BankOverview; now?: Date } = {}
): Promise<{ overview: BankOverview; position: BankPosition; connections: PositionConnection[] }> {
  const [overview, connections] = await Promise.all([
    options.overview ? Promise.resolve(options.overview) : getBankOverview(userId),
    loadPositionConnections(userId),
  ]);
  return { overview, connections, position: combineBankPosition(overview.accounts, connections, options.now) };
}

/** True when the owner has connected a bank at any point that still shows (the start checklist). */
export function bankEverConnected(connections: readonly PositionConnection[], now: Date = new Date()): boolean {
  return connections.some((connection) => consentUsable(connection, now) || consentEnded(connection, now));
}

// ---------------------------------------------------------------------------
// Balance trend (Koti's chart)
// ---------------------------------------------------------------------------

export interface BalancePoint {
  month: string;
  balance: number;
}

/**
 * Closing balance per month of a connected account, derived backwards from the
 * balance the bank reported: a month's closing is today's balance minus every
 * synced row booked after that month. Months before the first synced row are
 * unknown and left out (never extrapolated).
 *
 * `rows` only needs the rows booked from the window's first month on (older
 * ones never change a closing inside the window); pass `firstRowMonth` (the
 * month of the oldest synced row overall) when older rows were left out.
 */
export function connectedClosings(
  balanceCents: number,
  rows: ReadonlyArray<{ date: Date; amountCents: number }>,
  throughMonth: string,
  months: number,
  firstRowMonth?: string | null
): Array<{ month: string; cents: number }> {
  if (rows.length === 0 && !firstRowMonth) return [{ month: throughMonth, cents: balanceCents }];
  const firstMonth =
    firstRowMonth ?? rows.reduce((min, row) => (monthKey(row.date) < min ? monthKey(row.date) : min), throughMonth);
  const out: Array<{ month: string; cents: number }> = [];
  for (let back = months - 1; back >= 0; back -= 1) {
    const month = addMonths(throughMonth, -back);
    if (month < firstMonth) continue;
    const later = rows.reduce((sum, row) => (monthKey(row.date) > month ? sum + row.amountCents : sum), 0);
    out.push({ month, cents: balanceCents - later });
  }
  return out;
}

export interface TrendSeries {
  /** Known closings; months after the window are ignored. */
  points: ReadonlyArray<{ month: string; cents: number }>;
  /** The balance before the series' first point: a ledger account's opening
   * balance, a connected account's balance before its oldest synced row. */
  openingCents: number;
}

/**
 * The summed EUR balance of every counted account, per month. A month is
 * plotted when at least one series has a figure for it. A series without a
 * figure for that month counts with its last known closing before it, or with
 * its opening balance while it has none yet (a hand-added account with no
 * statements stays flat at its opening balance). So one account without data
 * never blanks the whole chart. Null under two points (nothing to draw).
 */
export function combineTrend(
  series: ReadonlyArray<TrendSeries>,
  throughMonth: string,
  months: number
): BalancePoint[] | null {
  if (series.length === 0) return null;
  const window = Array.from({ length: months }, (_, index) => addMonths(throughMonth, index - (months - 1)));
  const sorted = series.map((one) => ({
    openingCents: one.openingCents,
    points: one.points
      .filter((point) => point.month <= throughMonth)
      .slice()
      .sort((a, b) => a.month.localeCompare(b.month)),
  }));
  const valueAt = (one: (typeof sorted)[number], month: string): number => {
    let value = one.openingCents;
    for (const point of one.points) {
      if (point.month > month) break;
      value = point.cents;
    }
    return value;
  };
  const points: BalancePoint[] = [];
  for (const month of window) {
    if (!sorted.some((one) => one.points.some((point) => point.month === month))) continue;
    points.push({ month, balance: centsToEuros(sorted.reduce((sum, one) => sum + valueAt(one, month), 0)) });
  }
  return points.length >= 2 ? points : null;
}

export async function loadBalanceTrend(
  userId: string,
  overview: BankOverview,
  position: BankPosition,
  throughMonth: string,
  months = 6
): Promise<BalancePoint[] | null> {
  const series: TrendSeries[] = [];
  for (const account of overview.accounts) {
    if (account.archivedAt || account.currency !== "EUR") continue;
    series.push({
      openingCents: eurosToCents(account.openingBalance),
      points: account.monthlyClosings
        .filter((row) => row.month <= throughMonth)
        .map((row) => ({ month: row.month, cents: eurosToCents(row.balance) })),
    });
  }
  // Rows booked from the window's first month on are enough for every closing
  // inside the window. The oldest row's month and the sum of all rows (for the
  // opening) come from one aggregate instead of loading the whole history.
  const windowStart = addMonths(throughMonth, -(months - 1));
  const windowStartDate = new Date(`${windowStart}-01T00:00:00.000Z`);
  for (const account of position.connectedOnly) {
    if (account.currency !== "EUR" || account.balance === null) continue;
    const where = { userId, iban: account.iban, source: "enablebanking", date: { not: null } };
    const [rows, all] = await Promise.all([
      prisma.transaction.findMany({
        where: { ...where, date: { gte: windowStartDate } },
        select: { date: true, amountCents: true },
      }),
      prisma.transaction.aggregate({ where, _min: { date: true }, _sum: { amountCents: true } }),
    ]);
    const balanceCents = eurosToCents(account.balance);
    series.push({
      openingCents: balanceCents - (all._sum.amountCents ?? 0),
      points: connectedClosings(
        balanceCents,
        rows.filter((row): row is { date: Date; amountCents: number } => row.date !== null),
        throughMonth,
        months,
        all._min.date ? monthKey(all._min.date) : null
      ),
    });
  }
  return combineTrend(series, throughMonth, months);
}
