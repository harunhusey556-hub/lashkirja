/**
 * Closing the books (tilikauden lukitus).
 *
 * Once a VAT return has been filed or an accountant has taken a period, the
 * numbers behind it must stop moving. `booksLockedThrough` is the last closed
 * month; anything dated on or before it is refused - creation, edit and
 * deletion alike, because deleting a receipt changes a filed return exactly as
 * much as editing one does.
 */
import { prisma } from "./db";
import { AppError, ValidationError } from "./api-errors";
import { isMonthKey, monthKey } from "./bank-balances";

export class PeriodLockedError extends AppError {
  constructor(month: string, lockedThrough: string) {
    super(
      `Kausi ${month} on lukittu (kirjanpito suljettu ${lockedThrough} asti). Avaa lukitus asetuksista, jos muutos on välttämätön.`,
      "PERIOD_LOCKED",
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

export async function getLockedThrough(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({
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
  dates: Array<Date | string | null | undefined>
): Promise<void> {
  const lockedThrough = await getLockedThrough(userId);
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

/**
 * Sets or clears the watermark. A future month cannot be closed - the period
 * has not happened yet - and moving the watermark backwards (unlocking) is
 * allowed on purpose, because a correction sometimes has to be made.
 */
export async function setLockedThrough(
  userId: string,
  month: string | null,
  now: Date = new Date()
): Promise<LockState> {
  if (month !== null) {
    if (!isMonthKey(month)) {
      throw new ValidationError("Kuukausi on muotoa YYYY-MM.");
    }
    if (month > monthKey(now)) {
      throw new ValidationError("Tulevaa kuukautta ei voi lukita.");
    }
  }

  const user = await prisma.user.update({
    where: { id: userId },
    data: { booksLockedThrough: month },
    select: { booksLockedThrough: true },
  });
  return { lockedThrough: user.booksLockedThrough };
}
