/**
 * The one quiet line under the business name on Koti (design wave 1, lane D2).
 *
 * A greeting by the Helsinki hour and the owner's first name, or, on the last
 * day of a month and the first of the next, one calm sentence about the month.
 * The sentence is said only when it is true: it reads the same facts the
 * headline reads, and never claims anything for an empty month.
 */

export interface GreetingFacts {
  now: Date;
  firstName: string;
  /** Blocking things to do in the current month (the headline's count). */
  blockingCount: number;
  /** Something is recorded in the month (see kotiMonthHasActivity). */
  hasActivity: boolean;
  /** A brand-new account: nothing to say about a month yet. */
  setupEmpty: boolean;
  /** Last month, until it is closed (the dashboard's previousMonth). */
  previousMonth: { month: string; open: number } | null;
}


const NUMBER_WORDS = ["nolla", "yksi", "kaksi", "kolme", "neljä", "viisi", "kuusi", "seitsemän", "kahdeksan", "yhdeksän", "kymmenen"];

/** "yksi asia", "kaksi asiaa", "12 asiaa". */
export function countThings(count: number): string {
  const word = count >= 0 && count < NUMBER_WORDS.length ? NUMBER_WORDS[count] : String(count);
  return `${word} ${count === 1 ? "asia" : "asiaa"}`;
}

/** Hour (0-23), day of month and the month's length, all as the clock in Helsinki shows them. */
export function helsinkiClock(now: Date): { hour: number; day: number; daysInMonth: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Helsinki",
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
  }).formatToParts(now);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const year = read("year");
  const month = read("month");
  return {
    hour: read("hour") % 24,
    day: read("day"),
    daysInMonth: new Date(Date.UTC(year, month, 0)).getUTCDate(),
  };
}

/** "Hyvää huomenta, Liisa": 5-9 morning, 10-16 day, 17-22 evening, 23-4 night. */
export function timeOfDayGreeting(hour: number, firstName: string): string {
  const base = hour >= 5 && hour < 10 ? "Hyvää huomenta" : hour >= 10 && hour < 17 ? "Hyvää päivää" : hour >= 17 && hour < 23 ? "Hyvää iltaa" : "Hyvää yötä";
  return firstName ? `${base}, ${firstName}` : base;
}

/** The line, or null when there is nothing honest to say (no name and no month sentence). */
export function kotiGreeting(facts: GreetingFacts): string | null {
  const { hour, day, daysInMonth } = helsinkiClock(facts.now);
  if (!facts.setupEmpty) {
    if (day === daysInMonth) {
      if (facts.blockingCount > 0) return `Kuukauden viimeinen päivä. Vielä ${countThings(facts.blockingCount)}.`;
      if (facts.hasActivity) return "Kuukauden viimeinen päivä. Kirjanpito on ajan tasalla.";
    }
  }
  if (!facts.firstName.trim()) return null;
  return timeOfDayGreeting(hour, facts.firstName.trim());
}
