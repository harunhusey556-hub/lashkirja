import { alvDrillHref } from "./report-drill";
import type { ChatSource } from "./chat-turn";

const UNPERFORMED_ACTION =
  /olen yhdistänyt|yhdistin kuitin|hyväksyin täsmäytyksen|muutin kirjanpidon|lähetin laskun|kirjasin maksun|i (?:have )?matched your|i updated your books|i sent the invoice/i;

/** A reply that says the bot already changed the books, when it did not. */
export function replyClaimsUnperformedAction(text: string): boolean {
  return UNPERFORMED_ACTION.test(text);
}

export function explainsLimitedMode(text: string): boolean {
  return /Rajattu tila|Limited mode/.test(text);
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
  { prefix: "/alv-raportti", label: "ALV-raportti" },
  { prefix: "/raportit", label: "Raportit" },
  { prefix: "/kuitit", label: "Kuitit" },
  { prefix: "/laskut", label: "Laskut" },
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
    /(?:^|\s)(\/(?:alv-raportti|raportit|kuitit|laskut|tiliotteet)(?:\?[^\s).,;]*)?)/g
  )) {
    add(match[1]);
  }
  return found;
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
