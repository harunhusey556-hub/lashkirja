/**
 * Closing the books (tilikauden lukitus).
 *
 * Once a VAT return has been filed or an accountant has taken a period, the
 * numbers behind it must stop moving. `booksLockedThrough` is the last closed
 * month; anything dated on or before it is refused - creation, edit and
 * deletion alike, because deleting a receipt changes a filed return exactly as
 * much as editing one does.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "./db";

type LockReader = Prisma.TransactionClient | typeof prisma;
import { AppError, ValidationError } from "./api-errors";
import { isMonthKey, monthKey } from "./bank-balances";
import { formatMonth } from "./format";
import { helsinkiMonthKey } from "./validation";

export class PeriodLockedError extends AppError {
  constructor(month: string, lockedThrough: string) {
    // The period lock lives in Kirjanpito > Suljetut kaudet (/kirjanpito/kaudet); Asetukset has none.
    super(
      `Kausi ${formatMonth(month)} on suljettu (kirjanpito on suljettu ${formatMonth(lockedThrough)} asti). Voit avata sen kohdassa Kirjanpito > Suljetut kaudet, jos muutos on välttämätön.`,
      "PERIOD_LOCKED",
      409
    );
  }
}

/**
 * Lowering or clearing the boundary reopens months that may already be filed,
 * so it is refused unless the caller says it means exactly that (F68).
 */
export class PeriodReopenRequiredError extends AppError {
  constructor(lockedThrough: string) {
    super(
      `Kirjanpito on suljettu ${formatMonth(lockedThrough)} asti. Aiemman kuukauden lukitseminen ei avaa myöhempiä kausia. Jos haluat avata kausia uudelleen, valitse Avaa kaudet.`,
      "PERIOD_REOPEN_REQUIRED",
      409
    );
  }
}

export function isMonthLocked(
  lockedThrough: string | null | undefined,
  month: string
): boolean {
  if (!lockedThrough || !isMonthKey(lockedThrough) || !isMonthKey(month)) return false;
  return month <= lockedThrough;
}

export function isDateLocked(
  lockedThrough: string | null | undefined,
  date: Date | string | null | undefined
): boolean {
  if (!lockedThrough || !date) return false;
  return isMonthLocked(lockedThrough, monthKey(date));
}

export async function getLockedThrough(userId: string, db: LockReader = prisma): Promise<string | null> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { booksLockedThrough: true },
  });
  return user?.booksLockedThrough ?? null;
}

/**
 * Refuses the operation when any of the supplied dates falls inside a closed
 * period. Nulls are ignored: an undated row belongs to no period.
 */
export async function assertPeriodOpen(
  userId: string,
  dates: Array<Date | string | null | undefined>,
  db: LockReader = prisma
): Promise<void> {
  const lockedThrough = await getLockedThrough(userId, db);
  if (!lockedThrough) return;

  for (const date of dates) {
    if (!date) continue;
    const month = monthKey(date);
    if (isMonthLocked(lockedThrough, month)) {
      throw new PeriodLockedError(month, lockedThrough);
    }
  }
}

/** Same check for something identified by month rather than by date. */
export async function assertMonthOpen(userId: string, month: string): Promise<void> {
  const lockedThrough = await getLockedThrough(userId);
  if (!lockedThrough) return;
  if (isMonthLocked(lockedThrough, month)) {
    throw new PeriodLockedError(month, lockedThrough);
  }
}

export interface LockState {
  lockedThrough: string | null;
}

export interface LockChangeOptions {
  now?: Date;
  /** The caller has chosen to reopen months: lower or clear the boundary. */
  reopen?: boolean;
}

/**
 * The one rule for moving the boundary (F68, F69). Only a month that has
 * ended can be closed, by the same Helsinki calendar the Kuukausi page uses
 * for its `ended` flag, so the two entry points cannot disagree. Moving the
 * boundary backwards (or clearing it) is allowed on purpose, because a
 * correction sometimes has to be made, but only as an explicit `reopen`:
 * choosing an earlier month to lock must never quietly reopen later ones.
 */
export function checkLockChange(
  current: string | null,
  month: string | null,
  options: LockChangeOptions = {}
): void {
  const now = options.now ?? new Date();
  if (month !== null) {
    if (!isMonthKey(month)) {
      throw new ValidationError("Kuukausi on muotoa YYYY-MM.");
    }
    const running = helsinkiMonthKey(now);
    if (month > running) {
      throw new ValidationError("Tulevaa kuukautta ei voi lukita.");
    }
    if (month === running) {
      throw new ValidationError("Kuukausi on vielä kesken. Sen voi lukita, kun se on päättynyt.");
    }
  }
  const lowering = current !== null && (month === null || month < current);
  if (lowering && !options.reopen) {
    throw new PeriodReopenRequiredError(current);
  }
}

/** Sets or clears the watermark and leaves a trace of the change. */
export async function setLockedThrough(
  userId: string,
  month: string | null,
  options: LockChangeOptions = {}
): Promise<LockState> {
  return prisma.$transaction(async (tx) => {
    const previous = await getLockedThrough(userId, tx);
    checkLockChange(previous, month, options);
    if (previous === month) return { lockedThrough: previous };

    const user = await tx.user.update({
      where: { id: userId },
      data: { booksLockedThrough: month },
      select: { booksLockedThrough: true },
    });
    const reopened = previous !== null && (month === null || month < previous);
    await tx.automationEvent.create({
      data: {
        userId,
        kind: "lock",
        resourceType: "period",
        resourceId: "books",
        previousValue: previous,
        newValue: month,
        reason: reopened ? "käyttäjä avasi kaudet" : "käyttäjä lukitsi kauden",
      },
    });
    return { lockedThrough: user.booksLockedThrough };
  });
}
