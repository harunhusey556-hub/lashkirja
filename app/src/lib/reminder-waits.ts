/**
 * Which overdue invoices cannot be reminded yet (see reminder-schedule.ts).
 * Kept apart from invoice-reminders.ts so the lists that only need the answer
 * do not load the PDF renderer with it.
 */
import { prisma } from "./db";
import { nextReminderWait } from "./reminder-schedule";

/** When a new reminder is accepted, while that is still ahead; null when it may go now. */
export function pendingReminderAt(
  latest: { sentAt: Date; dueDate: Date } | null | undefined,
  now: Date
): string | null {
  if (!latest) return null;
  const wait = nextReminderWait(latest);
  return wait.at.getTime() > now.getTime() ? wait.at.toISOString() : null;
}

/**
 * For each given invoice whose last reminder still bars a new one: the moment a
 * new reminder is accepted. Invoices that may be reminded now are left out.
 */
export async function reminderWaitsFor(
  userId: string,
  invoiceIds: string[],
  now: Date = new Date()
): Promise<Map<string, string>> {
  const waits = new Map<string, string>();
  if (invoiceIds.length === 0) return waits;
  const rows = await prisma.invoiceReminder.findMany({
    where: { invoiceId: { in: invoiceIds }, invoice: { userId }, sentTo: { not: null } },
    orderBy: { sentAt: "asc" },
    select: { invoiceId: true, sentAt: true, dueDate: true },
  });
  const latest = new Map<string, { sentAt: Date; dueDate: Date }>();
  for (const row of rows) latest.set(row.invoiceId, row);
  for (const [invoiceId, reminder] of latest) {
    const at = pendingReminderAt(reminder, now);
    if (at) waits.set(invoiceId, at);
  }
  return waits;
}
