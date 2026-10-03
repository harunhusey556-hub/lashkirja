/**
 * The deterministic gate every bank-row match goes through: receipts (kuitit
 * and purchase laskut stored as receipts), sales invoices and purchase
 * invoices. Pure: no database, no model.
 *
 * A pair is *eligible* only with hard evidence:
 *
 *   exact amount (the total, the open amount, or a known partial)
 *     AND an identity signal: viite exact, counterparty IBAN, or a strong
 *     name match
 *   OR an exact viite alone, for a lasku (a partial payment or a fee).
 *
 * Dates never make a pair eligible. They decide whether an amount + name
 * pair is inside a realistic window (card rows post 0-5 banking days after
 * the purchase; laskut are paid around the due date, sometimes weeks late or
 * early) and break ties between candidates smoothly. A viite match is decisive
 * whatever the date.
 *
 * Ambiguity: when the two best candidates are within AMBIGUITY_MARGIN of each
 * other (and neither is certain over the other), nothing is suggested. "No
 * suggestion" is always a valid outcome.
 */

export type MatchKind = "kuitti" | "lasku";

export interface GateRow {
  id: string;
  date: Date | null;
  /** Signed or unsigned; only the magnitude is compared. */
  amountCents: number;
  counterparty: string | null;
  reference: string | null;
  message: string | null;
  counterpartyIban?: string | null;
}

export interface GateCandidate {
  id: string;
  /** kuitti = card/cash receipt; lasku = anything with terms (invoice). */
  kind: MatchKind;
  /** Receipt date, or the invoice's issue date. */
  date: Date | null;
  dueDate?: Date | null;
  amountCents: number | null;
  /** What is still open on an invoice, when part is already paid. */
  openCents?: number | null;
  /** Amounts agreed as instalments. */
  partialCents?: number[];
  party: string | null;
  reference: string | null;
  invoiceNumber: string | null;
  iban?: string | null;
}

export type AmountMatch = "total" | "open" | "partial" | null;

export interface GateSignals {
  reference: boolean;
  amount: AmountMatch;
  iban: boolean;
  /** Name similarity 0..1 when strong enough to count, else 0. */
  name: number;
  /** Bank date minus the anchor (purchase date or due date), whole days. */
  dateGapDays: number | null;
  /** The anchor the gap is measured from. */
  dateAnchor: "purchase" | "due" | "issue" | null;
  /** 0..1, smooth: 1 inside the usual gap, falling off outside it. */
  dateFit: number;
  inWindow: boolean;
}

export interface GateVerdict {
  candidateId: string;
  eligible: boolean;
  /** viite + exact amount: needs no review. */
  certain: boolean;
  /** 0..1 ordering and display score; below ELIGIBLE_MIN when not eligible. */
  score: number;
  signals: GateSignals;
  /** Stable codes for storage and the web labels: viite, amount, iban, vendor, date. */
  codes: string[];
  /** Short Finnish reasons for the owner ("viite täsmää", "summa sama"). */
  reasons: string[];
}

/** Lowest score an eligible pair can have. */
export const ELIGIBLE_MIN = 0.6;
/** Two candidates closer than this are equally plausible. */
export const AMBIGUITY_MARGIN = 0.05;
/** A non-eligible pair never scores above this (shown only when the owner searches). */
export const RELATED_MAX = 0.45;

const DAY_MS = 86_400_000;

/* ------------------------------ normalizing ------------------------------ */

/** Normalize a Finnish viite / invoice number for comparison.
 *  RF-references ("RF18 1009") reduce to the underlying viite. */
export function normalizeRef(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (/^RF\d{2}/.test(s)) s = s.slice(4);
  s = s.replace(/^0+/, "");
  return s.length >= 2 ? s : null;
}

/** References a free-text bank message carries: single tokens and digit groups
 *  printed with spaces ("12345 67890"), normalized like normalizeRef. */
export function messageReferences(message: string | null | undefined): Set<string> {
  if (!message) return new Set();
  return memo(referenceMemo, message, () => scanReferences(message));
}

// Every row is compared with every candidate: the per-text work is done once.
const MEMO_LIMIT = 5000;
const referenceMemo = new Map<string, Set<string>>();
const nameMemo = new Map<string, string[]>();

