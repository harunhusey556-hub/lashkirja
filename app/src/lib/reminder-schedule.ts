/**
 * When the next payment reminder of an invoice may go out.
 *
 * A reminder gives the customer a term to pay (its own due date). A second
 * reminder, with another fee, must not arrive while that term still runs, and
 * never sooner than 24 hours after the previous one. Pure, so the server that
 * refuses and the screens that hide the action read the same rule.
 */
import { formatDate } from "./format";
import { addDaysUtc } from "./invoices";
import { helsinkiCalendarDate, isoDateToUtc } from "./validation";

/** The shortest wait between two reminders of one invoice. */
export const REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export interface PreviousReminder {
  sentAt: Date;
  /** The due date printed on that reminder: the end of the term it gave. */
  dueDate: Date;
}

export interface ReminderWait {
  /** The first moment a new reminder is accepted. */
  at: Date;
  /** The term of the previous reminder decides, not the 24 hours. */
  byTerm: boolean;
}

/** The first instant of a calendar day in Europe/Helsinki. */
function helsinkiStartOfDay(isoDate: string): Date {
  const utcMidnight = isoDateToUtc(isoDate);
  for (const offsetHours of [3, 2]) {
    const candidate = new Date(utcMidnight.getTime() - offsetHours * 60 * 60 * 1000);
    const before = new Date(candidate.getTime() - 1);
    if (helsinkiCalendarDate(candidate) === isoDate && helsinkiCalendarDate(before) !== isoDate) {
      return candidate;
    }
  }
  return utcMidnight;
}

export function nextReminderWait(previous: PreviousReminder): ReminderWait {
  const cooldownEnd = new Date(previous.sentAt.getTime() + REMINDER_COOLDOWN_MS);
  // The term runs through its last day, so the next reminder may go on the day after.
  const dayAfterTerm = addDaysUtc(previous.dueDate, 1).toISOString().slice(0, 10);
  const termEnd = helsinkiStartOfDay(dayAfterTerm);
  return termEnd.getTime() > cooldownEnd.getTime()
    ? { at: termEnd, byTerm: true }
    : { at: cooldownEnd, byTerm: false };
}

function helsinkiTime(value: Date): string {
  return new Intl.DateTimeFormat("fi-FI", {
    timeZone: "Europe/Helsinki",
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(value);
}

/** Plain Finnish: why a new reminder is refused now, and the real time it is allowed. */
export function reminderWaitMessage(previous: PreviousReminder): string {
  const wait = nextReminderWait(previous);
  if (wait.byTerm) {
    return (
      `Edellisessä muistutuksessa asiakkaalla on maksuaikaa ${formatDate(previous.dueDate.toISOString())} asti. ` +
      `Uuden muistutuksen voi lähettää ${formatDate(helsinkiCalendarDate(wait.at))} alkaen.`
    );
  }
  return (
    `Muistutus lähetettiin jo ${formatDate(helsinkiCalendarDate(previous.sentAt))} klo ${helsinkiTime(previous.sentAt)}. ` +
    `Seuraava voidaan lähettää vasta ${formatDate(helsinkiCalendarDate(wait.at))} klo ${helsinkiTime(wait.at)}.`
  );
}

/**
 * The sentence that replaces the send button while a new reminder is not yet
 * possible, or null when the reminder may go now. Read from a reminder preview.
 */
export function reminderWaitNote(
  reminder: { nextReminderAt?: string | null; nextReminderNote?: string | null } | null | undefined,
  now: number = Date.now()
): string | null {
  if (!reminder?.nextReminderAt || !reminder.nextReminderNote) return null;
  return new Date(reminder.nextReminderAt).getTime() > now ? reminder.nextReminderNote : null;
}
