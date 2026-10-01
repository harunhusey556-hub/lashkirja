/**
 * IBAN handling for bank accounts.
 *
 * Validation is the real ISO 13616 mod-97 check, not a length/prefix guess:
 * a typo in an account number is otherwise invisible until a payment fails.
 */

/** Per-country IBAN lengths. Unlisted countries are accepted on mod-97 alone. */
const IBAN_LENGTHS: Record<string, number> = {
  AT: 20, BE: 16, CH: 21, CZ: 24, DE: 22, DK: 18, EE: 20, ES: 24, FI: 18,
  FR: 27, GB: 22, IE: 22, IS: 26, IT: 27, LT: 20, LU: 20, LV: 21, NL: 18,
  NO: 15, PL: 28, PT: 25, SE: 24, SI: 19, SK: 24,
};

/** Uppercase, strip every non-alphanumeric character (spaces, dashes, NBSP). */
export function normalizeIban(value: string): string {
  return value.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
}

/** Groups of four, the way banks print it: "FI21 1234 5600 0007 85". */
export function formatIban(value: string): string {
  const normalized = normalizeIban(value);
  return normalized.replace(/(.{4})(?=.)/g, "$1 ");
}

/** Show only the tail, e.g. "FI•••• 0785". Used where the full IBAN is not needed. */
export function maskIban(value: string): string {
  const normalized = normalizeIban(value);
  if (normalized.length <= 6) return normalized;
  return `${normalized.slice(0, 2)}•••• ${normalized.slice(-4)}`;
}

/**
 * mod-97 over the rearranged, letter-expanded IBAN. Computed in chunks so a
 * 34-character IBAN never exceeds Number.MAX_SAFE_INTEGER.
 */
function mod97(expanded: string): number {
  let remainder = 0;
  for (let i = 0; i < expanded.length; i += 7) {
    remainder = Number(`${remainder}${expanded.slice(i, i + 7)}`) % 97;
  }
  return remainder;
}

export function isValidIban(value: string | null | undefined): boolean {
  if (!value) return false;
  const iban = normalizeIban(value);
  if (!/^[A-Z]{2}[0-9]{2}[0-9A-Z]{10,30}$/.test(iban)) return false;

  const expectedLength = IBAN_LENGTHS[iban.slice(0, 2)];
  if (expectedLength && iban.length !== expectedLength) return false;

  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const expanded = rearranged.replace(/[A-Z]/g, (c) =>
    String(c.charCodeAt(0) - 55)
  );
  return mod97(expanded) === 1;
}

/**
 * Finnish bank hint from the IBAN's bank code. Only a UI convenience for
 * prefilling the bank name - the user can always overwrite it, so an unknown
 * prefix returns null instead of a guess.
 */
const FI_BANK_PREFIXES: Array<[RegExp, string]> = [
  [/^(1|2)/, "Nordea"],
  [/^31/, "Handelsbanken"],
  [/^(33|34)/, "Danske Bank"],
  [/^36/, "S-Pankki"],
  [/^37/, "DNB"],
  [/^38/, "Swedbank"],
  [/^39/, "S-Pankki"],
  [/^4/, "Säästöpankki / POP / Aktia"],
  [/^5/, "OP"],
  [/^6/, "Ålandsbanken"],
];

export function bankNameFromIban(value: string | null | undefined): string | null {
  if (!isValidIban(value)) return null;
  const iban = normalizeIban(value!);
  if (!iban.startsWith("FI")) return null;
  const bban = iban.slice(4);
  for (const [pattern, name] of FI_BANK_PREFIXES) {
    if (pattern.test(bban)) return name;
  }
  return null;
}

/**
 * Every valid IBAN appearing in a statement file, most frequent first.
 * camt.053 and most CSV exports name the account they describe, so this is
 * enough to file an upload under the right account without asking.
 */
export function extractIbans(text: string): string[] {
  const counts = new Map<string, number>();
  for (const iban of ibanMentions(text)) counts.set(iban, (counts.get(iban) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([iban]) => iban);
}

/** Every valid IBAN in the text, once per mention, in the order they appear. */
function ibanMentions(text: string): string[] {
  const found: string[] = [];
  const pattern = /\b[A-Z]{2}[0-9]{2}(?:[ -]?[0-9A-Z]{4}){2,7}(?:[ -]?[0-9A-Z]{1,3})?\b/gi;
  for (const match of text.matchAll(pattern)) {
    const candidate = normalizeIban(match[0]);
    if (isValidIban(candidate)) found.push(candidate);
  }
  return found;
}

/** A line label that names the account the file is about (not a counterparty). */
const OWN_ACCOUNT_LABEL = /^(?:tilinumero|tilin numero|tili|iban|tilin iban|omistajan tili|account|account number|account no\.?|konto)$/i;

/**
 * The account a statement file is about, or null when the file does not say.
 *
 * - camt.053: the statement's own account, which stands before the first entry.
 *   The creditor and debtor accounts of the entries are the other party's.
 * - A labelled line ("Tilinumero;FI21 ...", "IBAN: FI21 ...") above the rows.
 * - Otherwise the one IBAN the file mentions most, and only when that is
 *   unambiguous: with a tie, which one is the file's own is not known, and a
 *   guess would file the statement under the wrong account.
 *
 * Counterparty columns ("Saajan tilinumero") are never a label for this.
 */
export function extractOwnIban(text: string): string | null {
  const head = text.split(/<Ntry[\s>]/)[0];
  const camt = /<Acct>[\s\S]*?<IBAN>\s*([^<]+?)\s*<\/IBAN>/i.exec(head);
  if (camt) {
    const candidate = normalizeIban(camt[1]);
    if (isValidIban(candidate)) return candidate;
  }
  for (const line of text.split(/\r?\n/).slice(0, 40)) {
    const cells = line.split(/[;\t,:]/).map((cell) => cell.trim().replace(/^"|"$/g, ""));
    if (cells.length < 2 || !OWN_ACCOUNT_LABEL.test(cells[0])) continue;
    const found = extractIbans(cells.slice(1).join(" "))[0];
    if (found) return found;
  }
  const counts = new Map<string, number>();
  for (const iban of ibanMentions(text)) counts.set(iban, (counts.get(iban) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return null;
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) return null;
  return ranked[0][0];
}
