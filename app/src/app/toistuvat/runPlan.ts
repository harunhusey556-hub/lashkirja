import { formatEur, formatMonth } from "@/lib/format";

export interface RunPlan {
  plan: Array<{
    recurringInvoiceId: string;
    name: string;
    customerName: string;
    customerEmail: string | null;
    autoSend: boolean;
    /** What each run bills, VAT included, in the same order as issueDates. */
    grossByDate: number[];
    /** The invoices the run will make. */
    issueDates: string[];
    /** Due dates inside a closed month: held back, made once the month opens. */
    lockedDates?: string[];
  }>;
}

type Plan = RunPlan["plan"];

/** "3 × 100,00 € ja 1 × 99,00 €": equal amounts are grouped, so a rate change mid-catch-up shows both. */
function amountsText(grossByDate: number[]): string {
  const groups: Array<{ gross: number; count: number }> = [];
  for (const gross of grossByDate) {
    const last = groups[groups.length - 1];
    if (last && last.gross === gross) last.count++;
    else groups.push({ gross, count: 1 });
  }
  const single = groups.length === 1 && groups[0].count === 1;
  return groups
    .map((group) => (single ? formatEur(group.gross) : `${group.count} × ${formatEur(group.gross)}`))
    .join(" + ");
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "heinäkuu 2026, elokuu 2026": the distinct months of some dates, in order. */
function monthsText(dates: string[]): string {
  const months = [...new Set(dates.map((date) => date.slice(0, 7)))].sort();
  return months.map(formatMonth).join(", ");
}

const LOCK_FIX = "Avaa kausi kohdassa Kirjanpito > Suljetut kaudet.";

/** How many invoices the run will make: every due date counts, not every schedule. */
export function runPlanInvoiceCount(plan: Plan | null): number {
  return plan?.reduce((sum, entry) => sum + entry.issueDates.length, 0) ?? 0;
}

/** The due dates a closed month holds back, across the plan. */
function lockedDatesOf(plan: Plan): string[] {
  return plan.flatMap((entry) => entry.lockedDates ?? []);
}

/**
 * "Uusi vuosilasku 100,00 € ja Kuukausilasku 50,00 €. 3 lähetetään sähköpostilla.
 * Lähetettyä laskua ei voi perua, vain hyvittää." The counts are invoices (G06):
 * a schedule three months behind makes three invoices and three mails.
 */
export function runPlanSummary(plan: Plan | null): string {
  if (!plan) return "";
  const sends = plan
    .filter((entry) => entry.autoSend && entry.customerEmail)
    .reduce((sum, entry) => sum + entry.issueDates.length, 0);
  const drafts = runPlanInvoiceCount(plan) - sends;
  const parts = plan.filter((entry) => entry.issueDates.length > 0).map((entry) => `${entry.name} ${amountsText(entry.grossByDate)}`);
  const locked = lockedDatesOf(plan);
  const sentence = [
    parts.length > 0 ? `${parts.join(", ")}.` : "",
    sends > 0 ? `${sends === 1 ? "1 lähetetään" : `${sends} lähetetään`} sähköpostilla.` : "",
    drafts > 0 ? `${drafts === 1 ? "1 jää" : `${drafts} jää`} luonnokseksi.` : "",
    sends > 0 ? "Lähetettyä laskua ei voi perua, vain hyvittää." : "",
    locked.length > 0
      ? `${capitalize(monthsText(locked))} ${new Set(locked.map((d) => d.slice(0, 7))).size === 1 ? "on suljettu kausi" : "ovat suljettuja kausia"}, joten ${locked.length === 1 ? "sen lasku" : "niiden laskut"} jää odottamaan. ${LOCK_FIX}`
      : "",
  ];
  return sentence.filter(Boolean).join(" ");
}

/** When the plan has due dates but every one is in a closed month, there is nothing to confirm: say why. */
export function lockedOnlyMessage(plan: Plan): string {
  const locked = lockedDatesOf(plan);
  const one = new Set(locked.map((date) => date.slice(0, 7))).size === 1;
  return `${capitalize(monthsText(locked))} ${one ? "on suljettu kausi" : "ovat suljettuja kausia"}, joten laskuja ei voi luoda. ${LOCK_FIX}`;
}

export interface RunOutcome {
  generated: Array<{ sent: boolean; sendError: string | null }>;
  skipped: Array<{ reason: string; issueDate: string }>;
  sendRetries?: Array<{ sent: boolean }>;
}

/**
 * What the run did, in words: invoices made, months held back by a closed
 * period (named, with the way out), mails that did not leave. Never a plain
 * success while something was left undone (G05, G07).
 */
export function runResultSummary(result: RunOutcome): {
  text: string;
  tone: "success" | "error" | "info";
  durationMs?: number;
} {
  const made = result.generated.length;
  const lockedDates = result.skipped.filter((entry) => entry.reason === "period_locked").map((entry) => entry.issueDate);
  const failedCreate = result.skipped.filter((entry) => entry.reason === "failed").length;
  const already = result.skipped.filter((entry) => entry.reason === "already_generated").length;
  const failedSends = result.generated.filter((entry) => entry.sendError).length;
  const resent = result.sendRetries?.filter((retry) => retry.sent).length ?? 0;

  const pieces: string[] = [];
  if (made === 1) pieces.push("1 lasku luotiin.");
  else if (made > 1) pieces.push(`${made} laskua luotiin.`);
  else if (lockedDates.length === 0 && failedCreate === 0 && resent === 0) pieces.push("Yhtään laskua ei luotu.");
  if (resent > 0) {
    pieces.push(resent === 1 ? "1 aiemmin lähettämättä jäänyt lasku lähetettiin." : `${resent} aiemmin lähettämättä jäänyttä laskua lähetettiin.`);
  }
  if (lockedDates.length > 0) {
    const months = [...new Set(lockedDates.map((date) => date.slice(0, 7)))];
    pieces.push(
      `${capitalize(monthsText(lockedDates))} ${months.length === 1 ? "jäi" : "jäivät"} luomatta, koska kausi on suljettu. ${LOCK_FIX} Kun kausi on auki, ${lockedDates.length === 1 ? "lasku luodaan" : "laskut luodaan"} seuraavalla kerralla.`
    );
  }
  if (failedCreate > 0) {
    pieces.push(failedCreate === 1 ? "Yhden laskun luonti epäonnistui." : `${failedCreate} laskun luonti epäonnistui.`);
  }
  if (already > 0) pieces.push(already === 1 ? "1 oli jo luotu." : `${already} oli jo luotu.`);
  if (failedSends > 0) {
    pieces.push(
      failedSends === 1
        ? "1 lähetys epäonnistui, lasku on tallessa luonnoksena. Voit lähettää sen laskun sivulta."
        : `${failedSends} lähetystä epäonnistui, laskut ovat tallessa luonnoksina. Voit lähettää ne laskun sivulta.`
    );
  }
  const text = pieces.join(" ");
  if (failedSends > 0 || failedCreate > 0) return { text, tone: "error", durationMs: 9000 };
  if (lockedDates.length > 0) return { text, tone: "info", durationMs: 9000 };
  return { text, tone: "success" };
}
