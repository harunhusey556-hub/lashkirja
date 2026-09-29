/**
 * The owner's own "filed in OmaVero" / "paid" record for a VAT period
 * (FP-13, TF-16). LashKirja never files anything; this is what lets Koti
 * and the month close say the return is done instead of guessing.
 */
import { prisma } from "./db";
import { computeAlvReport } from "./alv";
import { loadAlvPeriodSources } from "./alv-period";
import { centsToEuros } from "./money";
import { ConflictError, ValidationError } from "./api-errors";
import { helsinkiCalendarDate, isoDateToUtc } from "./validation";
import type { VatFilingRecord } from "./vat-due";

/** "2026-08", "2026-Q3" or "2026". */
const FILING_PERIOD = /^(\d{4})(?:-(0[1-9]|1[0-2])|-Q([1-4]))?$/;

export function filingPeriodBoundsUtc(period: string): { start: Date; end: Date } {
  const match = FILING_PERIOD.exec(period);
  if (!match) throw new ValidationError("Virheellinen ALV-kausi");
  const year = Number(match[1]);
  if (match[2]) {
    const month = Number(match[2]);
    return { start: new Date(Date.UTC(year, month - 1, 1)), end: new Date(Date.UTC(year, month, 1)) };
  }
  if (match[3]) {
    const quarter = Number(match[3]);
    return {
      start: new Date(Date.UTC(year, (quarter - 1) * 3, 1)),
      end: new Date(Date.UTC(year, quarter * 3, 1)),
    };
  }
  return { start: new Date(Date.UTC(year, 0, 1)), end: new Date(Date.UTC(year + 1, 0, 1)) };
}

export function isFilingPeriod(value: unknown): value is string {
  return typeof value === "string" && FILING_PERIOD.test(value);
}

type FilingRow = { filedAt: Date | null; paidAt: Date | null; filedAmountCents: number | null };

export function toFilingRecord(row: FilingRow | null): VatFilingRecord | null {
  if (!row || (!row.filedAt && !row.paidAt)) return null;
  return {
    filedAt: row.filedAt ? row.filedAt.toISOString() : null,
    paidAt: row.paidAt ? row.paidAt.toISOString() : null,
    filedAmount: row.filedAmountCents == null ? null : centsToEuros(row.filedAmountCents),
  };
}

export async function getVatFiling(userId: string, period: string): Promise<VatFilingRecord | null> {
  const row = await prisma.vatFiling.findUnique({
    where: { userId_period: { userId, period } },
    select: { filedAt: true, paidAt: true, filedAmountCents: true },
  });
  return toFilingRecord(row);
}

/** Field 308 of the period, signed cents (negative = refund). */
async function signedVatCents(userId: string, period: string): Promise<number> {
  const { start, end } = filingPeriodBoundsUtc(period);
  const sources = await loadAlvPeriodSources(userId, start, end);
  const report = computeAlvReport(sources.receipts, sources.invoices);
  const cents = Math.round(report.field308.amount * 100);
  return report.field308.isRefund ? -cents : cents;
}

export interface FilingChange {
  filed?: boolean;
  paid?: boolean;
}

export async function updateVatFiling(
  userId: string,
  period: string,
  change: FilingChange,
  now: Date = new Date()
): Promise<VatFilingRecord | null> {
  const { end } = filingPeriodBoundsUtc(period);
  const today = isoDateToUtc(helsinkiCalendarDate(now));
  if (end.getTime() > today.getTime() && (change.filed || change.paid)) {
    throw new ConflictError("Kausi ei ole vielä päättynyt. Ilmoita ALV kauden päätyttyä.", "PERIOD_NOT_ENDED");
  }

  const current = await prisma.vatFiling.findUnique({ where: { userId_period: { userId, period } } });
  let filedAt = current?.filedAt ?? null;
  let filedAmountCents = current?.filedAmountCents ?? null;
  let paidAt = current?.paidAt ?? null;

  if (change.filed === true && !filedAt) {
    filedAt = now;
    filedAmountCents = await signedVatCents(userId, period);
  }
  if (change.filed === false) {
    // Undoing the filing also undoes the payment: a return that was not filed was not paid.
    filedAt = null;
    filedAmountCents = null;
    paidAt = null;
  }
  if (change.paid === true) {
    if (!filedAt) throw new ConflictError("Merkitse ensin ilmoitus annetuksi.", "NOT_FILED");
    paidAt = paidAt ?? now;
  }
  if (change.paid === false) paidAt = null;

  const row = await prisma.vatFiling.upsert({
    where: { userId_period: { userId, period } },
    create: { userId, period, filedAt, filedAmountCents, paidAt },
    update: { filedAt, filedAmountCents, paidAt },
    select: { filedAt: true, paidAt: true, filedAmountCents: true },
  });
  return toFilingRecord(row);
}

/** Pending receipts dated in the period: approving them changes the VAT (TF-11). */
export async function countPendingReceipts(userId: string, start: Date, end: Date): Promise<number> {
  return prisma.receipt.count({
    where: { userId, reviewStatus: "pending", date: { gte: start, lt: end } },
  });
}
