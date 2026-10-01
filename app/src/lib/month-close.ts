/**
 * What the month close screen says, as plain functions (F10, F66, F72).
 *
 * The screen used to read "nothing open" as "done": a month with no statement,
 * no receipts and no invoices ticked every step and said "Kaikki kirjattu. Voit
 * sulkea kuukauden." with an enabled button. A step that cannot be checked is
 * not a step that passed. Every word the screen uses for the verdict lives
 * here, so it can be tested without rendering the page.
 */

/** done: checked and in order. open: something to do. none: nothing there to check, so no tick. */
export type StepState = "done" | "open" | "none";

/** `openCount` things to do; `hasItems` tells whether the month holds any of this kind at all. */
export function checkStepState(openCount: number, hasItems: boolean): StepState {
  if (openCount > 0) return "open";
  return hasItems ? "done" : "none";
}

export interface MonthCloseVat {
  /** Ilmoittamatta / Ilmoitettu / Maksettu. */
  state: "open" | "filed" | "paid";
  /** A filed or paid return is done once nothing is left to pay (see vatNothingToPay). */
  done: boolean;
  /** The figures moved after the return was filed (F66). */
  changedSinceFiling: boolean;
  /** A refund or a zero return has no payment step. */
  nothingToPay: boolean;
}

export interface MonthCloseFacts {
  ended: boolean;
  locked: boolean;
  /** Blocking things to do in the month (Koti's count). */
  blocking: number;
  /** A statement, a receipt or a sales document is dated in the month. */
  hasContent: boolean;
  hasStatement: boolean;
  /** Null when the month closes no VAT period (a quarterly filer's July) or the owner is not registered. */
  vat: MonthCloseVat | null;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The line under "Elokuu 2026". "Kaikki kirjattu" is said only when every part is in order. */
export function monthCloseSubtitle(facts: MonthCloseFacts): string {
  if (facts.locked) return "Kuukausi on suljettu.";
  if (!facts.ended) return "Kuukausi on vielä kesken.";
  if (facts.blocking > 0) return `${plural(facts.blocking, "asia", "asiaa")} kesken`;
  if (!facts.hasContent) return "Ei kirjattavaa tässä kuussa.";
  if (facts.vat?.changedSinceFiling) return "ALV-luvut ovat muuttuneet ilmoituksen jälkeen. Tarkista ne.";
  if (!facts.hasStatement) return "Tiliote puuttuu. Tuo se ennen sulkemista.";
  if (facts.vat && !facts.vat.done) {
    return facts.vat.state === "filed"
      ? "Kirjaukset on tehty. ALV on ilmoitettu, mutta ei vielä maksettu."
      : "Kirjaukset on tehty. ALV-ilmoitus on vielä tekemättä.";
  }
  return "Kaikki kirjattu. Voit sulkea kuukauden.";
}

/** The primary button: a month with nothing in it has nothing to close. */
export function monthCloseButton(facts: Pick<MonthCloseFacts, "ended" | "blocking" | "hasContent">): {
  disabled: boolean;
  reason?: string;
} {
  if (!facts.ended) return { disabled: true, reason: "Kuukauden voi sulkea, kun se on päättynyt." };
  if (!facts.hasContent && facts.blocking === 0) return { disabled: true, reason: "Tässä kuussa ei ole kirjattavaa." };
  return { disabled: false };
}

/** What the confirm dialog warns about before the month is locked. */
export function monthCloseWarnings(facts: MonthCloseFacts): string[] {
  const lines: string[] = [];
  if (facts.blocking > 0) lines.push(`${plural(facts.blocking, "asia", "asiaa")} on vielä kesken.`);
  if (!facts.hasStatement && facts.hasContent) lines.push("Tiliotetta ei ole tuotu.");
  if (facts.vat?.changedSinceFiling) lines.push("ALV-luvut ovat muuttuneet ilmoituksen jälkeen.");
  else if (facts.vat && !facts.vat.done) {
    lines.push(
      facts.vat.state === "filed"
        ? "ALV:ta ei ole merkitty maksetuksi."
        : "ALV-ilmoitusta ei ole merkitty annetuksi."
    );
  }
  return lines;
}
