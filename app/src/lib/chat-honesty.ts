import { CHAT_DESTINATIONS } from "./chat-app";
import { alvDrillHref } from "./report-drill";
import { MONTHS } from "./finnish-months";
import type { ChatSource, ChatTurnStatus } from "./chat-turn";

export interface HonestyContext {
  performedActions: readonly string[];
  allowedAmounts: readonly string[];
  allowedRecordIds: readonly string[];
  allowedHrefs: readonly string[];
}

export const EMPTY_HONESTY: HonestyContext = {
  performedActions: [],
  allowedAmounts: [],
  allowedRecordIds: [],
  allowedHrefs: [],
};

export const HONESTY_REFUSAL =
  "En vahvistanut väitettä kirjanpidosta. Summat ja toimenpiteet tulevat vain palvelimen laskennasta ja tehdyistä toimista.";

const KNOWN_SCREENS = new Set([
  "/kirjanpito/alv",
  "/raportit",
  "/kuitit",
  "/laskut",
  "/pankki/tapahtumat",
  "/tiliotteet",
]);
const RECORD_ID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

const UNPERFORMED_ACTION =
  /olen yhdistänyt|yhdistin kuitin|hyväksyin täsmäytyksen|muutin kirjanpidon|lähetin laskun|kirjasin maksun|i (?:have )?matched your|i updated your books|i sent the invoice|i (?:have )?connected your bank|yhdistin pank|pankkiyhteys on nyt yhdistetty|bankan[ıi]z[ıi] ba[ğg]lad[ıi]m|faturan[ıi]z[ıi] g[öo]nderdim/i;

/** A reply that says the bot already changed the books, when it did not. */
export function replyClaimsUnperformedAction(text: string): boolean {
  return UNPERFORMED_ACTION.test(text);
}

export function explainsLimitedMode(text: string): boolean {
  // The no-model reply says plainly that it cannot answer, and what it can do.
  return /en osaa vielä vastata|can't answer that yet/i.test(text);
}

/** Euro amounts written like 12,50 € or 12.50 €. */
export function citedEuroAmounts(text: string): string[] {
  // A space (or no-break space) between thousands is part of the number: "1 234,56 €".
  return [...text.matchAll(/(\d{1,3}(?:[\s ]\d{3})+|\d+)[.,](\d{2})\s*€/g)].map(
    (match) => `${match[1].replace(/[\s ]/g, "")}.${match[2]}`
  );
}

/** Every cited euro figure is the one the calculation helper produced. */
export function replyUsesCalculatedAmount(reply: string, expected: string): boolean {
  const cited = citedEuroAmounts(reply);
  if (cited.length === 0) return false;
  return cited.every((amount) => amount === expected);
}

const SOURCE_RULES: Array<{ prefix: string; label: string }> = [
  { prefix: "/kirjanpito/alv", label: "ALV-ilmoitus" },
  // Legacy alias: a model can still emit the pre-restructure path from an
  // older prompt or cached memory. Keeping it recognised here means the
  // period/href honesty guard still checks it instead of silently letting
  // it through unexamined.
  { prefix: "/alv-raportti", label: "ALV-ilmoitus" },
  { prefix: "/raportit", label: "Raportit" },
  { prefix: "/kuitit", label: "Kuitit" },
  { prefix: "/laskut", label: "Laskut" },
  { prefix: "/pankki/tapahtumat", label: "Pankki" },
  { prefix: "/tiliotteet", label: "Tiliotteet" },
  ...CHAT_DESTINATIONS.map(item => ({ prefix: item.href.split("?")[0], label: item.label })),
];

function labelForHref(href: string): string | null {
  const path = href.split("?")[0];
  return SOURCE_RULES.find((rule) => path === rule.prefix)?.label ?? null;
}

/**
 * A reply that names a screen by its address ("[/laskut/uusi](/laskut/uusi)",
 * "täällä: /kuitit") shows the screen's name instead, as a link.
 */
export function humanizeScreenPaths(text: string): string {
  const named = (href: string) => labelForHref(href);
  return text
    .replace(/\[(\/[^\]\s]*)\]\((\/[^)\s]+)\)/g, (whole, _label: string, href: string) => {
      const label = named(href);
      return label ? `[${label}](${href})` : whole;
    })
    .replace(/(^|[\s:]|(?<!\])\()(\/[a-z][a-z0-9/_-]*(?:\?[^\s).,;]*)?)(?=$|[\s).,;:!?])/g, (whole, lead: string, href: string) => {
      const label = named(href);
      return label ? `${lead}[${label}](${href})` : whole;
    });
}

/** Internal book links cited in a reply, in first-seen order. */
export function sourcesFromText(text: string): ChatSource[] {
  const found: ChatSource[] = [];
  const seen = new Set<string>();
  const add = (href: string) => {
    if (!href.startsWith("/") || href.startsWith("//")) return;
    const label = labelForHref(href);
    if (!label || seen.has(href)) return;
    seen.add(href);
    found.push({ label, href });
  };
  for (const match of text.matchAll(/\[[^\]]+\]\((\/[^)\s]+)\)/g)) add(match[1]);
  for (const match of text.matchAll(
    /(?:^|\s)(\/(?:kirjanpito\/alv|raportit|kuitit|laskut|pankki\/tapahtumat|tiliotteet)(?:\?[^\s).,;]*)?)/g
  )) {
    add(match[1]);
  }
  return found;
}

