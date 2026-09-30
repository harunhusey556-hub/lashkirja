import { alvDrillHref } from "./report-drill";
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
  /olen yhdistänyt|yhdistin kuitin|hyväksyin täsmäytyksen|muutin kirjanpidon|lähetin laskun|kirjasin maksun|i (?:have )?matched your|i updated your books|i sent the invoice/i;

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
  return [...text.matchAll(/(\d+[.,]\d{2})\s*€/g)].map((match) => match[1].replace(",", "."));
}

/** Every cited euro figure is the one the calculation helper produced. */
export function replyUsesCalculatedAmount(reply: string, expected: string): boolean {
  const cited = citedEuroAmounts(reply);
  if (cited.length === 0) return false;
  return cited.every((amount) => amount === expected);
}

const SOURCE_RULES: Array<{ prefix: string; label: string }> = [
  { prefix: "/kirjanpito/alv", label: "ALV-raportti" },
  // Legacy alias: a model can still emit the pre-restructure path from an
  // older prompt or cached memory. Keeping it recognised here means the
  // period/href honesty guard still checks it instead of silently letting
  // it through unexamined.
  { prefix: "/alv-raportti", label: "ALV-raportti" },
  { prefix: "/raportit", label: "Raportit" },
  { prefix: "/kuitit", label: "Kuitit" },
  { prefix: "/laskut", label: "Laskut" },
  { prefix: "/pankki/tapahtumat", label: "Pankki" },
  { prefix: "/tiliotteet", label: "Tiliotteet" },
];

function labelForHref(href: string): string | null {
  const path = href.split("?")[0];
  return SOURCE_RULES.find((rule) => path === rule.prefix)?.label ?? null;
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
  const merged: ChatSource[] = [];
  const seen = new Set<string>();
  for (const source of [...(explicit ?? []), ...sourcesFromText(text)]) {
    if (seen.has(source.href)) continue;
    seen.add(source.href);
    merged.push(source);
  }
  return merged;
}

export function formatBookedVatAnswer(input: {
  month: string;
  amount: string;
  isRefund: boolean;
  english: boolean;
}): { text: string; sources: ChatSource[] } {
  const href = alvDrillHref(input.month);
  const kind = input.isRefund
    ? input.english
      ? "refund"
      : "palautusta"
    : input.english
      ? "to pay"
      : "maksettavaa";
  const text = input.english
    ? `From your books for ${input.month}: VAT ${kind} ${input.amount} € (field 308). Source: ${href}.`
    : `Kirjanpidostasi kaudelta ${input.month}: ALV ${kind} ${input.amount} € (kohta 308). Lähde: ${href}.`;
  return { text, sources: [{ label: "ALV-raportti", href }] };
}