function memo<T>(store: Map<string, T>, key: string, make: () => T): T {
  const hit = store.get(key);
  if (hit !== undefined) return hit;
  const value = make();
  if (store.size >= MEMO_LIMIT) store.clear();
  store.set(key, value);
  return value;
}

function scanReferences(message: string): Set<string> {
  const out = new Set<string>();
  const tokens = message.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i += 1) {
    const single = normalizeRef(tokens[i]);
    if (single) out.add(single);
    if (!/^\d+$/.test(tokens[i]) && !/^RF\d{2}$/.test(tokens[i])) continue;
    let joined = tokens[i];
    for (let j = i + 1; j < Math.min(tokens.length, i + 6); j += 1) {
      if (!/^\d+$/.test(tokens[j])) break;
      joined += tokens[j];
      const ref = normalizeRef(joined);
      if (ref) out.add(ref);
    }
  }
  return out;
}

const LEGAL_SUFFIXES = /\b(OY|OYJ|AB|KY|TMI|T:MI|LTD|OSK|RY|GMBH|INC|AS|AY)\b/g;

/** Words too common to identify anyone on their own. */
const GENERIC_TOKENS = new Set([
  "THE", "AND", "JA", "KAUPPA", "MARKET", "SHOP", "STORE", "SERVICE", "SERVICES",
  "PALVELU", "PALVELUT", "FINLAND", "SUOMI", "GROUP", "HELSINKI", "ESPOO", "VANTAA",
  "TAMPERE", "TURKU", "OULU", "CAFE", "KAHVILA", "RAVINTOLA", "PAYMENT", "MAKSU",
  "LASKU", "VERKKOKAUPPA", "FI", "COM", "WWW", "CARD", "KORTTI", "OSTO", "PAY",
]);

export function normalizeName(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return memo(nameMemo, raw, () => tokenizeName(raw));
}

function tokenizeName(raw: string): string[] {
  return raw
    .toUpperCase()
    // "K-Market" and "S-Market" are different chains: keep the letter with its word.
    .replace(/(^|[^A-ZÄÖÅ0-9])([A-ZÄÖÅ])-(?=[A-ZÄÖÅ])/g, "$1$2")
    .replace(LEGAL_SUFFIXES, " ")
    .replace(/[^A-ZÄÖÅ0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length >= 2);
}

function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= b.length; j += 1) {
      next[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], next[j - 1]);
    }
    prev = next;
  }
  return prev[b.length];
}

/** Same word, or a small typo in a long one. Short names must agree exactly:
 *  "KMARKET" and "SMARKET" are different shops. */
function sameToken(a: string, b: string): boolean {
  if (a === b) return true;
  if (a[0] !== b[0]) return false;
  const shorter = Math.min(a.length, b.length);
  if (shorter < 6) return false;
  return levenshtein(a, b) <= (shorter >= 9 ? 2 : 1);
}

/** 0..1 similarity between a party name and a bank-row name/message.
 *  Generic words do not count unless the name has nothing else. */
export function nameSimilarity(
  party: string | null | undefined,
  bankText: string | null | undefined
): number {
  const all = normalizeName(party);
  const other = normalizeName(bankText);
  if (all.length === 0 || other.length === 0) return 0;
  const distinctive = all.filter((t) => !GENERIC_TOKENS.has(t));
  const tokens = distinctive.length > 0 ? distinctive : all;
  let matches = 0;
  let longMatch = false;
  for (const token of tokens) {
    if (other.some((o) => sameToken(token, o))) {
      matches += 1;
      if (token.length >= 3) longMatch = true;
    }
  }
  if (!longMatch) return 0;
  // A name made only of common words must be there whole ("Kahvila Helsinki"
  // is not "Ravintola Helsinki").
  if (distinctive.length === 0) return matches === tokens.length ? 1 : 0;
  const otherDistinctive = other.filter((t) => !GENERIC_TOKENS.has(t)).length || other.length;
  return Math.min(1, matches / Math.min(tokens.length, otherDistinctive));
}

/** A name match strong enough to identify the party. */
export const STRONG_NAME = 0.5;

function normalizeIban(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s.length >= 15 ? s : null;
}