function sourceIsAllowed(href: string, allowed: readonly string[]): boolean {
  if (allowed.includes(href)) return true;
  const [path, query] = href.split("?");
  if (query) return false;
  return KNOWN_SCREENS.has(path);
}

/**
 * A model reply may describe only actions that already completed, euro amounts
 * the server calculated, and record ids or period links that were in context.
 */
export function enforceAssistantReply(
  text: string,
  ctx: HonestyContext = EMPTY_HONESTY
): { text: string; rejected: boolean; reason: "unperformed" | "amount" | "record" | "source" | null } {
  if (replyClaimsUnperformedAction(text) && ctx.performedActions.length === 0) {
    return { text: HONESTY_REFUSAL, rejected: true, reason: "unperformed" };
  }
  const amounts = citedEuroAmounts(text);
  if (amounts.some((amount) => !ctx.allowedAmounts.includes(amount))) {
    return { text: HONESTY_REFUSAL, rejected: true, reason: "amount" };
  }
  const allowedIds = new Set(ctx.allowedRecordIds.map((id) => id.toLowerCase()));
  const citedIds = [...text.matchAll(new RegExp(RECORD_ID_SOURCE, "gi"))].map((match) => match[0].toLowerCase());
  if (citedIds.some((id) => !allowedIds.has(id))) {
    return { text: HONESTY_REFUSAL, rejected: true, reason: "record" };
  }
  const links = [...text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)].map(match => match[1]);
  if (links.some(href => !href.startsWith("/") || href.startsWith("//") || !sourceIsAllowed(href, ctx.allowedHrefs))) {
    return { text: HONESTY_REFUSAL, rejected: true, reason: "source" };
  }
  if (sourcesFromText(text).some((source) => !sourceIsAllowed(source.href, ctx.allowedHrefs))) {
    return { text: HONESTY_REFUSAL, rejected: true, reason: "source" };
  }
  return { text, rejected: false, reason: null };
}

/** Half a stream, a timeout, or a finished reply that invents a book change. */
export function guardStreamReply(
  settled: { status: ChatTurnStatus; content: string },
  ctx: HonestyContext = EMPTY_HONESTY
): { status: ChatTurnStatus; content: string; rejected: boolean } {
  if (settled.status === "cancelled" || settled.status === "failed") {
    return { ...settled, rejected: false };
  }
  const guarded = enforceAssistantReply(settled.content, ctx);
  if (!guarded.rejected) return { ...settled, rejected: false };
  return {
    status: settled.status === "complete" ? "incomplete" : settled.status,
    content: guarded.text,
    rejected: true,
  };
}

export function mergeSources(explicit: ChatSource[] | undefined, text: string): ChatSource[] {
  const all = [...(explicit ?? []), ...sourcesFromText(text)];
  // A bare screen link ("/kirjanpito/alv") next to the same screen opened on a
  // period is the same chip twice, labelled alike (F59).
  const withQuery = new Set(all.filter((source) => source.href.includes("?")).map((source) => source.href.split("?")[0]));
  const merged: ChatSource[] = [];
  const seen = new Set<string>();
  for (const source of all) {
    if (seen.has(source.href)) continue;
    if (!source.href.includes("?") && withQuery.has(source.href)) continue;
    seen.add(source.href);
    merged.push(source);
  }
  return merged;
}

/** "Syyskuun" from "2026-09": every Finnish month name ends in "kuu", its genitive in "kuun". */
function monthGenitive(month: string): string {
  const index = Number(month.slice(5, 7)) - 1;
  const name = MONTHS[index];
  return name ? `${name}n` : month;
}

const ENGLISH_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * This month's booked VAT, written for a person: month name, fi-FI money, no
 * screen path, no ISO period, no field number (F59). `amount` stays the canonical
 * "287.01" so the honesty check compares numbers, never wording.
 */
export function formatBookedVatAnswer(input: {
  month: string;
  amount: string;
  isRefund: boolean;
  english: boolean;
}): { text: string; sources: ChatSource[]; amount: string } {
  const href = alvDrillHref(input.month);
  const [whole, cents] = input.amount.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
  const money = input.english ? `${input.amount} €` : `${grouped},${cents ?? "00"}\u00a0€`;
  const english = ENGLISH_MONTHS[Number(input.month.slice(5, 7)) - 1] ?? input.month;
  const text = input.english
    ? `VAT for ${english}: ${money} ${input.isRefund ? "to be refunded" : "to pay"}.`
    : `${monthGenitive(input.month)} ALV: ${input.isRefund ? "palautusta" : "maksettavaa"} ${money}.`;
  return { text, sources: [{ label: "ALV-ilmoitus", href }], amount: input.amount };
}
