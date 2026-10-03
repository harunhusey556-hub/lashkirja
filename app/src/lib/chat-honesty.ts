import { CHAT_DESTINATIONS } from "./chat-app";
import { alvDrillHref } from "./report-drill";
import { MONTHS } from "./finnish-months";
import type { ChatSource, ChatTurnStatus } from "./chat-turn";
import { replyLooksLikeCode, scopeRefusal } from "./chat-scope";

export interface HonestyContext {
  performedActions: readonly string[];
  allowedAmounts: readonly string[];
  allowedRecordIds: readonly string[];
  allowedHrefs: readonly string[];
  /** The reply's language, for a refusal written in it. */
  language?: "fi" | "en" | "tr";
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

/** What a reply can claim the assistant did to the books. */
export type ActionKind = "send" | "book" | "match" | "connect" | "delete" | "create" | "pay" | "update";

const W_BEFORE = String.raw`(?<![\p{L}])`;
const W_AFTER = String.raw`(?![\p{L}])`;
// English "I sent", "I've sent", "I have just sent"; never "I have not sent".
const EN_I = String.raw`i(?:['’]ve|\s+have)?\s+(?:just\s+|already\s+|now\s+|also\s+)?`;
// Swedish "jag skickade", "jag har skickat"; never "jag har inte skickat".
const SV_JAG = String.raw`jag\s+(?:har\s+)?(?:nu\s+|redan\s+|också\s+)?`;
const claim = (source: string) => new RegExp(`${W_BEFORE}(?:${source})${W_AFTER}`, "iu");

/**
 * First-person past claims of a change to the books, per kind, in Finnish,
 * English, Turkish and Swedish. Passive status words ("lähetetty", "sent
 * invoices", "skickade fakturor") describe records and are not claims.
 */
const ACTION_CLAIMS: Array<{ kind: ActionKind; pattern: RegExp }> = [
  {
    kind: "connect",
    pattern: claim(
      String.raw`yhdistin\s+pank\p{L}*|olen\s+yhdistänyt\s+pank\p{L}*|pankkiyhteys\s+on\s+nyt\s+yhdistetty|${EN_I}connected\s+(?:your|the)\s+bank|bankan[ıi]z[ıi]\s+ba[ğg]lad[ıi]m|ba[ğg]lad[ıi]m|${SV_JAG}(?:anslutit|anslöt|kopplat\s+banken|kopplade\s+banken)`
    ),
  },
  {
    kind: "match",
    pattern: claim(
      String.raw`yhdistin(?!\s+pank)|olen\s+yhdistänyt(?!\s+pank)|kohdistin|olen\s+kohdistanut|täs[m]äytin|hyväksyin\s+täs[m]äytyksen|${EN_I}(?:matched|linked|reconciled)|e[şs]le[şs]tirdim|${SV_JAG}(?:matchat|matchade|stämt\s+av|stämde\s+av)`
    ),
  },
  {
    kind: "send",
    pattern: claim(
      String.raw`lähetin|olen\s+lähettänyt|${EN_I}(?:sent|emailed|mailed)|yollad[ıi]m|g[öo]nderdim|ilettim|${SV_JAG}(?:skickat|skickade|mejlat|mejlade)|skickade\s+(?:jag|fakturan|kvittot|den|det|dem)`
    ),
  },
  {
    kind: "book",
    pattern: claim(
      String.raw`kirjasin|olen\s+kirjannut|tallensin|olen\s+tallentanut|merkitsin|olen\s+merkinnyt|hyväksyin(?!\s+täs[m]äytyksen)|olen\s+hyväksynyt|${EN_I}(?:booked|recorded|posted|saved|logged|approved|entered)|kaydettim|i[şs]ledim|onaylad[ıi]m|${SV_JAG}(?:bokfört|bokförde|registrerat|registrerade|sparat|sparade|godkänt|godkände)`
    ),
  },
  {
    kind: "delete",
    pattern: claim(String.raw`poistin|olen\s+poistanut|${EN_I}(?:deleted|removed)|sildim|${SV_JAG}(?:raderat|raderade|tagit\s+bort|tog\s+bort)`),
  },
  {
    kind: "create",
    pattern: claim(String.raw`loin|olen\s+luonut|${EN_I}created|olu[şs]turdum|${SV_JAG}(?:skapat|skapade)`),
  },
  {
    kind: "pay",
    pattern: claim(String.raw`maksoin|olen\s+maksanut|${EN_I}paid|[öo]dedim|${SV_JAG}(?:betalat|betalade)`),
  },
  {
    kind: "update",
    pattern: claim(
      String.raw`muutin|olen\s+muuttanut|päivitin|olen\s+päivittänyt|korjasin|olen\s+korjannut|${EN_I}(?:updated|changed|corrected|fixed|edited)|g[üu]ncelledim|de[ğg]i[şs]tirdim|d[üu]zelttim|${SV_JAG}(?:uppdaterat|uppdaterade|ändrat|ändrade|rättat|rättade)`
    ),
  },
];

/** The kinds of change a reply claims the assistant made, in a fixed order. */
export function claimedActionKinds(text: string): ActionKind[] {
  return ACTION_CLAIMS.filter((entry) => entry.pattern.test(text)).map((entry) => entry.kind);
}

/** A reply that says the bot already changed the books, when it did not. */
export function replyClaimsUnperformedAction(text: string): boolean {
  return claimedActionKinds(text).length > 0;
}

/**
 * The kind of a performed action as the turn recorded it: either the kind
 * itself ("send") or a descriptive id ("invoice_sent", "receipt_category_fixed").
 */
export function actionKindOf(performed: string): ActionKind | null {
  const text = performed.toLowerCase();
  const kinds: ActionKind[] = ["send", "book", "match", "connect", "delete", "create", "pay", "update"];
  if (kinds.includes(text as ActionKind)) return text as ActionKind;
  if (/send|sent|mail/.test(text)) return "send";
  if (/match|link|reconcil/.test(text)) return "match";
  if (/connect|bank_consent/.test(text)) return "connect";
  if (/delet|remov/.test(text)) return "delete";
  if (/creat|draft|new/.test(text)) return "create";
  if (/pay|paid/.test(text)) return "pay";
  if (/book|record|approv|save/.test(text)) return "book";
  if (/updat|fix|edit|chang|correct|categor|field/.test(text)) return "update";
  return null;
}

export function explainsLimitedMode(text: string): boolean {
  // The no-model reply says plainly that it cannot answer, and what it can do.
  return /en osaa vielä vastata|can't answer that yet/i.test(text);
}

const GROUP_SPACE = "[   ]";
// A number as people write money: "1 234,50", "1.234,50", "1,234.50", "999", "12,5".
const MONEY_NUMBER = String.raw`\d{1,3}(?:${GROUP_SPACE}\d{3})+(?:[.,]\d{1,2})?|\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:[.,]\d{1,2})?`;
const CURRENCY_BEFORE = String.raw`€|eur(?:o)?(?![\p{L}])`;
const CURRENCY_AFTER = String.raw`€|(?:euro(?:a|ja|s|n|ssa|lla|lta|lle)?|eur|e|avro|evro)(?![\p{L}\d])`;
// Grouped thousands with cents read as money even without a currency: "1.234,50".
const BARE_MONEY = String.raw`\d{1,3}(?:[.${GROUP_SPACE.slice(1, -1)}]\d{3})+,\d{2}|\d{1,3}(?:,\d{3})+\.\d{2}`;
const MONEY = new RegExp(
  String.raw`(?<![\d.,])(?:(?:${CURRENCY_BEFORE})${GROUP_SPACE}?(${MONEY_NUMBER})|(${MONEY_NUMBER})${GROUP_SPACE}?(?:${CURRENCY_AFTER})|(${BARE_MONEY}))(?!\d)`,
  "giu"
);

/** "1 234,5" → "1234.50": the last separator followed by one or two digits is the decimal mark. */
function canonicalMoney(raw: string): string {
  const compact = raw.replace(/[\s  ]/g, "");
  const decimal = /[.,](\d{1,2})$/.exec(compact);
  const whole = (decimal ? compact.slice(0, decimal.index) : compact).replace(/[.,]/g, "");
  const cents = decimal ? decimal[1].padEnd(2, "0") : "00";
  return `${String(Number(whole))}.${cents}`;
}

/** A context figure ("-12.5", "12.50") in the same canonical form, without its sign. */
export function canonicalAmount(value: string): string {
  const number = Number(value.replace(/^[-+−]/, ""));
  return Number.isFinite(number) ? number.toFixed(2) : value;
}

/** Euro amounts in a reply, however written: 12,50 €, 999 EUR, €999, 123.45 euros, 1.234,50. */
export function citedEuroAmounts(text: string): string[] {
  return [...text.matchAll(MONEY)].map((match) => canonicalMoney(match[1] ?? match[2] ?? match[3]));
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
  // A destination named by its whole address first: "/kirjanpito/pankkitilit?connect=1" is
  // "Yhdistä pankki", the same screen without the query "Pankkiyhteys ja tilit".
  const exact = CHAT_DESTINATIONS.find((item) => item.href === href);
  if (exact) return exact.label;
  const path = href.split("?")[0];
  const plain = CHAT_DESTINATIONS.find((item) => item.href === path);
  if (plain) return plain.label;
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
): { text: string; rejected: boolean; reason: "unperformed" | "amount" | "record" | "source" | "scope" | null } {
  // The prompt forbids code; a reply that still carries it is not shown.
  if (replyLooksLikeCode(text)) {
    return { text: scopeRefusal(ctx.language ?? "fi"), rejected: true, reason: "scope" };
  }
  const performed = new Set(ctx.performedActions.map(actionKindOf));
  if (claimedActionKinds(text).some((kind) => !performed.has(kind))) {
    return { text: HONESTY_REFUSAL, rejected: true, reason: "unperformed" };
  }
  const allowed = new Set(ctx.allowedAmounts.map(canonicalAmount));
  if (citedEuroAmounts(text).some((amount) => !allowed.has(amount))) {
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

const TURKISH_MONTHS = [
  "Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran",
  "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık",
];

type AnswerLanguage = "fi" | "en" | "tr";

/** "Syyskuun" / "September" / "Eylül", a quarter or a year, as the answer names the period. */
function periodName(key: string, language: AnswerLanguage, showYear: boolean): string {
  const year = key.slice(0, 4);
  const quarter = /-Q([1-4])$/.exec(key);
  if (quarter) {
    return { fi: `Q${quarter[1]}/${year}`, en: `Q${quarter[1]} ${year}`, tr: `${year} ${quarter[1]}. çeyrek` }[language];
  }
  if (key.length === 4) return { fi: `Vuoden ${year}`, en: year, tr: `${year} yılı` }[language];
  const index = Number(key.slice(5, 7)) - 1;
  const suffix = showYear ? ` ${year}` : "";
  if (language === "en") return `${ENGLISH_MONTHS[index] ?? key}${suffix}`;
  if (language === "tr") return `${TURKISH_MONTHS[index] ?? key}${suffix}`;
  return `${monthGenitive(key)}${suffix}`;
}

/**
 * A period's booked VAT, written for a person: the period's name, fi-FI money,
 * no screen path, no ISO period, no field number (F59). `amount` stays the
 * canonical "287.01" so the honesty check compares numbers, never wording.
 * `period` is "2026-09", "2026-Q3" or "2026"; `month` is its older name.
 */
export function formatBookedVatAnswer(input: {
  period?: string;
  month?: string;
  amount: string;
  isRefund: boolean;
  english?: boolean;
  language?: AnswerLanguage;
  /** Name the year of a month (a month of another year than the current one). */
  showYear?: boolean;
}): { text: string; sources: ChatSource[]; amount: string } {
  const key = input.period ?? input.month ?? "";
  const language: AnswerLanguage = input.language ?? (input.english ? "en" : "fi");
  const href = alvDrillHref(key);
  const [whole, cents] = input.amount.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const money = language === "en" ? `${input.amount} €` : `${grouped},${cents ?? "00"} €`;
  const name = periodName(key, language, Boolean(input.showYear));
  const text = {
    en: `VAT for ${name}: ${money} ${input.isRefund ? "to be refunded" : "to pay"}.`,
    tr: `${name} KDV: ${input.isRefund ? "iade edilecek" : "ödenecek"} ${money}.`,
    fi: `${name} ALV: ${input.isRefund ? "palautusta" : "maksettavaa"} ${money}.`,
  }[language];
  return { text, sources: [{ label: "ALV-ilmoitus", href }], amount: input.amount };
}

/**
 * When the asked period is shorter than the owner's VAT period (a month for a
 * quarterly filer), the return it belongs to. Null when the units agree.
 */
export function vatReturnNote(input: {
  period: string;
  ownerKind: "month" | "quarter" | "year";
  language: AnswerLanguage;
}): string | null {
  const year = input.period.slice(0, 4);
  const askedQuarter = /-Q[1-4]$/.test(input.period);
  const askedMonth = /^\d{4}-\d{2}$/.test(input.period);
  if (input.ownerKind === "month" || (!askedMonth && !askedQuarter)) return null;
  if (input.ownerKind === "quarter" && !askedMonth) return null;
  const returnKey =
    input.ownerKind === "quarter" ? `${year}-Q${Math.floor((Number(input.period.slice(5, 7)) - 1) / 3) + 1}` : year;
  const returnName = periodName(returnKey, input.language, true);
  const quarterly = input.ownerKind === "quarter";
  if (input.language === "en") {
    return `Your VAT period is ${quarterly ? "a quarter" : "the calendar year"}, so this ${askedMonth ? "month" : "quarter"} is part of the ${returnName} return.`;
  }
  if (input.language === "tr") {
    return `KDV dönemin ${quarterly ? "üç aylık" : "yıllık"}; bu ${askedMonth ? "ay" : "çeyrek"} ${returnName} beyannamesine dahil.`;
  }
  const fiName = returnKey.length === 4 ? `vuoden ${year}` : `kauden ${returnName}`;
  return `ALV-kautesi on ${quarterly ? "neljännesvuosi" : "kalenterivuosi"}, joten tämä ${askedMonth ? "kuukausi" : "neljännes"} kuuluu ${fiName} ilmoitukseen.`;
}