/* --------------------------------- dates --------------------------------- */

function dayGap(later: Date, earlier: Date): number {
  return Math.round((later.getTime() - earlier.getTime()) / DAY_MS);
}

// Card rows: 0-5 banking days after the purchase, which with weekends and
// holidays is up to ~10 calendar days; a pre-authorised row can be a day or
// two earlier than the receipt's own date.
const KUITTI_EARLY_DAYS = 2;
const KUITTI_LATE_DAYS = 10;
const KUITTI_USUAL_DAYS = 3;
// Laskut: paid around the due date. Early payment from the issue date on,
// late payment up to three months after the due date.
const LASKU_BEFORE_ISSUE_DAYS = 3;
const LASKU_LATE_DAYS = 90;
const LASKU_USUAL_DAYS = 3;
const LASKU_DEFAULT_TERM_DAYS = 14;

function dateSignals(row: GateRow, candidate: GateCandidate): Pick<GateSignals, "dateGapDays" | "dateAnchor" | "dateFit" | "inWindow"> {
  if (!row.date || (!candidate.date && !candidate.dueDate)) {
    return { dateGapDays: null, dateAnchor: null, dateFit: 0.5, inWindow: true };
  }
  if (candidate.kind === "kuitti") {
    const anchor = candidate.date ?? candidate.dueDate!;
    const gap = dayGap(row.date, anchor);
    const inWindow = gap >= -KUITTI_EARLY_DAYS && gap <= KUITTI_LATE_DAYS;
    let fit = 0;
    if (gap >= 0 && gap <= KUITTI_USUAL_DAYS) fit = 1;
    else if (gap > KUITTI_USUAL_DAYS && gap <= KUITTI_LATE_DAYS) fit = 1 - ((gap - KUITTI_USUAL_DAYS) / (KUITTI_LATE_DAYS - KUITTI_USUAL_DAYS)) * 0.8;
    else if (gap < 0 && gap >= -KUITTI_EARLY_DAYS) fit = 0.6;
    return { dateGapDays: gap, dateAnchor: "purchase", dateFit: round3(fit), inWindow };
  }
  const issue = candidate.date;
  const due = candidate.dueDate ?? (issue ? new Date(issue.getTime() + LASKU_DEFAULT_TERM_DAYS * DAY_MS) : null);
  const anchorKind: GateSignals["dateAnchor"] = candidate.dueDate ? "due" : "issue";
  const gapFromIssue = issue ? dayGap(row.date, issue) : null;
  const gap = due ? dayGap(row.date, due) : 0;
  const beforeIssue = gapFromIssue !== null && gapFromIssue < -LASKU_BEFORE_ISSUE_DAYS;
  const inWindow = !beforeIssue && gap <= LASKU_LATE_DAYS;
  let fit: number;
  if (Math.abs(gap) <= LASKU_USUAL_DAYS) fit = 1;
  else if (gap < 0) fit = Math.max(0.3, 1 - (Math.abs(gap) - LASKU_USUAL_DAYS) / 30);
  else fit = Math.max(0.2, 1 - (gap - LASKU_USUAL_DAYS) / 60);
  return {
    dateGapDays: anchorKind === "due" ? gap : (gapFromIssue ?? gap),
    dateAnchor: anchorKind,
    dateFit: inWindow ? round3(fit) : 0,
    inWindow,
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/* --------------------------------- gate ---------------------------------- */

function amountMatch(row: GateRow, candidate: GateCandidate): AmountMatch {
  const paid = Math.abs(row.amountCents);
  if (paid === 0) return null;
  if (candidate.amountCents != null && candidate.amountCents > 0 && Math.abs(candidate.amountCents) === paid) return "total";
  if (candidate.openCents != null && candidate.openCents > 0 && candidate.openCents === paid) return "open";
  if (candidate.partialCents?.some((cents) => cents > 0 && cents === paid)) return "partial";
  return null;
}

function referenceMatch(row: GateRow, candidate: GateCandidate): boolean {
  const ref = normalizeRef(candidate.reference);
  const inv = normalizeRef(candidate.invoiceNumber);
  const rowRef = normalizeRef(row.reference);
  if (rowRef && (rowRef === ref || rowRef === inv)) return true;
  const inMessage = messageReferences(row.message);
  // A reference in free text must be long enough not to be a stray number.
  if (ref && ref.length >= 4 && inMessage.has(ref)) return true;
  if (inv && inv.length >= 4 && inMessage.has(inv)) return true;
  return false;
}

/** Judge one bank row against one candidate. */
export function gatePair(row: GateRow, candidate: GateCandidate): GateVerdict {
  const reference = referenceMatch(row, candidate);
  const amount = amountMatch(row, candidate);
  const rowIban = normalizeIban(row.counterpartyIban);
  const iban = rowIban !== null && rowIban === normalizeIban(candidate.iban);
  const rawName = Math.max(
    nameSimilarity(candidate.party, row.counterparty),
    nameSimilarity(candidate.party, row.message)
  );
  const name = rawName >= STRONG_NAME ? round3(rawName) : 0;
  const date = dateSignals(row, candidate);
  const signals: GateSignals = { reference, amount, iban, name, ...date };

  const identity = reference || iban || name > 0;
  const certain = reference && amount !== null;
  const eligible =
    certain ||
    (amount !== null && identity && date.inWindow) ||
    (reference && candidate.kind === "lasku");

  let score: number;
  if (eligible) {
    let base: number;
    if (certain) base = 0.9;
    else if (amount && iban) base = 0.8;
    else if (amount && name > 0) base = 0.7 + (name - STRONG_NAME) * 0.2;
    else base = 0.6; // viite only
    const extras =
      (iban && !(amount && !reference) ? 0.05 : 0) +
      (name > 0 && (reference || iban) ? 0.05 * name : 0) +
      0.1 * date.dateFit;
    score = Math.min(0.99, base + extras);
  } else {
    // Only a search shortlist ever shows these; date alone counts for nothing.
    const related = amount !== null || reference || (name > 0 && date.inWindow);
    score = related
      ? Math.min(RELATED_MAX, (amount ? 0.2 : 0) + (reference ? 0.2 : 0) + (name > 0 ? 0.15 * name : 0) + 0.1 * date.dateFit)
      : 0;
  }

  const codes: string[] = [];
  if (reference) codes.push("viite");
  if (amount) codes.push("amount");
  if (iban) codes.push("iban");
  if (name > 0) codes.push("vendor");
  if (date.dateGapDays !== null && date.dateFit > 0) codes.push("date");

  return {
    candidateId: candidate.id,
    eligible,
    certain,
    score: round3(score),
    signals,
    codes,
    reasons: explainSignals(signals),
  };
}

/* ------------------------------- reasons -------------------------------- */

function days(n: number): string {
  return n === 1 ? "1 päivä" : `${n} päivää`;
}

/** The owner-facing "Miksi" line, in Finnish, from the signals. */
export function explainSignals(signals: GateSignals): string[] {
  const out: string[] = [];
  if (signals.reference) out.push("viite täsmää");
  if (signals.amount === "total") out.push("summa sama");
  else if (signals.amount === "open") out.push("summa sama kuin avoin osuus");
  else if (signals.amount === "partial") out.push("summa sama kuin sovittu osamaksu");
  if (signals.iban) out.push("tilinumero sama");
  if (signals.name > 0) out.push("nimi vastaa");
  const gap = signals.dateGapDays;
  if (gap !== null) {
    if (signals.dateAnchor === "purchase") {
      if (gap === 0) out.push("sama päivä");
      else if (gap > 0) out.push(`veloitettu ${days(gap)} oston jälkeen`);
      else out.push(`veloitettu ${days(-gap)} ennen kuitin päivää`);
    } else if (signals.dateAnchor === "due") {
      if (gap === 0) out.push("maksettu eräpäivänä");
      else if (gap > 0) out.push(`maksettu ${days(gap)} eräpäivän jälkeen`);
      else out.push(`maksettu ${days(-gap)} ennen eräpäivää`);
    } else if (signals.dateAnchor === "issue") {
      if (gap === 0) out.push("maksettu laskun päivänä");
      else if (gap > 0) out.push(`maksettu ${days(gap)} laskun päiväyksen jälkeen`);
      else out.push(`maksettu ${days(-gap)} ennen laskun päiväystä`);
    }
  }
  return out;
}

export const AMBIGUOUS_REASON = "useampi yhtä sopiva vaihtoehto, valitse itse";

/* ------------------------------ decisions -------------------------------- */

export interface GateDecision<T extends { score: number; certain: boolean }> {
  /** The one candidate to suggest, or null. */
  pick: T | null;
  /** Equally plausible candidates (nothing is suggested when set). */
  ambiguous: T[];
  /** Eligible candidates, best first. */
  eligible: T[];
}

/**
 * Picks the best eligible candidate only when it clearly beats the next one.
 * A certain pair (viite + amount) beats any uncertain one; two certain pairs,
 * or two uncertain ones within AMBIGUITY_MARGIN, are ambiguous.
 */
export function decide<T extends { score: number; certain: boolean; eligible?: boolean }>(
  verdicts: T[]
): GateDecision<T> {
  const eligible = verdicts
    .filter((v) => v.eligible !== false)
    .sort((a, b) => Number(b.certain) - Number(a.certain) || b.score - a.score);
  if (eligible.length === 0) return { pick: null, ambiguous: [], eligible };
  const [best, second] = eligible;
  if (!second) return { pick: best, ambiguous: [], eligible };
  if (best.certain && !second.certain) return { pick: best, ambiguous: [], eligible };
  if (best.score - second.score >= AMBIGUITY_MARGIN) return { pick: best, ambiguous: [], eligible };
  const tied = eligible.filter(
    (v) => v.certain === best.certain && best.score - v.score < AMBIGUITY_MARGIN
  );
  return { pick: null, ambiguous: tied, eligible };
}

export interface GatedPair {
  rowId: string;
  candidateId: string;
  verdict: GateVerdict;
}

export interface PairPlan {
  /** Mutually unambiguous pairs: the candidate is the row's clear best and the row is the candidate's. */
  picks: GatedPair[];
  /** Rows whose best candidates tie: listed for the owner, never suggested. */
  ambiguousRows: Map<string, GatedPair[]>;
  /** Every eligible pair per row, best first. */
  eligibleByRow: Map<string, GatedPair[]>;
}

/**
 * Plans suggestions over many rows and candidates. A pair is picked only when
 * it is the clear best from both sides, so one receipt is never suggested to
 * two rows and two look-alike rows never get a coin-flip receipt.
 */
export function planPairs(
  rows: GateRow[],
  candidates: GateCandidate[],
  allowed: (rowId: string, candidateId: string) => boolean = () => true
): PairPlan {
  const byRow = new Map<string, GatedPair[]>();
  const byCandidate = new Map<string, GatedPair[]>();
  for (const row of rows) {
    for (const candidate of candidates) {
      if (!allowed(row.id, candidate.id)) continue;
      const verdict = gatePair(row, candidate);
      if (!verdict.eligible) continue;
      const pair = { rowId: row.id, candidateId: candidate.id, verdict };
      byRow.set(row.id, [...(byRow.get(row.id) ?? []), pair]);
      byCandidate.set(candidate.id, [...(byCandidate.get(candidate.id) ?? []), pair]);
    }
  }
  const view = (pair: GatedPair) => ({ pair, score: pair.verdict.score, certain: pair.verdict.certain });
  const picks: GatedPair[] = [];
  const ambiguousRows = new Map<string, GatedPair[]>();
  const eligibleByRow = new Map<string, GatedPair[]>();
  for (const [rowId, pairs] of byRow) {
    const rowDecision = decide(pairs.map(view));
    eligibleByRow.set(rowId, rowDecision.eligible.map((v) => v.pair));
    if (!rowDecision.pick) {
      ambiguousRows.set(rowId, rowDecision.ambiguous.map((v) => v.pair));
      continue;
    }
    const best = rowDecision.pick.pair;
    const fromCandidate = decide((byCandidate.get(best.candidateId) ?? []).map(view));
    if (fromCandidate.pick?.pair === best) {
      picks.push(best);
    } else if (fromCandidate.pick === null) {
      // The receipt fits two rows equally: neither row gets it.
      ambiguousRows.set(rowId, [best]);
    }
    // Otherwise another row is the candidate's clear best; this row waits.
  }
  return { picks, ambiguousRows, eligibleByRow };
}
